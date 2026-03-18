-- devices lookup table
create table devices (
  device_id   text primary key,
  device_name text not null,
  location    text,
  sensor_type text
);

-- sensor readings table
create table sensor_readings (
  id          bigint generated always as identity primary key,
  device_id   text        not null,
  device_name text        not null,
  attribute   text        not null,
  value       numeric     not null,
  unit        text,
  recorded_at timestamptz not null default now()
);

-- indexes
create index idx_sensor_readings_device_time
  on sensor_readings (device_id, recorded_at desc);

create index idx_sensor_readings_attribute_time
  on sensor_readings (attribute, recorded_at desc);

-- enable RLS
alter table sensor_readings enable row level security;
alter table devices         enable row level security;

-- anon can read sensor_readings
create policy "anon read sensor_readings"
  on sensor_readings
  for select
  to anon
  using (true);

-- service_role can insert sensor_readings
create policy "service_role insert sensor_readings"
  on sensor_readings
  for insert
  to service_role
  with check (true);

-- anon can read devices
create policy "anon read devices"
  on devices
  for select
  to anon
  using (true);

-- service_role can manage devices
create policy "service_role manage devices"
  on devices
  for all
  to service_role
  using (true)
  with check (true);
