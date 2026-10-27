# Phase 3F: Secure remote AI infrastructure and authentication

**Status:** design and offline security preparation only. No tunnel, proxy, gateway listener, enrollment route, production credential, or automatic real-SMS request has been enabled. The Phase 3E Android `RemoteTransportGate.PRODUCTION_READY` remains `false`; the existing HTTP LAN page and `x-api-key` remain synthetic/manual development tools only. `src/production/security.js` is not imported by `src/app.js` or `src/server.js`.

## Existing architecture and reusable components

- Android consent is versioned, default-off, and revocable in `AiProtectionConsentStore`; `AutomaticAnalysisPolicy` excludes pre-consent and historical messages. `SmsProcessingWorker` has a unique work name and a disabled production path. Room stores the message, sender, receipt time, local evidence, and opaque request ID. The release manifest forbids cleartext and backup. `ProductionEndpointPolicy` and `RemoteTransportGate` now express the stricter future gate.
- `ManualAiClient` exists only in the debug source set. It accepts private LAN HTTP and an entered shared key for synthetic SMS. It must never become the production client.
- Express `POST /api/sms/analyze` currently validates exactly `messageId`, `sender`, `text`, and `receivedAt`, accepts `x-api-key`, and rate limits by IP. Express and Ollama bind to loopback in normal startup. The separate LAN launcher binds a selected private IPv4 and serves a manual test page. RAG uses approved `rag_knowledge` and keeps failures distinct from SAFE. No routine inference result is written to PostgreSQL by the current controller.
- Existing client-side OkHttp/Retrofit, WorkManager, Room, and server-side Express can be reused. The existing shared API key must remain an **internal gateway-to-loopback secret** in a future production design, never a credential distributed to Android.

## HTTPS connectivity options

| Option | Reachability and certificate | Operational/privacy tradeoff |
| --- | --- | --- |
| **Private pilot: Tailscale Serve** | Stable MagicDNS `*.ts.net` hostname, publicly trusted HTTPS certificate, access restricted to the tailnet. No Mac LAN IP or router port forwarding. | Simplest for a few approved devices; each Android tester needs tailnet access and a functioning VPN. Mac sleep/offline still stops inference. Do not use Tailscale Funnel. |
| Cloudflare Tunnel with Access or an application gateway | Stable public DNS and HTTPS; `cloudflared` makes outbound connections, so no home-router inbound port is needed. | A public hostname is reachable at Cloudflare's edge and must be protected before forwarding. Cloudflare can process decrypted SMS traffic; privacy terms and logging settings need review. Do not embed one Cloudflare service token in every APK. |
| Public reverse proxy, such as Caddy | Public DNS and ACME certificates; Caddy proxies only to loopback Express. | Requires inbound 80/443 or DNS challenge, DNS/IP management, firewall and patching. A dynamic home IP needs DNS updates. More attack surface on a personal Mac. |
| Managed deployment | Stable HTTPS and always-on service with separate private model/database network. | Best eventual availability and operations, but requires hosting sized for Gemma 3 12B, cost review, provider data-processing terms, and a migration plan. |

**Recommendation:** For a controlled developer pilot, use Tailscale Serve with the Mac's stable tailnet FQDN and a valid HTTPS certificate, *after* per-install authentication is ready. Keep Express, Ollama, and PostgreSQL on loopback; expose only a narrowly scoped gateway path to tailnet members. The tailnet is a network boundary, not the app's installation identity. Android must verify the certificate and exact approved hostname. Tailscale Serve is private to the tailnet and can proxy a local port; its HTTPS name avoids changing LAN IPs. This is a development recommendation, not approval to run Serve or transmit real SMS. For a broader release, move to managed infrastructure rather than depending on a sleeping Mac.

Sources: [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve), [Tailscale HTTPS certificates](https://tailscale.com/docs/how-to/set-up-https-certificates), [Cloudflare Tunnel](https://developers.cloudflare.com/tunnel/concepts/), [Caddy automatic HTTPS](https://caddyserver.com/docs/automatic-https).

## Per-install authentication design

1. **Controlled enrollment:** For the pilot, an administrator authorizes each installation out of band and issues one 256-bit random bearer credential per installation. No anonymous public self-enrollment. A future public enrollment flow needs single-use short-lived invitations, an account/eligibility check, enrollment quotas, and abuse review. Play Integrity may add evidence about the app/device but is not a substitute for an authorization decision.
2. **Credential handling:** Send the token once over verified HTTPS after enrollment. Android stores it only in app-private encrypted storage protected by an Android Keystore key. Do not place it in `BuildConfig`, resources, logs, URLs, Android backup, or the research-contribution client. Rotate/re-enroll after loss or compromise. The server stores only SHA-256(token), installation ID, issue/expiry/revocation times, and quota metadata in a separate auth store; it never stores the plaintext token.
3. **Request authentication:** The future gateway accepts `Authorization: Bearer <installation token>`, checks the hash and revocation/expiry, and rejects missing/invalid/revoked tokens with the same 401 body. Auth-store failure is 503 and remains an unavailable state in Android. The gateway discards any client-supplied internal `x-api-key`, then uses its own server-side key to call loopback Express. No raw SMS, sender, token, rationale, or full URL in auth logs.
4. **Abuse controls:** Apply a small pre-auth IP budget plus per-install request and concurrent-inference limits. Use 429 with `Retry-After`; never classify 401/429/503/504 as SAFE. A stolen token can still be used until revoked. Keep a revocation control and a way to identify the install without a phone number. The in-memory limiter in `src/production/security.js` is test preparation; production needs a shared bounded store before multiple gateway processes are used.
5. **Idempotency:** Use the existing opaque UUID `messageId` scoped to the authenticated installation. A later gateway should keep short-lived status/result metadata for duplicate requests, with no SMS body in that store. This and revocation must be tested under process death and concurrent requests.

The new backend auth and origin modules are **not mounted** and have no enrollment or database schema yet. They cannot authorize live traffic by themselves. Android also has no production credential store or remote client yet.

Sources: [Android Keystore](https://developer.android.com/privacy-and-security/keystore), [Android network security configuration](https://developer.android.com/privacy-and-security/security-config), [Play Integrity standard requests](https://developer.android.com/google/play/integrity/standard).

## Android security gate before automatic SMS analysis

All of these must hold for the same message at the moment of transmission:

1. Current explicit AI Protection consent and matching consent generation; receipt after grant; not an inbox-history import.
2. Endpoint is `https://` with the exact separately approved DNS hostname, a valid platform-trusted certificate and hostname verification. No IP literals, userinfo, URL secrets, paths or redirects to a different origin. Pinning, if later adopted, needs a backup key and rotation plan.
3. A current, per-install credential is present in Keystore-protected storage and has been accepted by the server; the shared development key is absent from production builds.
4. WorkManager has a network constraint, bounded retry/age limits, cancellation on revocation, and a final consent recheck immediately before a request and before applying a response. Never put SMS text or a credential in WorkManager input.
5. Auth, DNS, TLS, timeout, model, embedding, and database failures produce **REMOTE_UNAVAILABLE** with local keyword-only status; a low local score remains **UNVERIFIED**. Error messages and logs exclude SMS, sender and credentials.
6. The security review and physical-device tests pass, then an explicit release flag can be changed. A valid URL or an enabled Settings switch alone is insufficient.

The present gate remains closed even if a valid URL is supplied. Android's normal release config rejects cleartext. The debug manual client remains isolated for synthetic tests. [Android WorkManager constraints](https://developer.android.com/develop/background-work/background-tasks/persistent/getting-started/define-work) can defer network work; they do not guarantee that a sleeping Mac will answer.

## Data minimization and retention proposal

| Data | Current handling | Proposal before real-SMS rollout |
| --- | --- | --- |
| SMS body | Full text in Android Room; sent to Ollama only for an explicit API call. No routine inference insert into `rag_knowledge`. | Keep on device for a disclosed period (proposed default 30 days, user deletion at any time); transient in gateway/Ollama memory only; never persist in auth, gateway logs, analytics, or RAG. Confirm product retention preference before deleting existing rows. |
| Sender | Full address in Android Room; backend API requires `sender` and includes it in the model request. | Evaluate sending a minimized sender label or category for numeric addresses; preserve branded sender evidence only as needed. This affects model inputs and requires separate validation before changing the contract. |
| Receipt time | Millisecond local value; ISO timestamp required by API. | Send no finer than needed for analysis (candidate: minute precision), subject to validation. Do not use it for identity or long-term tracking. |
| Request ID | Random UUID stored with Android message. | Scope idempotency by install ID; retain metadata up to 24 hours, then delete. Do not encode phone number or timestamp in the ID. |
| Auth metadata | Only shared dev API key exists today. | Store token hash and pseudonymous install ID, issuance/expiry/revocation state, and coarse quota counters; remove revoked/expired records after a defined audit window (proposed 30 days). |
| API/security logs | Current app returns error codes and has no raw-body request logger in `src/app.js`; other infrastructure may log metadata. | Log only allowlisted event code, coarse duration, and aggregate status; no request/response body, sender, token, rationale, query string, or full URL. Proposed security-log retention: 7 days. Review tunnel/provider defaults. |
| Research contribution | Separate user review and upload path. | Keep consent, storage, and retention separate. Never add routine inference SMS to research data or approved RAG knowledge. |

The Android report upload path is separate and still has a compile-time report key. Phase 3F removes its HTTP logging interceptor and exception-message logging, but the key and report service need a separate security review before production distribution. Phase 3F does not repurpose report credentials as AI authentication. The retention durations above are **proposals**, not active deletion jobs.

## Implementation roadmap and verification

1. **Phase 3F (this change):** Pure backend installation-auth, rate-limit and origin checks with tests; Android endpoint and full-readiness gate checks with tests; no live wiring.
2. **Private pilot infrastructure, after approval:** Select a stable tailnet hostname; configure HTTPS and gateway-only access; verify certificate and deny HTTP/unauthenticated requests; keep model/database private. Define who can join the tailnet and who operates the Mac.
3. **Enrollment and client:** Implement admin-approved enrollment, persistent hash/revocation store, Android Keystore-protected credential storage, authenticated OkHttp client, WorkManager constraints and bounded retry, privacy-safe diagnostics, and server-side idempotency. Preserve the existing classifier and RAG behavior.
4. **Go/no-go tests:** Run device tests for no-consent/no-HTTP/no-key/revoked key, timeout/offline, RAG failure, revocation during a call, duplicate broadcasts, process death, notification updates, and migration. Inspect gateway/provider logs. Only then consider changing `PRODUCTION_READY` after explicit approval.

Verification in Phase 3F: backend `npm test` (78 passed); Android `./gradlew testDebugUnitTest assembleDebug compileReleaseKotlin --offline` (95 unit tests passed and both variants compiled); device instrumentation tests remain pending hardware. No full synthetic evaluation, deployment, or real SMS transmission.
