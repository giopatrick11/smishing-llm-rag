const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createApp } = require('../src/app');
const { privateLanHost, assertManualDevConfig } = require('../src/dev/lanServer');

const config = {
  ollamaUrl: 'http://127.0.0.1:11434', model: 'gemma3:12b',
  apiKey: 'private-test-key-with-adequate-length', requestTimeoutMs: 1000,
  rulesEnabled: true, rulesShadowMode: true, verdictPolicy: 'gemma', ragEnabled: false,
};

test('manual LAN launcher accepts only explicit private IPv4 addresses', () => {
  for (const address of ['10.0.0.8', '172.16.0.8', '172.31.255.8', '192.168.1.8']) {
    assert.equal(privateLanHost(address), address);
  }
  for (const address of [undefined, 'localhost', '127.0.0.1', '0.0.0.0',
    '172.32.0.8', '8.8.8.8', '169.254.1.2', '::1', '192.168.1.8:3000']) {
    assert.throws(() => privateLanHost(address), /private IPv4/);
  }
  assert.doesNotThrow(() => assertManualDevConfig(config));
  assert.throws(() => assertManualDevConfig({ ...config, rulesShadowMode: false }), /shadow-mode/);
  assert.throws(() => assertManualDevConfig({ ...config, verdictPolicy: 'evidence-weighted' }), /shadow-mode/);
  assert.throws(() => assertManualDevConfig({ ...config, apiKey: 'replace-with-a-long-random-secret' }), /random API_KEY/);
});

test('manual API requests support all verdicts and never analyze without a POST', async () => {
  let calls = 0;
  const fetchImpl = async (url) => {
    assert.equal(new URL(url).pathname, '/api/chat');
    const classification = ['SCAM', 'SAFE', 'SUSPICIOUS'][calls++];
    return new Response(JSON.stringify({ message: { content: JSON.stringify({
      classification, confidence: 'MEDIUM', rationale: 'Manual test result.',
    }) } }), { status: 200 });
  };
  const server = createApp(config, { fetchImpl }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal(calls, 0);
    for (const [index, classification] of ['SCAM', 'SAFE', 'SUSPICIOUS'].entries()) {
      const response = await fetch(`${base}/api/sms/analyze`, {
        method: 'POST',
        headers: { 'x-api-key': config.apiKey, 'content-type': 'application/json' },
        body: JSON.stringify({ messageId: `manual-${index}`, sender: 'ManualTest',
          text: 'Test SMS entered manually.', receivedAt: '2026-10-27T12:00:00+08:00' }),
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.classification, classification);
      assert.equal(body.confidence, 'MEDIUM');
      assert.equal(body.rationale, 'Manual test result.');
      assert.equal(body.gemmaClassification, classification);
      assert.equal(body.verdictPolicy, 'shadow');
    }
    assert.equal(calls, 3);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
