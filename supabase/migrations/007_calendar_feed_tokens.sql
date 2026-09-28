-- Private, revocable calendar subscription tokens. Raw tokens are never stored.
create table if not exists public.calendar_feed_tokens (
  user_id text not null references public.profiles(user_id) on delete cascade,
  token_hash text primary key,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create unique index if not exists calendar_feed_tokens_one_active_per_user
  on public.calendar_feed_tokens(user_id)
  where active;

create index if not exists calendar_feed_tokens_active_hash
  on public.calendar_feed_tokens(token_hash)
  where active;

alter table public.calendar_feed_tokens enable row level security;
