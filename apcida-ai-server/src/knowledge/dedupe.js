const { createHash } = require('node:crypto');

const NEAR_DUPLICATE_DICE_THRESHOLD = 0.88;

function normalizeSms(text) {
  return text.normalize('NFKC').toLocaleLowerCase()
    .replace(/(?:https?:\/\/|www\.)\S+/giu, ' url ')
    .replace(/\b\d{4,}\b/gu, ' number ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ').trim();
}

function makeGrams(value) {
  const padded = `  ${value}  `;
  const grams = new Map();
  for (let i = 0; i <= padded.length - 3; i += 1) {
    const gram = padded.slice(i, i + 3);
    grams.set(gram, (grams.get(gram) || 0) + 1);
  }
  return grams;
}

function signature(text) {
  const normalized = normalizeSms(text);
  if (!normalized) throw new Error('SMS has no comparable content');
  return {
    hash: createHash('sha256').update(normalized).digest('hex'),
    normalized,
    grams: makeGrams(normalized),
  };
}

function diceSimilarity(left, right) {
  let shared = 0;
  for (const [gram, count] of left.grams) shared += Math.min(count, right.grams.get(gram) || 0);
  const leftSize = [...left.grams.values()].reduce((sum, count) => sum + count, 0);
  const rightSize = [...right.grams.values()].reduce((sum, count) => sum + count, 0);
  return (2 * shared) / (leftSize + rightSize);
}

function duplicateKind(left, right) {
  if (left.hash === right.hash) return 'EXACT';
  return diceSimilarity(left, right) >= NEAR_DUPLICATE_DICE_THRESHOLD ? 'NEAR' : null;
}

function findDuplicate(candidate, references) {
  for (const reference of references) {
    const kind = duplicateKind(candidate.signature, reference.signature);
    if (kind) return { kind, referenceId: reference.id };
  }
  return null;
}

module.exports = { normalizeSms, signature, diceSimilarity, duplicateKind, findDuplicate, NEAR_DUPLICATE_DICE_THRESHOLD };
