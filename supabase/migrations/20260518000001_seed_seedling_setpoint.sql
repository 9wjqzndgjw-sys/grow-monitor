-- Seed a default SEEDLING setpoint.
-- Seedlings want high RH (65-70 %) and gentle temps to avoid transplant shock.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pid_setpoints WHERE stage = 'SEEDLING') THEN
    INSERT INTO pid_setpoints
      (name, stage, temp_day_f, temp_night_f, rh_day_pct, rh_night_pct, temp_tol_f, unit_temp, unit_rh)
    VALUES
      ('Seedling default', 'SEEDLING', 77, 72, 70, 65, 2, '°F', '%');
  END IF;
END $$;
