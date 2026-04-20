// Tent thermal / humidity model.
//
// First-order lag driven by exhaust fan, lights, humidifiers, and heater:
//
//     dY/dt = (ambient - Y)/tau
//             + gainFan * (fanPct / 100)        // fan pulls toward ambient faster
//             + gainLights * lightsOn
//             + gainHumidifier * humidifierOn
//             + gainHeater * heaterOn
//
// This is a deliberately simple plant model. Real grow tents have second-order
// thermal mass + coupled RH/temp dynamics, but first-order captures enough for
// useful PID tuning. The residuals of the fit are logged so you can tell when
// it's time to upgrade to a richer model.
//
// The step method uses exact discretization of the linear part (zero-order
// hold on the input), which stays stable at any dt you throw at it:
//
//     Y[k+1] = Y_ss + (Y[k] - Y_ss) * exp(-dt/tau)
//
// where Y_ss is the steady-state value the system is heading toward given the
// *current* input vector.

import type { TentModelRow } from './types'

export interface TentModel {
  tauS: number
  ambient: number
  gainFan: number
  gainLights: number
  gainHumidifier: number
  gainHeater: number
}

export function modelFromRow(row: TentModelRow): TentModel {
  return {
    tauS: Number(row.tau_s),
    ambient: Number(row.ambient),
    gainFan: Number(row.gain_fan),
    gainLights: Number(row.gain_lights),
    gainHumidifier: Number(row.gain_humidifier),
    gainHeater: Number(row.gain_heater),
  }
}

export interface Inputs {
  fanPct: number      // 0..100
  lightsOn: boolean
  humidifierOn: boolean
  heaterOn: boolean
}

/** Steady-state value of the controlled metric given the inputs. */
export function steadyState(m: TentModel, u: Inputs): number {
  return (
    m.ambient +
    m.tauS *
      (m.gainFan * (u.fanPct / 100) +
        m.gainLights * (u.lightsOn ? 1 : 0) +
        m.gainHumidifier * (u.humidifierOn ? 1 : 0) +
        m.gainHeater * (u.heaterOn ? 1 : 0))
  )
}

/** Advance the model one step of `dtS` seconds. Returns the new Y. */
export function step(m: TentModel, y: number, u: Inputs, dtS: number): number {
  const ySs = steadyState(m, u)
  const decay = Math.exp(-dtS / m.tauS)
  return ySs + (y - ySs) * decay
}

// ── Model fitting ───────────────────────────────────────────────────────────
//
// Given a time-aligned history of (y, fan, lights, humidifier, heater),
// fit (tau, ambient, gainFan, gainLights, gainHumidifier, gainHeater) by
// linear least squares.
//
// Derivation: discretizing dY/dt = (a - Y)/tau + sum(g_i * u_i) by forward
// Euler with a *small enough* sampling period gives:
//
//     (Y[k+1] - Y[k]) / dt = (1/tau)*a - (1/tau)*Y[k] + sum(g_i * u_i[k])
//
// Let β0 = (1/tau)*a, β1 = -(1/tau), β_{2..} = g_i. Stack rows and solve.
// Recover tau = -1/β1, ambient = β0 / (1/tau) = -β0/β1.

export interface FitSample {
  tMs: number            // timestamp (ms)
  y: number              // the controlled metric at this time
  fanPct: number
  lightsOn: boolean
  humidifierOn: boolean
  heaterOn: boolean
}

export interface FitResult {
  model: TentModel
  rmse: number
  samples: number
  windowHours: number
}

const MAX_GAP_S = 1800 // skip gaps > 30 minutes

/**
 * Fit a TentModel from time-series samples using ordinary least squares.
 *
 * Samples should be sorted by tMs ascending and ideally uniformly spaced
 * (resample before calling if necessary).
 *
 * `features` selects which input channels to fit. Omit channels the hardware
 * lacks (e.g. no heater) to avoid over-fitting.
 */
export function fitTentModel(
  samples: FitSample[],
  features: {
    fan?: boolean
    lights?: boolean
    humidifier?: boolean
    heater?: boolean
  } = { fan: true, lights: true, humidifier: true, heater: true },
): FitResult {
  if (samples.length < 10) {
    throw new Error(`Need at least 10 samples to fit; got ${samples.length}`)
  }

  const cols: string[] = ['bias', 'y']
  if (features.fan) cols.push('fan')
  if (features.lights) cols.push('lights')
  if (features.humidifier) cols.push('humidifier')
  if (features.heater) cols.push('heater')

  const rows: number[][] = []
  const targets: number[] = []

  for (let i = 0; i < samples.length - 1; i++) {
    const a = samples[i]
    const b = samples[i + 1]
    const dtS = (b.tMs - a.tMs) / 1000
    if (dtS <= 0 || dtS > MAX_GAP_S) continue

    const dyDt = (b.y - a.y) / dtS
    targets.push(dyDt)

    const row: number[] = [1, a.y]
    if (features.fan) row.push(a.fanPct / 100)
    if (features.lights) row.push(a.lightsOn ? 1 : 0)
    if (features.humidifier) row.push(a.humidifierOn ? 1 : 0)
    if (features.heater) row.push(a.heaterOn ? 1 : 0)
    rows.push(row)
  }

  if (rows.length < cols.length + 2) {
    throw new Error(
      `Not enough valid transitions to fit ${cols.length} coefficients (have ${rows.length})`,
    )
  }

  const beta = leastSquares(rows, targets)

  // β[0] = a/tau, β[1] = -1/tau → tau = -1/β[1], ambient = -β[0]/β[1]
  const invTau = -beta[1]
  if (invTau <= 0 || !Number.isFinite(invTau)) {
    throw new Error(
      `Fit produced non-physical time constant (1/tau = ${invTau}). ` +
        `Check that your history has meaningful actuator variation.`,
    )
  }
  const tauS = 1 / invTau
  const ambient = beta[0] / invTau

  let idx = 2
  const gainFan = features.fan ? beta[idx++] : 0
  const gainLights = features.lights ? beta[idx++] : 0
  const gainHumidifier = features.humidifier ? beta[idx++] : 0
  const gainHeater = features.heater ? beta[idx++] : 0

  const model: TentModel = {
    tauS,
    ambient,
    gainFan,
    gainLights,
    gainHumidifier,
    gainHeater,
  }

  // residual RMSE on the training set
  let sse = 0
  let n = 0
  for (let i = 0; i < samples.length - 1; i++) {
    const a = samples[i]
    const b = samples[i + 1]
    const dtS = (b.tMs - a.tMs) / 1000
    if (dtS <= 0 || dtS > MAX_GAP_S) continue
    const yPred = step(
      model,
      a.y,
      {
        fanPct: a.fanPct,
        lightsOn: a.lightsOn,
        humidifierOn: a.humidifierOn,
        heaterOn: a.heaterOn,
      },
      dtS,
    )
    const e = b.y - yPred
    sse += e * e
    n++
  }
  const rmse = Math.sqrt(sse / Math.max(1, n))

  const windowHours =
    (samples[samples.length - 1].tMs - samples[0].tMs) / 3_600_000

  return { model, rmse, samples: n, windowHours }
}

// ── Tiny numerical helpers — no dependency on a matrix library ─────────────

/** Ordinary least squares via normal equations with ridge for conditioning. */
function leastSquares(X: number[][], y: number[], ridge = 1e-8): number[] {
  const m = X.length
  const n = X[0].length
  // A = X^T X + ridge*I     b = X^T y
  const A: number[][] = Array.from({ length: n }, () => Array(n).fill(0))
  const b: number[] = Array(n).fill(0)

  for (let i = 0; i < m; i++) {
    for (let j = 0; j < n; j++) {
      b[j] += X[i][j] * y[i]
      for (let k = j; k < n; k++) {
        A[j][k] += X[i][j] * X[i][k]
      }
    }
  }
  for (let j = 0; j < n; j++) {
    A[j][j] += ridge
    for (let k = j + 1; k < n; k++) A[k][j] = A[j][k]
  }

  return solve(A, b)
}

/** Gauss–Jordan with partial pivoting. Modifies A, b in place. */
function solve(A: number[][], b: number[]): number[] {
  const n = A.length
  const M: number[][] = A.map((row, i) => [...row, b[i]])

  for (let i = 0; i < n; i++) {
    // pivot
    let maxRow = i
    let maxVal = Math.abs(M[i][i])
    for (let r = i + 1; r < n; r++) {
      const v = Math.abs(M[r][i])
      if (v > maxVal) {
        maxVal = v
        maxRow = r
      }
    }
    if (maxVal < 1e-12) {
      throw new Error('Singular matrix in least-squares solve')
    }
    if (maxRow !== i) [M[i], M[maxRow]] = [M[maxRow], M[i]]

    // eliminate
    for (let r = 0; r < n; r++) {
      if (r === i) continue
      const factor = M[r][i] / M[i][i]
      for (let c = i; c <= n; c++) M[r][c] -= factor * M[i][c]
    }
  }

  return M.map((row, i) => row[n] / row[i])
}