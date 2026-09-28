-- Repair the remaining legacy task columns that prevent inserts.

-- The current API uses duration_minutes. Legacy databases still require
-- estimated_minutes, so make the old field optional for new task inserts.
alter table if exists public.tasks
  add column if not exists estimated_minutes integer;

alter table if exists public.tasks
  alter column estimated_minutes set default 0;

alter table if exists public.tasks
  alter column estimated_minutes drop not null;

-- The current authentication boundary stores Clerk subjects in profiles.
-- Preserve existing task rows, then align the legacy foreign key with the
-- current schema contract.
insert into public.profiles (user_id)
select distinct user_id
from public.tasks
where user_id is not null
on conflict (user_id) do nothing;

alter table if exists public.tasks
  drop constraint if exists tasks_user_id_fkey;

alter table if exists public.tasks
  add constraint tasks_user_id_fkey
  foreign key (user_id) references public.profiles(user_id) on delete cascade;
