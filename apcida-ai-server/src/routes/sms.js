const { Router } = require('express');
const { createSmsController } = require('../controllers/smsController');
const { createApiKeyAuth } = require('../middleware/auth');
const { createRateLimiter } = require('../middleware/rateLimit');

function createSmsRouter(ollama, config) {
  const router = Router();
  router.post('/analyze', createRateLimiter(), createApiKeyAuth(config.apiKey), createSmsController(ollama, config.model));
  return router;
}

module.exports = { createSmsRouter };
