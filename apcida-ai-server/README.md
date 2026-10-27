# ApCiDa AI server

Local Express API for analyzing one SMS at a time with `gemma3:12b` through Ollama. The server listens on `127.0.0.1` only. It keeps no SMS database and does not log request bodies or SMS text. Opening `/` in a browser shows the available API routes.

## Requirements

- Node.js 20 or newer
- Ollama running locally with `gemma3:12b` installed
- For optional RAG: local PostgreSQL 17 with pgvector and Ollama's `nomic-embed-text`

## Install and configure

Run these commands in Terminal:

```sh
cd /Users/giopatrick/smishing-llm-rag/apcida-ai-server
npm ci
printf 'API_KEY=%s\n' "$(openssl rand -hex 32)" > .env
```

The generated `.env` is ignored by Git. Optional settings can be added to it:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Local Express port |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Local Ollama origin; only loopback HTTP is accepted |
| `OLLAMA_MODEL` | `gemma3:12b` | Exact Ollama model name |
| `API_KEY` | required | Secret of at least 16 characters for SMS analysis |
| `REQUEST_TIMEOUT_MS` | `120000` | Ollama request timeout, 1,000 to 300,000 ms |
| `RAG_ENABLED` | `false` | Enable local embedding and pgvector retrieval |
| `DATABASE_URL` | optional while RAG is off | Local PostgreSQL URL for database `apcida` |

The example values are in `.env.example`. Express always binds to `127.0.0.1`; no host environment setting can expose it on a network interface. Keep Ollama bound to localhost as well.

## Start

```sh
cd /Users/giopatrick/smishing-llm-rag/apcida-ai-server
npm start
```

In a second Terminal window, check both health and model availability:

```sh
curl -sS http://127.0.0.1:3000/health
curl -sS http://127.0.0.1:3000/api/ai/status
```

`/health` reports whether Express is running. `/api/ai/status` checks Ollama's `/api/tags` endpoint for the exact configured model name. It returns HTTP 503 when Ollama or the model is unavailable.

Analyze an SMS from the second Terminal window:

```sh
cd /Users/giopatrick/smishing-llm-rag/apcida-ai-server
source .env
curl -sS -X POST http://127.0.0.1:3000/api/sms/analyze \
  -H "x-api-key: $API_KEY" \
  -H 'content-type: application/json' \
  --data '{"messageId":"example-001","sender":"ExampleSender","text":"Your appointment is tomorrow at 9 AM.","receivedAt":"2026-10-26T09:00:00+08:00"}'
```

A successful response has this shape:

```json
{
  "messageId": "example-001",
  "classification": "SAFE",
  "confidence": "MEDIUM",
  "rationale": "This appears to be an ordinary appointment reminder.",
  "model": "gemma3:12b",
  "processingTimeMs": 1234
}
```

The values above illustrate the response format; the model decides the classification and rationale. The request must contain exactly `messageId`, `sender`, `text`, and an ISO 8601 `receivedAt` with a time zone. Text is limited to 2,000 characters, the full JSON body to 8 KB, and analysis requests to 30 per minute per local client address. `POST /api/sms/analyze` requires the `x-api-key` header. The other two endpoints do not.

The model receives a fixed instruction to weigh concrete evidence in English, Filipino, or Cebuano. An OTP, urgent wording, or unfamiliar URL alone is not treated as proof of a scam. The model's JSON response is checked against a strict Zod schema before it is returned. A classification is an assessment of the SMS text, not independent verification of the sender or any URL.

Error responses use codes such as `UNAUTHORIZED` (401), `INVALID_REQUEST` (400), `REQUEST_TOO_LARGE` (413), `RATE_LIMITED` (429), `OLLAMA_UNAVAILABLE` (503), `OLLAMA_OVERLOADED` (503), `OLLAMA_TIMEOUT` (504), and `OLLAMA_INVALID_RESPONSE` (502). They do not include raw SMS content or upstream error bodies.

## Test

```sh
cd /Users/giopatrick/smishing-llm-rag/apcida-ai-server
npm test
```

The automated tests mock Ollama and open a temporary local HTTP port. Ollama does not need to be running for them. The API handles one message per request. Community contributions, user reports, batch learning, and phone connectivity are outside this phase.

## Phase 2A: baseline evaluation

The evaluator reads a labeled UTF-8 CSV file and calls the same Ollama analysis service used by `POST /api/sms/analyze`. It runs **one inference at a time** with `gemma3:12b`; no API server or API key is needed for the CLI. Ollama must be running locally. The dataset is used only as evaluation input. The CLI does not train Gemma, store messages in a database, or add them to RAG.

Your CSV needs a header row, an SMS text column, and a ground-truth column containing `SCAM` or `SAFE` (case-insensitive). For a file with headers `message_id,sms_text,label`, run:

```sh
cd /Users/giopatrick/smishing-llm-rag/apcida-ai-server
npm run evaluate -- --input "/absolute/path/to/your-labeled-sms.csv" --text-column sms_text --label-column label --id-column message_id
```

Replace the file path and column names with those in your dataset. To see all flags:

```sh
npm run evaluate -- --help
```

`--id-column` is optional. Without it, IDs are generated as `row-000001`, `row-000002`, and so on. `--sender-column` and `--received-at-column` are optional and pass those fields to the same classifier if your CSV has them. Timestamps must be ISO 8601 with a time zone, such as `2026-10-26T09:00:00+08:00`. Do not map the SMS text column as the ID column. Column names are case-sensitive. Quoted commas, escaped quotes, and multiline SMS fields are supported.

The default output directory is `../evaluation-results/baseline-200/`. It is ignored by Git. Use `--output-dir /private/path` to put reports elsewhere. The CLI creates:

- `checkpoint.jsonl`: one durable record per completed inference, plus a dataset and classifier fingerprint;
- `evaluation.json`: metadata, metrics, and per-message results;
- `evaluation.csv`: one result row per SMS;
- `evaluation-metrics.csv`: aggregate metrics and their denominators.

Results contain the message ID, ground truth, prediction, confidence, rationale, inference duration, and an error code if the request failed. They do **not** contain the SMS text. The prompt asks the model not to quote it, and a verbatim full-message echo in a rationale is redacted. Keep reports private because rationales can still mention details from a message. Terminal progress prints counts only.

To resume after interruption, run the **same command with the same CSV, mapping, model, and output directory**. Completed results, including recorded errors and timeouts, are skipped. A changed dataset or classifier is rejected rather than mixed with old results. Each result is flushed to the checkpoint before the next inference. A crash after Ollama finishes but before that result is written can cause that one unfinished checkpoint item to run again. A concurrent run in the same output directory is blocked by `run.lock`; an abandoned lock from a dead process is removed automatically.

The JSON report gives each rate as `{numerator, denominator, value}`. `SCAM` and `SUSPICIOUS` both count as warnings for scam recall, scam precision, and the safe false-positive warning rate; their output counts stay separate. Scam recall divides warned scam rows by **all** scam rows, so failed scam inferences lower recall. Safe false-positive warning rate divides warned safe rows by safe rows with a valid prediction; safe errors are shown separately and do not make this rate look better. Binary accuracy uses only decisive `SCAM` or `SAFE` predictions. Latency statistics include every attempted inference, including errors and timeouts; P95 uses nearest rank. A metric with no eligible denominator has a JSON `null` value. Check `errorCount`, `errorsByCode`, and the numerator and denominator before interpreting rates.

## Phase 2B: local PostgreSQL and optional RAG

RAG is off by default. With `RAG_ENABLED=false`, the API uses the same Gemma classifier as Phase 1 and does not connect to PostgreSQL or request embeddings. The baseline evaluation CLI also remains independent of RAG. Existing Phase 2A checkpoints can resume from `../evaluation-results/baseline-200/`.

Use only the local PostgreSQL 17 server and database `apcida`. Set `DATABASE_URL` in `.env` to your working local URL; for a local connection without a password in the URL, its shape is:

```dotenv
RAG_ENABLED=false
DATABASE_URL=postgresql://localhost:5432/apcida
```

If your local PostgreSQL authentication needs a user or password, add your own credentials to that URL. The app rejects remote database hosts, other database names, and URL query parameters. No hosted PostgreSQL service is used.

Apply migrations from the server directory:

```sh
cd /Users/giopatrick/smishing-llm-rag/apcida-ai-server
npm ci
npm run db:migrate
```

The migration is safe to rerun. It enables pgvector and creates an **empty** `rag_knowledge` table with `vector(768)` embeddings, a cosine HNSW index, and explicit source and approval fields. It does not read or import the 200-message evaluation CSV. The 768 dimensions match the locally tested `nomic-embed-text` response. The vector type, cosine distance operator, and HNSW index follow the [pgvector documentation](https://github.com/pgvector/pgvector).

To enable retrieval after migrating, set `RAG_ENABLED=true` in `.env` and restart `npm start`. On startup, the server checks for PostgreSQL 17, pgvector, and the migrated table. For each authorized SMS analysis request, it sends the SMS text to local Ollama `/api/embed` using `nomic-embed-text`, searches up to three active knowledge entries with cosine similarity of at least 0.72, and passes any matches as untrusted reference context to `gemma3:12b`. The incoming SMS and its embedding are not written to PostgreSQL. With an empty knowledge table, there are no retrieved examples and the baseline prompt is used. If embedding or database retrieval fails while RAG is enabled, the request returns an error rather than silently claiming to have used RAG.

There is no public contribution endpoint. The local administrator workflow below is the only application path for knowledge ingestion. `GET /api/ai/status` still reports the Gemma classification model; it does not test PostgreSQL or the embedding model.

## Phase 2C: reviewed knowledge ingestion

Run `npm run db:migrate` before using these commands. Importing knowledge requires local PostgreSQL and Ollama; the Express server may remain stopped. The administrator CLI requires `RAG_ADMIN_KEY` in the private `.env` file and a matching `APCIDA_ADMIN_TOKEN` in the current shell. The administrator key is separate from the SMS API key. Set one up once if it has not already been configured:

```sh
cd /Users/giopatrick/smishing-llm-rag/apcida-ai-server
chmod 600 .env
node -e 'const fs=require("node:fs"),c=require("node:crypto");const f=".env",s=fs.readFileSync(f,"utf8");if(!/^RAG_ADMIN_KEY=/m.test(s))fs.appendFileSync(f,`${s.endsWith("\n")?"":"\n"}RAG_ADMIN_KEY=${c.randomBytes(32).toString("hex")}\n`);'
export APCIDA_ADMIN_TOKEN="$(node -e 'require("dotenv").config({quiet:true});process.stdout.write(process.env.RAG_ADMIN_KEY)')"
```

The import file must be UTF-8 CSV with exactly these headers (column order may vary):

```csv
external_id,content,label,reviewer,reviewed_at,source_reference
```

Each row needs a unique `external_id` (up to 128 characters), the independently reviewed SMS `content` (1–2,000 characters), a human-reviewed `SCAM` or `SAFE` label, the human `reviewer` (up to 100 characters), an ISO 8601 `reviewed_at` timestamp with time zone, and a nonempty `source_reference` (up to 200 characters, such as a review ticket ID). CSV quoting supports commas and multiline content. `SUSPICIOUS` is a model output, not an accepted knowledge label. The importer never asks Gemma to generate or approve labels.

The workflow is **CSV → full-file validation and duplicate checks → staging → sequential local embeddings → manual review → manual approval → active knowledge**. An invalid or contaminated row rejects the whole import before staging. Exact duplicates use normalized-text SHA-256; near duplicates use character trigram Dice similarity at 0.88 or higher. Normalization removes casing and punctuation differences and replaces URLs and long numbers with placeholders. This is a conservative text heuristic, not a guarantee against every paraphrase.

For the existing 200-message evaluation corpus, run the import with a contamination check:

```sh
npm run knowledge -- import --file "/absolute/path/to/independently-reviewed-knowledge.csv" --evaluation-csv ../dataset/apcida_synthetic_sms_200.csv --evaluation-text-column sms_text
```

The evaluation CSV is read only. Neither its messages nor its labels are staged or embedded. The importer checks each candidate against the evaluation corpus, other import rows, staged rows, and active knowledge. It stores only the evaluation file's SHA-256 fingerprint with each staged record. If Ollama embedding stops, entries remain `PENDING_EMBEDDING`; resume with:

```sh
npm run knowledge -- embed-pending
```

List entries awaiting embedding or approval, then inspect an individual entry before approving it:

```sh
npm run knowledge -- pending
npm run knowledge -- show --id 1
```

`pending` prints metadata only. `show` intentionally displays that entry's SMS content to the authenticated administrator for review. Replace `1` with the staged ID returned by `pending`. To approve a reviewed, embedded entry, or reject it:

```sh
npm run knowledge -- approve --id 1 --approver "Your Name" --confirm-reviewed
npm run knowledge -- reject --id 2 --approver "Your Name" --reason "Label not independently verified"
```

Approval is never automatic. Only `PENDING_APPROVAL` entries can be approved, and approval inserts them into `rag_knowledge` in one database transaction. The RAG query reads only active entries with an administrator and approval timestamp. Check the active count with:

```sh
npm run knowledge -- count
```

### Paged batch review and selective approval

Use `review-batch` to view up to 20 pending entries per page (10 by default). It shows the staged ID, message ID, SMS content, label, reviewer, review time, source, and a fresh duplicate/validation status. This command displays SMS content in the administrator's terminal. First preview a page without any approval prompt:

```sh
npm run knowledge -- review-batch --page 1 --page-size 10 --evaluation-csv ../dataset/apcida_synthetic_sms_200.csv --evaluation-text-column sms_text --list-only
```

To choose entries from that page for approval, run the interactive command in a Terminal window:

```sh
npm run knowledge -- review-batch --page 1 --page-size 10 --evaluation-csv ../dataset/apcida_synthetic_sms_200.csv --evaluation-text-column sms_text --approver "edison"
```

Enter only the staged IDs you reviewed from the displayed page, separated by commas, such as `5,7,9`. Press Enter without IDs to make no changes. The CLI then requires an exact confirmation such as `APPROVE 5,7,9 AS edison`. It refuses noninteractive approval and skips any selection whose check is not `PASS`. Before writing, it rechecks every selected row against the supplied evaluation corpus, all staged and active knowledge, the stored content hash, label, review metadata, and embedding state. All selected rows are approved in one transaction or none are. The actual approver name and database approval timestamp are recorded in staging and active knowledge.

The pending list shrinks after approval, so page numbers can shift. Reopen page 1 after each batch or preview other pages again before selecting IDs. Existing `show` and individual `approve` commands remain available. A checked embedding or reviewer field never causes automatic approval.

### Bulk approval of already reviewed entries

For the human-reviewed synthetic import, `approve-all` checks every `PENDING_APPROVAL` row against the supplied evaluation corpus and all staged and active knowledge. It requires a reviewer, review timestamp, source reference, valid SCAM/SAFE label, matching content and corpus fingerprints, and a completed `nomic-embed-text` embedding. A blocked row cannot be approved. The command uses the existing administrator token and records the named approver and database approval time. It does not change labels, import messages, or generate embeddings.

From the server directory, set the administrator token as shown above, then inspect the counts and blocked IDs without making changes:

```sh
npm run knowledge -- approve-all --approver giopatrick --preview
```

The command defaults to `../dataset/apcida_synthetic_sms_200.csv` and its `sms_text` column for contamination checks. To use a different evaluation corpus, supply both `--evaluation-csv FILE` and `--evaluation-text-column NAME` on the preview and approval commands. Its SHA-256 fingerprint must match the corpus recorded during import.

Run approval in an interactive Terminal window:

```sh
npm run knowledge -- approve-all --approver giopatrick
```

The CLI first displays the exact eligible count and any blocked IDs with reasons. Enter comma-separated staged IDs to **exclude** from this run, or press Enter for none. It then allows comma-separated IDs to **reject** with a required reason, or Enter for none. Any blocked ID must be excluded or rejected. It shows final approve, reject, and exclude counts, then requires the exact phrase it prints, such as `APPROVE 78 REJECT 0 AS giopatrick`. The number in this example is only a format illustration; use the number printed by your terminal. A blank or incorrect confirmation makes no changes.

Before writing, the command locks and rechecks the pending set and every selected approval. Approval and optional rejection occur in one PostgreSQL transaction; if a check or write fails, all changes roll back. It refuses a noninteractive approval. Preview and approval print IDs and check status, not SMS content; use `show` or `review-batch` if you need to inspect message text. Afterwards, run `npm run knowledge -- count` to see active knowledge records.

To enable RAG for the Express server on this Mac, change the existing `RAG_ENABLED=false` line in `.env` and restart the server:

```sh
sed -i '' 's/^RAG_ENABLED=.*/RAG_ENABLED=true/' .env
npm start
```

Stop a previously running `npm start` process before starting it again. RAG stays optional; the baseline evaluator always uses no RAG unless `--mode rag` is given.

After approving knowledge, run the same 200-message evaluation in a **new** output directory:

```sh
npm run evaluate -- --mode rag --input ../dataset/apcida_synthetic_sms_200.csv --text-column sms_text --label-column label --id-column message_id --output-dir ../evaluation-results/rag-200
```

RAG evaluation requires at least one active approved knowledge record. Before inference it compares active content with every evaluation message and aborts on exact or near duplicates. It holds a shared database advisory lock so administrator imports and approvals cannot change active knowledge during the run. Its checkpoint records the RAG pipeline and active knowledge fingerprints; changes require a new output directory. The original `../evaluation-results/baseline-200/` report and checkpoint remain separate and are not modified by this command. The RAG report uses the same metrics and per-message fields as the baseline report, with `mode: "rag"` in its metadata. Completed reports are in `../evaluation-results/rag-200/`.

## Phase 2E: keyword rules with Gemma 3 12B and optional RAG

The server can run `SMS → keyword rules → optional RAG retrieval → Gemma 3 12B → verdict resolver`.
Set `RULES_ENABLED=true` and `RULES_SHADOW_MODE=true` in `.env`, then restart the server. Shadow mode adds `rules`, `gemmaClassification`, and `verdictPolicy` to a successful analysis response, while `classification` remains Gemma's answer. `RAG_ENABLED` still independently controls retrieval. Rules are off when `RULES_ENABLED` is absent; the private `.env` on this Mac now enables them in shadow mode. No model is fine-tuned and the approved knowledge rows are unchanged.

The detector covers English, Filipino, Cebuano, and mixed-language phrases. It looks for credential requests, suspicious or obscured links, authority claims coupled with requested action, prize or aid offers, upfront fees, delivery fees, job offers, and coercive urgency. It returns a score, rule classification, indicator codes, and a short explanation. Repeated words or URLs contribute only once per category. Phrase points are capped at 60; URL points are capped at 80. Total scores of 0–29 are `SAFE`, 30–59 `SUSPICIOUS`, and 60 or higher `SCAM`. A brand, ordinary OTP notice, or harmless link alone cannot reach the warning threshold. These are heuristic signals; a link's destination and a sender's identity are not verified.

`VERDICT_POLICY=gemma` is the default final verdict policy. The optional `corroborated-warning` policy can be used only when shadow mode is explicitly disabled. It changes a Gemma `SAFE` verdict to `SUSPICIOUS` only when rules classify `SCAM` **and** find both a risky request (credential, upfront fee, or delivery fee) and independent support (suspicious/obscured URL, authority claim, or coercive urgency). It never promotes a message directly to `SCAM` and never downgrades a Gemma warning. This policy is experimental; do not enable it in the API until comparison and review support it. An inference or retrieval failure returns an error rather than a `SAFE` verdict.

### Reproducible 50-message development subset

`../dataset/apcida_synthetic_sms_50.csv` was selected from the original 200-message file with fixed seed `20261027`: exactly 25 `SCAM` and 25 `SAFE` rows. `npm run evaluation:subset` reproduces/verifies it and checks every selected message for exact and near-duplicate contamination against the **active approved PostgreSQL RAG knowledge**. It requires local PostgreSQL; the existing 200-message file and approved knowledge are read only. The RAG evaluation modes repeat the contamination check while holding a shared database lock. This synthetic subset is for preliminary development checks, not real-world performance claims.

### Archived Phase 2E evaluation commands

These commands produced the preserved Phase 2E reports. They are retained as a record of that run; the Phase 2F evaluator refuses to write to these same output directories. Use the new Phase 2F commands below for further evaluation. Each mode uses the same 50 rows, processes one message at a time, and supports a configurable `--pause-ms` (0–60000). Gemma 3 12B stays the only LLM classifier.

```sh
cd /Users/giopatrick/smishing-llm-rag/apcida-ai-server

# 1. Keyword rules only
npm run evaluate -- --mode rules --input ../dataset/apcida_synthetic_sms_50.csv --text-column sms_text --label-column label --id-column message_id --output-dir ../evaluation-results/phase2e-rules

# 2. Gemma 3 12B only
npm run evaluate -- --mode gemma --input ../dataset/apcida_synthetic_sms_50.csv --text-column sms_text --label-column label --id-column message_id --output-dir ../evaluation-results/phase2e-gemma

# 3. Gemma 3 12B + RAG
npm run evaluate -- --mode gemma-rag --input ../dataset/apcida_synthetic_sms_50.csv --text-column sms_text --label-column label --id-column message_id --output-dir ../evaluation-results/phase2e-gemma-rag

# 4. Keyword rules + Gemma 3 12B (shadow verdict)
npm run evaluate -- --mode rules-gemma --input ../dataset/apcida_synthetic_sms_50.csv --text-column sms_text --label-column label --id-column message_id --output-dir ../evaluation-results/phase2e-rules-gemma

# 5. Keyword rules + Gemma 3 12B + RAG (shadow verdict)
npm run evaluate -- --mode rules-gemma-rag --input ../dataset/apcida_synthetic_sms_50.csv --text-column sms_text --label-column label --id-column message_id --output-dir ../evaluation-results/phase2e-rules-gemma-rag
```

To compare the experimental resolver separately, run a hybrid mode with `--verdict-policy corroborated-warning --no-shadow true` and a **new** output directory. The five commands above all leave the final verdict at Gemma's classification in hybrid modes.

Each output directory contains `evaluation.json`, `evaluation.csv`, `evaluation-metrics.csv`, and `checkpoint.jsonl`. Per-message fields include `ruleScore`, `ruleClassification`, `matchedIndicators`, `ruleExplanation`, `gemmaClassification`, `finalClassification`, duration, and an error code. Fields for a component omitted by the mode are null or empty. The confusion matrix has `SCAM` and `SAFE` truth rows, and `SCAM`, `SAFE`, `SUSPICIOUS`, and `ERROR` output columns. `threeWayExactAccuracy` counts only exact `SCAM`/`SAFE` predictions as correct, with errors and `SUSPICIOUS` in the denominator. `scamClassRecall` and `scamClassPrecision` require an exact `SCAM` prediction. The preexisting `scamRecall` and `scamPrecision` remain warning-oriented metrics that also count `SUSPICIOUS` as a warning; `safeFalsePositiveWarningRate` uses the same warning interpretation. `latencyMs.mean` is the average processing time per row. Existing 200-message reports are grouped under `../evaluation-results/`.

## Phase 2F: broader rules and experimental evidence-weighted verdict

Phase 2E rule results missed requests for SIM/SMS codes, gift cards, personal-wallet payments, family emergencies, APK/remote-control installs, scholarships, and credentials entered into links. Rules version 2 adds those request patterns and related account, authority, government, delivery, and opportunity claims across English, Filipino, and Cebuano. A risky request must accompany a claim before it contributes claim points. An ordinary OTP notification, brand mention, bank transaction, or security alert directing the recipient to the official app stays below the warning threshold. Matching is still heuristic: it does not verify a sender, destination, or domain.

The scoring thresholds and caps are unchanged: `SAFE` 0–29, `SUSPICIOUS` 30–59, `SCAM` 60+; phrase cap 60 and URL cap 80. One highest-value indicator per category prevents overlapping phrases or repeated links from stacking. Existing credential-disclosure weight 55, advance-fee weight 40, and link weights 5/35/45 remain. New weights are 35 for credential entry into a link/form or personal ID requests; 35 for personal/changed-destination payments and delivery fees; 45 for gift-card purchases or APK/remote-control instructions; 20–25 for a corroborating claim or urgency. These are development weights, not calibrated probabilities.

`VERDICT_POLICY=evidence-weighted` is an **experimental** policy. The default `.env` still has `RULES_SHADOW_MODE=true` and `VERDICT_POLICY=gemma`, so the live final verdict stays Gemma's. With `--no-shadow true --verdict-policy evidence-weighted` in an evaluation, a Gemma `SAFE` result can become `SUSPICIOUS` only with rule score at least 60, a risky request, independent support, and either LOW Gemma confidence or strong RAG support. A Gemma `SUSPICIOUS` result can become `SCAM` only for an explicit credential-disclosure request, score at least 60, independent support, and LOW/MEDIUM Gemma confidence or strong RAG support. A Gemma `SCAM` verdict is never downgraded. Strong RAG support here means a retrieved SCAM example with similarity at least 0.82 and at least 0.05 above the closest SAFE example; retrieval similarity is supporting evidence, never a verdict by itself. RAG context in responses/reports contains similarity numbers and counts, not reference SMS text. Inference and retrieval failures remain errors.

### Dataset separation

- `../dataset/apcida_synthetic_sms_50.csv` is the inspected historical Phase 2E evaluation set; it was not edited. It is useful for comparing to the saved Phase 2E Gemma and RAG reports, but is no longer a blind test after inspecting its misses.
- `../dataset/apcida_synthetic_sms_50_development.csv` contains 25 SCAM and 25 SAFE examples selected from the remaining original corpus with fixed seed `20261028`. It is disjoint from the historical 50 and was checked against active approved RAG knowledge. The rules-only development run is in `../evaluation-results/phase2f-rules-development/`.
- `../dataset/apcida_synthetic_sms_50_holdout_phase2f.csv` contains another disjoint 25 SCAM and 25 SAFE examples selected with seed `20261029` and checked against approved RAG knowledge. It has **not** been evaluated or inspected for rule tuning; reserve it for a later generalization check. All three 50-message sets come from the same synthetic 200-message corpus, so even this holdout cannot establish real-world performance.

`npm run evaluation:development-set` and `npm run evaluation:holdout-set` reproduce and verify those files. The 200-message source, Phase 2E reports/checkpoints, and approved RAG records are not changed. New evaluations reject the five preserved `phase2e-*` output directories.

### Evaluate the actual experimental hybrid manually

Run from `apcida-ai-server`. These commands use the historical 50 to compare against the saved Phase 2E Gemma-only and Gemma+RAG classifications without changing those reports. Each command runs one Gemma inference at a time, with a one-second pause and checkpoint/resume support. Use the separate output directories shown. **Do not run them concurrently on the 16 GB Mac.**

```sh
cd /Users/giopatrick/smishing-llm-rag/apcida-ai-server

npm run evaluate -- --mode rules-gemma --input ../dataset/apcida_synthetic_sms_50.csv --text-column sms_text --label-column label --id-column message_id --verdict-policy evidence-weighted --no-shadow true --compare-gemma-report ../evaluation-results/phase2e-gemma/evaluation.json --compare-rag-report ../evaluation-results/phase2e-gemma-rag/evaluation.json --output-dir ../evaluation-results/phase2f-experimental-gemma

npm run evaluate -- --mode rules-gemma-rag --input ../dataset/apcida_synthetic_sms_50.csv --text-column sms_text --label-column label --id-column message_id --verdict-policy evidence-weighted --no-shadow true --compare-gemma-report ../evaluation-results/phase2e-gemma/evaluation.json --compare-rag-report ../evaluation-results/phase2e-gemma-rag/evaluation.json --output-dir ../evaluation-results/phase2f-experimental-gemma-rag
```

Each hybrid output includes `comparison.csv` with ground truth, rule score/indicator codes, the in-run Gemma classification, saved baseline Gemma classification, saved RAG classification, experimental hybrid classification, and `correctedError`/`introducedError`. These two booleans compare the hybrid verdict with the **in-run** Gemma prediction under exact SCAM/SAFE correctness; a `SUSPICIOUS` prediction is not exact. `evaluation.json` also contains the verdict reason, numeric RAG context when used, and aggregate correction/introduction counts. Comparison report inputs must match the exact dataset hash, row IDs, labels, mode, and Gemma model. A changed input or pipeline cannot be mixed with an existing checkpoint.

For the untouched Phase 2F holdout, first run Gemma-only and Gemma+RAG into new directories, then run the experimental hybrid with those reports passed to `--compare-gemma-report` and `--compare-rag-report`. Do this only after the rule and policy choices are frozen. The historical 50 and development 50 results are synthetic diagnostics, not a real-world accuracy estimate.

## Phase 2G: independent 50-message holdout

The reserved holdout is `../dataset/apcida_synthetic_sms_50_holdout_phase2f.csv`. Phase 2G preflight checks for exactly 50 unique message IDs, 25 SCAM and 25 SAFE labels, and no exact or near duplicates within the holdout or against the Phase 2F development and historical Phase 2E 50-message sets. It also checks the active approved RAG knowledge under a shared PostgreSQL lock. The check reads SMS text for duplicate detection but does not print or change it.

`../evaluation-results/phase2g-freeze.json` records SHA-256 hashes of the holdout, comparison datasets, keyword rules, scoring and verdict code, Gemma prompt and schema, RAG and evaluation pipeline; the active approved RAG knowledge fingerprint; and the local Gemma 3 12B and `nomic-embed-text` model digests. `npm run phase2g -- verify` recomputes all of them before a run. Every Phase 2G run also verifies the freeze after finishing. A mismatch stops the run for review. The policy is fixed to `evidence-weighted` with shadow mode off only for the hybrid evaluation; the production API remains in shadow mode.

Run the following commands **one at a time**, waiting for each to finish before the next. The Phase 2G runner holds a shared run lock across its three configurations, preventing two Phase 2G evaluations from running together. Each evaluation also calls Gemma sequentially, with a one-second pause between messages and a separate checkpoint/output folder. Avoid sending other API requests to Ollama during these runs.

```sh
cd /Users/giopatrick/smishing-llm-rag/apcida-ai-server
npm run phase2g -- verify
npm run phase2g -- gemma
npm run phase2g -- gemma-rag
npm run phase2g -- hybrid-rag
```

The outputs are `../evaluation-results/phase2g-gemma/`, `../evaluation-results/phase2g-gemma-rag/`, and `../evaluation-results/phase2g-hybrid-rag/`. The hybrid stage requires completed matching Gemma-only and Gemma+RAG reports and reads them without changing them. `evaluation-metrics.csv` in each folder reports `threeWayExactAccuracy`, `scamClassRecall`, `safeFalsePositiveWarningRate`, `errorCount`, and `latencyMs.mean`. The hybrid folder also contains `comparison.csv` with ground truth, rule score/indicators, Gemma-only and RAG classifications, experimental hybrid classification, and whether the hybrid corrected or introduced an exact-classification error. `evaluation.json` includes all per-message results, errors, and latency details. Checkpointed errors remain errors rather than SAFE predictions. Existing Phase 2E and 2F folders are preserved.

## Phase 2H: two-message sleep diagnostic

The separate diagnostic uses SF016 and SF046 copied byte-for-byte as CSV fields from the frozen Phase 2G holdout. `prepare` verifies the holdout hash and the two SAFE rows without model inference. The run verifies the full Phase 2G freeze, uses the existing sequential Gemma 3 12B + RAG evaluator with a one-second inter-message pause, and writes only to `../evaluation-results/phase2h-sleep-diagnostic-2/`. Keep the Mac lid open and avoid other Ollama requests during this short test.

```sh
cd /Users/giopatrick/smishing-llm-rag/apcida-ai-server
node src/evaluation/phase2hDiagnostic.js prepare
npm run phase2g -- verify
caffeinate -i node src/evaluation/phase2hDiagnostic.js run
node src/evaluation/phase2hDiagnostic.js compare
```

`caffeinate -i` holds an idle-system-sleep assertion for the duration of the child command. It cannot prevent forced sleep from closing the lid, low battery, or choosing Sleep. The diagnostic writes `diagnostic-events.jsonl` with UTC timestamps and elapsed times for run and chat events, plus the normal `evaluation.json`, `evaluation.csv`, `evaluation-metrics.csv`, and checkpoint. Events contain IDs, counts, timings, and error codes; they do not contain SMS text. The run refuses to reuse an existing diagnostic checkpoint so a second invocation cannot silently skip both requests. The `compare` command reads the two-message report and the three original Phase 2G reports and prints per-ID verdict, error, and duration.

For a sleep correlation, compare `chat_start` and `chat_error`/`chat_end` timestamps with `pmset -g log` sleep and wake entries. The original Phase 2G reports have per-row durations but no row timestamps. Their `OLLAMA_TIMEOUT` durations closely matched recorded Mac sleep intervals; this supports sleep as a cause, but does not rule out model load or memory pressure in a different run. The diagnostic does not change the existing timeout, retry behavior, prompts, rules, knowledge, or verdict policy.

The holdout is synthetic and comes from the same 200-message source as the development and historical sets. Treat its results as an independent check within that corpus, not as a measure of real-world performance. Do not alter labels, rules, prompt, policy, model, or approved RAG records in response to holdout results; record any proposed changes for a future dataset and evaluation phase.
