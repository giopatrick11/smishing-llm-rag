# Consented thesis contributions

The study workflow is separate from detection reports and RAG knowledge. It is disabled by default. Adding this source does not migrate a live database or deploy the website. Participants review and select messages on the phone. The private dashboard queues up to ten received messages per click; the worker processes one at a time under the existing global inference slot. The expert uses a separate password and sees message text without the participant label or model result until a label is saved.

## Storage and privacy

Migration `009_study_contributions.sql` creates a `study` schema: `participants`, `withdrawals`, `batches`, `contributions`, `predictions`, and `expert_labels`. SMS text is encrypted with a study-specific key derived from `PRODUCTION_DATA_KEY`; an HMAC supports duplicate checks without plaintext indexes. Phone identifiers are not included in the contribution. Submitted `clientId` values are keyed fingerprints made on the phone. The batch records how many SMS were examined, offered, and selected; it does not store declined SMS text. A participant can withdraw through `DELETE /api/v1/community/contributions`, which deletes their study rows and records a withdrawal timestamp so an old queued upload cannot recreate them. Revoking the phone credential also deletes study rows through the installation foreign key.

Set `APCIDA_STUDY_RETENTION_DAYS` explicitly before enabling the service. The production listener purges expired participant records and all dependent study rows hourly. Review the period, backup retention, deletion procedure, consent wording, and expert access with the study owner before setting it. The study data never enters `rag_knowledge` automatically.

## Phone API

The controlled phone listener uses the existing installation Bearer credential and Cloudflare Access service token. `APCIDA_STUDY_ENABLED=true` mounts:

- `GET /api/v1/community/contributions/progress?participantId=UUID`: accepted counts for the authenticated installation.
- `POST /api/v1/community/contributions`: one explicit consented batch of 1–20 edited SMS. It commits accepted and rejected item decisions before responding. The participant cap is 40 total, enforced transactionally. Replaying the same batch ID and content returns the saved response.
- `DELETE /api/v1/community/contributions`: withdraws all study records for that installation.

Batch JSON contains `batchId`, `participantId`, `submittedAt`, `consentScope: "STUDY_EVALUATION_ONLY"`, `examinedCount`, `offeredCount`, `selectionMethod: "RECENT_INBOX_PARTICIPANT_REVIEW"`, and `items`. Each item has a keyed `clientId`, edited `text`, `localSuggestion`, participant `reviewedCategory`, and `reviewedAt`. The participant category is a study input, not ground truth. The server requires the participant ID to stay bound to the authenticated installation and rejects obvious unredacted numeric codes and email addresses. Manual review remains necessary for names and other personal details.

## Dashboard and analysis

When enabled, `admin.apcida.stream/study` lists contributions and offers **Analyze next 10** to administrators. The action only queues rows; the server responds immediately. The dashboard process resumes queued work after restart. Each item records model digest, pipeline source hash, and active RAG fingerprint, and a changed snapshot pauses further analysis. Before model analysis, the worker excludes exact and near duplicates of approved, active RAG examples from the accuracy comparison. It holds the existing RAG read lock through inference so approved knowledge cannot change between the check and model call. Exclusion counts remain visible to administrators. The shared inference slot avoids parallel Gemma calls, but a research item already in progress can briefly make a live SMS request busy. Run batches during supervised quiet periods; the worker leaves a short gap between items.

The separate `study-expert-login.key` is created in the controlled server's private directory when study mode first starts. Give it only to the network expert through a private channel and add that expert to the Cloudflare Access allow policy before remote use. The expert account can open only the blind study list and labeling pages; only that role can save expert labels. Administrators can view `/study/results` and download `/study/results.csv`. The CSV contains IDs, labels, outcomes, errors, and version fingerprints; it contains no SMS text.

The website evaluates the **edited, redacted text** that both the expert and Gemma receive. It sends sender `Unknown` because contribution uploads omit sender addresses. Consequently, results describe the contributed, redacted set, not every incoming SMS under full production context. The local rule suggestion is recorded separately from the server Gemma/RAG verdict and from the expert label. `SUSPICIOUS`, analysis errors, and insufficient-evidence expert labels remain separate outcomes. Do not use the study messages to tune rules, prompts, or RAG until the frozen comparison is complete.

The dashboard reports classification accuracy only among completed messages with SCAM/SAFE expert labels, plus a separate end-to-end exact-match rate that includes analysis errors. Participant deselection and the local eligibility rules make this a self-selected test set. Record recruitment, scan counts, offered counts, selected counts, exclusions, and withdrawals in the thesis. A representative estimate across incoming SMS requires a separate consented sample selected independently of both the system verdict and participant preferences.

## Controlled preparation

1. Review the study protocol and select the retention period and expert access policy.
2. On the controlled Mac, run `APCIDA_PREPARE_STUDY_SCHEMA=true bash scripts/phase11-prepare-study-schema.sh` only after authorizing the database migration. It applies the opt-in schema and grants the existing app and dashboard roles the needed permissions.
3. Set `APCIDA_STUDY_ENABLED=true` and `APCIDA_STUDY_RETENTION_DAYS=<approved days>` in the private `production.env`, restart the controlled listener and admin dashboard, and verify their study pages and phone routes with synthetic submissions before inviting real contributions.
4. Test one phone's upload, retry, withdrawal, and re-enrollment behavior; then test expert blindness, model version freeze, ten-item queue recovery, and text-free export. Local unit tests and disposable PostgreSQL tests do not replace these device and deployment checks.
