-- Repair legacy task tables whose priority column was left with a
-- single-value check constraint. Keep both the current numeric contract and
-- the text values already present in older rows valid during the rollout.

alter table if exists public.tasks
  drop constraint if exists tasks_priority_check;

alter table if exists public.tasks
  add constraint tasks_priority_check
  check (lower(priority::text) in (
    '1', '2', '3', '4',
    'low', 'medium', 'high', 'urgent', 'critical'
  ));
