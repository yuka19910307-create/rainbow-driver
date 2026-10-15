# Cargo release readiness — 2026-10-15

This record supersedes older progress statements, not security constraints. Public intake remains OFF. No customer mail, dispatch, pricing finalization or payment is authorized by this record.

## Verified

- Owner reported receipt of the Resend connection email. Resend domain mail.rainbow-driver.com was verified.
- Actual Turnstile verification and encrypted storage/read/decrypt checks completed.
- Owner-only fixed-fixture OTP flow completed on iPhone at 09:18–09:20 JST. Request cca4c23e-fb11-4cdb-af73-3919e6ad8891 is operator_reviewing.
- Read-only SQL confirmed consumed OTP, cleared draft ciphertext, intake_enabled=false, and zero actual customer intake requests.
- Owner test uses isolated tables and a scoped adapter. It does not establish that the public intake path or quote/reply flow has passed live E2E.
- Owner SQL permission fault fixed using a minimal owner lookup table, without granting service_role access to auth.users.
- Post-send content-review silent return fixed in main commit 3e7f7db4883020f6bed3c1a2dca593f278ae2d8c. GitHub Pages deployment 38657626678 and owner browser/handler test run 38657626853 succeeded. Public HTML contains the fix.
- One expired failed test reservation was released only after owner explicitly approved one retry. An RLS-protected recovery audit retained the event. No automatic email was sent during repair.

## Staging retention progress

- Existing cargo_customer_intake_cleanup(integer) deletes drafts past their existing delete_after deadline, at most 100 per call.
- A rollback-only synthetic test under service_role left exactly the unexpired draft; no test data persisted and no email was sent.
- Applied schedule_staging_expired_customer_intake_drafts only to hvdoqcrnztqmbzgwrovd. pg_cron job cargo-staging-expired-intake-drafts is active, scheduled every five minutes.
- Source: integrations/cargo-customer-intake/staging-cleanup-schedule.sql. Existing draft deadline is 30 minutes; deletion is after that deadline on a subsequent scheduled run. A successful scheduled run is still to be observed.
- This job does NOT remove verified requests, quotes, followups, owner test records, or production data. Do not claim all personal data retention is automated.

## Remaining public-launch gates

1. Agree and implement customer-facing privacy notice, contact channel, request/quote/followup retention and deletion policy. Current 30-day request default is not an approved complete policy.
2. Review customer terms: when a contract forms, cancellation handling, tax/tolls/waiting/handling conditions. A quote reply remains an expression of interest, not automatic dispatch or payment.
3. Review abuse controls, IP-side limits and monitoring; verify public-path and quote/reply behavior in an explicitly scoped environment. Do not repeat completed owner tests without a concrete reason.
4. Prepare and review production configuration/migration/site changes and rollback plan. Do not copy secrets through chat or GitHub. Do not merge the entire development branch blindly.
5. Obtain explicit launch approval before enabling general intake or sending customer mail. Existing driving service and Square production must remain unaffected.

No production deployment or public intake enablement was performed in this step.
