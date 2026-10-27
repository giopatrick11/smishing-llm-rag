const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { analyzeRules } = require('../src/services/rules');
const { resolveVerdict, strongRagSupport } = require('../src/services/verdict');
const { summarizeContext, createRagService } = require('../src/services/rag');
const { buildDevelopmentSet } = require('../src/evaluation/makeDevelopmentSet');
const { buildHoldoutSet } = require('../src/evaluation/makeHoldoutSet');
const { loadDataset } = require('../src/evaluation/csv');
const { loadComparisonReport } = require('../src/evaluation/comparison');
const { runHybridEvaluation } = require('../src/evaluation/runHybrid');

const mapping = { idColumn: 'message_id', textColumn: 'sms_text', labelColumn: 'label' };

test('expanded rules detect risky requests across missed scam categories', () => {
  const cases = [
    ['SIM code', 'Gikan sa mobile network kami. I-submit ang SMS verification code para sa SIM reactivation.', 'CREDENTIAL_REQUEST'],
    ['family emergency', 'I am your sister on a new number. I need money urgently; do not call my old phone.', 'FAMILY_IDENTITY_CLAIM'],
    ['gift cards', 'I am your manager. Buy gift cards and send me the codes immediately.', 'GIFT_CARD_REQUEST'],
    ['APK', 'This is bank support. Open the APK attachment to restore your banking app.', 'UNSAFE_APP_INSTALL'],
    ['government payment', 'A court agent says pay your traffic fine to this personal wallet today.', 'GOVERNMENT_PAYMENT_CLAIM'],
    ['scholarship', 'Your scholarship will be forfeited unless you share your banking login.', 'JOB_OR_SCHOLARSHIP_CLAIM'],
    ['recruitment', 'HR is hiring. Pay an upfront registration fee to apply for the job.', 'JOB_OR_SCHOLARSHIP_CLAIM'],
    ['phishing form', 'Your payroll failed. Enter banking credentials at https://staff-verify.example.invalid.', 'CREDENTIAL_FORM_REQUEST'],
    ['Cebuano fee', 'Nakadaug ka og reward. Bayri una ang processing fee aron makuha ang premyo.', 'ADVANCE_FEE'],
    ['Filipino payment', 'May multa ka sa traffic. Bayaran sa personal wallet account ngayon.', 'PERSONAL_PAYMENT_REQUEST'],
  ];
  for (const [name, message, code] of cases) {
    const result = analyzeRules(message);
    assert.notEqual(result.classification, 'SAFE', `${name}: ${result.score}`);
    assert.ok(result.matchedIndicators.some((item) => item.code === code), name);
  }
});

test('ordinary OTP and security alerts need stronger evidence', () => {
  for (const message of [
    'Your OTP is 123456. Do not share this code with anyone.',
    'Ang imong OTP kay 427619. Ayaw kini ihatag bisan kinsa.',
    'Enter this OTP in the official bank app to complete your login.',
    'Your bank transfer succeeded. Reference AB12345.',
    'Security alert: New device signed in. Review activity in the official app if unrecognized.',
    'We noticed unusual sign-in activity. Open your official banking app to review.',
  ]) assert.equal(analyzeRules(message).classification, 'SAFE', message);
});

test('evidence-weighted verdict uses score, independent indicators, confidence, and RAG support', () => {
  const strong = analyzeRules('We are from the mobile network. Reply with your SMS code for SIM reactivation.');
  assert.equal(strong.classification, 'SCAM');
  assert.equal(resolveVerdict('SUSPICIOUS', strong, { policy: 'evidence-weighted', shadowMode: true,
    gemmaConfidence: 'LOW' }).classification, 'SUSPICIOUS');
  const upgraded = resolveVerdict('SUSPICIOUS', strong, { policy: 'evidence-weighted', shadowMode: false,
    gemmaConfidence: 'LOW' });
  assert.equal(upgraded.classification, 'SCAM');
  assert.equal(upgraded.reason, 'CORROBORATED_CREDENTIAL_DISCLOSURE');
  assert.equal(resolveVerdict('SUSPICIOUS', strong, { policy: 'evidence-weighted', shadowMode: false,
    gemmaConfidence: 'HIGH' }).classification, 'SUSPICIOUS');
  const context = { retrievedCount: 2, topScamSimilarity: 0.89, topSafeSimilarity: 0.74 };
  assert.equal(strongRagSupport(context), true);
  assert.equal(resolveVerdict('SUSPICIOUS', strong, { policy: 'evidence-weighted', shadowMode: false,
    gemmaConfidence: 'HIGH', ragContext: context }).classification, 'SCAM');
  assert.equal(resolveVerdict('SCAM', analyzeRules('Hello'), { policy: 'evidence-weighted',
    shadowMode: false, gemmaConfidence: 'LOW' }).classification, 'SCAM');
  const weak = analyzeRules('Your OTP is 123456. Do not share it.');
  assert.equal(resolveVerdict('SAFE', weak, { policy: 'evidence-weighted', shadowMode: false,
    gemmaConfidence: 'LOW', ragContext: context }).classification, 'SAFE');
});

test('RAG context summary contains similarities and labels only', () => {
  const context = summarizeContext([
    { label: 'SCAM', similarity: 0.91, content: 'Private reference SMS' },
    { label: 'SAFE', similarity: 0.78, content: 'Another private SMS' },
  ]);
  assert.deepEqual(context, { retrievedCount: 2, topScamSimilarity: 0.91, topSafeSimilarity: 0.78 });
  assert.doesNotMatch(JSON.stringify(context), /Private reference SMS/);
});

test('RAG analysis can expose retrieval metadata without reference text', async () => {
  const config = { ollamaUrl: 'http://127.0.0.1:11434', model: 'gemma3:12b', requestTimeoutMs: 1000 };
  const service = createRagService(config, { analyze: async () => ({
    classification: 'SUSPICIOUS', confidence: 'MEDIUM', rationale: 'Needs review.',
  }) }, { search: async () => [{ label: 'SCAM', similarity: 0.88, content: 'Private example' }] },
  async () => new Response(JSON.stringify({ embeddings: [Array(768).fill(0.01)] })),
  { includeContext: true });
  const result = await service.analyze({ text: 'Example message' });
  assert.deepEqual(result.ragContext, { retrievedCount: 1, topScamSimilarity: 0.88, topSafeSimilarity: 0 });
  assert.doesNotMatch(JSON.stringify(result), /Private example/);
});

test('development set is deterministic, balanced, and disjoint from untouched evaluation rows', () => {
  const original = fs.readFileSync(path.join(__dirname, '../../dataset/apcida_synthetic_sms_200.csv'), 'utf8');
  const holdout = fs.readFileSync(path.join(__dirname, '../../dataset/apcida_synthetic_sms_50.csv'), 'utf8');
  const result = buildDevelopmentSet(original, holdout);
  assert.equal(result.output, buildDevelopmentSet(original, holdout).output);
  const development = loadDataset(result.output, mapping);
  const evaluationIds = new Set(loadDataset(holdout, mapping).map((row) => row.messageId));
  assert.equal(development.length, 50);
  assert.equal(development.filter((row) => row.groundTruth === 'SCAM').length, 25);
  assert.equal(development.filter((row) => row.groundTruth === 'SAFE').length, 25);
  assert.ok(development.every((row) => !evaluationIds.has(row.messageId)));
});

test('new holdout remains disjoint from both inspected sets', () => {
  const original = fs.readFileSync(path.join(__dirname, '../../dataset/apcida_synthetic_sms_200.csv'), 'utf8');
  const evaluation = fs.readFileSync(path.join(__dirname, '../../dataset/apcida_synthetic_sms_50.csv'), 'utf8');
  const development = fs.readFileSync(path.join(__dirname, '../../dataset/apcida_synthetic_sms_50_development.csv'), 'utf8');
  const holdout = loadDataset(buildHoldoutSet(original, evaluation, development).output, mapping);
  const inspected = new Set([...loadDataset(evaluation, mapping), ...loadDataset(development, mapping)]
    .map((row) => row.messageId));
  assert.equal(holdout.length, 50);
  assert.equal(holdout.filter((row) => row.groundTruth === 'SCAM').length, 25);
  assert.equal(holdout.filter((row) => row.groundTruth === 'SAFE').length, 25);
  assert.ok(holdout.every((row) => !inspected.has(row.messageId)));
});

test('comparison input rejects a different dataset and keeps original report read only', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'apcida-phase2f-compare-'));
  const file = path.join(directory, 'evaluation.json');
  const rows = [{ messageId: '1', groundTruth: 'SCAM' }];
  const report = { metadata: { mode: 'gemma', datasetSha256: 'abc', rowCount: 1, model: 'gemma3:12b' },
    results: [{ messageId: '1', groundTruth: 'SCAM', prediction: 'SCAM', error: null }] };
  try {
    fs.writeFileSync(file, JSON.stringify(report));
    assert.throws(() => loadComparisonReport(file, 'gemma', 'wrong', rows), /does not match/);
    assert.equal(loadComparisonReport(file, 'gemma', 'abc', rows).results.get('1'), 'SCAM');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).results[0].prediction, 'SCAM');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('experimental evaluation records correction and separate per-message comparison', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'apcida-phase2f-eval-'));
  const input = path.join(directory, 'input.csv');
  const comparison = path.join(directory, 'gemma.json');
  const outputDir = path.join(directory, 'experimental');
  const inputBytes = Buffer.from('message_id,sms_text,label\n1,We are from the mobile network. Reply with your SMS code for SIM reactivation.,SCAM\n');
  fs.writeFileSync(input, inputBytes);
  fs.writeFileSync(comparison, JSON.stringify({ metadata: {
    mode: 'gemma', datasetSha256: createHash('sha256').update(inputBytes).digest('hex'), rowCount: 1,
    model: 'gemma3:12b',
  }, results: [{ messageId: '1', groundTruth: 'SCAM', prediction: 'SUSPICIOUS', error: null }] }));
  const options = { mode: 'rules-gemma', input, outputDir, pauseMs: 0, shadowMode: false,
    verdictPolicy: 'evidence-weighted', compareGemmaReport: comparison, mapping };
  try {
    const report = await runHybridEvaluation(options, { print: () => {}, createOllama: () => ({
      status: async () => ({ modelAvailable: true }),
      analyze: async () => ({ classification: 'SUSPICIOUS', confidence: 'LOW', rationale: 'Uncertain.' }),
    }) });
    const result = report.results[0];
    assert.equal(result.gemmaClassification, 'SUSPICIOUS');
    assert.equal(result.hybridClassification, 'SCAM');
    assert.equal(result.correctedError, true);
    assert.equal(result.introducedError, false);
    assert.equal(report.metrics.hybridComparison.corrected, 1);
    assert.match(fs.readFileSync(path.join(outputDir, 'comparison.csv'), 'utf8'), /correctedError,introducedError/);
    const resumed = await runHybridEvaluation(options, { print: () => {}, createOllama: () => ({
      status: async () => { throw new Error('should not call Ollama'); },
    }) });
    assert.deepEqual(resumed.results, report.results);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('experimental evaluation marks a newly introduced warning error', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'apcida-phase2f-introduced-'));
  const input = path.join(directory, 'input.csv');
  fs.writeFileSync(input, 'message_id,sms_text,label\n1,We are from bank support. Send your OTP immediately.,SAFE\n');
  const options = { mode: 'rules-gemma', input, outputDir: path.join(directory, 'report'), pauseMs: 0,
    shadowMode: false, verdictPolicy: 'evidence-weighted', mapping };
  try {
    const report = await runHybridEvaluation(options, { print: () => {}, createOllama: () => ({
      status: async () => ({ modelAvailable: true }),
      analyze: async () => ({ classification: 'SAFE', confidence: 'LOW', rationale: 'No known fraud.' }),
    }) });
    assert.equal(report.results[0].hybridClassification, 'SUSPICIOUS');
    assert.equal(report.results[0].introducedError, true);
    assert.equal(report.metrics.hybridComparison.introduced, 1);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
