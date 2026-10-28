const { createHash, timingSafeEqual } = require('node:crypto');

function requireProductionAdmin(environment = process.env) {
  const expected = environment.PRODUCTION_ADMIN_KEY;
  const supplied = environment.APCIDA_PRODUCTION_ADMIN_TOKEN;
  if (typeof expected !== 'string' || expected.length < 32) {
    throw new Error('PRODUCTION_ADMIN_KEY must be configured with at least 32 characters');
  }
  if (typeof supplied !== 'string' || !supplied) {
    throw new Error('APCIDA_PRODUCTION_ADMIN_TOKEN is required for production administration');
  }
  const a = createHash('sha256').update(expected).digest();
  const b = createHash('sha256').update(supplied).digest();
  if (!timingSafeEqual(a, b)) throw new Error('Production administrator authentication failed');
}

module.exports = { requireProductionAdmin };
