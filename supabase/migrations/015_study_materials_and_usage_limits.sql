-- Study material generation with durable per-user and global spend guardrails.
create table if not exists public.study_materials (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references public.profiles(user_id) on delete cascade,
  title text not null check (char_length(title) between 1 and 160),
  source_type text not null default 'text' check (source_type in ('text', 'file', 'transcript')),
  content text not null check (char_length(content) between 1 and 250000),
  content_hash text not null,
  token_count integer not null check (token_count between 1 and 500000),
  created_at timestamptz not null default now(),
  unique (user_id, content_hash)
);

create table if not exists public.study_artifacts (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references public.profiles(user_id) on delete cascade,
  material_id uuid not null references public.study_materials(id) on delete cascade,
  cache_key text not null,
  format text not null check (format in ('flashcards', 'quiz', 'summary', 'study_guide')),
  model text not null check (model in ('haiku', 'sonnet')),
  options jsonb not null default '{}'::jsonb check (jsonb_typeof(options) = 'object'),
  status text not null default 'processing' check (status in ('processing', 'completed', 'failed')),
  content_json jsonb,
  input_tokens integer not null default 0 check (input_tokens between 0 and 500000),
  output_tokens integer not null default 0 check (output_tokens between 0 and 100000),
  reserved_cost_cents integer not null default 0 check (reserved_cost_cents between 0 and 100000),
  error_message text,
  claimed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, cache_key)
);

create index if not exists study_materials_user_created on public.study_materials(user_id, created_at desc);
create index if not exists study_artifacts_user_created on public.study_artifacts(user_id, created_at desc);

create table if not exists public.study_usage_monthly (
  user_id text not null references public.profiles(user_id) on delete cascade,
  period_start date not null,
  basic_generations integer not null default 0,
  advanced_generations integer not null default 0,
  input_tokens integer not null default 0,
  reserved_cost_cents integer not null default 0,
  requests_today integer not null default 0,
  request_day date not null default current_date,
  primary key (user_id, period_start)
);

create table if not exists public.study_usage_global_monthly (
  period_start date primary key,
  requests integer not null default 0,
  reserved_cost_cents integer not null default 0
);

alter table public.study_materials enable row level security;
alter table public.study_artifacts enable row level security;
alter table public.study_usage_monthly enable row level security;
alter table public.study_usage_global_monthly enable row level security;

-- This function is the final spend gate. The API may lower these limits via
-- parameters, but can never raise the hard database ceilings.
create or replace function public.reserve_study_usage(
  p_user_id text,
  p_generation_kind text,
  p_input_tokens integer,
  p_estimated_cost_cents integer,
  p_max_basic integer default 25,
  p_max_advanced integer default 5,
  p_max_input_tokens integer default 500000,
  p_max_user_cost_cents integer default 1000,
  p_max_daily_requests integer default 10,
  p_max_global_cost_cents integer default 10000
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_month date := date_trunc('month', current_date)::date;
  v_today date := current_date;
  v_basic integer;
  v_advanced integer;
  v_input integer;
  v_cost integer;
  v_requests_today integer;
  v_request_day date;
  v_global_cost integer;
  v_basic_limit integer := least(greatest(coalesce(p_max_basic, 25), 0), 25);
  v_advanced_limit integer := least(greatest(coalesce(p_max_advanced, 5), 0), 5);
  v_input_limit integer := least(greatest(coalesce(p_max_input_tokens, 500000), 0), 500000);
  v_user_cost_limit integer := least(greatest(coalesce(p_max_user_cost_cents, 1000), 0), 1000);
  v_daily_limit integer := least(greatest(coalesce(p_max_daily_requests, 10), 0), 10);
  v_global_cost_limit integer := least(greatest(coalesce(p_max_global_cost_cents, 10000), 0), 10000);
begin
  if p_user_id is null or p_generation_kind not in ('basic', 'advanced') then
    return jsonb_build_object('allowed', false, 'reason', 'Invalid usage request');
  end if;
  if coalesce(p_input_tokens, 0) < 1 or coalesce(p_estimated_cost_cents, 0) < 1 then
    return jsonb_build_object('allowed', false, 'reason', 'The study request is too small or invalid');
  end if;
  if p_input_tokens > v_input_limit then
    return jsonb_build_object('allowed', false, 'reason', 'This material exceeds your monthly input limit');
  end if;

  insert into public.study_usage_global_monthly(period_start) values (v_month)
    on conflict (period_start) do nothing;
  select reserved_cost_cents into v_global_cost
    from public.study_usage_global_monthly where period_start = v_month for update;
  if v_global_cost + p_estimated_cost_cents > v_global_cost_limit then
    return jsonb_build_object('allowed', false, 'reason', 'Silico study generation is paused until the next monthly budget resets');
  end if;

  insert into public.study_usage_monthly(user_id, period_start)
    values (p_user_id, v_month)
    on conflict (user_id, period_start) do nothing;
  select basic_generations, advanced_generations, input_tokens, reserved_cost_cents, requests_today, request_day
    into v_basic, v_advanced, v_input, v_cost, v_requests_today, v_request_day
    from public.study_usage_monthly where user_id = p_user_id and period_start = v_month for update;
  if v_request_day <> v_today then v_requests_today := 0; end if;
  if v_requests_today + 1 > v_daily_limit then
    return jsonb_build_object('allowed', false, 'reason', 'Daily study generation limit reached');
  end if;
  if v_input + p_input_tokens > v_input_limit then
    return jsonb_build_object('allowed', false, 'reason', 'Monthly study input limit reached');
  end if;
  if v_cost + p_estimated_cost_cents > v_user_cost_limit then
    return jsonb_build_object('allowed', false, 'reason', 'Your monthly study budget has been reached');
  end if;
  if p_generation_kind = 'basic' and v_basic + 1 > v_basic_limit then
    return jsonb_build_object('allowed', false, 'reason', 'Basic study generation limit reached');
  end if;
  if p_generation_kind = 'advanced' and v_advanced + 1 > v_advanced_limit then
    return jsonb_build_object('allowed', false, 'reason', 'Advanced Sonnet generation limit reached');
  end if;

  update public.study_usage_monthly set
    basic_generations = v_basic + case when p_generation_kind = 'basic' then 1 else 0 end,
    advanced_generations = v_advanced + case when p_generation_kind = 'advanced' then 1 else 0 end,
    input_tokens = v_input + p_input_tokens,
    reserved_cost_cents = v_cost + p_estimated_cost_cents,
    requests_today = v_requests_today + 1,
    request_day = v_today
    where user_id = p_user_id and period_start = v_month;
  update public.study_usage_global_monthly set
    requests = requests + 1,
    reserved_cost_cents = reserved_cost_cents + p_estimated_cost_cents
    where period_start = v_month;
  return jsonb_build_object('allowed', true, 'period_start', v_month, 'basic_generations', v_basic + case when p_generation_kind = 'basic' then 1 else 0 end, 'advanced_generations', v_advanced + case when p_generation_kind = 'advanced' then 1 else 0 end, 'input_tokens', v_input + p_input_tokens, 'reserved_cost_cents', v_cost + p_estimated_cost_cents);
end;
$$;

revoke all on function public.reserve_study_usage(text, text, integer, integer, integer, integer, integer, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.reserve_study_usage(text, text, integer, integer, integer, integer, integer, integer, integer, integer) to service_role;
