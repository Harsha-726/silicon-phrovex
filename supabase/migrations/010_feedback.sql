-- Authenticated user bug reports and product feedback.
create table if not exists public.feedback (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references public.profiles(user_id) on delete cascade,
  category text not null check (category in ('bug', 'feedback')),
  message text not null check (char_length(message) between 1 and 5000),
  page text not null default '',
  resolved boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists feedback_created_at on public.feedback(created_at desc);
create index if not exists feedback_user on public.feedback(user_id, created_at desc);

alter table public.feedback enable row level security;
