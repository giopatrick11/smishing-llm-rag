const test = require('node:test');
const assert = require('node:assert/strict');
const { assertIsolatedTarget } = require('../src/staging/liveSyntheticCheck');

test('live synthetic fixture cannot write to the approved main database or a remote target', () => {
  for (const url of [
    'postgresql://localhost:5432/apcida',
    'postgresql://127.0.0.1:5432/apcida',
    'postgresql://db.example.com:55435/apcida',
    'postgresql://127.0.0.1:55435/apcida_staging',
  ]) assert.throws(() => assertIsolatedTarget(url));
  assert.doesNotThrow(() => assertIsolatedTarget('postgresql://user@127.0.0.1:55435/apcida'));
});
