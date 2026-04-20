// POST /api/pid/fit-model
//
// Fits a first-order tent humidity model from the last N hours of
// sensor_readings and saves it to `tent_models`. Typically call this weekly
// (or after any structural change to the tent) and then reference the latest
// model id when running simulations.

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'
import { fitTentModel, type FitSample } from '../../src/lib/pid'

function serviceClient() {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL
  if (!url) throw new Error('Missing SUPABASE_URL or VITE_SUPABASE_URL')
  return createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!)
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  try {
    const {
      humidity_device_id,
      fan_device_id,
      hours = 48,
      lights_on = true,
    } = (req.body ?? {}) as Record<string, unknown>

    if (!humidity_device_id || !fan_device_id) {
      return res.status(400).json({
        error: 'Missing humidity_device_id or fan_device_id',
      })
    }

    const sb = serviceClient()
    const since = new Date(Date.now() - Number(hours) * 3600 * 1000)

    const { data, error } = await sb
      .from('sensor_readings')
      .select('device_id, attribute, value, unit, recorded_at')
      .in('device_id', [humidity_device_id, fan_device_id])
      .gte('recorded_at', since.toISOString())
      .order('recorded_at', { ascending: true })
    if (error) throw error

    // Pivot to (rh, fan) per 30 s
    const bucketMs = 30_000
    type Bucket = { rh?: number; fanPct?: number }
    const buckets = new Map<number, Bucket>()
    for (const r of data ?? []) {
      const t = new Date(r.recorded_at).getTime()
      const b = Math.round(t / bucketMs) * bucketMs
      const entry = buckets.get(b) ?? {}
      const attr = (r.attribute as string).toLowerCase()
      const v = Number(r.value)
      if (attr === 'humidity') entry.rh = v
      else if (attr === 'dimmer' || attr === 'level' || attr === 'fan') entry.fanPct = v
      buckets.set(b, entry)
    }

    let lastRh: number | undefined
    let lastFan: number | undefined
    const samples: FitSample[] = []
    for (const [t, b] of Array.from(buckets.entries()).sort(([a], [c]) => a - c)) {
      if (b.rh !== undefined) lastRh = b.rh
      if (b.fanPct !== undefined) lastFan = b.fanPct
      if (lastRh !== undefined && lastFan !== undefined) {
        samples.push({
          tMs: t,
          y: lastRh,
          fanPct: lastFan,
          lightsOn: Boolean(lights_on),
          humidifierOn: false,
          heaterOn: false,
        })
      }
    }

    if (samples.length < 30) {
      return res.status(400).json({
        error: `Not enough aligned samples to fit a model (got ${samples.length}). Try a larger hours value.`,
      })
    }

    const fit = fitTentModel(samples, { fan: true, lights: true })

    const { data: row, error: insErr } = await sb
      .from('tent_models')
      .insert({
        device_id: humidity_device_id,
        metric: 'humidity',
        tau_s: fit.model.tauS,
        ambient: fit.model.ambient,
        gain_fan: fit.model.gainFan,
        gain_lights: fit.model.gainLights,
        gain_humidifier: fit.model.gainHumidifier,
        gain_heater: fit.model.gainHeater,
        fit_rmse: fit.rmse,
        fit_window_h: fit.windowHours,
        fit_samples: fit.samples,
      })
      .select()
      .single()
    if (insErr) throw insErr

    return res.status(200).json({
      model_id: row.id,
      tau_s: fit.model.tauS,
      ambient: fit.model.ambient,
      gain_fan: fit.model.gainFan,
      gain_lights: fit.model.gainLights,
      rmse: fit.rmse,
      samples: fit.samples,
      window_hours: fit.windowHours,
    })
  } catch (err) {
    console.error('[pid/fit-model] error:', err)
    return res
      .status(500)
      .json({ error: err instanceof Error ? err.message : 'Internal error' })
  }
}