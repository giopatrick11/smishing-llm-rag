# APCIDA manuscript rewrite map

Companion to `MANUSCRIPT_GITHUB_GAP_ANALYSIS.md`. Page numbers refer to the 100-page PDF `Manuscript - ApCiDa (1).pdf`. Path shorthand: `A/` = `.tmp-mobile-notification-fix/app/src/main/java/com/apcida/smishingdetector/`; `AD/` = `.tmp-mobile-notification-fix/app/src/debug/java/com/apcida/smishingdetector/`; `S/` = `apcida-ai-server/src/`. The primary audit is of the checked-out supervised beta code; local MediaPipe code is debug-only. A “figure” item names an existing PDF figure/caption, not a claim that its image contents were machine interpreted. Status describes the scale of manuscript revision, not implementation maturity. P0–P3 are change priorities.

## Front matter

### Title, PDF p.1 — P0

**Status:** Rewrite. **Why it needs updating:** “Keyword Pre-Filtering and On-Device LLM Contextual Analysis” describes the former prototype. **Current system evidence:** `A/controller/SmsController.kt -> receiveAndAnalyzeRules`; `S/production/createProductionApp.js -> createAnalysisService`; `.tmp-mobile-notification-fix/app/build.gradle.kts` beta/debug dependencies. **What the revised manuscript must say:** Name the supervised local-screening plus consented remote Gemma 3 12B/RAG artifact, with a title appropriate to the actual research evaluation. **What must be removed:** Unqualified “on-device LLM” in the artifact title. **What new material should be added:** A build-mode/methodology subtitle if needed. **Figures/tables that must be regenerated:** Title page.

## Chapter I

### §1.1 Background of the Study, PDF pp.2–4 — P0

**Status:** Major Revision. **Why it needs updating:** Final paragraphs introduce a keyword-gated on-device Gemma system. **Current system evidence:** `A/backend/receiver/SmsReceiver.kt -> onReceive`; `A/backend/worker/SmsProcessingWorker.kt -> doWork`; `S/services/rag.js -> analyze`. **What the revised manuscript must say:** Explain local initial warnings and remote consented context analysis; discuss network/failure limits. **What must be removed:** Claims that keyword score alone selects model invocation. **What new material should be added:** Privacy and latency tradeoffs of server inference. **Figures/tables that must be regenerated:** None in this section.

### §1.2 Statement of the Problem / research questions 1–5, PDF pp.4–5 — P0

**Status:** Rewrite. **Why it needs updating:** Questions 2–4 test the wrong architecture and binary distinction. **Current system evidence:** `S/production/smsContract.js -> productionSmsResponseSchema`; `A/backend/network/RemoteVerdictPolicy.kt`; `S/db/knowledgeRepository.js -> search`. **What the revised manuscript must say:** Frame measurable questions about three-class classification, local warning versus verified verdict, RAG versus no RAG, latency/error rate, and awareness if surveyed. **What must be removed:** Selective on-device prefilter premise. **What new material should be added:** Explicit baselines, labeled datasets and consented pilot scope. **Figures/tables that must be regenerated:** Research-question/evaluation alignment table if one is introduced.

### §1.3 Objectives of the Study, PDF pp.5–6 — P0

**Status:** Rewrite. **Why it needs updating:** Objective 2 specifies on-device model only for flagged messages; objective 5 requires awareness evidence. **Current system evidence:** `A/controller/SmsController.kt`; `S/production/createProductionApp.js`; `S/evaluation/threeClassMetrics.js`. **What the revised manuscript must say:** Define delivered mobile/server artifact and a metric for every effectiveness/awareness objective. **What must be removed:** Unsupported battery-efficiency implication from selective invocation. **What new material should be added:** RAG and unavailability objectives only if evaluated. **Figures/tables that must be regenerated:** Objective-to-metric table.

### §1.4 Significance of the Study, PDF pp.6–7 — P1

**Status:** Major Revision. **Why it needs updating:** Offline usability and device privacy are overstated. **Current system evidence:** `A/backend/remote/ProductionSmsTransport.kt -> analyze`; `A/backend/network/RemoteVerdictPolicy.kt -> localFallback`. **What the revised manuscript must say:** Local provisional warnings can function without remote service; verified AI needs connectivity and consent. **What must be removed:** Blanket offline/private description. **What new material should be added:** Value and limitations for Filipino users in remote-pilot conditions. **Figures/tables that must be regenerated:** None.

### §1.5 Scope and Delimitations, PDF pp.7–9 — P0

**Status:** Rewrite. **Why it needs updating:** Paragraphs say all inference stays on device and internet only updates/reports. **Current system evidence:** `.tmp-mobile-notification-fix/app/build.gradle.kts` build gates; `A/backend/consent/AutomaticAnalysisPolicy.kt`; `A/backend/worker/HistoricalSmsBatchWorker.kt`; `S/production/createProductionApp.js`. **What the revised manuscript must say:** SMS-only Android scope, min SDK 29, beta versus debug/release, consent and enrollment, historical batch exception, remote dependency, offline `UNVERIFIED`/local warning behavior, lack of automatic model learning. **What must be removed:** “No cloud/external AI” and unsupported automatic keyword/tip update. **What new material should be added:** Server/database boundary and failure conditions. **Figures/tables that must be regenerated:** Scope table.

### §1.6 Definition of Terms, PDF pp.10–12 — P1

**Status:** Major Revision. **Why it needs updating:** Gemma 2B/MediaPipe definition conflates artifact paths; `SAFE`/`LEGITIMATE` terms conflict. **Current system evidence:** `S/config/env.js`; `S/services/embeddings.js`; `A/view/presentation/DetectionPresentation.kt`; `AD/backend/gemma/GemmaValidator.kt`. **What the revised manuscript must say:** Define server Gemma 3 12B/Ollama, debug Gemma 3 1B/MediaPipe, RAG, embedding, cosine similarity, shadow rules, provisional versus verified labels, report payload. **What must be removed:** 2B as current model. **What new material should be added:** `UNVERIFIED`, consent, and PostgreSQL/pgvector terms. **Figures/tables that must be regenerated:** Glossary table if present.

## Chapter II

### §2.1.1–2.1.4 Related Literature, PDF pp.13–15 — P1

**Status:** Minor Revision. **Why it needs updating:** User behavior, ML, feature selection, and URL framing must connect to the revised artifact. **Current system evidence:** `S/services/rules.js`; `S/services/ollama.js`; `A/view/fragment/SafetyTipsFragment.kt`. **What the revised manuscript must say:** Keep relevant literature but distinguish literature claims from validated APCIDA performance. **What must be removed:** Inferences that URL heuristics themselves verify a domain or sender. **What new material should be added:** Literature for false warnings, code switching and human review. **Figures/tables that must be regenerated:** Related-systems table as needed; verify original citations separately.

### §2.1.5–2.1.7 Local pipeline and lightweight LLM, PDF pp.15–16 — P1

**Status:** Major Revision. **Why it needs updating:** These subsections present the deployed model as on-device MediaPipe. **Current system evidence:** `S/production/createProductionApp.js -> createAnalysisService`; `AD/backend/gemma/GemmaValidator.kt`; `.tmp-mobile-notification-fix/app/build.gradle.kts`. **What the revised manuscript must say:** Separate historical on-device feasibility from beta server architecture; discuss remote inference/retrieval literature. **What must be removed:** Current deployment assertions based solely on Gemma 2B. **What new material should be added:** RAG and operational reliability references with verified external citations. **Figures/tables that must be regenerated:** None.

### §2.2 Related Studies/Systems, PDF pp.16–21 — P1

**Status:** Major Revision. **Why it needs updating:** APCIDA comparison row uses 2B/MediaPipe/offline characteristics. **Current system evidence:** `S/config/env.js`; `S/services/rag.js`; `A/backend/remote/ProductionSmsTransport.kt`. **What the revised manuscript must say:** Compare the actual local-screening/remote-verification architecture, clearly marking experimental debug path. **What must be removed:** Unverified equivalence with solely offline systems. **What new material should be added:** Relevant retrieval and consented remote-analysis comparisons. **Figures/tables that must be regenerated:** Related-systems table on PDF pp.19–21.

### §2.3 Synthesis and research gap, PDF pp.21–22 — P1

**Status:** Major Revision. **Why it needs updating:** Synthesis concludes the gap is solved by purely on-device privacy/offline operation. **Current system evidence:** `A/backend/remote/ProductionSmsTransport.kt`; `S/production/reportContract.js`. **What the revised manuscript must say:** State a defensible gap for localized SMS classification with local warnings, remote contextual/RAG analysis, explicit failure and consent. **What must be removed:** Absolute privacy/offline conclusion. **What new material should be added:** Research limitations arising from connectivity and SMS data transfer. **Figures/tables that must be regenerated:** None.

### §2.4 Design Principles, PDF pp.22–24 — P1

**Status:** Major Revision. **Why it needs updating:** Selective on-device model invocation is listed as a principle. **Current system evidence:** `A/controller/SmsController.kt -> receiveAndAnalyzeRules`; `A/backend/worker/SmsProcessingWorker.kt`; `S/services/rag.js`. **What the revised manuscript must say:** Local provisional warning, authenticated remote check, retrieval evidence, plain-language explanation, and privacy controls. **What must be removed:** Model invocation rate as battery-saving mechanism in beta. **What new material should be added:** Graceful unavailable state and explicit trust boundaries. **Figures/tables that must be regenerated:** Design-principles summary if present.

### §2.5 Conceptual Framework, PDF pp.25–26 — P0

**Status:** Rewrite. **Why it needs updating:** Framework describes two-stage local pipeline. **Current system evidence:** `A/controller/SmsController.kt`; `S/production/createProductionApp.js`. **What the revised manuscript must say:** Show local rule warning, consent/gate, remote embedding/retrieval/model, verified/failure result, user feedback. **What must be removed:** Claim that low-score messages are final SAFE. **What new material should be added:** User consent and server processing as explicit concepts. **Figures/tables that must be regenerated:** IPO/BPM in next subsection.

### §2.5.1 Conceptual Framework Models, PDF pp.26–29 — P0

**Status:** Rewrite. **Why it needs updating:** Fig. 1 IPO and Fig. 2 BPM have incorrect participants/data arrows. **Current system evidence:** `A/backend/receiver/SmsReceiver.kt`; `A/backend/remote/ProductionSmsTransport.kt`; `S/db/knowledgeRepository.js`; `A/backend/network/ReportApiService.kt`. **What the revised manuscript must say:** Device and server processes, consented SMS flow, provisional/verified state, separate report flow. **What must be removed:** “Only flagged messages reach Gemma” and “only anonymized report metadata.” **What new material should be added:** Network failure/timeout branch and manual batch scope. **Figures/tables that must be regenerated:** Fig. 1 IPO; Fig. 2 BPM.

## Chapter III

### §3.1 Research Design, PDF pp.30–32 — P1

**Status:** Major Revision. **Why it needs updating:** DSR activities describe a different artifact. **Current system evidence:** `S/production/createProductionApp.js`; `A/backend/worker/SmsProcessingWorker.kt`; `S/evaluation/threeClassStudy.js`. **What the revised manuscript must say:** Identify implemented beta, development experiments, and planned participant evaluation as distinct phases. **What must be removed:** Conflation of prototype testing with final evaluation. **What new material should be added:** Architecture and version snapshot for each phase. **Figures/tables that must be regenerated:** Research design matrix.

### §3.2 Research Framework, PDF pp.32–34 — P1

**Status:** Major Revision. **Why it needs updating:** Figure 3.1 build/evaluate cycle specifies local 2B and keyword threshold. **Current system evidence:** `S/production/createProductionApp.js`; `S/study/worker.js`; `A/backend/detection/BackendKeywordRules.kt`. **What the revised manuscript must say:** Map DSR activities to built mobile/server components and completed vs pending evaluation. **What must be removed:** Obsolete model/runtime language. **What new material should be added:** Separate server knowledge approval and participant-label workflow. **Figures/tables that must be regenerated:** Fig. 3.1 DSR framework.

### §3.3 Problem Identification and Motivation, PDF pp.35–36 — P2

**Status:** Minor Revision. **Why it needs updating:** User reporting and corrections are presented as future shortcomings. **Current system evidence:** `A/view/dialog/ReportFormDialog.kt`; `S/production/createProductionApp.js -> POST /api/v1/reports`. **What the revised manuscript must say:** Preserve problem motivation but distinguish delivered feedback function from unproven learning benefits. **What must be removed:** Wording that suggests automatic prompt/keyword updates after reports. **What new material should be added:** Human review boundary. **Figures/tables that must be regenerated:** None.

### §3.4 Objectives of the Solution, PDF pp.36–37 — P0

**Status:** Rewrite. **Why it needs updating:** It promises threshold calibration and keyword-triggered local Gemma. **Current system evidence:** `A/backend/detection/BackendKeywordRules.kt -> analyze`; `S/services/rules.js -> analyzeRules`; `A/controller/SmsController.kt`. **What the revised manuscript must say:** Fixed local score thresholds, role of shadow server rules, three-class verified outcome and offline provisional state. **What must be removed:** Unimplemented gating/illustrative scoring as final method. **What new material should be added:** Failure and privacy objectives with measures. **Figures/tables that must be regenerated:** Solution objective table.

### §3.5 Research Locale and Participants, PDF pp.37–40 — P1

**Status:** Major Revision. **Why it needs updating:** Sampling/data wording assumes anonymized local logs and does not describe separate study consent. **Current system evidence:** `S/study/contract.js -> validateBatch`; `S/db/migrations/009_study_contributions.sql`; `S/db/migrations/010_unlabeled_study_contributions.sql`. **What the revised manuscript must say:** Define actual recruitment/consent, selected SMS contribution, independent expert labels, exclusions, retention and withdrawal; state sample size only when known. **What must be removed:** Unsupported completed participant claims. **What new material should be added:** Text filtering and possible residual identifiability limits. **Figures/tables that must be regenerated:** Participant/data-flow table.

### §3.6 Artifact Design and Development Plan, PDF pp.40–41 — P0

**Status:** Rewrite. **Why it needs updating:** It says all detection is offline and the server only receives optional reports. **Current system evidence:** `A/backend/worker/SmsProcessingWorker.kt`; `S/production/createProductionApp.js`; `S/db/knowledgeRepository.js`. **What the revised manuscript must say:** Realized client, controlled server, Ollama, embedding, pgvector, Room and API; identify build gates. **What must be removed:** Current-tense local-only claims. **What new material should be added:** Versioned development chronology and remaining deployment conditions. **Figures/tables that must be regenerated:** Architecture table.

### §3.7 Evaluation Framework, PDF pp.41–43 — P0

**Status:** Rewrite. **Why it needs updating:** Contextual accuracy is only measured for keyword-flagged messages; metrics omit RAG/failures/three-class. **Current system evidence:** `S/evaluation/threeClassMetrics.js`; `S/evaluation/metrics.js`; `S/evaluation/runHybrid.js`; `evaluation-results/three-class-exploratory-v1/audited-report.json`. **What the revised manuscript must say:** Predefine datasets, splits, ground truth, confusion matrix, per-class metrics, warning rate, latency, timeout and RAG/no-RAG paired comparisons; separate technical and usability evaluation. **What must be removed:** Selective Gemma Invocation Rate as core metric unless redefined for beta. **What new material should be added:** Error denominator, 8-case exploration limitation, independent participant study protocol. **Figures/tables that must be regenerated:** Evaluation plan and metrics tables.

### §3.8 Data Gathering Procedures, PDF pp.43–46 — P0

**Status:** Rewrite. **Why it needs updating:** It asserts raw SMS remains local. **Current system evidence:** `A/backend/remote/ProductionSmsTransport.kt`; `A/backend/network/ReportApiService.kt`; `S/study/contract.js`. **What the revised manuscript must say:** Describe three distinct flows: automatic consented beta inference, explicitly consented report, and optional study contribution. **What must be removed:** “Only anonymized report metadata” and “all SMS processing on device.” **What new material should be added:** Enrollment, selection, consent revocation, encrypted storage, researcher access and provenance. **Figures/tables that must be regenerated:** Data-collection flow table.

### §3.9 Data Analysis, PDF pp.46–49 — P0

**Status:** Rewrite. **Why it needs updating:** Formulas assume flagged-only Gemma and local override. **Current system evidence:** `S/evaluation/threeClassMetrics.js`; `S/evaluation/runHybrid.js`; `A/controller/SmsController.kt`; `S/production/createProductionApp.js`. **What the revised manuscript must say:** Use actual three-class confusion and success/error denominators, paired RAG comparison, local versus remote state analysis, and explicit synthetic/real-world separation. **What must be removed:** Old invocation/override formulas as if measured in beta. **What new material should be added:** Missing-data/timeout treatment and inference latency percentiles. **Figures/tables that must be regenerated:** Formulas and analysis tables.

### §3.10 Ethical Considerations, PDF pp.49–51 — P0

**Status:** Rewrite. **Why it needs updating:** Multiple paragraphs say no raw SMS leaves device. **Current system evidence:** `S/production/smsContract.js`; `S/production/reportContract.js`; `S/production/privacy.js`; `S/db/migrations/007_production_reports.sql`. **What the revised manuscript must say:** Raw text and sender travel over approved HTTPS after AI consent; reports include SMS text after separate consent; describe encrypted server persistence, default inference-cache/report retention, deletion/withdrawal, reviewer access, and residual privacy risk. **What must be removed:** Absolute anonymity and local-only statements. **What new material should be added:** Distinct consent scopes and data minimization limits. **Figures/tables that must be regenerated:** Data-flow/privacy table.

## Chapter IV

### §4.1 Overview of the Proposed Artifact, PDF pp.54–56 — P0

**Status:** Rewrite. **Why it needs updating:** Intro and Fig. 4.1.1 show selective local 2B validation. **Current system evidence:** `A/controller/SmsController.kt`; `A/backend/worker/SmsProcessingWorker.kt`; `S/production/createProductionApp.js`. **What the revised manuscript must say:** Present implemented supervised beta and distinguish debug prototype; specify provisional and verified outcomes. **What must be removed:** 2B/MediaPipe as beta core. **What new material should be added:** Network and consent gates. **Figures/tables that must be regenerated:** Fig. 4.1.1 Current System Activity Diagram.

### §4.2 System Architecture and §4.2.1 Architectural Style, PDF pp.56–58 — P0

**Status:** Rewrite. **Why it needs updating:** “Three layers entirely within Android” omits most beta components. **Current system evidence:** `A/backend/remote/ProductionSmsTransport.kt`; `S/production/createProductionApp.js`; `S/services/rag.js`; `S/db/knowledgeRepository.js`. **What the revised manuscript must say:** Draw Android UI/intake/Room/workers, HTTPS authenticated server, Ollama models, PostgreSQL RAG/report/inference stores, admin/study boundary. **What must be removed:** Optional-server-only description. **What new material should be added:** Trust boundaries and dependency/fallback matrix. **Figures/tables that must be regenerated:** Layer/architecture diagram and component table.

### §4.2.2 Security Framework, PDF p.58 — P0

**Status:** Major Revision. **Why it needs updating:** Generic security prose obscures transmitted raw SMS. **Current system evidence:** `.tmp-mobile-notification-fix/app/src/main/AndroidManifest.xml`; `A/backend/network/ProductionEndpointPolicy.kt`; `S/production/security.js`; `S/production/privacy.js`. **What the revised manuscript must say:** Identify concrete HTTPS/host check, per-install auth, rate limits, AES-GCM/HMAC at rest, backups disabled, report review access and retention. **What must be removed:** Unqualified anonymity or broad “secure storage” without control evidence. **What new material should be added:** Threat model and remaining risks. **Figures/tables that must be regenerated:** Security-control/data-location table.

### §4.2.3 Gemma Integration Design, PDF pp.59–60 — P0

**Status:** Rewrite. **Why it needs updating:** It prints an obsolete prompt/model/runtime/latency. **Current system evidence:** `S/services/ollama.js -> SYSTEM_PROMPT/analyze`; `S/validators/sms.js`; `S/services/rag.js`; `AD/backend/gemma/GemmaValidator.kt`. **What the revised manuscript must say:** Server Gemma 3 12B JSON schema, three-class result, retrieved examples as contextual data, model-reported confidence, timeout/errors; separately label debug 1B INT4. **What must be removed:** 2B startup, 500 MB, 2–4 s unverified claims. **What new material should be added:** Actual measured evaluation latency by dataset; prompt-injection handling. **Figures/tables that must be regenerated:** Model/runtime comparison table.

### §4.2.4 Keyword Weighting and Risk Threshold Design, PDF pp.60–62 — P0

**Status:** Rewrite. **Why it needs updating:** Representative weight table does not match active rule engine; threshold no longer gates remote model. **Current system evidence:** `A/backend/detection/BackendKeywordRules.kt -> analyze`; `S/services/rules.js -> analyzeRules`; `A/backend/detection/RiskScorer.kt` legacy. **What the revised manuscript must say:** Strongest indicator per category; phrase cap 60; URL contribution 5/35/45; effective max 105; 30/60 boundaries; local v2 versus shadow server v3, clause/negation/family-rule differences. **What must be removed:** 30/25/20/35/40/10 illustration as deployed settings and pending-threshold language. **What new material should be added:** Reproducible pseudocode and version-divergence limitation. **Figures/tables that must be regenerated:** Weight table and score formula.

### §4.3.1 Activity Diagram, PDF pp.62–64 — P0

**Status:** Rewrite. **Why it needs updating:** Current figure's decision branches use threshold-gated local model. **Current system evidence:** `A/backend/receiver/SmsReceiver.kt`; `A/backend/worker/SmsProcessingWorker.kt`; `A/backend/network/RemoteVerdictPolicy.kt`. **What the revised manuscript must say:** Start with SMS, local row and warning, consent/gate, queued network job, server retrieval/inference, success/fail and UI update. **What must be removed:** Final SAFE below local threshold. **What new material should be added:** Expiry and cancellation branch. **Figures/tables that must be regenerated:** §4.3.1 activity diagram and Fig. 4.1.1.

### §4.3.2 Use Case Diagram, PDF pp.64–65 — P0

**Status:** Rewrite. **Why it needs updating:** Actors omit authenticated server, enrollment and separate consent. **Current system evidence:** `A/view/fragment/OnboardingFragment.kt`; `A/view/fragment/SettingsFragment.kt`; `A/view/fragment/MessagesFragment.kt`; `S/production/createProductionApp.js`. **What the revised manuscript must say:** User permission/enrollment/AI consent, automatic analysis, view result, report with separate consent, safety tips, optional historical batch and study. **What must be removed:** Unsupported automatic tip refresh/use cases. **What new material should be added:** Server/admin/researcher actors only for actual capabilities. **Figures/tables that must be regenerated:** Fig. 4.3.2.1.

### §4.3.3 UC-1 Grant SMS Access, PDF pp.65–66 — P1

**Status:** Major Revision. **Why it needs updating:** It says granting SMS permission loads Gemma 2B into memory. **Current system evidence:** `.tmp-mobile-notification-fix/app/build.gradle.kts`; `A/view/fragment/OnboardingFragment.kt`; `A/backend/consent/AiProtectionConsentStore.kt`. **What the revised manuscript must say:** Separate Android SMS permission from beta enrollment and AI Protection consent. **What must be removed:** Model-load postcondition. **What new material should be added:** Denied-consent and unconfigured-host flows. **Figures/tables that must be regenerated:** UC-1 table.

### §4.3.3 UC-2 Automatic SMS Monitoring, PDF pp.66–67 — P0

**Status:** Rewrite. **Why it needs updating:** Steps 3–8 use Room keyword lookup, threshold-gated local 2B and binary output. **Current system evidence:** `A/controller/SmsController.kt -> receiveAndAnalyzeRules/applyRemoteResult`; `S/production/createProductionApp.js`; `A/backend/network/RemoteVerdictPolicy.kt`. **What the revised manuscript must say:** Actual local built-in rule engine, provisional `UNVERIFIED` or warning, remote eligibility independent of score, three-class result, timeout/consent state. **What must be removed:** Automatic below-threshold SAFE and 2B requirement. **What new material should be added:** Idempotency and WorkManager queue. **Figures/tables that must be regenerated:** UC-2 flow table.

### §4.3.3 UC-3 View Alert and Analysis, PDF pp.67–68 — P1

**Status:** Major Revision. **Why it needs updating:** It assumes every alert has Gemma rationale/confidence and only SCAM outcomes. **Current system evidence:** `A/view/presentation/DetectionPresentation.kt`; `A/view/fragment/MessageDetailFragment.kt`; `A/view/presentation/NotificationCopy.kt`; `A/controller/SmsController.kt`. **What the revised manuscript must say:** Distinguish provisional warning, remote `SUSPICIOUS`/`SCAM`, remote `SAFE`, and `UNVERIFIED`; confidence is self-reported. **What must be removed:** Guaranteed rationale, high-confidence implication, and blanket SAFE notification. **What new material should be added:** Current screen states and screenshots. **Figures/tables that must be regenerated:** UC-3 table, detail-screen figures.

### §4.3.3 UC-4 Report Detection Feedback, PDF pp.68–69 — P0

**Status:** Rewrite. **Why it needs updating:** Old reason options and no-text payload are false. **Current system evidence:** `A/view/dialog/ReportFormDialog.kt`; `A/backend/reporting/ReportSnapshotFactory.kt`; `A/backend/network/ReportApiService.kt`; `S/production/reportContract.js`. **What the revised manuscript must say:** Actual detection-issue choices, required SMS-text review/RAG-candidate consent, queued local snapshot, authenticated POST `/api/v1/reports`, encrypted server review and no automatic knowledge promotion. **What must be removed:** Anonymized-only and automatic prompt/keyword improvement claims. **What new material should be added:** Retry, expiry, status and human approval. **Figures/tables that must be regenerated:** UC-4 table and reporting sequence.

### §4.3.3 UC-5 Safety Tips, PDF pp.69–70 — P2

**Status:** Minor Revision. **Why it needs updating:** It describes server refresh/fallback not wired in current production route. **Current system evidence:** `A/backend/database/DatabaseSeeder.kt`; `A/view/fragment/SafetyTipsFragment.kt`; `S/production/createProductionApp.js`. **What the revised manuscript must say:** XML-seeded local Room safety tips available offline. **What must be removed:** Fetch-newer-content steps and network error exception. **What new material should be added:** Seed/update limitation. **Figures/tables that must be regenerated:** UC-5 table.

### §4.3.4 Sequence Diagram, PDF pp.70–71 — P0

**Status:** Rewrite. **Why it needs updating:** Fig. 4.3.4.1 omits server/RAG/auth and starts local model at startup. **Current system evidence:** `A/backend/worker/SmsProcessingWorker.kt`; `A/backend/remote/ProductionSmsTransport.kt`; `S/services/rag.js`; `S/production/createProductionApp.js`. **What the revised manuscript must say:** Message/event, local rule/Room, gate, API, embed/search/Ollama, verified or failure return, alert update. **What must be removed:** Local 2B participant. **What new material should be added:** Separate report/study sequences. **Figures/tables that must be regenerated:** Fig. 4.3.4.1.

### §4.3.5 Context Diagram, PDF pp.71–72 — P0

**Status:** Rewrite. **Why it needs updating:** Gemma is drawn as on-device external actor and server as optional log recipient. **Current system evidence:** `A/backend/remote/ProductionSmsTransport.kt`; `S/production/createProductionApp.js`; `S/admin-web/app.js`. **What the revised manuscript must say:** Android, public HTTPS/tunnel, controlled server, Ollama/PostgreSQL, user/admin/researcher with distinct flows. **What must be removed:** Strict local-processing boundary assertion. **What new material should be added:** Raw-text edges and consent labels. **Figures/tables that must be regenerated:** Fig. 4.3.5.1.

### §4.3.6 ERD, PDF pp.72–73 — P0

**Status:** Rewrite. **Why it needs updating:** One five-table ERD excludes server data and current columns. **Current system evidence:** `A/backend/database/AppDatabase.kt`; `S/db/migrations/001_rag_knowledge.sql`–`010_unlabeled_study_contributions.sql`. **What the revised manuscript must say:** Separate Room and PostgreSQL models, FKs, HMAC/encrypted columns, vector knowledge and study schema. **What must be removed:** Single-database depiction of entire artifact. **What new material should be added:** Trust/storage boundary and retention. **Figures/tables that must be regenerated:** Fig. 4.3.6.1 into two ERDs.

### §4.4.1 Logical Database Structure, PDF pp.73–74 — P0

**Status:** Rewrite. **Why it needs updating:** “Five main entities” is true only for local Room. **Current system evidence:** `A/backend/database/AppDatabase.kt`; `S/db/migrations/*.sql`. **What the revised manuscript must say:** Five Room entities plus separate server inference, identity, report, RAG, and optional study tables; clarify that Android intake does not query `keywords` Room table. **What must be removed:** Server-free logical model. **What new material should be added:** Relationships and lifecycle. **Figures/tables that must be regenerated:** Logical structure tables.

### §4.4.2 Data Dictionary, PDF pp.74–78 — P0

**Status:** Rewrite. **Why it needs updating:** `sender_harsh` typo; incomplete messages/reports; wrong `Keyword.weight` type and report semantics. **Current system evidence:** `A/model/entity/{Message,Keyword,MessageKeyword,Report,SafetyTip}.kt`; `S/db/migrations/*.sql`. **What the revised manuscript must say:** Exact current fields/types/nullable/keys and separate server dictionary. **What must be removed:** “Reports contain no SMS” and required report message FK. **What new material should be added:** `sms_text_snapshot`, remote state/source, encrypted server content, vector(768), study JSONB. **Figures/tables that must be regenerated:** All five local table dictionaries plus server table dictionary.

### §4.5–4.5.2 User Interface Design, PDF pp.78–84 — P2

**Status:** Major Revision. **Why it needs updating:** Low/high fidelity mockups may not reflect the current app. **Current system evidence:** `A/view/fragment/{MessagesFragment,MessageDetailFragment,ReportLogsFragment,CommunityFragment,SettingsFragment,OnboardingFragment,SafetyTipsFragment}.kt`. **What the revised manuscript must say:** Describe currently implemented screens and state-dependent labels; capture screenshots from the target beta build before replacing images. **What must be removed:** Mockup captions presented as actual UI. **What new material should be added:** Consent, pending/unavailable, report status, and batch contribution UI if shown. **Figures/tables that must be regenerated:** Existing UI figures on pp.79–84.

### §4.6–4.6.2 Development Strategy and Sprint Structure, PDF pp.84–88 — P1

**Status:** Major Revision. **Why it needs updating:** Future-tense plans do not distinguish completed code and pending study. **Current system evidence:** `.tmp-mobile-notification-fix/README.md`; `apcida-ai-server/README.md`; `S/production/createProductionApp.js`; `S/study/worker.js`. **What the revised manuscript must say:** Actual implementation sequence, versions/commits, tests and deployment gates; mark unrun participant tasks planned. **What must be removed:** Planned features presented as delivered. **What new material should be added:** Versioned milestone evidence. **Figures/tables that must be regenerated:** Sprint schedule/status tables.

### §4.6.3 Tools and Technologies, PDF pp.88–89 — P1

**Status:** Rewrite. **Why it needs updating:** Local-only technology list omits server stack and overstates MediaPipe deployment. **Current system evidence:** `.tmp-mobile-notification-fix/app/build.gradle.kts`; `apcida-ai-server/package.json`; `S/db/migrations/001_rag_knowledge.sql`; `S/production/server.js`. **What the revised manuscript must say:** Kotlin/Room/WorkManager/OkHttp/Retrofit, Node/Express, Ollama Gemma 3 12B, `nomic-embed-text`, local PostgreSQL/pgvector, supervised HTTPS tunnel; MediaPipe debug only. **What must be removed:** 2B production entry. **What new material should be added:** Build-mode column. **Figures/tables that must be regenerated:** Tools/technologies table.

### §4.7 Planned Demonstration and Evaluation, PDF pp.89–90 — P0

**Status:** Rewrite. **Why it needs updating:** It does not reflect completed synthetic tests or their limits. **Current system evidence:** `evaluation-results/baseline-200/evaluation.json`; `evaluation-results/rag-200/evaluation.json`; `evaluation-results/three-class-exploratory-v1/audited-report.json`; `S/evaluation/threeClassMetrics.js`. **What the revised manuscript must say:** Separate completed synthetic comparisons and small three-class diagnostic from pending participant/usability evaluation; include errors and latency. **What must be removed:** Future tense for already-run development tests and unqualified accuracy claims. **What new material should be added:** Dataset/provenance/result limitations. **Figures/tables that must be regenerated:** Evaluation plan/results table.

### §4.8 Expected Outcomes and Contributions, PDF pp.90–91 — P1

**Status:** Major Revision. **Why it needs updating:** Expected local 2–4 s and offline AI protection do not follow current implementation. **Current system evidence:** `S/production/server.js`; `evaluation-results/*/evaluation.json`; `A/backend/network/RemoteVerdictPolicy.kt`. **What the revised manuscript must say:** Separate demonstrated functions, observed synthetic performance, and outcomes awaiting user study. **What must be removed:** Unsupported speed/storage/generalization figures. **What new material should be added:** Connectivity and timeout limitations. **Figures/tables that must be regenerated:** Outcome table.

### §4.9 Summary, PDF p.91 — P1

**Status:** Major Revision. **Why it needs updating:** It summarizes obsolete architecture. **Current system evidence:** `S/production/createProductionApp.js`; `A/controller/SmsController.kt`. **What the revised manuscript must say:** Summarize actual beta boundaries and evidence with no new performance claims. **What must be removed:** Selective on-device 2B language. **What new material should be added:** Next-stage evaluation statement. **Figures/tables that must be regenerated:** None.

## Appendix

### Appendix A.1–A.4 Database Structure, PDF pp.98–100 — P0

**Status:** Rewrite. **Why it needs updating:** Appendix says only local SQLite exists, reports are anonymized, and raw SMS never leaves device. **Current system evidence:** `A/backend/database/AppDatabase.kt`; `A/backend/network/ReportApiService.kt`; `S/db/migrations/001_rag_knowledge.sql`–`010_unlabeled_study_contributions.sql`; `S/production/reportContract.js`. **What the revised manuscript must say:** Separate local and server schemas and distinct inference/report/study data flows, retention and human review. **What must be removed:** Absolute no-raw-SMS transmission line. **What new material should be added:** Complete current data dictionary and API payload appendix. **Figures/tables that must be regenerated:** Appendix A relationships and summary tables.
