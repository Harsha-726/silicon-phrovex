-- Persist the one-time admin-key unlock for the owning Clerk account.
create table if not exists public.feedback_admin_access (
  user_id text primary key references public.profiles(user_id) on delete cascade,
  granted_at timestamptz not null default now()
);

alter table public.feedback_admin_access enable row level security;
