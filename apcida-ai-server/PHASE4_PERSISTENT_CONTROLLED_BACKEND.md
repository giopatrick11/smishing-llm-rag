# Phase 4: Persistent controlled Mac backend

Prepared and verified 2026-10-30. This is a **synthetic-only controlled test**, not automatic real-SMS deployment. Android `RemoteTransportGate.PRODUCTION_READY` remains `false`.

## Current arrangement

| Component | Retired temporary pilot | Persistent controlled setup |
| --- | --- | --- |
| API | `127.0.0.1:3020` | `127.0.0.1:3021` |
| PostgreSQL | Disposable port 55435, removed when the pilot script stops | Separate port 55436, stored under `~/Library/Application Support/ApCiDa/controlled-server/postgres` |
| Cloudflare route | Removed from the temporary pilot | `sms.apcida.stream` points to 3021 behind Cloudflare Access |
| Startup | Foreground pilot stopped and its disposable database removed | User LaunchAgents for PostgreSQL, API, and `cloudflared`, starting at Mac login |
| Credentials | One-day credential invalid after database removal | Private server keys and database password outside Git; no active synthetic phone credential after the supervised test |

The controlled data directory is mode 0700. Its environment, PostgreSQL superuser password, and admin key files are mode 0600. PostgreSQL host connections use SCRAM authentication. The app uses a separate `apcida_app` database role; it can read approved RAG rows and access only the production-contract tables needed by the controlled API. The approved source database was read only. Four migrations and 100 approved RAG records were copied to the separate database.

## Verification performed

- New API `/health` responded on 3021, and a missing bearer received HTTP 401.
- One invented local request returned HTTP 200, `SCAM · HIGH` in about 22 seconds. An identical request replayed the same encrypted cached response. The temporary test credential was then revoked and its private token file removed.
- Aggregate checks after revocation: **0 active installations, 0 cached inference requests, 100 active approved RAG records**.
- The API reopened the same database after a manual restart. Both LaunchAgents are now running; the API returned healthy after `launchctl kickstart -k`. The old pilot on 3020 remained healthy.
- A private PostgreSQL custom-format backup was restored into a temporary check database with 100 approved RAG rows. The archive was about 413 KB. This is a manual backup; automated retention and off-device recovery remain to be designed.
- Backend `npm test`: **118 total, 116 passed, 0 failed, 2 optional isolated-environment skips**. Shell syntax, plist lint, and `git diff --check` passed.
- The owner changed the Tunnel route to `127.0.0.1:3021`, then opened `https://sms.apcida.stream/health` after Cloudflare Access login and saw `{"status":"ok"}`. The local 3021 API remained HTTP 200. The old 3020 pilot and port-55435 database were stopped and removed.
- On 2026-10-30, a debug Android phone with Wi-Fi off and mobile data on displayed `SCAM · HIGH` for invented bank-warning text. The persistent backend's privacy-safe audit recorded HTTP 200 in 24,525 ms for that request. An invented appointment reminder displayed `SAFE` and the backend recorded HTTP 200 in 6,287 ms. These timings are backend durations, not measured phone round-trip times.
- With both Wi-Fi and mobile data off, the debug screen displayed `Test unavailable`; no new analysis request reached the backend. The supervised installation credential was then revoked, its private token and ID files were removed, and the backend still returned HTTP 200 from `/health`. The phone should also remove its locally stored test credentials. This checks the manual synthetic screen's offline response, not the automatic SMS worker.
- A fresh synthetic phone installation credential was enrolled in a mode-0600 private file for the supervised test. The previous disposable pilot credential was invalid. The new installation was revoked after testing and the local files were removed.

## Local operator commands

From `apcida-ai-server`, the synthetic-only end-to-end check creates a temporary installation and revokes it after the test:

```bash
bash scripts/phase4-local-synthetic-verify.sh
```

To make and restore-check a new private backup:

```bash
bash scripts/phase4-backup-controlled-db.sh
```

To check both local services without displaying credentials:

```bash
/opt/homebrew/opt/postgresql@17/bin/pg_isready -h 127.0.0.1 -p 55436
curl -fsS http://127.0.0.1:3021/health
launchctl print gui/501/com.apcida.controlled-postgres
launchctl print gui/501/com.apcida.controlled-api
```

For a concise read-only check of local services, models, AC power, and the public Access redirect:

```bash
bash scripts/phase4-readiness-check.sh
```

This check does not submit an SMS or prove that a remote phone can analyze text. The owner browser check above confirmed the authenticated public health route at the time of testing.

The source-controlled service definitions are in `deploy/macos/`. Installed copies are under `~/Library/LaunchAgents/`. They contain paths and ports, not credentials. `scripts/phase4-run-controlled-server.sh` reads the private environment and uses the Mac's currently installed Node 22 binary. Update that binary path if Node is moved or upgraded. The LaunchAgents start at **user login**; they do not keep a sleeping or powered-off Mac reachable.

After the Mac was plugged in, the controlled API launcher was wrapped with `caffeinate -s`. macOS confirmed a `PreventSystemSleep` assertion while on AC power and the API still answered `/health`. This does not keep the Mac available when powered off, unplugged, or with its lid closed.

## Still required before broader rollout or real SMS

1. Define and test automated backup schedule, retention, private-key recovery, and off-device restore. A one-time local archive is not a disaster-recovery plan.
2. Verify Mac power, sleep, login, network, Ollama startup, and service recovery. `/health` checks the API process; use the separate PostgreSQL and model checks for dependencies.
3. Continue cold and warm invented-message measurements through Cloudflare from the phone, including an induced outage. Resolve deadline misses before relying on that route for automatic SMS.
4. Run physical Android instrumentation and consent/revocation checks with the friend, provision unique renewable credentials per phone outside the APK, and complete privacy review.
5. Keep `PRODUCTION_READY=false` until a separate explicit activation decision for real SMS.

## Prepared tunnel-token rotation handoff

`scripts/phase4-capture-rotated-tunnel-token.sh` waits for the operator to copy the **new** Cloudflare `apcida-pilot` command, validates that the clipboard token belongs to the expected tunnel, saves it as a mode-0600 file under the private controlled-server directory, then clears the clipboard. It refuses to overwrite an existing token file. The new `com.apcida.cloudflared` user LaunchAgent runs with `--token-file`, keeping the token out of its process command line. After rotation, the new connector registered four Cloudflare connections and showed no startup errors. The old command-line-token connector was stopped; only the new managed connector remained running. The public hostname returned HTTPS 302 from Cloudflare Access afterward. The route was later moved to 3021 and verified by the owner in the browser.

## Backup deferral and additional local timing

The owner chose to postpone off-device backups while this setup accepts only invented test text. The one private local backup/restore check above remains; there is no Time Machine destination or off-device copy. Do not enable real-SMS upload before the backup, retention, and key-recovery plan is reviewed.

Two more local synthetic requests through the persistent API succeeded in 20,873 ms and 8,455 ms, each with identical encrypted replay. Both temporary credentials were revoked afterward; aggregate checks again found zero active installations and zero cached requests. These local timings do not measure Cloudflare Access, a different network, phone background execution, or cold-start outage behavior. The prior remote phone timeout still needs a protected-route reliability check.
