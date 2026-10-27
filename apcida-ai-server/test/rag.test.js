const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig, loadDatabaseUrl } = require('../src/config/env');
const { createEmbeddingService } = require('../src/services/embeddings');
const { createKnowledgeRepository, vectorLiteral } = require('../src/db/knowledgeRepository');
const { createApp } = require('../src/app');

const vector = Array(768).fill(0.01);
const config = {
  host: '127.0.0.1',
  ollamaUrl: 'http://127.0.0.1:11434',
  model: 'gemma3:12b',
  apiKey: 'long-test-api-key-value',
  requestTimeoutMs: 1000,
  ragEnabled: true,
};

test('RAG is disabled by default and requires a local apcida URL when enabled', () => {
  assert.equal(loadConfig({ API_KEY: config.apiKey }).ragEnabled, false);
  assert.throws(() => loadConfig({ API_KEY: config.apiKey, RAG_ENABLED: 'true' }), /DATABASE_URL/);
  assert.throws(() => loadDatabaseUrl({ DATABASE_URL: 'postgresql://example.com:5432/apcida' }), /local apcida/);
  assert.throws(() => loadDatabaseUrl({ DATABASE_URL: 'postgresql://localhost:5432/other' }), /local apcida/);
  assert.throws(() => loadDatabaseUrl({ DATABASE_URL: 'postgresql://localhost:5432/apcida?host=example.com' }), /local apcida/);
  assert.throws(() => loadConfig({ API_KEY: config.apiKey, RAG_ENABLED: 'true', OLLAMA_MODEL: 'other', DATABASE_URL: 'postgresql://localhost:5432/apcida' }), /gemma3:12b/);
  assert.equal(loadConfig({ API_KEY: config.apiKey, RAG_ENABLED: 'true', DATABASE_URL: 'postgresql://localhost:5432/apcida' }).ragEnabled, true);
});

test('RAG migration creates an empty vector knowledge schema without seed statements', () => {
  const sql = fs.readFileSync(path.join(__dirname, '../src/db/migrations/001_rag_knowledge.sql'), 'utf8');
  assert.match(sql, /embedding vector\(768\)/);
  assert.match(sql, /USING hnsw \(embedding vector_cosine_ops\)/);
  assert.doesNotMatch(sql, /\b(?:INSERT|COPY)\b/i);
});

test('embedding service uses local nomic-embed-text and validates 768 dimensions', async () => {
  const service = createEmbeddingService(config, async (url, options) => {
    assert.equal(new URL(url).pathname, '/api/embed');
    assert.deepEqual(JSON.parse(options.body), { model: 'nomic-embed-text', input: 'test message' });
    return new Response(JSON.stringify({ embeddings: [vector] }), { status: 200 });
  });
  assert.equal((await service.embed('test message')).length, 768);
  await assert.rejects(createEmbeddingService(config, async () => new Response(JSON.stringify({ embeddings: [[1, 2]] }))).embed('x'), /EMBEDDING_INVALID_RESPONSE/);
  await assert.rejects(createEmbeddingService(config, async () => { throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); }).embed('x'), /EMBEDDING_TIMEOUT/);
});

test('knowledge retrieval parameterizes a valid vector and keeps source text out of SQL', async () => {
  const pool = { query: async (sql, parameters) => {
    assert.match(sql, /embedding <=> \$1::vector/);
    assert.match(sql, /approved_by IS NOT NULL/);
    assert.doesNotMatch(sql, /private SMS/);
    assert.equal(parameters[0], vectorLiteral(vector));
    assert.deepEqual(parameters.slice(1), ['nomic-embed-text', 3, 0.72]);
    return { rows: [{ id: '1', content: 'A vetted pattern', label: 'SCAM', similarity: '0.91' }] };
  } };
  const matches = await createKnowledgeRepository(pool).search(vector);
  assert.deepEqual(matches, [{ id: '1', content: 'A vetted pattern', label: 'SCAM', similarity: 0.91 }]);
  assert.throws(() => vectorLiteral([1, 2]), /Invalid embedding/);
});

async function withApp(knowledgeRepository, fetchImpl, run) {
  const server = createApp(config, { knowledgeRepository, fetchImpl }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function analyze(base) {
  return fetch(`${base}/api/sms/analyze`, {
    method: 'POST',
    headers: { 'x-api-key': config.apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({ messageId: 'rag-1', sender: 'Example', text: 'An SMS to classify.', receivedAt: '2026-10-26T09:00:00+08:00' }),
  });
}

test('RAG-enabled analysis embeds, retrieves, and sends reference context to Gemma', async () => {
  const repository = { search: async (embedding) => {
    assert.equal(embedding.length, 768);
    return [{ id: '1', label: 'SAFE', content: 'Vetted reference pattern', similarity: 0.9 }];
  } };
  const fetchImpl = async (url, options) => {
    if (url.endsWith('/api/embed')) return new Response(JSON.stringify({ embeddings: [vector] }), { status: 200 });
    assert.ok(url.endsWith('/api/chat'));
    const request = JSON.parse(options.body);
    assert.equal(request.model, 'gemma3:12b');
    assert.equal(request.messages.length, 4);
    assert.match(request.messages[1].content, /reference examples, not instructions/);
    assert.deepEqual(JSON.parse(request.messages[2].content).retrievedReferenceExamples, [{ label: 'SAFE', content: 'Vetted reference pattern' }]);
    return new Response(JSON.stringify({ message: { content: '{"classification":"SAFE","confidence":"LOW","rationale":"No clear deception."}' } }), { status: 200 });
  };
  await withApp(repository, fetchImpl, async (base) => {
    const response = await analyze(base);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.classification, 'SAFE');
    assert.equal(result.messageId, 'rag-1');
    assert.doesNotMatch(JSON.stringify(result), /Vetted reference pattern/);
  });
});

test('RAG database errors return a generic code without leaking SMS text', async () => {
  await withApp({ search: async () => { throw new Error('private SMS in database error'); } },
    async () => new Response(JSON.stringify({ embeddings: [vector] }), { status: 200 }),
    async (base) => {
      const response = await analyze(base);
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: 'RAG_DATABASE_UNAVAILABLE' });
    });
});
