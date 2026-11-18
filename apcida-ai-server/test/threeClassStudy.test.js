const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { calculateThreeClassMetrics } = require('../src/evaluation/threeClassMetrics');
const { loadRows, pairedSummary, validateOutputDir, validateSavedResults, parseArgs } = require('../src/evaluation/threeClassStudy');
const { auditReport } = require('../src/evaluation/auditThreeClassReport');

test('three-class exploratory dataset has each proposed truth label', () => {
  const input = path.resolve(__dirname, '../../dataset/apcida_three_class_exploratory_v1.json');
  const { rows, datasetSha256 } = loadRows(input);
  assert.equal(rows.length, 8);
  assert.deepEqual([...new Set(rows.map((row) => row.groundTruth))].sort(), ['SAFE', 'SCAM', 'SUSPICIOUS']);
  assert.match(datasetSha256, /^[0-9a-f]{64}$/u);
});

test('three-class metrics keep SUSPICIOUS distinct and count errors in recall', () => {
  const rows = [
    ['SAFE', 'SAFE', null, 10], ['SAFE', 'SCAM', null, 20],
    ['SUSPICIOUS', 'SUSPICIOUS', null, 30],
    ['SCAM', 'SUSPICIOUS', null, 40], ['SCAM', null, 'OLLAMA_TIMEOUT', 50],
  ].map(([groundTruth, prediction, error, inferenceDurationMs]) => ({
    groundTruth, prediction, error, inferenceDurationMs,
  }));
  const metrics = calculateThreeClassMetrics(rows);
  assert.equal(metrics.confusionMatrix.SCAM.SUSPICIOUS, 1);
  assert.equal(metrics.confusionMatrix.SCAM.ERROR, 1);
  assert.deepEqual(metrics.scamRecall, { numerator: 0, denominator: 2, value: 0 });
  assert.deepEqual(metrics.scamWarningRecall, { numerator: 1, denominator: 2, value: 0.5 });
  assert.deepEqual(metrics.safeFalsePositiveWarningRate, { numerator: 1, denominator: 2, value: 0.5 });
  assert.equal(metrics.perClass.SUSPICIOUS.f1, 2 / 3);
  assert.equal(metrics.latencyMs.median, 30);
  assert.equal(metrics.latencyMs.p95, 50);
});

test('even-sized latency sample uses the arithmetic median', () => {
  const rows = [10, 20, 30, 80].map((inferenceDurationMs) => ({
    groundTruth: 'SAFE', prediction: 'SAFE', error: null, inferenceDurationMs,
  }));
  assert.equal(calculateThreeClassMetrics(rows).latencyMs.median, 25);
});

test('SAFE timeout is an error, not a correct SAFE result or a false warning', () => {
  const metrics = calculateThreeClassMetrics([
    { groundTruth: 'SAFE', prediction: null, error: 'OLLAMA_TIMEOUT', inferenceDurationMs: 120000 },
    { groundTruth: 'SAFE', prediction: 'SUSPICIOUS', error: null, inferenceDurationMs: 9000 },
  ]);
  assert.equal(metrics.confusionMatrix.SAFE.ERROR, 1);
  assert.deepEqual(metrics.safeFalsePositiveWarningRate,
    { numerator: 1, denominator: 1, value: 1 });
  assert.deepEqual(metrics.exactAccuracy, { numerator: 0, denominator: 2, value: 0 });
  assert.equal(metrics.latencyMs.median, 64500);
});

test('paired comparison excludes failed rows rather than treating them as SAFE', () => {
  const gemma = [
    { messageId: 'A', groundTruth: 'SAFE', prediction: 'SUSPICIOUS', error: null },
    { messageId: 'B', groundTruth: 'SCAM', prediction: 'SCAM', error: null },
  ];
  const rag = [
    { messageId: 'A', groundTruth: 'SAFE', prediction: 'SAFE', error: null },
    { messageId: 'B', groundTruth: 'SCAM', prediction: null, error: 'OLLAMA_TIMEOUT' },
  ];
  assert.deepEqual(pairedSummary(gemma, rag), { commonSuccessful: 1,
    gemmaExactOnCommon: 0, ragExactOnCommon: 1,
    changed: [{ id: 'A', truth: 'SAFE', gemma: 'SUSPICIOUS', rag: 'SAFE' }] });
  assert.throws(() => pairedSummary(gemma, rag.slice(0, 1)), /same row count/u);
  assert.throws(() => pairedSummary(gemma, [{ ...rag[0], groundTruth: 'SCAM' }, rag[1]]), /mismatched/u);
  assert.throws(() => pairedSummary([gemma[0], gemma[0]], rag), /mismatched/u);
});

test('study refuses historical output paths and invalid checkpoint rows', () => {
  assert.throws(() => validateOutputDir(path.resolve(__dirname, '../../evaluation-results/phase2g-gemma')),
    /three-class/u);
  assert.throws(() => parseArgs(['--env-file', '/tmp/private', '--pause-ms', '1', '--pause-ms', '2']),
    /Duplicate/u);
  const metadata = { version: 1 };
  const rows = [{ messageId: 'A', groundTruth: 'SAFE' }];
  const result = { messageId: 'A', groundTruth: 'SAFE', prediction: 'SAFE', error: null,
    inferenceDurationMs: 1 };
  const results = { rules: [result], gemma: [result], gemmaRag: [result], shadow: [result] };
  validateSavedResults({ metadata, results }, metadata, rows);
  assert.throws(() => validateSavedResults({ metadata, results: { ...results,
    shadow: [{ ...result, text: 'private SMS' }] } }, metadata, rows), /sensitive/u);
  assert.throws(() => validateSavedResults({ metadata, results: { ...results,
    gemma: [{ ...result, error: 'OLLAMA_TIMEOUT' }] } }, metadata, rows), /invalid/u);
});

test('auditing a saved report preserves rows and corrects only derived metrics', () => {
  const rows = [
    { messageId: 'A', groundTruth: 'SAFE' },
    { messageId: 'B', groundTruth: 'SCAM' },
  ];
  const results = rows.map((row, index) => ({ ...row,
    prediction: row.groundTruth, error: null, inferenceDurationMs: index ? 20 : 10,
    ruleClassification: row.groundTruth }));
  const source = { metadata: { datasetSha256: 'test', rowCount: 2 },
    metrics: Object.fromEntries(['rules', 'gemma', 'gemmaRag', 'shadow'].map((mode) => [mode,
      { latencyMs: { median: 10 } }])),
    results: Object.fromEntries(['rules', 'gemma', 'gemmaRag', 'shadow'].map((mode) => [mode, results])) };
  const audited = auditReport(source, rows, 'test');
  assert.equal(audited.metrics.gemma.latencyMs.median, 15);
  assert.deepEqual(audited.medianCorrections.gemma, { original: 10, corrected: 15 });
  assert.throws(() => auditReport(source, rows, 'wrong'), /does not match/u);
  source.results.shadow[0] = { ...source.results.shadow[0], text: 'private SMS' };
  assert.throws(() => auditReport(source, rows, 'test'), /sensitive/u);
});
