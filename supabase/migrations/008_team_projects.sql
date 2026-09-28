-- Shared team projects with per-member completion and availability.
create table if not exists public.team_projects (
  id uuid primary key default gen_random_uuid(),
  owner_id text not null references public.profiles(user_id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  join_code_hash text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.team_project_members (
  team_project_id uuid not null references public.team_projects(id) on delete cascade,
  user_id text not null references public.profiles(user_id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'member')),
  display_name text,
  joined_at timestamptz not null default now(),
  primary key (team_project_id, user_id)
);

create table if not exists public.team_tasks (
  id uuid primary key default gen_random_uuid(),
  team_project_id uuid not null references public.team_projects(id) on delete cascade,
  created_by text not null references public.profiles(user_id) on delete cascade,
  title text not null check (char_length(title) between 1 and 500),
  description text not null default '',
  due_date date,
  due_time time,
  duration_minutes integer check (duration_minutes is null or duration_minutes between 1 and 1440),
  priority smallint not null default 1 check (priority between 1 and 4),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.team_task_completions (
  team_task_id uuid not null references public.team_tasks(id) on delete cascade,
  user_id text not null references public.profiles(user_id) on delete cascade,
  completed_at timestamptz not null default now(),
  primary key (team_task_id, user_id)
);

create table if not exists public.team_availability (
  team_project_id uuid not null references public.team_projects(id) on delete cascade,
  user_id text not null references public.profiles(user_id) on delete cascade,
  week_start date not null,
  slots jsonb not null default '[]'::jsonb check (jsonb_typeof(slots) = 'array'),
  updated_at timestamptz not null default now(),
  primary key (team_project_id, user_id, week_start)
);

create index if not exists team_project_members_user on public.team_project_members(user_id);
create index if not exists team_tasks_project on public.team_tasks(team_project_id, due_date, due_time);
create index if not exists team_task_completions_user on public.team_task_completions(user_id);
create index if not exists team_availability_project_week on public.team_availability(team_project_id, week_start);

alter table public.team_projects enable row level security;
alter table public.team_project_members enable row level security;
alter table public.team_tasks enable row level security;
alter table public.team_task_completions enable row level security;
alter table public.team_availability enable row level security;
