// POST /api/pid/simulate
//
// Runs a closed-loop PID simulation against the fitted tent model and
// persists the run, its samples, and accuracy metrics so the leaderboard
// records it. The PidTuner page also computes the trajectory client-side
// for instant charting; this endpoint is the source of truth for storage.

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'
import {
  computeMetrics,
  configFromRow,
  metricsToRow,
  modelFromRow,
  runSimulation,
} from '../../src/lib/pid'

function serviceClient() {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL
  if (!url) throw new Error('Missing SUPABASE_URL or VITE_SUPABASE_URL')
  return createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!)
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  try {
    const {
      params_id,
      setpoint_id,
      model_humidity_id,
      model_temp_id,
      duration_s = 3600,
      dt_s = 15,
      initial_rh,
      initial_temp_f,
      lights_on = true,
      notes = null,
    } = (req.body ?? {}) as Record<string, unknown>

    for (const [k, v] of Object.entries({
      params_id,
      setpoint_id,
      model_humidity_id,
      model_temp_id,
      initial_rh,
      initial_temp_f,
    })) {
      if (v === undefined || v === null) {
        return res.status(400).json({ error: `Missing required field: ${k}` })
      }
    }

    const sb = serviceClient()

    const [params, setpoint, mh, mt] = await Promise.all([
      sb.from('pid_params').select('*').eq('id', params_id).single(),
      sb.from('pid_setpoints').select('*').eq('id', setpoint_id).single(),
      sb.from('tent_models').select('*').eq('id', model_humidity_id).single(),
      sb.from('tent_models').select('*').eq('id', model_temp_id).single(),
    ])
    for (const r of [params, setpoint, mh, mt]) {
      if (r.error) return res.status(400).json({ error: r.error.message })
    }

    const durationS = Number(duration_s)
    const dtS = Number(dt_s)
    const initialRh = Number(initial_rh)
    const initialTempF = Number(initial_temp_f)

    const result = runSimulation({
      pid: configFromRow(params.data!),
      setpoint: setpoint.data!,
      modelHumidity: modelFromRow(mh.data!),
      modelTemp: modelFromRow(mt.data!),
      durationS,
      dtS,
      initialRh,
      initialTempF,
      lightsOn: Boolean(lights_on),
    })

    const metrics = computeMetrics(result.samples, { initialValue: initialRh })

    const { data: runRow, error: runErr } = await sb
      .from('pid_sim_runs')
      .insert({
        params_id,
        setpoint_id,
        model_humidity: model_humidity_id,
        model_temp: model_temp_id,
        lights_on,
        duration_s: durationS,
        dt_s: dtS,
        initial_rh: initialRh,
        initial_temp_f: initialTempF,
        source: 'sim',
        notes,
      })
      .select()
      .single()
    if (runErr) throw runErr

    const runId = runRow.id as number
    const chunk = 500
    for (let i = 0; i < result.samples.length; i += chunk) {
      const slice = result.samples.slice(i, i + chunk).map((s) => ({
        run_id: runId,
        t_s: s.t_s,
        setpoint: s.setpoint,
        rh: s.rh,
        temp_f: s.temp_f,
        vpd_kpa: s.vpd_kpa,
        fan_pct: s.fan_pct,
        humidifier: s.humidifier,
        heater: s.heater,
        lights_on: s.lights_on,
        error: s.error,
        p_term: s.p_term,
        i_term: s.i_term,
        d_term: s.d_term,
      }))
      const { error } = await sb.from('pid_sim_samples').insert(slice)
      if (error) throw error
    }

    const { error: mErr } = await sb
      .from('pid_sim_metrics')
      .insert(metricsToRow(runId, metrics))
    if (mErr) throw mErr

    return res.status(200).json({ run_id: runId, metrics })
  } catch (err) {
    console.error('[pid/simulate] error:', err)
    return res
      .status(500)
      .json({ error: err instanceof Error ? err.message : 'Internal error' })
  }
}
