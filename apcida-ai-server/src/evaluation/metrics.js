const PREDICTIONS = ['SCAM', 'SAFE', 'SUSPICIOUS'];

function fraction(numerator, denominator) {
  return { numerator, denominator, value: denominator === 0 ? null : numerator / denominator };
}

function median(sorted) {
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function calculateMetrics(results) {
  const distribution = { SCAM: 0, SAFE: 0, SUSPICIOUS: 0 };
  const errorsByCode = {};
  let scamTotal = 0;
  let scamWarned = 0;
  let safeEvaluable = 0;
  let safeWarned = 0;
  let warned = 0;
  let decisive = 0;
  let decisiveCorrect = 0;
  let exactCorrect = 0;
  let exactScamTruePositive = 0;
  let predictedScam = 0;
  const confusionMatrix = {
    SCAM: { SCAM: 0, SAFE: 0, SUSPICIOUS: 0, ERROR: 0 },
    SAFE: { SCAM: 0, SAFE: 0, SUSPICIOUS: 0, ERROR: 0 },
  };
  const durations = [];

  for (const result of results) {
    if (!['SCAM', 'SAFE'].includes(result.groundTruth)) throw new Error('Invalid ground truth in evaluation result');
    if (!Number.isFinite(result.inferenceDurationMs) || result.inferenceDurationMs < 0) {
      throw new Error('Invalid inference duration in evaluation result');
    }
    durations.push(result.inferenceDurationMs);
    if (result.groundTruth === 'SCAM') scamTotal += 1;

    if (result.error) {
      if (result.prediction != null) throw new Error('An errored result cannot also have a prediction');
      errorsByCode[result.error] = (errorsByCode[result.error] || 0) + 1;
      confusionMatrix[result.groundTruth].ERROR += 1;
      continue;
    }
    if (!PREDICTIONS.includes(result.prediction)) throw new Error('Invalid prediction in evaluation result');
    distribution[result.prediction] += 1;
    confusionMatrix[result.groundTruth][result.prediction] += 1;
    if (result.prediction === result.groundTruth) exactCorrect += 1;
    if (result.prediction === 'SCAM') {
      predictedScam += 1;
      if (result.groundTruth === 'SCAM') exactScamTruePositive += 1;
    }
    const isWarning = result.prediction !== 'SAFE';
    if (isWarning) warned += 1;
    if (result.groundTruth === 'SCAM' && isWarning) scamWarned += 1;
    if (result.groundTruth === 'SAFE') {
      safeEvaluable += 1;
      if (isWarning) safeWarned += 1;
    }
    if (result.prediction !== 'SUSPICIOUS') {
      decisive += 1;
      if (result.prediction === result.groundTruth) decisiveCorrect += 1;
    }
  }

  durations.sort((a, b) => a - b);
  const totalInferenceDurationMs = durations.reduce((sum, duration) => sum + duration, 0);
  const errorCount = Object.values(errorsByCode).reduce((sum, count) => sum + count, 0);
  return {
    totalRows: results.length,
    validPredictionCount: results.length - errorCount,
    errorCount,
    errorsByCode,
    threeWayOutputDistribution: distribution,
    confusionMatrix,
    threeWayExactAccuracy: fraction(exactCorrect, results.length),
    scamClassRecall: fraction(exactScamTruePositive, scamTotal),
    scamClassPrecision: fraction(exactScamTruePositive, predictedScam),
    scamRecall: fraction(scamWarned, scamTotal),
    scamPrecision: fraction(scamWarned, warned),
    safeFalsePositiveWarningRate: fraction(safeWarned, safeEvaluable),
    binaryAccuracyDecisive: fraction(decisiveCorrect, decisive),
    totalInferenceDurationMs,
    latencyMs: durations.length === 0 ? { mean: null, median: null, p95: null } : {
      mean: totalInferenceDurationMs / durations.length,
      median: median(durations),
      p95: durations[Math.ceil(0.95 * durations.length) - 1],
    },
  };
}

module.exports = { calculateMetrics };
