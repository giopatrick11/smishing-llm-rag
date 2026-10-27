# Phase 3H: Secure pilot readiness and synthetic verification

Verified on 2026-10-27 against the local Mac environment. This report covers **synthetic messages only**. Tailscale Serve was not activated, no tailnet policy was changed, no Android device was used, and no real SMS was transmitted.

## 1. Verified working components

| Component | Evidence |
| --- | --- |
| Pilot listener | `src/pilot/server.js` binds explicitly to `127.0.0.1:3010`; a temporary local listener served the probe and was stopped afterward. Port 3010 had no listener at the end. |
| Local AI and database | Ollama listened on `127.0.0.1:11434` and reported `gemma3:12b` and `nomic-embed-text`. PostgreSQL 17 listened on `127.0.0.1:5432` and `[::1]:5432`; pgvector was enabled. |
| Migration | Applied only `003_pilot_installations.sql` with `npm run db:migrate`. The pilot table and migration record exist. Approved RAG knowledge remained at 100 records. |
| Administrator enrollment | A temporary administrator key approved two test installations through the local CLI. Each token was written to a mode-0600 file, never printed. Both installations were revoked and the transfer files deleted. Zero pilot credentials were active afterward. The private `.env` currently has no lasting `PILOT_ADMIN_KEY`; routine administrator enrollment still needs configuration. |
| Authentication | Missing, invalid, and revoked bearer credentials returned generic HTTP 401. Token hashes, rather than tokens, are stored in PostgreSQL. The database-backed lookup was exercised by the live probe. |
| API restrictions | Malformed JSON returned 400; a request marked as synthetic with a non-`ManualTest` sender returned 400. The route requires a pilot-prefixed ID, validated body, and synthetic marker. Rate limits and the 8 KiB body cap pass automated tests. Synthetic markers cannot prove the text itself is synthetic. |
| Android | The pilot screen exists only under `src/debug`; the client requires the exact approved HTTPS host, normal TLS validation, a per-install Keystore-encrypted token, and an explicit synthetic confirmation. The production SMS worker never calls the pilot client. Consent defaults off, revocation cancels queued work, local fallback retains warning or UNVERIFIED, and `RemoteTransportGate.PRODUCTION_READY` is still `false`. |

## 2. End-to-end results

The local probe started the **actual** pilot server, enrolled a temporary installation using the administrator CLI, submitted only synthetic text, then revoked it and stopped the listener. The first synthetic message went through the RAG-enabled pipeline but had no matches above the frozen 0.72 similarity threshold. To verify retrieved context as well, the second probe read one already approved **synthetic** RAG example without changing it or printing its text.

| Check | Result |
| --- | --- |
| Missing installation token | HTTP 401 `UNAUTHORIZED` |
| Invalid installation token | HTTP 401 `UNAUTHORIZED` |
| Malformed JSON with valid token | HTTP 400 `INVALID_JSON` |
| Non-synthetic sender with valid token | HTTP 400 `SYNTHETIC_TEST_ONLY` |
| First valid synthetic analysis | HTTP 200, `SCAM`, `HIGH`, `gemma3:12b`, rationale present; 0 RAG matches; 25,497 ms |
| Approved synthetic RAG example | HTTP 200, `SCAM`, `HIGH`, `gemma3:12b`, rationale present; **3 RAG matches**; 9,202 ms |
| Revoked installation token | HTTP 401 `UNAUTHORIZED` |
| Server after shutdown | Connection rejected |
| Simulated Ollama timeout at the pilot API | HTTP 504 `OLLAMA_TIMEOUT`; no SAFE verdict |
| Audit output | No synthetic text or bearer token found in captured pilot logs |

These two timings are individual observations, not latency estimates. The timeout check injected an inference timeout in an automated test; Ollama was not deliberately stopped or stalled during the live probe. Existing tests cover rate limiting, oversized bodies, invalid credentials, and authentication-store failure. No full dataset evaluation was run.

## 3. Private HTTPS and security checks

- The pilot process is coded to bind loopback, and the live probe reached it only via `127.0.0.1`. Ollama and PostgreSQL were observed listening on loopback addresses. The existing development LAN launcher is separate and was not started for this probe.
- The Tailscale CLI and `/Applications/Tailscale.app` were absent. Therefore **tailnet grants, Serve status, Funnel status, certificate validation, and unauthorized-device denial could not be verified**. No inference endpoint was published.
- The Android `apcida.pilotApprovedHost` value is currently unconfigured in untracked `local.properties`. The pilot client will reject requests until the approved `*.ts.net` host is provided.
- The lasting `PILOT_ADMIN_KEY` is not configured. The probe used an ephemeral key only, revoked both test credentials, and left no active installation. This is a provisioning blocker, not a classifier failure.
- The debug build still contains the older LAN manual test screen with its debug-only HTTP configuration. The new pilot client independently rejects HTTP. Use **Secure Pilot Test (debug)** for HTTPS pilot checks; never enter real SMS in either manual screen.

## 4. Automated verification and changes

```sh
cd /Users/giopatrick/smishing-llm-rag/apcida-ai-server
npm test
# 85 passed, 0 failed

cd /Users/giopatrick/Documents/apcida/Mobile_App
./gradlew testDebugUnitTest assembleDebug assembleDebugAndroidTest assembleRelease
# 99 Android unit tests passed, 0 failed; all three APK builds succeeded
```

The Android Keystore instrumentation test **compiled but was not run** because no Android device was available. This phase added only `test/phase3hPilotReadiness.test.js` to verify timeout behavior at the pilot API and this report. It applied the local pilot identity migration. It did not change prompts, keyword scores, verdict policy, RAG records, frozen evaluations, or production SMS transmission.

## 5. Exact steps for physical Android pilot testing

1. Install Tailscale on the Mac and Android device and sign both in to the intended tailnet. In the Tailscale admin console, define the approved pilot identities and a grant allowing only those identities to reach the Mac pilot node on TCP 443. Remove any broad allow-all grant that would also reach that service. Confirm the intended node tag, ownership, and that no Funnel mapping exposes the pilot. Follow the grant example in `PHASE3G_SECURE_PILOT.md` and [Tailscale's grant guidance](https://tailscale.com/docs/reference/examples/grants); review the actual tailnet policy before applying it.
2. Configure a distinct random `PILOT_ADMIN_KEY` in the backend's ignored `.env`. Keep the existing internal `API_KEY` private. Verify `tailscale status`, `tailscale serve status`, and `tailscale funnel status` once the CLI is installed. Confirm Ollama and PostgreSQL still listen only on loopback:

   ```sh
   lsof -nP -iTCP:11434 -sTCP:LISTEN
   lsof -nP -iTCP:5432 -sTCP:LISTEN
   ```

3. Start the localhost pilot listener in one terminal. Leave model, RAG, prompts, and verdict configuration as shown:

   ```sh
   cd /Users/giopatrick/smishing-llm-rag/apcida-ai-server
   RAG_ENABLED=true RULES_ENABLED=true RULES_SHADOW_MODE=true VERDICT_POLICY=gemma npm run pilot:start
   ```

4. In another terminal, confirm the backend is bound to `127.0.0.1:3010`. **After** the tailnet grant review, manually start HTTPS Serve in the foreground following the [current Serve CLI](https://tailscale.com/docs/reference/tailscale-cli/serve). Check its tailnet URL and verify that an unauthorized tailnet device cannot connect:

   ```sh
   lsof -nP -iTCP:3010 -sTCP:LISTEN
   tailscale serve --https=443 3010
   tailscale serve status
   tailscale funnel status
   curl --fail --silent https://YOUR-MAC.YOUR-TAILNET.ts.net/health
   ```

   Use a second terminal for the status and curl commands while Serve runs. Stop Serve with Ctrl-C; if its mapping remains, run `tailscale serve --https=443 off`. Never use `tailscale funnel` for this pilot.

5. Enroll the approved Android installation from the Mac only. The administrator key is entered through a hidden prompt; the token is written to a new private file, not printed or placed in a URL:

   ```sh
   cd /Users/giopatrick/smishing-llm-rag/apcida-ai-server
   mkdir -p -m 700 "$HOME/.apcida-pilot"
   read -s 'APCIDA_PILOT_ADMIN_TOKEN?Pilot administrator key: '
   export APCIDA_PILOT_ADMIN_TOKEN
   printf '\n'
   npm run pilot:admin -- enroll --label PilotPhone1 --out "$HOME/.apcida-pilot/pilot-phone1.token" --approve
   unset APCIDA_PILOT_ADMIN_TOKEN
   ```

   Transfer the token privately to that device, record its installation UUID separately, and delete the transfer file after provisioning. Revoke a lost or retired installation with `npm run pilot:admin -- revoke --id INSTALLATION_UUID` using the same hidden administrator prompt.

6. Set only the approved public DNS name in Android's ignored `local.properties`:

   ```properties
   apcida.pilotApprovedHost=YOUR-MAC.YOUR-TAILNET.ts.net
   ```

   Build and install the debug APK from `/Users/giopatrick/Documents/apcida/Mobile_App` with `./gradlew assembleDebug`. Connect the Android Tailscale app, open **Secure Pilot Test (debug)**, enter `https://YOUR-MAC.YOUR-TAILNET.ts.net`, provision the installation token, and submit one manually typed **synthetic** SMS after checking the confirmation box. Verify classification, confidence, rationale, and error messages. Test an invalid token, revoke the installation and verify 401 handling, and stop the Mac server to verify the unavailable-server message. Run `./gradlew connectedDebugAndroidTest` only after a physical device is attached; it exercises actual Keystore persistence.

## 6. Before any real SMS analysis

Keep automatic transmission disabled. A later rollout needs physical-device verification of TLS identity, tailnet policy isolation and Funnel absence, Keystore persistence/revocation, actual timeout and outage behavior, Mac availability, operational credential provisioning/rotation, privacy and retention review, and explicit consent validation. The current debug pilot asks users to affirm synthetic input, but cannot prove it; it is unsuitable for real-message processing. Only after those checks and a separate product/security decision should the production gate and background transport be implemented and reviewed.
