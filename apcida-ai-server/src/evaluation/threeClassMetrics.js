const LABELS = ['SAFE', 'SUSPICIOUS', 'SCAM'];

function rate(numerator, denominator) {
  return { numerator, denominator, value: denominator ? numerator / denominator : null };
}

function percentile(sorted, proportion) {
  return sorted.length ? sorted[Math.ceil(proportion * sorted.length) - 1] : null;
}

function median(sorted) {
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function calculateThreeClassMetrics(results) {
  const confusionMatrix = Object.fromEntries(LABELS.map((label) => [label,
    { SAFE: 0, SUSPICIOUS: 0, SCAM: 0, ERROR: 0 }]));
  const errorsByCode = {};
  const durations = [];
  let exactCorrect = 0;
  let warningsOnSafe = 0;
  let validSafe = 0;
  for (const result of results) {
    if (!LABELS.includes(result.groundTruth) || !Number.isFinite(result.inferenceDurationMs)
      || result.inferenceDurationMs < 0) throw new Error('Invalid evaluation result');
    durations.push(result.inferenceDurationMs);
    if (result.error) {
      if (result.prediction != null) throw new Error('Error cannot have a prediction');
      errorsByCode[result.error] = (errorsByCode[result.error] || 0) + 1;
      confusionMatrix[result.groundTruth].ERROR += 1;
      continue;
    }
    if (!LABELS.includes(result.prediction)) throw new Error('Invalid prediction');
    confusionMatrix[result.groundTruth][result.prediction] += 1;
    if (result.groundTruth === result.prediction) exactCorrect += 1;
    if (result.groundTruth === 'SAFE') {
      validSafe += 1;
      if (result.prediction !== 'SAFE') warningsOnSafe += 1;
    }
  }
  const perClass = {};
  for (const label of LABELS) {
    const tp = confusionMatrix[label][label];
    const support = Object.values(confusionMatrix[label]).reduce((sum, count) => sum + count, 0);
    const predicted = LABELS.reduce((sum, truth) => sum + confusionMatrix[truth][label], 0);
    const precision = rate(tp, predicted);
    const recall = rate(tp, support);
    const f1 = support === 0 ? null : precision.value == null || recall.value === 0
      ? 0 : (2 * precision.value * recall.value) / (precision.value + recall.value);
    perClass[label] = { support, precision, recall, f1 };
  }
  const f1Values = LABELS.map((label) => perClass[label].f1).filter((value) => value !== null);
  const scamWarningRecall = rate(confusionMatrix.SCAM.SCAM + confusionMatrix.SCAM.SUSPICIOUS,
    perClass.SCAM.support);
  durations.sort((a, b) => a - b);
  return {
    totalRows: results.length,
    validPredictionCount: results.length - Object.values(errorsByCode).reduce((sum, n) => sum + n, 0),
    errorsByCode,
    confusionMatrix,
    exactAccuracy: rate(exactCorrect, results.length),
    perClass,
    macroF1: f1Values.length ? f1Values.reduce((sum, value) => sum + value, 0) / f1Values.length : null,
    scamPrecision: perClass.SCAM.precision,
    scamRecall: perClass.SCAM.recall,
    scamWarningRecall,
    safeFalsePositiveWarningRate: rate(warningsOnSafe, validSafe),
    latencyMs: { mean: durations.length ? durations.reduce((sum, n) => sum + n, 0) / durations.length : null,
      median: median(durations), p90: percentile(durations, 0.9),
      p95: percentile(durations, 0.95) },
  };
}

module.exports = { calculateThreeClassMetrics, LABELS };
