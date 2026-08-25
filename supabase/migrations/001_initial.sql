-- Silico's database contract. Authentication is Clerk; Supabase is database-only.
-- All writes go through the authenticated server API with the verified Clerk subject.

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  user_id text primary key,
  display_name text,
  timezone text not null default 'UTC',
  onboarding_complete boolean not null default false,
  settings jsonb not null default '{}'::jsonb check (jsonb_typeof(settings) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.classes (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references public.profiles(user_id) on delete cascade,
  name text not null,
  color text,
  created_at timestamptz not null default now(),
  unique (user_id, name)
);

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references public.profiles(user_id) on delete cascade,
  name text not null,
  color text,
  created_at timestamptz not null default now(),
  unique (user_id, name)
);

create table if not exists public.learning_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references public.profiles(user_id) on delete cascade,
  class_id uuid references public.classes(id) on delete cascade,
  session_length_minutes integer not null default 45 check (session_length_minutes between 15 and 180),
  sessions_per_week integer not null default 2 check (sessions_per_week between 0 and 14),
  preferred_methods jsonb not null default '[]'::jsonb,
  preferred_start time not null default '16:30',
  latest_study_time time not null default '21:00',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, class_id)
);

create table if not exists public.assessments (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references public.profiles(user_id) on delete cascade,
  class_id uuid references public.classes(id) on delete set null,
  title text not null,
  due_date date not null,
  due_time time,
  priority smallint not null default 1 check (priority between 1 and 4),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references public.profiles(user_id) on delete cascade,
  title text not null check (char_length(title) between 1 and 500),
  description text not null default '',
  status text not null default 'open' check (status in ('open', 'completed')),
  priority smallint not null default 1 check (priority between 1 and 4),
  due_date date,
  due_time time,
  duration_minutes integer check (duration_minutes is null or duration_minutes between 1 and 1440),
  project_id uuid references public.projects(id) on delete set null,
  project_name text,
  class_id uuid references public.classes(id) on delete set null,
  class_name text,
  recurrence jsonb,
  related_assessment_id uuid references public.tasks(id) on delete set null,
  task_type text not null default 'task' check (task_type in ('task', 'assessment', 'study_session', 'fixed_event')),
  source text not null default 'capture',
  idempotency_key text,
  scheduling_identity text,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (recurrence is null or jsonb_typeof(recurrence) = 'object')
);

-- Upgrade-safe repair for databases where public.tasks existed before this
-- migration was applied. CREATE TABLE IF NOT EXISTS does not add new columns.
alter table public.tasks add column if not exists scheduling_identity text;
alter table public.tasks add column if not exists idempotency_key text;
alter table public.tasks add column if not exists project_name text;
alter table public.tasks add column if not exists class_name text;
alter table public.profiles add column if not exists settings jsonb not null default '{}'::jsonb;

create unique index if not exists tasks_user_idempotency_key
  on public.tasks(user_id, idempotency_key)
  where idempotency_key is not null;

create unique index if not exists tasks_user_scheduling_identity
  on public.tasks(user_id, scheduling_identity)
  where scheduling_identity is not null;

create index if not exists tasks_user_due_date on public.tasks(user_id, due_date);
create index if not exists tasks_user_status on public.tasks(user_id, status);

create table if not exists public.recurrence_occurrence_completions (
  user_id text not null references public.profiles(user_id) on delete cascade,
  task_id uuid not null references public.tasks(id) on delete cascade,
  occurrence_date date not null,
  completed_at timestamptz not null default now(),
  primary key (user_id, task_id, occurrence_date)
);

-- The service role bypasses RLS. No browser client is allowed to query these tables directly.
alter table public.profiles enable row level security;
alter table public.classes enable row level security;
alter table public.projects enable row level security;
alter table public.learning_profiles enable row level security;
alter table public.assessments enable row level security;
alter table public.tasks enable row level security;
alter table public.recurrence_occurrence_completions enable row level security;
