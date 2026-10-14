# Isolated owner staging test

Requires the exact owner Auth identity and operator membership, official app origin, and the real staging gate OFF with both protections required. Fixed recipient and fictional request are enforced server-side. A permanent reservation prevents a second email attempt, including after ambiguous failure. An unexpired pending OTP can resume after login.

core.ts snapshots the deployed customer intake implementation with registration changed to a factory. The scoped adapter supplies an internal test gate and exclusively isolated table/RPC mappings. It never changes the real gate or accesses customer request tables. The SQL commit mirrors the customer OTP transaction against isolated test tables while requiring the real gate OFF and a matching owner reservation. Operator AES-GCM decoding validates the readback before listing it.

Validation: synthetic owner/isolation/crypto tests, a real staging SQL transaction for wrong/correct/reused OTP and consumed-payload clearing that was fully rolled back, and mobile Chromium UI tests using intercepted services only. The live owner send/code/save/review test remains user-operated. Deployment never sends email. No dispatch, booking, fare finalization or payment.

The test fixture contains only fictional details plus the owner email. Sessions are memory-only. Public launch approval, customer retention cleanup, and production rollout remain separate work. Future changes to customer source must be explicitly compared before updating this snapshot.
