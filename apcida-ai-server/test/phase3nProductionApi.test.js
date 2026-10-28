const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createProductionApp } = require('../src/production/createProductionApp');
const { createApp } = require('../src/app');
const { createPilotApp } = require('../src/pilot/createPilotApp');
const { productionSettings } = require('../src/production/server');
const { createPrivacyCodec } = require('../src/production/privacy');
const { issueInstallationCredential, hashInstallationToken } = require('../src/production/security');
const { enrollProductionInstallation, revokeProductionInstallation } = require('../src/production/enrollment');
const { requireProductionAdmin } = require('../src/production/adminAuth');
const { parseCommand } = require('../src/production/adminCli');
const { shouldApplyMigration } = require('../src/db/migrate');
const { OllamaError } = require('../src/services/ollama');

const config = { model: 'gemma3:12b', ragEnabled: true, rulesEnabled: true,
  rulesShadowMode: true, verdictPolicy: 'gemma', requestTimeoutMs: 120000,
  ollamaUrl: 'http://127.0.0.1:11434' };
const keyHex = '1a'.repeat(32);
const messageId = '6d5f9250-3a47-42a8-a06b-68f0b8a82691';
const sms = { messageId, sender: 'ManualTest', text: 'Synthetic payment lure',
  receivedAt: '2026-10-28T00:00:00Z' };

function fakeDatabase() {
  const installations = new Map();
  const requests = new Map();
  const windows = new Map();
  let unavailable = false;
  let slotOwner = null;
  const db = {
    installations, requests, windows,
    setUnavailable(value) { unavailable = value; },
    async createInstallation(row) { if (unavailable) throw Error('db down'); installations.set(row.tokenHash, { ...row, revokedAt: null }); },
    async findByTokenHash(hash) {
      if (unavailable) throw Error('db down');
      const row = installations.get(hash);
      return row && { installationId: row.installationId,
        expiresAt: row.expiresAt, revokedAt: row.revokedAt };
    },
    async isActive(id) {
      if (unavailable) throw Error('db down');
      const row = [...installations.values()].find((item) => item.installationId === id);
      return !!row && !row.revokedAt && row.expiresAt > Date.now();
    },
    async revoke(id) {
      if (unavailable) throw Error('db down');
      const row = [...installations.values()].find((item) => item.installationId === id);
      if (!row || row.revokedAt) return false;
      row.revokedAt = new Date();
      for (const key of requests.keys()) if (key.startsWith(`${id}/`)) requests.delete(key);
      windows.delete(id);
      return true;
    },
    async countRequest(id, limit) {
      if (unavailable) throw Error('db down');
      const count = (windows.get(id) || 0) + 1;
      windows.set(id, count); return count <= limit;
    },
    async acquireSlot(owner) {
      if (unavailable) throw Error('db down');
      if (slotOwner !== null) return false;
      slotOwner = owner; return true;
    },
    async releaseSlot(owner) {
      if (unavailable) throw Error('db down');
      if (slotOwner === owner) slotOwner = null;
    },
    async claim({ installationId, messageId: id, requestHmac, leaseOwner }) {
      if (unavailable) throw Error('db down');
      const key = `${installationId}/${id}`;
      const old = requests.get(key);
      if (!old) { requests.set(key, { requestHmac, leaseOwner, status: 'PROCESSING', leaseExpired: false }); return { kind: 'CLAIMED' }; }
      if (old.requestHmac !== requestHmac) return { kind: 'CONFLICT' };
      if (old.status === 'COMPLETED') return { kind: 'REPLAY', encrypted: old.encrypted };
      if (old.leaseExpired) { old.leaseOwner = leaseOwner; old.leaseExpired = false; return { kind: 'CLAIMED' }; }
      return { kind: 'BUSY' };
    },
    async complete({ installationId, messageId: id, leaseOwner, encrypted }) {
      if (unavailable) throw Error('db down');
      const row = requests.get(`${installationId}/${id}`);
      if (!row || row.leaseOwner !== leaseOwner || row.status !== 'PROCESSING') return false;
      row.status = 'COMPLETED'; row.encrypted = encrypted; return true;
    },
    async release({ installationId, messageId: id, leaseOwner }) {
      if (unavailable) throw Error('db down');
      const key = `${installationId}/${id}`; const row = requests.get(key);
      if (row?.status === 'PROCESSING' && row.leaseOwner === leaseOwner) requests.delete(key);
    },
  };
  return db;
}

function fixture(options = {}) {
  const db = options.db || fakeDatabase();
  const { token, tokenHash } = issueInstallationCredential();
  const installationId = randomUUID();
  db.installations.set(tokenHash, { installationId, tokenHash,
    expiresAt: Date.now() + 86400000, revokedAt: null });
  const audit = [];
  const codec = createPrivacyCodec(keyHex);
  const analyzer = options.analyzer || { async analyze() {
    return { classification: 'SCAM', confidence: 'HIGH', rationale: 'Synthetic mock warning' };
  } };
  const app = createProductionApp(config, { repository: db, codec,
    analysisService: analyzer, audit: (event) => audit.push(event),
    rateLimit: options.rateLimit || 10, deadlineMs: options.deadlineMs || 90000 });
  return { db, token, tokenHash, installationId, audit, codec, app, analyzer };
}

async function withServer(app, action) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  try { return await action(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

async function post(origin, token, body = sms, headers = {}) {
  const response = await fetch(`${origin}/api/v1/sms/analyze`, { method: 'POST',
    headers: { 'content-type': 'application/json',
      'idempotency-key': body.messageId, ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json(), headers: response.headers };
}

test('controlled listener is disabled by default and pinned to loopback', () => {
  assert.equal(shouldApplyMigration('004_production_inference.sql'), false);
  assert.equal(shouldApplyMigration('004_production_inference.sql', { includeProduction: true }), true);
  assert.equal(shouldApplyMigration('003_pilot_installations.sql'), true);
  assert.throws(() => productionSettings({}), /disabled/);
  assert.throws(() => productionSettings({ APCIDA_PRODUCTION_ENABLED: 'true',
    APCIDA_PRODUCTION_MODE: 'controlled-test', APCIDA_PRODUCTION_BIND: '0.0.0.0',
    PRODUCTION_DATA_KEY: keyHex }), /127.0.0.1/);
  const settings = productionSettings({ APCIDA_PRODUCTION_ENABLED: 'true',
    APCIDA_PRODUCTION_MODE: 'controlled-test', APCIDA_PRODUCTION_BIND: '127.0.0.1',
    PRODUCTION_DATA_KEY: keyHex });
  assert.equal(settings.port, 3020);
  assert.equal(settings.retentionSeconds, 86400);
  assert.equal(settings.deadlineMs, 90000);
  assert.throws(() => productionSettings({ APCIDA_PRODUCTION_ENABLED: 'true',
    APCIDA_PRODUCTION_MODE: 'controlled-test', APCIDA_PRODUCTION_BIND: '127.0.0.1',
    PRODUCTION_DATA_KEY: keyHex, APCIDA_PRODUCTION_DEADLINE_MS: '120000' }),
  /deadline/);
  assert.equal(settings.identityRetentionDays, null);
  assert.equal(productionSettings({ APCIDA_PRODUCTION_ENABLED: 'true',
    APCIDA_PRODUCTION_MODE: 'controlled-test', APCIDA_PRODUCTION_BIND: '127.0.0.1',
    PRODUCTION_DATA_KEY: keyHex, APCIDA_PRODUCTION_IDENTITY_RETENTION_DAYS: '30' })
    .identityRetentionDays, 30);
  assert.throws(() => productionSettings({ APCIDA_PRODUCTION_ENABLED: 'true',
    APCIDA_PRODUCTION_MODE: 'controlled-test', APCIDA_PRODUCTION_BIND: '127.0.0.1',
    PRODUCTION_DATA_KEY: keyHex, APCIDA_PRODUCTION_IDENTITY_RETENTION_DAYS: '0' }),
  /Identity retention/);
});

test('existing development and synthetic pilot listeners do not expose production route', async () => {
  const development = createApp({ ...config, ragEnabled: false, apiKey: 'a'.repeat(32) });
  await withServer(development, async (origin) => {
    const response = await fetch(`${origin}/api/v1/sms/analyze`, { method: 'POST' });
    assert.equal(response.status, 404);
    assert.equal((await fetch(`${origin}/api/v1/installations/me`, { method: 'DELETE' })).status, 404);
  });
  const pilot = createPilotApp({ ...config, apiKey: 'a'.repeat(32) }, {
    installationRepository: { async findByTokenHash() { return null; } },
    knowledgeRepository: { async search() { return []; } },
  });
  await withServer(pilot, async (origin) => {
    const response = await fetch(`${origin}/api/v1/sms/analyze`, { method: 'POST' });
    assert.equal(response.status, 404);
    assert.equal((await fetch(`${origin}/api/v1/installations/me`, { method: 'DELETE' })).status, 404);
  });
});

test('production administrator enrollment is separate, approved, unique and revocable', async () => {
  const db = fakeDatabase();
  assert.throws(() => requireProductionAdmin({ PRODUCTION_ADMIN_KEY: 'x'.repeat(32) }), /required/);
  assert.throws(() => requireProductionAdmin({ PRODUCTION_ADMIN_KEY: 'x'.repeat(32),
    APCIDA_PRODUCTION_ADMIN_TOKEN: 'wrong' }), /failed/);
  requireProductionAdmin({ PRODUCTION_ADMIN_KEY: 'x'.repeat(32),
    APCIDA_PRODUCTION_ADMIN_TOKEN: 'x'.repeat(32) });
  assert.throws(() => parseCommand(['enroll', '--label', 'Device', '--out', '/tmp/token']), /Usage/);
  const first = await enrollProductionInstallation(db, { label: 'SyntheticOne' });
  const second = await enrollProductionInstallation(db, { label: 'SyntheticTwo' });
  assert.notEqual(first.token, second.token);
  assert.notEqual(first.installationId, second.installationId);
  assert.ok(db.installations.has(hashInstallationToken(first.token)));
  assert.equal(JSON.stringify([...db.installations.values()]).includes(first.token), false);
  assert.equal(await revokeProductionInstallation(db, first.installationId), true);
  assert.ok((await db.findByTokenHash(hashInstallationToken(first.token))).revokedAt);
});

test('production route accepts only its own credential and returns a strict response', async () => {
  const f = fixture();
  await withServer(f.app, async (origin) => {
    const valid = await post(origin, f.token);
    assert.equal(valid.status, 200);
    assert.deepEqual(valid.body, { messageId, classification: 'SCAM',
      confidence: 'HIGH', rationale: 'Synthetic mock warning' });
    assert.equal(valid.headers.get('cache-control'), 'no-store');
    assert.equal((await post(origin, null)).status, 401);
    assert.equal((await post(origin, 'b'.repeat(43))).status, 401);
    const pilot = await fetch(`${origin}/api/sms/analyze`, { method: 'POST',
      headers: { authorization: `Bearer ${f.token}` } });
    assert.equal(pilot.status, 404);
    assert.equal((await post(origin, f.token, sms,
      { 'x-apcida-pilot-synthetic': 'true' })).status, 400);
    assert.equal(JSON.stringify(f.audit).includes(sms.text), false);
    assert.equal(JSON.stringify(f.audit).includes(f.token), false);
  });
});

test('production listener reuses frozen Gemma 3 12B plus RAG shadow pipeline', async () => {
  const f = fixture();
  let embeds = 0;
  let chats = 0;
  const app = createProductionApp(config, { repository: f.db, codec: f.codec,
    knowledgeRepository: { async search(vector) {
      assert.equal(vector.length, 768);
      return [{ label: 'SCAM', content: 'Approved synthetic example', similarity: 0.91 }];
    } },
    fetchImpl: async (url, options) => {
      if (url.endsWith('/api/embed')) {
        embeds++;
        assert.equal(JSON.parse(options.body).model, 'nomic-embed-text');
        return new Response(JSON.stringify({ embeddings: [Array(768).fill(0.01)] }), { status: 200 });
      }
      chats++;
      assert.ok(url.endsWith('/api/chat'));
      const prompt = JSON.parse(options.body);
      assert.equal(prompt.model, 'gemma3:12b');
      assert.match(JSON.stringify(prompt.messages), /Approved synthetic example/);
      return new Response(JSON.stringify({ message: { content: JSON.stringify({
        classification: 'SUSPICIOUS', confidence: 'LOW', rationale: 'Mock uncertain case',
      }) } }), { status: 200 });
    },
  });
  await withServer(app, async (origin) => {
    const result = await post(origin, f.token);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { messageId, classification: 'SUSPICIOUS',
      confidence: 'LOW', rationale: 'Mock uncertain case' });
  });
  assert.equal(embeds, 1);
  assert.equal(chats, 1);
});

test('expired and revoked credentials cannot analyze', async () => {
  const f = fixture();
  await withServer(f.app, async (origin) => {
    f.db.installations.get(f.tokenHash).expiresAt = Date.now() - 1;
    assert.equal((await post(origin, f.token)).status, 401);
    f.db.installations.get(f.tokenHash).expiresAt = Date.now() + 86400000;
    f.db.installations.get(f.tokenHash).revokedAt = new Date();
    assert.equal((await post(origin, f.token)).status, 401);
    assert.equal(f.db.requests.size, 0);
  });
});

test('authenticated self-revocation erases cached verdict and blocks future requests', async () => {
  const f = fixture();
  await withServer(f.app, async (origin) => {
    const path = `${origin}/api/v1/installations/me`;
    assert.equal((await fetch(path, { method: 'DELETE' })).status, 401);
    assert.equal((await fetch(path, { method: 'DELETE',
      headers: { authorization: `Bearer ${'z'.repeat(43)}` } })).status, 401);
    assert.equal((await post(origin, f.token)).status, 200);
    assert.equal(f.db.requests.size, 1);
    assert.equal((await fetch(path, { method: 'DELETE',
      headers: { authorization: `Bearer ${'z'.repeat(43)}` } })).status, 401);
    assert.equal(f.db.requests.size, 1);
    f.db.installations.get(f.tokenHash).expiresAt = Date.now() - 1;
    assert.equal((await fetch(path, { method: 'DELETE',
      headers: { authorization: `Bearer ${f.token}` } })).status, 401);
    assert.equal(f.db.requests.size, 1);
    f.db.installations.get(f.tokenHash).expiresAt = Date.now() + 86400000;
    assert.equal((await fetch(path, { method: 'DELETE',
      headers: { authorization: `Bearer ${f.token}`, 'content-type': 'text/plain' },
      body: 'unexpected payload' })).status, 400);
    assert.equal(f.db.requests.size, 1);
    const result = await fetch(path, { method: 'DELETE',
      headers: { authorization: `Bearer ${f.token}` } });
    assert.equal(result.status, 204);
    assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.equal(f.db.requests.size, 0);
    assert.equal(f.db.windows.has(f.installationId), false);
    assert.equal((await post(origin, f.token)).status, 401);
    assert.equal((await fetch(path, { method: 'DELETE',
      headers: { authorization: `Bearer ${f.token}` } })).status, 401);
  });
  assert.equal(JSON.stringify(f.audit).includes(f.token), false);
  assert.equal(JSON.stringify(f.audit).includes(sms.text), false);
});

test('self-revocation during inference suppresses the response', async () => {
  const f = fixture();
  let release;
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const app = createProductionApp(config, { repository: f.db, codec: f.codec,
    analysisService: { async analyze() { started(); await gate;
      return { classification: 'SAFE', confidence: 'HIGH', rationale: 'Synthetic ordinary message' }; } } });
  await withServer(app, async (origin) => {
    const pending = post(origin, f.token);
    await startedPromise;
    const revoked = await fetch(`${origin}/api/v1/installations/me`, { method: 'DELETE',
      headers: { authorization: `Bearer ${f.token}` } });
    assert.equal(revoked.status, 204);
    release();
    const result = await pending;
    assert.equal(result.status, 401);
    assert.equal(result.body.classification, undefined);
    assert.equal(f.db.requests.size, 0);
  });
});

test('revocation during response completion suppresses the verdict and deletes cache', async () => {
  const db = fakeDatabase();
  const complete = db.complete.bind(db);
  db.complete = async (args) => {
    const saved = await complete(args);
    await db.revoke(args.installationId);
    return saved;
  };
  const f = fixture({ db });
  await withServer(f.app, async (origin) => {
    const result = await post(origin, f.token);
    assert.equal(result.status, 401);
    assert.equal(result.body.classification, undefined);
    assert.equal(db.requests.size, 0);
  });
});

test('duplicate request replays encrypted answer after app restart; changed payload conflicts', async () => {
  const f = fixture();
  let calls = 0;
  const analyzer = { async analyze() { calls++; return {
    classification: 'SAFE', confidence: 'MEDIUM', rationale: 'Synthetic ordinary message',
  }; } };
  const firstApp = createProductionApp(config, { repository: f.db, codec: f.codec, analysisService: analyzer });
  await withServer(firstApp, async (origin) => {
    assert.equal((await post(origin, f.token)).status, 200);
  });
  const secondApp = createProductionApp(config, { repository: f.db, codec: f.codec, analysisService: analyzer });
  await withServer(secondApp, async (origin) => {
    const replay = await post(origin, f.token);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.classification, 'SAFE');
    assert.equal((await post(origin, f.token, { ...sms, text: 'Different synthetic body' })).status, 409);
  });
  assert.equal(calls, 1);
  const record = [...f.db.requests.values()][0];
  assert.equal(record.encrypted.includes(Buffer.from('Synthetic ordinary message')), false);
  assert.equal(JSON.stringify(record).includes(sms.text), false);
  assert.equal(JSON.stringify(record).includes(sms.sender), false);
});

test('a completed response releases its inference slot before the next sequential request', async () => {
  const f = fixture();
  const releaseSlot = f.db.releaseSlot.bind(f.db);
  f.db.releaseSlot = async (owner) => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    return releaseSlot(owner);
  };
  await withServer(f.app, async (origin) => {
    assert.equal((await post(origin, f.token)).status, 200);
    const next = await post(origin, f.token, { ...sms, messageId: randomUUID() });
    assert.equal(next.status, 200, JSON.stringify(next.body));
  });
});

test('revocation between authentication and cached replay blocks the cached verdict', async () => {
  const f = fixture();
  await withServer(f.app, async (origin) => {
    assert.equal((await post(origin, f.token)).status, 200);
    const claim = f.db.claim.bind(f.db);
    f.db.claim = async (input) => {
      const result = await claim(input);
      if (result.kind === 'REPLAY') await f.db.revoke(f.installationId);
      return result;
    };
    const result = await post(origin, f.token);
    assert.equal(result.status, 401);
    assert.notEqual(result.body.classification, 'SCAM');
  });
});

test('concurrent duplicate and another message do not launch parallel inference', async () => {
  const f = fixture();
  let release;
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const app = createProductionApp(config, { repository: f.db, codec: f.codec,
    analysisService: { async analyze() { calls++; started(); await gate;
      return { classification: 'SCAM', confidence: 'HIGH', rationale: 'Mock' }; } } });
  await withServer(app, async (origin) => {
    const first = post(origin, f.token);
    await startedPromise;
    assert.equal((await post(origin, f.token)).status, 409);
    assert.equal((await post(origin, f.token, { ...sms, messageId: randomUUID() })).status, 429);
    release();
    assert.equal((await first).status, 200);
    assert.equal(calls, 1);
  });
});

test('revocation during inference prevents response and clears pending cache', async () => {
  const f = fixture();
  let release;
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const app = createProductionApp(config, { repository: f.db, codec: f.codec,
    analysisService: { async analyze() { started(); await gate;
      return { classification: 'SAFE', confidence: 'HIGH', rationale: 'Mock' }; } } });
  await withServer(app, async (origin) => {
    const pending = post(origin, f.token);
    await startedPromise;
    assert.equal(await f.db.revoke(f.installationId), true);
    release();
    const result = await pending;
    assert.equal(result.status, 401);
    assert.notEqual(result.body.classification, 'SAFE');
    assert.equal(f.db.requests.size, 0);
  });
});

test('stale processing lease can be reclaimed after server recreation', async () => {
  const f = fixture();
  const hmac = f.codec.requestHmac(sms);
  f.db.requests.set(`${f.installationId}/${messageId}`, { requestHmac: hmac,
    leaseOwner: randomUUID(), status: 'PROCESSING', leaseExpired: true });
  await withServer(f.app, async (origin) => {
    assert.equal((await post(origin, f.token)).status, 200);
    assert.equal(f.db.requests.get(`${f.installationId}/${messageId}`).status, 'COMPLETED');
  });
});

test('durable per-install rate counter survives app recreation', async () => {
  const f = fixture({ rateLimit: 1 });
  await withServer(f.app, async (origin) => {
    assert.equal((await post(origin, f.token)).status, 200);
  });
  const next = createProductionApp(config, { repository: f.db, codec: f.codec,
    analysisService: f.analyzer, rateLimit: 1 });
  await withServer(next, async (origin) => {
    const limited = await post(origin, f.token);
    assert.equal(limited.status, 429);
    assert.equal(limited.body.error, 'RATE_LIMITED');
  });
});

test('invalid JSON, key, body and oversized requests fail before inference', async () => {
  const f = fixture();
  await withServer(f.app, async (origin) => {
    assert.equal((await post(origin, f.token, { ...sms, text: '' })).status, 400);
    assert.equal((await post(origin, f.token, { ...sms, messageId: `pilot-${messageId}` })).status, 400);
    assert.equal((await post(origin, f.token, sms, { 'idempotency-key': randomUUID() })).status, 400);
    const malformed = await fetch(`${origin}/api/v1/sms/analyze`, { method: 'POST',
      headers: { authorization: `Bearer ${f.token}`, 'content-type': 'application/json' }, body: '{' });
    assert.equal(malformed.status, 400);
    const huge = await post(origin, f.token, { ...sms, text: 'x'.repeat(9000) });
    assert.equal(huge.status, 413);
    assert.equal(f.db.requests.size, 0);
  });
});

test('database outage and model timeout return errors, never SAFE', async () => {
  const f = fixture();
  f.db.setUnavailable(true);
  await withServer(f.app, async (origin) => {
    const result = await post(origin, f.token);
    assert.equal(result.status, 503);
    assert.equal(result.body.error, 'AUTH_UNAVAILABLE');
  });
  f.db.setUnavailable(false);
  const originalCount = f.db.countRequest;
  f.db.countRequest = async () => { throw Error('synthetic database outage'); };
  await withServer(f.app, async (origin) => {
    const result = await post(origin, f.token);
    assert.equal(result.status, 503);
    assert.equal(result.body.error, 'DATABASE_UNAVAILABLE');
  });
  f.db.countRequest = originalCount;
  const timedOut = createProductionApp(config, { repository: f.db, codec: f.codec,
    analysisService: { async analyze() { throw new OllamaError('OLLAMA_TIMEOUT', 504); } } });
  await withServer(timedOut, async (origin) => {
    const result = await post(origin, f.token);
    assert.equal(result.status, 504);
    assert.equal(result.body.error, 'OLLAMA_TIMEOUT');
    assert.equal(f.db.requests.size, 0);
  });
});

test('production deadline aborts inference and rejects a late SAFE result', async () => {
  let started;
  let finish;
  let observedSignal;
  let calls = 0;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const firstTask = new Promise((resolve) => { finish = resolve; });
  const f = fixture({ deadlineMs: 25, analyzer: { async analyze(_sms, { signal }) {
    calls++;
    if (calls === 1) { observedSignal = signal; started(); return firstTask; }
    return { classification: 'SCAM', confidence: 'HIGH', rationale: 'Synthetic warning' };
  } } });
  await withServer(f.app, async (origin) => {
    const pending = post(origin, f.token);
    await startedPromise;
    const expired = await pending;
    assert.equal(expired.status, 504);
    assert.equal(expired.body.error, 'ANALYSIS_DEADLINE');
    assert.equal(expired.body.classification, undefined);
    assert.equal(observedSignal.aborted, true);
    assert.equal((await post(origin, f.token, { ...sms, messageId: randomUUID() })).status, 429);
    finish({ classification: 'SAFE', confidence: 'HIGH', rationale: 'Late synthetic safe' });
    await new Promise((resolve) => setImmediate(resolve));
    const retried = await post(origin, f.token);
    assert.equal(retried.status, 200);
    assert.equal(retried.body.classification, 'SCAM');
  });
  assert.equal(calls, 2);
});

test('shared deadline propagates through embedding and cancels before Gemma', async () => {
  let embeddingSignal;
  let chats = 0;
  const f = fixture();
  const app = createProductionApp(config, { repository: f.db, codec: f.codec,
    deadlineMs: 25, knowledgeRepository: { async search() { throw Error('must not retrieve'); } },
    fetchImpl: async (url, options) => {
      if (url.endsWith('/api/chat')) { chats++; throw Error('must not chat'); }
      embeddingSignal = options.signal;
      return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')),
          { once: true });
      });
    } });
  await withServer(app, async (origin) => {
    const result = await post(origin, f.token);
    assert.equal(result.status, 504);
    assert.equal(result.body.classification, undefined);
  });
  assert.equal(embeddingSignal.aborted, true);
  assert.equal(chats, 0);
});

test('shared deadline reaches Gemma chat after synthetic embedding', async () => {
  let chatSignal;
  const f = fixture();
  const app = createProductionApp(config, { repository: f.db, codec: f.codec,
    deadlineMs: 25, knowledgeRepository: { async search() { return []; } },
    fetchImpl: async (url, options) => {
      if (url.endsWith('/api/embed')) {
        return new Response(JSON.stringify({ embeddings: [Array(768).fill(0.01)] }), { status: 200 });
      }
      chatSignal = options.signal;
      return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')),
          { once: true });
      });
    } });
  await withServer(app, async (origin) => {
    const result = await post(origin, f.token);
    assert.equal(result.status, 504);
    assert.equal(result.body.classification, undefined);
  });
  assert.equal(chatSignal.aborted, true);
});

test('client disconnect cancels an in-flight synthetic analyzer', async () => {
  const f = fixture();
  let started;
  let aborted;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const abortedPromise = new Promise((resolve) => { aborted = resolve; });
  const app = createProductionApp(config, { repository: f.db, codec: f.codec,
    analysisService: { analyze(_sms, { signal }) {
      started();
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => {
          aborted(); reject(new DOMException('client gone', 'AbortError'));
        }, { once: true });
      });
    } } });
  await withServer(app, async (origin) => {
    const controller = new AbortController();
    const pending = fetch(`${origin}/api/v1/sms/analyze`, { method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': messageId,
        authorization: `Bearer ${f.token}` }, body: JSON.stringify(sms), signal: controller.signal });
    await startedPromise;
    controller.abort();
    await assert.rejects(pending);
    await abortedPromise;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.db.requests.size, 0);
  });
});
