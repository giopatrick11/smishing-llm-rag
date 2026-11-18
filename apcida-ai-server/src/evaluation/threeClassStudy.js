const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { performance } = require('node:perf_hooks');
const dotenv = require('dotenv');
const { createOllamaService, OllamaError } = require('../services/ollama');
const { createRagService, RagError } = require('../services/rag');
const { analyzeRules, RULES_VERSION } = require('../services/rules');
const { resolveVerdict } = require('../services/verdict');
const { EMBEDDING_MODEL } = require('../services/embeddings');
const { createDatabasePool, checkRagDatabase } = require('../db/pool');
const { createKnowledgeRepository } = require('../db/knowledgeRepository');
const { lockAndCheckRagKnowledge } = require('../knowledge/evaluationGuard');
const { signature, duplicateKind } = require('../knowledge/dedupe');
const { loadEvaluationConfig, loadDatabaseUrl } = require('../config/env');
const { acquireRunLock, writeAtomic } = require('./checkpoint');
const { calculateThreeClassMetrics, LABELS } = require('./threeClassMetrics');
const { projectRoot, evaluationResultsDir } = require('../paths');

const MODES = ['rules', 'gemma', 'gemmaRag', 'shadow'];
const DEFAULT_INPUT = path.join(projectRoot, 'dataset/apcida_three_class_exploratory_v1.json');
const DEFAULT_OUTPUT = path.join(evaluationResultsDir, 'three-class-exploratory-v1');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(args) {
  const options = { input: DEFAULT_INPUT, outputDir: DEFAULT_OUTPUT, pauseMs: 1000, preflight: false };
  const seen = new Set();
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    if (seen.has(flag)) throw new Error(`Duplicate option: ${flag}`);
    seen.add(flag);
    if (flag === '--preflight') { options.preflight = true; continue; }
    if (!['--input', '--output-dir', '--env-file', '--pause-ms'].includes(flag) || !args[i + 1]) {
      throw new Error(`Invalid option: ${flag}`);
    }
    const value = args[++i];
    if (flag === '--input') options.input = path.resolve(value);
    if (flag === '--output-dir') options.outputDir = path.resolve(value);
    if (flag === '--env-file') options.envFile = path.resolve(value);
    if (flag === '--pause-ms') options.pauseMs = Number(value);
  }
  if (!options.envFile || !Number.isInteger(options.pauseMs) || options.pauseMs < 0 || options.pauseMs > 60000) {
    throw new Error('Usage: node src/evaluation/threeClassStudy.js --env-file PRIVATE_ENV [--input JSON] [--output-dir DIR] [--pause-ms 0..60000] [--preflight]');
  }
  return options;
}

function loadRows(input) {
  const bytes = fs.readFileSync(input);
  let data;
  try { data = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('Invalid evaluation JSON'); }
  if (!Array.isArray(data) || data.length < 3) throw new Error('Evaluation requires at least three rows');
  const ids = new Set();
  const signatures = [];
  const rows = data.map((item) => {
    if (!item || typeof item.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/u.test(item.id)
      || ids.has(item.id) || typeof item.text !== 'string' || !item.text.trim()
      || item.text.length > 2000 || !LABELS.includes(item.label)
      || (item.category !== undefined && (typeof item.category !== 'string'
        || !/^[a-z0-9-]{1,80}$/u.test(item.category)))) {
      throw new Error('Invalid or duplicate evaluation row');
    }
    ids.add(item.id);
    const candidate = signature(item.text);
    for (const previous of signatures) {
      if (duplicateKind(candidate, previous.signature)) {
        throw new Error(`Evaluation row ${item.id} duplicates ${previous.id}`);
      }
    }
    signatures.push({ id: item.id, signature: candidate });
    return { messageId: item.id, groundTruth: item.label, text: item.text,
      category: item.category ?? null };
  });
  if (LABELS.some((label) => !rows.some((row) => row.groundTruth === label))) {
    throw new Error('Evaluation needs SAFE, SUSPICIOUS, and SCAM truth rows');
  }
  return { rows, datasetSha256: sha256(bytes) };
}

function pipelineHash() {
  const files = [__filename, './threeClassMetrics.js', '../services/ollama.js', '../services/rag.js',
    '../services/rules.js', '../services/verdict.js', '../services/embeddings.js',
    '../db/knowledgeRepository.js', '../knowledge/evaluationGuard.js', '../knowledge/dedupe.js'];
  return sha256(Buffer.concat(files.map((file) => fs.readFileSync(path.resolve(__dirname, file)))));
}

async function modelDigests(config) {
  const response = await fetch(`${config.ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(config.requestTimeoutMs) });
  if (!response.ok) throw new Error('Ollama model list unavailable');
  const models = (await response.json()).models;
  if (!Array.isArray(models)) throw new Error('Invalid Ollama model list');
  const gemma = models.find((model) => model.name === config.model || model.model === config.model);
  const embedding = models.find((model) => model.name === EMBEDDING_MODEL
    || model.name === `${EMBEDDING_MODEL}:latest` || model.model === EMBEDDING_MODEL);
  if (!gemma?.digest || !embedding?.digest) throw new Error('Gemma or embedding model unavailable');
  return { gemma: gemma.digest, embedding: embedding.digest };
}

function pairedSummary(gemma, rag) {
  if (!Array.isArray(gemma) || !Array.isArray(rag) || gemma.length !== rag.length) {
    throw new Error('Paired reports must have the same row count');
  }
  const byId = new Map(rag.map((row) => [row.messageId, row]));
  if (byId.size !== rag.length || new Set(gemma.map((row) => row.messageId)).size !== gemma.length
    || gemma.some((row) => !byId.has(row.messageId)
    || byId.get(row.messageId).groundTruth !== row.groundTruth)) {
    throw new Error('Paired reports have mismatched IDs or labels');
  }
  const common = gemma.filter((row) => !row.error && !byId.get(row.messageId).error);
  return {
    commonSuccessful: common.length,
    gemmaExactOnCommon: common.filter((row) => row.prediction === row.groundTruth).length,
    ragExactOnCommon: common.filter((row) => byId.get(row.messageId).prediction === row.groundTruth).length,
    changed: common.filter((row) => row.prediction !== byId.get(row.messageId).prediction)
      .map((row) => ({ id: row.messageId, truth: row.groundTruth, gemma: row.prediction,
        rag: byId.get(row.messageId).prediction })),
  };
}

function validateOutputDir(outputDir) {
  const resolved = path.resolve(outputDir);
  if (!resolved.startsWith(`${path.resolve(evaluationResultsDir)}${path.sep}`)
    || !path.basename(resolved).startsWith('three-class-')) {
    throw new Error('Choose a new three-class-* directory under evaluation-results');
  }
  if (fs.existsSync(resolved) && !fs.existsSync(path.join(resolved, 'progress.json'))
    && fs.readdirSync(resolved).length > 0) {
    throw new Error('Output directory has files without a matching checkpoint');
  }
  return resolved;
}

function validateSavedResults(progress, metadata, rows) {
  if (!isDeepStrictEqual(progress.metadata, metadata)
    || MODES.some((mode) => !Array.isArray(progress.results?.[mode]))) {
    throw new Error('Existing checkpoint does not match dataset, code, models, or RAG knowledge');
  }
  for (const mode of MODES) {
    const saved = progress.results[mode];
    if (saved.length > rows.length || saved.some((result, index) => result.messageId !== rows[index].messageId
      || result.groundTruth !== rows[index].groundTruth
      || !Number.isFinite(result.inferenceDurationMs) || result.inferenceDurationMs < 0
      || (result.error ? result.prediction !== null : !LABELS.includes(result.prediction))
      || Object.hasOwn(result, 'text') || Object.hasOwn(result, 'sms')
      || Object.hasOwn(result, 'rationale'))) {
      throw new Error('Existing checkpoint has invalid, mismatched, or sensitive rows');
    }
  }
}

async function runStudy(options, { print = (line) => process.stdout.write(`${line}\n`) } = {}) {
  const { rows, datasetSha256 } = loadRows(options.input);
  const fileMode = fs.statSync(options.envFile).mode & 0o777;
  if (fileMode & 0o077) throw new Error('Private environment file must be owner-only');
  const env = dotenv.parse(fs.readFileSync(options.envFile));
  const config = loadEvaluationConfig(env);
  const pool = createDatabasePool(loadDatabaseUrl(env), { statementTimeoutMillis: 10000 });
  let knowledgeLock;
  let releaseRunLock;
  try {
    await checkRagDatabase(pool);
    knowledgeLock = await lockAndCheckRagKnowledge(pool, rows);
    if (knowledgeLock.activeCount === 0) throw new Error('No approved RAG knowledge');
    const digests = await modelDigests(config);
    const metadata = { version: 1, datasetSha256, pipelineSha256: pipelineHash(),
      model: config.model, embeddingModel: EMBEDDING_MODEL, modelDigests: digests,
      knowledgeSha256: knowledgeLock.fingerprint, knowledgeCount: knowledgeLock.activeCount,
      retrieval: { topK: 3, minSimilarity: 0.72 }, rulesVersion: RULES_VERSION,
      policy: 'shadow', rowCount: rows.length };
    if (options.preflight) {
      print(`Preflight passed: ${rows.length} rows, all three labels, no internal or approved-RAG duplicates; ${knowledgeLock.activeCount} approved RAG rows; models available.`);
      return { metadata };
    }
    validateOutputDir(options.outputDir);
    releaseRunLock = acquireRunLock(options.outputDir);
    const progressPath = path.join(options.outputDir, 'progress.json');
    let progress = { metadata, results: Object.fromEntries(MODES.map((mode) => [mode, []])) };
    if (fs.existsSync(progressPath)) {
      progress = JSON.parse(fs.readFileSync(progressPath, 'utf8'));
      validateSavedResults(progress, metadata, rows);
    } else if (fs.existsSync(path.join(options.outputDir, 'report.json'))) {
      throw new Error('Report exists without checkpoint; choose a new output directory');
    }
    const ollama = createOllamaService(config);
    const repository = createKnowledgeRepository(pool);
    for (const mode of MODES) {
      for (let index = progress.results[mode].length; index < rows.length; index += 1) {
        const row = rows[index];
        if (index > 0 || mode !== MODES[0]) await pause(options.pauseMs);
        const started = performance.now();
        let rules = null;
        let retrieved = [];
        let prediction = null;
        let confidence = null;
        let error = null;
        let ragContext = null;
        try {
          if (mode === 'rules' || mode === 'shadow') rules = analyzeRules(row.text);
          if (mode === 'rules') prediction = rules.classification;
          else {
            const sms = { sender: 'SYNTHETIC_TEST', text: row.text,
              receivedAt: '2026-11-13T00:00:00+08:00' };
            const usesRag = mode === 'gemmaRag' || mode === 'shadow';
            const service = usesRag ? createRagService(config, ollama, {
              async search(vector) {
                const examples = await repository.search(vector);
                retrieved = examples.map((entry) => ({ id: entry.id, label: entry.label,
                  similarity: entry.similarity }));
                return examples;
              },
            }, undefined, { includeContext: true }) : ollama;
            const gemma = await service.analyze(sms);
            confidence = gemma.confidence;
            ragContext = gemma.ragContext || null;
            prediction = mode === 'shadow' ? resolveVerdict(gemma.classification, rules,
              { shadowMode: true, policy: 'gemma', gemmaConfidence: gemma.confidence,
                ragContext }).classification : gemma.classification;
          }
        } catch (cause) {
          if (!(cause instanceof OllamaError || cause instanceof RagError)) throw cause;
          error = cause.code;
        }
        const result = { messageId: row.messageId, groundTruth: row.groundTruth,
          category: row.category, prediction, confidence,
          inferenceDurationMs: Math.round(performance.now() - started), error,
          ruleScore: rules?.score ?? null, ruleClassification: rules?.classification ?? null,
          matchedIndicators: rules?.matchedIndicators.map((item) => item.code) || [],
          ragContext, retrieved };
        progress.results[mode].push(result);
        writeAtomic(progressPath, `${JSON.stringify(progress, null, 2)}\n`);
        print(`${mode} ${index + 1}/${rows.length}${error ? ` ${error}` : ''}`);
      }
    }
    const metrics = Object.fromEntries(MODES.map((mode) => [mode,
      calculateThreeClassMetrics(progress.results[mode])]));
    metrics.shadow.ruleDisagreements = progress.results.shadow.filter((row) =>
      !row.error && row.ruleClassification !== row.prediction).length;
    const report = { metadata, metrics,
      pairedGemmaRag: pairedSummary(progress.results.gemma, progress.results.gemmaRag),
      results: progress.results };
    writeAtomic(path.join(options.outputDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    print(`Report written to ${options.outputDir}`);
    return report;
  } finally {
    try { if (knowledgeLock) await knowledgeLock.release(); }
    finally {
      try { await pool.end(); }
      finally { if (releaseRunLock) releaseRunLock(); }
    }
  }
}

if (require.main === module) {
  runStudy(parseArgs(process.argv.slice(2))).catch((error) => {
    process.stderr.write(`Three-class evaluation failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, loadRows, pairedSummary, validateOutputDir, validateSavedResults, runStudy };
