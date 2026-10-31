# Invite-only phone setup preparation (2026-10-30)

## Current state

The debug Android app now has a one-time invite field. When the enrollment endpoint is enabled, a tester can enter one invite code and the app will obtain a unique backend installation token and a unique Cloudflare Access service token, then store both in Android Keystore-backed storage. The synthetic-message screen still accepts only invented text. `RemoteTransportGate.PRODUCTION_READY` is still `false`; this change does not send real SMS automatically.

The controlled server now has invite enrollment enabled. The local database migration and app-role grant are applied. A scoped Cloudflare provisioning API token is stored in the private Mac environment. Cloudflare Access has a path-specific Bypass for `/api/v1/enrollment`; the rest of `sms.apcida.stream` remains protected. A disposable remote enrollment and revocation test passed. No live invite has been issued for a friend yet.

## Design and limits

- The Mac administrator issues a 256-bit, one-use, 24-hour invite. Only its SHA-256 hash is stored in PostgreSQL. The code goes into a private mode-0600 file, never an APK or source file.
- Redemption claims the invite atomically. The server creates a 30-day Cloudflare service token, stores its ID with a unique backend installation, and returns the secrets once over HTTPS. The backend installation expires after 29 days. Failed enrollment attempts release the invite and attempt to delete a newly created Cloudflare token.
- The endpoint has a small request body, rate limit, generic errors, and `no-store` responses. The invite code is a bearer secret. Anyone holding an unused code can redeem it, so deliver it privately and revoke or let it expire if exposed.
- This is beta onboarding, not public self-service signup. It has no account login, lost-device recovery, automatic credential renewal, or guaranteed cleanup of a Cloudflare token if the Mac crashes between Cloudflare creation and database commit. A 29-day credential would require a new invite. When the backend installation is revoked or expires, the server retries Cloudflare token deletion and keeps the token ID until deletion succeeds. The debug screen's local removal button does not itself revoke the backend installation; the owner must revoke it separately.
- The `sms.apcida.stream` Service Auth policy now accepts any valid service token in this Cloudflare account. The backend installation token still protects analysis. The narrow enrollment path has a separate Access Bypass rule; Cloudflare Access checks and logging do not protect that path. The invite code and backend validation carry its authentication.

## Remote beta setup

1. Give the tester the updated debug APK containing the invite setup screen. Android commit `5196091` is on the shared `beta-test` branch. The earlier APK requires manually entering three credentials and cannot redeem an invite. The tester must set `apcida.productionApprovedHost=sms.apcida.stream` in their local `local.properties` before building.
2. When the tester is ready, issue one invite with the admin CLI to a private file and send only its code privately. It expires in 24 hours and works once. Do not put it in Git, an APK, screenshots, or this chat.
3. On the phone, enter the code in the debug screen and tap **Set up this test phone with invite**. Then use invented text only. Test on mobile data with Wi-Fi off, and test the unavailable state with both radios off.
4. Revoke the test installation after the supervised test. Removing local credentials from the phone does not revoke the backend installation. Confirm the Cloudflare service token has been deleted.
5. Before any release that sends real SMS: implement account recovery and credential renewal, finish privacy/backup/outage checks, and separately approve opening the Android production gate.

## Local verification completed

- Backend `npm test`: 124 tests, 122 passed, 2 pre-existing isolated-database tests skipped, 0 failures.
- Disposable invite against the controlled PostgreSQL app role: issue, redeem, reject replay, verify backend credential, revoke and remove records; no Cloudflare token created.
- Android `:app:assembleDebug :app:testDebugUnitTest --offline`: successful.
- Controlled API `/health` still returned `{"status":"ok"}` after migration.
- Remote Access check before enablement: unauthenticated `/health` and `/api/v1/sms/analyze` required Access; `/api/v1/enrollment` reached the server.
- Disposable remote invite smoke: first redemption HTTP 201, replay HTTP 401, newly minted phone service token reached protected `/health` with HTTP 200, authenticated invalid-body analysis request HTTP 400, and installation self-revocation HTTP 204. No SMS was analyzed; test token and database rows were removed.
- Physical beta phone on 2026-10-30: the one-time invite was redeemed and the installation was active. Invented scam text returned `SCAM · HIGH` on Wi-Fi. Invented appointment text returned `SAFE · HIGH` with Wi-Fi off and mobile data on. With both radios off, invented parcel text returned `Test unavailable: SERVER_UNAVAILABLE`. The owner revoked the installation and removed its Cloudflare service token; on mobile data the phone then returned `Test unavailable: CREDENTIAL_REVOKED`. The consumed invite file was removed from the Mac. The phone still needs local test credentials and the visible used invite text cleared by the tester.

Cloudflare references: [Access policies](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/), [path-specific Bypass](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/common-policies/), [service token creation API](https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/service_tokens/methods/create/).
