import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'

function serviceClient() {
  return createClient(
    process.env.VITE_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'GET') {
    return res.status(200).json({ status: 'ok' })
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const token = req.query['secret']
  if (!token || token !== process.env.HUBITAT_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  try {
    const { deviceId, displayName, name, value, unit } = req.body ?? {}

    if (!deviceId || !name || value === undefined || value === null) {
      return res.status(400).json({ error: 'Missing required fields: deviceId, name, value' })
    }

    const numericValue = parseFloat(String(value))
    if (isNaN(numericValue)) {
      return res.status(400).json({ error: `Non-numeric value: ${value}` })
    }

    const supabase = serviceClient()
    const { error } = await supabase.from('sensor_readings').insert({
      device_id: String(deviceId),
      device_name: displayName ?? String(deviceId),
      attribute: name,
      value: numericValue,
      unit: unit ?? null,
    })

    if (error) throw error

    return res.status(200).json({ ok: true })
  } catch (err) {
    console.error('[hubitat-webhook] error:', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
}
