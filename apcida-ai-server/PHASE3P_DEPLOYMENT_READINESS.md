# Phase 3P: Security, privacy, and stable-hosting readiness

Prepared on 2026-10-28 from the Phase 3O, 3N, 3M, and 3K implementations. This is a **local preparation and synthetic verification** phase. No production tunnel, domain, Cloudflare route, or production listener was deployed. No migration or deletion was run against the main ApCiDa database. No real SMS was transmitted. Android RemoteTransportGate.PRODUCTION_READY remains false and the live receiver/worker still do not construct ProductionSmsTransport or AutomaticRemoteCoordinator.

## Implemented files

| File | Phase 3P change |
| --- | --- |
| Backend src/production/createProductionApp.js | Added an authenticated, bodyless DELETE /api/v1/installations/me endpoint for future consent-revocation cleanup. It calls the existing transactional installation revocation, deletes that installation's response cache and rate counters, and returns 204. It does not accept a bearer-free request. A revocation audit event contains only event type and opaque installation ID. The route is present only in the opt-in production app, never the development or synthetic-pilot apps. |
| Backend src/production/repository.js | Added bounded purgeInactiveInstallations(days). It deletes only expired or revoked production identity rows older than the selected grace period; FK cascades delete their remaining production request/rate rows. It does not access research or RAG tables. |
| Backend src/production/server.js | Added optional APCIDA_PRODUCTION_IDENTITY_RETENTION_DAYS, valid from 1 to 3650. Unset means no automatic identity deletion. When explicitly set, cleanup runs at listener startup and hourly alongside the existing 1–72-hour response-cache cleanup. The production listener remains opt-in and loopback-only. |
| Backend src/staging/localServer.js, scripts/phase3o-staging-verify.sh, test/phase3oStaging.test.js | Added a disposable staging identity for testing the real self-revocation route and ran the PostgreSQL repository test against the same temporary cluster. |
| Backend test/phase3nProductionApi.test.js and test/phase3nProductionRepository.test.js | Added synthetic tests for unauthorized revocation, cache deletion, in-flight inference revocation, retention configuration, and actual PostgreSQL identity cleanup. |
| Android ProductionSenderMinimization.kt and ProductionSenderMinimizationTest.kt | Added an **unwired candidate** that replaces ordinary numeric phone-number senders with PHONE_NUMBER while preserving short codes and alphanumeric claims. This is for a future privacy/accuracy review; no production request or model input changed. |
| Android ProductionCredentialStore.kt and ProductionCredentialStoreInstrumentedTest.kt | Added test-isolated preference/Keystore alias parameters and a production credential device test that verifies encrypted persistence, store recreation, and clearing without touching any provisioned credential. The default store names are unchanged. |
| Android ProductionSmsTransportTest.kt | Added a synthetic Cloudflare 524 response assertion: it remains SERVER_UNAVAILABLE, never a verified SAFE. |

The new self-revocation endpoint is **not wired to Android Settings**. Once a controlled rollout is separately approved, Android must arrange a durable, privacy-safe deletion request after local consent revocation, including handling offline devices and already-started requests. The backend endpoint alone cannot guarantee immediate remote deletion when the MacBook is offline.

## Security and privacy verification

Administrator enrollment remains a local CLI operation requiring a distinct administrator key, explicit approval, and a new private credential file. No anonymous enrollment route exists. Each installation receives a different 256-bit bearer credential; only its SHA-256 hash is stored by PostgreSQL. Android production credentials use AES-GCM with an Android Keystore key and are separate from pilot credentials. The Android manifest disables backup and release cleartext traffic. The production API rejects missing, invalid, expired, and revoked tokens. The new self-revoke operation invalidates its own token, clears cached responses and rate windows transactionally, and prevents a pending inference from returning a verdict after the revocation check. Existing tests cover per-install durable rate counts, atomic message claims, encrypted replay, and the database-backed one-inference slot.

Production request text and raw sender are still used in memory for inference. The production database stores no raw SMS or sender columns. A keyed request HMAC binds a message ID to a payload, and cached responses are encrypted because a rationale may contain sensitive data. Audit output contains event code, coarse timestamp, and installation UUID; tests check it contains neither SMS body nor token. Error bodies use generic codes. Research contribution remains a separate opt-in workflow; this phase did not access its records or approved RAG knowledge.

The sender minimization helper is only a candidate. Changing the sender actually sent to Gemma could change classification, so it must be assessed with synthetic and later consented real-world data before use. The current Android Room record can contain raw SMS and sender locally; local retention is outside this backend cache policy. Do not log Authorization, Cloudflare Access secrets, SMS text, sender, or rationale in tunnel, proxy, crash, or analytics logs.

The response cache retains ciphertext for a configured 1–72 hours, default 24. Startup/hourly purge means physical deletion can lag expiry by up to one hour while the listener runs, or until restart if offline. Revocation deletes that installation's cache immediately when the request reaches the backend. Identity rows retain opaque ID, label, hash, issue/expiry/revocation times; automatic identity deletion is **disabled by default** and requires explicit APCIDA_PRODUCTION_IDENTITY_RETENTION_DAYS. PostgreSQL backups, OS logs, Cloudflare logs, and transient Ollama memory have separate retention policies still to decide. Rotating PRODUCTION_DATA_KEY without a migration makes old encrypted replay unavailable, so a rotation plan is required before deployment.

## Stable Cloudflare hosting recommendation

Use a **named Cloudflare Tunnel** with a stable subdomain of a domain controlled by the thesis team, pointing only to the Mac's localhost-bound production API port after a separate deployment approval. Keep Ollama on 127.0.0.1:11434 and PostgreSQL on 127.0.0.1/[::1]:5432, with no tunnel route to either. The Mac must stay powered, online, and logged in or run managed services at boot; a stable hostname does not make a sleeping Mac available. The Android client would use the exact approved HTTPS hostname with ordinary certificate validation and no redirects. Phones need no Tailscale installation.

The current trycloudflare.com Quick Tunnel is a development URL: Cloudflare says its hostname changes and it has no uptime guarantee. A named published application requires a domain on Cloudflare. Cloudflare Tunnel is available on all plans; domain registration/renewal price depends on the chosen domain and registrar. Cloudflare Registrar publishes current extension prices. Cloudflare's current Zero Trust Free plan is listed for up to 50 users, but check actual Access/service-token requirements and any billing before purchase or rollout. No domain was bought here. See [Quick Tunnel limitations](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/), [named tunnel setup](https://developers.cloudflare.com/tunnel/get-started/), [Tunnel availability](https://developers.cloudflare.com/tunnel/), [Cloudflare plans](https://www.cloudflare.com/plans/), and [registrar prices](https://pricing.registrar.cloudflare.com/).

Create the Cloudflare Access application and Service Auth policy **before** publishing a route; Cloudflare warns that an unprotected published hostname is reachable by anyone. Enable Access validation at cloudflared or the origin, plus the backend's own per-install bearer check. Cloudflare Access service tokens use a Client ID and Secret in separate headers. A shared secret embedded in the APK is unacceptable. A limited pilot could provision unique Access credentials per installation into platform-protected storage, but the current Android production transport does not send Access headers and this design still needs enrollment, rotation, and revocation tests. Protect with Access and deny-by-default account policy should be reviewed carefully because account-wide changes can affect unrelated sites. See [Access application order and token validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/), [Service Auth headers](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/), and [default-deny setting](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/require-access-protection/).

Future manual setup and recovery after approval:

1. In the Cloudflare dashboard, create a named tunnel and Access application for a chosen stable hostname. Configure Access policy and token validation before adding the published application route. Route that hostname only to the production listener at http://127.0.0.1:3020. Keep public ingress to the Mac closed. Do not route to pilot port 3010, Ollama, or PostgreSQL.
2. Install cloudflared as a macOS service using the official [macOS service guide](https://developers.cloudflare.com/tunnel/features/locally-managed-tunnels/as-a-service/macos/). Secure the tunnel credential/configuration outside Git. For a local-managed service, that guide documents launch-at-login or launch-at-boot; choose deliberately based on who operates the Mac. Do not put a tunnel token on a shared command line or in a repository.
3. Verify the local backend health and localhost bind with lsof -nP -iTCP -sTCP:LISTEN, then check the named tunnel's Healthy status in the Cloudflare dashboard or cloudflared tunnel list. Verify valid HTTPS on the approved hostname, Access rejecting unauthorized requests, and the backend returning 401 for missing per-install credentials.
4. If the tunnel is Down, check whether the Mac is awake, cloudflared service is running, and outbound Cloudflare connectivity is available. If a connected tunnel returns 502, check the localhost API listener and configured origin port; Cloudflare documents this as an origin reachability problem. A 524 indicates the origin did not respond before the proxy read timeout. Restart the macOS cloudflared service using the service type and commands from the official guide, then recheck health and access. Restart Ollama/backend separately if their own health checks fail. Never log tokens while diagnosing. See [Tunnel troubleshooting](https://developers.cloudflare.com/tunnel/troubleshooting/) and [macOS service restart instructions](https://developers.cloudflare.com/tunnel/features/locally-managed-tunnels/as-a-service/macos/).

For the **future approved boot daemon** with its reviewed configuration in /etc/cloudflared, the official macOS guide gives these manual commands. They were not run in this phase:

~~~bash
sudo cloudflared service install
sudo launchctl stop com.cloudflare.cloudflared
sudo launchctl start com.cloudflare.cloudflared
cloudflared tunnel list
lsof -nP -iTCP:3020 -sTCP:LISTEN
curl --fail --silent http://127.0.0.1:3020/health
~~~

Use the service guide's separate login-agent instructions if that mode is chosen instead. A healthy tunnel plus a failed localhost health check points to the backend, not DNS. Keep tunnel tokens out of command arguments, shell history, source files, and diagnostic output.

Local inspection found cloudflared 2026.10.4 installed, but no ~/.cloudflared configuration directory. Ollama and PostgreSQL currently listen on loopback, and a Node process listens on loopback port 3010. Process-list access was restricted, so an active Quick Tunnel could not be confirmed from this inspection. No Cloudflare account configuration was changed.

## Timeout and fallback review

| Layer | Current behavior | Readiness consequence |
| --- | --- | --- |
| Android production OkHttp | 10 s connect, 150 s read, 180 s total call | A Cloudflare 524 or network timeout is SERVER_UNAVAILABLE/TIMEOUT, never SAFE. |
| Cloudflare proxied hostname | Official documentation currently lists 125 s default proxy read timeout and 30 s write timeout; longer read timeout requires Enterprise configuration | A single synchronous Gemma+RAG request may hit 524 before Android's 180 s deadline. |
| Ollama embedding and Gemma chat | REQUEST_TIMEOUT_MS defaults to 120,000 ms for **each** sequential request | Worst-case embedding plus chat approaches 240 s before DB/network overhead, exceeding Cloudflare's default read timeout. No timeout increase was made. |
| Node 24 HTTP server on this Mac | No application response deadline configured; observed requestTimeout 300 s to receive a request, headersTimeout 60 s, socket timeout 0 | These are not an end-to-end inference deadline and do not remove the Cloudflare mismatch. |
| PostgreSQL production pool | Statement timeout 10 s; inference lease 300 s | Database stalls fail as 503; a crashed lease is eventually recoverable. |
| Android orphan work recovery | Marks AI work older than 120 s unavailable; coordinator is not wired | It conflicts with a future 180 s HTTP call. Resolve before receiver integration. |

Cloudflare limit: [Error 524](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-524/) and [connection limits](https://developers.cloudflare.com/fundamentals/reference/connection-limits/). Measure actual synthetic Gemma+RAG latency through a separately approved stable staging route before deciding on a request budget or asynchronous job/poll design. Do not simply raise the Ollama timeout. A failed, timed-out, offline, malformed, or authentication-rejected remote attempt preserves local keyword assessment. Zero-rule messages remain UNVERIFIED without a successful AI verdict. The coordinator attempts no automatic retry; Room and PostgreSQL claims prevent ordinary duplicates. A crash between model completion and cache commit can still repeat inference if an explicit request is later retried.

## Automated verification

- Backend npm test: **107 total, 105 passed, 0 failed, 2 optional tests skipped** because an isolated PostgreSQL URL and staging listener are not set in the ordinary run.
- Isolated staging harness: **2/2 backend staging tests passed, 1/1 actual PostgreSQL repository test passed, 4/4 Android-to-staging JVM contract tests passed**. It creates and removes a temporary local cluster, applies migration 004 there only, and uses a synthetic analyzer. The new self-revocation and identity purge paths were verified against this temporary database.
- Android JVM: **114 total, 110 passed, 0 failed, 4 staging-only tests skipped** in the ordinary run. Those four passed in the separate harness. The new sender-minimization helper tests passed.
- Android builds: debug APK built; release Kotlin compiled; instrumentation APK compiled. APKs are under app/build/outputs/apk/debug/ and app/build/outputs/apk/androidTest/debug/. **No physical instrumentation was executed here.** The new production Keystore test was compiled only.

## Windows physical-device run for the teammate

The corrected suite contains consent persistence, pilot and new production Keystore tests, Room migration/atomic claims/concurrent claims, offline keyword fallback, notification update/cancellation, and database-reopen persistence. Database reopen is **not** a true process-kill test. The notification test can skip unless OS notifications, POST_NOTIFICATIONS, the notification channel, and ApCiDa scam alerts are enabled. These tests use synthetic rows and mock responses; they do not transmit real SMS.

The Android working tree still contains uncommitted Phase 3L/3M files and these Phase 3P changes. The teammate must receive the updated source branch or the newly built debug and instrumentation APKs before rerunning; an older clone will still contain the obsolete test. No commit or push was performed in this phase.

In PowerShell on the Windows teammate's machine with a working JDK/Android SDK and the Xiaomi connected:

~~~powershell
cd C:\path\to\Mobile_App
adb devices -l
.\gradlew.bat :app:testDebugUnitTest :app:assembleDebug :app:assembleDebugAndroidTest --console=plain
.\gradlew.bat :app:installDebug --console=plain
adb shell pm grant com.apcida.smishingdetector.debug android.permission.POST_NOTIFICATIONS
.\gradlew.bat :app:connectedDebugAndroidTest --console=plain
~~~

Confirm adb lists the Xiaomi as device, not unauthorized. In Android settings, enable notifications and the ApCiDa notification channel. In ApCiDa Settings, enable scam alerts. Read the device report at app\build\reports\androidTests\connected\index.html. The earlier Xiaomi baseline was 13 tests with 10 passed, 2 failed, and 1 skipped. Phase 3L replaced the obsolete Gemma test with two keyword tests and fixed the debug application ID assertion; this phase adds one production Keystore instrumentation test. The expected discovery count is therefore 15, but only the actual device report can establish that count or a pass.

For a focused notification rerun:

~~~powershell
.\gradlew.bat :app:connectedDebugAndroidTest "-Pandroid.testInstrumentationRunnerArguments.class=com.apcida.smishingdetector.util.SyntheticNotificationInstrumentedTest" --console=plain
~~~

For a supervised process-death check using synthetic local state, first inspect a synthetic test row/notification through the test fixture, then background the debug app, run adb shell am kill com.apcida.smishingdetector.debug, relaunch it with adb shell monkey -p com.apcida.smishingdetector.debug 1, and inspect persisted Room state and notification behavior. The current test suite only reopens a database and does not automate that kill/restart observation. Do not use a real SMS or the production endpoint for this check.

## Remaining blockers before controlled production-like testing

1. Approve a stable domain, named tunnel, Access/device-auth strategy, credential provisioning, and private API deployment separately. Android has no Access service-token support yet. Verify TLS and hostname behavior from the physical phone.
2. Align Cloudflare's 125 s default proxy read timeout, sequential model calls, Android's 180 s call timeout, and 120 s orphan recovery. Measure observed latency and define a bounded protocol that never invents SAFE.
3. Wire consent revocation to a durable backend self-revocation request only after endpoint/auth provisioning is approved. Offline revocations must remain pending without sending SMS; define what happens if the Mac is offline beyond cache TTL.
4. Decide whether numeric sender masking can be enabled without reducing detection accuracy; exact sender and received time are still transmitted by the current unwired production transport. Approve cloud/proxy/backup and local Room retention.
5. Run the compiled instrumentation tests on the Xiaomi; add a real process-death and notification reconciliation test. Fix any failures before contemplating worker wiring.
6. Approve production schema application to a dedicated controlled database. The main database and approved RAG knowledge were not changed here.
7. Keep PRODUCTION_READY false and the receiver disconnected until a separate security, privacy, availability, and product activation decision.
