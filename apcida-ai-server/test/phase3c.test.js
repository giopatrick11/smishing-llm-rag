const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createLanApp } = require('../src/dev/lanServer');
const { createApp } = require('../src/app');

const config = {
  ollamaUrl: 'http://127.0.0.1:11434', model: 'gemma3:12b',
  apiKey: 'synthetic-test-key-with-adequate-length', requestTimeoutMs: 1000,
  rulesEnabled: true, rulesShadowMode: true, verdictPolicy: 'gemma', ragEnabled: false,
};
const sms = { messageId: 'manual-test-1', sender: 'ManualTest',
  text: 'Synthetic SMS for a local API test.', receivedAt: '2026-10-27T12:00:00+08:00' };

async function withApp(app, run) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

function post(base, body = sms, key = config.apiKey) {
  return fetch(`${base}/api/sms/analyze`, { method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { 'x-api-key': key } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body) });
}

test('manual page exists only on the LAN launcher and never contains a secret or SMS', async () => {
  let inferenceCalls = 0;
  const fetchImpl = async () => { inferenceCalls += 1; throw new Error('Unexpected inference'); };
  await withApp(createLanApp(config, { fetchImpl }), async (base) => {
    const page = await fetch(`${base}/manual-test`);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('cache-control'), 'no-store');
    assert.match(page.headers.get('content-security-policy'), /connect-src 'self'/);
    const html = await page.text();
    assert.match(html, /synthetic SMS/i);
    assert.doesNotMatch(html, new RegExp(config.apiKey));
    const script = await fetch(`${base}/manual-test.js`);
    assert.equal(script.status, 200);
    assert.equal(script.headers.get('cache-control'), 'no-store');
    assert.doesNotMatch(await script.text(), /localStorage|sessionStorage|console\.log/);
    assert.equal(inferenceCalls, 0);
  });
  await withApp(createApp(config, { fetchImpl }), async (base) => {
    assert.equal((await fetch(`${base}/manual-test`)).status, 404);
  });
});

test('LAN page reuses authenticated API contract and all three verdicts', async () => {
  let calls = 0;
  const fetchImpl = async (url, options) => {
    assert.equal(new URL(url).pathname, '/api/chat');
    assert.equal(JSON.parse(options.body).model, 'gemma3:12b');
    const classification = ['SCAM', 'SAFE', 'SUSPICIOUS'][calls++];
    return new Response(JSON.stringify({ message: { content: JSON.stringify({
      classification, confidence: 'MEDIUM', rationale: 'Synthetic test result.',
    }) } }), { status: 200 });
  };
  await withApp(createLanApp(config, { fetchImpl }), async (base) => {
    assert.equal((await post(base, sms, null)).status, 401);
    assert.equal((await post(base, sms, 'wrong-key')).status, 401);
    assert.equal(calls, 0);
    for (const classification of ['SCAM', 'SAFE', 'SUSPICIOUS']) {
      const response = await post(base);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const body = await response.json();
      assert.equal(body.messageId, sms.messageId);
      assert.equal(body.classification, classification);
      assert.equal(body.confidence, 'MEDIUM');
      assert.equal(body.rationale, 'Synthetic test result.');
      assert.equal(body.model, 'gemma3:12b');
      assert.equal(body.verdictPolicy, 'shadow');
      assert.ok(Number.isInteger(body.processingTimeMs));
    }
    assert.equal(calls, 3);
  });
});

test('LAN API keeps validation, Ollama unavailable, timeout, and malformed response errors', async () => {
  await withApp(createLanApp(config, { fetchImpl: async () => { throw new Error('Should not infer'); } }), async (base) => {
    const malformed = await post(base, '{bad json');
    assert.equal(malformed.status, 400);
    assert.deepEqual(await malformed.json(), { error: 'INVALID_JSON' });
    const missingText = await post(base, { ...sms, text: undefined });
    assert.equal(missingText.status, 400);
    assert.deepEqual(await missingText.json(), { error: 'INVALID_REQUEST', fields: ['text'] });
  });
  for (const [mock, status, code] of [
    [async () => { throw new TypeError('offline'); }, 503, 'OLLAMA_UNAVAILABLE'],
    [async () => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }); }, 504, 'OLLAMA_TIMEOUT'],
    [async () => new Response(JSON.stringify({ message: { content: '{bad json' } }), { status: 200 }),
      502, 'OLLAMA_INVALID_RESPONSE'],
  ]) {
    await withApp(createLanApp(config, { fetchImpl: mock }), async (base) => {
      const response = await post(base);
      assert.equal(response.status, status);
      assert.deepEqual(await response.json(), { error: code });
    });
  }
});

test('RAG mode reports embedding failures separately from chat failures', async () => {
  const ragConfig = { ...config, ragEnabled: true };
  const knowledgeRepository = { search: async () => [] };
  for (const [mock, status, code] of [
    [async () => { throw new TypeError('offline'); }, 503, 'EMBEDDING_UNAVAILABLE'],
    [async () => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }); },
      504, 'EMBEDDING_TIMEOUT'],
  ]) {
    await withApp(createLanApp(ragConfig, { fetchImpl: mock, knowledgeRepository }), async (base) => {
      const response = await post(base);
      assert.equal(response.status, status);
      assert.deepEqual(await response.json(), { error: code });
    });
  }
});
