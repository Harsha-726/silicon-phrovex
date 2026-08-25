# Silico

Silico is a calm, Todoist-style task manager with deterministic study planning. This first foundation is intentionally small: the browser demo uses local storage so the product can be exercised without credentials, while the server-side Groq boundary is ready for a Vercel deployment.

## Architecture

- `src/core.js` is the authoritative domain layer. It owns task shape, date semantics, recurrence expansion, natural-language capture, overdue logic, and study-slot planning.
- `src/app.js` is the view/controller layer. It contains one mutation pipeline and persists one state object under `silico.state.v1`.
- `src/capture.js` is the one parser entry point. It first resolves deterministic date/time semantics and may enrich intent through `/api/parse`; the LLM never mutates data.
- `api/_auth.js`, `api/tasks.js`, `api/profile.js`, and `api/occurrences.js` are the authenticated server persistence boundary. Clerk subjects are verified server-side and user IDs are injected from the token.
- `supabase/migrations/001_initial.sql` is the authoritative database contract. The unique scheduling index prevents duplicate generated sessions.
- `src/repository.js` is the one client persistence adapter. The local demo fallback is scoped by Clerk user id and is used only when the server boundary is unavailable.
- `src/providers.js` defines future Calendar, LMS, and transcription contracts without fake integrations.

## Run

```sh
npm install
npm run dev
```

The demo starts with a small sample schedule. Use the capture field for inputs such as `Bio test Friday`, `Finish my English essay tomorrow at 7`, or `I have an hour free`. Authenticated users complete a short study-preferences onboarding flow before assessment scheduling is enabled.

## Validation

```sh
npm run lint
npm test
npm run build
```

## Environment configuration

Local values belong in `.env.local`, which is ignored by git. `GROQ_API_KEY` is consumed only by `api/parse.js`. `VITE_CLERK_PUBLISHABLE_KEY`, `VITE_CLERK_DOMAIN`, `VITE_SUPABASE_URL`, and `VITE_SUPABASE_ANON_KEY` are browser-safe configuration values. `VITE_CLERK_DOMAIN` is the Clerk instance domain used to load Clerk's UI bundle.

Clerk's browser SDK is loaded at the HTML boundary and gates the workspace when it is available. The local fallback state is scoped by Clerk user id. Supabase configuration is isolated in `src/platform.js`; durable task persistence uses the authenticated server repository when `SUPABASE_SERVICE_ROLE_KEY`, `CLERK_ISSUER`, and `CLERK_JWKS_URL` are configured. The anon key must not be used to authorize user-owned writes.

## Deployment boundary

Set `GROQ_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `CLERK_ISSUER`, and `CLERK_JWKS_URL` only in the Vercel server environment. The browser must never receive the Groq or service-role secrets. The migration enforces uniqueness for scheduled sessions on `(user_id, scheduling_identity)`. If migration 001 was partially applied, run `supabase/migrations/002_repair_legacy_tasks.sql` and `supabase/migrations/003_repair_profile_and_task_labels.sql` after it.
