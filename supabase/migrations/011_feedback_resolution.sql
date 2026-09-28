-- Persist owner triage state for bug reports and feedback.
alter table public.feedback add column if not exists resolved boolean not null default false;

create index if not exists feedback_resolved_created_at on public.feedback(resolved, created_at desc);
