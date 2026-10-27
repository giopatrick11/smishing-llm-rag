const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseKnowledgeCsv, loadEvaluationCorpus } = require('../src/knowledge/csv');
const { signature, duplicateKind } = require('../src/knowledge/dedupe');
const { requireAdmin } = require('../src/knowledge/adminAuth');
const { stageImport, approveEntry } = require('../src/knowledge/adminRepository');
const { lockAndCheckRagKnowledge } = require('../src/knowledge/evaluationGuard');
const { parseOptions } = require('../src/knowledge/cli');
const { parseArgs } = require('../src/evaluation/cli');
const { metadataMatches } = require('../src/evaluation/checkpoint');

const csv = '\uFEFFexternal_id,content,label,reviewer,reviewed_at,source_reference\n'
  + 'k-1,"Your package delivery requires a payment at this link",SCAM,Ana,2026-10-25T10:00:00+08:00,review-ticket-1\n';

test('knowledge CSV requires independently reviewed SCAM/SAFE rows', () => {
  const rows = parseKnowledgeCsv(csv);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].label, 'SCAM');
  assert.equal(rows[0].reviewer, 'Ana');
  assert.equal(rows[0].signature.hash.length, 64);
  assert.throws(() => parseKnowledgeCsv(csv.replace(',SCAM,', ',SUSPICIOUS,')), /invalid label/);
  assert.throws(() => parseKnowledgeCsv(csv.replace(',Ana,', ',,')), /reviewer metadata/);
  assert.throws(() => parseKnowledgeCsv(csv + csv.split('\n')[1] + '\n'), /duplicate external_id/);
});

test('workflow migration has pending states and never seeds knowledge', () => {
  const sql = fs.readFileSync(path.join(__dirname, '../src/db/migrations/002_knowledge_workflow.sql'), 'utf8');
  assert.match(sql, /PENDING_EMBEDDING/);
  assert.match(sql, /PENDING_APPROVAL/);
  assert.match(sql, /approved_by text/);
  assert.doesNotMatch(sql, /\b(?:INSERT|COPY)\b/i);
});

test('normalization and near duplicate checks catch template variants', () => {
  assert.equal(duplicateKind(signature('Your OTP is 123456. Visit https://example.com now'),
    signature('Your OTP is 987654. Visit https://other.test now')), 'EXACT');
  assert.equal(duplicateKind(signature('Your package delivery requires a payment at this link'),
    signature('Your package delivery require payment at this link')), 'NEAR');
  assert.equal(duplicateKind(signature('Your package delivery requires a payment at this link'),
    signature('The weather is sunny today')), null);
});

test('evaluation contamination corpus is read for checking without changing the file', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'apcida-corpus-'));
  try {
    const file = path.join(directory, 'evaluation.csv');
    const bytes = Buffer.from('\uFEFFmessage_id,sms_text,label\n1,"Your package delivery require payment at this link",SCAM\n');
    fs.writeFileSync(file, bytes);
    const corpus = loadEvaluationCorpus(file, 'sms_text');
    assert.equal(corpus.entries.length, 1);
    assert.equal(corpus.sha256.length, 64);
    assert.deepEqual(fs.readFileSync(file), bytes);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('administrator commands require a matching secret without exposing it', () => {
  const key = 'a'.repeat(64);
  assert.doesNotThrow(() => requireAdmin({ RAG_ADMIN_KEY: key, APCIDA_ADMIN_TOKEN: key }));
  assert.throws(() => requireAdmin({ RAG_ADMIN_KEY: key, APCIDA_ADMIN_TOKEN: 'wrong' }), /authentication failed/);
  assert.throws(() => requireAdmin({ RAG_ADMIN_KEY: key }), /APCIDA_ADMIN_TOKEN/);
  assert.deepEqual(parseOptions(['--id', '7', '--approver', 'Admin', '--confirm-reviewed'],
    ['--id', '--approver', '--confirm-reviewed'], ['--confirm-reviewed']),
    { '--id': '7', '--approver': 'Admin', '--confirm-reviewed': true });
});

function fakeStagePool() {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('pg_try_advisory_xact_lock')) return { rows: [{ locked: true }] };
      if (sql.includes('SELECT id, external_id, content, status')) return { rows: [] };
      if (sql.includes('SELECT id, content FROM rag_knowledge')) return { rows: [] };
      if (sql.includes('INSERT INTO rag_knowledge_staging')) return { rows: [{ id: '1' }] };
      return { rows: [] };
    },
    release() {},
  };
  return { calls, connect: async () => client };
}

test('contamination blocks all staging writes; clean import only stages entries', async () => {
  const rows = parseKnowledgeCsv(csv);
  const pool = fakeStagePool();
  const corpus = { sha256: 'corpus-hash', entries: [{ id: 'eval-1', signature: signature('Your package delivery require payment at this link') }] };
  await assert.rejects(stageImport(pool, rows, corpus), /evaluation corpus \(NEAR\)/);
  assert.equal(pool.calls.filter((call) => call.sql.includes('INSERT INTO rag_knowledge_staging')).length, 0);
  const ids = await stageImport(pool, rows, null);
  assert.deepEqual(ids, ['1']);
  assert.equal(pool.calls.filter((call) => call.sql.includes('INSERT INTO rag_knowledge_staging')).length, 1);
  assert.equal(pool.calls.filter((call) => call.sql.includes('INSERT INTO rag_knowledge\n')).length, 0);
});

test('manual approval requires an embedded pending row and inserts active knowledge once', async () => {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('pg_try_advisory_xact_lock')) return { rows: [{ locked: true }] };
      if (sql.includes('FROM rag_knowledge_staging WHERE id = $1 FOR UPDATE')) return { rows: [{
        id: '1', content: 'Human reviewed message', label: 'SAFE', source_reference: 'review-ticket-1',
        normalized_hash: signature('Human reviewed message').hash, embedding_text: '[0.1,0.2]', status: 'PENDING_APPROVAL',
      }] };
      if (sql.includes('SELECT id, content FROM rag_knowledge')) return { rows: [] };
      if (sql.includes('INSERT INTO rag_knowledge\n')) return { rows: [{ id: '10' }] };
      return { rows: [] };
    },
    release() {},
  };
  const pool = { connect: async () => client };
  assert.equal(await approveEntry(pool, '1', 'Administrator'), '10');
  assert.equal(calls.filter((call) => call.sql.includes('INSERT INTO rag_knowledge\n')).length, 1);
  assert.ok(calls.some((call) => call.sql.includes("SET status = 'APPROVED'")));
});

test('RAG evaluation blocks contaminated active knowledge and isolates its output directory', async () => {
  const row = { messageId: 'eval-1', text: 'Your package delivery requires a payment at this link' };
  let released = false;
  const client = {
    async query(sql) {
      if (sql.includes('SELECT id, content, label')) return { rows: [{
        id: '7', content: 'Your package delivery require payment at this link', label: 'SCAM',
        embedding_model: 'nomic-embed-text', embedding_hash: 'hash', approved_by: 'Admin', approved_at: new Date(),
      }] };
      return { rows: [] };
    },
    release() { released = true; },
  };
  await assert.rejects(lockAndCheckRagKnowledge({ connect: async () => client }, [row]), /RAG evaluation blocked/);
  assert.equal(released, true);
  assert.throws(() => parseArgs(['--input', 'data.csv', '--text-column', 'sms', '--label-column', 'label', '--mode', 'rag']), /requires a new --output-dir/);
  const options = parseArgs(['--input', 'data.csv', '--text-column', 'sms', '--label-column', 'label', '--mode', 'rag', '--output-dir', '../evaluation-results/rag-200']);
  assert.equal(options.mode, 'rag');
  assert.notEqual(options.outputDir, path.resolve(__dirname, '../../evaluation-results/baseline-200'));
  assert.equal(metadataMatches({ mode: 'rag', knowledgeSha256: 'old', classifierSha256: 'same' },
    { mode: 'rag', knowledgeSha256: 'new', classifierSha256: 'same' }), false);
});

test('RAG evaluation fingerprints approved knowledge under a shared lock', async () => {
  let released = false;
  const client = {
    async query(sql) {
      if (sql.includes('SELECT id, content, label')) return { rows: [{
        id: '10', content: 'An unrelated curated pattern', label: 'SAFE',
        embedding_model: 'nomic-embed-text', embedding_hash: 'vector-hash',
        approved_by: 'Admin', approved_at: new Date('2026-10-26T00:00:00Z'),
      }] };
      return { rows: [] };
    },
    release() { released = true; },
  };
  const lock = await lockAndCheckRagKnowledge({ connect: async () => client }, [{ messageId: 'eval-1', text: 'A different message' }]);
  assert.equal(lock.activeCount, 1);
  assert.equal(lock.fingerprint.length, 64);
  await lock.release();
  assert.equal(released, true);
});
