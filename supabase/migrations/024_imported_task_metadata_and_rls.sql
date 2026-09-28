-- Preserve calendar classification edits across refreshes and make every
-- application table private by default. The server uses the service role for
-- its authenticated API, while direct client access is restricted to rows
-- owned by the current Supabase user.

alter table if exists public.tasks
  add column if not exists calendar_class_manually_set boolean not null default false,
  add column if not exists calendar_class_name text,
  add column if not exists calendar_class_hint text,
  add column if not exists calendar_default_class text,
  add column if not exists calendar_class_resolution text;

alter table if exists public.profiles enable row level security;
alter table if exists public.classes enable row level security;
alter table if exists public.projects enable row level security;
alter table if exists public.learning_profiles enable row level security;
alter table if exists public.assessments enable row level security;
alter table if exists public.tasks enable row level security;
alter table if exists public.recurrence_occurrence_completions enable row level security;
alter table if exists public.calendar_feed_tokens enable row level security;
alter table if exists public.team_projects enable row level security;
alter table if exists public.team_project_members enable row level security;
alter table if exists public.team_tasks enable row level security;
alter table if exists public.team_task_completions enable row level security;
alter table if exists public.team_availability enable row level security;
alter table if exists public.team_subprojects enable row level security;
alter table if exists public.team_files enable row level security;
alter table if exists public.study_materials enable row level security;
alter table if exists public.study_artifacts enable row level security;
alter table if exists public.study_usage_monthly enable row level security;
alter table if exists public.study_usage_global_monthly enable row level security;
alter table if exists public.feedback enable row level security;
alter table if exists public.feedback_admin_access enable row level security;
alter table if exists public.billing_subscriptions enable row level security;
alter table if exists public.stripe_webhook_events enable row level security;

do $$
declare
  table_name text;
  owned_tables text[] := array[
    'profiles', 'classes', 'projects', 'learning_profiles', 'assessments',
    'tasks', 'recurrence_occurrence_completions', 'calendar_feed_tokens',
    'team_task_completions', 'team_availability',
    'study_materials', 'study_artifacts', 'study_usage_monthly', 'feedback',
    'feedback_admin_access', 'billing_subscriptions'
  ];
begin
  foreach table_name in array owned_tables loop
    execute format('drop policy if exists %I on public.%I', table_name || '_owner_policy', table_name);
    execute format(
      'create policy %I on public.%I for all to authenticated using (user_id = auth.uid()::text) with check (user_id = auth.uid()::text)',
      table_name || '_owner_policy', table_name
    );
  end loop;
end $$;

drop policy if exists team_projects_owner_policy on public.team_projects;
create policy team_projects_owner_policy on public.team_projects
  for all to authenticated
  using (owner_id = auth.uid()::text)
  with check (owner_id = auth.uid()::text);

drop policy if exists team_project_members_self_policy on public.team_project_members;
create policy team_project_members_self_policy on public.team_project_members
  for all to authenticated
  using (user_id = auth.uid()::text)
  with check (user_id = auth.uid()::text);

drop policy if exists team_tasks_creator_policy on public.team_tasks;
create policy team_tasks_creator_policy on public.team_tasks
  for all to authenticated
  using (created_by = auth.uid()::text)
  with check (created_by = auth.uid()::text);

drop policy if exists team_subprojects_creator_policy on public.team_subprojects;
create policy team_subprojects_creator_policy on public.team_subprojects
  for all to authenticated
  using (created_by = auth.uid()::text)
  with check (created_by = auth.uid()::text);

drop policy if exists team_files_uploader_policy on public.team_files;
create policy team_files_uploader_policy on public.team_files
  for all to authenticated
  using (uploaded_by = auth.uid()::text)
  with check (uploaded_by = auth.uid()::text);

drop policy if exists study_usage_global_deny_policy on public.study_usage_global_monthly;
create policy study_usage_global_deny_policy on public.study_usage_global_monthly
  for all to authenticated using (false) with check (false);

drop policy if exists stripe_webhook_events_deny_policy on public.stripe_webhook_events;
create policy stripe_webhook_events_deny_policy on public.stripe_webhook_events
  for all to authenticated using (false) with check (false);

-- team_files is also represented in Supabase Storage; this protects objects
-- even when a client bypasses the application API.
drop policy if exists team_files_storage_owner_policy on storage.objects;
create policy team_files_storage_owner_policy on storage.objects
  for all to authenticated
  using (bucket_id = 'team-files' and owner_id = auth.uid()::text)
  with check (bucket_id = 'team-files' and owner_id = auth.uid()::text);
