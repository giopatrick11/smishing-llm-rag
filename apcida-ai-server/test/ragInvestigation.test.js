const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { cosine, referenceMetadata, parseArgs } = require('../src/evaluation/ragInvestigation');

test('embedding repeat comparison reports cosine without storing vectors', () => {
  assert.equal(cosine([1, 0, 1], [1, 0, 1]), 1);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.throws(() => cosine([1], [1, 2]), /Incompatible/u);
  assert.throws(() => cosine([0, 0], [1, 0]), /Zero-length/u);
});

test('retrieval diagnostic strips approved SMS content', () => {
  const metadata = referenceMetadata([{ id: 7, label: 'SAFE', similarity: 0.71,
    content: 'Private reference text' }]);
  assert.deepEqual(metadata, [{ id: '7', label: 'SAFE', similarity: 0.71 }]);
  assert.doesNotMatch(JSON.stringify(metadata), /Private reference/u);
});

test('diagnostic refuses historical report directories', () => {
  assert.throws(() => parseArgs(['--env-file', '/tmp/private', '--output-dir',
    path.resolve(__dirname, '../../evaluation-results/phase2g-gemma')]), /rag-investigation/u);
});
