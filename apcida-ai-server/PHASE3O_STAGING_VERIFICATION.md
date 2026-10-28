# Phase 3O: Isolated staging and synthetic contract verification

Verified on 2026-10-28. This phase did not start the real production listener, apply migration 004 to the main ApCiDa database, call Ollama, query or change approved RAG knowledge, expose a Cloudflare route, upload a real SMS, or open the Android production gate. The development and synthetic-pilot listeners remain separate.

## Staging architecture

- scripts/phase3o-staging-verify.sh creates a new PostgreSQL cluster under a private /private/tmp directory, bound to 127.0.0.1:55434. It creates only the apcida_staging database there and applies migration 004_production_inference.sql to that temporary cluster only.
- src/staging/localServer.js requires explicit APCIDA_STAGING_ENABLED=true, loopback binding, and a loopback URL whose database is exactly apcida_staging. It builds the actual Phase 3N production route, repository, authentication, rate counter, idempotency cache, encryption, and inference slot. A test-only synthetic analyzer answers fixtures beginning STAGING SYNTHETIC: SCAM, SAFE, or SUSPICIOUS; TIMEOUT returns OLLAMA_TIMEOUT. It never constructs the Ollama or RAG services. The staging app permits 30 requests per installation per minute to accommodate both suites, with a separate 30-per-minute IP limit.
- The harness enrolls a valid installation and a second installation that it revokes immediately. Their random tokens and the ephemeral HTTP origin go only to private temporary files and test-process environment variables, not console output. On exit, the temporary directory, database, files, and listener are removed. The HTTP origin is loopback-only and must never be used for an Android device or real SMS.
- The Android ProductionStagingContractTest constructs the existing ProductionSmsTransport with a test-only authorization gate and OkHttp interceptor that replaces its approved fake HTTPS origin with the ephemeral loopback origin. The shipped client keeps its HTTPS policy, valid TLS behavior, default closed gate, and production route. There is no staging configuration or credential in the APK.

Run from the backend directory on the Mac with PostgreSQL command-line tools, Node dependencies, Android SDK, and working Gradle/JDK:

~~~bash
bash scripts/phase3o-staging-verify.sh
~~~

The temporary database's local authentication is trust because it contains synthetic fixtures only and is removed immediately. Other local processes could access it during the brief run. It must never be reused for real messages or remote access. Port 55434 must be free.

## Contract results

| Check | Executed result |
| --- | --- |
| Backend staging configuration and authenticated production route | 2/2 backend staging tests passed against temporary PostgreSQL and listener. |
| Android transport against the real staging route | 4/4 JVM contract tests passed: three verdicts and duplicate replay; invalid and revoked credentials; timeout and unavailable server; consent revocation, historical import, HTTP rejection, and closed production gate. |
| Backend route error handling | Missing, invalid, and revoked bearer tokens; changed-content idempotency conflict; malformed JSON; missing SMS text; pilot marker rejection; timeout without SAFE classification passed. |
| Backend full suite | npm test: 105 total, 103 passed, 0 failed, 2 skipped when optional database/staging variables were absent. The staging test ran and passed separately above. |
| Android full JVM suite | testDebugUnitTest: 112 total, 108 passed, 0 failed, 4 skipped when staging listener was absent. Those four passed in the separate staging run. Debug app and instrumentation APK built; release Kotlin compiled. |
| Physical Android instrumentation | Not executed here. No Android device/ADB was available. Compiling the instrumentation APK is not a device pass. |

The staging tests validate the wire contract and durable repository with a synthetic responder. They do not validate live Gemma/RAG output, model latency, TLS certificates on a phone, process death on Android, or real notification display.

## Instrumentation failures and Windows rerun

The earlier Xiaomi 2109119DG Android 14 run reported 13 tests: 10 passed, 2 failed, 1 skipped. The Phase 3L fixes were reviewed and remain in the Android working tree:

- The obsolete offline on-device-Gemma test was replaced by two synthetic offline keyword tests. Zero matches must stay UNVERIFIED; a strong keyword case keeps its local SCAM warning. Neither invokes Gemma or the network.
- ExampleInstrumentedTest now compares with the active BuildConfig.APPLICATION_ID instead of the old template package.
- The notification test remains present. It skipped because at least one notification permission/setting assumption was false; the prior summary did not identify which. Its assumption messages now identify the missing condition. It checks same-ID alert update and cancellation, but still needs execution on a phone.

Use the teammate's working JDK and Android SDK in Windows PowerShell:

~~~powershell
cd C:\path\to\Mobile_App
adb devices -l
.\gradlew.bat :app:testDebugUnitTest :app:assembleDebug :app:assembleDebugAndroidTest --console=plain
.\gradlew.bat :app:installDebug --console=plain
adb shell pm grant com.apcida.smishingdetector.debug android.permission.POST_NOTIFICATIONS
.\gradlew.bat :app:connectedDebugAndroidTest --console=plain
~~~

Confirm the Xiaomi appears as device, grant OS notification permission and enable the app's notification channel, and turn on scam alerts in ApCiDa Settings before the final command. The normal Windows JVM run will show four staging-only tests skipped; their loopback backend harness is run on the Mac. Inspect app\build\reports\androidTests\connected\index.html for device outcomes and any remaining notification assumption. The updated suite should discover 14 device tests, but this count is an expectation, not a pass claim.

## Privacy, reliability, and activation review

The production request still includes full SMS text, raw sender, and exact received time. Phase 3N tables store neither raw text nor sender: they store an HMAC of normalized request fields, an encrypted response cache, opaque installation ID, token hash, and rate counters. Response rationale may contain sensitive information and is encrypted. The production listener logs event code, time, and installation ID, not SMS body or bearer token. Staging audit output is suppressed, and temporary tokens are deleted after the test.

Production cache TTL defaults to 24 hours, configurable 1–72 hours; the production listener purges at startup and hourly, so physical deletion can lag expiry by up to one hour while running or until restart if stopped. Administrator revocation deletes that installation's cached responses and rate windows. Android consent revocation stops future submissions but currently does not notify the backend to purge a previously cached response. Installation identity rows do not expire automatically. PostgreSQL backups, OS logs, tunnel logs, and Ollama memory have separate retention behavior not enforced by this app.

The backend's 300-second claim lease and single durable inference slot survive listener restart; response replay survives restart after commit. A crash between inference and cache commit can repeat inference on a later explicit request. Android Room claims and consent generation prevent duplicate coordinator work, but that coordinator remains disconnected from the live SMS worker. The active worker uses local keyword screening and a closed transport gate. Zero local matches remain UNVERIFIED if remote AI does not complete. Notification updates reuse the message ID, but the Room commit followed by notification posting still has a crash window; reconciliation after process death needs device testing and design review.

Before automatic real SMS analysis: complete physical instrumentation and notification/process-death checks; approve a stable private HTTPS endpoint with certificate and identity validation; approve and migrate a separate production database; provision/rotate/revoke per-install credentials; align Android's 180-second call timeout with possible sequential embedding-plus-chat latency; define sender/time minimization and backup/tunnel/identity retention; add consent-revocation cache deletion policy; and review receiver wiring, crash recovery, and notification reconciliation. Keep RemoteTransportGate.PRODUCTION_READY=false and the live receiver disconnected until those reviews are complete. Do not use the Quick Tunnel or synthetic pilot route for production traffic.
