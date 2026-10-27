const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { signature } = require('../src/knowledge/dedupe');
const { getApproveAllPreview, parseIds, createApprovalPlan, applyApproveAll } = require('../src/knowledge/approveAll');
const { approveAllSession } = require('../src/knowledge/cli');

const corpus = {
  sha256: 'reviewed-corpus',
  entries: [{ id: 'evaluation-1', signature: signature('A school enrollment notice for next month') }],
};

function staged(id, content) {
  return {
    id: String(id), external_id: `reviewed-${id}`, content, label: 'SCAM', reviewer: 'edison',
    reviewed_at: new Date('2026-10-26T00:00:00+08:00'), source_reference: 'independent-review-2026',
    normalized_hash: signature(content).hash, evaluation_corpus_sha256: corpus.sha256,
    status: 'PENDING_APPROVAL', embedding_model: 'nomic-embed-text', embedding_error: null,
    has_embedding: true, embedded_at: new Date('2026-10-26T01:00:00+08:00'), embedding_text: '[0.1,0.2]',
  };
}

const row4 = staged(4, 'Claim a reward by giving your bank password to this sender');
const row5 = staged(5, 'Your clinic appointment is confirmed for Tuesday afternoon');
const row6 = staged(6, 'Pay an unexpected customs fee before claiming the package');

function fakePool(rows, { failInsert = 0 } = {}) {
  const calls = [];
  let inserts = 0;
  const query = async (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes('pg_try_advisory_xact_lock')) return { rows: [{ locked: true }] };
    if (sql.includes("WHERE status = 'PENDING_APPROVAL' ORDER BY id")) return { rows };
    if (sql.includes('SELECT id, content FROM rag_knowledge_staging')) {
      return { rows: rows.map((row) => ({ id: row.id, content: row.content })) };
    }
    if (sql.includes('SELECT id, content FROM rag_knowledge')) return { rows: [] };
    if (sql.includes("SET status = 'REJECTED'")) return { rowCount: params[0].length };
    if (sql.includes('INSERT INTO rag_knowledge\n')) {
      inserts += 1;
      if (inserts === failInsert) throw new Error('simulated database failure');
      return { rows: [{ id: String(100 + inserts) }] };
    }
    return { rows: [] };
  };
  return { calls, query, connect: async () => ({ query, release() {} }) };
}

test('approve-all CLI requires the existing administrator token before opening the database', () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, '../src/knowledge/cli.js'),
    'approve-all', '--approver', 'giopatrick', '--preview'], {
    encoding: 'utf8', env: { ...process.env, RAG_ADMIN_KEY: 'a'.repeat(32), APCIDA_ADMIN_TOKEN: '' },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /APCIDA_ADMIN_TOKEN is required/);
  assert.doesNotMatch(result.stderr, /Claim a reward|clinic appointment/);
});

test('preview includes only pending entries and blocks missing or failed evidence', async () => {
  const invalid = { ...row5, reviewer: '', reviewed_at: null, source_reference: '', has_embedding: false, embedded_at: null,
    evaluation_corpus_sha256: null };
  const pool = fakePool([row4, invalid]);
  const preview = await getApproveAllPreview(pool, corpus);
  assert.equal(preview.pendingCount, 2);
  assert.deepEqual(preview.eligibleIds, ['4']);
  assert.deepEqual(preview.snapshotIds, ['4', '5']);
  assert.ok(preview.blocked[0].problems.includes('INVALID_REVIEW_METADATA'));
  assert.ok(preview.blocked[0].problems.includes('NOT_READY_FOR_APPROVAL'));
  assert.ok(preview.blocked[0].problems.includes('CORPUS_UNCHECKED'));
  assert.ok(pool.calls[0].sql.includes("WHERE status = 'PENDING_APPROVAL'"));
});

test('preview blocks contamination, knowledge duplicates, and changed content hashes', async () => {
  const copiedEval = staged(7, 'A school enrollment notice for next month');
  const copiedKnowledge = staged(8, row4.content);
  const changedHash = { ...row6, normalized_hash: 'invalid-hash' };
  const pool = fakePool([row4, copiedEval, copiedKnowledge, changedHash]);
  const preview = await getApproveAllPreview(pool, corpus);
  assert.equal(preview.eligibleIds.length, 0);
  assert.ok(preview.blocked.find((entry) => entry.id === '7').problems.includes('EVALUATION_EXACT'));
  assert.ok(preview.blocked.find((entry) => entry.id === '8').problems.includes('KNOWLEDGE_EXACT'));
  assert.ok(preview.blocked.find((entry) => entry.id === '6').problems.includes('CONTENT_HASH_MISMATCH'));
});

test('plan permits exclusion and rejection, but never approves a blocked entry', () => {
  const preview = { pendingCount: 3, snapshotIds: ['4', '5', '6'], eligibleIds: ['4', '5'],
    blocked: [{ id: '6', problems: ['CORPUS_UNCHECKED'] }] };
  assert.deepEqual(parseIds('4, 5', preview.snapshotIds), ['4', '5']);
  assert.throws(() => parseIds('4,4', preview.snapshotIds), /distinct/);
  assert.throws(() => parseIds('9', preview.snapshotIds), /displayed/);
  assert.throws(() => createApprovalPlan(preview, [], [], null), /Blocked IDs/);
  assert.throws(() => createApprovalPlan(preview, ['6'], ['6'], 'bad label'), /distinct/);
  assert.throws(() => createApprovalPlan(preview, [], ['6'], ''), /rejection reason/);
  assert.deepEqual(createApprovalPlan(preview, ['5'], ['6'], 'not verified').approveIds, ['4']);
});

test('interactive session requires exact confirmation after exclusions and rejections', async () => {
  const preview = { pendingCount: 3, snapshotIds: ['4', '5', '6'], eligibleIds: ['4', '5', '6'], blocked: [] };
  let writes = 0;
  const run = (answers) => approveAllSession(preview, {
    ask: async () => answers.shift(), print: () => {}, approver: 'giopatrick',
    apply: async (plan) => { writes += 1; assert.deepEqual(plan.approveIds, ['4']);
      assert.deepEqual(plan.excludeIds, ['5']); assert.deepEqual(plan.rejectIds, ['6']);
      return { approved: 1, rejected: 1, excluded: 1 }; },
  });
  assert.equal(await run(['5', '6', 'incorrect label', 'yes']), null);
  assert.equal(writes, 0);
  assert.deepEqual(await run(['5', '6', 'incorrect label', 'APPROVE 1 REJECT 1 AS giopatrick']),
    { approved: 1, rejected: 1, excluded: 1 });
  assert.equal(writes, 1);
});

test('bulk approval writes the approver and approval time in one transaction', async () => {
  const pool = fakePool([row4, row5, row6]);
  const preview = await getApproveAllPreview(pool, corpus);
  const plan = createApprovalPlan(preview, ['5'], ['6'], 'exclude incorrect label');
  const result = await applyApproveAll(pool, plan, 'giopatrick', corpus);
  assert.deepEqual(result, { approved: 1, rejected: 1, excluded: 1 });
  const insert = pool.calls.find((call) => call.sql.includes('INSERT INTO rag_knowledge\n'));
  assert.equal(insert.params.at(-1), 'giopatrick');
  assert.equal(insert.params[1], row4.label);
  assert.ok(insert.sql.includes('approved_at'));
  const approved = pool.calls.find((call) => call.sql.includes("SET status = 'APPROVED'"));
  const rejected = pool.calls.find((call) => call.sql.includes("SET status = 'REJECTED'"));
  assert.equal(approved.params[1], 'giopatrick');
  assert.equal(rejected.params[1], 'giopatrick');
  assert.ok(approved.sql.includes('approved_at = now()'));
  assert.ok(rejected.sql.includes('approved_at = now()'));
  assert.equal(pool.calls.filter((call) => call.sql === 'COMMIT').length, 1);
  assert.equal(pool.calls.filter((call) => call.sql === 'ROLLBACK').length, 0);
});

test('bulk approval rechecks evidence and aborts on changed pending entries', async () => {
  const preview = await getApproveAllPreview(fakePool([row4, row5]), corpus);
  const plan = createApprovalPlan(preview, [], [], null);
  const changed = fakePool([row4, { ...row5, evaluation_corpus_sha256: 'changed' }]);
  await assert.rejects(applyApproveAll(changed, plan, 'giopatrick', corpus), /CORPUS_MISMATCH/);
  assert.equal(changed.calls.filter((call) => call.sql.includes('INSERT INTO rag_knowledge\n')).length, 0);
  assert.equal(changed.calls.filter((call) => call.sql === 'ROLLBACK').length, 1);
  const added = fakePool([row4, row5, row6]);
  await assert.rejects(applyApproveAll(added, plan, 'giopatrick', corpus), /changed since preview/);
  assert.equal(added.calls.filter((call) => call.sql === 'COMMIT').length, 0);
});

test('database failure during bulk approval rolls back all inserts and status changes', async () => {
  const pool = fakePool([row4, row5, row6], { failInsert: 2 });
  const preview = await getApproveAllPreview(pool, corpus);
  const plan = createApprovalPlan(preview, [], ['6'], 'incorrect source');
  await assert.rejects(applyApproveAll(pool, plan, 'giopatrick', corpus), /simulated database failure/);
  assert.equal(pool.calls.filter((call) => call.sql.includes("SET status = 'REJECTED'")).length, 1);
  assert.equal(pool.calls.filter((call) => call.sql === 'ROLLBACK').length, 1);
  assert.equal(pool.calls.filter((call) => call.sql === 'COMMIT').length, 0);
});
