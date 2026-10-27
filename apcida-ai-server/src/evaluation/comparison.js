const fs = require('node:fs');
const { createHash } = require('node:crypto');

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function loadComparisonReport(filePath, expectedMode, datasetSha256, rows) {
  if (!filePath) return null;
  const bytes = fs.readFileSync(filePath);
  let report;
  try { report = JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error(`Invalid ${expectedMode} comparison report`); }
  if (report?.metadata?.mode !== expectedMode || report.metadata.datasetSha256 !== datasetSha256
    || report.metadata.rowCount !== rows.length || report.metadata.model !== 'gemma3:12b'
    || !Array.isArray(report.results) || report.results.length !== rows.length) {
    throw new Error(`${expectedMode} comparison report does not match this dataset or model`);
  }
  const expected = new Map(rows.map((row) => [row.messageId, row.groundTruth]));
  const results = new Map();
  for (const result of report.results) {
    if (!expected.has(result.messageId) || expected.get(result.messageId) !== result.groundTruth
      || results.has(result.messageId) || (result.error ? result.prediction != null
        : !['SCAM', 'SAFE', 'SUSPICIOUS'].includes(result.prediction))) {
      throw new Error(`${expectedMode} comparison report contains invalid or mismatched results`);
    }
    results.set(result.messageId, result.prediction);
  }
  return { sha256: sha256(bytes), results };
}

module.exports = { loadComparisonReport };
