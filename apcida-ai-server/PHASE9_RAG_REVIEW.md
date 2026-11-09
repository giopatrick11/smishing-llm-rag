# Reviewed RAG examples on the controlled Mac

The live RAG collection is the `rag_knowledge` table in the Mac's local
PostgreSQL database. It is not a folder of SMS files. ApCiDa retrieves up to
three approved, similar examples for each authorized remote analysis request.
The incoming SMS is not added to that collection.

Reports are separate. New reports require one explicit consent to send the SMS
for admin review and allow a redacted version to be considered as a RAG candidate.
Only reports with `consentScope` set to `REVIEW_AND_RAG_CANDIDATE` have that
authorization. Reports collected before this change were consented for report
review only and must not be imported into RAG. No report is imported
automatically; the reviewer must verify the label, redact personal details, and
run the controlled validation and approval steps below. An approved RAG example
can remain after the original report expires. For initial checks, prefer invented
test messages.

## See what is in the live collection

On the Mac, open Terminal and run:

```sh
cd /Users/giopatrick/smishing-llm-rag/apcida-ai-server
bash scripts/phase9-controlled-rag.sh count
bash scripts/phase9-controlled-rag.sh active --page 1 --page-size 10
bash scripts/phase9-controlled-rag.sh pending
bash scripts/phase9-controlled-rag.sh audit \
  --evaluation-csv ../dataset/apcida_synthetic_sms_200.csv \
  --evaluation-text-column sms_text
```

`count` shows the number of active approved examples. `active` shows up to 20
at a time with their labels, source references, and approval metadata.
`pending` shows metadata for candidates awaiting embedding or approval. None
of these commands displays SMS content. `audit` also counts labels and sources
and lists IDs of duplicate or evaluation-overlapping examples; it changes no
records. To inspect one specific entry, use its numeric ID from `pending` or
`active`. For example:

```sh
bash scripts/phase9-controlled-rag.sh show --id 3
bash scripts/phase9-controlled-rag.sh show-active --id 102
```

`show` reads a staged candidate; `show-active` reads an approved example.
Replace `3` or `102` with the ID you want. Both commands display example text
in the private Mac terminal. The wrapper selects the controlled local database
and reads private credentials without printing them. Do not paste credentials
or example text into chat.

## Prepare a candidate file

Create a private UTF-8 CSV outside the Git repository, for example at
`~/Library/Application Support/ApCiDa/rag-review/candidates.csv`. Its first
line must be exactly:

```csv
external_id,content,label,reviewer,reviewed_at,source_reference
```

To create an empty candidate file on the Mac:

```sh
mkdir -p "$HOME/Library/Application Support/ApCiDa/rag-review"
chmod 700 "$HOME/Library/Application Support/ApCiDa/rag-review"
printf '%s\n' 'external_id,content,label,reviewer,reviewed_at,source_reference' > \
  "$HOME/Library/Application Support/ApCiDa/rag-review/candidates.csv"
chmod 600 "$HOME/Library/Application Support/ApCiDa/rag-review/candidates.csv"
nano "$HOME/Library/Application Support/ApCiDa/rag-review/candidates.csv"
```

The `printf` command replaces an existing file, so use it only when starting a
new candidate file. Add reviewed rows below the header in the editor.

Each following row represents one candidate. Use a unique `external_id`, the
approved message text in `content`, a human-verified `SCAM` or `SAFE` label,
the reviewer's name, an ISO 8601 review time with a time-zone offset, and a
traceable source reference. Quote CSV fields containing commas or line breaks.
Never use a model's verdict as the sole evidence for the label. Remove names,
phone numbers, account details, codes, and other personal information before
preparing the file. Keep the file private (`chmod 600`), and do not commit it.

## Validate without adding anything

```sh
bash scripts/phase9-controlled-rag.sh validate \
  --file "$HOME/Library/Application Support/ApCiDa/rag-review/candidates.csv" \
  --evaluation-csv ../dataset/apcida_synthetic_sms_200.csv \
  --evaluation-text-column sms_text
```

Validation checks the CSV structure and review metadata, duplicate IDs and
near-duplicate text against active and staged knowledge, and overlap with the
held-out evaluation dataset. It uses a read-only database transaction. It does
not stage, embed, approve, or print message text. These checks cannot establish
that a label is correct or that every personal detail was removed; a human
must do that review. Validation is a snapshot, so import repeats its checks.

## Stage and approve a reviewed candidate

Only after the candidate source, label, and text have been reviewed, stage it:

```sh
bash scripts/phase9-controlled-rag.sh import \
  --file "$HOME/Library/Application Support/ApCiDa/rag-review/candidates.csv" \
  --evaluation-csv ../dataset/apcida_synthetic_sms_200.csv \
  --evaluation-text-column sms_text
bash scripts/phase9-controlled-rag.sh pending
```

Import embeds candidates locally and leaves them pending. To inspect a page
without making changes:

```sh
bash scripts/phase9-controlled-rag.sh review-batch --page 1 --list-only \
  --evaluation-csv ../dataset/apcida_synthetic_sms_200.csv \
  --evaluation-text-column sms_text
```

This review command **prints candidate SMS text** in the Mac terminal. Check
the text, label, source, and duplicate status. The interactive `review-batch`
command with `--approver "Your Name"` then lets the reviewer select specific
IDs and requires an exact typed confirmation. Only approved entries become
active RAG knowledge. See the Phase 2C section of `README.md` for the full
review and rejection commands.
