-- Centralized private file storage for team projects.
create table if not exists public.team_files (
  id uuid primary key default gen_random_uuid(),
  team_project_id uuid not null references public.team_projects(id) on delete cascade,
  uploaded_by text not null references public.profiles(user_id) on delete cascade,
  object_path text not null unique,
  file_name text not null check (char_length(file_name) between 1 and 180),
  mime_type text not null default 'application/octet-stream',
  size_bytes integer not null check (size_bytes between 1 and 4194304),
  created_at timestamptz not null default now()
);

create index if not exists team_files_project_created on public.team_files(team_project_id, created_at desc);
alter table public.team_files enable row level security;
insert into storage.buckets (id, name, public)
values ('team-files', 'team-files', false)
on conflict (id) do update set public = false;
