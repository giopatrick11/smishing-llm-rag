const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { Client } = require('pg');
const { enrollProductionInstallation } = require('../production/enrollment');
const { createProductionRepository } = require('../production/repository');
const { validateProductionResponse } = require('../production/smsContract');
const { loadDatabaseUrl } = require('../config/env');

function assertIsolatedTarget(urlString) {
  const url = new URL(urlString);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) ||
    url.hostname !== '127.0.0.1' || url.port !== '55435' ||
    url.pathname !== '/apcida' || url.search || url.hash) {
    throw new Error('A disposable loopback PostgreSQL target on port 55435 is required');
  }
}

async function prepare() {
  assertIsolatedTarget(process.env.DATABASE_URL);
  const sourceUrl = loadDatabaseUrl({ DATABASE_URL: process.env.APCIDA_PHASE3S_SOURCE_DATABASE_URL });
  const source = new Client({ connectionString: sourceUrl,
    connectionTimeoutMillis: 5000 });
  const target = new Client({ connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 5000 });
  await source.connect();
  try {
    await target.connect();
    try {
      await source.query('BEGIN READ ONLY');
      const sourceIdentity = await source.query('SELECT current_database() AS name');
      if (sourceIdentity.rows[0]?.name !== 'apcida') throw new Error('Expected approved apcida RAG source');
      const rows = await source.query(`SELECT content, label, embedding::text AS embedding,
        embedding_model, source_type, source_reference, approved_at, is_active,
        normalized_hash, approved_by FROM rag_knowledge WHERE is_active = true`);
      if (rows.rowCount !== 100) throw new Error('Expected exactly 100 active approved RAG records');
      await target.query('BEGIN');
      for (const row of rows.rows) {
        await target.query(`INSERT INTO rag_knowledge (content, label, embedding,
          embedding_model, source_type, source_reference, approved_at, is_active,
          normalized_hash, approved_by) VALUES ($1,$2,$3::vector,$4,$5,$6,$7,$8,$9,$10)`,
        [row.content, row.label, row.embedding, row.embedding_model, row.source_type,
          row.source_reference, row.approved_at, row.is_active, row.normalized_hash,
          row.approved_by]);
      }
      await target.query('COMMIT');
      await source.query('COMMIT');
      const enrollment = await enrollProductionInstallation(createProductionRepository(target),
        { label: 'Phase3SSynthetic', days: 1 });
      fs.writeFileSync(process.env.APCIDA_PHASE3S_TOKEN_FILE, enrollment.token,
        { flag: 'wx', mode: 0o600 });
      process.stdout.write(`Copied ${rows.rowCount} approved records to disposable staging; enrolled one temporary installation.\n`);
    } finally { await target.end(); }
  } finally { await source.end(); }
}

async function verify() {
  const token = fs.readFileSync(process.env.APCIDA_PHASE3S_TOKEN_FILE, 'utf8');
  const messageId = randomUUID();
  const request = { messageId, sender: 'ManualTest',
    text: 'Synthetic test: Your bank account will be frozen. Send your one-time code to this number now.',
    receivedAt: new Date().toISOString() };
  const started = Date.now();
  const response = await fetch('http://127.0.0.1:3020/api/v1/sms/analyze', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`,
      'Idempotency-Key': messageId, 'Content-Type': 'application/json' },
    body: JSON.stringify(request), signal: AbortSignal.timeout(120000),
  });
  const payload = await response.json();
  if (response.status !== 200 || !validateProductionResponse(payload, messageId)) {
    process.stdout.write(`Synthetic live request: HTTP ${response.status}, error=${payload.error || 'INVALID_RESPONSE'}, elapsed_ms=${Date.now() - started}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`Synthetic live request: HTTP 200, classification=${payload.classification}, confidence=${payload.confidence}, elapsed_ms=${Date.now() - started}\n`);
  const replay = await fetch('http://127.0.0.1:3020/api/v1/sms/analyze', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`,
      'Idempotency-Key': messageId, 'Content-Type': 'application/json' },
    body: JSON.stringify(request), signal: AbortSignal.timeout(5000),
  });
  const replayPayload = await replay.json();
  if (replay.status !== 200 || JSON.stringify(replayPayload) !== JSON.stringify(payload)) {
    throw new Error('Synthetic replay was not identical');
  }
  process.stdout.write(`Synthetic duplicate replay: HTTP 200, same response, elapsed_ms=${Date.now() - started}\n`);
}

if (require.main === module) {
  const command = process.argv[2];
  (command === 'prepare' ? prepare() : command === 'verify' ? verify() :
    Promise.reject(new Error('Expected prepare or verify'))).catch((error) => {
    process.stderr.write(`Phase 3S synthetic check failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { assertIsolatedTarget, prepare, verify };
