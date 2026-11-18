const test = require('node:test');
const assert = require('node:assert/strict');
const cases = require('./fixtures/rules-regression.json');
const { analyzeRules, RULES_VERSION } = require('../src/services/rules');

test('proposed rule-regression examples retain their intended heuristic outcomes', () => {
  assert.equal(RULES_VERSION, 3);
  for (const item of cases) {
    const result = analyzeRules(item.sms);
    assert.equal(result.classification, item.expectedRules, item.id);
    if (item.expectedIndicator) {
      assert.ok(result.matchedIndicators.some((indicator) => indicator.code === item.expectedIndicator), item.id);
    }
    assert.equal(result.diagnosticCode, result.matchedIndicators.length === 0
      ? 'NO_INDICATORS_MATCHED' : result.score < 30 ? 'BELOW_WARNING_THRESHOLD' : 'INDICATORS_MATCHED', item.id);
  }
});

test('a weak link is distinguished from a message with no matched indicators', () => {
  const weakLink = analyzeRules('View the schedule at https://example.com/events.');
  assert.equal(weakLink.classification, 'SAFE');
  assert.equal(weakLink.diagnosticCode, 'BELOW_WARNING_THRESHOLD');
  assert.equal(analyzeRules('Kita ta ugma.').diagnosticCode, 'NO_INDICATORS_MATCHED');
});
