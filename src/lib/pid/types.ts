// Shared types for the PID simulator. Shapes match the Supabase tables
// created by supabase/migrations/20260420000000_pid_simulator.sql.

export interface PidParamsRow {
  id: number
  name: string
  controlled: 'humidity' | 'temperature' | 'vpd'
  actuator: string
  kp: number
  ki: number
  kd: number
  fan_base_pct: number
  fan_min_pct: number
  fan_max_pct: number
  integral_max: number
  deadband_pct: number
  dt_cap_min: number
  tent_open_vpd_kpa: number
  sample_period_s: number
  warm_seed_factor: number
  notes: string | null
  created_at: string
}

export interface SetpointRow {
  id: number
  name: string
  stage: 'VEG' | 'FLOWER' | 'SEEDLING'
  temp_day_f: number
  temp_night_f: number
  rh_day_pct: number
  rh_night_pct: number
  temp_tol_f: number
  unit_temp: string
  unit_rh: string
  created_at: string
}

export interface TentModelRow {
  id: number
  device_id: string
  metric: 'humidity' | 'temperature'
  tau_s: number
  ambient: number
  gain_fan: number
  gain_lights: number
  gain_humidifier: number
  gain_heater: number
  fit_rmse: number | null
  fit_window_h: number | null
  fit_samples: number | null
  fitted_at: string
}

export interface SimSample {
  t_s: number
  setpoint: number
  rh: number
  temp_f: number
  vpd_kpa: number
  fan_pct: number
  humidifier: boolean
  heater: boolean
  lights_on: boolean
  error: number
  p_term: number
  i_term: number
  d_term: number
}

export interface SimRunRow {
  id: number
  params_id: number
  setpoint_id: number
  model_humidity: number | null
  model_temp: number | null
  lights_on: boolean
  duration_s: number
  dt_s: number
  initial_rh: number
  initial_temp_f: number
  disturbance: unknown
  source: 'sim' | 'replay'
  replay_from: string | null
  replay_to: string | null
  notes: string | null
  created_at: string
}

export interface SimMetricsRow {
  run_id: number
  rmse: number
  mae: number
  iae: number
  ise: number
  overshoot_pct: number | null
  settling_time_s: number | null
  settling_band_pct: number
  steady_state_error: number | null
  rise_time_s: number | null
  control_effort: number | null
  model_rmse: number | null
  computed_at: string
}