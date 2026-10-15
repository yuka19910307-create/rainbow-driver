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
- Source: integrations/cargo-customer-intake/staging-cleanup-schedule.sql. Existing draft deadline is 30 minutes; deletion is after that deadline on a subsequent scheduled run. The scheduled run at 2026-10-15 09:30 JST succeeded, as recorded in docs/cargo-customer-notice.review.md.
- This job does NOT remove verified requests, quotes, followups, owner test records, or production data. Do not claim all personal data retention is automated.

## Customer-facing development changes

- Owner designated rainbow.driver.saitama@gmail.com and https://lin.ee/8YNhfM5 as customer inquiry channels. These do not replace the administrator login or owner test recipient.
- Both development intake pages now show contact links, information-use purposes before consent, and the statement that submitting/verifying does not finalize delivery, price or contract.
- Confirmation summaries now use the Japanese preparation and handling labels from the form. Stored enum values and sending logic remain unchanged.
- Commits: acb7fc869fbeae1d106923c8d23cbb37f221bf18, f10270221f717287d4455b89b5525862d8220dac; summary labels 33ea890434dad29f8deca83e6fe497056fb48de8 and 202b4bbf6a041d575e3b75919f100db322de2edc.
- These changes are on test/cargo-safe-integration-20261013 only; they have not been published to the production site.
- Owner adopted the recommended 30-day-after-closure policy on 2026-10-15 at 11:03 JST. Explicit no-order closure and retention holds are implemented in staging; operator UI/API wiring is complete in development/staging; production rollout and external-service retention remain pending.

## Remaining public-launch gates

1. Finish privacy notice and production implementation of the approved retention policy. Contact channels and the 30-day-after-no-order-closure policy are decided. Operator closure/hold UI/API tests passed; existing request-expiry behavior is corrected in staging. Validate production scheduling/failure monitoring and external-service retention.
2. Review customer terms: when a contract forms, cancellation handling, tax/tolls/waiting/handling conditions. A quote reply remains an expression of interest, not automatic dispatch or payment.
3. Review abuse controls, IP-side limits and monitoring; verify public-path and quote/reply behavior in an explicitly scoped environment. Do not repeat completed owner tests without a concrete reason.
4. Prepare and review production configuration/migration/site changes and rollback plan. Do not copy secrets through chat or GitHub. Do not merge the entire development branch blindly.
5. Obtain explicit launch approval before enabling general intake or sending customer mail. Existing driving service and Square production must remain unaffected.

No production deployment or public intake enablement was performed in this step.

## Approved closed-consultation retention implementation

- Staging migration staging_closed_no_order_retention adds explicit closure timestamp, default-on retention hold, service-only closure/hold RPCs, transactional dependent-record cleanup, and count-only run records protected by RLS.
- Every-hour staging job cargo-staging-closed-no-order-retention runs at minute 17. The scheduled run at 2026-10-15 11:17 JST succeeded (zero requests deleted). Cron failure history is available; push/email alerts are not configured.
- Rollback-only service_role test passed: one eligible closed request and its quote/followup/event/consumed draft removed; six protected requests retained. Tested operator/confirmation/limit guards, hold release resetting the deadline, public access denial, and idempotence. Zero fixture rows persisted.
- Security advisors: new retention table has RLS with no client policies intentionally, and anon/authenticated privileges are revoked. Existing leaked-password-protection warning remains; no billing/auth configuration changed.
- General intake stays OFF. No customer mail, production changes or owner-test deletion.

## Operator closure/hold controls — 2026-10-15

- Both development operator pages now provide explicit no-order closure, saved-record hold/release, deletion due date in JST, and a separate closed/declined list. Cancelling confirmation makes no mutation.
- Removed the legacy direct closed-status UI/API path, which bypassed the retention confirmation. The server obtains operator identity from the verified JWT, rejects extra/body operator IDs and wrong confirmations, then calls the service-only RPC.
- cargo-customer-review-operator staging version 11 deployed with verify_jwt=true. Original version 10 source matched the reviewed repository file before replacement. No production function deployed.
- Tests use the actual handler with synthetic auth/RPC and both pages with a simulated DOM. They verify unauthorized denial, payload/confirmation guards, no-order/hold/release mapping, active vs closed list scopes, and no mail calls. This is not a real authenticated browser-to-staging end-to-end claim.
- Added tests/cargo-customer-retention-operator.test.cjs to CI and added retention SQL plus rollback tests to disposable PostgreSQL integration.
- Commit 3060ef2047fa429fdb4bc73c34a907083da75d76: security/disposable-SQL workflow 38671675886 succeeded; customer form browser workflow 38671675951 succeeded; live staging OFF/auth smoke 38671676074 succeeded.
- Development page changes are not yet published. Owner does not need to repeat the completed OTP test.
- Cron execution at 11:17 JST succeeded; read-only check shows customer request count 0, deleted request count 0, intake_enabled=false.

## Active consultation versus quote expiry — 2026-10-15

- Removed the legacy request-created-plus-30-days condition from quote preparation, send claim and customer reply. An ongoing consultation is no longer blocked merely by its old delete_after field.
- Request status guards still exclude closed/declined consultations. Operator membership, public intake OFF, single-send claim, matching response HMAC, one-time response and quote valid_until checks are preserved.
- Staging migration staging_separate_quote_expiry_from_retention applied only to hvdoqcrnztqmbzgwrovd. Upgrade SQL: integrations/cargo-customer-intake/active-consultation-expiry.review.sql.
- Rollback-only service_role test passed for an old active request with a past delete_after preparing a new quote, rejecting a past quote deadline, rejecting closed-request quoting and preserving protected records.
- Disposable quote test now uses a request created 31 days ago throughout the claim/reply flow and separately verifies EXPIRED on the quote's own deadline.
- Commit 5124254a965abd4c4430495cce1f9388abb7551e: security/disposable-SQL workflow 38672944798 and live OFF/auth smoke 38672944809 succeeded.
- Read-only verification: old request-age checks 0; quote deadline guards 2; real customer request count 0; intake_enabled=false. No production deployment or real mail.

## Shared customer email cap — 2026-10-15

- Applied staging_shared_customer_mail_budget only to staging. Global reservation cap shared by customer OTP and operator quotes: 10 attempts/calendar hour and 50/JST day. Config/counters only, no contact/IP/PII. These are conservative staging defaults, not a provider-account-wide or free-tier guarantee.
- Service-only SECURITY INVOKER RPC locks a single budget row; checks/reset/increment are atomic. Missing, disabled, exhausted or failed budget state blocks email. Denials do not increment; unknown/failed provider calls are not refunded.
- OTP claims budget after creating its unique draft and before the final intake switch check. Budget rejection removes the draft without contacting the provider.
- Quote claim obtains budget only after existing request/quote/expiry/gate checks, in the same DB transaction as the irreversible send claim. Capped quotes remain ready_to_send.
- Staging cargo-customer-intake v12 deployed, preserving existing verify_jwt=false and custom intake/CAPTCHA/OTP checks. Operator function remains JWT protected; SQL enforces quote cap without changing that deployment.
- Customer and operator pages distinguish budget refusal (mail not sent) from unknown provider delivery. Updated source/upgrade SQL retain the same guard.
- Rollback SQL tested hourly cap, day cap, hour/day reset, disabled state and public privilege denial. Actual handler tests verify zero provider calls and cleared draft on cap/failure; all four pages recognize budget errors. Counter remains 0/0, customer request count 0, intake OFF.
- Commit 0839e44f9f926763ba5ddaac8bc9ea620f08b98c: security/disposable-SQL 38675377796, staging OFF/auth smoke 38675377797 and browser 38675377809 succeeded.
- Security advisors report intentional RLS-without-client-policies on the new service-only table; client privileges revoked. Existing leaked-password warning unchanged.
- This is not complete abuse protection. Trusted source IP handling, per-IP fairness/limits, operator monitoring/alerting and external-service limits remain launch checks. No real customer mail or production change.
