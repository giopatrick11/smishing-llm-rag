# Phase 3T: Remote synthetic pilot reliability

The later persistent controlled Mac setup is documented in [Phase 4](PHASE4_PERSISTENT_CONTROLLED_BACKEND.md).

Prepared 2026-10-30. The physical Android debug app reached `sms.apcida.stream` over mobile data and displayed a `SCAM · HIGH` result for invented text. The current listener is still a disposable, controlled test on the Mac. Automatic real-SMS transport remains disabled (`RemoteTransportGate.PRODUCTION_READY=false`).

## Observed pilot behavior

- The phone's first synthetic attempt displayed `TIMEOUT`. The production listener had accepted that request, so Cloudflare routing, Access Service Auth, and the backend installation credential passed for it. The exact timeout source was not recorded by the old listener.
- A later synthetic request succeeded over mobile data. The screen displayed `SCAM · HIGH` for an invented package-fee lure.
- At inspection time, the isolated test database held five completed synthetic analyses, with completion times from about 7 to 54 seconds. The listener audit held six accepted events. An unfinished request is released from the database, so the missing row is consistent with the displayed timeout. This is a small sample and does not establish an availability rate.

## Change prepared for the next listener start

The production-contract API now emits a bounded audit outcome for each accepted request: HTTP status and elapsed milliseconds when a response finishes, or a disconnect event and elapsed milliseconds when the client closes first. The audit does not include SMS text, sender, rationale, request ID, or credentials. The old accepted event remains. API tests cover success, deadline, and client-disconnect outcomes. No protocol, classifier, timeout, gate, or deployment setting changed.

The already-running disposable listener does not load code changes automatically. Restarting `phase3s-live-synthetic-verify.sh` destroys its private PostgreSQL cluster and invalidates the temporary installation token. Keep this listener running for any current phone test. On the next intentional pilot start, re-provision the new temporary phone token and check the new outcome events in the private server log. Do not copy that log to a public issue without review.

The protected listener now uses a separate configuration loader that does not require or use the development `API_KEY`. When launched in `controlled-test` mode, it does not load the project's development `.env` file. Its required settings must be supplied explicitly through a private environment. The normal development API still requires its key and loads `.env`. This does not change phone authentication or enable real-SMS upload.

Verification: the backend test suite completed with 115 passed, 0 failed, and 2 isolated-environment tests skipped. `bash -n scripts/phase3s-live-synthetic-verify.sh` and `git diff --check` passed. The running listener was deliberately not restarted, and no new physical-phone or real-SMS test was performed for these code changes.

## Mac check before the next phone session

From `apcida-ai-server`, run `bash scripts/phase3t-pilot-preflight.sh`. It makes only local read-only checks: test API health and loopback binding, disposable PostgreSQL readiness, both required Ollama models, and the named tunnel connector process. It prints no tunnel token or installation credential. All six checks passed on the Mac after the phone session. The check does not prove that the remote DNS route or Cloudflare Access policy is healthy. The temporary installation credential expires one day after enrollment; a passing Mac check does not renew it.

`deploy/macos/production.env.example` is a placeholder for a later dedicated local database on port 55436. It contains no usable key. It is not installed or sourced; the currently running pilot still uses the disposable database on port 55435. The protected listener requires an explicit private environment and remains restricted to `controlled-test` mode. The persistent database, migration, approved RAG copy, key storage, backup policy, and startup service must be reviewed before using the template.

## Remaining production work

1. Measure repeated invented-message requests through the protected hostname, including cold start, warm start, and an induced outage. Record counts and status/latency distributions without recording content. Decide how the client handles deadline misses before changing the 90-second backend deadline or synchronous protocol.
2. Replace the disposable test database and one-day installation credential with a dedicated persistent database, migration, backup/retention policy, and a separate renewable credential for each installation. Provision Access device credentials outside the APK; never bundle a shared Service Auth secret.
3. Set up managed startup and recovery for Ollama, PostgreSQL, the loopback API, and `cloudflared` on the Mac. Verify hostname, TLS, authorization, restart, sleep, and power-loss behavior. A registered domain and healthy tunnel alone do not make the Mac highly available.
4. Run the compiled Android instrumentation suite on the connected physical phone, then test consent, revocation, background handling, notifications, and process death with synthetic data. The phone used here is remote and was not connected to this Mac for ADB tests.
5. Review real-SMS privacy, retention, and opt-in behavior, then make a separate explicit activation decision before changing `PRODUCTION_READY` or enrolling real users.
