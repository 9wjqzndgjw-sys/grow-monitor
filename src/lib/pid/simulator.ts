// Simulation runner — wires the PID controller and tent model together and
// produces a full trajectory that can be saved to pid_sim_samples.

import {
  DEFAULT_PID_CONFIG,
  auxControl,
  calcVpdKpa,
  makeAuxState,
  makeState,
  resetPid,
  rhTarget,
  tempTarget,
  tick,
  type PidConfig,
} from './controller'
import { step, MAX_GAP_S, type TentModel, type Inputs } from './model'
import type { SimSample, SetpointRow } from './types'

export interface SimConfig {
  pid: PidConfig
  setpoint: SetpointRow
  modelHumidity: TentModel
  modelTemp: TentModel
  /** Total duration in seconds. */
  durationS: number
  /** Integrator step in seconds. 5–30 s is a good range. */
  dtS: number
  /** Starting values. */
  initialRh: number
  initialTempF: number
  /** Day/night. Set `schedule` to override this with a photoperiod. */
  lightsOn?: boolean
  /**
   * Optional disturbance list. Each entry is (t_s, description). Supported:
   *   { t: 600, kind: 'tent_open' }        — simulates a door opening
   *   { t: 1200, kind: 'setpoint_step', delta: -5 }
   *   { t: 0, kind: 'lights', on: true }   — flip photoperiod mid-run
   */
  disturbances?: Disturbance[]
  /** Called every step; useful for streaming progress in the UI. */
  onStep?: (sample: SimSample) => void
  hasBoostHumidifier?: boolean
  hasHeater?: boolean
}

export type Disturbance =
  | { t: number; kind: 'tent_open' }
  | { t: number; kind: 'setpoint_step'; deltaRh: number }
  | { t: number; kind: 'lights'; on: boolean }

export interface SimResult {
  samples: SimSample[]
  /** RH the controller was aiming for at each step (lights may flip it). */
  setpointTrack: number[]
  /** Settings echoed back so the UI can store a run record in one shot. */
  config: SimConfig
}

/**
 * Runs a closed-loop sim: PID → fan command → tent model → new sensor values
 * → PID (next tick).  Aux devices (heater, boost humidifier) follow the same
 * discrete hysteresis rules as the Hubitat app.
 */
export function runSimulation(cfg: SimConfig): SimResult {
  const pid = cfg.pid ?? DEFAULT_PID_CONFIG
  const pidState = makeState(pid)
  const auxState = makeAuxState()

  let rh = cfg.initialRh
  let tempF = cfg.initialTempF
  let lightsOn = cfg.lightsOn ?? true
  let spOffset = 0 // accumulated setpoint_step disturbances

  // Seed PID state at t=0 mimicking Hubitat's `resetPID()` behavior
  resetPid(pidState, pid, rh, rhTarget(cfg.setpoint, lightsOn) + spOffset, 0)

  const samples: SimSample[] = []
  const setpointTrack: number[] = []

  const nSteps = Math.ceil(cfg.durationS / cfg.dtS)
  for (let i = 0; i <= nSteps; i++) {
    const tS = i * cfg.dtS
    const nowMs = tS * 1000

    // Apply disturbances scheduled at this step.
    if (cfg.disturbances) {
      for (const d of cfg.disturbances) {
        if (d.t === tS) {
          if (d.kind === 'tent_open') {
            // Big VPD jump -> triggers controller suppression.
            pidState.lastVpd =
              (pidState.lastVpd ?? calcVpdKpa(tempF, rh)) +
              pid.tentOpenVpdKpa * 2
            rh += 10 * (Math.random() > 0.5 ? -1 : 1) // quick swing
            tempF += 1 * (Math.random() > 0.5 ? -1 : 1)
          } else if (d.kind === 'setpoint_step') {
            spOffset += d.deltaRh
          } else if (d.kind === 'lights') {
            lightsOn = d.on
            // mirror Hubitat: lights toggle triggers a PID reset
            resetPid(
              pidState,
              pid,
              rh,
              rhTarget(cfg.setpoint, lightsOn) + spOffset,
              nowMs,
            )
          }
        }
      }
    }

    const targetRh = rhTarget(cfg.setpoint, lightsOn) + spOffset
    const targetTempF = tempTarget(cfg.setpoint, lightsOn)

    // Aux devices
    auxControl(
      auxState,
      rh,
      targetRh,
      tempF,
      targetTempF,
      lightsOn,
      cfg.hasBoostHumidifier ?? true,
      cfg.hasHeater ?? true,
    )

    const ctl = tick(pidState, pid, rh, targetRh, tempF, nowMs)

    const sample: SimSample = {
      t_s: tS,
      setpoint: targetRh,
      rh,
      temp_f: tempF,
      vpd_kpa: calcVpdKpa(tempF, rh),
      fan_pct: ctl.fanPct,
      humidifier: auxState.boostHumOn || auxState.constantHumOn,
      heater: auxState.heaterOn,
      lights_on: lightsOn,
      error: ctl.error,
      p_term: ctl.pTerm,
      i_term: ctl.iTerm,
      d_term: ctl.dTerm,
    }
    samples.push(sample)
    setpointTrack.push(targetRh)
    cfg.onStep?.(sample)

    // Advance the plant model for the next step.
    const inputs: Inputs = {
      fanPct: ctl.fanPct,
      lightsOn,
      humidifierOn: auxState.boostHumOn || auxState.constantHumOn,
      heaterOn: auxState.heaterOn,
    }
    rh = step(cfg.modelHumidity, rh, inputs, cfg.dtS)
    tempF = step(cfg.modelTemp, tempF, inputs, cfg.dtS)
  }

  return { samples, setpointTrack, config: cfg }
}

// ─────────────────────────────────────────────────────────────────────────────
// Replay mode: given a window of real sensor_readings, feed the real fan
// commands + lights + aux states into the tent model, and feed the real
// (rh, temp) into the PID controller. Two comparisons fall out:
//
//  (1) PID prediction error: does our sim-PID produce the same fan command
//      Hubitat actually produced?  If yes, the port is faithful.
//  (2) Model accuracy: does the tent model predict the same rh/temp
//      trajectory the sensors saw?  If yes, the model is calibrated.
//
// Both errors go into pid_sim_metrics so the user can track drift over time.
// ─────────────────────────────────────────────────────────────────────────────

export interface ReplayPoint {
  tMs: number
  rh: number
  tempF: number
  fanPct: number
  lightsOn: boolean
  humidifierOn: boolean
  heaterOn: boolean
}

export interface ReplayResult {
  samples: SimSample[]
  predictedFan: number[]      // per step: sim-PID prediction
  actualFan: number[]         // per step: what Hubitat logged
  predictedRh: number[]       // model rollout from initial RH
  actualRh: number[]          // what sensors saw
  controllerRmse: number
  modelRmse: number
}

export function replayFromHistory(
  points: ReplayPoint[],
  pid: PidConfig,
  setpoint: SetpointRow,
  modelHumidity: TentModel,
): ReplayResult {
  if (points.length < 2) {
    throw new Error('Replay requires at least 2 points')
  }

  const pidState = makeState(pid)
  resetPid(
    pidState,
    pid,
    points[0].rh,
    rhTarget(setpoint, points[0].lightsOn),
    points[0].tMs,
  )

  let rhModel = points[0].rh
  const samples: SimSample[] = []
  const predictedFan: number[] = []
  const actualFan: number[] = []
  const predictedRh: number[] = []
  const actualRh: number[] = []

  let ctrlSse = 0
  let modelSse = 0

  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    const targetRh = rhTarget(setpoint, p.lightsOn)
    // Run PID on the REAL rh/temp — this predicts what Hubitat should do.
    const ctl = tick(pidState, pid, p.rh, targetRh, p.tempF, p.tMs)

    predictedFan.push(ctl.fanPct)
    actualFan.push(p.fanPct)
    ctrlSse += (ctl.fanPct - p.fanPct) ** 2

    predictedRh.push(rhModel)
    actualRh.push(p.rh)
    modelSse += (rhModel - p.rh) ** 2

    samples.push({
      t_s: (p.tMs - points[0].tMs) / 1000,
      setpoint: targetRh,
      rh: p.rh,
      temp_f: p.tempF,
      vpd_kpa: calcVpdKpa(p.tempF, p.rh),
      fan_pct: p.fanPct,
      humidifier: p.humidifierOn,
      heater: p.heaterOn,
      lights_on: p.lightsOn,
      error: ctl.error,
      p_term: ctl.pTerm,
      i_term: ctl.iTerm,
      d_term: ctl.dTerm,
    })

    // Advance model using REAL actuator inputs (not the sim-predicted fan).
    if (i < points.length - 1) {
      const dtS = (points[i + 1].tMs - p.tMs) / 1000
      if (dtS > 0 && dtS < MAX_GAP_S) {
        rhModel = step(
          modelHumidity,
          rhModel,
          {
            fanPct: p.fanPct,
            lightsOn: p.lightsOn,
            humidifierOn: p.humidifierOn,
            heaterOn: p.heaterOn,
          },
          dtS,
        )
      }
    }
  }

  return {
    samples,
    predictedFan,
    actualFan,
    predictedRh,
    actualRh,
    controllerRmse: Math.sqrt(ctrlSse / points.length),
    modelRmse: Math.sqrt(modelSse / points.length),
  }
}