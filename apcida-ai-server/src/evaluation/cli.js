const path = require('node:path');
const { runEvaluation } = require('./run');
const { runHybridEvaluation, MODES } = require('./runHybrid');
const { baselineOutputDir } = require('../paths');

const HELP = `Usage: npm run evaluate -- --input FILE --text-column NAME --label-column NAME [options]

Required:
  --input FILE               Labeled UTF-8 CSV dataset
  --text-column NAME         SMS text column header
  --label-column NAME        SCAM/SAFE ground-truth column header

Optional:
  --mode MODE                baseline, rag, or a Phase 2E mode (see README)
  --output-dir DIR           Checkpoint and report directory (default: ../evaluation-results/baseline-200)
  --id-column NAME           Stable message ID column (otherwise row-000001, ...)
  --sender-column NAME       Sender column to pass to the classifier
  --received-at-column NAME  ISO 8601 timestamp column to pass to the classifier
  --help                     Show this help
  --pause-ms NUMBER          Pause 0–60000 ms between messages (Phase 2E default: 1000)
  --verdict-policy POLICY    gemma (default), corroborated-warning, or evidence-weighted
  --no-shadow true           Enable experimental verdict policy in hybrid modes
  --compare-gemma-report FILE  Matching Gemma-only evaluation.json for comparison
  --compare-rag-report FILE    Matching Gemma+RAG evaluation.json for comparison

The same command resumes from a matching checkpoint. Inference is sequential.`;

function parseArgs(args) {
  if (args.includes('--help')) return { help: true };
  const allowed = new Set(['--input', '--text-column', '--label-column', '--output-dir', '--id-column', '--sender-column', '--received-at-column', '--mode', '--pause-ms', '--verdict-policy', '--no-shadow', '--compare-gemma-report', '--compare-rag-report']);
  const values = {};
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    if (!allowed.has(flag) || !args[i + 1] || args[i + 1].startsWith('--') || values[flag] != null) {
      throw new Error(`Invalid or duplicate option: ${flag || '(missing)'}`);
    }
    values[flag] = args[i + 1];
  }
  for (const flag of ['--input', '--text-column', '--label-column']) {
    if (!values[flag]) throw new Error(`Missing required option: ${flag}`);
  }
  const mode = values['--mode'] || 'baseline';
  if (!['baseline', 'rag', ...MODES].includes(mode)) throw new Error('Invalid evaluation mode');
  if (mode !== 'baseline' && !values['--output-dir']) throw new Error('This evaluation mode requires a new --output-dir');
  if (mode !== 'baseline' && path.resolve(values['--output-dir']) === baselineOutputDir) {
    throw new Error('This evaluation mode cannot use the baseline output directory');
  }
  const pauseMs = values['--pause-ms'] == null ? 1000 : Number(values['--pause-ms']);
  if (!Number.isInteger(pauseMs) || pauseMs < 0 || pauseMs > 60000) throw new Error('--pause-ms must be 0 to 60000');
  const verdictPolicy = values['--verdict-policy'] || 'gemma';
  if (!['gemma', 'corroborated-warning', 'evidence-weighted'].includes(verdictPolicy)) throw new Error('Invalid verdict policy');
  if (values['--no-shadow'] != null && values['--no-shadow'] !== 'true') throw new Error('--no-shadow must be true');
  return {
    mode,
    pauseMs,
    shadowMode: values['--no-shadow'] !== 'true',
    verdictPolicy,
    compareGemmaReport: values['--compare-gemma-report'] ? path.resolve(values['--compare-gemma-report']) : null,
    compareRagReport: values['--compare-rag-report'] ? path.resolve(values['--compare-rag-report']) : null,
    input: path.resolve(values['--input']),
    outputDir: path.resolve(values['--output-dir'] || baselineOutputDir),
    mapping: {
      textColumn: values['--text-column'],
      labelColumn: values['--label-column'],
      idColumn: values['--id-column'] || null,
      senderColumn: values['--sender-column'] || null,
      receivedAtColumn: values['--received-at-column'] || null,
    },
  };
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(`${HELP}\n`);
      return;
    }
    if (MODES.includes(options.mode)) await runHybridEvaluation(options);
    else await runEvaluation(options);
  } catch (error) {
    process.stderr.write(`Evaluation failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { parseArgs };
