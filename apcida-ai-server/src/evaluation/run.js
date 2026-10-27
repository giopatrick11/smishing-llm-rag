const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { createOllamaService, OllamaError, SYSTEM_PROMPT, BASELINE_CLASSIFIER_VERSION } = require('../services/ollama');
const { analysisJsonSchema } = require('../validators/sms');
const { loadEvaluationConfig } = require('../config/env');
const { loadDataset, resultsToCsv, metricsToCsv } = require('./csv');
const { calculateMetrics } = require('./metrics');
const { acquireRunLock, openCheckpoint, writeAtomic } = require('./checkpoint');
const { loadDatabaseUrl } = require('../config/env');
const { createDatabasePool, checkRagDatabase } = require('../db/pool');
const { createKnowledgeRepository } = require('../db/knowledgeRepository');
const { createRagService, RagError } = require('../services/rag');
const { lockAndCheckRagKnowledge } = require('../knowledge/evaluationGuard');
const { baselineOutputDir } = require('../paths');

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

// Phase 2A hashed the whole Ollama service file. RAG-only code changes do not
// change that baseline classifier, so this exact earlier fingerprint may resume.
const LEGACY_BASELINE_CLASSIFIER_SHA256 = 'e7c3ab73486451929d11b43277335fe58daf2af8ac310467bc277b463699ae22';

function safeRationale(rationale, text) {
  const cleaned = rationale.trim();
  const normalizedRationale = cleaned.replace(/\s+/g, ' ').toLocaleLowerCase();
  const normalizedText = text.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
  return normalizedRationale.includes(normalizedText)
    ? '[redacted: rationale repeated the SMS text]'
    : cleaned;
}

async function runEvaluation(options, { print = (line) => process.stdout.write(`${line}\n`) } = {}) {
  const mode = options.mode || 'baseline';
  if (!['baseline', 'rag'].includes(mode)) throw new Error('Invalid evaluation mode');
  if (mode === 'rag' && path.resolve(options.outputDir) === baselineOutputDir) {
    throw new Error('RAG evaluation cannot use the baseline output directory');
  }
  const config = loadEvaluationConfig();
  const inputBytes = fs.readFileSync(options.input);
  const rows = loadDataset(inputBytes.toString('utf8'), options.mapping);
  const validatorSource = fs.readFileSync(path.join(__dirname, '../validators/sms.js'));
  const outputDir = path.resolve(options.outputDir);
  const releaseLock = acquireRunLock(outputDir);
  let pool;
  let knowledgeLock;
  try {
    const ollama = createOllamaService(config);
    let analysisService = ollama;
    if (mode === 'rag') {
      pool = createDatabasePool(loadDatabaseUrl());
      await checkRagDatabase(pool);
      knowledgeLock = await lockAndCheckRagKnowledge(pool, rows);
      if (knowledgeLock.activeCount === 0) throw new Error('RAG evaluation requires active approved knowledge records');
      analysisService = createRagService(config, ollama, createKnowledgeRepository(pool));
      print(`RAG evaluation: ${knowledgeLock.activeCount} active approved knowledge records; contamination check passed.`);
    }
    const metadata = {
      version: 1,
      datasetSha256: sha256(inputBytes),
      classifierSha256: sha256(Buffer.concat([
        Buffer.from(JSON.stringify({ prompt: SYSTEM_PROMPT, format: analysisJsonSchema, version: BASELINE_CLASSIFIER_VERSION })),
        validatorSource,
      ])),
      model: config.model,
      mapping: options.mapping,
      rowCount: rows.length,
    };
    if (mode === 'rag') {
      const pipelineFiles = ['../services/ollama.js', '../services/embeddings.js', '../services/rag.js', '../db/knowledgeRepository.js'];
      metadata.mode = 'rag';
      metadata.knowledgeSha256 = knowledgeLock.fingerprint;
      metadata.ragPipelineSha256 = sha256(Buffer.concat(pipelineFiles.map((file) => fs.readFileSync(path.join(__dirname, file)))));
    }
    const checkpoint = openCheckpoint(outputDir, metadata, rows, {
      compatibleClassifierHashes: mode === 'baseline' ? [LEGACY_BASELINE_CLASSIFIER_SHA256] : [],
    });
    const pending = rows.length - checkpoint.completed.size;
    print(`Dataset rows: ${rows.length}; checkpointed: ${checkpoint.completed.size}; pending: ${pending}`);
    if (pending > 0) {
      const status = await ollama.status();
      if (!status.modelAvailable) throw new Error('gemma3:12b is not available in Ollama');
      print('Ollama model ready: gemma3:12b');
    }

    let processed = checkpoint.completed.size;
    for (const row of rows) {
      if (checkpoint.completed.has(row.messageId)) continue;
      const started = performance.now();
      let result;
      try {
        const analysis = await analysisService.analyze({ sender: row.sender, text: row.text, receivedAt: row.receivedAt });
        result = {
          messageId: row.messageId,
          groundTruth: row.groundTruth,
          prediction: analysis.classification,
          confidence: analysis.confidence,
          rationale: safeRationale(analysis.rationale, row.text),
          inferenceDurationMs: Math.round(performance.now() - started),
          error: null,
        };
      } catch (error) {
        result = {
          messageId: row.messageId,
          groundTruth: row.groundTruth,
          prediction: null,
          confidence: null,
          rationale: null,
          inferenceDurationMs: Math.round(performance.now() - started),
          error: error instanceof OllamaError || error instanceof RagError ? error.code : 'EVALUATION_ERROR',
        };
      }
      checkpoint.append(result);
      processed += 1;
      print(`Processed ${processed}/${rows.length}${result.error ? ' (error)' : ''}`);
    }

    const results = rows.map((row) => checkpoint.completed.get(row.messageId));
    const metrics = calculateMetrics(results);
    const report = {
      metadata: { ...metadata, generatedAt: new Date().toISOString() },
      metrics,
      results,
    };
    writeAtomic(path.join(outputDir, 'evaluation.json'), `${JSON.stringify(report, null, 2)}\n`);
    writeAtomic(path.join(outputDir, 'evaluation.csv'), resultsToCsv(results));
    writeAtomic(path.join(outputDir, 'evaluation-metrics.csv'), metricsToCsv(metrics));
    print(`Reports written to ${outputDir}`);
    return report;
  } finally {
    try {
      try {
        if (knowledgeLock) await knowledgeLock.release();
      } finally {
        if (pool) await pool.end();
      }
    } finally {
      releaseLock();
    }
  }
}

module.exports = { runEvaluation, safeRationale };
