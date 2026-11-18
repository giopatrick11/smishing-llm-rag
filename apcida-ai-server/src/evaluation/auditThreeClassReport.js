const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { loadRows, pairedSummary } = require('./threeClassStudy');
const { calculateThreeClassMetrics } = require('./threeClassMetrics');
const { writeAtomic } = require('./checkpoint');
const { projectRoot, evaluationResultsDir } = require('../paths');

const MODES = ['rules', 'gemma', 'gemmaRag', 'shadow'];
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function auditReport(source, rows, datasetSha256) {
  if (source?.metadata?.datasetSha256 !== datasetSha256 || source.metadata.rowCount !== rows.length) {
    throw new Error('Report does not match the source dataset');
  }
  const metrics = {};
  const medianCorrections = {};
  for (const mode of MODES) {
    const results = source.results?.[mode];
    if (!Array.isArray(results) || results.length !== rows.length) {
      throw new Error(`Missing or incomplete ${mode} results`);
    }
    for (let index = 0; index < rows.length; index += 1) {
      const result = results[index];
      if (result?.messageId !== rows[index].messageId
        || result.groundTruth !== rows[index].groundTruth
        || Object.hasOwn(result, 'text') || Object.hasOwn(result, 'sms')
        || Object.hasOwn(result, 'rationale')) {
        throw new Error(`Mismatched or sensitive ${mode} result`);
      }
    }
    metrics[mode] = calculateThreeClassMetrics(results);
    if (source.metrics?.[mode]?.latencyMs?.median !== metrics[mode].latencyMs.median) {
      medianCorrections[mode] = { original: source.metrics?.[mode]?.latencyMs?.median ?? null,
        corrected: metrics[mode].latencyMs.median };
    }
  }
  metrics.shadow.ruleDisagreements = source.results.shadow.filter((row) =>
    !row.error && row.ruleClassification !== row.prediction).length;
  return { sourceMetadata: source.metadata, metrics,
    pairedGemmaRag: pairedSummary(source.results.gemma, source.results.gemmaRag),
    medianCorrections };
}

function main() {
  const reportPath = path.join(evaluationResultsDir, 'three-class-exploratory-v1/report.json');
  const datasetPath = path.join(projectRoot, 'dataset/apcida_three_class_exploratory_v1.json');
  const sourceBytes = fs.readFileSync(reportPath);
  const { rows, datasetSha256 } = loadRows(datasetPath);
  const audited = auditReport(JSON.parse(sourceBytes.toString('utf8')), rows, datasetSha256);
  const outputPath = path.join(path.dirname(reportPath), 'audited-report.json');
  const result = { ...audited,
    provenance: { sourceReportSha256: sha256(sourceBytes),
      auditPipelineSha256: sha256(Buffer.concat([__filename, './threeClassMetrics.js',
        './threeClassStudy.js'].map((file) => fs.readFileSync(path.resolve(__dirname, file))))) } };
  writeAtomic(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`Audited metrics written to ${outputPath}; median corrections: ${JSON.stringify(audited.medianCorrections)}\n`);
}

if (require.main === module) {
  try { main(); }
  catch (error) {
    process.stderr.write(`Three-class report audit failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { auditReport };
