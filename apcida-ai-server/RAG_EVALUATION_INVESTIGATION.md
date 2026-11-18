# APCIDA evaluation follow-up, 2026-11-13

This investigation reviews the exploratory [three-class evaluation](THREE_CLASS_EVALUATION.md), the preserved Phase 2G/2H reports, the current 104 approved RAG records, and the separate read-only [RAG diagnostic](src/evaluation/ragInvestigation.js). It does not change classification settings, rules, verdict policy, model, or knowledge records.

## Evaluation tooling audit

The eight-message study runs all four modes on the same proposed labels. Its RAG preflight checks internal and approved-knowledge exact/near duplicates using the repository's normalized Dice matcher at 0.88, fingerprints the approved collection, and holds the shared knowledge lock while evaluating. The current knowledge workflow takes the corresponding exclusive lock for writes. Errors keep a null prediction and an error code; they are not converted to SAFE. The SAFE warning denominator includes only valid SAFE predictions, while class recall counts errored truth rows as misses. The four modes made separate sequential model calls, so C versus D latency differences can reflect run order and model variation even though shadow rules cannot alter the verdict.

Three tooling issues were confirmed and corrected for future runs:

1. The reported `median` was nearest rank rather than the arithmetic median for even-sized samples. The original report remains intact; the derived [audited report](../evaluation-results/three-class-exploratory-v1/audited-report.json) corrects Gemma 7,589 → 7,618 ms, Gemma+RAG 7,929 → 7,947.5 ms, and shadow 11,009 → 11,040.5 ms. Accuracy, F1, confusion matrices, and P95 are unchanged.
2. Paired comparison previously assumed IDs and truth labels matched; a malformed comparison could throw an unclear error or pair duplicates. It now validates row count, unique IDs, and truth labels before comparing successful calls.
3. The runner previously accepted historical output paths and checked only IDs/labels in a resumed checkpoint. It now restricts output to `three-class-*` directories and rejects malformed, errored-with-prediction, or text-bearing checkpoint rows. Dataset categories are limited to short slugs so they cannot carry SMS text into reports.

The original study report is a preserved result of the earlier runner. The corrected source hash intentionally prevents resuming its checkpoint with the revised runner. Use a new `--output-dir` for a fresh trial; use `node src/evaluation/auditThreeClassReport.js` to reproduce corrected metrics from the original inference results. The source-hash-frozen Phase 2G artifacts were not changed.

The leakage check is useful but limited: it catches normalized exact matches and near duplicates at Dice ≥ 0.88. It cannot prove semantic independence of different paraphrases or adjudicate labels. The exploratory eight labels remain proposed, not independently verified.

## Why four messages retrieved nothing

The diagnostic used the same `nomic-embed-text` embedding service and approved-record query, first at the production cutoff 0.72 and then read-only with the cutoff set to 0 **for inspection only**. Each of the four messages produced a valid 768-dimensional embedding. A repeat embedding had cosine similarity 1.000 and reproduced the same top score. Three diagnostic runs returned identical nearest scores with the same model digests and approved-knowledge fingerprint. Database retrieval for these four messages took 1–27 ms in the final versioned run.

| Message ID | Category | Highest approved similarity | Nearest label | Margin below 0.72 |
| --- | --- | ---: | --- | ---: |
| T01 | OTP warning | 0.546 | SCAM | 0.174 |
| T03 | Casual greeting | 0.703 | SCAM | 0.017 |
| T05 | Family/new number | 0.676 | SAFE | 0.044 |
| T07 | Shortened link | 0.575 | SAFE | 0.145 |

The **confirmed immediate cause** is the 0.72 threshold: no approved vector for these messages reached it. The embedding service was functioning and repeatable in this test. That does not establish that its semantic representation is optimal. T03 would retrieve a SCAM-labeled reference at 0.703 if the cutoff were lowered to 0.70, despite its proposed SAFE label. T05 and T07 also have SAFE-labeled nearest references despite proposed SUSPICIOUS labels. These are reasons to keep the production threshold unchanged.

Knowledge coverage is a plausible contributor. A read-only phrase proxy found one approved SAFE OTP-warning example (T01 similarity 0.532), no obvious casual-greeting example, one SCAM family/new-number example (T05 similarity 0.659), and one SCAM short-link example (T07 similarity 0.495). This count is a narrow lexical check, not a full human review of semantic coverage. The current collection has 52 SCAM and 52 SAFE examples and no SUSPICIOUS label. The low score of related examples could reflect corpus coverage, cross-language embedding behavior, or both; these data do not isolate their relative contribution. The complete nearest IDs, labels, and scores are in the private [diagnostic report](../evaluation-results/rag-investigation-2026-11-13-v3/report.json), with no message text or OTPs.

For the four messages that did retrieve context, the prior study recorded: T02 at 0.783 SAFE, 0.732 SAFE, and 0.730 SCAM; T04 at 0.746 SCAM; T06 at 0.732 SAFE; and T08 at 0.730 SAFE. Mixed labels in T02 show why retrieval must remain supporting context rather than a vote.

## Informal account-code label (T04)

The SMS asks the recipient to send a code so the sender can verify an account. That is a concerning request. The text does not specify that the code is an OTP or password, identify the sender, claim institutional authority, include a destination, or independently establish deception. Under the current evidence-based prompt, `SUSPICIOUS` is defensible from the SMS alone. A `SCAM` label is also arguable if the research labeling policy treats any request to disclose an account-verification code to another person as fraudulent; that policy assumption is not explicit in this message. The proposed `SCAM` label therefore needs independent adjudication before it is counted as a model error.

Gemma returned SUSPICIOUS without RAG (LOW confidence), with RAG (MEDIUM), and in the shadow run (LOW); one SCAM reference at 0.746 did not change the decision. Rules v3 detected a credential-request indicator but scored 55, also yielding SUSPICIOUS. T02's explicit OTP request was classified SCAM by Gemma, but that comparison changes more than one wording detail and cannot prove which word caused the difference. No prompt, score, or threshold change is justified by this single disputed label.

## Phase 2G timeout stage

The preserved Phase 2G RAG report records `OLLAMA_TIMEOUT` on SF016 (653,711 ms total) and SF046 (125,073 ms total). In this pipeline, embedding failures use `EMBEDDING_TIMEOUT` and retrieval failures use `RAG_DATABASE_UNAVAILABLE`; `OLLAMA_TIMEOUT` is emitted by the Ollama chat request. **The confirmed failure stage is Gemma chat, not embedding or PostgreSQL retrieval.** The original report did not record per-stage timestamps, so the exact historical chat wait and machine state cannot be reconstructed.

| Run | ID | Embedding | DB retrieval | Gemma chat | Outcome |
| --- | --- | ---: | ---: | ---: | --- |
| Phase 2G original | SF016 | unrecorded | unrecorded | timed out | 653.7 s total |
| Phase 2G original | SF046 | unrecorded | unrecorded | timed out | 125.1 s total |
| Phase 2H retry | SF016 | combined pre-chat ≈0.6 s | combined | 17.9 s | SAFE |
| Phase 2H retry | SF046 | combined pre-chat ≈1.2 s | combined | 5.8 s | SAFE |
| Current diagnostic, first | SF016 | 20 ms | 2 ms | 20.9 s | SAFE |
| Current diagnostic, first | SF046 | 1,477 ms | 56 ms | 6.3 s | SAFE |
| Current diagnostic, second | SF016 | 26 ms | 2 ms | 7.9 s | SAFE |
| Current diagnostic, second | SF046 | 17 ms | 3 ms | 5.7 s | SAFE |
| Current diagnostic, final | SF016 | 27 ms | 3 ms | 8.0 s | SAFE |
| Current diagnostic, final | SF046 | 67 ms | 248 ms | 6.3 s | SAFE |

The chat call dominates current end-to-end time; database retrieval is consistently small. The 653.7-second historical duration greatly exceeds the configured 120-second per-call timeout, which is consistent with a host sleep or suspended event loop, but not proof. The project README recorded a contemporaneous sleep correlation. Current `pmset` logs begin after the original October run, so that correlation cannot be independently rechecked now. Model loading or resource contention remains another hypothesis. Raising the timeout would not address host availability and is unsupported by these measurements.

## Prioritized action plan

| Priority | Action | Evidence and status | Production change now? |
| --- | --- | --- | --- |
| 1 | For future paired evaluations, keep the Mac awake, record power state, and capture stage start/end times and errors per message. Repeat the frozen IDs and new cases under controlled load. | Confirmed chat-stage timeouts; sleep/resource cause unconfirmed. | No classifier change. Operational control and evaluation instrumentation only. |
| 2 | Independently adjudicate T04 and build a larger three-class holdout, including informal account-code and legitimate code-sharing counterexamples. | Proposed SCAM label is debatable from text alone; eight cases are insufficient. | No. |
| 3 | Have a reviewer inspect nearest approved examples by ID and map missing semantic categories before proposing new consented, curated RAG examples. Re-evaluate retrieval coverage and errors on a separate dataset. | Four maxima below 0.72; sparse lexical coverage; related vectors also score low. | No threshold or knowledge change yet. |
| 4 | Repeat Gemma/RAG comparisons with multiple runs and paired successful rows; report errors separately from misclassifications. | One eight-case improvement, but historical 48-common-row tie and two RAG timeouts. | No verdict-policy change. |
| 5 | Consider prompt, embedding, or hybrid-policy experiments only after the label and coverage studies show a repeatable error pattern. | Current evidence cannot isolate prompt versus embedding/corpus limitations. | None justified now. |

## Reproduce and test

From `apcida-ai-server`, with local Ollama and the controlled PostgreSQL database available:

```sh
node src/evaluation/auditThreeClassReport.js
node src/evaluation/ragInvestigation.js \
  --env-file "$HOME/Library/Application Support/ApCiDa/controlled-server/production.env" \
  --output-dir ../evaluation-results/rag-investigation-new-trial
npm test
```

The diagnostic refuses to overwrite its previous report and writes only reference IDs, labels, similarities, stage durations, and model digests to mode-0600 files under a mode-0700 directory. The audited report derives metrics from the preserved study results without another model call. A new study with the corrected runner must use a new `three-class-*` output directory because its pipeline hash differs from the original report.
