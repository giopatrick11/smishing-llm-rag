const test = require('node:test');
const assert = require('node:assert/strict');
const {
  issueInstallationCredential, hashInstallationToken, validProductionOrigin,
  createInstallationAuth, createInstallationRateLimiter,
} = require('../src/production/security');

function response() {
  return {
    locals: {}, headers: {},
    set(name, value) { this.headers[name] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('production origin requires HTTPS and the exact approved DNS name', () => {
  assert.equal(validProductionOrigin('https://ai.example.org/', 'ai.example.org'), true);
  for (const origin of [
    'http://ai.example.org/', 'https://ai.example.org.evil.test/',
    'https://user@ai.example.org/', 'https://ai.example.org:8443/',
    'https://ai.example.org/path', 'https://ai.example.org/?key=secret',
    'https://127.0.0.1/', 'https://ai.example.org/#fragment',
  ]) assert.equal(validProductionOrigin(origin, 'ai.example.org'), false, origin);
  assert.equal(validProductionOrigin('https://ai.example.org/', undefined), false);
});

test('installation credentials are unique opaque tokens with server-side hashes', () => {
  const first = issueInstallationCredential();
  const second = issueInstallationCredential();
  assert.notEqual(first.token, second.token);
  assert.equal(hashInstallationToken(first.token), first.tokenHash);
  assert.notEqual(first.tokenHash, first.token);
  assert.throws(() => hashInstallationToken('shared-dev-key'), /format/);
});

test('missing, invalid, expired and revoked credentials all fail with generic 401', async () => {
  const { token, tokenHash } = issueInstallationCredential();
  const audit = [];
  let lookupCount = 0;
  const auth = createInstallationAuth({
    findByTokenHash: async (hash) => { lookupCount++; return hash === tokenHash
      ? { installationId: 'install-1', expiresAt: 2000, revokedAt: null } : null; },
    now: () => 1000, audit: (event) => audit.push(event),
  });
  for (const header of [undefined, 'Bearer wrong', `Bearer ${issueInstallationCredential().token}`]) {
    const res = response();
    await auth({ get: () => header, body: { text: 'private SMS' } }, res, () => assert.fail('must reject'));
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, { error: 'UNAUTHORIZED' });
  }
  assert.equal(lookupCount, 1);
  for (const record of [
    { installationId: 'install-1', expiresAt: 1000, revokedAt: null },
    { installationId: 'install-1', expiresAt: 2000, revokedAt: 900 },
  ]) {
    const middleware = createInstallationAuth({ findByTokenHash: async () => record, now: () => 1000 });
    const res = response();
    await middleware({ get: () => `Bearer ${token}` }, res, () => assert.fail('must reject'));
    assert.equal(res.statusCode, 401);
  }
  assert.doesNotMatch(JSON.stringify(audit), /private SMS|Bearer|wrong|install-1/);
});

test('valid installation reaches next middleware and is rate limited independently', async () => {
  const { token, tokenHash } = issueInstallationCredential();
  const auth = createInstallationAuth({ findByTokenHash: async (hash) => hash === tokenHash
    ? { installationId: 'install-1', expiresAt: 2000 } : null, now: () => 1000 });
  const limiter = createInstallationRateLimiter({ limit: 1, now: () => 1000 });
  const req = { get: () => `Bearer ${token}` };
  const first = response();
  await auth(req, first, () => limiter(req, first, () => { first.passed = true; }));
  assert.equal(first.passed, true);
  const second = response();
  await auth(req, second, () => limiter(req, second, () => assert.fail('rate limit')));
  assert.equal(second.statusCode, 429);
  assert.deepEqual(second.body, { error: 'RATE_LIMITED' });
});

test('authentication store outage is an error, never a SAFE classification', async () => {
  const { token } = issueInstallationCredential();
  const audit = [];
  const auth = createInstallationAuth({
    findByTokenHash: async () => { throw new Error('database connection details'); },
    audit: (event) => audit.push(event),
  });
  const res = response();
  await auth({ get: () => `Bearer ${token}`, body: { text: 'private SMS' } }, res,
    () => assert.fail('must reject'));
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.body, { error: 'AUTH_UNAVAILABLE' });
  assert.deepEqual(audit, [{ event: 'INSTALL_AUTH_STORE_UNAVAILABLE' }]);
});
