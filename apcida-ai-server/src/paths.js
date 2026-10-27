const path = require('node:path');

const projectRoot = path.resolve(__dirname, '../..');
const datasetDir = path.join(projectRoot, 'dataset');
const evaluationResultsDir = path.join(projectRoot, 'evaluation-results');
const baselineOutputDir = path.join(evaluationResultsDir, 'baseline-200');

module.exports = { projectRoot, datasetDir, evaluationResultsDir, baselineOutputDir };
