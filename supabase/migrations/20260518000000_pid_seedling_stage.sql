-- Allow SEEDLING as a valid growth stage in pid_setpoints
alter table pid_setpoints
  drop constraint if exists pid_setpoints_stage_check;

alter table pid_setpoints
  add constraint pid_setpoints_stage_check
    check (stage in ('VEG', 'FLOWER', 'SEEDLING'));
