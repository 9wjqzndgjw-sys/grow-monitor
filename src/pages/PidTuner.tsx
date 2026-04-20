import { useEffect, useMemo, useState } from 'react'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend, ReferenceLine,
} from 'recharts'
import { supabase } from '../lib/supabase'
import {
  listPidParams,
  listSetpoints,
  latestTentModel,
} from '../lib/pid/supabase'
import {
  runSimulation,
  computeMetrics,
  configFromRow,
  modelFromRow,
  relayAutotune,
  zieglerNicholsStep,
  type PidParamsRow,
  type SetpointRow,
  type TentModelRow,
  type SimSample,
  type Metrics,
} from '../lib/pid'
import './PidTuner.css'

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const HUMIDITY_DEVICE = 'YoLink Canopy'   // matches your existing dashboard default
const FAN_DEVICE = 'Dimmer'

// ─────────────────────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────────────────────

export default function PidTuner() {
  const [paramSets, setParamSets] = useState<PidParamsRow[]>([])
  const [setpoints, setSetpoints] = useState<SetpointRow[]>([])
  const [selectedParamId, setSelectedParamId] = useState<number | null>(null)
  const [selectedSetpointId, setSelectedSetpointId] = useState<number | null>(null)
  const [modelH, setModelH] = useState<TentModelRow | null>(null)
  const [modelT, setModelT] = useState<TentModelRow | null>(null)

  // Live-editable gains (copy of selected row, overridable before running)
  const [kp, setKp] = useState(3.0)
  const [ki, setKi] = useState(0.05)
  const [kd, setKd] = useState(1.5)
  const [durationMin, setDurationMin] = useState(60)
  const [dtS, setDtS] = useState(15)
  const [lightsOn, setLightsOn] = useState(true)
  const [initialRh, setInitialRh] = useState(60)
  const [initialTempF, setInitialTempF] = useState(78)

  const [samples, setSamples] = useState<SimSample[] | null>(null)
  const [metrics, setMetrics] = useState<Metrics | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [leaderboard, setLeaderboard] = useState<LeaderboardRow[]>([])

  // ── load data ──────────────────────────────────────────────────────────
  useEffect(() => {
    ;(async () => {
      const [p, s, mh, mt] = await Promise.all([
        listPidParams(),
        listSetpoints(),
        latestTentModel(HUMIDITY_DEVICE, 'humidity'),
        latestTentModel(HUMIDITY_DEVICE, 'temperature'),
      ])
      setParamSets(p)
      setSetpoints(s)
      setModelH(mh)
      setModelT(mt)
      if (p.length) {
        setSelectedParamId(p[0].id)
        setKp(Number(p[0].kp))
        setKi(Number(p[0].ki))
        setKd(Number(p[0].kd))
      }
      if (s.length) setSelectedSetpointId(s[0].id)
      loadLeaderboard()
    })()
  }, [])

  async function apiJson(resp: Response): Promise<Record<string, unknown>> {
    const text = await resp.text()
    try { return JSON.parse(text) } catch {
      throw new Error(`Server error (${resp.status}): ${text.slice(0, 200)}`)
    }
  }

  function onParamChange(id: number) {
    setSelectedParamId(id)
    const row = paramSets.find((p) => p.id === id)
    if (row) {
      setKp(Number(row.kp))
      setKi(Number(row.ki))
      setKd(Number(row.kd))
    }
  }

  // ── run sim (client-side; persists via /api/pid/simulate) ──────────────
  async function handleRun() {
    setError(null)
    setRunning(true)
    try {
      if (!selectedParamId || !selectedSetpointId || !modelH || !modelT) {
        throw new Error('Pick a param set, setpoint, and fit models first.')
      }
      const paramRow = paramSets.find((p) => p.id === selectedParamId)!
      const setpoint = setpoints.find((s) => s.id === selectedSetpointId)!
      const pid = {
        ...configFromRow(paramRow),
        kp,
        ki,
        kd,
      }
      const result = runSimulation({
        pid,
        setpoint,
        modelHumidity: modelFromRow(modelH),
        modelTemp: modelFromRow(modelT),
        durationS: durationMin * 60,
        dtS,
        initialRh,
        initialTempF,
        lightsOn,
      })
      const m = computeMetrics(result.samples, { initialValue: initialRh })
      setSamples(result.samples)
      setMetrics(m)

      // Persist the run server-side so the leaderboard records it
      const resp = await fetch('/api/pid/simulate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          params_id: selectedParamId,
          setpoint_id: selectedSetpointId,
          model_humidity_id: modelH.id,
          model_temp_id: modelT.id,
          duration_s: durationMin * 60,
          dt_s: dtS,
          initial_rh: initialRh,
          initial_temp_f: initialTempF,
          lights_on: lightsOn,
          notes: `live: Kp=${kp} Ki=${ki} Kd=${kd}`,
        }),
      })
      if (!resp.ok) {
        const body = await apiJson(resp).catch(() => ({}))
        throw new Error((body as Record<string,unknown>).error as string ?? `Save failed: ${resp.status}`)
      }
      loadLeaderboard()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRunning(false)
    }
  }

  async function handleReplay(hours: number) {
    setError(null)
    setRunning(true)
    try {
      if (!selectedParamId || !selectedSetpointId || !modelH) {
        throw new Error('Pick a param set, setpoint, and fit a humidity model first.')
      }
      const resp = await fetch('/api/pid/replay', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          params_id: selectedParamId,
          setpoint_id: selectedSetpointId,
          model_humidity_id: modelH.id,
          humidity_device_id: HUMIDITY_DEVICE,
          fan_device_id: FAN_DEVICE,
          hours,
          lights_on: lightsOn,
        }),
      })
      const body = await apiJson(resp)
      if (!resp.ok) throw new Error(body.error as string ?? 'Replay failed')

      // Load the samples back for charting
      const { data } = await supabase
        .from('pid_sim_samples')
        .select('*')
        .eq('run_id', body.run_id)
        .order('t_s', { ascending: true })
      setSamples((data ?? []) as SimSample[])
      setMetrics(body.metrics as Metrics)
      loadLeaderboard()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRunning(false)
    }
  }

  async function handleFitModel(hours: number) {
    setError(null)
    setRunning(true)
    try {
      const resp = await fetch('/api/pid/fit-model', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          humidity_device_id: HUMIDITY_DEVICE,
          fan_device_id: FAN_DEVICE,
          hours,
          lights_on: lightsOn,
        }),
      })
      const body = await apiJson(resp)
      if (!resp.ok) throw new Error(body.error as string ?? 'Fit failed')
      const mh = await latestTentModel(HUMIDITY_DEVICE, 'humidity')
      setModelH(mh)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRunning(false)
    }
  }

  function handleAutotune(method: 'relay' | 'step') {
    if (!modelH || !selectedSetpointId) {
      setError('Need a humidity model and a setpoint to autotune.')
      return
    }
    try {
      const setpoint = setpoints.find((s) => s.id === selectedSetpointId)!
      const targetRh = lightsOn ? Number(setpoint.rh_day_pct) : Number(setpoint.rh_night_pct)
      let gains
      if (method === 'relay') {
        const r = relayAutotune(modelFromRow(modelH), targetRh, {})
        gains = { kp: r.kp, ki: r.ki, kd: r.kd }
      } else {
        const r = zieglerNicholsStep(modelFromRow(modelH), {})
        gains = { kp: r.kp, ki: r.ki, kd: r.kd }
      }
      setKp(round(gains.kp, 3))
      setKi(round(gains.ki, 4))
      setKd(round(gains.kd, 3))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function loadLeaderboard() {
    const { data } = await supabase
      .from('pid_run_leaderboard')
      .select('*')
      .limit(15)
    setLeaderboard((data ?? []) as LeaderboardRow[])
  }

  const chartData = useMemo(() => {
    if (!samples) return []
    return samples.map((s) => ({
      t: s.t_s / 60,    // minutes
      rh: s.rh,
      sp: s.setpoint,
      fan: s.fan_pct,
    }))
  }, [samples])

  const setpointRow = setpoints.find((s) => s.id === selectedSetpointId)
  const targetRhNow = setpointRow
    ? lightsOn ? Number(setpointRow.rh_day_pct) : Number(setpointRow.rh_night_pct)
    : null

  return (
    <div className="pid-tuner">
      <header className="pid-header">
        <h1>PID Tuner</h1>
        <a href="/grow" className="pid-link">← Dashboard</a>
      </header>

      {error && <div className="pid-error">{error}</div>}

      {/* ── Config row ──────────────────────────────────────────────── */}
      <section className="pid-config">
        <div className="pid-field">
          <label>Param set</label>
          <select
            value={selectedParamId ?? ''}
            onChange={(e) => onParamChange(Number(e.target.value))}
          >
            {paramSets.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
            {!paramSets.length && <option>No param sets — insert one in pid_params</option>}
          </select>
        </div>
        <div className="pid-field">
          <label>Setpoint</label>
          <select
            value={selectedSetpointId ?? ''}
            onChange={(e) => setSelectedSetpointId(Number(e.target.value))}
          >
            {setpoints.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} — {s.stage}
              </option>
            ))}
          </select>
        </div>
        <div className="pid-field small">
          <label>Lights</label>
          <label className="pid-toggle">
            <input
              type="checkbox"
              checked={lightsOn}
              onChange={(e) => setLightsOn(e.target.checked)}
            />
            <span>{lightsOn ? 'ON (day)' : 'OFF (night)'}</span>
          </label>
        </div>
        {targetRhNow !== null && (
          <div className="pid-readout">
            Target RH: <b>{targetRhNow}%</b>
          </div>
        )}
      </section>

      {/* ── Gains ───────────────────────────────────────────────────── */}
      <section className="pid-gains">
        <Field label="Kp" value={kp} onChange={setKp} step={0.1} />
        <Field label="Ki" value={ki} onChange={setKi} step={0.005} />
        <Field label="Kd" value={kd} onChange={setKd} step={0.1} />
        <Field label="Duration (min)" value={durationMin} onChange={setDurationMin} step={5} />
        <Field label="Δt (s)" value={dtS} onChange={setDtS} step={5} />
        <Field label="Start RH %" value={initialRh} onChange={setInitialRh} step={1} />
        <Field label="Start Temp °F" value={initialTempF} onChange={setInitialTempF} step={1} />
      </section>

      {/* ── Actions ─────────────────────────────────────────────────── */}
      <section className="pid-actions">
        <button className="btn primary" disabled={running} onClick={handleRun}>
          {running ? 'Running…' : '▶ Run simulation'}
        </button>
        <button className="btn" disabled={running} onClick={() => handleReplay(6)}>
          Replay last 6h
        </button>
        <button className="btn" disabled={running} onClick={() => handleReplay(24)}>
          Replay last 24h
        </button>
        <button className="btn" disabled={running} onClick={() => handleFitModel(48)}>
          Fit model (48h)
        </button>
        <button className="btn subtle" disabled={!modelH} onClick={() => handleAutotune('relay')}>
          Autotune: relay
        </button>
        <button className="btn subtle" disabled={!modelH} onClick={() => handleAutotune('step')}>
          Autotune: Z-N step
        </button>
      </section>

      {/* ── Model info ──────────────────────────────────────────────── */}
      {modelH && (
        <div className="pid-modelinfo">
          Humidity model: τ={Math.round(Number(modelH.tau_s))}s
          &nbsp;gainFan={Number(modelH.gain_fan).toFixed(4)}
          &nbsp;gainLights={Number(modelH.gain_lights).toFixed(4)}
          &nbsp;ambient={Number(modelH.ambient).toFixed(1)}
          &nbsp;rmse={modelH.fit_rmse ? Number(modelH.fit_rmse).toFixed(2) : '—'}
          &nbsp;fit&nbsp;{modelH.fit_window_h ?? '?'}h
        </div>
      )}

      {/* ── Chart ───────────────────────────────────────────────────── */}
      {chartData.length > 0 && (
        <div className="pid-chart">
          <ResponsiveContainer width="99%" height={320}>
            <LineChart data={chartData} margin={{ right: 16 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#2a2a2a" />
              <XAxis dataKey="t" unit="m" stroke="#888" tick={{ fontSize: 11 }} />
              <YAxis yAxisId="l" domain={['auto','auto']} unit="%" stroke="#888" tick={{ fontSize: 11 }} width={44} />
              <YAxis yAxisId="r" orientation="right" domain={[0,100]} unit="%" stroke="#888" tick={{ fontSize: 11 }} width={44} />
              <Tooltip contentStyle={{ background:'#1a1a1a', border:'1px solid #333' }} />
              <Legend />
              {targetRhNow !== null && (
                <ReferenceLine yAxisId="l" y={targetRhNow} stroke="#22c55e" strokeDasharray="4 4" label={{ value: 'SP', fill:'#22c55e' }}/>
              )}
              <Line yAxisId="l" type="monotone" dataKey="rh" name="RH" stroke="#3b82f6" dot={false} strokeWidth={2} />
              <Line yAxisId="l" type="monotone" dataKey="sp" name="Setpoint" stroke="#22c55e" dot={false} strokeDasharray="4 4" />
              <Line yAxisId="r" type="stepAfter" dataKey="fan" name="Fan %" stroke="#facc15" dot={false} strokeWidth={2} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* ── Metrics ─────────────────────────────────────────────────── */}
      {metrics && (
        <section className="pid-metrics">
          <MetricCard label="RMSE" value={metrics.rmse.toFixed(2)} unit="%RH" />
          <MetricCard label="MAE" value={metrics.mae.toFixed(2)} unit="%RH" />
          <MetricCard label="Overshoot" value={metrics.overshootPct !== null ? metrics.overshootPct.toFixed(1) : '—'} unit="%" />
          <MetricCard label="Settling" value={metrics.settlingTimeS !== null ? (metrics.settlingTimeS/60).toFixed(1) : '—'} unit="min" />
          <MetricCard label="Rise" value={metrics.riseTimeS !== null ? (metrics.riseTimeS/60).toFixed(1) : '—'} unit="min" />
          <MetricCard label="SS err" value={metrics.steadyStateError !== null ? metrics.steadyStateError.toFixed(2) : '—'} unit="%RH" />
          <MetricCard label="Effort" value={metrics.controlEffort !== null ? metrics.controlEffort.toFixed(1) : '—'} unit="Δfan/step" />
          {metrics.modelRmse != null && (
            <MetricCard label="Model RMSE" value={metrics.modelRmse.toFixed(2)} unit="%RH" accent="#f97316" />
          )}
        </section>
      )}

      {/* ── Leaderboard ────────────────────────────────────────────── */}
      {leaderboard.length > 0 && (
        <section className="pid-leaderboard">
          <h2>Recent runs</h2>
          <table>
            <thead>
              <tr>
                <th>When</th><th>Source</th><th>Params</th>
                <th>Kp</th><th>Ki</th><th>Kd</th>
                <th>RMSE</th><th>Over%</th><th>Settle</th><th>Model</th>
              </tr>
            </thead>
            <tbody>
              {leaderboard.map((row) => (
                <tr key={row.run_id}>
                  <td>{new Date(row.run_at).toLocaleString([], { dateStyle:'short', timeStyle:'short' })}</td>
                  <td>{row.source}</td>
                  <td>{row.params_name}</td>
                  <td>{Number(row.kp).toFixed(2)}</td>
                  <td>{Number(row.ki).toFixed(3)}</td>
                  <td>{Number(row.kd).toFixed(2)}</td>
                  <td>{row.rmse !== null ? Number(row.rmse).toFixed(2) : '—'}</td>
                  <td>{row.overshoot_pct !== null ? Number(row.overshoot_pct).toFixed(1) : '—'}</td>
                  <td>{row.settling_time_s !== null ? (Number(row.settling_time_s)/60).toFixed(1)+'m' : '—'}</td>
                  <td>{row.model_rmse !== null ? Number(row.model_rmse).toFixed(2) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────────────────────

interface LeaderboardRow {
  run_id: number
  run_at: string
  source: string
  params_name: string
  kp: number; ki: number; kd: number
  rmse: number | null
  overshoot_pct: number | null
  settling_time_s: number | null
  model_rmse: number | null
}

function Field({ label, value, onChange, step = 1 }: {
  label: string
  value: number
  onChange: (n: number) => void
  step?: number
}) {
  return (
    <div className="pid-field small">
      <label>{label}</label>
      <input
        type="number"
        value={value}
        step={step}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  )
}

function MetricCard({ label, value, unit, accent }: {
  label: string
  value: string
  unit?: string
  accent?: string
}) {
  return (
    <div className="metric-card" style={accent ? { borderTopColor: accent, borderTopWidth: 3 } : undefined}>
      <div className="metric-value">{value}{unit && <span className="metric-unit">{unit}</span>}</div>
      <div className="metric-label">{label}</div>
    </div>
  )
}

function round(n: number, d: number) {
  const p = 10 ** d
  return Math.round(n * p) / p
}