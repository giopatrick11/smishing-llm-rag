const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { auditHoldout, assertNoOverlap, evaluationOptions } = require('../src/evaluation/phase2g');

test('Phase 2G preflight audits balance, uniqueness, and near-duplicate separation', () => {
  const audit = auditHoldout();
  assert.equal(audit.holdout.length, 50);
  assert.equal(audit.holdout.filter((row) => row.groundTruth === 'SCAM').length, 25);
  assert.equal(audit.holdout.filter((row) => row.groundTruth === 'SAFE').length, 25);
  assert.match(audit.datasetSha256.holdout, /^[a-f0-9]{64}$/);
  assert.throws(() => assertNoOverlap(
    [{ messageId: 'one', text: 'Pay the fake release fee for your prize today' }],
    [{ messageId: 'two', text: 'Pay the fake release fee for your prize today please' }],
    { label: 'test' },
  ), /near duplicate/);
});

test('Phase 2G stages use fixed sequential modes, policy, and separate output directories', () => {
  const gemma = evaluationOptions('gemma');
  const rag = evaluationOptions('gemma-rag');
  const hybrid = evaluationOptions('hybrid-rag');
  assert.equal(gemma.mode, 'gemma');
  assert.equal(rag.mode, 'gemma-rag');
  assert.equal(hybrid.mode, 'rules-gemma-rag');
  assert.equal(hybrid.shadowMode, false);
  assert.equal(hybrid.verdictPolicy, 'evidence-weighted');
  assert.equal(hybrid.pauseMs, 1000);
  assert.notEqual(gemma.outputDir, rag.outputDir);
  assert.notEqual(rag.outputDir, hybrid.outputDir);
  assert.equal(path.basename(hybrid.compareGemmaReport), 'evaluation.json');
  assert.equal(path.basename(hybrid.compareRagReport), 'evaluation.json');
  assert.throws(() => evaluationOptions('unknown'), /Use freeze/);
});
