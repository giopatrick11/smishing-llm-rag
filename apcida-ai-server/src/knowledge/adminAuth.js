require('dotenv').config({ quiet: true });
const { createHash, timingSafeEqual } = require('node:crypto');

function requireAdmin(environment = process.env) {
  const expected = environment.RAG_ADMIN_KEY;
  const supplied = environment.APCIDA_ADMIN_TOKEN;
  if (typeof expected !== 'string' || expected.length < 32) throw new Error('RAG_ADMIN_KEY must be configured with at least 32 characters');
  if (typeof supplied !== 'string' || !supplied) throw new Error('APCIDA_ADMIN_TOKEN is required for knowledge commands');
  const expectedHash = createHash('sha256').update(expected).digest();
  const suppliedHash = createHash('sha256').update(supplied).digest();
  if (!timingSafeEqual(expectedHash, suppliedHash)) throw new Error('Administrator authentication failed');
}

module.exports = { requireAdmin };
