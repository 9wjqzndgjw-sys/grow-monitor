import { describe, it, expect } from 'vitest'
import {
  DEFAULT_AUX_CONFIG,
  DEFAULT_PID_CONFIG,
  auxControl,
  makeAuxState,
  makeState,
  resetPid,
  tick,
  type AuxConfig,
  type PidConfig,
} from './controller'

// Gains isolate the D-term; huge tent-open + dt caps keep the math
// deterministic so we can assert the exact v3 EMA values.
const D_ONLY: PidConfig = {
  ...DEFAULT_PID_CONFIG,
  kp: 0,
  ki: 0,
  kd: 1,
  tentOpenVpdKpa: 1e9,
  dtCapMin: 1e9,
  deadbandPct: 0,
}

describe('tick() derivative smoothing — v3 parity', () => {
  it('applies smoothDeriv = 0.3*raw + 0.7*lastDeriv across ticks', () => {
    const s = makeState(D_ONLY)
    resetPid(s, D_ONLY, 50, 50, 0) // error 0 → lastError/lastDeriv 0

    // tick 1: error 5, lastError 0, dt 1 min → raw 5, smooth 0.3*5 = 1.5
    const r1 = tick(s, D_ONLY, 55, 50, 75, 60_000)
    expect(r1.dTerm).toBeCloseTo(1.5, 6)
    expect(s.lastDeriv).toBeCloseTo(1.5, 6)
    expect(s.lastError).toBe(5)

    // tick 2: error 3, lastError 5, dt 1 → raw -2,
    // smooth 0.3*(-2) + 0.7*1.5 = 0.45
    const r2 = tick(s, D_ONLY, 53, 50, 75, 120_000)
    expect(r2.dTerm).toBeCloseTo(0.45, 6)
    expect(s.lastDeriv).toBeCloseTo(0.45, 6)
  })

  it('resetPid zeroes the smoothed derivative', () => {
    const s = makeState(DEFAULT_PID_CONFIG)
    s.lastDeriv = 9
    resetPid(s, DEFAULT_PID_CONFIG, 60, 55, 1000)
    expect(s.lastDeriv).toBe(0)
  })
})

describe('auxControl() heater — v3 parity', () => {
  it('runs the heater during lights-on by default (heaterAllowLightsOn)', () => {
    const aux = makeAuxState()
    // 2°F below target, lights on → on (default onDiff 1.5)
    auxControl(aux, 50, 50, 70, 72, true)
    expect(aux.heaterOn).toBe(true)
  })

  it('keeps the heater off during lights-on when disabled', () => {
    const cfg: AuxConfig = { ...DEFAULT_AUX_CONFIG, heaterAllowLightsOn: false }
    const aux = makeAuxState()
    auxControl(aux, 50, 50, 50, 72, true, true, true, cfg)
    expect(aux.heaterOn).toBe(false)
  })

  it('honors the 1.5°F-on / 0.5°F-off hysteresis band', () => {
    const aux = makeAuxState()
    auxControl(aux, 50, 50, 70, 72, false) // diff -2 ≤ -1.5 → on
    expect(aux.heaterOn).toBe(true)
    auxControl(aux, 50, 50, 72.4, 72, false) // diff 0.4 < 0.5 → stays on
    expect(aux.heaterOn).toBe(true)
    auxControl(aux, 50, 50, 72.6, 72, false) // diff 0.6 ≥ 0.5 → off
    expect(aux.heaterOn).toBe(false)
  })
})

describe('auxControl() humidifiers — v3 parity', () => {
  it('runs the constant humidifier 24/7 when alwaysOn (SEEDLING)', () => {
    const cfg: AuxConfig = {
      ...DEFAULT_AUX_CONFIG,
      constantHumidifierAlwaysOn: true,
    }
    const aux = makeAuxState()
    auxControl(aux, 50, 50, 72, 72, false, true, true, cfg) // lights off
    expect(aux.constantHumOn).toBe(true)
  })

  it('keeps both humidifiers off at night when not alwaysOn', () => {
    const aux = makeAuxState()
    auxControl(aux, 30, 50, 72, 72, false) // lights off, default cfg
    expect(aux.constantHumOn).toBe(false)
    expect(aux.boostHumOn).toBe(false)
  })

  it('boost hysteresis: on at -8, off at -4', () => {
    const aux = makeAuxState()
    auxControl(aux, 40, 50, 72, 72, true) // diff -10 ≤ -8 → boost on
    expect(aux.boostHumOn).toBe(true)
    auxControl(aux, 45, 50, 72, 72, true) // diff -5, not ≥ -4 → stays on
    expect(aux.boostHumOn).toBe(true)
    auxControl(aux, 46, 50, 72, 72, true) // diff -4 ≥ -4 → off
    expect(aux.boostHumOn).toBe(false)
  })
})
