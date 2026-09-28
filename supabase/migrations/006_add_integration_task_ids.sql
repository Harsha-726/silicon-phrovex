-- Durable provider identifiers used to update rather than duplicate synced work.
alter table if exists public.tasks
  add column if not exists google_event_id text;

create index if not exists tasks_user_google_event_id
  on public.tasks(user_id, google_event_id)
  where google_event_id is not null;

do $$
begin
  alter table public.tasks drop constraint if exists tasks_source_check;
  alter table public.tasks
    add constraint tasks_source_check
    check (source in ('capture', 'calendar', 'scheduler', 'todoist'));
exception when undefined_table then
  null;
end $$;
