const fs = require('node:fs');
const path = require('node:path');
const { datasetDir } = require('../paths');
const { loadDataset } = require('./csv');
const { makeSubset } = require('./makeSubset');
const { loadDatabaseUrl } = require('../config/env');
const { createDatabasePool, checkRagDatabase } = require('../db/pool');
const { lockAndCheckRagKnowledge } = require('../knowledge/evaluationGuard');

const SEED = 20261029;
const mapping = { idColumn: 'message_id', textColumn: 'sms_text', labelColumn: 'label' };
const originalPath = path.join(datasetDir, 'apcida_synthetic_sms_200.csv');
const evaluationPath = path.join(datasetDir, 'apcida_synthetic_sms_50.csv');
const developmentPath = path.join(datasetDir, 'apcida_synthetic_sms_50_development.csv');
const outputPath = path.join(datasetDir, 'apcida_synthetic_sms_50_holdout_phase2f.csv');

function buildHoldoutSet(originalCsv, evaluationCsv, developmentCsv) {
  const excluded = new Set([
    ...loadDataset(evaluationCsv, mapping),
    ...loadDataset(developmentCsv, mapping),
  ].map((row) => row.messageId));
  if (excluded.size !== 100) throw new Error('Expected two disjoint 50-message sets');
  const result = makeSubset(originalCsv, SEED, excluded);
  if (result.selected.some((row) => excluded.has(row.messageId))) throw new Error('Holdout overlaps an inspected set');
  return result;
}

async function main() {
  const result = buildHoldoutSet(fs.readFileSync(originalPath, 'utf8'),
    fs.readFileSync(evaluationPath, 'utf8'), fs.readFileSync(developmentPath, 'utf8'));
  const pool = createDatabasePool(loadDatabaseUrl());
  let lock;
  try {
    await checkRagDatabase(pool);
    lock = await lockAndCheckRagKnowledge(pool, result.selected);
    if (lock.activeCount !== 100) throw new Error(`Expected 100 approved RAG records; found ${lock.activeCount}`);
    if (fs.existsSync(outputPath)) {
      if (fs.readFileSync(outputPath, 'utf8') !== result.output) throw new Error('Existing holdout differs from fixed-seed selection');
    } else fs.writeFileSync(outputPath, result.output, { flag: 'wx', mode: 0o600 });
    process.stdout.write(`Created/verified ${outputPath}: 25 SCAM, 25 SAFE; disjoint from inspected sets; no approved RAG duplicates.\n`);
  } finally {
    try { if (lock) await lock.release(); }
    finally { await pool.end(); }
  }
}

if (require.main === module) main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });

module.exports = { buildHoldoutSet, SEED };
