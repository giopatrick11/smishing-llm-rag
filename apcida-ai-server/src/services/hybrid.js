const { analyzeRules } = require('./rules');
const { resolveVerdict } = require('./verdict');

function createHybridService(analysisService, { shadowMode = true, verdictPolicy = 'gemma' } = {}) {
  return {
    async analyze(sms, options = {}) {
      const rules = analyzeRules(sms);
      const gemma = await analysisService.analyze(sms, options);
      const verdict = resolveVerdict(gemma.classification, rules, {
        shadowMode, policy: verdictPolicy, gemmaConfidence: gemma.confidence, ragContext: gemma.ragContext,
      });
      return {
        ...gemma,
        classification: verdict.classification,
        gemmaClassification: gemma.classification,
        rules,
        verdictPolicy: verdict.policy,
      };
    },
  };
}

module.exports = { createHybridService };
