const test = require('node:test');
const assert = require('node:assert/strict');
const { assertIsolatedTarget } = require('../src/staging/liveSyntheticCheck');
const { assertControlledTarget } = require('../src/staging/copyApprovedKnowledge');

test('live synthetic fixture cannot write to the approved main database or a remote target', () => {
  for (const url of [
    'postgresql://localhost:5432/apcida',
    'postgresql://127.0.0.1:5432/apcida',
    'postgresql://db.example.com:55435/apcida',
    'postgresql://127.0.0.1:55435/apcida_staging',
  ]) assert.throws(() => assertIsolatedTarget(url));
  assert.doesNotThrow(() => assertIsolatedTarget('postgresql://user@127.0.0.1:55435/apcida'));
});

test('persistent synthetic knowledge copy is pinned to a separate loopback database', () => {
  for (const url of [
    'postgresql://127.0.0.1:5432/apcida',
    'postgresql://127.0.0.1:55435/apcida',
    'postgresql://db.example.com:55436/apcida',
    'postgresql://127.0.0.1:55436/other',
  ]) assert.throws(() => assertControlledTarget(url));
  assert.doesNotThrow(() => assertControlledTarget('postgresql://user@127.0.0.1:55436/apcida'));
});
