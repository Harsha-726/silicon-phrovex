-- Team subprojects and optional per-task assignees.
create table if not exists public.team_subprojects (
  id uuid primary key default gen_random_uuid(),
  team_project_id uuid not null references public.team_projects(id) on delete cascade,
  created_by text not null references public.profiles(user_id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (team_project_id, name)
);

alter table public.team_tasks add column if not exists subproject_id uuid references public.team_subprojects(id) on delete set null;
alter table public.team_tasks add column if not exists assignee_id text references public.profiles(user_id) on delete set null;

create index if not exists team_subprojects_project on public.team_subprojects(team_project_id, name);
create index if not exists team_tasks_assignment on public.team_tasks(assignee_id);
create index if not exists team_tasks_subproject on public.team_tasks(subproject_id);

alter table public.team_subprojects enable row level security;
