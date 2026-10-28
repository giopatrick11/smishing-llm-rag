/** One wall-clock budget for the production inference chain. */
function startAnalysisDeadline(analyzer, sms, remainingMs) {
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
    throw new TypeError('A positive remaining inference deadline is required');
  }
  const controller = new AbortController();
  let timer;
  const settled = Promise.resolve().then(() => analyzer.analyze(sms, { signal: controller.signal }))
    .then((value) => ({ kind: 'RESULT', value }), (error) => ({ kind: 'ERROR', error }));
  const expired = new Promise((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ kind: 'DEADLINE' });
    }, remainingMs);
  });
  const outcome = Promise.race([settled, expired]).finally(() => clearTimeout(timer));
  return { outcome, settled, signal: controller.signal,
    cancel: () => controller.abort() };
}

module.exports = { startAnalysisDeadline };
