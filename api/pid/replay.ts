// POST /api/pid/replay
//
// Runs the PID + tent model against a window of real sensor_readings.
// Produces both the sim-PID's predicted fan commands and the model's
// predicted humidity, so we can score:
//   (a) controller faithfulness — does our port match Hubitat?
//   (b) model accuracy          — does the plant model match reality?

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'
import {
  computeMetrics,
  configFromRow,
  metricsToRow,
  modelFromRow,
  replayFromHistory,
  type ReplayPoint,
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
      humidity_device_id,
      fan_device_id,
      hours = 6,
      lights_on = true,
    } = (req.body ?? {}) as Record<string, unknown>

    for (const [k, v] of Object.entries({
      params_id,
      setpoint_id,
      model_humidity_id,
      humidity_device_id,
      fan_device_id,
    })) {
      if (v === undefined || v === null) {
        return res.status(400).json({ error: `Missing required field: ${k}` })
      }
    }

    const sb = serviceClient()
    const since = new Date(Date.now() - Number(hours) * 3600 * 1000)

    const [params, setpoint, mh, history] = await Promise.all([
      sb.from('pid_params').select('*').eq('id', params_id).single(),
      sb.from('pid_setpoints').select('*').eq('id', setpoint_id).single(),
      sb.from('tent_models').select('*').eq('id', model_humidity_id).single(),
      sb
        .from('sensor_readings')
        .select('device_id, attribute, value, unit, recorded_at')
        .in('device_id', [humidity_device_id, fan_device_id])
        .gte('recorded_at', since.toISOString())
        .order('recorded_at', { ascending: true }),
    ])
    for (const r of [params, setpoint, mh, history]) {
      if (r.error) return res.status(400).json({ error: r.error.message })
    }

    // Pivot EAV rows to (rh, tempF, fanPct) per 30 s bucket
    const bucketMs = 30_000
    type Bucket = { rh?: number; tempF?: number; fanPct?: number }
    const buckets = new Map<number, Bucket>()
    for (const r of history.data ?? []) {
      const t = new Date(r.recorded_at).getTime()
      const b = Math.round(t / bucketMs) * bucketMs
      const entry = buckets.get(b) ?? {}
      const attr = (r.attribute as string).toLowerCase()
      const v = Number(r.value)
      if (attr === 'humidity') entry.rh = v
      else if (attr === 'temperature') {
        const isF = (r.unit ?? '°F').toUpperCase().includes('F')
        entry.tempF = isF ? v : v * 1.8 + 32
      } else if (attr === 'dimmer' || attr === 'level' || attr === 'fan') entry.fanPct = v
      buckets.set(b, entry)
    }

    let lastRh: number | undefined
    let lastTemp: number | undefined
    let lastFan: number | undefined
    const points: ReplayPoint[] = []
    for (const [t, b] of Array.from(buckets.entries()).sort(([a], [c]) => a - c)) {
      if (b.rh !== undefined) lastRh = b.rh
      if (b.tempF !== undefined) lastTemp = b.tempF
      if (b.fanPct !== undefined) lastFan = b.fanPct
      if (lastRh !== undefined && lastTemp !== undefined && lastFan !== undefined) {
        points.push({
          tMs: t,
          rh: lastRh,
          tempF: lastTemp,
          fanPct: lastFan,
          lightsOn: Boolean(lights_on),
          humidifierOn: false,
          heaterOn: false,
        })
      }
    }
    if (points.length < 10) {
      return res.status(400).json({
        error: `Not enough aligned history in the window (got ${points.length} pivot rows). Try a larger hours value or confirm both devices are logging.`,
      })
    }

    const replay = replayFromHistory(
      points,
      configFromRow(params.data!),
      setpoint.data!,
      modelFromRow(mh.data!),
    )

    // Persist as a replay run
    const { data: runRow, error: runErr } = await sb
      .from('pid_sim_runs')
      .insert({
        params_id,
        setpoint_id,
        model_humidity: model_humidity_id,
        lights_on,
        duration_s: (points[points.length - 1].tMs - points[0].tMs) / 1000,
        dt_s: bucketMs / 1000,
        initial_rh: points[0].rh,
        initial_temp_f: points[0].tempF,
        source: 'replay',
        replay_from: new Date(points[0].tMs).toISOString(),
        replay_to: new Date(points[points.length - 1].tMs).toISOString(),
        notes: `replay ${hours}h window`,
      })
      .select()
      .single()
    if (runErr) throw runErr

    const runId = runRow.id as number
    const chunk = 500
    for (let i = 0; i < replay.samples.length; i += chunk) {
      const slice = replay.samples.slice(i, i + chunk).map((s) => ({
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

    const metrics = computeMetrics(replay.samples, {
      modelRmse: replay.modelRmse,
    })
    const { error: mErr } = await sb.from('pid_sim_metrics').insert(metricsToRow(runId, metrics))
    if (mErr) throw mErr

    return res.status(200).json({
      run_id: runId,
      controller_rmse: replay.controllerRmse,
      model_rmse: replay.modelRmse,
      metrics,
    })
  } catch (err) {
    console.error('[pid/replay] error:', err)
    return res
      .status(500)
      .json({ error: err instanceof Error ? err.message : 'Internal error' })
  }
}