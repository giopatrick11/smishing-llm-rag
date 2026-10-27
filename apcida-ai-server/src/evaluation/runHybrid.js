const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { createOllamaService, OllamaError } = require('../services/ollama');
const { createRagService, RagError } = require('../services/rag');
const { analyzeRules } = require('../services/rules');
const { resolveVerdict } = require('../services/verdict');
const { loadEvaluationConfig, loadDatabaseUrl } = require('../config/env');
const { createDatabasePool, checkRagDatabase } = require('../db/pool');
const { createKnowledgeRepository } = require('../db/knowledgeRepository');
const { lockAndCheckRagKnowledge } = require('../knowledge/evaluationGuard');
const { loadDataset, resultsToCsv, comparisonsToCsv, metricsToCsv } = require('./csv');
const { loadComparisonReport } = require('./comparison');
const { evaluationResultsDir } = require('../paths');
const { calculateMetrics } = require('./metrics');
const { acquireRunLock, openCheckpoint, writeAtomic } = require('./checkpoint');
const { safeRationale } = require('./run');

const MODES = ['rules', 'gemma', 'gemma-rag', 'rules-gemma', 'rules-gemma-rag'];
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function withRetrievalRetry(repository, retryDelayMs = 500) {
  return {
    async search(...args) {
      try { return await repository.search(...args); }
      catch {
        await pause(retryDelayMs);
        return repository.search(...args);
      }
    },
  };
}

async function runHybridEvaluation(options, { print = (line) => process.stdout.write(`${line}\n`),
  createOllama = createOllamaService, createPool = createDatabasePool } = {}) {
  if (!MODES.includes(options.mode)) throw new Error('Invalid Phase 2E evaluation mode');
  const usesRules = options.mode.startsWith('rules');
  const usesGemma = options.mode !== 'rules';
  const usesRag = options.mode.endsWith('-rag');
  const shadowMode = options.shadowMode ?? true;
  const verdictPolicy = options.verdictPolicy || 'gemma';
  if (!Number.isInteger(options.pauseMs) || options.pauseMs < 0 || options.pauseMs > 60000) throw new Error('Invalid pause');
  if (!usesRules && (!shadowMode || verdictPolicy !== 'gemma')) throw new Error('Verdict policy requires a hybrid mode');
  if (usesRules && !usesGemma && (!shadowMode || verdictPolicy !== 'gemma')) throw new Error('Rules-only mode has no Gemma verdict');
  if (!shadowMode && !['corroborated-warning', 'evidence-weighted'].includes(verdictPolicy)) {
    throw new Error('Experimental mode requires an experimental verdict policy');
  }
  if ((options.compareGemmaReport || options.compareRagReport) && !(usesRules && usesGemma)) {
    throw new Error('Comparison reports require a hybrid mode');
  }

  const config = loadEvaluationConfig();
  const inputBytes = fs.readFileSync(options.input);
  const rows = loadDataset(inputBytes.toString('utf8'), options.mapping);
  const outputDir = path.resolve(options.outputDir);
  const preservedDirs = MODES.map((mode) => path.join(evaluationResultsDir, `phase2e-${mode}`));
  if (preservedDirs.includes(outputDir)) throw new Error('Phase 2E reports are preserved; choose a new Phase 2F output directory');
  const datasetSha256 = sha256(inputBytes);
  const comparisonGemma = loadComparisonReport(options.compareGemmaReport, 'gemma', datasetSha256, rows);
  const comparisonRag = loadComparisonReport(options.compareRagReport, 'gemma-rag', datasetSha256, rows);
  const releaseLock = acquireRunLock(outputDir);
  let pool;
  let knowledgeLock;
  try {
    const ollama = usesGemma ? createOllama(config) : null;
    let analysisService = ollama;
    if (usesRag) {
      pool = createPool(loadDatabaseUrl());
      await checkRagDatabase(pool);
      knowledgeLock = await lockAndCheckRagKnowledge(pool, rows);
      if (knowledgeLock.activeCount === 0) throw new Error('RAG evaluation requires active approved knowledge records');
      analysisService = createRagService(config, ollama, withRetrievalRetry(createKnowledgeRepository(pool)),
        undefined, { includeContext: true });
      print(`RAG evaluation: ${knowledgeLock.activeCount} approved records; contamination check passed.`);
    }
    const sourceFiles = ['./runHybrid.js', '../services/ollama.js', '../validators/sms.js'];
    if (usesRules) sourceFiles.push('../services/rules.js');
    if (usesRules && usesGemma) sourceFiles.push('../services/verdict.js');
    if (usesRag) sourceFiles.push('../services/embeddings.js', '../services/rag.js', '../db/knowledgeRepository.js');
    if (comparisonGemma || comparisonRag) sourceFiles.push('./comparison.js');
    const metadata = {
      version: 3,
      mode: options.mode,
      datasetSha256,
      pipelineSha256: sha256(Buffer.concat(sourceFiles.map((file) => fs.readFileSync(path.join(__dirname, file))))),
      model: usesGemma ? config.model : null,
      mapping: options.mapping,
      rowCount: rows.length,
      shadowMode,
      verdictPolicy,
      ...(usesRag ? { knowledgeSha256: knowledgeLock.fingerprint } : {}),
      ...(comparisonGemma ? { comparisonGemmaSha256: comparisonGemma.sha256 } : {}),
      ...(comparisonRag ? { comparisonRagSha256: comparisonRag.sha256 } : {}),
    };
    const checkpoint = openCheckpoint(outputDir, metadata, rows);
    print(`Dataset rows: ${rows.length}; checkpointed: ${checkpoint.completed.size}; pending: ${rows.length - checkpoint.completed.size}`);
    if (usesGemma && checkpoint.completed.size < rows.length) {
      const status = await ollama.status();
      if (!status.modelAvailable) throw new Error('gemma3:12b is not available in Ollama');
      print('Ollama model ready: gemma3:12b');
    }
    let processed = checkpoint.completed.size;
    for (const row of rows) {
      if (checkpoint.completed.has(row.messageId)) continue;
      if (processed > 0 && options.pauseMs > 0) await pause(options.pauseMs);
      const started = performance.now();
      let rules = null;
      let result;
      try {
        // The order is intentional: rules, optional retrieval, Gemma, resolver.
        if (usesRules) rules = analyzeRules(row.text);
        const gemma = usesGemma ? await analysisService.analyze({ sender: row.sender, text: row.text, receivedAt: row.receivedAt }) : null;
        const verdict = usesGemma
          ? resolveVerdict(gemma.classification, rules, {
            shadowMode, policy: verdictPolicy, gemmaConfidence: gemma.confidence, ragContext: gemma.ragContext,
          })
          : { classification: rules.classification, policy: 'rules-only', reason: 'RULES_ONLY' };
        const correctedError = gemma ? gemma.classification !== row.groundTruth && verdict.classification === row.groundTruth : null;
        const introducedError = gemma ? gemma.classification === row.groundTruth && verdict.classification !== row.groundTruth : null;
        result = {
          messageId: row.messageId, groundTruth: row.groundTruth,
          prediction: verdict.classification,
          confidence: gemma?.confidence ?? null,
          rationale: gemma ? safeRationale(gemma.rationale, row.text) : rules.explanation,
          inferenceDurationMs: Math.round(performance.now() - started), error: null,
          ruleScore: rules?.score ?? null,
          ruleClassification: rules?.classification ?? null,
          matchedIndicators: rules?.matchedIndicators.map((item) => item.code) ?? [],
          ruleExplanation: rules?.explanation ?? null,
          gemmaClassification: gemma?.classification ?? null,
          baselineGemmaClassification: comparisonGemma
            ? (comparisonGemma.results.get(row.messageId) ?? null) : (usesRag ? null : gemma?.classification ?? null),
          ragEnabledClassification: comparisonRag
            ? (comparisonRag.results.get(row.messageId) ?? null) : (usesRag ? gemma?.classification ?? null : null),
          finalClassification: verdict.classification,
          hybridClassification: usesRules && usesGemma ? verdict.classification : null,
          verdictPolicy: verdict.policy,
          verdictReason: verdict.reason,
          ragContext: gemma?.ragContext ?? null,
          correctedError, introducedError,
        };
      } catch (error) {
        result = {
          messageId: row.messageId, groundTruth: row.groundTruth,
          prediction: null, confidence: null, rationale: null,
          inferenceDurationMs: Math.round(performance.now() - started),
          error: error instanceof OllamaError || error instanceof RagError ? error.code : 'EVALUATION_ERROR',
          ruleScore: rules?.score ?? null,
          ruleClassification: rules?.classification ?? null,
          matchedIndicators: rules?.matchedIndicators.map((item) => item.code) ?? [],
          ruleExplanation: rules?.explanation ?? null,
          gemmaClassification: null,
          baselineGemmaClassification: comparisonGemma?.results.get(row.messageId) ?? null,
          ragEnabledClassification: comparisonRag?.results.get(row.messageId) ?? null,
          finalClassification: null, hybridClassification: null,
          verdictPolicy: usesGemma ? (shadowMode ? 'shadow' : verdictPolicy) : 'rules-only',
          verdictReason: null, ragContext: null, correctedError: null, introducedError: null,
        };
      }
      checkpoint.append(result);
      processed += 1;
      print(`Processed ${processed}/${rows.length}${result.error ? ` (${result.error})` : ''}`);
    }
    const results = rows.map((row) => checkpoint.completed.get(row.messageId));
    const metrics = calculateMetrics(results);
    if (usesRules && usesGemma) metrics.hybridComparison = {
      corrected: results.filter((result) => result.correctedError === true).length,
      introduced: results.filter((result) => result.introducedError === true).length,
    };
    const report = { metadata: { ...metadata, generatedAt: new Date().toISOString() }, metrics, results };
    writeAtomic(path.join(outputDir, 'evaluation.json'), `${JSON.stringify(report, null, 2)}\n`);
    writeAtomic(path.join(outputDir, 'evaluation.csv'), resultsToCsv(results, { extended: true }));
    writeAtomic(path.join(outputDir, 'evaluation-metrics.csv'), metricsToCsv(metrics));
    if (usesRules && usesGemma) writeAtomic(path.join(outputDir, 'comparison.csv'), comparisonsToCsv(results));
    print(`Reports written to ${outputDir}`);
    return report;
  } finally {
    try {
      try { if (knowledgeLock) await knowledgeLock.release(); }
      finally { if (pool) await pool.end(); }
    } finally { releaseLock(); }
  }
}

module.exports = { runHybridEvaluation, withRetrievalRetry, MODES };
