// Supabase helpers specific to the PID simulator tables.
//
// Uses the project's existing `supabase` singleton (anon-key client, good for
// reads). Writes go through the serverless endpoints in api/pid/* which use
// the service role key.

import { supabase } from '../supabase'
import { fitTentModel, type FitSample } from './model'
import type {
  PidParamsRow,
  SetpointRow,
  TentModelRow,
  SimRunRow,
  SimMetricsRow,
} from './types'

// ── Reads ────────────────────────────────────────────────────────────────────

export async function listPidParams(): Promise<PidParamsRow[]> {
  const { data, error } = await supabase
    .from('pid_params')
    .select('*')
    .order('created_at', { ascending: false })
  if (error) throw error
  return (data ?? []) as PidParamsRow[]
}

export async function listSetpoints(): Promise<SetpointRow[]> {
  const { data, error } = await supabase
    .from('pid_setpoints')
    .select('*')
    .order('name')
  if (error) throw error
  return (data ?? []) as SetpointRow[]
}

export async function listDeviceIds(attributes: string[], sinceDays = 30): Promise<string[]> {
  const since = new Date(Date.now() - sinceDays * 86400_000)
  const { data, error } = await supabase
    .from('sensor_readings')
    .select('device_id')
    .in('attribute', attributes)
    .gte('recorded_at', since.toISOString())
  if (error) throw error
  const seen = new Set<string>()
  for (const r of (data ?? []) as Array<{ device_id: string }>) seen.add(r.device_id)
  return Array.from(seen).sort()
}

export async function latestTentModel(
  deviceId: string,
  metric: 'humidity' | 'temperature',
): Promise<TentModelRow | null> {
  const { data, error } = await supabase
    .from('tent_models')
    .select('*')
    .eq('device_id', deviceId)
    .eq('metric', metric)
    .order('fitted_at', { ascending: false })
    .limit(1)
  if (error) throw error
  return (data?.[0] ?? null) as TentModelRow | null
}

export async function listSimRuns(limit = 20): Promise<Array<SimRunRow & { metrics: SimMetricsRow | null; params_name: string; setpoint_name: string }>> {
  const { data, error } = await supabase
    .from('pid_run_leaderboard')
    .select('*')
    .limit(limit)
  if (error) throw error
  // The view returns flat rows; callers reshape as needed.
  return (data ?? []) as unknown as Array<SimRunRow & { metrics: SimMetricsRow | null; params_name: string; setpoint_name: string }>
}

// ── History fetch for model fitting + replay ────────────────────────────────
//
// The grow-monitor schema is EAV. Pivot rows into (rh, temp, fan, lights)
// series aligned on timestamp. Dimmer is the actuator (attribute='dimmer').
// Lights on/off can be inferred from the lights virtual switch if logged,
// otherwise passed in by the caller.

export interface HistoryPivot {
  tMs: number
  rh: number | null
  tempF: number | null
  fanPct: number | null
  lightsOn: boolean
}

export async function fetchHistory(
  deviceId: string,
  fanDeviceId: string,
  since: Date,
  until: Date = new Date(),
  defaultLightsOn: boolean = true,
): Promise<HistoryPivot[]> {
  // Pull both devices' data in a single query filtered by device_id IN
  const { data, error } = await supabase
    .from('sensor_readings')
    .select('device_id, attribute, value, unit, recorded_at')
    .in('device_id', [deviceId, fanDeviceId])
    .gte('recorded_at', since.toISOString())
    .lte('recorded_at', until.toISOString())
    .order('recorded_at', { ascending: true })
  if (error) throw error

  // Pivot by nearest-bucket (30 s)
  const bucketMs = 30_000
  type Bucket = { rh?: number; tempF?: number; fanPct?: number }
  const map = new Map<number, Bucket>()

  for (const r of data ?? []) {
    const t = new Date(r.recorded_at).getTime()
    const b = Math.round(t / bucketMs) * bucketMs
    const entry = map.get(b) ?? {}
    const attr = (r.attribute as string).toLowerCase()
    const val = Number(r.value)
    if (attr === 'humidity') entry.rh = val
    else if (attr === 'temperature') {
      // Dashboard stores °F or °C based on unit. Normalize to °F.
      const isF = (r.unit ?? '°F').toUpperCase().includes('F')
      entry.tempF = isF ? val : val * 1.8 + 32
    } else if (attr === 'dimmer' || attr === 'level' || attr === 'fan') {
      entry.fanPct = val
    }
    map.set(b, entry)
  }

  // Forward-fill each channel and emit aligned pivots
  const sorted = Array.from(map.entries()).sort(([a], [b]) => a - b)
  let lastRh: number | undefined
  let lastTemp: number | undefined
  let lastFan: number | undefined

  const out: HistoryPivot[] = []
  for (const [t, b] of sorted) {
    if (b.rh !== undefined) lastRh = b.rh
    if (b.tempF !== undefined) lastTemp = b.tempF
    if (b.fanPct !== undefined) lastFan = b.fanPct
    out.push({
      tMs: t,
      rh: lastRh ?? null,
      tempF: lastTemp ?? null,
      fanPct: lastFan ?? null,
      lightsOn: defaultLightsOn,
    })
  }
  return out
}

/**
 * Convenience wrapper: fetch history → fit a humidity model.
 * Returns the fit result; caller persists via the API endpoint.
 */
export async function fitModelFromHistory(params: {
  deviceId: string
  fanDeviceId: string
  hours: number
  lightsOn?: boolean
}): Promise<ReturnType<typeof fitTentModel>> {
  const since = new Date(Date.now() - params.hours * 3600 * 1000)
  const pivots = await fetchHistory(
    params.deviceId,
    params.fanDeviceId,
    since,
    new Date(),
    params.lightsOn ?? true,
  )

  const samples: FitSample[] = pivots
    .filter(
      (p) =>
        p.rh !== null && p.tempF !== null && p.fanPct !== null,
    )
    .map((p) => ({
      tMs: p.tMs,
      y: p.rh!,
      fanPct: p.fanPct!,
      lightsOn: p.lightsOn,
      humidifierOn: false,   // not in EAV history; pass separately if you log it
      heaterOn: false,
    }))

  return fitTentModel(samples, { fan: true, lights: true })
}