-- Failed provider calls must not consume a user's study quota. The release
-- marker makes this safe to retry if the API process is interrupted.
alter table public.study_artifacts
  add column if not exists usage_released_at timestamptz;

create or replace function public.release_study_usage(
  p_user_id text,
  p_artifact_id uuid,
  p_generation_kind text,
  p_input_tokens integer,
  p_estimated_cost_cents integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_month date := date_trunc('month', current_date)::date;
  v_today date := current_date;
  v_request_day date;
  v_released integer;
begin
  if p_user_id is null
    or p_artifact_id is null
    or p_generation_kind not in ('basic', 'advanced')
    or coalesce(p_input_tokens, 0) < 1
    or coalesce(p_estimated_cost_cents, 0) < 1 then
    return jsonb_build_object('released', false, 'reason', 'Invalid usage release');
  end if;

  -- Claim the release exactly once. A completed artifact can never be
  -- refunded, while a processing/failed artifact can be refunded safely.
  update public.study_artifacts
  set usage_released_at = now(), updated_at = now()
  where id = p_artifact_id
    and user_id = p_user_id
    and status in ('processing', 'failed')
    and usage_released_at is null;
  get diagnostics v_released = row_count;
  if v_released = 0 then
    return jsonb_build_object('released', false, 'reason', 'Usage was already released or artifact completed');
  end if;

  -- Lock in the same order as reserve_study_usage so concurrent requests do
  -- not deadlock while one is reserving and another is refunding.
  insert into public.study_usage_global_monthly(period_start) values (v_month)
    on conflict (period_start) do nothing;
  perform 1 from public.study_usage_global_monthly
    where period_start = v_month for update;
  update public.study_usage_global_monthly
  set requests = greatest(0, requests - 1),
      reserved_cost_cents = greatest(0, reserved_cost_cents - p_estimated_cost_cents)
  where period_start = v_month;

  insert into public.study_usage_monthly(user_id, period_start)
    values (p_user_id, v_month)
    on conflict (user_id, period_start) do nothing;
  select request_day into v_request_day
    from public.study_usage_monthly
    where user_id = p_user_id and period_start = v_month
    for update;
  update public.study_usage_monthly
  set basic_generations = greatest(0, basic_generations - case when p_generation_kind = 'basic' then 1 else 0 end),
      advanced_generations = greatest(0, advanced_generations - case when p_generation_kind = 'advanced' then 1 else 0 end),
      input_tokens = greatest(0, input_tokens - p_input_tokens),
      reserved_cost_cents = greatest(0, reserved_cost_cents - p_estimated_cost_cents),
      requests_today = case when v_request_day = v_today then greatest(0, requests_today - 1) else 0 end,
      request_day = case when v_request_day = v_today then request_day else v_today end
  where user_id = p_user_id and period_start = v_month;

  return jsonb_build_object('released', true);
end;
$$;

revoke all on function public.release_study_usage(text, uuid, text, integer, integer) from public, anon, authenticated;
grant execute on function public.release_study_usage(text, uuid, text, integer, integer) to service_role;
