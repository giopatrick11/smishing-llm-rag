const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { prepareSubset, eventLogger } = require('../src/evaluation/phase2hDiagnostic');

test('Phase 2H subset preserves the two frozen SAFE messages', () => {
  const subset = prepareSubset();
  assert.deepEqual(subset.rows.map((row) => row.messageId), ['SF016', 'SF046']);
  assert.deepEqual(subset.rows.map((row) => row.groundTruth), ['SAFE', 'SAFE']);
  assert.match(subset.holdoutSha256, /^[a-f0-9]{64}$/);
  assert.match(subset.subsetSha256, /^[a-f0-9]{64}$/);
});

test('Phase 2H event markers contain timestamps and no message text', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase2h-log-'));
  try {
    const file = path.join(dir, 'events.jsonl');
    eventLogger(file)('chat_start', { messageId: 'SF016' });
    const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(entry.event, 'chat_start');
    assert.equal(entry.messageId, 'SF016');
    assert.match(entry.at, /^\d{4}-\d\d-\d\dT/);
    assert.ok(entry.wallElapsedMs >= 0);
    assert.ok(entry.monotonicElapsedMs >= 0);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
