const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createApp } = require('../src/app');
const { loadConfig } = require('../src/config/env');

const config = {
  host: '127.0.0.1',
  ollamaUrl: 'http://127.0.0.1:11434',
  model: 'gemma3:12b',
  apiKey: 'test-key-with-adequate-length',
  requestTimeoutMs: 1000,
};
const sms = {
  messageId: 'sms-001',
  sender: 'ExampleSender',
  text: 'Your appointment is tomorrow at 9 AM.',
  receivedAt: '2026-10-26T09:00:00+08:00',
};

function response(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function withServer(fetchImpl, run) {
  const server = createApp(config, { fetchImpl }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run(base);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function post(base, body = sms, apiKey = config.apiKey) {
  return fetch(`${base}/api/sms/analyze`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(apiKey ? { 'x-api-key': apiKey } : {}) },
    body: JSON.stringify(body),
  });
}

test('health and status expose service availability', async () => {
  await withServer(async (url) => {
    assert.equal(new URL(url).pathname, '/api/tags');
    return response({ models: [{ name: 'gemma3:12b' }] });
  }, async (base) => {
    const index = await fetch(base);
    assert.equal(index.status, 200);
    assert.deepEqual(await index.json(), {
      service: 'ApCiDa AI server',
      endpoints: ['GET /health', 'GET /api/ai/status', 'POST /api/sms/analyze'],
    });
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'ok' });
    const status = await fetch(`${base}/api/ai/status`);
    assert.equal(status.status, 200);
    assert.deepEqual(await status.json(), { ollamaAvailable: true, modelAvailable: true, model: 'gemma3:12b' });
  });
});

test('status distinguishes a missing model and an offline Ollama', async () => {
  await withServer(async () => response({ models: [] }), async (base) => {
    const result = await fetch(`${base}/api/ai/status`);
    assert.equal(result.status, 503);
    assert.deepEqual(await result.json(), { ollamaAvailable: true, modelAvailable: false, model: 'gemma3:12b' });
  });
  await withServer(async () => { throw new TypeError('connect failed'); }, async (base) => {
    const result = await fetch(`${base}/api/ai/status`);
    assert.equal(result.status, 503);
    assert.deepEqual(await result.json(), { ollamaAvailable: false, modelAvailable: false, error: 'OLLAMA_UNAVAILABLE' });
  });
});

test('analysis sends a schema-constrained chat request and returns validated data', async () => {
  await withServer(async (url, init) => {
    assert.equal(new URL(url).pathname, '/api/chat');
    assert.equal(init.method, 'POST');
    const body = JSON.parse(init.body);
    assert.equal(body.model, 'gemma3:12b');
    assert.equal(body.stream, false);
    assert.deepEqual(body.format.required, ['classification', 'confidence', 'rationale']);
    assert.equal(body.format.additionalProperties, false);
    assert.match(body.messages[0].content, /Filipino, or Cebuano/);
    assert.match(body.messages[0].content, /OTP, urgency, or an unfamiliar URL alone does not make a message a scam/);
    assert.deepEqual(JSON.parse(body.messages[1].content), {
      sender: sms.sender, text: sms.text, receivedAt: sms.receivedAt,
    });
    return response({ message: { content: JSON.stringify({ classification: 'SAFE', confidence: 'MEDIUM', rationale: 'This is an ordinary appointment reminder.' }) } });
  }, async (base) => {
    const result = await post(base);
    assert.equal(result.status, 200);
    const body = await result.json();
    assert.deepEqual(Object.keys(body).sort(), ['messageId', 'classification', 'confidence', 'rationale', 'model', 'processingTimeMs'].sort());
    assert.equal(body.messageId, sms.messageId);
    assert.equal(body.classification, 'SAFE');
    assert.equal(body.confidence, 'MEDIUM');
    assert.equal(body.model, 'gemma3:12b');
    assert.ok(Number.isInteger(body.processingTimeMs) && body.processingTimeMs >= 0);
  });
});

test('analysis requires an API key and valid SMS input', async () => {
  await withServer(async () => { throw new Error('Ollama should not be called'); }, async (base) => {
    assert.equal((await post(base, sms, null)).status, 401);
    assert.equal((await post(base, sms, 'wrong-key')).status, 401);
    const invalid = await post(base, { ...sms, text: '', receivedAt: 'not-a-date' });
    assert.equal(invalid.status, 400);
    assert.deepEqual((await invalid.json()).fields.sort(), ['text', 'receivedAt'].sort());
    assert.equal((await post(base, { ...sms, unexpected: true })).status, 400);
    assert.equal((await post(base, { ...sms, text: 'x'.repeat(8200) })).status, 413);
  });
});

test('analysis rejects malformed model output and maps Ollama failures', async () => {
  const cases = [
    [async () => response({ message: { content: '{bad json' } }), 502, 'OLLAMA_INVALID_RESPONSE'],
    [async () => response({ message: { content: JSON.stringify({ classification: 'MAYBE', confidence: 'HIGH', rationale: 'guess' }) } }), 502, 'OLLAMA_INVALID_RESPONSE'],
    [async () => response({}, 503), 503, 'OLLAMA_OVERLOADED'],
    [async () => response({}, 404), 503, 'MODEL_UNAVAILABLE'],
    [async () => { throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); }, 504, 'OLLAMA_TIMEOUT'],
    [async () => { throw new TypeError('offline'); }, 503, 'OLLAMA_UNAVAILABLE'],
  ];
  for (const [mock, status, code] of cases) {
    await withServer(mock, async (base) => {
      const result = await post(base);
      assert.equal(result.status, status);
      assert.deepEqual(await result.json(), { error: code });
    });
  }
});

test('analysis limits requests per client', async () => {
  await withServer(async () => response({ message: { content: '{"classification":"SAFE","confidence":"LOW","rationale":"No clear deception."}' } }), async (base) => {
    for (let i = 0; i < 30; i += 1) assert.equal((await post(base)).status, 200);
    const limited = await post(base);
    assert.equal(limited.status, 429);
    assert.equal((await limited.json()).error, 'RATE_LIMITED');
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
  });
});

test('configuration requires a key and a loopback Ollama URL', () => {
  assert.throws(() => loadConfig({}), /API_KEY/);
  assert.throws(() => loadConfig({ API_KEY: config.apiKey, OLLAMA_URL: 'http://192.168.1.5:11434' }), /OLLAMA_URL/);
  const loaded = loadConfig({ API_KEY: config.apiKey });
  assert.equal(loaded.host, '127.0.0.1');
  assert.equal(loaded.ollamaUrl, config.ollamaUrl);
});
