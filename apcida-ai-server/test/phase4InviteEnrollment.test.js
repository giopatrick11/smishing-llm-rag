const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { createProductionApp } = require('../src/production/createProductionApp');
const { hashInvite, issueInvite, redeemInvite,
  createCloudflareTokenClient, renewInstallation, cleanupCloudflareTokens } = require('../src/production/inviteEnrollment');
const { shouldApplyMigration } = require('../src/db/migrate');

function fakeStore() {
  const invites = new Map();
  const installations = [];
  return {
    invites, installations,
    async issue(row) { invites.set(row.hash, { ...row, claim: null, used: false }); },
    async claim(hash, claimId) {
      const row = invites.get(hash);
      if (!row || row.used || row.expiresAt <= Date.now() || row.claim) return null;
      row.claim = claimId;
      return { label: row.label };
    },
    async release(hash, claimId) {
      const row = invites.get(hash);
      if (row?.claim === claimId) row.claim = null;
    },
    async finish(row) {
      const invite = invites.get(row.hash);
      if (!invite || invite.used || invite.claim !== row.claimId) return false;
      invite.used = true;
      invite.claim = null;
      installations.push(row);
      return true;
    },
  };
}

test('invite is strong, hashed at rest, one-use, and provisions distinct per-phone secrets', async () => {
  assert.equal(shouldApplyMigration('005_production_invites.sql'), false);
  assert.equal(shouldApplyMigration('005_production_invites.sql', { includeProduction: true }), true);
  assert.equal(shouldApplyMigration('006_production_invite_cleanup.sql'), false);
  const store = fakeStore();
  const invite = await issueInvite(store, { label: 'Test phone' });
  assert.match(invite.code, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(store.invites.has(hashInvite(invite.code)));
  assert.ok(!JSON.stringify([...store.invites.values()]).includes(invite.code));
  const cf = { async create() { return { id: 'cf-1', clientId: 'id.access', clientSecret: 'secret' }; },
    async remove() { throw Error('must not remove successful token'); } };
  const first = await redeemInvite(store, cf, invite.code);
  assert.match(first.installationToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(first.clientId, 'id.access');
  assert.equal(store.installations[0].cfTokenId, 'cf-1');
  assert.ok(!JSON.stringify(store.installations).includes(first.installationToken));
  assert.equal(await redeemInvite(store, cf, invite.code), null);
  assert.equal(await redeemInvite(store, cf, 'invalid'), null);
});

test('failed provisioning releases invite and deletes orphan Cloudflare token', async () => {
  const store = fakeStore();
  const { code } = await issueInvite(store, { label: 'Second phone' });
  let removed = 0;
  const cf = { async create() { return { id: 'cf-2', clientId: 'id.access', clientSecret: 'secret' }; },
    async remove(id) { assert.equal(id, 'cf-2'); removed++; } };
  const finish = store.finish;
  store.finish = async () => { throw Error('database unavailable'); };
  await assert.rejects(redeemInvite(store, cf, code), /database unavailable/);
  assert.equal(removed, 1);
  assert.equal(store.invites.get(hashInvite(code)).claim, null);
  store.finish = finish;
  assert.ok(await redeemInvite(store, cf, code));
});

test('Cloudflare API client uses a scoped create call without disclosing its API token', async () => {
  const calls = [];
  const cf = createCloudflareTokenClient({ accountId: 'a'.repeat(32), apiToken: 't'.repeat(30),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200, async json() { return { success: true,
        result: { id: 'cf-3', client_id: 'phone.access', client_secret: 'b'.repeat(54) } }; } };
    } });
  const token = await cf.create('device-id');
  assert.equal(token.clientId, 'phone.access');
  assert.equal(calls[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].options.body),
    { name: 'apcida-device-id', duration: '720h', enabled: true });
  assert.ok(calls[0].url.startsWith('https://api.cloudflare.com/client/v4/accounts/'));
});

test('Cloudflare refresh extends the same service token without returning a new secret', async () => {
  const calls = [];
  const cf = createCloudflareTokenClient({ accountId: 'a'.repeat(32), apiToken: 't'.repeat(30),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200, async json() { return { success: true,
        result: { id: 'cf-3', enabled: true, expires_at: '2026-12-01T00:00:00Z' } }; } };
    } });
  assert.equal((await cf.refresh('cf-3')).expiresAt, Date.parse('2026-12-01T00:00:00Z'));
  assert.ok(calls[0].url.endsWith('/cf-3/refresh'));
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.body, undefined);
});

test('phone renewal waits until the last week and never extends a revoked installation', async () => {
  const now = Date.parse('2026-11-02T00:00:00Z');
  let expiry = now + 6 * 86400000;
  let active = true;
  let refreshes = 0;
  const repository = {
    async renewalCandidate() { return active ? { cfTokenId: 'cf-3', expiresAt: expiry } : null; },
    async extendExpiry(id, tokenId, next) {
      assert.equal(id, 'phone-1');
      assert.equal(tokenId, 'cf-3');
      if (!active) return null;
      expiry = next;
      return expiry;
    },
  };
  const cf = { async refresh() { refreshes++; return { expiresAt: now + 30 * 86400000 }; } };
  assert.equal(await renewInstallation(repository, cf, 'phone-1', { now: () => now }),
    now + 29 * 86400000);
  assert.equal(refreshes, 1);
  assert.equal(await renewInstallation(repository, cf, 'phone-1', { now: () => now }), expiry);
  assert.equal(refreshes, 1);
  active = false;
  assert.equal(await renewInstallation(repository, cf, 'phone-1', { now: () => now }), null);
  assert.equal(refreshes, 1);
});

test('phone renewal refuses a Cloudflare expiry that is too short', async () => {
  const now = Date.parse('2026-11-02T00:00:00Z');
  const repository = { async renewalCandidate() {
    return { cfTokenId: 'cf-3', expiresAt: now + 2 * 86400000 };
  }, async extendExpiry() { throw Error('must not write'); } };
  await assert.rejects(renewInstallation(repository,
    { async refresh() { return { expiresAt: now + 3 * 86400000 }; } },
    'phone-1', { now: () => now }), /did not extend/);
});

test('revoked phone tokens stay queued until Cloudflare confirms deletion', async () => {
  let pending = [{ installationId: 'phone-1', cfTokenId: 'cf-1' }];
  const repository = {
    async pendingCloudflareTokens() { return pending; },
    async markCloudflareTokenRemoved(id, tokenId) {
      assert.equal(id, 'phone-1');
      assert.equal(tokenId, 'cf-1');
      pending = [];
    },
  };
  assert.equal(await cleanupCloudflareTokens(repository, { async remove() { throw Error('offline'); } }), 0);
  assert.equal(pending.length, 1);
  assert.equal(await cleanupCloudflareTokens(repository, { async remove() {} }), 1);
  assert.equal(pending.length, 0);
});

async function withServer(app, run) {
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

test('enrollment endpoint is absent by default and validates one code when enabled', async () => {
  const repository = Object.fromEntries(['findByTokenHash', 'isActive', 'revoke', 'countRequest',
    'claim', 'complete', 'release', 'acquireSlot', 'releaseSlot'].map((name) => [name, async () => null]));
  const options = { repository, codec: { requestHmac() {}, encrypt() {}, decrypt() {} },
    analysisService: { analyze() {} } };
  const config = { model: 'gemma3:12b', ragEnabled: true, rulesEnabled: true,
    rulesShadowMode: true, verdictPolicy: 'gemma' };
  const post = (origin, body) => fetch(`${origin}/api/v1/enrollment`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  await withServer(createProductionApp(config, options), async (origin) => {
    assert.equal((await post(origin, { inviteCode: 'x'.repeat(43) })).status, 404);
  });
  let redeemed = 0;
  const app = createProductionApp(config, { ...options, inviteEnrollment: {
    async redeem() { redeemed++; return null; },
  } });
  await withServer(app, async (origin) => {
    assert.equal((await post(origin, { inviteCode: 12 })).status, 400);
    assert.equal((await post(origin, { inviteCode: 'x'.repeat(43), other: true })).status, 400);
    assert.equal(redeemed, 0);
    assert.equal((await post(origin, { inviteCode: 'x'.repeat(43) })).status, 401);
    assert.equal(redeemed, 1);
  });
});

test('renewal endpoint requires an active phone credential and accepts an empty request', async () => {
  const token = 'a'.repeat(43);
  const repository = Object.fromEntries(['findByTokenHash', 'isActive', 'revoke', 'countRequest',
    'claim', 'complete', 'release', 'acquireSlot', 'releaseSlot'].map((name) => [name, async () => null]));
  repository.findByTokenHash = async () => ({ installationId: 'phone-1',
    expiresAt: Date.now() + 86400000, revokedAt: null });
  const config = { model: 'gemma3:12b', ragEnabled: true, rulesEnabled: true,
    rulesShadowMode: true, verdictPolicy: 'gemma' };
  let renewals = 0;
  const app = createProductionApp(config, {
    repository, codec: { requestHmac() {}, encrypt() {}, decrypt() {} },
    analysisService: { analyze() {} }, inviteEnrollment: {
      async redeem() { return null; },
      async renew(id) { assert.equal(id, 'phone-1'); renewals++; return Date.now() + 29 * 86400000; },
    },
  });
  await withServer(app, async (origin) => {
    const url = `${origin}/api/v1/installations/me/renew`;
    assert.equal((await fetch(url, { method: 'POST' })).status, 401);
    assert.equal((await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}` },
      body: 'unexpected' })).status, 400);
    const response = await fetch(url, { method: 'POST',
      headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200);
    assert.ok(Number.isFinite((await response.json()).expiresAt));
    assert.equal(renewals, 1);
  });
});
