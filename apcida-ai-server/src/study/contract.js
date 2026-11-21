const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const HASH = /^[0-9a-f]{64}$/iu;
const SUGGESTIONS = new Set(['SCAM', 'SAFE', 'SUSPICIOUS', 'UNVERIFIED']);
const LABELS = new Set(['SCAM', 'SAFE']);
const MAX_ITEMS = 20;

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function validateBatch(body) {
  if (!exactKeys(body, ['batchId', 'participantId', 'submittedAt', 'consentScope',
    'examinedCount', 'offeredCount', 'selectionMethod', 'items']) ||
    !UUID.test(body.batchId) || !UUID.test(body.participantId) ||
    body.consentScope !== 'STUDY_EVALUATION_ONLY' ||
    body.selectionMethod !== 'RECENT_INBOX_PARTICIPANT_REVIEW' ||
    !Number.isInteger(body.examinedCount) || body.examinedCount < 1 || body.examinedCount > 1000 ||
    !Number.isInteger(body.offeredCount) || body.offeredCount < 1 ||
    body.offeredCount > 40 || body.examinedCount < body.offeredCount ||
    !Number.isSafeInteger(body.submittedAt) ||
    Math.abs(Date.now() - body.submittedAt) > 30 * 86400000 ||
    !Array.isArray(body.items) || body.items.length < 1 || body.items.length > MAX_ITEMS ||
    body.offeredCount < body.items.length) return null;
  const seen = new Set();
  const items = [];
  for (const item of body.items) {
    if (!exactKeys(item, ['clientId', 'text', 'localSuggestion', 'reviewedCategory', 'reviewedAt']) ||
      !HASH.test(item.clientId) || seen.has(item.clientId.toLowerCase()) ||
      typeof item.text !== 'string' || item.text.trim() !== item.text ||
      item.text.length < 1 || item.text.length > 2000 ||
      /(?<!\d)\d{4,8}(?!\d)|(?<!\d)\d{9,}(?!\d)|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu.test(item.text) ||
      !SUGGESTIONS.has(item.localSuggestion) || !LABELS.has(item.reviewedCategory) ||
      !Number.isSafeInteger(item.reviewedAt) || item.reviewedAt > body.submittedAt ||
      item.reviewedAt < body.submittedAt - 30 * 86400000) return null;
    seen.add(item.clientId.toLowerCase());
    items.push({ clientId: item.clientId.toLowerCase(), text: item.text,
      localSuggestion: item.localSuggestion, reviewedCategory: item.reviewedCategory,
      reviewedAt: item.reviewedAt });
  }
  return { batchId: body.batchId.toLowerCase(), participantId: body.participantId.toLowerCase(),
    submittedAt: body.submittedAt, consentScope: body.consentScope,
    examinedCount: body.examinedCount, offeredCount: body.offeredCount,
    selectionMethod: body.selectionMethod, items };
}

module.exports = { validateBatch, UUID, MAX_ITEMS };
