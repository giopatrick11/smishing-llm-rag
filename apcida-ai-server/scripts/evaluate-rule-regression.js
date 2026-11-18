const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { loadDataset } = require('../src/evaluation/csv');
const { analyzeRules, RULES_VERSION } = require('../src/services/rules');

// Keep the original Phase 2G rules as the comparison point after this change is committed.
const BASELINE_COMMIT = '1f3e09bc2c2685647aa47bd9f27fc24445e72b8a';
const RULES_PATH = 'apcida-ai-server/src/services/rules.js';
const root = path.resolve(__dirname, '../..');
const outputDir = path.join(root, 'evaluation-results/rules-v3-targeted-regression');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

const baselineSource = execFileSync('git', ['show', `${BASELINE_COMMIT}:${RULES_PATH}`],
  { cwd: root, encoding: 'utf8' });
const baselineModule = { exports: {} };
vm.runInNewContext(baselineSource, { module: baselineModule, URL }, { filename: 'rules-v2-baseline.js' });
const baselineRules = baselineModule.exports.analyzeRules;
const cases = require('../test/fixtures/rules-regression.json');

function targetedPredictions(analyze) {
  return cases.map(({ id, proposedLabel, sms }) => {
    const result = analyze(sms);
    return { id, proposedLabel, classification: result.classification, score: result.score,
      indicators: result.matchedIndicators.map((indicator) => indicator.code) };
  });
}

function targetedTotals(rows) {
  return {
    proposedWarningsDetected: rows.filter((row) => row.proposedLabel !== 'SAFE' && row.classification !== 'SAFE').length,
    proposedWarningsTotal: rows.filter((row) => row.proposedLabel !== 'SAFE').length,
    proposedSafeFlagged: rows.filter((row) => row.proposedLabel === 'SAFE' && row.classification !== 'SAFE').length,
    proposedSafeTotal: rows.filter((row) => row.proposedLabel === 'SAFE').length,
    exactThreeClassAgreement: rows.filter((row) => row.proposedLabel === row.classification).length,
  };
}

const targetedBefore = targetedPredictions(baselineRules);
const targetedAfter = targetedPredictions(analyzeRules);
const targeted = {
  title: 'Rules v3 targeted regression comparison',
  note: 'Synthetic, hand-picked cases with proposed labels. Not a held-out accuracy estimate or a Gemma/RAG evaluation.',
  baseline: { commit: BASELINE_COMMIT, rulesVersion: baselineModule.exports.RULES_VERSION,
    sha256: sha256(baselineSource), totals: targetedTotals(targetedBefore) },
  candidate: { rulesVersion: RULES_VERSION,
    sha256: sha256(fs.readFileSync(path.join(root, RULES_PATH))), totals: targetedTotals(targetedAfter) },
  cases: cases.map((item, index) => ({ id: item.id, proposedLabel: item.proposedLabel,
    baseline: targetedBefore[index], candidate: targetedAfter[index] })),
};

const input = fs.readFileSync(path.join(root, 'dataset/apcida_synthetic_sms_50_development.csv'), 'utf8');
const rows = loadDataset(input, { idColumn: 'message_id', textColumn: 'sms_text', labelColumn: 'label' });
function developmentPredictions(analyze) {
  return rows.map((row) => ({ id: row.messageId, label: row.groundTruth,
    classification: analyze(row.text).classification }));
}
function developmentTotals(predictions) {
  return {
    rows: predictions.length,
    scamClassifiedScam: predictions.filter((row) => row.label === 'SCAM' && row.classification === 'SCAM').length,
    scamFlagged: predictions.filter((row) => row.label === 'SCAM' && row.classification !== 'SAFE').length,
    safeClassifiedScam: predictions.filter((row) => row.label === 'SAFE' && row.classification === 'SCAM').length,
    safeFlagged: predictions.filter((row) => row.label === 'SAFE' && row.classification !== 'SAFE').length,
    exactAgreement: predictions.filter((row) => row.label === row.classification).length,
  };
}
const developmentBefore = developmentPredictions(baselineRules);
const developmentAfter = developmentPredictions(analyzeRules);
const development = {
  title: 'Rules v3 development-set comparison',
  note: 'Previously inspected synthetic development set (25 SCAM, 25 SAFE). Not a held-out or production accuracy estimate. No Gemma or RAG calls.',
  datasetSha256: sha256(input),
  baseline: developmentTotals(developmentBefore),
  candidate: developmentTotals(developmentAfter),
  changes: developmentBefore.flatMap((row, index) => row.classification === developmentAfter[index].classification
    ? [] : [{ id: row.id, label: row.label, from: row.classification, to: developmentAfter[index].classification }]),
};

fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(path.join(outputDir, 'report.json'), `${JSON.stringify(targeted, null, 2)}\n`);
fs.writeFileSync(path.join(outputDir, 'development-report.json'), `${JSON.stringify(development, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ targeted: { baseline: targeted.baseline.totals,
  candidate: targeted.candidate.totals }, development: { baseline: development.baseline,
  candidate: development.candidate, changes: development.changes } }, null, 2)}\n`);
