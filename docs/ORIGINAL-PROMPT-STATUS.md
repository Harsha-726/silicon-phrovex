# Original Silico prompt status

## Implemented foundation

- Calm productivity UI with Today, Upcoming, Calendar, Inbox, Classes, Projects, and Settings.
- One task representation in `src/core.js`.
- Deterministic local date, time, overdue, recurrence, parser, and study-slot logic.
- Natural-language capture for common task, assessment, shorthand, recurrence, and free-time inputs.
- Bounded assessment planning with conflict checks, no-past scheduling, and stable session identities.
- Server-only Groq endpoint boundary in `api/parse.js`.
- Clerk browser boundary and Supabase browser-safe configuration in `src/platform.js`.
- Local per-user fallback state and deterministic unit tests.
- Supabase migration with explicit relationships, checks, RLS enabled, and a unique scheduled-session identity.
- Authenticated server routes for tasks, profiles, and recurring occurrence completion.
- Durable authenticated profile settings and class/project task labels for remote refreshes.
- One client capture pipeline that uses the deterministic parser and optionally calls the server Groq parser.
- Study-preferences onboarding and persisted scheduling defaults.
- Configurable school start/end times and school days used as hard scheduler boundaries.
- Idempotent XP awards, completion-day tracking, streaks, and a compact Today progress summary.
- Calendar/LMS/transcription provider contracts without fake integrations.

## External deployment prerequisites

- Confirm the supplied Supabase project has `001_initial.sql` applied; use `002_repair_legacy_tasks.sql` and `003_repair_profile_and_task_labels.sql` for partial/legacy runs.
- Configure server-only `SUPABASE_SERVICE_ROLE_KEY`, `CLERK_ISSUER`, and `CLERK_JWKS_URL` in Vercel. They were not included in the supplied environment values.
- Add browser end-to-end coverage against a deployed Clerk/Supabase environment.
- Implement real Calendar/LMS imports and voice transcription when provider credentials and product requirements are available.

The application foundation and security boundaries are implemented and tested locally. Production persistence still depends on the external Supabase migration and server-only credentials being present in the deployed environment, followed by a browser-level smoke test.
