-- Profile writes arrive from multiple devices and may race. Keep onboarding
-- completion and append-only gamification history inside one row lock so a
-- stale device cannot erase another device's progress.
create or replace function public.merge_profile_state(p_user_id text, p_patch jsonb)
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  current_profile public.profiles;
  current_settings jsonb;
  incoming_settings jsonb;
  current_gamification jsonb;
  incoming_gamification jsonb;
  merged_gamification jsonb;
  completed_days jsonb;
  awarded_task_ids jsonb;
  streak_milestones jsonb;
begin
  select * into current_profile
  from public.profiles
  where user_id = p_user_id
  for update;

  if not found then
    insert into public.profiles (user_id)
    values (p_user_id)
    returning * into current_profile;
  end if;

  current_settings := case when jsonb_typeof(current_profile.settings) = 'object' then current_profile.settings else '{}'::jsonb end;
  incoming_settings := case when jsonb_typeof(p_patch->'settings') = 'object' then p_patch->'settings' else '{}'::jsonb end;
  current_gamification := case when jsonb_typeof(current_settings->'gamification') = 'object' then current_settings->'gamification' else '{}'::jsonb end;
  incoming_gamification := case when jsonb_typeof(incoming_settings->'gamification') = 'object' then incoming_settings->'gamification' else '{}'::jsonb end;

  select coalesce(jsonb_agg(day order by day), '[]'::jsonb) into completed_days
  from (
    select distinct value as day
    from jsonb_array_elements_text(coalesce(current_gamification->'completedDays', '[]'::jsonb))
    union
    select distinct value as day
    from jsonb_array_elements_text(coalesce(incoming_gamification->'completedDays', '[]'::jsonb))
  ) days;

  select coalesce(jsonb_object_agg(key, true), '{}'::jsonb) into awarded_task_ids
  from (
    select key from jsonb_each(case when jsonb_typeof(current_gamification->'awardedTaskIds') = 'object' then current_gamification->'awardedTaskIds' else '{}'::jsonb end)
    union
    select key from jsonb_each(case when jsonb_typeof(incoming_gamification->'awardedTaskIds') = 'object' then incoming_gamification->'awardedTaskIds' else '{}'::jsonb end)
  ) task_ids;

  select coalesce(jsonb_object_agg(key, true), '{}'::jsonb) into streak_milestones
  from (
    select key from jsonb_each(case when jsonb_typeof(current_gamification->'streakMilestonesAwarded') = 'object' then current_gamification->'streakMilestonesAwarded' else '{}'::jsonb end)
    union
    select key from jsonb_each(case when jsonb_typeof(incoming_gamification->'streakMilestonesAwarded') = 'object' then incoming_gamification->'streakMilestonesAwarded' else '{}'::jsonb end)
  ) milestones;

  merged_gamification := current_gamification || incoming_gamification || jsonb_build_object(
    'xp', greatest(
      case when coalesce(current_gamification->>'xp', '') ~ '^-?[0-9]+([.][0-9]+)?$' then (current_gamification->>'xp')::numeric else 0 end,
      case when coalesce(incoming_gamification->>'xp', '') ~ '^-?[0-9]+([.][0-9]+)?$' then (incoming_gamification->>'xp')::numeric else 0 end
    ),
    'currentStreak', greatest(
      case when coalesce(current_gamification->>'currentStreak', '') ~ '^-?[0-9]+([.][0-9]+)?$' then (current_gamification->>'currentStreak')::numeric else 0 end,
      case when coalesce(incoming_gamification->>'currentStreak', '') ~ '^-?[0-9]+([.][0-9]+)?$' then (incoming_gamification->>'currentStreak')::numeric else 0 end
    ),
    'longestStreak', greatest(
      case when coalesce(current_gamification->>'longestStreak', '') ~ '^-?[0-9]+([.][0-9]+)?$' then (current_gamification->>'longestStreak')::numeric else 0 end,
      case when coalesce(incoming_gamification->>'longestStreak', '') ~ '^-?[0-9]+([.][0-9]+)?$' then (incoming_gamification->>'longestStreak')::numeric else 0 end
    ),
    'completedDays', completed_days,
    'awardedTaskIds', awarded_task_ids,
    'streakMilestonesAwarded', streak_milestones
  );

  update public.profiles
  set display_name = case when p_patch ? 'display_name' then nullif(trim(p_patch->>'display_name'), '') else current_profile.display_name end,
      timezone = case when p_patch ? 'timezone' then p_patch->>'timezone' else current_profile.timezone end,
      onboarding_complete = case when p_patch ? 'onboarding_complete' then current_profile.onboarding_complete or coalesce((p_patch->>'onboarding_complete')::boolean, false) else current_profile.onboarding_complete end,
      settings = jsonb_set(current_settings || incoming_settings, '{gamification}', merged_gamification, true)
  where user_id = p_user_id
  returning * into current_profile;

  return current_profile;
end;
$$;

revoke all on function public.merge_profile_state(text, jsonb) from public;
grant execute on function public.merge_profile_state(text, jsonb) to service_role;
