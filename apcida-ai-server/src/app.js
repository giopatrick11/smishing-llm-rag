const express = require('express');
const { createOllamaService, OllamaError } = require('./services/ollama');
const { createAiRouter } = require('./routes/ai');
const { createSmsRouter } = require('./routes/sms');

function createApp(config, { fetchImpl } = {}) {
  const app = express();
  app.disable('x-powered-by');
  const ollama = createOllamaService(config, fetchImpl);

  app.use(express.json({ limit: '8kb', strict: true }));
  app.get('/', (req, res) => res.json({
    service: 'ApCiDa AI server',
    endpoints: ['GET /health', 'GET /api/ai/status', 'POST /api/sms/analyze'],
  }));
  app.get('/health', (req, res) => res.json({ status: 'ok' }));
  app.use('/api/ai', createAiRouter(ollama));
  app.use('/api/sms', createSmsRouter(ollama, config));

  app.use((req, res) => res.status(404).json({ error: 'NOT_FOUND' }));
  app.use((error, req, res, next) => {
    if (error instanceof OllamaError) return res.status(error.status).json({ error: error.code });
    if (error.type === 'entity.too.large') return res.status(413).json({ error: 'REQUEST_TOO_LARGE' });
    if (error instanceof SyntaxError && error.status === 400) return res.status(400).json({ error: 'INVALID_JSON' });
    return res.status(500).json({ error: 'INTERNAL_ERROR' });
  });

  return app;
}

module.exports = { createApp };
