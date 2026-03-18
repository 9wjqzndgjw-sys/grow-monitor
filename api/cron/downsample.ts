import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  const supabase = createClient(
    process.env.VITE_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  console.log('[downsample] starting daily downsample job')

  try {
    // Row count before deletion
    const { count: beforeCount } = await supabase
      .from('sensor_readings')
      .select('*', { count: 'exact', head: true })
      .lt('recorded_at', new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString())

    console.log(`[downsample] rows older than 30d before job: ${beforeCount}`)

    const { data, error } = await supabase.rpc('downsample_old_readings')

    if (error) throw error

    console.log(`[downsample] completed: inserted=${data.inserted} deleted=${data.deleted}`)

    return res.status(200).json({ ok: true, ...data, before: beforeCount })
  } catch (err) {
    console.error('[downsample] error:', err)
    return res.status(500).json({ error: 'Downsample job failed' })
  }
}
