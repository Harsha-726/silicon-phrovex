# Silico

Silico is a calm, Todoist-style task manager with deterministic study planning. Workspaces are available only after Clerk authentication; a signed-in user's cache keeps the app usable during a brief server outage while the server-side Groq boundary is ready for a Vercel deployment.

## Architecture

- `src/core.js` is the authoritative domain layer. It owns task shape, date semantics, recurrence expansion, natural-language capture, overdue logic, and the deterministic constraint-aware planning engine.
- `src/app.js` is the view/controller layer. It contains one mutation pipeline and persists one state object under `silico.state.v1`.
- `src/capture.js` is the one parser entry point. It first resolves deterministic date/time semantics and may enrich intent through `/api/parse`; the LLM never mutates data.
- `api/_auth.js`, `api/tasks.js`, `api/profile.js`, `api/feedback.js`, and `api/occurrences.js` are the authenticated server persistence boundary. Clerk subjects are verified server-side and user IDs are injected from the token.
- `supabase/migrations/001_initial.sql` is the authoritative database contract. The unique scheduling index prevents duplicate generated sessions.
- `src/repository.js` is the one client persistence adapter. Its offline cache is scoped by Clerk user id and is used only when the server boundary is unavailable.
- `src/providers.js` defines future Calendar, LMS, and transcription contracts without fake integrations.
- `api/team-projects.js` and migration 008 provide shared team projects with invite codes, per-member task completion, and weekly availability overlap. A member completing a task hides it only for that member; it disappears for everyone once all members complete it. Migration 010 stores authenticated bug reports and product feedback.
- `api/study.js` and migration 015 provide saved study materials and Gemini Flash-backed flashcards, quizzes, summaries, and outlines. Generation is disabled by default and passes through an atomic Supabase usage gate before any Gemini request.

## Run

```sh
npm install
npm run dev
```

After signing in, complete the study-preferences onboarding flow before assessment scheduling is enabled. Use the capture field for inputs such as `Bio test Friday`, `Finish my English essay tomorrow at 7`, or `I have an hour free`. Use Moments for commitments you want to remember before deciding when to do them; adding a date from Task details moves the item into the normal schedule.

## Validation

```sh
npm run lint
npm test
npm run build
```

## Environment configuration

Local values belong in `.env.local`, which is ignored by git. `GROQ_API_KEY` is consumed only by `api/parse.js`. `VITE_CLERK_PUBLISHABLE_KEY`, `VITE_CLERK_DOMAIN`, `VITE_SUPABASE_URL`, and `VITE_SUPABASE_ANON_KEY` are browser-safe configuration values. `VITE_CLERK_DOMAIN` is the Clerk instance domain used to load Clerk's UI bundle.

Clerk's browser SDK is loaded at the HTML boundary and gates the workspace. The offline cache is scoped by Clerk user id. Supabase configuration is isolated in `src/platform.js`; durable task persistence uses the authenticated server repository when `SUPABASE_SERVICE_ROLE_KEY`, `CLERK_ISSUER`, and `CLERK_JWKS_URL` are configured. The anon key must not be used to authorize user-owned writes.

## Deployment boundary

Set `GROQ_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `CLERK_ISSUER`, and `CLERK_JWKS_URL` only in the Vercel server environment. The browser must never receive the Groq or service-role secrets. The migration enforces uniqueness for scheduled sessions on `(user_id, scheduling_identity)`. If migration 001 was partially applied, run the repair migrations in order, including `supabase/migrations/014_team_subprojects_and_assignments.sql` and `supabase/migrations/015_study_materials_and_usage_limits.sql`, before enabling the related features.

The Feedback item in the sidebar is a private admin tool. It requires a signed-in Clerk session and the server-only `FEEDBACK_ADMIN_KEY`; after the first successful unlock, access is remembered for that Clerk account across devices. The owner can revoke that account grant from the panel. The key is never bundled into the client.

Study generation is fail-closed and plan-gated. The current public experience uses 10 Gemini Flash generations per month and supports longer source material through a 100,000-token free input budget. Text-bearing PDFs are extracted in the browser, and image-only pages are rendered and OCR-scanned locally before any extracted text can be sent to Gemini; the original PDF is not uploaded. Student and Advanced entitlements remain in the backend for later release, but their plan cards and model controls are hidden for now. Set `GEMINI_API_KEY` and `STUDY_AI_ENABLED=true` in Vercel only after reviewing the limits and the free-tier privacy implications in `.env.example`. Google marks Gemini free-tier content as potentially used to improve its products, so the UI warns users not to submit sensitive material. The database gate independently enforces the plan ceilings and spend budgets, and failed provider calls release their reservation exactly once. Apply migrations 015, 016, 017, and 023 before enabling the flag.

Tasks keep an editable assignment type such as Study, Test, Quiz, Homework, or Event. Event tasks can optionally create one generated reminder task two days before the event, with a recipient such as parents or a teacher. Apply migration 018 before using these fields.

Stripe billing uses hosted Checkout and the customer portal. Create separate Products for Student and Advanced, then create monthly Student, annual Student, and monthly Advanced recurring Prices. Add their IDs as `STRIPE_PRICE_STUDENT_MONTHLY`, `STRIPE_PRICE_STUDENT_ANNUAL`, and `STRIPE_PRICE_ADVANCED_MONTHLY`; set `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` in Vercel; then register `POST /api/billing` for `checkout.session.completed`, subscription updates/deletions, and invoice paid/failed events. Entitlements are granted only from verified webhook events; returning from Checkout alone never unlocks paid features.

Moments can also be created by voice through an IFTTT Google Assistant applet. The server-only `MOMENT_WEBHOOK_TOKEN` protects `POST /api/moment-webhook`; bind it to one account with `MOMENT_WEBHOOK_USER_ID` or `MOMENT_WEBHOOK_OWNER_EMAIL`, then send `{ "title": "<<<{{TextField}}>>>" }` from the IFTTT Webhooks action. If no text is spoken, the title defaults to `Voice moment`.

## Calendar integrations

The Settings page keeps separate Schoology and Todoist iCal imports, then publishes a private Silico iCal feed for Google Calendar. Todoist and Google OAuth are intentionally not used. Set `APP_URL` in Vercel if the deployment hostname should be explicit, and apply migrations 007, 008, and 013 before using calendar publishing, team projects, or persisted recommended work times. The private feed token is shown only when it is generated or regenerated; it is hashed in Supabase and can be revoked from Settings. Google Calendar subscribes read-only and refreshes periodically.
