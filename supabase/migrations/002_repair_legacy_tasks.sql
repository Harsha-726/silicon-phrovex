-- Safe repair for databases where public.tasks existed before migration 001.
-- Run this after 001 if the original index statement reported that
-- scheduling_identity did not exist.

alter table if exists public.tasks
  add column if not exists scheduling_identity text;
alter table if exists public.tasks
  add column if not exists idempotency_key text;

create unique index if not exists tasks_user_idempotency_key
  on public.tasks(user_id, idempotency_key)
  where idempotency_key is not null;

create unique index if not exists tasks_user_scheduling_identity
  on public.tasks(user_id, scheduling_identity)
  where scheduling_identity is not null;
