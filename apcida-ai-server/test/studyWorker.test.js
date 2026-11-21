const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createStudyWorker } = require('../src/study/worker');

test('a ten-item dashboard batch runs sequentially and records each result', async () => {
  const expectedKnowledge = createHash('sha256').update('[]').digest('hex');
  const queued = [];
  const finished = [];
  let active = 0;
  let maxActive = 0;
  const repository = {
    queueNext: async (limit, snapshot) => {
      assert.equal(limit, 10);
      queued.push(...[1, 2].map((id) => ({ id, text: `Synthetic message ${id}`,
        created_at: new Date(), knowledge_sha256: snapshot.knowledgeHash,
        model_digest: snapshot.modelDigest })));
      return [1, 2];
    },
    hasQueued: async () => queued.length > 0,
    claimQueued: async () => queued.shift() || null,
    finish: async (id, result) => { finished.push([id, result.classification]); },
    requeue: async () => { throw new Error('Unexpected requeue'); },
    resetRunning: async () => {},
  };
  const pool = { query: async (sql) => sql.includes('rag_knowledge')
    ? { rows: [] } : { rows: [] },
  connect: async () => ({ query: async () => ({ rows: [{ locked: true }] }), release() {} }) };
  const slotRepository = {
    acquireSlot: async () => { active++; maxActive = Math.max(active, maxActive); return true; },
    releaseSlot: async () => { active--; },
  };
  const worker = createStudyWorker({ pool, repository, slotRepository, model: 'gemma3:12b',
    ollamaUrl: 'http://127.0.0.1:11434', gapMs: 0,
    fetchImpl: async () => ({ ok: true, json: async () => ({ models: [
      { name: 'gemma3:12b', digest: 'test-digest' },
    ] }) }),
    analyzer: { analyze: async () => ({ classification: 'SAFE', confidence: 'HIGH' }) },
  });
  assert.equal(await worker.knowledgeHash(), expectedKnowledge);
  assert.deepEqual(await worker.queueNext(), [1, 2]);
  for (let attempt = 0; attempt < 100 && finished.length < 2; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.deepEqual(finished, [[1, 'SAFE'], [2, 'SAFE']]);
  assert.equal(maxActive, 1);
  assert.equal(active, 0);
});

test('approved RAG overlap is excluded before inference', async () => {
  const queued = [];
  const excluded = [];
  let inferenceCalls = 0;
  const pool = { query: async (sql) => ({ rows: sql.includes('rag_knowledge')
    ? [{ id: 7, label: 'SCAM', content: 'Claim your reward at [link]',
      normalized_hash: 'test', embedding_model: 'test' }] : [] }),
  connect: async () => ({ query: async () => ({ rows: [{ locked: true }] }), release() {} }) };
  const repository = {
    queueNext: async (limit, snapshot) => {
      queued.push({ id: 1, text: 'Claim your reward at [link]', created_at: new Date(),
        knowledge_sha256: snapshot.knowledgeHash, model_digest: snapshot.modelDigest });
      return [1];
    },
    hasQueued: async () => queued.length > 0,
    claimQueued: async () => queued.shift() || null,
    exclude: async (id, reason) => { excluded.push([id, reason]); },
    finish: async () => { throw new Error('Excluded item must not finish as a prediction'); },
    requeue: async () => { throw new Error('Unexpected requeue'); },
  };
  const worker = createStudyWorker({ pool, repository,
    slotRepository: { acquireSlot: async () => true, releaseSlot: async () => {} },
    model: 'gemma3:12b', ollamaUrl: 'http://127.0.0.1:11434', gapMs: 0,
    fetchImpl: async () => ({ ok: true, json: async () => ({ models: [
      { name: 'gemma3:12b', digest: 'test-digest' },
    ] }) }),
    analyzer: { analyze: async () => { inferenceCalls++; } },
  });
  assert.deepEqual(await worker.queueNext(), [1]);
  for (let attempt = 0; attempt < 100 && excluded.length < 1; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.deepEqual(excluded, [[1, 'RAG_OVERLAP_EXACT']]);
  assert.equal(inferenceCalls, 0);
});
