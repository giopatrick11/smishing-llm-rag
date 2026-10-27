# Phase 3G private pilot (manual synthetic tests only)

## Architecture and current gate

`npm run pilot:start` starts a separate Express listener on **127.0.0.1:3010**. Its only routes are `GET /health` and authenticated `POST /api/sms/analyze`. It reuses the existing Gemma 3 12B + RAG analysis pipeline and refuses to start unless RAG and rules are enabled, rules remain in shadow mode, and the verdict policy is `gemma`. The existing LAN development launcher is unchanged. Ollama and PostgreSQL stay on localhost and are never proxied by this configuration.

The pilot's PostgreSQL table stores a random installation ID, administrator label, SHA-256 hash of a 256-bit random bearer token, issue/expiry times, and revocation time. It stores no SMS. The local administrator CLI is the **only** enrollment path. There is no enrollment HTTP endpoint. A credential is displayed in neither stdout nor logs; enrollment writes it once to a new mode-0600 file. Protected requests have a pre-auth rate limit, a per-install rate limit, an 8 KiB JSON body limit, and one in-flight model request per process. Audit events contain only an event code, time, and installation ID. Rate limits are process-local and reset on restart; this is for a small single-instance pilot, not a managed multi-instance service.

The Android pilot client is available through a separate **debug launcher**. It accepts manually entered text only, requires a synthetic-text confirmation, uses the approved HTTPS host and platform certificate verification, sends the per-install bearer token, and removes a token rejected with HTTP 401. The credential is encrypted with a non-exportable Android Keystore key before local storage. Android backup is disabled. The existing SMS receiver, keyword fallback, consent store, and production transport gate remain unchanged; `RemoteTransportGate.PRODUCTION_READY` stays `false`. The pilot client has no path from incoming SMS, and no real SMS is authorized for this pilot. The synthetic marker and `ManualTest` sender are safeguards against accidental use, **not** proof that text is synthetic.

## Administrator setup on the Mac (manual; do not run until pilot approval)

1. Install and sign in to Tailscale on the Mac and the authorized Android device. In the Tailscale admin console, remove any broad allow-all access that would reach the Mac's pilot service. Grant only approved pilot user/device identities access to the Mac's pilot node on TCP 443. Review existing grants, device sharing, posture, expiry, and device revocation. A representative grant to adapt to your actual tailnet identities is:

   ```json
   {"grants":[{"src":["group:apcida-pilot"],"dst":["tag:apcida-pilot"],"ip":["tcp:443"]}]}
   ```

   Configure ownership/tag assignment and verify the policy in the admin console before serving. The example is **not** an automatically applied ACL. Access to the tailnet and access to the inference API are separate checks.

2. Keep `OLLAMA_URL=http://127.0.0.1:11434` and the local `DATABASE_URL` in a private `.env`. Set a distinct random `API_KEY` for the internal analysis pipeline and a separate random `PILOT_ADMIN_KEY` (at least 32 characters). Never place the admin key, installation token, or SMS content in the APK, command line, Git, URL, or logs. Confirm Gemma 3 12B, `nomic-embed-text`, PostgreSQL, and approved RAG records are available. The migration command below creates the new pilot installation table; it does not seed or alter RAG records:

   ```sh
   cd /Users/giopatrick/smishing-llm-rag/apcida-ai-server
   npm run db:migrate
   RAG_ENABLED=true RULES_ENABLED=true RULES_SHADOW_MODE=true VERDICT_POLICY=gemma npm run pilot:start
   ```

3. In a **second** terminal, confirm the loopback listener and healthy endpoint. On macOS, `lsof` should show Node bound to `127.0.0.1:3010`, never `0.0.0.0:3010`:

   ```sh
   lsof -nP -iTCP:3010 -sTCP:LISTEN
   curl --fail --silent http://127.0.0.1:3010/health
   tailscale status
   tailscale serve status
   tailscale funnel status
   ```

4. Only after ACL review, **manually** activate tailnet-only HTTPS Serve (never Funnel). Tailscale issues and verifies the `*.ts.net` HTTPS certificate for the Serve name. Copy that exact DNS name to the Android debug configuration. Verify another device outside the approved group cannot connect:

   ```sh
   tailscale serve --https=443 3010
   tailscale serve status
   tailscale funnel status
   curl --fail --silent https://YOUR-MAC.YOUR-TAILNET.ts.net/health
   ```

   The command runs in the foreground; keep its terminal open while testing. To stop, press Ctrl-C, check `tailscale serve status`, and if a mapping remains run `tailscale serve --https=443 off`. Do **not** run `tailscale funnel`.

## Enroll and revoke an approved installation

Run the CLI only on the Mac. Enter the admin key through a hidden prompt, matching the private `PILOT_ADMIN_KEY` in `.env`. The token file must be outside Git, inside a private directory, and transferred to the approved device through a trusted channel. Never paste it into a URL or shell argument.

```sh
cd /Users/giopatrick/smishing-llm-rag/apcida-ai-server
mkdir -p -m 700 "$HOME/.apcida-pilot"
read -s 'APCIDA_PILOT_ADMIN_TOKEN?Pilot administrator key: '
export APCIDA_PILOT_ADMIN_TOKEN
printf '\n'
npm run pilot:admin -- enroll --label PilotPhone1 --out "$HOME/.apcida-pilot/pilot-phone1.token" --approve
npm run pilot:admin -- status --id INSTALLATION_UUID
npm run pilot:admin -- revoke --id INSTALLATION_UUID
unset APCIDA_PILOT_ADMIN_TOKEN
```

The approval flag is required, token files cannot be overwritten, and tokens expire after 30 days by default. Record each installation ID separately from its token. Delete the transfer copy after provisioning and verify device access. A revoked or expired token returns generic HTTP 401. An unavailable credential database returns HTTP 503, never SAFE. Re-enrollment issues a fresh ID/token; no anonymous self-registration exists. Administrators must verify device ownership before enrollment. Anyone with an issued token and tailnet access could use the service until expiry/revocation, so lost devices require both credential revocation and tailnet device removal.

## Android debug pilot test

On the Android project, put only the **public approved host name** in untracked `local.properties`:

```properties
apcida.pilotApprovedHost=YOUR-MAC.YOUR-TAILNET.ts.net
```

```sh
cd /Users/giopatrick/Documents/apcida/Mobile_App
./gradlew testDebugUnitTest assembleDebug assembleDebugAndroidTest
```

Install the debug APK on an authorized Android device with the Tailscale app connected. Open **Secure Pilot Test (debug)**, enter `https://YOUR-MAC.YOUR-TAILNET.ts.net`, provision the one-time installation credential, enter only a synthetic SMS, confirm it is synthetic, and tap Analyze. The UI shows remote classification, confidence, rationale, or a generic failure. The debug launcher is separate from the old LAN manual screen. Instrumentation tests for actual Keystore persistence need an Android device and are not run by unit tests.

## Privacy and remaining rollout gates

Only synthetic message text and the fixed `ManualTest` sender are sent. The request ID is random; no phone number or SMS timestamp from the inbox is sent. The backend keeps no inference history or raw request logs; Ollama receives the synthetic prompt in memory. Tailnet and OS proxy logs may still contain connection metadata. Keep diagnostic logs short-lived and access-controlled, and delete temporary credential transfer files after provisioning. Research contribution remains a separate consent choice.

Do not use this path for real SMS. Before real-device **SMS** testing, independently verify the HTTPS Serve certificate on the phone, tailnet ACL denial from unauthorized devices, authentication/revocation, Mac sleep and model availability, end-to-end timeout behavior, privacy and retention, and explicit user consent. Automatic remote transmission requires a separate production decision and remains hard-disabled; local keyword detection and UNVERIFIED fallback continue unchanged.
