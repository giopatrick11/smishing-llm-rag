const { createHash, timingSafeEqual } = require('node:crypto');

function createApiKeyAuth(apiKey) {
  const expected = createHash('sha256').update(apiKey).digest();
  return function apiKeyAuth(req, res, next) {
    const supplied = req.get('x-api-key');
    const actual = createHash('sha256').update(supplied || '').digest();
    if (!supplied || !timingSafeEqual(actual, expected)) {
      return res.status(401).json({ error: 'UNAUTHORIZED' });
    }
    next();
  };
}

module.exports = { createApiKeyAuth };
