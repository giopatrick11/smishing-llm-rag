# Phase 3S: Stable hosting and synthetic integration

Prepared 2026-10-28. **No named tunnel, DNS route, Access application, or public production listener was activated. No real SMS was sent.** Android `RemoteTransportGate.PRODUCTION_READY` is still `false`. The Mac remains the intended Gemma 3 12B + RAG host.

## File inventory

| File | Phase 3S change |
| --- | --- |
| `deploy/cloudflare/production-tunnel.example.yml` | Inactive named-tunnel ingress template: one stable hostname to localhost port 3020 and a 404 catch-all. It contains no real tunnel ID, domain, or credential. |
| `scripts/phase3s-live-synthetic-verify.sh` | Explicitly opted-in, one-message localhost integration runner. Creates and destroys a private PostgreSQL 17 cluster, applies migrations there, starts the real production listener, and keeps the Mac awake during one synthetic Gemma + RAG request. |
| `src/staging/liveSyntheticCheck.js` | Copies the 100 active approved RAG records with a read-only transaction into the disposable cluster, enrolls one disposable installation, validates the real response, and checks identical encrypted-cache replay. Rejects nonisolated target URLs. Does not print SMS, tokens, RAG text, or rationale. |
| `test/phase3sSafety.test.js` | Guards against accidentally targeting the main or a remote database with the disposable live fixture. |
| `src/production/createProductionApp.js` | Releases the inference slot before returning a completed response, then rechecks active credential and deadline. This prevents a new sequential request from seeing a stale busy slot. No classifier behavior changed. |
| `test/phase3nProductionApi.test.js`, `test/phase3oStaging.test.js` | Added a delayed-slot-release regression test and clearer staging HTTP status assertion for a sequential-request failure seen during this phase. |
| `PHASE3S_STABLE_HOSTING_AND_INTEGRATION.md` | This review and handoff. |

Existing Android code, backend classification code, rules, prompts, RAG rows, retention configuration, evaluation artifacts, and Phase 3O–3R changes were preserved. The source RAG database was queried only; the 100 records were copied into temporary storage and deleted on exit. The ordinary Phase 3O staging harness remains independent and uses a fake analyzer for contract tests.

## Hosting configuration and requirements

The template is for a **locally managed named Cloudflare Tunnel**, with a stable subdomain on a team-controlled domain in Cloudflare. It routes only `sms.example.com` (a placeholder) to the Mac's `127.0.0.1:3020`; the final rule returns 404 for every other hostname. The production listener itself requires explicit `APCIDA_PRODUCTION_ENABLED=true`, `APCIDA_PRODUCTION_MODE=controlled-test`, and `APCIDA_PRODUCTION_BIND=127.0.0.1`. Ollama and PostgreSQL must also remain localhost-only, and no ingress rule may point to their ports. Tunnel origin traffic is HTTP over loopback; the phone-facing connection would be HTTPS with ordinary Android certificate verification. The Android client requires an exact separately approved hostname, rejects the temporary `trycloudflare.com` hostname, and follows no redirects.

**Approval sequence, not executed here:** obtain/control a domain in Cloudflare; review Access policy and Android service authentication; provision a dedicated production database and per-install credentials; complete privacy and physical-device reviews; then create a named tunnel and DNS route. [Cloudflare's named tunnel setup](https://developers.cloudflare.com/tunnel/get-started/) requires a domain on Cloudflare for a published application. Tunnel is [available on all plans](https://developers.cloudflare.com/tunnel/); domain registration/renewal has a separate, variable cost. Check the current [Cloudflare plans](https://www.cloudflare.com/plans/) and [registrar pricing](https://pricing.registrar.cloudflare.com/) before purchase. A stable hostname does not keep a sleeping or offline Mac available.

After separate deployment approval, an operator can use these **manual** commands, replacing placeholders and keeping the real credential file outside Git:

```bash
# Cloudflare account login and tunnel creation are interactive administrator actions.
cloudflared tunnel login
cloudflared tunnel create apcida-production
# Complete the Access/device-auth review before this public DNS step.
cloudflared tunnel route dns apcida-production sms.YOUR_DOMAIN
# Copy the example YAML to a private location and replace tunnel UUID,
# credentials-file absolute path, and the approved hostname.
chmod 600 /PRIVATE/PATH/production-tunnel.yml
cloudflared tunnel --config /PRIVATE/PATH/production-tunnel.yml ingress validate
cloudflared tunnel --config /PRIVATE/PATH/production-tunnel.yml ingress rule https://sms.YOUR_DOMAIN/health
cloudflared tunnel --config /PRIVATE/PATH/production-tunnel.yml run
```

The example was validated locally with `cloudflared tunnel --config deploy/cloudflare/production-tunnel.example.yml ingress validate` (OK). No tunnel was run. Start PostgreSQL and Ollama on loopback first. After a separate production-database migration and deployment approval, an operator can load a private environment file **outside Git** and start the listener in a foreground terminal:

```bash
cd /Users/giopatrick/smishing-llm-rag/apcida-ai-server
set -a; . /PRIVATE/PATH/apcida-production.env; set +a
node src/production/server.js
# In another terminal while the listener stays running:
lsof -nP -iTCP:3020 -sTCP:LISTEN
curl --fail --silent http://127.0.0.1:3020/health
```

The private file must supply the separately approved local `DATABASE_URL`, `PRODUCTION_DATA_KEY`, `APCIDA_PRODUCTION_ENABLED=true`, `APCIDA_PRODUCTION_MODE=controlled-test`, `APCIDA_PRODUCTION_BIND=127.0.0.1`, `RAG_ENABLED=true`, `RULES_ENABLED=true`, `RULES_SHADOW_MODE=true`, `VERDICT_POLICY=gemma`, and the frozen Gemma/Ollama settings. The generic config loader **still requires `API_KEY`**, although this production route uses installation bearers instead; remove that unused development-key dependency in a separately reviewed deployment change. Do not reuse the development `.env` as a production secret file.

Verify `lsof` shows only `127.0.0.1` for port 3020 and Ollama/PostgreSQL on loopback before starting `cloudflared`. After approved activation, verify the HTTPS certificate and exact hostname from a phone, a missing installation bearer receives 401, invalid/revoked bearers cannot analyze, and Access denies unauthorized devices. Stop the tunnel with `Ctrl-C` if foreground-run; stop the production listener separately with `Ctrl-C`/SIGTERM. For managed restart at boot, follow Cloudflare's [macOS service guide](https://developers.cloudflare.com/tunnel/features/locally-managed-tunnels/as-a-service/macos/) only after defining startup order, private secret storage, and restart checks. Check tunnel status in the dashboard; a [502 usually means origin reachability](https://developers.cloudflare.com/tunnel/troubleshooting/), while [524 means the origin exceeded the proxy read window](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-524/). No service was installed or changed in this phase.

**Access blocker:** Cloudflare Access Service Auth supports noninteractive requests using a Client ID and Secret in headers ([official service-token documentation](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)). The current Android `ProductionSmsTransport` sends only the backend's per-install bearer and cannot pass Access Service Auth. A shared Access token in the APK would violate the design. Before publishing this hostname, implement and verify an approved per-install Access credential or another noninteractive device identity mechanism, provision it outside the APK into platform-protected storage, and coordinate its expiry/revocation with backend credentials. Browser-based Access login per SMS is unsuitable for unattended WorkManager requests. An Access-protected route would currently reject Android requests even though the backend bearer is valid. No Access bypass was configured.

## Production-like synthetic integration

The local production listener was off before and after the test. The single-run command was:

```bash
cd /Users/giopatrick/smishing-llm-rag/apcida-ai-server
APCIDA_PHASE3S_LIVE_SYNTHETIC=true caffeinate -i bash scripts/phase3s-live-synthetic-verify.sh
```

The script uses PostgreSQL 17 binaries, a disposable cluster on `127.0.0.1:55435`, database name `apcida` **inside that cluster**, migration 001–004, and a temporary encrypted-cache key/installation credential. It copies 100 active approved knowledge records from the main database using a read-only transaction and never migrates the main database. It starts the actual `src/production/server.js` on `127.0.0.1:3020`, using the real production route, authentication, durable repository, embedding, RAG retrieval, Gemma 3 12B, and shadow-rule Gemma verdict. One synthetic message about a fraudulent bank OTP request returned **HTTP 200, SCAM, HIGH** with a schema-valid nonempty rationale in **79,996 ms**. The same message ID and payload returned **HTTP 200 with an identical cached response**; the whole check reached replay at **80,440 ms**. No concurrent inference or public proxy was involved. The live run preceded the slot-release patch; that patch was subsequently verified by backend and disposable staging tests. This confirms local live Gemma + RAG for one synthetic request; it is not a throughput, accuracy, Cloudflare, or phone test.

The first disposable attempt selected PostgreSQL 14 from the shell PATH and failed the existing PostgreSQL 17 guard before inference. The runner now explicitly selects PostgreSQL 17; the successful run above followed. Temporary databases and credentials were removed by the cleanup trap. The script requires a free localhost port 3020 and 55435 and explicitly opts in, so it cannot silently start a listener during ordinary tests.

## Android/backend contract and security review

- Android sends `POST /api/v1/sms/analyze`, an installation bearer, matching `Idempotency-Key`/UUID `messageId`, `sender`, `text`, and ISO `receivedAt`. It does not send the synthetic pilot header. The backend validates the same strict fields and returns `messageId`, `classification` (`SCAM`, `SAFE`, `SUSPICIOUS`), `confidence` (`HIGH`, `MEDIUM`, `LOW`), and a short rationale. The existing Android staging contract test exercises the actual route with a mock responder; the live local test exercises the real responder from Node.
- Android default transport retains platform TLS certificate verification, exact approved-host validation, HTTPS-only origin, and redirects disabled. Its unit tests reject HTTP, a host mismatch, and `trycloudflare.com`. These properties were code/test-verified, **not measured over Cloudflare or on a phone**.
- The live receiver runs local keyword detection immediately. Historical imports and duplicates are excluded before remote work; WorkManager stores only a Room ID and uses unique per-message jobs. The worker, coordinator, and transport recheck consent/generation/security gate. `PRODUCTION_READY=false` prevents all automatic real-SMS transmission. A failed remote attempt keeps a local warning or `UNVERIFIED`; zero keyword matches do not become SAFE.
- Backend enrollment remains administrator-approved, per-install tokens are hashed, expired/revoked credentials fail authentication, durable rate counters and a single inference slot bound abuse, and an encrypted response cache supports idempotent replay. The test copied approved RAG rows but made no change to their source. Cache retention remains 1–72 hours (24 default), with startup/hourly purge. Self-revocation requires a currently valid token and transactionally deletes that installation's cache; Android marks deletion confirmed only on authenticated 204. Offline/401/403 leaves a visible pending deletion and quarantines rejected inference credentials. Backup and proxy-log deletion are not covered by this API.
- Sender minimization remains **unwired**. The current inactive transport would send sender and received time. Numeric-sender masking may affect Gemma context and idempotency HMAC, so it requires a reviewed, stable representation before rollout. Research contribution consent remains separate from routine inference.
- The backend audit records event and installation ID, not raw SMS/token/rationale. This phase did not verify external Cloudflare logs, database backups, Android crash analytics, or device storage retention. Proxy/CDN logging and backup retention must be approved before real traffic.

## Timeout and recovery assessment

| Component | Current bound | Observed/implication |
| --- | --- | --- |
| Node production request | 90 s wall-clock analysis deadline | The synthetic Gemma + RAG result used about 80 s, leaving about 10 s local margin; cold loads and contention may exceed it. Deadline/abort returns an error, never SAFE. |
| Ollama embedding and Gemma chat | Existing 120 s each, but share Node's earlier abort | The 90 s signal caps their combined production operation. PostgreSQL retrieval has a 10 s statement timeout. |
| Android OkHttp | 10 s connect, 110 s read, 115 s total | Authentication/proxy delay can use the 25 s margin after the Node deadline. 504 becomes TIMEOUT; 524/offline becomes unavailable. |
| Cloudflare proxied origin | [125 s default read timeout](https://developers.cloudflare.com/fundamentals/reference/connection-limits/) | 35 s above Node's nominal deadline; actual Access/tunnel/plan behavior remains untested. |
| Android stale work fallback | 150 s | Work expiry conditionally marks only pending local rows unavailable; it cannot overwrite a completed remote verdict. |
| Backend lease | 300 s crash recovery | An explicit duplicate during inference returns in-progress; after completion it replays. Crash before cache commit can require a repeated inference after lease recovery. |

The request path has no automatic SMS retry. Node cancels the inference signal on deadline or client disconnect and retains its busy slot until an uncooperative analyzer settles. A staging run's next sequential message received an error response with no classification; its exact HTTP status was not captured. Code review found a compatible race: a just-completed response could reach the client before Node released its inference slot, so the next message could briefly receive `INFERENCE_BUSY`. The API now awaits slot cleanup before exposing success, with a regression test that delays release. It repeats the active-credential and deadline checks after cleanup. Room completion is conditional on generation/state; the expiry worker cannot turn a successful verdict into a later fallback. A crash between Room commit and notification delivery may leave a stale notification until a future reconciliation path; this remains a device review item. Likewise, an inference that completed just before a proxy/network failure may have a cached backend verdict while Android shows `UNVERIFIED` or a local warning; an explicit later retry could replay it, but current automatic processing intentionally does not retry. The 80 s sample is too close to 90 s to claim reliability under load. Measure repeated synthetic cold/warm latency through an approved stable route before changing the protocol; an asynchronous bounded job/poll design may be needed. Do not simply increase every timeout.

## Automated verification

The staging harness is fake-model contract coverage; only the one-message live check above reached Ollama/RAG. The first isolated staging attempt failed on an immediate sequential SAFE request (the response lacked `classification`); a rerun passed, and the delayed-release regression now covers the code-level slot-cleanup race. Its failure was not counted as a passed check.

| Verification | Result |
| --- | --- |
| Backend `npm test` after final patch | **115 total, 113 passed, 0 failed, 2 environment-gated skips**. Includes the new isolation and delayed-slot-release tests. |
| Isolated Phase 3O staging after final patch | **2/2 backend API**, **1/1 PostgreSQL repository**, **5/5 Android production-contract JVM tests** passed against disposable localhost services. |
| Android full JVM suite | **124 total, 119 passed, 0 failed, 5 staging-only skips** outside the isolated staging harness. Those five passed in the separate harness above. |
| Android builds | Debug APK built, instrumentation APK built, release Kotlin compiled; Gradle `BUILD SUCCESSFUL`. |
| Named-tunnel template | `cloudflared tunnel ingress validate`: **OK**; no tunnel or route activated. |
| Live synthetic Gemma + RAG | One authenticated production-contract request and identical replay passed locally; **79,996 ms** for first response. |
| Physical Android instrumentation | **Not run**; no device was connected. |

Commands executed:

```bash
cd /Users/giopatrick/smishing-llm-rag/apcida-ai-server
npm test
bash scripts/phase3o-staging-verify.sh

cd /Users/giopatrick/Documents/apcida/Mobile_App
./gradlew :app:testDebugUnitTest :app:assembleDebug :app:assembleDebugAndroidTest :app:compileReleaseKotlin --offline --console=plain
```

No physical Android device was connected here. Compiling the instrumentation APK is **not** executing instrumentation tests. Local APK outputs are `app/build/outputs/apk/debug/app-debug.apk` and `app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk`.

## Later Windows physical-device checks

On the teammate's Windows machine with a working JDK/SDK and a connected test phone:

```powershell
cd C:\path\to\Mobile_App
adb devices -l
.\gradlew.bat :app:testDebugUnitTest :app:assembleDebug :app:assembleDebugAndroidTest --console=plain
.\gradlew.bat :app:installDebug --console=plain
.\gradlew.bat :app:connectedDebugAndroidTest --console=plain
```

Confirm ADB reports `device`; inspect `app\build\reports\androidTests\connected\index.html` for actual pass/fail/skip counts. Enable Android notification permission/channel and ApCiDa scam alerts for the synthetic notification test. Verify synthetic duplicate intake, zero-rule `UNVERIFIED`, local warning, historical exclusion, Room claim/completion, offline expiry, consent revocation during a pending mock request, process-kill/relaunch recovery, and same-ID notification updates. The current compiled tests do not prove these behaviors on hardware. Keep the production gate closed and do not send real SMS or use a real production credential for device checks.

## Blockers before controlled real-SMS activation

1. Approve a domain, a named tunnel, Access/device-auth design compatible with unattended Android, and a protected endpoint. No shared Access token or administrator secret may be embedded in the APK.
2. Approve and deploy a dedicated production database/schema, secure per-install credential provisioning/rotation/revocation, and a managed Mac startup/sleep/recovery plan. The localhost controlled-test listener is not a production deployment.
3. Measure repeated Gemma + RAG latency through a protected stable route; define behavior for 90 s deadline misses, Cloudflare 524, cache/replay after failures, and Mac outage. One 80 s sample is insufficient for an availability claim.
4. Approve sender/time minimization, local Room retention, Cloudflare/proxy audit and backup retention, and deletion procedures for lost/expired credentials. Run a privacy and consent review.
5. Execute and resolve physical Android instrumentation, notification, network, TLS, credential, revocation, and process-death tests. No device was present on this Mac.
6. Make a separate explicit activation decision before setting `PRODUCTION_READY=true` or transmitting any real SMS.
