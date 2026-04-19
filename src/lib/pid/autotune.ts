// PID auto-tuners.
//
// Two approaches are provided:
//
//   ziegler_nichols_step — Open-loop method. Runs a step response against
//     the tent model (fan 30 → 100) and reads off process gain K, dead-time L,
//     and time constant T. Returns the Z-N rule-of-thumb gains for a PID.
//
//   relay_autotune — Closed-loop Åström-Hägglund relay method. Toggles the
//     fan between two levels around fanBase and measures the ultimate period
//     Tu and ultimate gain Ku from the induced oscillation.
//
// Both are *starting points*, not final answers. Always refine by running a
// real simulation afterward and inspecting the accuracy metrics.

import {
  DEFAULT_PID_CONFIG,
  type PidConfig,
} from './controller'
import { step, type TentModel, type Inputs } from './model'

export interface StepFitResult {
  K: number         // steady-state gain (ΔY / Δu fraction)
  L: number         // dead time (seconds)
  T: number         // time constant (seconds)
  kp: number
  ki: number
  kd: number
}

/**
 * Open-loop step-response Z-N tuning.
 *
 * We simulate a step in the fan from `u0` to `u1` (both in percent) against
 * the model, then fit a first-order-plus-dead-time (FOPDT) approximation by
 * reading K = ΔY∞/Δu, L = time until 10 % response, T = time until 63 %
 * response minus L.
 *
 * Returned gains are the Ziegler-Nichols "classic" values:
 *     Kp = 1.2 * T / (K * L)
 *     Ki = Kp / (2L)
 *     Kd = Kp * L / 2
 */
export function zieglerNicholsStep(
  model: TentModel,
  opts: {
    u0?: number
    u1?: number
    lightsOn?: boolean
    humidifierOn?: boolean
    heaterOn?: boolean
    initialY?: number
    dtS?: number
    durationS?: number
  } = {},
): StepFitResult {
  const u0 = opts.u0 ?? 30
  const u1 = opts.u1 ?? 100
  const dtS = opts.dtS ?? 5
  const durationS = opts.durationS ?? Math.max(model.tauS * 5, 900)
  const lightsOn = opts.lightsOn ?? true
  const humidifierOn = opts.humidifierOn ?? false
  const heaterOn = opts.heaterOn ?? false

  const mkInputs = (fanPct: number): Inputs => ({
    fanPct,
    lightsOn,
    humidifierOn,
    heaterOn,
  })

  // Run to steady state at u0 so the step response is clean.
  let y = opts.initialY ?? model.ambient
  for (let t = 0; t < model.tauS * 5; t += dtS) y = step(model, y, mkInputs(u0), dtS)
  const y0 = y

  // Step to u1, collect trace.
  const trace: Array<{ t: number; y: number }> = [{ t: 0, y: y0 }]
  const nSteps = Math.ceil(durationS / dtS)
  for (let i = 1; i <= nSteps; i++) {
    y = step(model, y, mkInputs(u1), dtS)
    trace.push({ t: i * dtS, y })
  }

  const yInf = trace[trace.length - 1].y
  const dy = yInf - y0
  const du = (u1 - u0) / 100
  const K = Math.abs(du) > 1e-9 ? dy / du : 0
  if (Math.abs(K) < 1e-9) {
    throw new Error('Auto-tune: step produced no measurable process gain')
  }

  // L = time to reach 10 % of dy, T63 = time to reach 63.2 % of dy, T = T63 - L
  const target10 = y0 + dy * 0.1
  const target63 = y0 + dy * 0.632
  const rising = dy > 0
  let L = 0
  let T63 = 0
  for (const p of trace) {
    if (!L && ((rising && p.y >= target10) || (!rising && p.y <= target10))) L = p.t
    if (!T63 && ((rising && p.y >= target63) || (!rising && p.y <= target63))) {
      T63 = p.t
      break
    }
  }
  if (L === 0) L = dtS                   // avoid div-by-zero
  const T = Math.max(T63 - L, dtS)

  // Z-N "classic PID" rule
  const kp = (1.2 * T) / (Math.abs(K) * L)
  const ki = kp / (2 * L)
  const kd = (kp * L) / 2

  return { K, L, T, kp, ki, kd }
}

// ─────────────────────────────────────────────────────────────────────────────
// Relay (Åström-Hägglund) auto-tune
//
// Idea: replace the PID with a relay: fan = fanBase + h if error > 0, else
// fan = fanBase - h. The closed loop settles into a limit cycle. Read off
// the amplitude `a` and period `Tu` of the controlled variable. Ultimate
// gain is `Ku = 4h / (π a)`. Apply Z-N from (Ku, Tu).
// ─────────────────────────────────────────────────────────────────────────────

export interface RelayResult {
  Ku: number
  Tu: number
  kp: number
  ki: number
  kd: number
  trace: Array<{ t: number; y: number; fan: number }>
}

export function relayAutotune(
  model: TentModel,
  setpoint: number,
  opts: {
    relayHeightPct?: number
    fanBasePct?: number
    fanMinPct?: number
    fanMaxPct?: number
    initialY?: number
    dtS?: number
    maxDurationS?: number
    minCycles?: number
  } = {},
): RelayResult {
  const h = opts.relayHeightPct ?? 25
  const fanBase = opts.fanBasePct ?? DEFAULT_PID_CONFIG.fanBasePct
  const fanMin = opts.fanMinPct ?? DEFAULT_PID_CONFIG.fanMinPct
  const fanMax = opts.fanMaxPct ?? DEFAULT_PID_CONFIG.fanMaxPct
  const dtS = opts.dtS ?? 5
  const maxDurationS = opts.maxDurationS ?? Math.max(model.tauS * 20, 3600)
  const minCycles = opts.minCycles ?? 4

  let y = opts.initialY ?? setpoint
  const trace: Array<{ t: number; y: number; fan: number }> = []
  const crossings: number[] = []
  let lastErrSign = 0

  const nSteps = Math.ceil(maxDurationS / dtS)
  for (let i = 0; i <= nSteps; i++) {
    const t = i * dtS
    const err = y - setpoint
    const fan = Math.max(
      fanMin,
      Math.min(fanMax, fanBase + (err > 0 ? h : -h)),
    )
    trace.push({ t, y, fan })

    // Detect zero-crossings on error (use a small hysteresis for noise safety)
    const sign = err > 0.1 ? 1 : err < -0.1 ? -1 : lastErrSign
    if (sign !== 0 && lastErrSign !== 0 && sign !== lastErrSign) {
      crossings.push(t)
      if (crossings.length >= 2 * minCycles + 1) break
    }
    if (sign !== 0) lastErrSign = sign

    y = step(
      model,
      y,
      { fanPct: fan, lightsOn: true, humidifierOn: false, heaterOn: false },
      dtS,
    )
  }

  if (crossings.length < 3) {
    throw new Error(
      `Relay auto-tune did not produce a limit cycle within ${maxDurationS}s ` +
        `(got ${crossings.length} crossings). Check the model or increase relay height.`,
    )
  }

  // Period = average of diffs over pairs of crossings (one full cycle = 2 crossings)
  const periods: number[] = []
  for (let i = 2; i < crossings.length; i++) {
    periods.push(crossings[i] - crossings[i - 2])
  }
  const Tu = periods.reduce((a, b) => a + b, 0) / periods.length

  // Amplitude = half the peak-to-peak of y during steady-state cycles
  const tailStart = crossings[Math.max(0, crossings.length - 2 * minCycles)]
  const tail = trace.filter((p) => p.t >= tailStart)
  const ys = tail.map((p) => p.y)
  const a = (Math.max(...ys) - Math.min(...ys)) / 2
  if (a < 1e-6) throw new Error('Relay amplitude too small to measure Ku')

  const Ku = (4 * h) / (Math.PI * a)

  // Ziegler-Nichols closed-loop "classic PID"
  const kp = 0.6 * Ku
  const ki = (1.2 * Ku) / Tu
  const kd = (0.075 * Ku) * Tu

  return { Ku, Tu, kp, ki, kd, trace }
}

/** Build a ready-to-save PidConfig from autotune output. */
export function configFromTune(
  gains: { kp: number; ki: number; kd: number },
  base: PidConfig = DEFAULT_PID_CONFIG,
): PidConfig {
  return { ...base, kp: gains.kp, ki: gains.ki, kd: gains.kd }
}