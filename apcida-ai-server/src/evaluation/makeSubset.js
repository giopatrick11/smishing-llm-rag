const fs = require('node:fs');
const path = require('node:path');
const { parseCsv, loadDataset } = require('./csv');
const { loadDatabaseUrl } = require('../config/env');
const { createDatabasePool, checkRagDatabase } = require('../db/pool');
const { lockAndCheckRagKnowledge } = require('../knowledge/evaluationGuard');
const { datasetDir } = require('../paths');

const SEED = 20261027;
const INPUT = path.join(datasetDir, 'apcida_synthetic_sms_200.csv');
const OUTPUT = path.join(datasetDir, 'apcida_synthetic_sms_50.csv');
const MAPPING = { idColumn: 'message_id', textColumn: 'sms_text', labelColumn: 'label' };

function random(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function choose(rows, label, rng) {
  const items = rows.filter((row) => row.groundTruth === label);
  for (let index = items.length - 1; index > 0; index -= 1) {
    const other = Math.floor(rng() * (index + 1));
    [items[index], items[other]] = [items[other], items[index]];
  }
  if (items.length < 25) throw new Error(`Dataset has fewer than 25 ${label} rows`);
  return items.slice(0, 25);
}

function makeSubset(csvText, seed = SEED, excludedIds = new Set()) {
  const records = parseCsv(csvText);
  const rows = loadDataset(csvText, MAPPING).filter((row) => !excludedIds.has(row.messageId));
  const rng = random(seed);
  const selectedIds = new Set([...choose(rows, 'SCAM', rng), ...choose(rows, 'SAFE', rng)].map((row) => row.messageId));
  const selected = rows.filter((row) => selectedIds.has(row.messageId));
  const escape = (value) => /[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
  const outputRows = [records[0], ...records.slice(1).filter((record) => selectedIds.has(record[0].trim()))];
  const output = `${outputRows.map((record) => record.map(escape).join(',')).join('\n')}\n`;
  if (selected.length !== 50 || selected.filter((row) => row.groundTruth === 'SCAM').length !== 25) throw new Error('Subset balance check failed');
  return { output, selected };
}

async function main() {
  const { output, selected } = makeSubset(fs.readFileSync(INPUT, 'utf8'));
  const pool = createDatabasePool(loadDatabaseUrl());
  let lock;
  try {
    await checkRagDatabase(pool);
    lock = await lockAndCheckRagKnowledge(pool, selected);
    if (lock.activeCount !== 100) throw new Error(`Expected 100 approved RAG records; found ${lock.activeCount}`);
    if (fs.existsSync(OUTPUT)) {
      if (fs.readFileSync(OUTPUT, 'utf8') !== output) throw new Error('Existing 50-message subset differs from reproducible output');
    } else {
      fs.writeFileSync(OUTPUT, output, { flag: 'wx', mode: 0o600 });
    }
    process.stdout.write(`Created/verified ${OUTPUT}: 25 SCAM, 25 SAFE; seed ${SEED}; ${lock.activeCount} approved RAG records checked.\n`);
  } finally {
    try { if (lock) await lock.release(); }
    finally { await pool.end(); }
  }
}

if (require.main === module) main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });

module.exports = { makeSubset, SEED };
