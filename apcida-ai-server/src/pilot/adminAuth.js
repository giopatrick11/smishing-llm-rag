const { createHash, timingSafeEqual } = require('node:crypto');

function requirePilotAdmin(environment = process.env) {
  const expected = environment.PILOT_ADMIN_KEY;
  const supplied = environment.APCIDA_PILOT_ADMIN_TOKEN;
  if (typeof expected !== 'string' || expected.length < 32) {
    throw new Error('PILOT_ADMIN_KEY must be configured with at least 32 characters');
  }
  if (typeof supplied !== 'string' || !supplied) {
    throw new Error('APCIDA_PILOT_ADMIN_TOKEN is required for pilot administration');
  }
  const expectedHash = createHash('sha256').update(expected).digest();
  const suppliedHash = createHash('sha256').update(supplied).digest();
  if (!timingSafeEqual(expectedHash, suppliedHash)) throw new Error('Pilot administrator authentication failed');
}

module.exports = { requirePilotAdmin };
