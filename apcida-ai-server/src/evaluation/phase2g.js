const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { projectRoot, datasetDir, evaluationResultsDir } = require('../paths');
const { loadDataset } = require('./csv');
const { signature, duplicateKind, NEAR_DUPLICATE_DICE_THRESHOLD } = require('../knowledge/dedupe');
const { loadEvaluationConfig, loadDatabaseUrl } = require('../config/env');
const { createDatabasePool, checkRagDatabase } = require('../db/pool');
const { lockAndCheckRagKnowledge } = require('../knowledge/evaluationGuard');
const { acquireRunLock, writeAtomic } = require('./checkpoint');
const { runHybridEvaluation } = require('./runHybrid');

const MANIFEST = path.join(evaluationResultsDir, 'phase2g-freeze.json');
const CONTROL_DIR = path.join(evaluationResultsDir, 'phase2g-control');
const HOLDOUT = path.join(datasetDir, 'apcida_synthetic_sms_50_holdout_phase2f.csv');
const DEVELOPMENT = path.join(datasetDir, 'apcida_synthetic_sms_50_development.csv');
const HISTORICAL = path.join(datasetDir, 'apcida_synthetic_sms_50.csv');
const MAPPING = { textColumn: 'sms_text', labelColumn: 'label', idColumn: 'message_id',
  senderColumn: null, receivedAtColumn: null };
const FROZEN_FILES = [
  'apcida-ai-server/src/services/rules.js',
  'apcida-ai-server/src/services/verdict.js',
  'apcida-ai-server/src/services/ollama.js',
  'apcida-ai-server/src/services/rag.js',
  'apcida-ai-server/src/services/embeddings.js',
  'apcida-ai-server/src/db/knowledgeRepository.js',
  'apcida-ai-server/src/db/pool.js',
  'apcida-ai-server/src/knowledge/evaluationGuard.js',
  'apcida-ai-server/src/knowledge/dedupe.js',
  'apcida-ai-server/src/config/env.js',
  'apcida-ai-server/src/validators/sms.js',
  'apcida-ai-server/src/evaluation/runHybrid.js',
  'apcida-ai-server/src/evaluation/csv.js',
  'apcida-ai-server/src/evaluation/metrics.js',
  'apcida-ai-server/src/evaluation/checkpoint.js',
  'apcida-ai-server/src/evaluation/comparison.js',
  'apcida-ai-server/src/evaluation/phase2g.js',
  'apcida-ai-server/package.json',
];
const SHA256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function assertNoOverlap(left, right, { within = false, label = 'datasets' } = {}) {
  const leftSignatures = left.map((row) => ({ id: row.messageId, signature: signature(row.text) }));
  const rightSignatures = within ? leftSignatures : right.map((row) => ({ id: row.messageId, signature: signature(row.text) }));
  for (let i = 0; i < leftSignatures.length; i += 1) {
    for (let j = within ? i + 1 : 0; j < rightSignatures.length; j += 1) {
      if (leftSignatures[i].id === rightSignatures[j].id) throw new Error(`${label}: repeated message ID`);
      const kind = duplicateKind(leftSignatures[i].signature, rightSignatures[j].signature);
      if (kind) throw new Error(`${label}: ${kind.toLowerCase()} duplicate`);
    }
  }
}

function auditHoldout() {
  const holdoutBytes = fs.readFileSync(HOLDOUT);
  const developmentBytes = fs.readFileSync(DEVELOPMENT);
  const historicalBytes = fs.readFileSync(HISTORICAL);
  const holdout = loadDataset(holdoutBytes.toString('utf8'), MAPPING);
  const development = loadDataset(developmentBytes.toString('utf8'), MAPPING);
  const historical = loadDataset(historicalBytes.toString('utf8'), MAPPING);
  if (holdout.length !== 50 || holdout.filter((row) => row.groundTruth === 'SCAM').length !== 25
    || holdout.filter((row) => row.groundTruth === 'SAFE').length !== 25) {
    throw new Error('Phase 2G holdout must contain 25 SCAM and 25 SAFE rows');
  }
  if (development.length !== 50 || historical.length !== 50) throw new Error('Reference subsets must each contain 50 rows');
  assertNoOverlap(holdout, holdout, { within: true, label: 'holdout' });
  assertNoOverlap(holdout, development, { label: 'holdout vs development' });
  assertNoOverlap(holdout, historical, { label: 'holdout vs historical' });
  return { holdout, datasetSha256: {
    holdout: SHA256(holdoutBytes), development: SHA256(developmentBytes), historical: SHA256(historicalBytes),
  } };
}

async function modelDigests(config) {
  const response = await fetch(`${config.ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error('Local Ollama model list is unavailable');
  const data = await response.json();
  if (!Array.isArray(data?.models)) throw new Error('Local Ollama model list is invalid');
  const find = (name) => data.models.find((model) => model.name === name || model.model === name);
  const gemma = find('gemma3:12b');
  const embedding = find('nomic-embed-text:latest') || find('nomic-embed-text');
  if (!/^[a-f0-9]{64}$/iu.test(gemma?.digest || '') || !/^[a-f0-9]{64}$/iu.test(embedding?.digest || '')) {
    throw new Error('Required local Ollama model or digest is unavailable');
  }
  return { gemma3_12b: gemma.digest, nomicEmbedText: embedding.digest };
}

async function currentFreeze() {
  const { holdout, datasetSha256 } = auditHoldout();
  const config = loadEvaluationConfig();
  if (config.model !== 'gemma3:12b' || !config.rulesShadowMode || config.verdictPolicy !== 'gemma') {
    throw new Error('Expected Gemma 3 12B with the production API still in Gemma shadow mode');
  }
  const codeSha256 = Object.fromEntries(FROZEN_FILES.map((file) => [file, SHA256(fs.readFileSync(path.join(projectRoot, file)))]));
  const pool = createDatabasePool(loadDatabaseUrl());
  let knowledgeLock;
  let knowledge;
  try {
    await checkRagDatabase(pool);
    knowledgeLock = await lockAndCheckRagKnowledge(pool, holdout);
    if (knowledgeLock.activeCount !== 100) throw new Error(`Expected 100 approved knowledge rows; found ${knowledgeLock.activeCount}`);
    knowledge = { activeApproved: knowledgeLock.activeCount, fingerprint: knowledgeLock.fingerprint };
  } finally {
    try { if (knowledgeLock) await knowledgeLock.release(); }
    finally { await pool.end(); }
  }
  return {
    version: 1,
    holdout: { rows: 50, scam: 25, safe: 25, nearDuplicateDiceThreshold: NEAR_DUPLICATE_DICE_THRESHOLD },
    datasetSha256, codeSha256, knowledge,
    models: await modelDigests(config),
    evaluation: { model: config.model, requestTimeoutMs: config.requestTimeoutMs,
      evidenceWeightedPolicy: 'evidence-weighted', shadowModeForExperiment: false, pauseMs: 1000 },
  };
}

async function freeze() {
  const release = acquireRunLock(CONTROL_DIR);
  try {
    if (fs.existsSync(MANIFEST)) throw new Error('Phase 2G freeze already exists; run verify instead');
    const frozen = await currentFreeze();
    writeAtomic(MANIFEST, `${JSON.stringify({ createdAt: new Date().toISOString(), frozen }, null, 2)}\n`);
    process.stdout.write(`Phase 2G freeze written to ${MANIFEST}; 50 balanced unique rows, no near duplicates, 100 approved RAG rows.\n`);
  } finally { release(); }
}

async function verifyFreeze() {
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); }
  catch { throw new Error('Phase 2G freeze manifest is missing or invalid; do not evaluate'); }
  if (!manifest?.frozen || manifest.frozen.version !== 1) throw new Error('Phase 2G freeze manifest is invalid');
  const current = await currentFreeze();
  if (!isDeepStrictEqual(current, manifest.frozen)) {
    const changed = Object.keys(current).filter((key) => !isDeepStrictEqual(current[key], manifest.frozen[key]));
    throw new Error(`Phase 2G freeze mismatch: ${changed.join(', ')}; do not evaluate`);
  }
  return current;
}

function evaluationOptions(stage) {
  const output = (name) => path.join(evaluationResultsDir, `phase2g-${name}`);
  const base = { input: HOLDOUT, mapping: MAPPING, pauseMs: 1000,
    compareGemmaReport: null, compareRagReport: null };
  if (stage === 'gemma') return { ...base, mode: 'gemma', outputDir: output('gemma'),
    shadowMode: true, verdictPolicy: 'gemma' };
  if (stage === 'gemma-rag') return { ...base, mode: 'gemma-rag', outputDir: output('gemma-rag'),
    shadowMode: true, verdictPolicy: 'gemma' };
  if (stage === 'hybrid-rag') return { ...base, mode: 'rules-gemma-rag', outputDir: output('hybrid-rag'),
    shadowMode: false, verdictPolicy: 'evidence-weighted',
    compareGemmaReport: path.join(output('gemma'), 'evaluation.json'),
    compareRagReport: path.join(output('gemma-rag'), 'evaluation.json') };
  throw new Error('Use freeze, verify, gemma, gemma-rag, or hybrid-rag');
}

async function runStage(stage) {
  const release = acquireRunLock(CONTROL_DIR);
  try {
    await verifyFreeze();
    if (stage === 'gemma-rag' && !fs.existsSync(path.join(evaluationResultsDir, 'phase2g-gemma/evaluation.json'))) {
      throw new Error('Complete Phase 2G Gemma-only evaluation first');
    }
    if (stage === 'hybrid-rag' && !fs.existsSync(path.join(evaluationResultsDir, 'phase2g-gemma-rag/evaluation.json'))) {
      throw new Error('Complete Phase 2G Gemma+RAG evaluation first');
    }
    await runHybridEvaluation(evaluationOptions(stage));
    await verifyFreeze();
    process.stdout.write('Phase 2G freeze remained unchanged through the run.\n');
  } finally { release(); }
}

async function main() {
  const action = process.argv[2];
  if (process.argv.length !== 3) throw new Error('Use exactly one Phase 2G action');
  if (action === 'freeze') return freeze();
  if (action === 'verify') {
    await verifyFreeze();
    process.stdout.write('Phase 2G freeze verified: holdout, code, Gemma, embedding model, and approved RAG knowledge match.\n');
    return;
  }
  return runStage(action);
}

if (require.main === module) main().catch((error) => {
  process.stderr.write(`Phase 2G failed: ${error.message}\n`);
  process.exitCode = 1;
});

module.exports = { auditHoldout, assertNoOverlap, evaluationOptions, currentFreeze, verifyFreeze };
