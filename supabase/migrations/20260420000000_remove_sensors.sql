-- Remove decommissioned sensors and all their readings
do $$
declare
  names text[] := array[
    'Yolink Upper',
    'MainHygro',
    'Sonoff Hygrometer 1',
    'Sonoff Hygrometer 2'
  ];
begin
  delete from sensor_readings_archive where device_name = any(names);
  delete from sensor_readings         where device_name = any(names);
  delete from devices                 where device_name = any(names);
end $$;
