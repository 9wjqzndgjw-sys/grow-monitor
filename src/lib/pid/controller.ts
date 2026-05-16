// PID controller — 1:1 port of the Hubitat Cannabis Climate Controller v3
// Groovy app (smartapps/cannabis-climate-controller-v3.groovy). Same dt units
// (minutes), same anti-windup clamp, same 3 % deadband, same warm-seeded
// integral on reset, same tent-open suppression, same light-triggered reset,
// same v3 humidifier/heater hysteresis.
//
// Keep this file faithful — every deviation widens the gap between sim and
// reality. If the Groovy app changes, change here too.

import type { PidParamsRow, SetpointRow } from './types'

// ── VPD ─────────────────────────────────────────────────────────────────────

/** VPD in kPa via the Magnus formula. Input temp is °F, RH is %. */
export function calcVpdKpa(tempF: number, rhPct: number): number {
  const tempC = ((tempF - 32) * 5) / 9
  const svp = 0.6108 * Math.exp((17.27 * tempC) / (tempC + 237.3))
  return Number(((1 - rhPct / 100) * svp).toFixed(4))
}

// ── Config + state ──────────────────────────────────────────────────────────

export interface PidConfig {
  kp: number
  ki: number
  kd: number
  fanBasePct: number
  fanMinPct: number
  fanMaxPct: number
  integralMax: number
  deadbandPct: number
  dtCapMin: number
  tentOpenVpdKpa: number
  warmSeedFactor: number
}

export function configFromRow(row: PidParamsRow): PidConfig {
  return {
    kp: Number(row.kp),
    ki: Number(row.ki),
    kd: Number(row.kd),
    fanBasePct: Number(row.fan_base_pct),
    fanMinPct: Number(row.fan_min_pct),
    fanMaxPct: Number(row.fan_max_pct),
    integralMax: Number(row.integral_max),
    deadbandPct: Number(row.deadband_pct),
    dtCapMin: Number(row.dt_cap_min),
    tentOpenVpdKpa: Number(row.tent_open_vpd_kpa),
    warmSeedFactor: Number(row.warm_seed_factor),
  }
}

export const DEFAULT_PID_CONFIG: PidConfig = {
  kp: 3.0,
  ki: 0.05,
  kd: 1.5,
  fanBasePct: 30,
  fanMinPct: 20,
  fanMaxPct: 100,
  integralMax: 15.0,
  deadbandPct: 3.0,
  dtCapMin: 5.0,
  tentOpenVpdKpa: 0.15,
  warmSeedFactor: 2.0,
}

// Groovy `pidFanSpeed` smooths the derivative term with a fixed EMA:
//   smoothDeriv = 0.3 * rawDeriv + 0.7 * lastDeriv
const DERIV_SMOOTH_ALPHA = 0.3

export interface PidState {
  integral: number
  lastError: number
  lastDeriv: number
  lastTimeMs: number | null
  lastVpd: number | null
  lastFanPct: number
}

export function makeState(config: PidConfig = DEFAULT_PID_CONFIG): PidState {
  return {
    integral: 0,
    lastError: 0,
    lastDeriv: 0,
    lastTimeMs: null,
    lastVpd: null,
    lastFanPct: config.fanBasePct,
  }
}

export interface TickResult {
  fanPct: number
  error: number
  pTerm: number
  iTerm: number
  dTerm: number
  tentOpen: boolean
  skipped: boolean
  dtMin: number
}

// ── Reset (Groovy `resetPID`) ───────────────────────────────────────────────

export function resetPid(
  state: PidState,
  cfg: PidConfig,
  currRh: number,
  targetRh: number,
  nowMs: number,
): void {
  const err = Number.isFinite(currRh) ? currRh - targetRh : 0
  state.integral = err * cfg.warmSeedFactor
  state.lastError = err
  state.lastDeriv = 0
  state.lastTimeMs = nowMs
}

// ── Tick (Groovy `evaluateClimate` + `pidFanSpeed`) ─────────────────────────

export function tick(
  state: PidState,
  cfg: PidConfig,
  currRh: number,
  targetRh: number,
  currTempF: number,
  nowMs: number,
): TickResult {
  // --- tent-open detection (VPD delta) ------------------------------------
  const currVpd = calcVpdKpa(currTempF, currRh)
  const lastVpd = state.lastVpd ?? currVpd
  const vpdDelta = Math.abs(currVpd - lastVpd)
  state.lastVpd = currVpd
  const tentOpen = vpdDelta > cfg.tentOpenVpdKpa

  if (tentOpen) {
    state.integral = 0
    state.lastError = 0
    state.lastTimeMs = nowMs
    return {
      fanPct: state.lastFanPct,
      error: 0,
      pTerm: 0,
      iTerm: 0,
      dTerm: 0,
      tentOpen: true,
      skipped: true,
      dtMin: 0,
    }
  }

  // --- dt in minutes (NOT seconds — Groovy uses minutes) ------------------
  const lastMs = state.lastTimeMs ?? nowMs
  let dt = (nowMs - lastMs) / 60_000
  if (dt <= 0) dt = 1
  if (dt > cfg.dtCapMin) dt = cfg.dtCapMin

  // --- error + integral (anti-windup clamp) -------------------------------
  const error = currRh - targetRh
  let integ = state.integral + error * dt
  integ = Math.max(-cfg.integralMax, Math.min(cfg.integralMax, integ))

  // --- derivative (EMA-smoothed, Groovy `pidFanSpeed`) --------------------
  const rawDeriv = (error - state.lastError) / dt
  const smoothDeriv =
    DERIV_SMOOTH_ALPHA * rawDeriv + (1 - DERIV_SMOOTH_ALPHA) * state.lastDeriv
  state.lastDeriv = smoothDeriv

  const pTerm = cfg.kp * error
  const iTerm = cfg.ki * integ
  const dTerm = cfg.kd * smoothDeriv
  const rawOutput = pTerm + iTerm + dTerm

  let fan = Math.round(cfg.fanBasePct + rawOutput)
  fan = Math.max(cfg.fanMinPct, Math.min(cfg.fanMaxPct, fan))

  // --- persist state ------------------------------------------------------
  state.lastError = error
  state.integral = integ
  state.lastTimeMs = nowMs

  // --- 3 % deadband -------------------------------------------------------
  const commanded =
    Math.abs(fan - state.lastFanPct) >= cfg.deadbandPct ? fan : state.lastFanPct
  state.lastFanPct = commanded

  return {
    fanPct: commanded,
    error,
    pTerm,
    iTerm,
    dTerm,
    tentOpen: false,
    skipped: false,
    dtMin: dt,
  }
}

// ── Setpoint helper ─────────────────────────────────────────────────────────

export function rhTarget(sp: SetpointRow, lightsOn: boolean): number {
  return lightsOn ? Number(sp.rh_day_pct) : Number(sp.rh_night_pct)
}

export function tempTarget(sp: SetpointRow, lightsOn: boolean): number {
  return lightsOn ? Number(sp.temp_day_f) : Number(sp.temp_night_f)
}

// ── Auxiliary hysteretic controls ───────────────────────────────────────────

export interface AuxState {
  constantHumOn: boolean
  boostHumOn: boolean
  heaterOn: boolean
}

export function makeAuxState(): AuxState {
  return { constantHumOn: false, boostHumOn: false, heaterOn: false }
}

// v3 aux tunables. Defaults mirror the Groovy `defaultValue`s so a sim with
// no overrides reproduces the shipped controller exactly.
export interface AuxConfig {
  /** Groovy `heaterAllowLightsOn` — run heater during lights ON. */
  heaterAllowLightsOn: boolean
  /** Groovy `heaterOnDiff` — ON when temp this far below target (°F). */
  heaterOnDiffF: number
  /** Groovy `heaterOffDiff` — OFF when temp this far above target (°F). */
  heaterOffDiffF: number
  /** Groovy SEEDLING stage runs the constant humidifier 24/7. */
  constantHumidifierAlwaysOn: boolean
}

export const DEFAULT_AUX_CONFIG: AuxConfig = {
  heaterAllowLightsOn: true,
  heaterOnDiffF: 1.5,
  heaterOffDiffF: 0.5,
  constantHumidifierAlwaysOn: false,
}

export function auxControl(
  aux: AuxState,
  currRh: number,
  targetRh: number,
  currTempF: number,
  targetTempF: number,
  lightsOn: boolean,
  hasBoost = true,
  hasHeater = true,
  cfg: AuxConfig = DEFAULT_AUX_CONFIG,
): AuxState {
  // ── Humidifiers (Groovy `controlHumidifiers`) ──────────────────────────
  // Constant runs whenever lights are on OR the stage needs 24/7 humidity
  // (SEEDLING). Boost only when RH is well below target.
  const wantConstant = lightsOn || cfg.constantHumidifierAlwaysOn
  if (!wantConstant) {
    aux.constantHumOn = false
    aux.boostHumOn = false
  } else {
    aux.constantHumOn = true
    if (hasBoost) {
      const diff = currRh - targetRh
      if (!aux.boostHumOn && diff <= -8) aux.boostHumOn = true
      else if (aux.boostHumOn && diff >= -4) aux.boostHumOn = false
    }
  }

  // ── Heater (Groovy `manageHeater`) ─────────────────────────────────────
  if (!hasHeater) {
    aux.heaterOn = false
    return aux
  }
  if (lightsOn && !cfg.heaterAllowLightsOn) {
    aux.heaterOn = false
    return aux
  }
  const diff = currTempF - targetTempF
  if (!aux.heaterOn && diff <= -cfg.heaterOnDiffF) aux.heaterOn = true
  else if (aux.heaterOn && diff >= cfg.heaterOffDiffF) aux.heaterOn = false

  return aux
}