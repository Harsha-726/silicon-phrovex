-- Persist editable assignment labels and optional two-day event reminders.
alter table public.tasks add column if not exists assignment_type text not null default 'other';
alter table public.tasks alter column assignment_type set default 'homework';
alter table public.tasks add column if not exists event_reminder_enabled boolean not null default false;
alter table public.tasks add column if not exists event_reminder_recipient text;
alter table public.tasks add column if not exists reminder_for_task_id uuid references public.tasks(id) on delete cascade;

update public.tasks
set assignment_type = case
  when task_type = 'study_session' then 'study'
  when task_type = 'assessment' then 'test'
  when task_type = 'fixed_event' then 'event'
  else coalesce(nullif(assignment_type, ''), 'other')
end
where assignment_type is null or assignment_type = 'other';

alter table public.tasks drop constraint if exists tasks_assignment_type_check;
alter table public.tasks add constraint tasks_assignment_type_check
  check (assignment_type in ('study', 'test', 'quiz', 'homework', 'club_meeting', 'meeting', 'project', 'essay', 'presentation', 'event', 'other'));

create index if not exists tasks_user_reminder_for
  on public.tasks(user_id, reminder_for_task_id)
  where reminder_for_task_id is not null;
