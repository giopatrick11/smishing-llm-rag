const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseCsv, loadDataset, resultsToCsv, metricsToCsv } = require('../src/evaluation/csv');
const { calculateMetrics } = require('../src/evaluation/metrics');
const { openCheckpoint, acquireRunLock, metadataMatches } = require('../src/evaluation/checkpoint');
const { parseArgs } = require('../src/evaluation/cli');
const { safeRationale } = require('../src/evaluation/run');

test('CSV parser handles BOM, CRLF, escaped quotes, and multiline SMS', () => {
  const csv = '\uFEFFid,sms,truth,sender\r\n1,"Hello, ""friend""\nPlease call.",safe,ABC\r\n2,Claim prize now,SCAM,XYZ\r\n';
  assert.deepEqual(parseCsv(csv), [
    ['id', 'sms', 'truth', 'sender'],
    ['1', 'Hello, "friend"\nPlease call.', 'safe', 'ABC'],
    ['2', 'Claim prize now', 'SCAM', 'XYZ'],
  ]);
  const rows = loadDataset(csv, { idColumn: 'id', textColumn: 'sms', labelColumn: 'truth', senderColumn: 'sender' });
  assert.deepEqual(rows, [
    { messageId: '1', groundTruth: 'SAFE', text: 'Hello, "friend"\nPlease call.', sender: 'ABC', receivedAt: undefined },
    { messageId: '2', groundTruth: 'SCAM', text: 'Claim prize now', sender: 'XYZ', receivedAt: undefined },
  ]);
  assert.equal(resultsToCsv([{ messageId: '1', groundTruth: 'SAFE', prediction: 'SAFE', confidence: 'LOW', rationale: 'A "quote", here', inferenceDurationMs: 10, error: null }]),
    'messageId,groundTruth,prediction,confidence,rationale,inferenceDurationMs,error\n1,SAFE,SAFE,LOW,"A ""quote"", here",10,\n');
});

test('CSV loader rejects bad structure, labels, and duplicate IDs before inference', () => {
  const mapping = { idColumn: 'id', textColumn: 'sms', labelColumn: 'label' };
  assert.throws(() => parseCsv('sms,label\n"unclosed,SCAM'), /unterminated/);
  assert.throws(() => loadDataset('id,sms,label\n1,Hello,MAYBE\n', mapping), /ground-truth/);
  assert.throws(() => loadDataset('id,sms,label\n1,Hello,SAFE\n1,Goodbye,SCAM\n', mapping), /duplicate message ID/);
  assert.throws(() => loadDataset('id,sms,label\n1,Hello,SAFE,extra\n', mapping), /fields/);
  assert.throws(() => loadDataset('id,sms,label\n1,Hello,SAFE\n', { ...mapping, textColumn: 'missing' }), /column not found/);
  assert.throws(() => loadDataset('id,sms,label\n1,Hello,SAFE\n', { ...mapping, idColumn: 'sms' }), /ID column cannot/);
  const generated = loadDataset('sms,label\nHello,SAFE\n', { textColumn: 'sms', labelColumn: 'label' });
  assert.equal(generated[0].messageId, 'row-000001');
});

test('warning metrics keep SUSPICIOUS distinct and do not count errors as correct', () => {
  const cases = [
    ['SCAM', 'SCAM', 100], ['SCAM', 'SUSPICIOUS', 200], ['SCAM', 'SAFE', 300], ['SCAM', null, 400],
    ['SAFE', 'SAFE', 500], ['SAFE', 'SUSPICIOUS', 600], ['SAFE', 'SCAM', 700], ['SAFE', null, 800],
  ];
  const results = cases.map(([groundTruth, prediction, inferenceDurationMs], index) => ({
    messageId: String(index), groundTruth, prediction, inferenceDurationMs,
    error: prediction === null ? 'OLLAMA_TIMEOUT' : null,
  }));
  const metrics = calculateMetrics(results);
  assert.deepEqual(metrics.threeWayOutputDistribution, { SCAM: 2, SAFE: 2, SUSPICIOUS: 2 });
  assert.equal(metrics.errorCount, 2);
  assert.deepEqual(metrics.errorsByCode, { OLLAMA_TIMEOUT: 2 });
  assert.deepEqual(metrics.scamRecall, { numerator: 2, denominator: 4, value: 0.5 });
  assert.deepEqual(metrics.scamPrecision, { numerator: 2, denominator: 4, value: 0.5 });
  assert.deepEqual(metrics.safeFalsePositiveWarningRate, { numerator: 2, denominator: 3, value: 2 / 3 });
  assert.deepEqual(metrics.binaryAccuracyDecisive, { numerator: 2, denominator: 4, value: 0.5 });
  assert.equal(metrics.totalInferenceDurationMs, 3600);
  assert.deepEqual(metrics.latencyMs, { mean: 450, median: 450, p95: 800 });
  assert.match(metricsToCsv(metrics), /scamRecall,2,4,0\.5/);
  assert.match(metricsToCsv(metrics), /threeWayOutputDistribution\.SUSPICIOUS,,,2/);
  assert.match(metricsToCsv(metrics), /errorsByCode\.OLLAMA_TIMEOUT,,,2/);
  assert.throws(() => calculateMetrics([{ groundTruth: 'SAFE', prediction: 'INVALID', inferenceDurationMs: 1 }]), /Invalid prediction/);
  assert.equal(calculateMetrics([]).scamRecall.value, null);
});

test('checkpoint resumes completed results, removes a partial tail, and rejects mismatches', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'apcida-eval-'));
  try {
    const metadata = { datasetSha256: 'abc', model: 'gemma3:12b', mapping: { textColumn: 'sms', labelColumn: 'label' } };
    const rows = [
      { messageId: '1', groundTruth: 'SAFE', text: 'Private SMS body' },
      { messageId: '2', groundTruth: 'SCAM', text: 'Another private SMS body' },
    ];
    const release = acquireRunLock(directory);
    assert.throws(() => acquireRunLock(directory), /already in use/);
    const first = openCheckpoint(directory, metadata, rows);
    first.append({ messageId: '1', groundTruth: 'SAFE', prediction: 'SAFE', confidence: 'HIGH', rationale: 'Routine reminder.', inferenceDurationMs: 12, error: null });
    assert.throws(() => first.append({ messageId: '1', groundTruth: 'SAFE', prediction: 'SAFE' }), /completed/);
    fs.appendFileSync(first.filePath, '{"type":"result","value":');
    const resumed = openCheckpoint(directory, metadata, rows);
    assert.equal(resumed.completed.size, 1);
    assert.equal(resumed.completed.get('1').prediction, 'SAFE');
    resumed.append({ messageId: '2', groundTruth: 'SCAM', prediction: null, confidence: null, rationale: null, inferenceDurationMs: 50, error: 'OLLAMA_TIMEOUT' });
    assert.equal(openCheckpoint(directory, metadata, rows).completed.size, 2);
    assert.doesNotMatch(fs.readFileSync(first.filePath, 'utf8'), /Private SMS body|Another private SMS body/);
    assert.throws(() => openCheckpoint(directory, { ...metadata, datasetSha256: 'changed' }, rows), /does not match/);
    release();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('baseline checkpoint compatibility accepts only the known earlier classifier hash', () => {
  const current = { datasetSha256: 'same-data', classifierSha256: 'new-baseline-hash', model: 'gemma3:12b' };
  const earlier = { ...current, classifierSha256: 'known-earlier-hash' };
  assert.equal(metadataMatches(earlier, current, ['known-earlier-hash']), true);
  assert.equal(metadataMatches({ ...earlier, datasetSha256: 'changed-data' }, current, ['known-earlier-hash']), false);
  assert.equal(metadataMatches({ ...earlier, classifierSha256: 'unknown-hash' }, current, ['known-earlier-hash']), false);
});

test('CLI mapping and rationale redaction keep raw SMS out of report defaults', () => {
  const options = parseArgs(['--input', './data.csv', '--text-column', 'body', '--label-column', 'truth']);
  assert.equal(options.mapping.textColumn, 'body');
  assert.equal(options.mapping.idColumn, null);
  assert.equal(options.outputDir, path.resolve(__dirname, '../../evaluation-results/baseline-200'));
  assert.throws(() => parseArgs(['--input', 'data.csv']), /Missing required/);
  assert.equal(safeRationale('The text says Claim your prize now.', 'Claim your prize now.'), '[redacted: rationale repeated the SMS text]');
  assert.equal(safeRationale('The text says Claim your prize now.', 'Claim your\nprize now.'), '[redacted: rationale repeated the SMS text]');
});
