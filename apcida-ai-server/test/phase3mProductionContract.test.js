const test = require('node:test');
const assert = require('node:assert/strict');
const { validateProductionRequest, validateProductionResponse } = require('../src/production/smsContract');
const { createPrivacyCodec } = require('../src/production/privacy');
const { analyzeRules } = require('../src/services/rules');

const messageId = '6d5f9250-3a47-42a8-a06b-68f0b8a82691';
const request = { messageId, sender: 'ManualTest', text: 'Synthetic test SMS',
  receivedAt: '2026-10-28T00:00:00Z' };

test('production contract accepts a matching opaque request ID and valid response', () => {
  assert.deepEqual(validateProductionRequest(request, messageId), request);
  const response = { messageId, classification: 'SCAM', confidence: 'HIGH', rationale: 'Mock warning' };
  assert.deepEqual(validateProductionResponse(response, messageId), response);
});

test('production contract rejects pilot identifiers and unmatched idempotency keys', () => {
  assert.equal(validateProductionRequest({ ...request, messageId: `pilot-${messageId}` },
    `pilot-${messageId}`), null);
  assert.equal(validateProductionRequest(request, 'another-key'), null);
  assert.equal(validateProductionRequest({ ...request, 'x-apcida-pilot-synthetic': true }, messageId), null);
});

test('production contract rejects malformed response and extra fields', () => {
  assert.equal(validateProductionResponse({ messageId, classification: 'SAFE',
    confidence: 'HIGH', rationale: 'Mock', text: request.text }, messageId), null);
  assert.equal(validateProductionResponse({ messageId: 'a7b56576-3f40-43c5-9a27-2be9ac2b6f65',
    classification: 'SAFE', confidence: 'HIGH', rationale: 'Mock' }, messageId), null);
  assert.equal(validateProductionRequest({ ...request, text: '' }, messageId), null);
});

test('synthetic numeric sender masking fits contract but changes request identity', () => {
  const original = { ...request, sender: '+63 917 123 4567' };
  const masked = { ...original, sender: 'PHONE_NUMBER' };
  assert.deepEqual(validateProductionRequest(original, messageId), original);
  assert.deepEqual(validateProductionRequest(masked, messageId), masked);
  const codec = createPrivacyCodec('1a'.repeat(32));
  assert.notEqual(codec.requestHmac(original), codec.requestHmac(masked));
  assert.deepEqual(analyzeRules(original), analyzeRules(masked));
  // Gemma receives sender as context; its verdict impact needs separate paired inference.
});
