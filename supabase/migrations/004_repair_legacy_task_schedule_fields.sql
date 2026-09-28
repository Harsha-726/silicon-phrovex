-- Repair for databases where public.tasks predates the complete task contract.
-- Every statement is upgrade-safe for databases that already have these fields.

alter table if exists public.tasks
  add column if not exists due_time time;

alter table if exists public.tasks
  add column if not exists duration_minutes integer;

alter table if exists public.tasks
  add column if not exists project_id uuid;

alter table if exists public.tasks
  add column if not exists task_type text not null default 'task';

alter table if exists public.tasks
  add column if not exists source text not null default 'capture';

alter table if exists public.tasks
  add column if not exists completed_at timestamptz;

-- Add the relationships/checks only when the legacy table does not already
-- have equivalent constraints. PostgreSQL constraint names are table-scoped.
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.tasks'::regclass
      and conname = 'tasks_project_id_fkey'
  ) then
    alter table public.tasks
      add constraint tasks_project_id_fkey
      foreign key (project_id) references public.projects(id) on delete set null;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.tasks'::regclass
      and conname = 'tasks_duration_minutes_check'
  ) then
    alter table public.tasks
      add constraint tasks_duration_minutes_check
      check (duration_minutes is null or duration_minutes between 1 and 1440);
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.tasks'::regclass
      and conname = 'tasks_task_type_check'
  ) then
    alter table public.tasks
      add constraint tasks_task_type_check
      check (task_type in ('task', 'assessment', 'study_session', 'fixed_event'));
  end if;
end $$;
