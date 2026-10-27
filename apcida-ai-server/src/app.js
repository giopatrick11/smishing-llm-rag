const express = require('express');
const { createOllamaService, OllamaError } = require('./services/ollama');
const { createRagService, RagError } = require('./services/rag');
const { createHybridService } = require('./services/hybrid');
const { createAiRouter } = require('./routes/ai');
const { createSmsRouter } = require('./routes/sms');

function createApp(config, { fetchImpl, knowledgeRepository } = {}) {
  const app = express();
  app.disable('x-powered-by');
  const ollama = createOllamaService(config, fetchImpl);
  const baseAnalysisService = config.ragEnabled
    ? createRagService(config, ollama, knowledgeRepository, fetchImpl, { includeContext: !!config.rulesEnabled })
    : ollama;
  const analysisService = config.rulesEnabled
    ? createHybridService(baseAnalysisService, { shadowMode: config.rulesShadowMode, verdictPolicy: config.verdictPolicy })
    : baseAnalysisService;

  app.use(express.json({ limit: '8kb', strict: true }));
  app.get('/', (req, res) => res.json({
    service: 'ApCiDa AI server',
    endpoints: ['GET /health', 'GET /api/ai/status', 'POST /api/sms/analyze'],
  }));
  app.get('/health', (req, res) => res.json({ status: 'ok' }));
  app.use('/api/ai', createAiRouter(ollama));
  app.use('/api/sms', createSmsRouter(analysisService, config));

  app.use((req, res) => res.status(404).json({ error: 'NOT_FOUND' }));
  app.use((error, req, res, next) => {
    if (error instanceof OllamaError) return res.status(error.status).json({ error: error.code });
    if (error instanceof RagError) return res.status(error.status).json({ error: error.code });
    if (error.type === 'entity.too.large') return res.status(413).json({ error: 'REQUEST_TOO_LARGE' });
    if (error instanceof SyntaxError && error.status === 400) return res.status(400).json({ error: 'INVALID_JSON' });
    return res.status(500).json({ error: 'INTERNAL_ERROR' });
  });

  return app;
}

module.exports = { createApp };
