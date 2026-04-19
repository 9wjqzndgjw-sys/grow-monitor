// Accuracy / performance metrics for a simulation or replay trajectory.
//
// All metrics assume `samples` is time-ordered with roughly constant dt.
// Settling time uses a ±band around the final setpoint. Overshoot is measured
// against the initial setpoint step.

import type { SimSample, SimMetricsRow } from './types'

export interface Metrics {
  rmse: number
  mae: number
  iae: number
  ise: number
  overshootPct: number | null
  settlingTimeS: number | null
  settlingBandPct: number
  steadyStateError: number | null
  riseTimeS: number | null
  controlEffort: number | null
  modelRmse?: number | null
}

export interface MetricsOptions {
  /** ±band for settling-time, as a % of the setpoint. Default 2 %. */
  settlingBandPct?: number
  /** Fraction of tail used for steady-state-error. Default 0.1 (last 10 %). */
  tailFrac?: number
  /** Override the initial value; otherwise taken from samples[0].rh. */
  initialValue?: number
  /** Optional replay model RMSE to bundle into the metrics row. */
  modelRmse?: number
}

export function computeMetrics(
  samples: SimSample[],
  opts: MetricsOptions = {},
): Metrics {
  if (samples.length < 2) {
    return {
      rmse: 0,
      mae: 0,
      iae: 0,
      ise: 0,
      overshootPct: null,
      settlingTimeS: null,
      settlingBandPct: opts.settlingBandPct ?? 2,
      steadyStateError: null,
      riseTimeS: null,
      controlEffort: null,
      modelRmse: opts.modelRmse ?? null,
    }
  }

  const n = samples.length
  const band = opts.settlingBandPct ?? 2
  const tailFrac = opts.tailFrac ?? 0.1
  const initial = opts.initialValue ?? samples[0].rh

  let sse = 0
  let sae = 0
  let iae = 0
  let ise = 0
  let effortSum = 0
  for (let i = 0; i < n; i++) {
    const e = samples[i].error
    sse += e * e
    sae += Math.abs(e)
    const dt = i > 0 ? samples[i].t_s - samples[i - 1].t_s : 0
    iae += Math.abs(e) * dt
    ise += e * e * dt
    if (i > 0) effortSum += Math.abs(samples[i].fan_pct - samples[i - 1].fan_pct)
  }
  const rmse = Math.sqrt(sse / n)
  const mae = sae / n
  const controlEffort = n > 1 ? effortSum / (n - 1) : 0

  // --- overshoot (% beyond setpoint on first crossing) --------------------
  const sp0 = samples[0].setpoint
  const rising = initial < sp0
  let overshootPct: number | null = null
  let crossedIdx = -1
  for (let i = 1; i < n; i++) {
    const s = samples[i]
    if (rising && s.rh >= s.setpoint) {
      crossedIdx = i
      break
    }
    if (!rising && s.rh <= s.setpoint) {
      crossedIdx = i
      break
    }
  }
  if (crossedIdx >= 0) {
    let extreme = samples[crossedIdx].rh
    for (let i = crossedIdx; i < n; i++) {
      const s = samples[i]
      if (rising && s.rh > extreme) extreme = s.rh
      if (!rising && s.rh < extreme) extreme = s.rh
      // stop once clearly coming back
      if (rising && s.rh < s.setpoint) break
      if (!rising && s.rh > s.setpoint) break
    }
    const stepSize = Math.abs(sp0 - initial)
    if (stepSize > 1e-6) {
      overshootPct = (Math.abs(extreme - sp0) / stepSize) * 100
    }
  }

  // --- rise time (10 %→90 % of step) --------------------------------------
  let riseTimeS: number | null = null
  if (Math.abs(sp0 - initial) > 1e-6) {
    const target10 = initial + (sp0 - initial) * 0.1
    const target90 = initial + (sp0 - initial) * 0.9
    let t10 = -1
    let t90 = -1
    for (const s of samples) {
      if (t10 < 0 && ((rising && s.rh >= target10) || (!rising && s.rh <= target10))) t10 = s.t_s
      if (t90 < 0 && ((rising && s.rh >= target90) || (!rising && s.rh <= target90))) {
        t90 = s.t_s
        break
      }
    }
    if (t10 >= 0 && t90 >= 0) riseTimeS = t90 - t10
  }

  // --- settling time — last time we left the ±band around final SP --------
  const finalSp = samples[n - 1].setpoint
  const bandVal = Math.abs(finalSp) * (band / 100)
  let settlingTimeS: number | null = null
  let leftBandAt = -1
  for (let i = 0; i < n; i++) {
    if (Math.abs(samples[i].rh - finalSp) > bandVal) leftBandAt = samples[i].t_s
  }
  if (leftBandAt >= 0 && leftBandAt < samples[n - 1].t_s) {
    settlingTimeS = leftBandAt
  }

  // --- steady-state error (mean error over last tailFrac) -----------------
  const tailStart = Math.floor(n * (1 - tailFrac))
  let tailErr = 0
  let tailCount = 0
  for (let i = tailStart; i < n; i++) {
    tailErr += samples[i].error
    tailCount++
  }
  const steadyStateError = tailCount > 0 ? tailErr / tailCount : null

  return {
    rmse,
    mae,
    iae,
    ise,
    overshootPct,
    settlingTimeS,
    settlingBandPct: band,
    steadyStateError,
    riseTimeS,
    controlEffort,
    modelRmse: opts.modelRmse ?? null,
  }
}

/** Convenience: convert Metrics to a row shape ready for Supabase insert. */
export function metricsToRow(
  runId: number,
  m: Metrics,
): Omit<SimMetricsRow, 'computed_at'> {
  return {
    run_id: runId,
    rmse: m.rmse,
    mae: m.mae,
    iae: m.iae,
    ise: m.ise,
    overshoot_pct: m.overshootPct,
    settling_time_s: m.settlingTimeS,
    settling_band_pct: m.settlingBandPct,
    steady_state_error: m.steadyStateError,
    rise_time_s: m.riseTimeS,
    control_effort: m.controlEffort,
    model_rmse: m.modelRmse ?? null,
  }
}