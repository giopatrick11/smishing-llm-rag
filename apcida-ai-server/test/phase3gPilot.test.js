const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { issueInstallationCredential, hashInstallationToken } = require('../src/production/security');
const { createPilotApp, assertPilotConfig } = require('../src/pilot/createPilotApp');
const { enrollInstallation, revokeInstallation } = require('../src/pilot/enrollment');
const { parseCommand } = require('../src/pilot/adminCli');
const { createInstallationRepository } = require('../src/pilot/installationRepository');

const config = {
  model: 'gemma3:12b', ragEnabled: true, rulesEnabled: true,
  rulesShadowMode: true, verdictPolicy: 'gemma', apiKey: 'internal-secret-of-sufficient-length',
  ollamaUrl: 'http://127.0.0.1:11434', requestTimeoutMs: 120000,
};
const body = {
  messageId: 'pilot-synthetic123', sender: 'ManualTest',
  text: 'Your bank account is locked. Send your password to unlock it.',
  receivedAt: '2026-01-01T00:00:00Z',
};

function repository() {
  const records = new Map();
  return {
    async create(record) { records.set(record.tokenHash, { ...record, revokedAt: null }); },
    async findByTokenHash(hash) {
      const record = records.get(hash);
      return record && { installationId: record.installationId,
        expiresAt: record.expiresAt, revokedAt: record.revokedAt };
    },
    async revoke(id) {
      const record = [...records.values()].find((item) => item.installationId === id);
      if (!record || record.revokedAt) return false;
      record.revokedAt = new Date();
      return true;
    },
  };
}

async function withApp(fn) {
  const store = repository();
  const events = [];
  const app = createPilotApp(config, {
    installationRepository: store,
    knowledgeRepository: { async search() { return []; } },
    fetchImpl: async (url) => ({ ok: true, json: async () => url.endsWith('/api/embed')
      ? { embeddings: [Array(768).fill(0)] }
      : { message: { content: JSON.stringify({
        classification: 'SCAM', confidence: 'HIGH', rationale: 'Requests a password.'
      }) } } }),
    audit: (event) => events.push(event),
  });
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const token = issueInstallationCredential().token;
    const installationId = '51924d06-0923-4d60-a953-80286ee0b971';
    await store.create({ installationId, tokenHash: hashInstallationToken(token),
      expiresAt: Date.now() + 60000 });
    await fn({ url: `http://127.0.0.1:${server.address().port}`, store, token, installationId, events });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('pilot accepts only authenticated synthetic requests and logs metadata', async () => withApp(async ({ url, token, events }) => {
  const send = (headers, value = body) => fetch(`${url}/api/sms/analyze`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(value),
  });
  assert.equal((await send({ 'x-apcida-pilot-synthetic': 'true' })).status, 401);
  assert.equal((await send({ authorization: 'Bearer bad', 'x-apcida-pilot-synthetic': 'true' })).status, 401);
  const auth = { authorization: `Bearer ${token}`, 'x-apcida-pilot-synthetic': 'true' };
  assert.equal((await send(auth, { ...body, sender: '+639123456789' })).status, 400);
  assert.equal((await send(auth, { ...body, messageId: 'real-id' })).status, 400);
  const result = await send(auth);
  assert.equal(result.status, 200);
  const json = await result.json();
  assert.equal(json.classification, 'SCAM');
  assert.equal(json.model, 'gemma3:12b');
  assert.equal(events.some((item) => item.event === 'PILOT_ANALYSIS_ACCEPTED'), true);
  assert.equal(JSON.stringify(events).includes(body.text), false);
  assert.equal((await fetch(`${url}/api/ai/status`)).status, 404);
}));

test('revocation blocks an issued credential', async () => withApp(async ({ url, token, store, installationId }) => {
  assert.equal(await revokeInstallation(store, installationId), true);
  const response = await fetch(`${url}/api/sms/analyze`, { method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'x-apcida-pilot-synthetic': 'true',
      'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(response.status, 401);
}));

test('enrollment creates unique hashed credentials with bounded validity', async () => {
  const store = repository();
  const a = await enrollInstallation(store, { label: 'Pilot Phone A' });
  const b = await enrollInstallation(store, { label: 'Pilot Phone B' });
  assert.notEqual(a.token, b.token);
  assert.notEqual(a.installationId, b.installationId);
  assert.equal((await store.findByTokenHash(hashInstallationToken(a.token))).installationId, a.installationId);
  assert.throws(() => parseCommand(['enroll', '--label', 'x', '--out', '/tmp/x']), /Usage/);
});

test('pilot refuses classifier drift and placeholder credentials', () => {
  assert.throws(() => assertPilotConfig({ ...config, ragEnabled: false }));
  assert.throws(() => assertPilotConfig({ ...config, verdictPolicy: 'evidence-weighted' }));
  assert.throws(() => assertPilotConfig({ ...config, apiKey: 'replace-with-a-long-random-secret' }));
});

test('persistent repository writes only token hash and supports revocation', async () => {
  const calls = [];
  const pool = { async query(sql, values) {
    calls.push({ sql, values });
    if (sql.startsWith('UPDATE')) return { rowCount: 1 };
    if (sql.startsWith('SELECT')) return { rows: [{ installationId: 'test', expiresAt: Date.now() + 1000, revokedAt: null }] };
    return { rowCount: 1 };
  } };
  const repo = createInstallationRepository(pool);
  const token = issueInstallationCredential();
  await repo.create({ installationId: 'test', label: 'test', tokenHash: token.tokenHash,
    expiresAt: Date.now() + 1000 });
  assert.equal(await repo.revoke('test'), true);
  assert.equal((await repo.findByTokenHash(token.tokenHash)).installationId, 'test');
  assert.equal(JSON.stringify(calls).includes(token.token), false);
  assert.match(calls[0].sql, /INSERT INTO pilot_installations/);
  assert.match(calls[1].sql, /UPDATE pilot_installations/);
});

test('pilot rejects oversized authenticated JSON before inference', async () => withApp(async ({ url, token, events }) => {
  const response = await fetch(`${url}/api/sms/analyze`, { method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'x-apcida-pilot-synthetic': 'true',
      'content-type': 'application/json' }, body: JSON.stringify({ ...body, text: 'x'.repeat(9000) }) });
  assert.equal(response.status, 413);
  assert.equal(events.some((item) => item.event === 'PILOT_ANALYSIS_ACCEPTED'), false);
}));
