-- Preserve whether an execution time came from the user, Silico, or nowhere
-- yet. Change metadata makes automatic interventions auditable.
alter table if exists public.tasks
  add column if not exists schedule_origin text;

alter table if exists public.tasks
  add column if not exists schedule_change_reason text;

alter table if exists public.tasks
  add column if not exists schedule_change_message text;

update public.tasks
set schedule_origin = case
  when schedule_origin is not null then schedule_origin
  when scheduling_reason like '%silico:auto-scheduled%' then 'SILICO_SCHEDULED'
  when scheduled_date is not null or scheduled_time is not null then 'USER_SCHEDULED'
  else 'UNSCHEDULED'
end
where schedule_origin is null;

alter table if exists public.tasks
  add constraint tasks_schedule_origin_check
  check (schedule_origin is null or schedule_origin in ('USER_SCHEDULED', 'SILICO_SCHEDULED', 'UNSCHEDULED'));

alter table if exists public.tasks
  add constraint tasks_schedule_change_reason_check
  check (schedule_change_reason is null or schedule_change_reason in ('OVERDUE_RECOVERY', 'HARD_STOP_CONFLICT', 'TIME_CONFLICT', 'DURATION_REORDERING'));