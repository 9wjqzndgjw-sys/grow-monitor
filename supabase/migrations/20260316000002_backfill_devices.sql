-- Backfill devices table from existing sensor readings
insert into devices (device_id, device_name)
select distinct device_id, device_name
from sensor_readings
on conflict (device_id) do update
set device_name = excluded.device_name;
