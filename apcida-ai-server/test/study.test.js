const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { validateBatch } = require('../src/study/contract');
const { createPrivacyCodec } = require('../src/production/privacy');
const { createProductionApp } = require('../src/production/createProductionApp');
const { createAdminApp } = require('../src/admin-web/app');
const { issueInstallationCredential } = require('../src/production/security');

const installationId = randomUUID();
const participantId = randomUUID();
const clientId = 'a'.repeat(64);
const batch = () => ({ batchId: randomUUID(), participantId, submittedAt: Date.now(),
  consentScope: 'STUDY_EVALUATION_ONLY', examinedCount: 1, offeredCount: 1,
  selectionMethod: 'RECENT_INBOX_PARTICIPANT_REVIEW',
  items: [{ clientId, text: 'Ordinary appointment reminder',
    localSuggestion: 'UNVERIFIED', reviewedAt: Date.now() - 1000 }] });

function request(base, pathname, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(base + pathname, { method, headers: { host: '127.0.0.1:3022', ...headers } }, (res) => {
      let output = '';
      res.setEncoding('utf8');
      res.on('data', (part) => { output += part; });
      res.on('end', () => resolve({ status: res.statusCode, body: output,
        cookie: res.headers['set-cookie']?.[0]?.split(';')[0], location: res.headers.location }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function withServer(app, run) {
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise((resolve) => server.once('listening', resolve));
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally { await new Promise((resolve) => server.close(resolve)); }
}

test('study batch requires explicit scope, reviewed text, and no participant label', () => {
  const valid = batch();
  assert.deepEqual(validateBatch(valid), valid);
  assert.equal(validateBatch({ ...valid, consentScope: 'REVIEW_AND_RAG_CANDIDATE' }), null);
  assert.equal(validateBatch({ ...valid, items: [{ ...valid.items[0], sender: 'private' }] }), null);
  assert.equal(validateBatch({ ...valid, items: [{ ...valid.items[0], text: 'Your code is 123456' }] }), null);
  assert.equal(validateBatch({ ...valid, items: [{ ...valid.items[0], reviewedCategory: 'SAFE' }] }), null);
  assert.equal(validateBatch({ ...valid, items: Array(21).fill(valid.items[0]) }), null);
});

test('study content uses a separate encryption key from reports', () => {
  const codec = createPrivacyCodec('12'.repeat(32));
  const encrypted = codec.encryptStudy({ text: 'private SMS' });
  assert.deepEqual(codec.decryptStudy(encrypted), { text: 'private SMS' });
  assert.equal(encrypted.includes(Buffer.from('private SMS')), false);
  assert.throws(() => codec.decryptReport(encrypted));
});

test('contribution upload stores a batch without invoking SMS inference', async () => {
  const { token } = issueInstallationCredential();
  const codec = createPrivacyCodec('13'.repeat(32));
  const calls = [];
  const studyRepository = {
    progress: async () => ({ totalAccepted: 0 }),
    submit: async (id, value) => { calls.push([id, value]); return { kind: 'ACCEPTED', response: {
      acceptedClientIds: [clientId], rejectedClientIds: [],
      progress: { totalAccepted: 1 },
    } }; },
    withdraw: async (id) => { calls.push(['withdraw', id]); },
  };
  const app = createProductionApp({ model: 'gemma3:12b', ragEnabled: true,
    rulesEnabled: true, rulesShadowMode: true, verdictPolicy: 'gemma' }, {
    repository: { findByTokenHash: async () => ({ installationId, expiresAt: Date.now() + 60000 }),
      isActive() {}, revoke() {}, countRequest() {}, claim() {}, complete() {}, release() {},
      acquireSlot() {}, releaseSlot() {}, submitReport() {} },
    codec, studyRepository, analysisService: { analyze: async () => { throw new Error('inference ran'); } },
  });
  await withServer(app, async (base) => {
    const payload = batch();
    const response = await request(base, '/api/v1/community/contributions', { method: 'POST',
      headers: { host: '127.0.0.1:3022', authorization: `Bearer ${token}`,
        'content-type': 'application/json' }, body: JSON.stringify(payload) });
    assert.equal(response.status, 200);
    assert.equal(JSON.parse(response.body).progress.totalAccepted, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], installationId);
    const removed = await request(base, '/api/v1/community/contributions', { method: 'DELETE',
      headers: { authorization: `Bearer ${token}` } });
    assert.equal(removed.status, 204);
  });
});

test('expert role cannot see predictions or queue analysis before independent labeling', async () => {
  let expertLabel = null;
  let queued = 0;
  const studyRepository = {
    list: async () => [{ id: '1', created_at: new Date(), prediction_status: 'COMPLETED',
      classification: 'SCAM', expert_label: expertLabel }],
    stats: async () => ({ total: 1, completed: 1, errors: 0, expert_labeled: expertLabel ? 1 : 0,
      examined: 1, offered: 1, selected: 1 }),
    get: async () => ({ id: '1', created_at: new Date(), text: '<script>private</script>',
      prediction_status: 'COMPLETED', classification: 'SCAM', expert_label: expertLabel }),
    label: async (id, label) => { expertLabel = label; return true; },
    comparison: async () => [],
    exportRows: async () => [{ id: '1', participant_id: participantId,
      expert_label: expertLabel, classification: 'SCAM', reviewer: '=HYPERLINK("bad")' }],
  };
  const app = createAdminApp({ pool: { query: async () => ({ rows: [] }) },
    codec: { decryptReport() {} }, loginPassword: 'a'.repeat(64),
    expertLoginPassword: 'b'.repeat(64), embeddingService: { embed() {} },
    corpus: { sha256: 'f'.repeat(64) }, studyRepository,
    studyWorker: { queueNext: async () => { queued++; return [1]; } } });
  await withServer(app, async (base) => {
    const login = await request(base, '/login', { method: 'POST', headers: {
      origin: 'http://127.0.0.1:3022', 'content-type': 'application/x-www-form-urlencoded',
    }, body: `password=${'b'.repeat(64)}` });
    assert.equal(login.status, 303);
    assert.equal(login.location, '/study');
    const detail = await request(base, '/study/1', { headers: { cookie: login.cookie } });
    assert.equal(detail.status, 200);
    assert.match(detail.body, /&lt;script&gt;private&lt;\/script&gt;/u);
    assert.doesNotMatch(detail.body, /System result|Confidence:/u);
    const expertList = await request(base, '/study', { headers: { cookie: login.cookie } });
    assert.doesNotMatch(expertList.body, /COMPLETED|analysis errors/u);
    const csrf = /name="csrf" value="([a-f0-9]+)"/u.exec(detail.body)[1];
    const blocked = await request(base, '/study/analyze-next', { method: 'POST',
      headers: { cookie: login.cookie, origin: 'http://127.0.0.1:3022',
        'content-type': 'application/x-www-form-urlencoded' }, body: `csrf=${csrf}` });
    assert.equal(blocked.status, 403);
    assert.equal(queued, 0);
    const hiddenExport = await request(base, '/study/results.csv', { headers: { cookie: login.cookie } });
    assert.equal(hiddenExport.status, 403);
    const label = await request(base, '/study/1/label', { method: 'POST',
      headers: { cookie: login.cookie, origin: 'http://127.0.0.1:3022',
        'content-type': 'application/x-www-form-urlencoded' },
      body: `csrf=${csrf}&label=SAFE&reviewer=Expert` });
    assert.equal(label.status, 303);
    assert.equal(expertLabel, 'SAFE');
    const adminLogin = await request(base, '/login', { method: 'POST', headers: {
      origin: 'http://127.0.0.1:3022', 'content-type': 'application/x-www-form-urlencoded',
    }, body: `password=${'a'.repeat(64)}` });
    const list = await request(base, '/study', { headers: { cookie: adminLogin.cookie } });
    assert.equal(list.status, 200);
    assert.match(list.body, /Analyze next 10/u);
    const adminDetail = await request(base, '/study/1', { headers: { cookie: adminLogin.cookie } });
    assert.doesNotMatch(adminDetail.body, /Save expert label/u);
    const adminCsrf = /name="csrf" value="([a-f0-9]+)"/u.exec(list.body)[1];
    const adminLabel = await request(base, '/study/1/label', { method: 'POST', headers: {
      cookie: adminLogin.cookie, origin: 'http://127.0.0.1:3022',
      'content-type': 'application/x-www-form-urlencoded',
    }, body: `csrf=${adminCsrf}&label=SCAM&reviewer=Admin` });
    assert.equal(adminLabel.status, 403);
    const queue = await request(base, '/study/analyze-next', { method: 'POST', headers: {
      cookie: adminLogin.cookie, origin: 'http://127.0.0.1:3022',
      'content-type': 'application/x-www-form-urlencoded',
    }, body: `csrf=${adminCsrf}` });
    assert.equal(queue.status, 303);
    assert.equal(queued, 1);
    const exported = await request(base, '/study/results.csv', { headers: { cookie: adminLogin.cookie } });
    assert.equal(exported.status, 200);
    assert.doesNotMatch(exported.body, /private|<script>/u);
    assert.doesNotMatch(exported.body, /participant_label/u);
    assert.match(exported.body, /'=HYPERLINK/u);
  });
});
