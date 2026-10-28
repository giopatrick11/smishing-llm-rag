# Phase 3Q: Remote AI reliability and consent revocation

Status: synthetic preparation only, 2026-10-28. The production listener was not deployed, the main database was not migrated, and no real SMS was sent. Android `RemoteTransportGate.PRODUCTION_READY` remains `false`; the live receiver does not construct `ProductionSmsTransport` or `AutomaticRemoteCoordinator`.

## Changed files

Backend:

- `src/production/deadline.js`, `src/production/createProductionApp.js`, `src/production/server.js`: one production analysis deadline, abort propagation, fail-closed 504, and no cached result from an inference that settles after the deadline. An additional installation-status check after response completion suppresses a verdict if revocation raced with that database write. A timed-out inference retains the single-process busy guard and database slot until it settles; an uncooperative task therefore blocks further inference rather than overlapping it.
- `src/services/embeddings.js`, `src/services/rag.js`, `src/services/ollama.js`, `src/services/hybrid.js`: pass the optional cancellation signal through sequential embedding, retrieval, Gemma, and hybrid composition. Prompts, rules, weights, RAG records, and verdict policy are unchanged.
- `src/staging/localServer.js`, `scripts/phase3o-staging-verify.sh`: add a separate short-lived synthetic credential for Android deletion-contract tests.
- `test/phase3nProductionApi.test.js`, `test/phase3mProductionContract.test.js`: deadlines, client disconnect, abort propagation, late SAFE suppression, and sender contract/HMAC checks.

Android:

- `ProductionTiming.kt`, `ProductionSmsTransport.kt`, `SmsProcessingWorker.kt`: 10-second connect, 110-second read, 115-second total call; 150-second stale remote claim recovery. The production transport remains unwired. Coroutine cancellation is rethrown rather than presented as a classification failure.
- `AiProtectionConsentStore.kt`, `ProductionCredentialStore.kt`, `ProductionRevocationClient.kt`, `ProductionRevocationRetryPolicy.kt`, `ProductionRevocationWorker.kt`: durable local opt-out and deletion marker, encrypted credential retained for bodyless deletion, exact-host HTTPS request, and a bounded deletion-only retry path. Local opt-out still commits if credential lookup fails. A 401/403 quarantines the credential for inference in persistent preferences and immediately in memory; the store refuses reenrollment while that credential remains, including reuse of the same token. It retains the encrypted token only for an authenticated deletion attempt. Backend 401/403 is never treated as deletion confirmation. A pending deletion blocks the credential from future inference, including after regrant.
- `ProductionHttpCall.kt`: the inference and deletion clients now cancel their OkHttp calls when their coroutine is canceled. A canceled response is closed without becoming a verdict or a confirmed deletion.
- `SettingsFragment.kt`, `MainActivity.kt`, `app/build.gradle.kts`: visible deletion status/manual retry, resume pending deletion work at launch, and a separately configurable exact approved production hostname. `apcida.productionApprovedHost` is blank by default; no production host or secret is embedded.
- `ProductionHttpCallTest.kt`, `ProductionRevocationClientTest.kt`, `ProductionSmsTransportTest.kt`, `ProductionStagingContractTest.kt`, `ProductionCredentialStoreInstrumentedTest.kt`, `ProductionConsentRevocationInstrumentedTest.kt`: synthetic cancellation, deletion, 524/offline handling, backend token invalidation, no reuse after 401, encrypted credential quarantine across store recreation, and persistent opt-out coverage. The instrumentation tests were compiled, not run on a phone here.

## Timeout strategy

| Layer | Limit / behavior |
| --- | --- |
| Android production inference | 10 s connection, 110 s read, 115 s whole call. HTTP 504 is TIMEOUT; Cloudflare 524 and connectivity failures remain unavailable. Neither yields SAFE. |
| Cloudflare default proxied origin read | Cloudflare currently documents 125 s (and a 30 s proxy write timeout). An infrastructure review must verify the actual plan and route before deployment. See [Cloudflare 524](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-524/) and [connection limits](https://developers.cloudflare.com/fundamentals/reference/connection-limits/). |
| Node production analysis | 90 s default, configurable with `APCIDA_PRODUCTION_DEADLINE_MS` in controlled tests only (1000–100000 ms). Starts after strict request validation and covers rate/claim work plus sequential embedding, retrieval, and Gemma. Node's request/header socket timeouts do not bound inference; this explicit deadline does. |
| Retrieval and model | PostgreSQL statement timeout is 10 s. Existing Ollama embed and chat calls each retain their 120 s per-call limit, but the shared 90 s signal can abort either sooner. No prompt or model changes. |
| Android recovery / backend leases | Android stale remote claim: 150 s. Backend claim and global inference lease: 300 s for process crash recovery. A client timeout is not an automatic SMS retry. |
| Remote deletion | Separate 10/15/20 s connection/read/call limits; WorkManager requires network and retries at most three attempts with exponential backoff, then shows `RETRY_PAUSED`. The request contains no SMS or message ID. |

The 90/115/125-second spacing leaves a 25-second Android margin and a 35-second Cloudflare margin for ordinary transport delay. It is a design target, not a service guarantee. Slow proxy auth, database operations, Mac sleep, Ollama stalls, and process death can still make analysis unavailable. On deadline or disconnect the server cancels its fetch signal, returns an error when possible, and does not fabricate SAFE. An inference implementation that ignores cancellation may keep the single inference slot occupied until it settles or the listener restarts. Device cancellation cannot recall content already received by the server.

## Revocation behavior

Settings commits consent **off** and a deletion-pending marker in one local preference write before any network action. It cancels tagged automatic remote work and reconciles pending Room results. Local keyword detection remains available. If a production credential exists, the deletion-only worker sends `DELETE /api/v1/installations/me` to a configured exact approved HTTPS host, using the encrypted per-install token. This backend route authenticates only active, unexpired credentials, then transactionally revokes the credential and deletes its production response cache and rate windows; only 204 clears the local credential and marker. It never sends an SMS body. A 401/403, missing credential, offline network, 524, or absent approved host leaves the marker visible and unconfirmed. A failed network request can be manually retried; startup re-enqueues eligible pending work. Credentials are unavailable to inference while deletion remains pending. A prior 401/403 from inference quarantines the credential and blocks another analysis or reenrollment. It does **not** authorize deletion: only a separately authenticated backend 204 does. No production host is configured in this build, so no external deletion request can occur.

Limitations: a local revocation cannot guarantee deletion while the backend is unreachable. If the token is already expired, revoked, lost, or rejected by an upstream access proxy, self-revocation may be impossible; an administrator must identify the installation and delete its cache. A 204 confirms deletion of the live database rows, not backups or external logs. Regranting consent does not resolve an existing deletion marker or silently reenroll an installation. Coroutine cancellation now cancels an active OkHttp call, but a request already received by the server cannot be recalled. A race between local revocation and an already-started send is handled by conditional Room completion and backend self-revocation, but still needs physical-device verification. Live transport remains disconnected.

## Sender minimization review

The Phase 3P `ProductionSenderMinimization` helper remains unwired. A synthetic numeric sender becomes `PHONE_NUMBER`, which satisfies the production schema's sender length/type requirements; short codes and alphanumeric sender claims remain intact. The request HMAC changes if masking is applied to a retry with the same message ID, producing an intentional `MESSAGE_ID_CONFLICT`. Any future rollout must choose the sender representation before the first request and keep it stable for idempotent retries. Gemma receives sender as prompt context; this phase did **not** run paired model evaluations, so classification impact is unknown. Exact sender transmission remains in the current, inactive production transport.

## Verification

- Backend `npm test`: 113 tests, 111 passed, 0 failed, 2 environment-gated PostgreSQL/staging tests skipped in the default run. Tests use synthetic fixtures and mocked Gemma/embedding.
- Isolated Phase 3O staging harness: backend staging 2/2, temporary PostgreSQL repository 1/1, Android production route contract 5/5 passed. It used an ephemeral staging database and synthetic responses, not Ollama or the approved RAG database.
- Android `./gradlew testDebugUnitTest assembleDebug assembleDebugAndroidTest compileReleaseKotlin --offline`: 120 JVM tests discovered, 115 passed, 0 failed, 5 staging-only tests skipped outside their harness. Debug app and instrumentation APKs built; release Kotlin compiled. No physical instrumentation was run here. The first version of the new cancellation test blocked its own coroutine in `runBlocking`; moving that child to `Dispatchers.IO` fixed the test setup and the rerun passed.

Backend tests cover encrypted duplicate replay after app/listener recreation and stale lease recovery. The Android consent and Keystore instrumentation tests check store recreation, but were only compiled; they do not prove behavior after a real Android process kill. Room orphan recovery, notification persistence, and revocation while a socket is active still require a connected device.

The continuation's Android file edits are local working-tree changes on top of the previously pushed Phase 3Q baseline. They were not committed or pushed here. The backend working tree also contains earlier uncommitted Phase 3N–3P files; none were reset or overwritten. A Windows teammate needs the continuation changes before running its new tests.

## Physical-device steps for Windows teammate

From `Mobile_App` in PowerShell, with an appropriate Java/Android SDK setup:

```powershell
adb devices -l
.\gradlew.bat :app:testDebugUnitTest :app:assembleDebug :app:assembleDebugAndroidTest --console=plain
.\gradlew.bat :app:connectedDebugAndroidTest --console=plain
```

Inspect `app\build\reports\androidTests\connected\index.html` for actual pass/skip counts. Grant the debug app notification permission and enable in-app alerts to execute `SyntheticNotificationInstrumentedTest`; its assumptions otherwise skip it. Install only the debug APK at `app\build\outputs\apk\debug\app-debug.apk`. In Settings, check AI Protection is off by default, grant/revoke consent and restart the app to verify persistence. The new revocation instrumentation test uses isolated synthetic preferences and no server; a production credential/deletion request cannot be validated until a separately approved staging HTTPS setup exists. At that later stage, `local.properties` may contain `apcida.productionApprovedHost=<exact approved host>`; keep tokens out of that file and the APK. Do not put a production credential into this build or send a real SMS. The synthetic pilot screen remains separate.

## Before activation

Approve and provision a stable authenticated HTTPS host; decide Cloudflare Access/device credential provisioning and rotation; exercise the deletion route and proxy timeout with a real device against an isolated HTTPS staging environment; resolve admin deletion for lost/expired tokens; review backend/Cloudflare/backup retention and audit logs; confirm Mac availability; run physical instrumentation and process-death/notification checks; review cancellation of in-flight Android calls; and explicitly review receiver wiring. Keep `PRODUCTION_READY=false` and the production listener undeployed until these gates are satisfied.
