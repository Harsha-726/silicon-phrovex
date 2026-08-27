# Silico V2 master specification audit

| Stage | Status | Evidence |
| --- | --- | --- |
| Foundation | Complete | Hash routing, Clerk boundary, Supabase REST boundary, shared CSS, Today/Upcoming/Calendar, task drawer, capture UI |
| Task engine | Complete | `src/core.js`, `src/repository.js`, `/api/tasks`, single local/remote mutation path |
| Recurrence | Complete | Canonical recurrence JSON, occurrence expansion, independent completion API, DST-safe calendar iteration |
| Date/time | Complete | One date/time module, injected `now` in scheduler tests, invalid-date rejection, local calendar semantics |
| Parser | Complete | `src/capture.js` entry point plus deterministic intent extraction and shorthand correction |
| Server Groq | Complete | Authenticated `/api/parse`, server-only `GROQ_API_KEY`, timeout/rate-limit/JSON validation, deterministic fallback |
| Learning profile | Complete | Onboarding, per-class allocation, methods, session length, configurable school days/hours, time window, Settings editing |
| Scheduler | Complete | Hard school-hour/blocked-period/conflict/no-past rules, configurable boundaries, distributed sessions, soft priority/deadline ranking, stable identities |
| Assessment planning | Complete | Assessment plus bounded, distributed Study Session tasks, no arbitrary subplans, idempotency guard |
| Free-time assistant | Complete | Deterministic recommendation ranking after intent parsing, including duration fit |
| Calendar | Complete | Unified task/study/fixed-event calendar styling |
| State/cache | Complete | One authoritative state object, local fallback, remote repository, delete-all path, no duplicate cache layer |
| Error states | Complete | Parser fallback warnings, local-sync warnings, no-slot messaging, auth/database boundary errors |
| Polish | Complete | Responsive shell, keyboard capture shortcut, empty states, task drawer, onboarding, settings |
| Gamification | Complete locally | Idempotent XP awards, transparent completion days, current/longest streaks, subtle Today summary |
| Testing | Complete locally | `npm run lint`, `npm test`, `npm run build`; 14 deterministic tests pass |
| Production audit | Conditional | Groq secret absent from bundle; migration is now present/applied, while server-only Supabase credentials and browser-level deployment verification remain |

## External deployment actions

1. Confirm `supabase/migrations/001_initial.sql` (and, if needed, `002_repair_legacy_tasks.sql` plus `003_repair_profile_and_task_labels.sql`) is applied in Supabase.
2. Add `SUPABASE_SERVICE_ROLE_KEY`, `CLERK_ISSUER`, and `CLERK_JWKS_URL` to Vercel server environment variables.
3. Configure Clerk's allowed origins/redirects for the deployed Vercel URL.
4. Run browser-level smoke tests against the deployed environment.

If `public.tasks` was created by an older partial schema, the standalone repair migration restores the missing scheduling identity column and unique index.
