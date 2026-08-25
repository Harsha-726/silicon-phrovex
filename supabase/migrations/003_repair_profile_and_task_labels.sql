-- Repair for databases where migration 001 was applied before profile settings
-- and durable class/project labels were added to the task contract.

alter table if exists public.profiles
  add column if not exists settings jsonb not null default '{}'::jsonb;

alter table if exists public.tasks
  add column if not exists project_name text;
alter table if exists public.tasks
  add column if not exists class_name text;
alter table if exists public.tasks
  add column if not exists related_assessment_id uuid;

-- The application uses one authoritative task table for assessments and study
-- sessions. Re-point the legacy FK away from the unused assessments table.
alter table if exists public.tasks
  drop constraint if exists tasks_related_assessment_id_fkey;
alter table if exists public.tasks
  add constraint tasks_related_assessment_id_fkey
  foreign key (related_assessment_id) references public.tasks(id) on delete set null
  not valid;

alter table if exists public.profiles
  drop constraint if exists profiles_settings_check;
alter table if exists public.profiles
  add constraint profiles_settings_check check (jsonb_typeof(settings) = 'object');
