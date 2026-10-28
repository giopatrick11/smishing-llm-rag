const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { stagingSettings, syntheticAnalyzer } = require('../src/staging/localServer');

const base = process.env.APCIDA_STAGING_HTTP_BASE;
const token = process.env.APCIDA_STAGING_TOKEN;
const revoked = process.env.APCIDA_STAGING_REVOKED_TOKEN;
const selfRevoke = process.env.APCIDA_STAGING_SELF_REVOKE_TOKEN;

function syntheticSms(kind, id = randomUUID()) {
  return { messageId: id, sender: 'ManualTest',
    text: 'STAGING SYNTHETIC: ' + kind + ' contract fixture',
    receivedAt: '2026-10-28T00:00:00Z' };
}

async function request(body, bearer = token, idempotencyKey = body.messageId) {
  const response = await fetch(base + '/api/v1/sms/analyze', { method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey,
      ...(bearer ? { authorization: 'Bearer ' + bearer } : {}) },
    body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

test('staging configuration refuses normal environments and non-staging databases', () => {
  assert.throws(() => stagingSettings({}), /disabled/);
  assert.throws(() => stagingSettings({ APCIDA_STAGING_ENABLED: 'true',
    APCIDA_STAGING_BIND: '0.0.0.0' }), /disabled/);
  assert.throws(() => stagingSettings({ APCIDA_STAGING_ENABLED: 'true',
    APCIDA_STAGING_BIND: '127.0.0.1',
    APCIDA_STAGING_DATABASE_URL: 'postgresql://localhost/apcida' }), /staging database/);
  assert.equal(typeof syntheticAnalyzer().analyze, 'function');
});

test('isolated staging listener verifies authenticated verdict, replay and failure contract',
  { skip: !base || !token || !revoked || !selfRevoke }, async () => {
    assert.equal(new URL(base).hostname, '127.0.0.1');
    const scam = syntheticSms('SCAM');
    const first = await request(scam);
    assert.equal(first.status, 200);
    assert.equal((await fetch(base + '/health')).status, 200);
    assert.deepEqual(first.body, { messageId: scam.messageId,
      classification: 'SCAM', confidence: 'HIGH', rationale: 'Synthetic staging response' });
    assert.deepEqual((await request(scam)).body, first.body);
    assert.equal((await request({ ...scam, text: 'STAGING SYNTHETIC: SAFE changed' })).status, 409);
    const safe = await request(syntheticSms('SAFE'));
    assert.equal(safe.status, 200, JSON.stringify(safe.body));
    assert.equal(safe.body.classification, 'SAFE');
    assert.equal((await request(syntheticSms('SUSPICIOUS'))).body.classification, 'SUSPICIOUS');
    assert.equal((await request(syntheticSms('SCAM'), null)).status, 401);
    assert.equal((await request(syntheticSms('SCAM'), 'b'.repeat(43))).status, 401);
    assert.equal((await request(syntheticSms('SCAM'), revoked)).status, 401);
    assert.equal((await request({ ...syntheticSms('SCAM'), text: '' })).status, 400);
    const malformed = await fetch(base + '/api/v1/sms/analyze', { method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: '{' });
    assert.equal(malformed.status, 400);
    const pilot = await fetch(base + '/api/v1/sms/analyze', { method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json',
        'idempotency-key': randomUUID(), 'x-apcida-pilot-synthetic': 'true' },
      body: JSON.stringify(syntheticSms('SCAM')) });
    assert.equal(pilot.status, 400);
    const timedOut = await request(syntheticSms('TIMEOUT'));
    assert.equal(timedOut.status, 504);
    assert.equal(timedOut.body.error, 'OLLAMA_TIMEOUT');
    assert.equal(timedOut.body.classification, undefined);
    const disposable = syntheticSms('SCAM');
    assert.equal((await request(disposable, selfRevoke)).status, 200);
    const deletion = await fetch(base + '/api/v1/installations/me', { method: 'DELETE',
      headers: { authorization: 'Bearer ' + selfRevoke } });
    assert.equal(deletion.status, 204);
    assert.equal((await request(disposable, selfRevoke)).status, 401);
  });
