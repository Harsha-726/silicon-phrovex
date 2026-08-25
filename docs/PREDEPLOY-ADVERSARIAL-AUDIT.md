# Silico V2 pre-deployment adversarial audit

## Outcome

The local application passes static, domain, build, and unauthenticated browser checks. It is not yet possible to certify production readiness from this workspace alone because the deployed Supabase schema, server-only service-role credential, and authenticated end-to-end task flows still require an external smoke test.

## Findings fixed in this audit

- Clerk sign-in was crashing because Clerk JS was loaded without the Clerk UI bundle. The page now loads the matching Clerk UI bundle and renders the sign-in form successfully.
- A first task from a new user could fail its foreign key because no `profiles` row existed. Authenticated task/profile paths now create the profile row before writes.
- Class and project labels were lost on remote refresh. They now travel through the task API and have durable columns.
- Onboarding and Settings preferences were local-only. Profile settings now persist through the authenticated profile endpoint and reload on startup.
- Repeated task creation relied on a generic Supabase upsert that did not target the custom idempotency indexes. The task API now looks up canonical idempotency/scheduling identities and recovers from concurrent unique conflicts.
- Study sessions referenced an assessment task UUID while the schema referenced the unused `assessments` table. The task relation is now self-referential, matching the one-authoritative-task design.
- Deleting a recurring occurrence from the detail drawer could silently leave the series in place. The delete path now resolves occurrence IDs to the canonical series task.
- Invalid natural-language times are rejected instead of being sent to persistence as impossible values.
- Clerk JWT validation now requires a valid expiry, rejects future `nbf`, limits token size, caches JWKS briefly, and refreshes on key rotation.

## Verification performed

- `npm run lint` — passed.
- `npm test` — 11 deterministic tests passed.
- `npm run build` — passed with Vite production output.
- Client bundle scan — no `VITE_GROQ_API_KEY`, Groq secret, service-role value, or `service_role` secret found.
- App/deployment scan — no localhost-only references found.
- Browser smoke check — Clerk sign-in form renders with email/password and Google options; the prior `Clerk was not loaded with Ui components` failure is gone.
- Static authority scan — one scheduler, one storage writer, and one client task repository remain; the parser has the intentional deterministic core plus one network wrapper.

## Required external checks before deployment

1. Apply `supabase/migrations/001_initial.sql`. For an existing partial/legacy database, also apply `002_repair_legacy_tasks.sql` and `003_repair_profile_and_task_labels.sql`.
2. Set server-only `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `GROQ_API_KEY`, `CLERK_ISSUER`, and `CLERK_JWKS_URL` in Vercel. Set browser-safe `VITE_CLERK_PUBLISHABLE_KEY`, `VITE_CLERK_DOMAIN`, `VITE_SUPABASE_URL`, and `VITE_SUPABASE_ANON_KEY`.
3. Use a Clerk production instance/key for production, and configure the deployed origin and redirect URLs in Clerk.
4. Run authenticated smoke tests for create, repeat assessment, edit, complete, recurring occurrence completion, delete, Delete All, refresh, and cross-user isolation.
5. Test one live `/api/parse` request and one live task write against the deployed server; local checks cannot prove external credentials or database state.

## Residual risks

- Calendar/LMS/transcription provider integrations are contracts only; no external provider has been implemented.
- There is no browser automation suite with a real Clerk session and live Supabase project yet.
- The supplied local Clerk key is a development key. It is suitable for local smoke testing, not production deployment.
