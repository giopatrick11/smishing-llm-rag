const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { validateReport } = require('../src/production/reportContract');
const { createPrivacyCodec } = require('../src/production/privacy');
const { parseArgs } = require('../src/production/reportReviewCli');
const { shouldApplyMigration } = require('../src/db/migrate');

const base = { clientReportId: randomUUID(), reportType: 'Scam was not detected',
  remarks: 'The warning did not appear', smsText: null,
  messageSharingConsent: false, observedVerdict: 'SAFE', riskScore: 0 };

test('report contract requires explicit message sharing and rejects unknown fields', () => {
  assert.deepEqual(validateReport(base), base);
  assert.equal(validateReport({ ...base, smsText: 'private SMS' }), null);
  assert.equal(validateReport({ ...base, smsText: 'private SMS', messageSharingConsent: true })?.smsText,
    'private SMS');
  assert.equal(validateReport({ ...base, sender: 'phone number' }), null);
  assert.equal(validateReport({ ...base, gemmaRationale: 'echoed SMS' }), null);
  assert.equal(validateReport({ ...base, remarks: 'x'.repeat(501) }), null);
  assert.equal(validateReport({ ...base, clientReportId: 'not-a-uuid' }), null);
});

test('report privacy codec encrypts content and gives a separate keyed digest', () => {
  const codec = createPrivacyCodec('1a'.repeat(32));
  const report = validateReport({ ...base, smsText: 'private SMS', messageSharingConsent: true });
  const encrypted = codec.encryptReport(report);
  assert.equal(encrypted.includes(Buffer.from('private SMS')), false);
  assert.deepEqual(codec.decryptReport(encrypted), report);
  assert.throws(() => codec.decrypt(encrypted));
  assert.equal(codec.reportHmac(report), codec.reportHmac(report));
  assert.notEqual(codec.reportHmac(report), codec.reportHmac({ ...report, smsText: 'different' }));
});

test('review command requires a report ID and a new absolute private output path', () => {
  const installationId = randomUUID();
  assert.deepEqual(parseArgs(['list']), { action: 'list' });
  assert.deepEqual(parseArgs(['inspect', '--id', base.clientReportId,
    '--installation-id', installationId, '--out', '/private/tmp/report.json']),
  { action: 'inspect', id: base.clientReportId, installationId,
    out: '/private/tmp/report.json' });
  assert.throws(() => parseArgs(['inspect', '--id', base.clientReportId,
    '--installation-id', installationId, '--out', 'report.json']), /Usage/);
  assert.throws(() => parseArgs(['review', '--id', base.clientReportId]), /Usage/);
  assert.throws(() => parseArgs(['review', '--id', 'bad-id']), /Usage/);
});

test('report table migration requires controlled production schema opt-in', () => {
  assert.equal(shouldApplyMigration('007_production_reports.sql'), false);
  assert.equal(shouldApplyMigration('007_production_reports.sql', { includeProduction: true }), true);
});
