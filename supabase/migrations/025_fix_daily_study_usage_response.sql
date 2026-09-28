-- Refresh the deployed reservation function so daily usage resets at the
-- database boundary and the API receives the current daily counter immediately
-- after a successful Gemini reservation.
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
  v_month date := date_trunc('month', now() at time zone 'utc')::date;
  v_today date := (now() at time zone 'utc')::date;
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

  -- A new UTC calendar day starts a fresh daily request window, regardless of
  -- the previous row's counter. Persist the new day with the first reservation.
  if v_request_day is distinct from v_today then v_requests_today := 0; end if;
  if v_requests_today + 1 > v_daily_limit then
    return jsonb_build_object('allowed', false, 'reason', 'Daily study generation limit reached', 'requests_today', v_requests_today, 'request_day', v_today);
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

  return jsonb_build_object(
    'allowed', true,
    'period_start', v_month,
    'basic_generations', v_basic + case when p_generation_kind = 'basic' then 1 else 0 end,
    'advanced_generations', v_advanced + case when p_generation_kind = 'advanced' then 1 else 0 end,
    'input_tokens', v_input + p_input_tokens,
    'reserved_cost_cents', v_cost + p_estimated_cost_cents,
    'requests_today', v_requests_today + 1,
    'request_day', v_today
  );
end;
$$;

revoke all on function public.reserve_study_usage(text, text, integer, integer, integer, integer, integer, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.reserve_study_usage(text, text, integer, integer, integer, integer, integer, integer, integer, integer) to service_role;
