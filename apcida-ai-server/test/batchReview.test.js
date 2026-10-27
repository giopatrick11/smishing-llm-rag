const test = require('node:test');
const assert = require('node:assert/strict');
const { signature } = require('../src/knowledge/dedupe');
const { checkStagedEntry, getReviewPage, approveBatch, parseSelectedIds } = require('../src/knowledge/batchReview');
const { reviewBatchSession, formatReviewPage } = require('../src/knowledge/cli');

function staged(id, content = id === 4
  ? 'Parcel delivery payment request from an unknown sender'
  : 'A routine appointment reminder for tomorrow morning') {
  return {
    id: String(id), external_id: `K-${id}`, content, label: 'SAFE', reviewer: 'edison',
    reviewed_at: new Date('2026-10-26T00:00:00+08:00'), source_reference: 'independent-review',
    normalized_hash: signature(content).hash, evaluation_corpus_sha256: 'corpus-hash',
    status: 'PENDING_APPROVAL', embedding_model: 'nomic-embed-text', embedding_error: null,
    has_embedding: true, embedded_at: new Date('2026-10-26T01:00:00+08:00'), embedding_text: '[0.1,0.2]',
  };
}
const corpus = { sha256: 'corpus-hash', entries: [{ id: 'eval-1', signature: signature('An unrelated evaluation SMS') }] };

test('batch review flags unresolved contamination, duplicates, and validation problems', () => {
  const row = staged(4);
  const references = [{ id: 'staged-4', signature: signature(row.content) }];
  assert.deepEqual(checkStagedEntry(row, references, corpus), []);
  assert.ok(checkStagedEntry({ ...row, label: 'MAYBE' }, references, corpus).includes('INVALID_LABEL'));
  assert.ok(checkStagedEntry({ ...row, normalized_hash: 'wrong' }, references, corpus).includes('CONTENT_HASH_MISMATCH'));
  assert.ok(checkStagedEntry({ ...row, evaluation_corpus_sha256: null }, references, corpus).includes('CORPUS_UNCHECKED'));
  assert.ok(checkStagedEntry({ ...row, evaluation_corpus_sha256: 'changed' }, references, corpus).includes('CORPUS_MISMATCH'));
  assert.ok(checkStagedEntry({ ...row, has_embedding: false }, references, corpus).includes('NOT_READY_FOR_APPROVAL'));
  assert.ok(checkStagedEntry({ ...row, content: 'An unrelated evaluation SMS' }, references, corpus).includes('EVALUATION_EXACT'));
  assert.ok(checkStagedEntry(row, [...references, { id: 'active-10', signature: signature(row.content) }], corpus).includes('KNOWLEDGE_EXACT'));
});

test('paged review shows required fields and only accepts IDs from that page', async () => {
  const row = staged(5);
  const pool = { async query(sql, params) {
    if (sql.includes('count(*)::integer AS total')) return { rows: [{ total: 11 }] };
    if (sql.includes('ORDER BY id LIMIT')) {
      assert.deepEqual(params, [10, 0]);
      return { rows: [row] };
    }
    if (sql.includes('SELECT id, content FROM rag_knowledge_staging')) return { rows: [{ id: row.id, content: row.content }] };
    if (sql.includes('SELECT id, content FROM rag_knowledge')) return { rows: [] };
    throw new Error('Unexpected query');
  } };
  const page = await getReviewPage(pool, { page: 1, pageSize: 10, corpus });
  assert.equal(page.pages, 2);
  assert.deepEqual(page.entries[0].duplicateCheckStatus, []);
  const printed = formatReviewPage(page);
  for (const value of ['K-5', row.content, 'SAFE', 'edison', 'independent-review', 'Duplicate/validation check: PASS']) {
    assert.ok(printed.includes(value));
  }
  assert.deepEqual(parseSelectedIds('5', page.entries), ['5']);
  assert.throws(() => parseSelectedIds('6', page.entries), /shown on this page/);
  assert.throws(() => parseSelectedIds('5,5', page.entries), /distinct/);
});

test('batch session requires exact typed confirmation and never approves blocked entries', async () => {
  const page = { page: 1, pages: 1, total: 2, entries: [
    { ...staged(4), duplicateCheckStatus: [] },
    { ...staged(5), duplicateCheckStatus: [] },
  ] };
  let writes = 0;
  const run = async (answers) => reviewBatchSession(page, {
    ask: async () => answers.shift(), print: () => {}, approver: 'Administrator',
    approve: async (ids) => { writes += 1; assert.deepEqual(ids, ['4']); return [{ stagedId: '4', activeId: '20' }]; },
  });
  assert.deepEqual(await run(['4', 'no']), []);
  assert.equal(writes, 0);
  assert.deepEqual(await run(['']), []);
  assert.equal(writes, 0);
  assert.equal((await run(['4', 'APPROVE 4 AS Administrator'])).length, 1);
  assert.equal(writes, 1);
  const blocked = { ...page, entries: [{ ...page.entries[0], duplicateCheckStatus: ['EVALUATION_NEAR'] }] };
  await assert.rejects(reviewBatchSession(blocked, {
    ask: async () => '4', print: () => {}, approver: 'Administrator', approve: async () => { throw new Error('Must not write'); },
  }), /unresolved checks/);
});

function fakeApprovalPool(rows) {
  const calls = [];
  let nextId = 20;
  const client = { async query(sql, params) {
    calls.push({ sql, params });
    if (sql.includes('pg_try_advisory_xact_lock')) return { rows: [{ locked: true }] };
    if (sql.includes('FROM rag_knowledge_staging WHERE id = ANY')) return { rows };
    if (sql.includes('SELECT id, content FROM rag_knowledge_staging')) return { rows: rows.map((row) => ({ id: row.id, content: row.content })) };
    if (sql.includes('SELECT id, content FROM rag_knowledge')) return { rows: [] };
    if (sql.includes('INSERT INTO rag_knowledge\n')) return { rows: [{ id: String(nextId++) }] };
    return { rows: [] };
  }, release() {} };
  return { calls, connect: async () => client };
}

test('batch approval rechecks all rows and commits selected entries atomically', async () => {
  const pool = fakeApprovalPool([staged(4), staged(5)]);
  const approved = await approveBatch(pool, ['4', '5'], 'Administrator', corpus);
  assert.deepEqual(approved, [{ stagedId: '4', activeId: '20' }, { stagedId: '5', activeId: '21' }]);
  const inserts = pool.calls.filter((call) => call.sql.includes('INSERT INTO rag_knowledge\n'));
  assert.equal(inserts.length, 2);
  assert.equal(inserts[0].params.at(-1), 'Administrator');
  assert.ok(inserts[0].sql.includes('approved_at'));
  const updates = pool.calls.filter((call) => call.sql.includes("SET status = 'APPROVED'"));
  assert.equal(updates.length, 2);
  assert.equal(updates[0].params[1], 'Administrator');
  assert.ok(updates[0].sql.includes('approved_at = now()'));
  assert.equal(pool.calls.filter((call) => call.sql === 'COMMIT').length, 1);
});

test('batch approval rolls back before writes when any selected row has a problem', async () => {
  const pool = fakeApprovalPool([staged(4), { ...staged(5), evaluation_corpus_sha256: 'wrong' }]);
  await assert.rejects(approveBatch(pool, ['4', '5'], 'Administrator', corpus), /CORPUS_MISMATCH/);
  assert.equal(pool.calls.filter((call) => call.sql.includes('INSERT INTO rag_knowledge\n')).length, 0);
  assert.equal(pool.calls.filter((call) => call.sql === 'ROLLBACK').length, 1);
  assert.equal(pool.calls.filter((call) => call.sql === 'COMMIT').length, 0);
});

test('a database failure during batch insertion triggers transaction rollback', async () => {
  const pool = fakeApprovalPool([staged(4), staged(5)]);
  const originalConnect = pool.connect;
  pool.connect = async () => {
    const client = await originalConnect();
    const query = client.query.bind(client);
    let inserts = 0;
    client.query = async (sql, params) => {
      if (sql.includes('INSERT INTO rag_knowledge\n') && ++inserts === 2) throw new Error('database write failed');
      return query(sql, params);
    };
    return client;
  };
  await assert.rejects(approveBatch(pool, ['4', '5'], 'Administrator', corpus), /database write failed/);
  assert.equal(pool.calls.filter((call) => call.sql === 'ROLLBACK').length, 1);
  assert.equal(pool.calls.filter((call) => call.sql === 'COMMIT').length, 0);
});
