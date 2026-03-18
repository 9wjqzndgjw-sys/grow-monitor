/** Saturated vapour pressure (kPa) using the Magnus formula */
function svp(tempC: number): number {
  return 0.6108 * Math.exp((17.27 * tempC) / (tempC + 237.3))
}

export function celsiusFromFahrenheit(f: number): number {
  return (f - 32) * (5 / 9)
}

/** VPD in kPa. tempC = leaf temperature (°C), rh = relative humidity (%) */
export function computeVpd(tempC: number, rh: number): number {
  return parseFloat((svp(tempC) * (1 - rh / 100)).toFixed(3))
}

export type VpdZone =
  | 'danger-low'
  | 'warning-low'
  | 'ideal-veg'
  | 'ideal-flower'
  | 'warning-high'
  | 'danger-high'

export function vpdZone(vpd: number): VpdZone {
  if (vpd < 0.4) return 'danger-low'
  if (vpd < 0.8) return 'warning-low'
  if (vpd < 1.2) return 'ideal-veg'
  if (vpd < 1.6) return 'ideal-flower'
  if (vpd < 2.0) return 'warning-high'
  return 'danger-high'
}

export const VPD_ZONE_COLORS: Record<VpdZone, string> = {
  'danger-low':    '#ef4444',
  'warning-low':   '#f59e0b',
  'ideal-veg':     '#22c55e',
  'ideal-flower':  '#84cc16',
  'warning-high':  '#f59e0b',
  'danger-high':   '#ef4444',
}

export const VPD_ZONE_LABELS: Record<VpdZone, string> = {
  'danger-low':    'Danger (< 0.4)',
  'warning-low':   'Low (0.4 – 0.8)',
  'ideal-veg':     'Ideal Veg (0.8 – 1.2)',
  'ideal-flower':  'Ideal Flower (1.2 – 1.6)',
  'warning-high':  'High (1.6 – 2.0)',
  'danger-high':   'Danger (> 2.0)',
}
