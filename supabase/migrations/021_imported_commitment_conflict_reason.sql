-- Imported calendar commitments are hard stops. Keep their automatic repair
-- reason distinct from generic same-time collisions so the UI and audit trail
-- explain why an existing task moved around an imported event.
alter table if exists public.tasks
  drop constraint if exists tasks_schedule_change_reason_check;

alter table if exists public.tasks
  add constraint tasks_schedule_change_reason_check
  check (schedule_change_reason is null or schedule_change_reason in ('OVERDUE_RECOVERY', 'HARD_STOP_CONFLICT', 'HARD_COMMITMENT_CONFLICT', 'TIME_CONFLICT', 'DURATION_REORDERING'));
