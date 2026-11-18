# Gemma and RAG evaluation, 2026-11-13

## Architecture and fixed settings

The SMS API validates a request, then the configured analysis service returns `SCAM`, `SAFE`, or `SUSPICIOUS`. The protected production listener composes `rules.js` → RAG retrieval → Gemma through Ollama → `verdict.js`. Rules run first, but production keeps them in shadow mode, so Gemma's classification remains the final verdict. The strict production response contains the request ID, classification, confidence, and rationale; rule diagnostics are not added to that response.

Gemma is `gemma3:12b`. Query and approved-knowledge embeddings use `nomic-embed-text` at 768 dimensions. `knowledgeRepository.js` searches only active, approved `rag_knowledge` rows with the matching embedding model, returns at most three examples, and requires cosine similarity of at least 0.72. The rule thresholds are 30 for `SUSPICIOUS` and 60 for `SCAM`; phrase points are capped at 60. The live study used rules version 3, with no change to Gemma, RAG, thresholds, or the production verdict policy.

## Data audit and limitations

The existing 200-message synthetic corpus has 100 `SCAM` and 100 `SAFE` labels. The historical, development, and Phase 2G holdout subsets each have 25 of each label. The repository's exact/near-duplicate matcher found no duplicate pairs within the 200 rows, within each subset, or between the three subsets. A read-only check found no exact or near overlap between any of those datasets and the current 104 approved RAG rows. The existing RAG audit found all 104 retrievable, balanced at 52 `SCAM` and 52 `SAFE`, with no duplicate, overlap, or retrievability issues. These checks do not establish that the labels are correct; that needs independent human review.

The new [eight-message dataset](../dataset/apcida_three_class_exploratory_v1.json) has four proposed `SAFE`, two proposed `SUSPICIOUS`, and two proposed `SCAM` labels. It is based on the user's examples. The shortened-link case includes an actual synthetic short URL because the original sentence named a shortened link but contained no URL. Its labels are **proposed**, not independently adjudicated. Preflight found no duplicates within it or against the 104 approved RAG rows. The corpus is too small and deliberately selected to estimate real-world accuracy.

## Live three-class comparison

The [study runner](src/evaluation/threeClassStudy.js) evaluated the same eight messages in four sequential modes: rules only, Gemma only, Gemma plus RAG, and Gemma plus RAG with rules in shadow mode. It checked the local model digests and approved-knowledge fingerprint, blocked duplicate leakage before inference, and saved results after each message. The private [JSON report](../evaluation-results/three-class-exploratory-v1/report.json) contains IDs, predictions, scores, durations, and retrieved reference IDs/labels/similarities; it contains no SMS text, OTP, model rationale, or credentials. No run fell back to simulated model output.

| Mode | Exact | Macro F1 | SCAM precision | SCAM recall | SAFE warning rate | Mean latency | P95 latency |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Rules | 6/8 | 0.556 | undefined | 0/2 | 0/4 | 3 ms | 11 ms |
| Gemma | 6/8 | 0.730 | 1/1 | 1/2 | 1/4 | 9.14 s | 21.99 s |
| Gemma + RAG | 7/8 | 0.822 | 1/1 | 1/2 | 0/4 | 7.32 s | 9.69 s |
| Gemma + RAG + shadow rules | 7/8 | 0.822 | 1/1 | 1/2 | 0/4 | 11.14 s | 12.39 s |

The confusion matrix below gives each truth row as predictions `(SAFE, SUSPICIOUS, SCAM, ERROR)`:

| Mode | Truth SAFE | Truth SUSPICIOUS | Truth SCAM |
| --- | --- | --- | --- |
| Rules | (4, 0, 0, 0) | (0, 2, 0, 0) | (0, 2, 0, 0) |
| Gemma | (3, 1, 0, 0) | (0, 2, 0, 0) | (0, 1, 1, 0) |
| Gemma + RAG | (4, 0, 0, 0) | (0, 2, 0, 0) | (0, 1, 1, 0) |
| Gemma + RAG + shadow rules | (4, 0, 0, 0) | (0, 2, 0, 0) | (0, 1, 1, 0) |

`SUSPICIOUS` is its own truth and prediction class for per-class precision, recall, F1, macro F1, and exact accuracy. A `SUSPICIOUS` prediction on a `SCAM` truth row is **not** an exact scam detection, but is counted in the separately reported `scamWarningRecall`. A SAFE false-positive warning is either `SUSPICIOUS` or `SCAM` on a valid SAFE row. An inference error has no prediction, appears in the `ERROR` column, and lowers class recall; it is never treated as SAFE. Precision is undefined when a class has no predictions. The full report has per-class precision, recall, F1, median latency, and P90 latency. With only eight rows, P95 is effectively the slowest call and latency differences are not reliable comparative estimates.

The paired Gemma/RAG comparison had eight common successful messages. RAG changed one result: T06, a proposed SAFE parcel notification, from `SUSPICIOUS` to `SAFE`; its only retrieved reference was labeled SAFE at similarity 0.732. This is consistent with a helpful reference, but a single inference per mode cannot separate a RAG effect from model variation. T04, the informal account-code request, remained `SUSPICIOUS` in Gemma, RAG, and shadow modes despite its proposed `SCAM` label; RAG retrieved one SCAM reference at similarity 0.746. Its label and the model's evidence threshold deserve independent review. Rules also labeled T04 `SUSPICIOUS` at 55 points. Rules and Gemma disagreed on one of eight shadow-mode messages. Four of eight RAG messages retrieved no reference; both proposed SUSPICIOUS cases were among those four. T02 retrieved two SAFE and one SCAM reference but Gemma still returned SCAM, so retrieved labels should not be treated as votes.

## Historical Phase 2G comparison

The preserved Phase 2G reports use a different, 50-message two-class synthetic holdout and an earlier 100-record RAG snapshot. Gemma alone had 48/50 exact classifications and no errors. Gemma plus RAG had 46/50 exact classifications and two `OLLAMA_TIMEOUT` errors on SAFE rows. On the 48 messages completed by both, each mode had 46 exact classifications: RAG corrected one SAFE false warning and changed one SCAM from exact `SCAM` to `SUSPICIOUS`. The latter still counted as a warning. The historical experimental hybrid report used a non-shadow policy and a separate model run; it is not evidence about the current shadow policy.

Taken together, these runs **do not establish that RAG is better than Gemma alone**. The eight-message three-class study favors RAG by one case, while the historical paired 50-message results tie among completed calls and include two RAG timeouts. The studies also differ in knowledge snapshot and run conditions.

## Recommended next work

| Priority | Improvement | Expected impact | Complexity | Evidence |
| --- | --- | --- | --- | --- |
| 1 | Build a larger, independently labeled three-class set with informal Filipino/Cebuano, mixed language, OTP warnings, family claims, links, delivery, and ambiguous messages; keep it disjoint from RAG and development examples. | High | Medium | Current SUSPICIOUS labels are only two proposed examples; T04's label needs review. |
| 2 | Repeat paired Gemma/RAG runs under controlled uptime and model settings, recording errors and paired changes. | High | Medium | Historical RAG had two timeouts; one run per message cannot establish consistency. |
| 3 | Review retrieved examples by ID with a human, especially T02 and T04, and measure retrieval coverage and label diversity before changing top-K or 0.72. | Medium | Medium | Four of eight messages retrieved nothing; T02 returned mixed labels. |
| 4 | After label review, test a versioned Gemma prompt or structured evidence fields for informal code requests and low-confidence decisions. | Medium | Medium | T04 remained SUSPICIOUS with and without RAG. |
| 5 | Continue rules-only multilingual regression work in shadow mode; evaluate false warnings before any score or threshold change. | Medium | Low | Rules warned on both proposed scams but called neither exact SCAM; one shadow disagreement. |
| 6 | Consider an experimental hybrid verdict only after larger paired evidence shows fewer errors without added SAFE warnings. | Uncertain | Medium | Shadow mode does not alter the verdict; this study supplies no justification to enable an override. |

## Reproduce

From `apcida-ai-server` on the controlled Mac, with Ollama and the local approved RAG database available:

```sh
node src/evaluation/threeClassStudy.js \
  --env-file "$HOME/Library/Application Support/ApCiDa/controlled-server/production.env" \
  --preflight

node src/evaluation/threeClassStudy.js \
  --env-file "$HOME/Library/Application Support/ApCiDa/controlled-server/production.env"

npm test
```

The same output directory resumes its checkpoint if the dataset, code, model digests, and approved-knowledge fingerprint match. A later [tooling audit](RAG_EVALUATION_INVESTIGATION.md) corrected the median calculation and tightened checkpoint and paired-report validation. Because that revised the pipeline hash, the original study directory is preserved and cannot be resumed by the revised runner. `node src/evaluation/auditThreeClassReport.js` recomputes the corrected metrics from the preserved results without new inference. For a new trial, pass `--output-dir ../evaluation-results/three-class-exploratory-v1-trial2`. Reports under `evaluation-results` are local and ignored by Git. The Phase 2G source-hash freeze and historical reports were not changed. Its old hash check will not pass against the separately updated rules v3 working tree; reproduce the old pipeline only from the frozen source and knowledge snapshot.

The live study directly used the workspace rules v3. A running API process does not reload file edits automatically, so its loaded rule version may differ until it is restarted. This evaluation did not restart or change the production service.
