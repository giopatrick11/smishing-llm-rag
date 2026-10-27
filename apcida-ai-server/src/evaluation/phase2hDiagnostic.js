const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { datasetDir, evaluationResultsDir } = require('../paths');
const { parseCsv, loadDataset } = require('./csv');
const { verifyFreeze } = require('./phase2g');
const { runHybridEvaluation } = require('./runHybrid');
const { createOllamaService } = require('../services/ollama');
const { acquireRunLock } = require('./checkpoint');

const holdoutPath = path.join(datasetDir, 'apcida_synthetic_sms_50_holdout_phase2f.csv');
const subsetPath = path.join(datasetDir, 'apcida_phase2h_timeout_diagnostic_2.csv');
const outputDir = path.join(evaluationResultsDir, 'phase2h-sleep-diagnostic-2');
const manifestPath = path.join(evaluationResultsDir, 'phase2g-freeze.json');
const mapping = { textColumn: 'sms_text', labelColumn: 'label', idColumn: 'message_id',
  senderColumn: null, receivedAtColumn: null };
const targetIds = ['SF016', 'SF046'];
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const escapeCsv = (value) => /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;

function prepareSubset() {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const holdoutBytes = fs.readFileSync(holdoutPath);
  if (sha256(holdoutBytes) !== manifest.frozen?.datasetSha256?.holdout) {
    throw new Error('Frozen Phase 2G holdout hash mismatch');
  }
  const records = parseCsv(holdoutBytes.toString('utf8'));
  const headers = records[0];
  const indexes = ['message_id', 'sms_text', 'label'].map((name) => headers.indexOf(name));
  if (indexes.includes(-1)) throw new Error('Holdout columns are missing');
  const selected = targetIds.map((id) => {
    const matches = records.slice(1).filter((record) => record[indexes[0]] === id);
    if (matches.length !== 1 || matches[0][indexes[2]] !== 'SAFE') {
      throw new Error(`Expected one frozen SAFE row for ${id}`);
    }
    return indexes.map((index) => matches[0][index]);
  });
  const expected = [
    ['message_id', 'sms_text', 'label'], ...selected,
  ].map((record) => record.map(escapeCsv).join(',')).join('\n') + '\n';
  if (fs.existsSync(subsetPath)) {
    if (fs.readFileSync(subsetPath, 'utf8') !== expected) {
      throw new Error('Phase 2H subset differs from the frozen holdout');
    }
  } else {
    fs.writeFileSync(subsetPath, expected, { flag: 'wx' });
  }
  const rows = loadDataset(expected, mapping);
  if (rows.length !== 2 || rows.some((row, i) => row.messageId !== targetIds[i]
    || row.text !== selected[i][1] || row.groundTruth !== 'SAFE')) {
    throw new Error('Phase 2H subset validation failed');
  }
  return { rows, holdoutSha256: sha256(holdoutBytes), subsetSha256: sha256(expected) };
}

function eventLogger(file) {
  const startedWall = Date.now();
  const startedMono = performance.now();
  return (event, details = {}) => {
    const entry = { event, at: new Date().toISOString(),
      wallElapsedMs: Date.now() - startedWall,
      monotonicElapsedMs: Math.round(performance.now() - startedMono), ...details };
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  };
}

async function run() {
  const { rows, holdoutSha256, subsetSha256 } = prepareSubset();
  const release = acquireRunLock(path.join(evaluationResultsDir, 'phase2g-control'));
  try {
    const frozen = await verifyFreeze();
    fs.mkdirSync(outputDir, { recursive: true });
    if (['checkpoint.jsonl', 'evaluation.json', 'diagnostic-events.jsonl'].some((name) =>
      fs.existsSync(path.join(outputDir, name)))) {
      throw new Error('Phase 2H diagnostic output already exists; choose a fresh run before evaluating again');
    }
    const log = eventLogger(path.join(outputDir, 'diagnostic-events.jsonl'));
    const idsByText = new Map(rows.map((row) => [row.text, row.messageId]));
    log('run_start', { holdoutSha256, subsetSha256, model: frozen.evaluation.model,
      requestTimeoutMs: frozen.evaluation.requestTimeoutMs, mode: 'gemma-rag', rowCount: 2 });
    try {
      const report = await runHybridEvaluation({ input: subsetPath, outputDir, mapping, mode: 'gemma-rag',
        pauseMs: 1000, shadowMode: true, verdictPolicy: 'gemma' }, {
        print: (line) => {
          log('runner', { message: line });
          process.stdout.write(`${new Date().toISOString()} ${line}\n`);
        },
        createOllama: (config) => {
          const ollama = createOllamaService(config);
          return {
            status: (...args) => ollama.status(...args),
            async analyze(sms, examples) {
              const messageId = idsByText.get(sms.text);
              const started = performance.now();
              log('chat_start', { messageId, retrievedCount: examples.length });
              try {
                const result = await ollama.analyze(sms, examples);
                log('chat_end', { messageId, durationMs: Math.round(performance.now() - started) });
                return result;
              } catch (error) {
                log('chat_error', { messageId, durationMs: Math.round(performance.now() - started),
                  code: error.code || error.name });
                throw error;
              }
            },
          };
        },
      });
      log('run_end', { errorCount: report.metrics.errorCount });
    } catch (error) {
      log('run_error', { code: error.code || error.name });
      throw error;
    }
  } finally { release(); }
}

function compare() {
  const diagnostic = JSON.parse(fs.readFileSync(path.join(outputDir, 'evaluation.json'), 'utf8'));
  if (diagnostic.metadata.mode !== 'gemma-rag' || diagnostic.metadata.rowCount !== 2) {
    throw new Error('Unexpected Phase 2H diagnostic report');
  }
  const original = Object.fromEntries(['gemma', 'gemma-rag', 'hybrid-rag'].map((name) => [name,
    JSON.parse(fs.readFileSync(path.join(evaluationResultsDir, `phase2g-${name}`, 'evaluation.json'), 'utf8'))]));
  for (const id of targetIds) {
    const values = Object.fromEntries([...Object.entries(original), ['phase2h-gemma-rag', diagnostic]]
      .map(([name, report]) => {
        const row = report.results.find((item) => item.messageId === id);
        return [name, { prediction: row?.prediction ?? null, error: row?.error ?? null,
          durationMs: row?.inferenceDurationMs ?? null }];
      }));
    process.stdout.write(`${id} ${JSON.stringify(values)}\n`);
  }
}

async function main() {
  if (process.argv.length !== 3) throw new Error('Use prepare, run, or compare');
  if (process.argv[2] === 'prepare') {
    const subset = prepareSubset();
    process.stdout.write(`Verified ${subset.rows.length} frozen holdout messages in ${subsetPath}\n`);
  } else if (process.argv[2] === 'run') await run();
  else if (process.argv[2] === 'compare') compare();
  else throw new Error('Use prepare, run, or compare');
}

if (require.main === module) main().catch((error) => {
  process.stderr.write(`Phase 2H diagnostic failed: ${error.message}\n`);
  process.exitCode = 1;
});

module.exports = { prepareSubset, eventLogger };
