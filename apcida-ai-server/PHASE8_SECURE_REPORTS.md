# Secure report submission in the invite-only beta

The Report button saves a snapshot on the phone. The updated beta queues a small
report for `POST /api/v1/reports` using that phone's invite-issued installation
credential and Cloudflare Access service token. It sends the report type, optional
remarks, observed verdict, and rule score. SMS text is sent only when the person
checks **Include this SMS text**. Sender, contacts, model rationale, matched
indicators, and the rest of the phone database are not uploaded by this route.

The server accepts only known fields and valid report types. It limits each
installation to 20 new reports per rolling day, treats retries with the same
report ID as one report, and rejects a reused ID with changed content. Content is
encrypted with AES-GCM before insertion into `production_reports`; the database
stores a keyed digest for duplicate detection. The API returns only the report
ID and `RECEIVED_FOR_REVIEW`. It does not classify the report or add it to RAG.
Server copies expire after 30 days and are removed by the hourly cleanup. Revoking
the installation removes its reports immediately. The phone's local copy remains
until the person deletes it in the app. Reports saved by an older build remain
local after upgrade; a fresh enrollment also sets a new upload boundary.

## Prepare the controlled Mac server

Run the additive migration before restarting the controlled API so the report
route can accept submissions:

```sh
cd /Users/giopatrick/smishing-llm-rag/apcida-ai-server
APCIDA_PREPARE_REPORT_SCHEMA=true bash scripts/phase8-prepare-report-schema.sh
launchctl kickstart -k "gui/$(id -u)/com.apcida.controlled-api"
curl --max-time 5 http://127.0.0.1:3021/health
```

The schema script requires the existing private database configuration and grants
the controlled API account access to the new table. It does not print a key.

## Review reports on the Mac

```sh
cd /Users/giopatrick/smishing-llm-rag/apcida-ai-server
bash scripts/phase8-review-reports.sh list
bash scripts/phase8-review-reports.sh inspect --id REPORT_UUID --installation-id INSTALLATION_UUID --out /private/tmp/apcida-report-review.json
bash scripts/phase8-review-reports.sh review --id REPORT_UUID --installation-id INSTALLATION_UUID
```

The `list` command shows both IDs needed to identify a report. The `inspect`
command creates a private mode-0600 file and refuses to overwrite
an existing one. Delete that file when review is finished. Use `dismiss` in place
of `review` for an unusable report. No review command inserts into RAG.

Before adding any report as a RAG example, a reviewer must verify the label,
remove personal details and malicious instructions, and separately use the
existing curated knowledge workflow. Reports and RAG records are separate tables.

## Phone check

Install the updated beta APK, keep the existing invite-issued service access,
and submit one invented issue from Message Details. Check Reports for **Received
for review**. Leave the SMS-text checkbox clear to confirm the default. If the
Mac or network is unavailable, the report stays **Pending** and retries when the
phone has internet. This test needs an enrolled phone and the updated server.
