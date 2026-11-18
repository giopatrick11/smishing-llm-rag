const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const dotenv = require('dotenv');
const { createEmbeddingService, EMBEDDING_MODEL } = require('../services/embeddings');
const { createOllamaService, OllamaError } = require('../services/ollama');
const { createDatabasePool, checkRagDatabase } = require('../db/pool');
const { createKnowledgeRepository } = require('../db/knowledgeRepository');
const { lockAndCheckRagKnowledge } = require('../knowledge/evaluationGuard');
const { loadEvaluationConfig, loadDatabaseUrl } = require('../config/env');
const { loadDataset } = require('./csv');
const { loadRows } = require('./threeClassStudy');
const { acquireRunLock, writeAtomic } = require('./checkpoint');
const { projectRoot, evaluationResultsDir } = require('../paths');

const EXPLORATORY = path.join(projectRoot, 'dataset/apcida_three_class_exploratory_v1.json');
const TIMEOUTS = path.join(projectRoot, 'dataset/apcida_phase2h_timeout_diagnostic_2.csv');
const OUTPUT = path.join(evaluationResultsDir, 'rag-investigation-2026-11-13-v3');
const TIMEOUT_SUBSET_SHA256 = '323586c5f0f0c1bf29f74e2ac7e9f184c9acc17a45816ef66250deacdfe8832b';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function parseArgs(args) {
  const [flag, envFile, ...rest] = args;
  if (flag !== '--env-file' || !envFile || (rest.length !== 0
    && (rest.length !== 2 || rest[0] !== '--output-dir' || !rest[1]))) {
    throw new Error('Usage: node src/evaluation/ragInvestigation.js --env-file PRIVATE_ENV [--output-dir DIR]');
  }
  const outputDir = rest.length ? path.resolve(rest[1]) : OUTPUT;
  if (!outputDir.startsWith(`${path.resolve(evaluationResultsDir)}${path.sep}`)
    || !path.basename(outputDir).startsWith('rag-investigation-')) {
    throw new Error('Diagnostic output must be a rag-investigation-* directory under evaluation-results');
  }
  return { envFile: path.resolve(envFile), outputDir };
}

function cosine(left, right) {
  if (!Array.isArray(left) || left.length !== right?.length || left.length === 0) {
    throw new Error('Incompatible embedding vectors');
  }
  let dot = 0; let normLeft = 0; let normRight = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    normLeft += left[index] ** 2;
    normRight += right[index] ** 2;
  }
  if (normLeft === 0 || normRight === 0) throw new Error('Zero-length embedding direction');
  return dot / Math.sqrt(normLeft * normRight);
}

function referenceMetadata(examples) {
  return examples.map((example) => ({ id: String(example.id), label: example.label,
    similarity: example.similarity }));
}

async function timed(action) {
  const started = performance.now();
  const value = await action();
  return { value, ms: Math.round(performance.now() - started) };
}

async function run({ envFile, outputDir = OUTPUT }, { print = (line) => process.stdout.write(`${line}\n`) } = {}) {
  if (fs.statSync(envFile).mode & 0o077) throw new Error('Private environment file must be owner-only');
  const env = dotenv.parse(fs.readFileSync(envFile));
  const config = loadEvaluationConfig(env);
  const { rows: exploratory, datasetSha256 } = loadRows(EXPLORATORY);
  const timeoutBytes = fs.readFileSync(TIMEOUTS);
  if (sha256(timeoutBytes) !== TIMEOUT_SUBSET_SHA256) throw new Error('Historical timeout subset hash changed');
  const historical = loadDataset(timeoutBytes.toString('utf8'), {
    idColumn: 'message_id', textColumn: 'sms_text', labelColumn: 'label',
  });
  if (historical.length !== 2 || historical[0].messageId !== 'SF016'
    || historical[1].messageId !== 'SF046') throw new Error('Unexpected historical timeout subset');
  const rows = [...exploratory, ...historical];
  const pool = createDatabasePool(loadDatabaseUrl(env), { statementTimeoutMillis: 10000 });
  let knowledgeLock;
  let releaseRunLock;
  try {
    await checkRagDatabase(pool);
    knowledgeLock = await lockAndCheckRagKnowledge(pool, rows);
    if (!knowledgeLock.activeCount) throw new Error('No approved RAG knowledge');
    const response = await fetch(`${config.ollamaUrl}/api/tags`,
      { signal: AbortSignal.timeout(config.requestTimeoutMs) });
    if (!response.ok) throw new Error('Ollama model list unavailable');
    const models = (await response.json()).models;
    if (!Array.isArray(models)) throw new Error('Invalid Ollama model list');
    const gemmaModel = models.find((model) => model.name === config.model || model.model === config.model);
    const embeddingModel = models.find((model) => model.name === EMBEDDING_MODEL
      || model.name === `${EMBEDDING_MODEL}:latest` || model.model === EMBEDDING_MODEL);
    if (!gemmaModel?.digest || !embeddingModel?.digest) throw new Error('Required local model unavailable');
    releaseRunLock = acquireRunLock(outputDir);
    const outputPath = path.join(outputDir, 'report.json');
    if (fs.existsSync(outputPath)) throw new Error('Diagnostic report already exists; preserve the previous run');
    const embedding = createEmbeddingService(config);
    const repository = createKnowledgeRepository(pool);
    const ollama = createOllamaService(config);
    const results = [];
    for (const row of rows) {
      const embed = await timed(() => embedding.embed(row.text));
      const actual = await timed(() => repository.search(embed.value));
      const nearest = await timed(() => repository.search(embed.value, { limit: 3, minSimilarity: 0 }));
      const result = { id: row.messageId, source: row.messageId.startsWith('T') ? 'exploratory' : 'phase2g-timeout',
        embeddingMs: embed.ms, retrievalMs: actual.ms, nearestQueryMs: nearest.ms,
        retrieved: referenceMetadata(actual.value), nearest: referenceMetadata(nearest.value) };
      if (result.retrieved.length === 0) {
        const repeated = await timed(() => embedding.embed(row.text));
        const repeatedNearest = await timed(() => repository.search(repeated.value,
          { limit: 1, minSimilarity: 0 }));
        result.repeatEmbeddingMs = repeated.ms;
        result.repeatEmbeddingCosine = cosine(embed.value, repeated.value);
        result.repeatTopSimilarity = repeatedNearest.value[0]?.similarity ?? null;
      }
      if (result.source === 'phase2g-timeout') {
        const chatStarted = performance.now();
        try {
          const chat = await ollama.analyze({ text: row.text }, actual.value);
          result.chatClassification = chat.classification;
          result.chatError = null;
        } catch (error) {
          if (!(error instanceof OllamaError)) throw error;
          result.chatClassification = null;
          result.chatError = error.code || error.name;
        } finally {
          result.chatMs = Math.round(performance.now() - chatStarted);
        }
      }
      results.push(result);
      print(`${result.id}: ${result.retrieved.length} reference(s); embedding ${result.embeddingMs} ms, retrieval ${result.retrievalMs} ms${result.chatMs === undefined ? '' : `, chat ${result.chatMs ?? result.chatError}`}`);
    }
    const report = { metadata: { exploratoryDatasetSha256: datasetSha256,
      timeoutDatasetSha256: sha256(timeoutBytes), knowledgeSha256: knowledgeLock.fingerprint,
      knowledgeCount: knowledgeLock.activeCount, model: config.model,
      embeddingModel: EMBEDDING_MODEL,
      modelDigests: { gemma: gemmaModel.digest, embedding: embeddingModel.digest },
      diagnosticPipelineSha256: sha256(Buffer.concat([__filename, '../services/embeddings.js',
        '../services/ollama.js', '../db/knowledgeRepository.js',
        '../knowledge/evaluationGuard.js', './threeClassStudy.js']
        .map((file) => fs.readFileSync(path.resolve(__dirname, file))))),
      topK: 3, productionMinSimilarity: 0.72 }, results };
    writeAtomic(outputPath, `${JSON.stringify(report, null, 2)}\n`);
    print(`Diagnostic report written to ${outputPath}`);
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
  run(parseArgs(process.argv.slice(2))).catch((error) => {
    process.stderr.write(`RAG investigation failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, cosine, referenceMetadata, run };
