-- Personal projects are stored in profiles.settings, not in the projects
-- table used by the older task foreign-key schema. The previous profile RPC
-- shallow-merged JSON, so a stale device carrying projects: [] could erase
-- every project on the account. Merge this collection under the profile row
-- lock and retain explicit deletion tombstones.
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
  current_projects jsonb;
  incoming_projects jsonb;
  current_project_removals jsonb;
  incoming_project_removals jsonb;
  merged_projects jsonb;
  merged_project_removals jsonb;
  merged_settings jsonb;
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
  current_projects := case when jsonb_typeof(current_settings->'projects') = 'array' then current_settings->'projects' else '[]'::jsonb end;
  incoming_projects := case when jsonb_typeof(incoming_settings->'projects') = 'array' then incoming_settings->'projects' else '[]'::jsonb end;
  current_project_removals := case when jsonb_typeof(current_settings->'projectRemovals') = 'array' then current_settings->'projectRemovals' else '[]'::jsonb end;
  incoming_project_removals := case when jsonb_typeof(incoming_settings->'projectRemovals') = 'array' then incoming_settings->'projectRemovals' else '[]'::jsonb end;

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

  select coalesce(jsonb_agg(name order by lower(name), name), '[]'::jsonb) into merged_project_removals
  from (
    select distinct trim(value) as name
    from jsonb_array_elements_text(current_project_removals)
    where trim(value) <> ''
    union
    select distinct trim(value) as name
    from jsonb_array_elements_text(incoming_project_removals)
    where trim(value) <> ''
  ) removals;

  select coalesce(jsonb_agg(name order by lower(name), name), '[]'::jsonb) into merged_projects
  from (
    select distinct trim(value) as name
    from jsonb_array_elements_text(current_projects || incoming_projects)
    where trim(value) <> ''
      and not exists (
        select 1
        from jsonb_array_elements_text(merged_project_removals) removal
        where lower(trim(removal)) = lower(trim(value))
      )
  ) projects;

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

  merged_settings := current_settings || incoming_settings;
  merged_settings := jsonb_set(merged_settings, '{projects}', merged_projects, true);
  merged_settings := jsonb_set(merged_settings, '{projectRemovals}', merged_project_removals, true);
  merged_settings := jsonb_set(merged_settings, '{gamification}', merged_gamification, true);

  update public.profiles
  set display_name = case when p_patch ? 'display_name' then nullif(trim(p_patch->>'display_name'), '') else current_profile.display_name end,
      timezone = case when p_patch ? 'timezone' then p_patch->>'timezone' else current_profile.timezone end,
      onboarding_complete = case when p_patch ? 'onboarding_complete' then current_profile.onboarding_complete or coalesce((p_patch->>'onboarding_complete')::boolean, false) else current_profile.onboarding_complete end,
      settings = merged_settings
  where user_id = p_user_id
  returning * into current_profile;

  return current_profile;
end;
$$;

revoke all on function public.merge_profile_state(text, jsonb) from public;
grant execute on function public.merge_profile_state(text, jsonb) to service_role;
