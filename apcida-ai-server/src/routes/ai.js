const { Router } = require('express');
const { createAiController } = require('../controllers/aiController');

function createAiRouter(ollama) {
  const router = Router();
  router.get('/status', createAiController(ollama));
  return router;
}

module.exports = { createAiRouter };
