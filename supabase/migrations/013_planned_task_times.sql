-- Keep a task's hard deadline separate from the time Silico recommends doing it.
-- This prevents a recommendation from overwriting the user's actual due date.
alter table if exists public.tasks
  add column if not exists scheduled_date date;

alter table if exists public.tasks
  add column if not exists scheduled_time time;

alter table if exists public.tasks
  add column if not exists scheduling_reason text;

create index if not exists tasks_user_scheduled_date
  on public.tasks(user_id, scheduled_date)
  where scheduled_date is not null;
