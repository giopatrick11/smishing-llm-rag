# Rules v3 regression evaluation

Rules v3 narrows credential and identity-document requests to a single sentence or clause, requires a direct request for a secret, and recognizes selected informal Filipino and Cebuano phrases. It adds a family/new-number money-request warning and a `diagnosticCode` that distinguishes no matched indicators from indicators below the warning threshold. Existing indicator points, classification thresholds, Gemma prompt, RAG retrieval, and production shadow-mode configuration are unchanged.

The 18 hand-picked synthetic cases in `test/fixtures/rules-regression.json` include the eight proposed messages, legitimate counterexamples, and a warning followed by a real credential request. Their labels are proposed examples, not verified ground truth. The original text-only “shortened link” case contains no URL, so the rules still return `SAFE`; a separate case with an actual short URL returns `SUSPICIOUS`.

| Rules-only check | Baseline v2 | Candidate v3 |
| --- | ---: | ---: |
| Proposed warning cases flagged | 3/7 | 6/7 |
| Proposed safe cases flagged | 1/11 | 0/11 |
| Exact three-class agreement with proposed labels | 11/18 | 14/18 |

The changed outcomes are: informal account-code request `SAFE` → `SUSPICIOUS`, new-number family money request `SAFE` → `SUSPICIOUS`, warning followed by a credential request `SAFE` → `SUSPICIOUS`, and the cross-sentence password example `SUSPICIOUS` → `SAFE`. The Cebuano OTP request remains `SUSPICIOUS` because its credential indicator scores 55; no score or threshold was raised.

On the previously inspected, synthetic 50-row development set, both versions classified all 25 labeled scams as `SCAM` and all 25 labeled safe messages as `SAFE`. This is a regression check, not an estimate of real-world accuracy. No Gemma or RAG inference was run for this evaluation.

Reproduce the comparison with `node scripts/evaluate-rule-regression.js`. The generated, ignored JSON reports are under `../evaluation-results/rules-v3-targeted-regression/`. The script compares against the pinned pre-change commit, so later edits do not replace the baseline. `npm test` checks the new examples and the existing API and policy behavior.

The original Phase 2G freeze manifest records a hash of the old `rules.js`. This intentional rules change means its source-hash verification will no longer match; the earlier evaluation artifacts remain untouched. A future model/RAG comparison should use a newly versioned evaluation and independently reviewed cases.
