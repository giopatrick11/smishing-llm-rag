const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { analyzeRules } = require('../src/services/rules');
const { resolveVerdict } = require('../src/services/verdict');
const { createHybridService } = require('../src/services/hybrid');
const { createRagService } = require('../src/services/rag');
const { createOllamaService } = require('../src/services/ollama');
const { createApp } = require('../src/app');
const { once } = require('node:events');
const { runHybridEvaluation, withRetrievalRetry } = require('../src/evaluation/runHybrid');
const { makeSubset, SEED } = require('../src/evaluation/makeSubset');
const { loadDataset } = require('../src/evaluation/csv');
const { signature, findDuplicate } = require('../src/knowledge/dedupe');

const has = (result, code) => result.matchedIndicators.some((item) => item.code === code);

test('English, Filipino, and Cebuano requests produce structured signals', () => {
  const english = analyzeRules('Bank support: send your OTP now to unlock your account at https://secure-check.xyz/login');
  assert.equal(english.classification, 'SCAM');
  assert.ok(has(english, 'CREDENTIAL_REQUEST'));
  assert.ok(has(english, 'SUSPICIOUS_URL'));
  const filipino = analyzeRules('Nanalo ka ng premyo! Bayad muna ng processing fee para makuha ang gantimpala.');
  assert.equal(filipino.classification, 'SCAM');
  assert.ok(has(filipino, 'ADVANCE_FEE'));
  const cebuano = analyzeRules('Naa kay daog nga premyo. Ipadala ang imong OTP karun aron makuha ang reward.');
  assert.equal(cebuano.classification, 'SCAM');
  assert.ok(has(cebuano, 'CREDENTIAL_REQUEST'));
});

test('ordinary OTP, banking, brand, and harmless link messages stay SAFE', () => {
  for (const message of [
    'Your OTP is 123456. Do not share it with anyone.',
    'Your bank transfer of PHP 1,250 was successful. Reference BQ78102.',
    'Your BDO appointment is tomorrow.',
    'View the event schedule at https://example.com/events.',
  ]) {
    assert.equal(analyzeRules(message).classification, 'SAFE', message);
  }
});

test('duplicate phrases and links cannot inflate a category; caps apply', () => {
  const once = analyzeRules('Send your OTP to bank support now at https://bad.xyz/a');
  const repeated = analyzeRules('Send your OTP OTP OTP to bank support now at https://bad.xyz/a https://bad.xyz/b');
  assert.equal(repeated.score, once.score);
  assert.ok(repeated.phraseScore <= 60);
  assert.ok(repeated.urlScore <= 80);
  assert.equal(repeated.matchedIndicators.filter((item) => item.category === 'url').length, 1);
});

test('shadow policy never overrides Gemma; experimental policy requires independent evidence', () => {
  const strong = analyzeRules('Bank support: send your OTP now at https://secure-check.xyz/login');
  assert.equal(resolveVerdict('SAFE', strong, { shadowMode: true, policy: 'corroborated-warning' }).classification, 'SAFE');
  assert.equal(resolveVerdict('SAFE', strong, { shadowMode: false, policy: 'corroborated-warning' }).classification, 'SUSPICIOUS');
  assert.equal(resolveVerdict('SCAM', analyzeRules('Hello'), { shadowMode: false, policy: 'corroborated-warning' }).classification, 'SCAM');
  assert.equal(resolveVerdict('SAFE', { classification: 'SCAM', matchedIndicators: [{ code: 'CREDENTIAL_REQUEST' }] },
    { shadowMode: false, policy: 'corroborated-warning' }).classification, 'SAFE');
});

test('hybrid shadow response includes rules while retaining Gemma output', async () => {
  const service = createHybridService({ analyze: async () => ({ classification: 'SAFE', confidence: 'LOW', rationale: 'Uncertain.' }) });
  const result = await service.analyze({ text: 'Send your OTP to support now at https://bad.xyz/a' });
  assert.equal(result.classification, 'SAFE');
  assert.equal(result.gemmaClassification, 'SAFE');
  assert.equal(result.rules.classification, 'SCAM');
  assert.equal(result.verdictPolicy, 'shadow');
});

test('API shadow mode exposes rule evidence without changing the production verdict', async () => {
  const config = { host: '127.0.0.1', ollamaUrl: 'http://127.0.0.1:11434', model: 'gemma3:12b',
    apiKey: 'phase2e-test-api-key', requestTimeoutMs: 1000, ragEnabled: false,
    rulesEnabled: true, rulesShadowMode: true, verdictPolicy: 'gemma' };
  const fetchImpl = async () => new Response(JSON.stringify({ message: { content: JSON.stringify({
    classification: 'SAFE', confidence: 'LOW', rationale: 'Uncertain.',
  }) } }));
  const server = createApp(config, { fetchImpl }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/sms/analyze`, {
      method: 'POST', headers: { 'x-api-key': config.apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ messageId: '1', sender: 'Bank', text: 'Send your OTP now at https://bad.xyz/x',
        receivedAt: '2026-10-27T09:00:00+08:00' }),
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.classification, 'SAFE');
    assert.equal(body.gemmaClassification, 'SAFE');
    assert.equal(body.rules.classification, 'SCAM');
    assert.equal(body.verdictPolicy, 'shadow');
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('RAG retrieval error and Ollama timeout propagate instead of returning SAFE', async () => {
  const config = { ollamaUrl: 'http://127.0.0.1:11434', model: 'gemma3:12b', requestTimeoutMs: 1000 };
  const embed = async () => new Response(JSON.stringify({ embeddings: [Array(768).fill(0.01)] }));
  const rag = createRagService(config, { analyze: async () => { throw new Error('should not run'); } },
    { search: async () => { throw new Error('db down'); } }, embed);
  await assert.rejects(rag.analyze({ text: 'hello' }), { code: 'RAG_DATABASE_UNAVAILABLE' });
  const ollama = createOllamaService(config, async () => { throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); });
  await assert.rejects(ollama.analyze({ text: 'hello' }), { code: 'OLLAMA_TIMEOUT' });
});

test('new RAG evaluator retries retrieval once and still exposes a persistent failure', async () => {
  let attempts = 0;
  const recovered = withRetrievalRetry({ search: async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('transient database failure');
    return [{ id: 1 }];
  } }, 0);
  assert.deepEqual(await recovered.search([0.1]), [{ id: 1 }]);
  assert.equal(attempts, 2);
  attempts = 0;
  const failed = withRetrievalRetry({ search: async () => { attempts += 1; throw new Error('database unavailable'); } }, 0);
  await assert.rejects(failed.search([0.1]), /database unavailable/);
  assert.equal(attempts, 2);
});

test('fixed-seed subset is balanced, deterministic, and checked with the production duplicate matcher', () => {
  const original = fs.readFileSync(path.join(__dirname, '../../dataset/apcida_synthetic_sms_200.csv'), 'utf8');
  const first = makeSubset(original, SEED);
  assert.equal(first.output, makeSubset(original, SEED).output);
  const rows = loadDataset(first.output, { idColumn: 'message_id', textColumn: 'sms_text', labelColumn: 'label' });
  assert.equal(rows.length, 50);
  assert.equal(rows.filter((row) => row.groundTruth === 'SCAM').length, 25);
  assert.equal(rows.filter((row) => row.groundTruth === 'SAFE').length, 25);
  const references = [{ id: 'approved-1', signature: signature('Pay the fee to get a prize') }];
  assert.deepEqual(findDuplicate({ signature: signature('Pay the fee to get a prize') }, references),
    { kind: 'EXACT', referenceId: 'approved-1' });
});

test('rules-only evaluation checkpoints and resumes without model access', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'apcida-phase2e-'));
  const input = path.join(directory, 'input.csv');
  const outputDir = path.join(directory, 'report');
  fs.writeFileSync(input, 'message_id,sms_text,label\n1,Ordinary appointment reminder,SAFE\n2,Send your OTP now at https://bad.xyz/x,SCAM\n');
  const options = { mode: 'rules', input, outputDir, pauseMs: 0, shadowMode: true, verdictPolicy: 'gemma',
    mapping: { idColumn: 'message_id', textColumn: 'sms_text', labelColumn: 'label' } };
  try {
    const first = await runHybridEvaluation(options, { print: () => {} });
    assert.equal(first.results.length, 2);
    assert.equal(first.metrics.threeWayExactAccuracy.denominator, 2);
    const resumed = await runHybridEvaluation(options, { print: () => {} });
    assert.deepEqual(resumed.results, first.results);
    assert.equal(fs.readFileSync(path.join(outputDir, 'checkpoint.jsonl'), 'utf8').trim().split('\n').length, 3);
    assert.match(fs.readFileSync(path.join(outputDir, 'evaluation.csv'), 'utf8'), /ruleScore,ruleClassification,matchedIndicators/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('Gemma timeout is checkpointed as an error with no final verdict', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'apcida-phase2e-timeout-'));
  const input = path.join(directory, 'input.csv');
  fs.writeFileSync(input, 'message_id,sms_text,label\n1,Hello,SAFE\n');
  const options = { mode: 'gemma', input, outputDir: path.join(directory, 'report'), pauseMs: 0,
    shadowMode: true, verdictPolicy: 'gemma', mapping: { idColumn: 'message_id', textColumn: 'sms_text', labelColumn: 'label' } };
  try {
    const report = await runHybridEvaluation(options, { print: () => {}, createOllama: () => ({
      status: async () => ({ modelAvailable: true }),
      analyze: async () => { const error = new Error('timeout'); error.code = 'OLLAMA_TIMEOUT';
        // Use the real error class so the evaluator records its public code.
        const { OllamaError } = require('../src/services/ollama');
        throw new OllamaError(error.code, 504); },
    }) });
    assert.equal(report.results[0].prediction, null);
    assert.equal(report.results[0].finalClassification, null);
    assert.equal(report.metrics.errorsByCode.OLLAMA_TIMEOUT, 1);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
