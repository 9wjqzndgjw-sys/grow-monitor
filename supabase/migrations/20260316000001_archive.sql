-- sensor_readings_archive: hourly-bucketed data for rows older than 30d
create table sensor_readings_archive (
  id           bigint generated always as identity primary key,
  device_id    text        not null,
  device_name  text        not null,
  attribute    text        not null,
  value        numeric     not null,  -- hourly average
  unit         text,
  hour_bucket  timestamptz not null,
  sample_count integer     not null default 1,

  unique (device_id, attribute, hour_bucket)
);

create index idx_archive_device_time
  on sensor_readings_archive (device_id, hour_bucket desc);

create index idx_archive_attribute_time
  on sensor_readings_archive (attribute, hour_bucket desc);

alter table sensor_readings_archive enable row level security;

create policy "anon read archive"
  on sensor_readings_archive
  for select
  to anon
  using (true);

create policy "service_role manage archive"
  on sensor_readings_archive
  for all
  to service_role
  using (true)
  with check (true);

-- Aggregation function called by the daily cron
create or replace function downsample_old_readings()
returns jsonb
language plpgsql
security definer
as $$
declare
  inserted_count integer;
  deleted_count  integer;
begin
  -- Upsert hourly averages into archive
  insert into sensor_readings_archive
    (device_id, device_name, attribute, value, unit, hour_bucket, sample_count)
  select
    device_id,
    device_name,
    attribute,
    round(avg(value)::numeric, 4),
    unit,
    date_trunc('hour', recorded_at),
    count(*)::integer
  from sensor_readings
  where recorded_at < now() - interval '30 days'
  group by device_id, device_name, attribute, unit, date_trunc('hour', recorded_at)
  on conflict (device_id, attribute, hour_bucket) do update set
    value        = excluded.value,
    sample_count = excluded.sample_count;

  get diagnostics inserted_count = row_count;

  -- Delete granular rows now archived
  delete from sensor_readings
  where recorded_at < now() - interval '30 days';

  get diagnostics deleted_count = row_count;

  return jsonb_build_object('inserted', inserted_count, 'deleted', deleted_count);
end;
$$;
