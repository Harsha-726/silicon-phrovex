-- Add a first-class Reminder label for generated and manually categorized tasks.
alter table if exists public.tasks drop constraint if exists tasks_assignment_type_check;
alter table if exists public.tasks add constraint tasks_assignment_type_check
  check (assignment_type in ('study', 'test', 'quiz', 'homework', 'club_meeting', 'meeting', 'project', 'essay', 'presentation', 'event', 'reminder', 'other'));
