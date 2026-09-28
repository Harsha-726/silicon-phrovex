-- Stripe-backed study entitlements. Stripe is the source of payment truth;
-- this table is the local read model used by the authenticated API.
create table if not exists public.billing_subscriptions (
  user_id text primary key references public.profiles(user_id) on delete cascade,
  stripe_customer_id text,
  stripe_subscription_id text unique,
  stripe_price_id text,
  plan text not null default 'free' check (plan in ('free', 'student')),
  status text not null default 'inactive' check (status in ('inactive', 'trialing', 'active', 'past_due', 'unpaid', 'canceled', 'incomplete', 'incomplete_expired')),
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists billing_subscriptions_customer on public.billing_subscriptions(stripe_customer_id);
create index if not exists billing_subscriptions_status on public.billing_subscriptions(status);

create table if not exists public.stripe_webhook_events (
  event_id text primary key,
  event_type text not null,
  processed_at timestamptz not null default now()
);

alter table public.billing_subscriptions enable row level security;
alter table public.stripe_webhook_events enable row level security;
