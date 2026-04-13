import { useEffect, useMemo, useState } from 'react'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceArea, Legend,
} from 'recharts'
import { supabase } from '../lib/supabase'
import { celsiusFromFahrenheit, computeVpd, VPD_ZONE_COLORS, VPD_ZONE_LABELS, vpdZone } from '../lib/vpd'
import './GrowDashboard.css'

// ── types ────────────────────────────────────────────────────────────────────

interface Device { device_id: string; device_name: string }

interface Reading {
  attribute: string
  value: number
  unit: string | null
  recorded_at: string
}

interface ChartPoint {
  ts: number
  temperature: number | null
  humidity: number | null
  vpd: number | null
}

// ── constants ────────────────────────────────────────────────────────────────

const TIME_RANGES = [
  { label: '6h',  hours: 6,   bucketMs: 2 * 60 * 1000 },
  { label: '12h', hours: 12,  bucketMs: 2 * 60 * 1000 },
  { label: '24h', hours: 24,  bucketMs: 5 * 60 * 1000 },
  { label: '7d',  hours: 168, bucketMs: 5 * 60 * 1000 },
  { label: '30d', hours: 720, bucketMs: 5 * 60 * 1000 },
]

// ── helpers ──────────────────────────────────────────────────────────────────

function formatTime(ts: unknown): string {
  return new Date(ts as number).toLocaleTimeString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function formatShortTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function mergeIntoChartPoints(readings: Reading[], bucketMs: number): ChartPoint[] {
  const buckets = new Map<number, { temp?: { value: number; unit: string }; humidity?: number }>()

  for (const r of readings) {
    const ts = new Date(r.recorded_at).getTime()
    const bucket = Math.round(ts / bucketMs) * bucketMs
    if (!buckets.has(bucket)) buckets.set(bucket, {})
    const b = buckets.get(bucket)!

    if (r.attribute === 'temperature') {
      b.temp = { value: Number(r.value), unit: r.unit ?? '°F' }
    } else if (r.attribute === 'humidity') {
      b.humidity = Number(r.value)
    }
  }

  const sorted = Array.from(buckets.entries()).sort(([a], [b]) => a - b)

  // Forward-fill last known temp/humidity so VPD is computed even when
  // temperature and humidity readings land in different 5-minute buckets.
  let lastTemp: { value: number; unit: string } | undefined
  let lastHumidity: number | undefined

  return sorted.map(([ts, b]) => {
    if (b.temp !== undefined) lastTemp = b.temp
    if (b.humidity !== undefined) lastHumidity = b.humidity

    const effectiveTemp = b.temp ?? lastTemp
    const effectiveHumidity = b.humidity ?? lastHumidity

    let vpd: number | null = null
    if (effectiveTemp !== undefined && effectiveHumidity !== undefined) {
      const tempC = effectiveTemp.unit.includes('F')
        ? celsiusFromFahrenheit(effectiveTemp.value)
        : effectiveTemp.value
      vpd = computeVpd(tempC, effectiveHumidity)
    }

    return {
      ts,
      temperature: effectiveTemp?.value ?? null,
      humidity: effectiveHumidity ?? null,
      vpd,
    }
  })
}

// ── data fetching ────────────────────────────────────────────────────────────

async function fetchDevices(): Promise<Device[]> {
  const { data } = await supabase
    .from('devices')
    .select('device_id, device_name')
    .order('device_name')
  return data ?? []
}

async function fetchReadings(deviceId: string, hours: number): Promise<Reading[]> {
  const since = new Date(Date.now() - hours * 3600 * 1000).toISOString()
  const { data } = await supabase
    .from('sensor_readings')
    .select('attribute, value, unit, recorded_at')
    .eq('device_id', deviceId)
    .gte('recorded_at', since)
    .in('attribute', ['temperature', 'humidity'])
    .order('recorded_at', { ascending: true })
  return data ?? []
}

async function fetchLatest(deviceId: string): Promise<Reading[]> {
  const { data } = await supabase
    .from('sensor_readings')
    .select('attribute, value, unit, recorded_at')
    .eq('device_id', deviceId)
    .order('recorded_at', { ascending: false })
    .limit(100)
  if (!data) return []
  const seen = new Set<string>()
  return data.filter(r => {
    if (seen.has(r.attribute)) return false
    seen.add(r.attribute)
    return true
  })
}

async function fetchDimmerReadings(hours: number): Promise<Reading[]> {
  const since = new Date(Date.now() - hours * 3600 * 1000).toISOString()
  const { data } = await supabase
    .from('sensor_readings')
    .select('attribute, value, unit, recorded_at')
    .eq('device_id', 'Dimmer')
    .eq('attribute', 'dimmer')
    .gte('recorded_at', since)
    .order('recorded_at', { ascending: true })
  return data ?? []
}

async function fetchLatestDimmer(): Promise<Reading | null> {
  const { data } = await supabase
    .from('sensor_readings')
    .select('attribute, value, unit, recorded_at')
    .eq('device_id', 'Dimmer')
    .eq('attribute', 'dimmer')
    .order('recorded_at', { ascending: false })
    .limit(1)
  return data?.[0] ?? null
}

// ── components ───────────────────────────────────────────────────────────────

function StatCard({ value, unit, sub, isAvg, accentColor }: {
  value: string | null
  unit: string
  sub?: string
  isAvg?: boolean
  accentColor?: string
}) {
  return (
    <div
      className={`stat-card${isAvg ? ' stat-avg' : ' stat-current'}`}
      style={accentColor ? { borderTopColor: accentColor, borderTopWidth: 3 } : undefined}
    >
      <div className="stat-value">
        {value ?? '—'}
        {value !== null && <span className="stat-unit">{unit}</span>}
      </div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  )
}

function VpdReferenceCard() {
  const zones: Array<{ zone: keyof typeof VPD_ZONE_COLORS; range: string; desc: string }> = [
    { zone: 'danger-low',   range: '< 0.4 kPa',     desc: 'Overwatering risk, slow growth' },
    { zone: 'warning-low',  range: '0.4 – 0.8 kPa', desc: 'Low transpiration' },
    { zone: 'ideal-veg',    range: '0.8 – 1.2 kPa', desc: 'Ideal for veg stage' },
    { zone: 'ideal-flower', range: '1.2 – 1.6 kPa', desc: 'Ideal for flower stage' },
    { zone: 'warning-high', range: '1.6 – 2.0 kPa', desc: 'Plant stress beginning' },
    { zone: 'danger-high',  range: '> 2.0 kPa',     desc: 'Severe stress / wilting risk' },
  ]
  return (
    <div className="vpd-reference-card">
      <h3>VPD Reference</h3>
      <p className="vpd-subtitle">Vapor Pressure Deficit — the "pull" the air exerts on the plant</p>
      <table className="vpd-table">
        <tbody>
          {zones.map(z => (
            <tr key={z.zone}>
              <td className="vpd-swatch-cell">
                <span className="vpd-swatch" style={{ background: VPD_ZONE_COLORS[z.zone] }} />
              </td>
              <td className="vpd-range">{z.range}</td>
              <td className="vpd-note">
                {VPD_ZONE_LABELS[z.zone]}
                <div className="vpd-desc">{z.desc}</div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── main page ────────────────────────────────────────────────────────────────

export default function GrowDashboard() {
  const [devices, setDevices] = useState<Device[]>([])
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('')
  const [selectedHours, setSelectedHours] = useState(6)
  const [readings, setReadings] = useState<Reading[]>([])
  const [latest, setLatest] = useState<Reading[]>([])
  const [dimmerReadings, setDimmerReadings] = useState<Reading[]>([])
  const [latestDimmer, setLatestDimmer] = useState<Reading | null>(null)
  const [loading, setLoading] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const [now, setNow] = useState(() => Date.now())

  // Keep 'now' fresh every minute for age calculations
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60000)
    return () => clearInterval(timer)
  }, [])

  // Load device list on mount
  useEffect(() => {
    fetchDevices().then(devs => {
      setDevices(devs)
      if (devs.length > 0) {
        const preferred = devs.find(d => d.device_name === 'YoLink Canopy')
        setSelectedDeviceId((preferred ?? devs[0]).device_id)
      }
    })
  }, [])

  // Load time-series and latest readings when device/range changes
  useEffect(() => {
    if (!selectedDeviceId) return

    let isMounted = true
    setLoading(true)
    const loadData = async () => {
      try {
        const [ts, lat, dimTs, dimLat] = await Promise.all([
          fetchReadings(selectedDeviceId, selectedHours),
          fetchLatest(selectedDeviceId),
          fetchDimmerReadings(selectedHours),
          fetchLatestDimmer(),
        ])
        if (isMounted) {
          setReadings(ts)
          setLatest(lat)
          setDimmerReadings(dimTs)
          setLatestDimmer(dimLat)
        }
      } finally {
        if (isMounted) setLoading(false)
      }
    }

    loadData()
    return () => { isMounted = false }
  }, [selectedDeviceId, selectedHours, refreshKey])

  const bucketMs = TIME_RANGES.find(r => r.hours === selectedHours)?.bucketMs ?? 5 * 60 * 1000
  const chartData = useMemo(() => mergeIntoChartPoints(readings, bucketMs), [readings, bucketMs])

  const dimmerChartData = useMemo(() => {
    const buckets = new Map<number, number>()
    for (const r of dimmerReadings) {
      const ts = new Date(r.recorded_at).getTime()
      const bucket = Math.round(ts / bucketMs) * bucketMs
      buckets.set(bucket, Number(r.value))
    }
    return Array.from(buckets.entries())
      .sort(([a], [b]) => a - b)
      .map(([ts, level]) => ({ ts, level }))
  }, [dimmerReadings, bucketMs])

  const tempUnit = latest.find(r => r.attribute === 'temperature')?.unit ?? '°F'

  const currentVpd = useMemo(() => {
    const t = latest.find(r => r.attribute === 'temperature')
    const h = latest.find(r => r.attribute === 'humidity')
    if (!t || !h) return null
    const tempC = (t.unit ?? '°F').includes('F')
      ? celsiusFromFahrenheit(t.value)
      : t.value
    return computeVpd(tempC, h.value)
  }, [latest])

  const avgStats = useMemo(() => {
    const avg = (vals: (number | null)[]) => {
      const nums = vals.filter((v): v is number => v !== null)
      return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null
    }
    return {
      temp: avg(chartData.map(p => p.temperature)),
      humidity: avg(chartData.map(p => p.humidity)),
      vpd: avg(chartData.map(p => p.vpd)),
      dimmer: avg(dimmerChartData.map(p => p.level)),
    }
  }, [chartData, dimmerChartData])

  const latestTemp = latest.find(r => r.attribute === 'temperature') ?? null
  const latestHumidity = latest.find(r => r.attribute === 'humidity') ?? null

  function formatAge(mins: number): string {
    if (mins < 1) return 'just now'
    if (mins < 60) return `${mins}m ago`
    const h = Math.floor(mins / 60)
    const m = mins % 60
    return m > 0 ? `${h}h ${m}m ago` : `${h}h ago`
  }

  function ageSubFor(r: typeof latestTemp) {
    if (!r) return '—'
    const mins = Math.round((now - new Date(r.recorded_at).getTime()) / 60000)
    return formatAge(mins)
  }

  const tempAgeSub = ageSubFor(latestTemp)
  const humidityAgeSub = ageSubFor(latestHumidity)
  const rangeLabel = TIME_RANGES.find(r => r.hours === selectedHours)?.label ?? ''

  function exportCsv() {
    const rows = [...readings, ...dimmerReadings]
      .slice()
      .sort((a, b) => new Date(a.recorded_at).getTime() - new Date(b.recorded_at).getTime())
    const header = 'timestamp,attribute,value,unit'
    const lines = rows.map(r =>
      `${r.recorded_at},${r.attribute},${r.value},${r.unit ?? ''}`
    )
    const csv = [header, ...lines].join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `grow-readings-${rangeLabel}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="grow-dashboard">
      <header className="grow-header">
        <h1>Grow Monitor</h1>
        {currentVpd !== null && (
          <div className="grow-vpd-badge" style={{ background: VPD_ZONE_COLORS[vpdZone(currentVpd)] }}>
            VPD {currentVpd} kPa
          </div>
        )}
      </header>

      {/* Controls */}
      <div className="grow-controls">
        <select
          value={selectedDeviceId}
          onChange={e => setSelectedDeviceId(e.target.value)}
          className="grow-select"
        >
          {devices.length === 0 && <option value="">No devices yet</option>}
          {devices.map(d => (
            <option key={d.device_id} value={d.device_id}>{d.device_name}</option>
          ))}
        </select>

        <div className="time-range-picker">
          {TIME_RANGES.map(r => (
            <button
              key={r.label}
              className={`range-btn${selectedHours === r.hours ? ' active' : ''}`}
              onClick={() => setSelectedHours(r.hours)}
            >
              {r.label}
            </button>
          ))}
        </div>

        <button
          className="refresh-btn"
          onClick={() => setRefreshKey(k => k + 1)}
          disabled={loading}
          title="Refresh data"
        >
          ↻
        </button>

        <button
          className="export-btn"
          onClick={exportCsv}
          disabled={loading || readings.length === 0}
          title="Export CSV"
        >
          Export
        </button>
      </div>

      {/* Stats rows */}
      {!loading && (latest.length > 0 || chartData.length > 0) && (
        <>
          <div className="stats-row-label">Average over {rangeLabel}</div>
          <div className="stats-grid">
            <StatCard
              isAvg
              value={avgStats.temp !== null ? avgStats.temp.toFixed(1) : null}
              unit={` ${tempUnit}`}
            />
            <StatCard
              isAvg
              value={avgStats.humidity !== null ? avgStats.humidity.toFixed(1) : null}
              unit="%"
            />
            <StatCard
              isAvg
              value={avgStats.vpd !== null ? avgStats.vpd.toFixed(2) : null}
              unit=" kPa"
              accentColor={avgStats.vpd !== null ? VPD_ZONE_COLORS[vpdZone(avgStats.vpd)] : undefined}
            />
            <StatCard
              isAvg
              value={avgStats.dimmer !== null ? avgStats.dimmer.toFixed(0) : null}
              unit="%"
            />
          </div>

          <div className="stats-row-label">Current</div>
          <div className="stats-grid">
            <StatCard
              value={latestTemp !== null ? String(latestTemp.value) : null}
              unit={` ${tempUnit}`}
              sub={tempAgeSub}
            />
            <StatCard
              value={latestHumidity !== null ? String(latestHumidity.value) : null}
              unit="%"
              sub={humidityAgeSub}
            />
            <StatCard
              value={currentVpd !== null ? currentVpd.toFixed(2) : null}
              unit=" kPa"
              sub={tempAgeSub}
              accentColor={currentVpd !== null ? VPD_ZONE_COLORS[vpdZone(currentVpd)] : undefined}
            />
            <StatCard
              value={latestDimmer !== null ? String(latestDimmer.value) : null}
              unit="%"
              sub={latestDimmer ? ageSubFor(latestDimmer) : '—'}
            />
          </div>
        </>
      )}

      {loading && <div className="grow-loading">Loading…</div>}

      {!loading && chartData.length > 0 && (
        <>
          {/* Temperature chart */}
          <div className="chart-section">
            <h2 className="chart-title">Temperature</h2>
            <ResponsiveContainer width="99%" height={220}>
              <LineChart data={chartData} margin={{ right: 16 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#2a2a2a" />
                <XAxis dataKey="ts" tickFormatter={formatShortTime} stroke="#888" tick={{ fontSize: 11 }} />
                <YAxis domain={['auto', 'auto']} unit={` ${tempUnit}`} stroke="#888" tick={{ fontSize: 11 }} width={56} />
                <Tooltip labelFormatter={formatTime} formatter={(v: unknown) => [`${v} ${tempUnit}`, 'Temp']} contentStyle={{ background: '#1a1a1a', border: '1px solid #333' }} />
                <Line type="monotone" dataKey="temperature" stroke="#f97316" dot={false} connectNulls strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* Humidity chart */}
          <div className="chart-section">
            <h2 className="chart-title">Humidity</h2>
            <ResponsiveContainer width="99%" height={220}>
              <LineChart data={chartData} margin={{ right: 16 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#2a2a2a" />
                <XAxis dataKey="ts" tickFormatter={formatShortTime} stroke="#888" tick={{ fontSize: 11 }} />
                <YAxis domain={[45, 100]} ticks={[45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 100]} unit="%" stroke="#888" tick={{ fontSize: 11 }} width={44} />
                <Tooltip labelFormatter={formatTime} formatter={(v: unknown) => [`${v}%`, 'RH']} contentStyle={{ background: '#1a1a1a', border: '1px solid #333' }} />
                <Line type="monotone" dataKey="humidity" stroke="#3b82f6" dot={false} connectNulls strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* Dimmer chart */}
          {dimmerChartData.length > 0 && (
            <div className="chart-section">
              <h2 className="chart-title">Dimmer Level</h2>
              <ResponsiveContainer width="99%" height={220}>
                <LineChart data={dimmerChartData} margin={{ right: 16 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#2a2a2a" />
                  <XAxis dataKey="ts" tickFormatter={formatShortTime} stroke="#888" tick={{ fontSize: 11 }} />
                  <YAxis domain={[0, 100]} unit="%" stroke="#888" tick={{ fontSize: 11 }} width={44} />
                  <Tooltip labelFormatter={formatTime} formatter={(v: unknown) => [`${v}%`, 'Dimmer']} contentStyle={{ background: '#1a1a1a', border: '1px solid #333' }} />
                  <Line type="stepAfter" dataKey="level" stroke="#facc15" dot={false} strokeWidth={2} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* VPD chart */}
          <div className="chart-section">
            <h2 className="chart-title">VPD (kPa)</h2>
            <ResponsiveContainer width="99%" height={260}>
              <LineChart data={chartData} margin={{ right: 16 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#2a2a2a" />
                <XAxis dataKey="ts" tickFormatter={formatShortTime} stroke="#888" tick={{ fontSize: 11 }} />
                <YAxis domain={[0, 2.5]} unit=" kPa" stroke="#888" tick={{ fontSize: 11 }} width={60} />
                <Tooltip labelFormatter={formatTime} formatter={(v: unknown) => [`${v} kPa`, 'VPD']} contentStyle={{ background: '#1a1a1a', border: '1px solid #333' }} />
                <Legend verticalAlign="top" height={28} />

                {/* Zone bands — rendered behind the line */}
                <ReferenceArea y1={0}   y2={0.4} fill="#ef4444" fillOpacity={0.12} />
                <ReferenceArea y1={0.4} y2={0.8} fill="#f59e0b" fillOpacity={0.12} />
                <ReferenceArea y1={0.8} y2={1.2} fill="#22c55e" fillOpacity={0.15} label={{ value: 'Ideal Veg', position: 'insideTopRight', fontSize: 10, fill: '#22c55e' }} />
                <ReferenceArea y1={1.2} y2={1.6} fill="#84cc16" fillOpacity={0.15} label={{ value: 'Ideal Flower', position: 'insideTopRight', fontSize: 10, fill: '#84cc16' }} />
                <ReferenceArea y1={1.6} y2={2.0} fill="#f59e0b" fillOpacity={0.12} />
                <ReferenceArea y1={2.0} y2={2.5} fill="#ef4444" fillOpacity={0.12} />

                <Line type="monotone" dataKey="vpd" name="VPD" stroke="#8b5cf6" dot={false} connectNulls strokeWidth={2.5} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </>
      )}

      {!loading && chartData.length === 0 && selectedDeviceId && (
        <div className="grow-empty">No readings found for this device in the selected time range.</div>
      )}

      <VpdReferenceCard />
    </div>
  )
}
