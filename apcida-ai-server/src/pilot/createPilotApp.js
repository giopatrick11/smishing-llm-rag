const express = require('express');
const { createApp } = require('../app');
const { smsRequestSchema } = require('../validators/sms');
const { createRateLimiter } = require('../middleware/rateLimit');
const { createInstallationAuth, createInstallationRateLimiter } = require('../production/security');

function assertPilotConfig(config) {
  if (config.model !== 'gemma3:12b' || !config.ragEnabled || !config.rulesEnabled
    || !config.rulesShadowMode || config.verdictPolicy !== 'gemma') {
    throw new Error('Pilot requires Gemma 3 12B, RAG, rules in shadow mode, and Gemma verdicts');
  }
  if (!config.apiKey || config.apiKey === 'replace-with-a-long-random-secret') {
    throw new Error('Configure a private internal API_KEY for the pilot');
  }
}

function createPilotApp(config, { installationRepository, knowledgeRepository, fetchImpl,
  audit = () => {} } = {}) {
  assertPilotConfig(config);
  if (!installationRepository?.findByTokenHash) throw new TypeError('Installation repository required');
  const inner = createApp(config, { knowledgeRepository, fetchImpl });
  const app = express();
  app.disable('x-powered-by');
  app.disable('etag');
  app.use((req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    next();
  });
  app.get('/health', (req, res) => res.json({ status: 'ok' }));
  const auth = createInstallationAuth({
    findByTokenHash: installationRepository.findByTokenHash.bind(installationRepository), audit,
  });
  const perInstallLimit = createInstallationRateLimiter({ limit: 10 });
  let busy = false;
  app.post('/api/sms/analyze', createRateLimiter({ limit: 30 }), auth, perInstallLimit,
    express.json({ limit: '8kb', strict: true }), (req, res) => {
      if (req.get('x-apcida-pilot-synthetic') !== 'true'
        || !req.body || req.body.sender !== 'ManualTest'
        || !/^pilot-[A-Za-z0-9_-]{8,80}$/u.test(req.body.messageId || '')) {
        return res.status(400).json({ error: 'SYNTHETIC_TEST_ONLY' });
      }
      const parsed = smsRequestSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'INVALID_REQUEST' });
      if (busy) return res.status(429).json({ error: 'INFERENCE_BUSY' });
      busy = true;
      const release = () => { busy = false; };
      res.once('finish', release);
      res.once('close', release);
      // The internal key never comes from the caller and stays on this process.
      req.headers['x-api-key'] = config.apiKey;
      delete req.headers.authorization;
      audit({ event: 'PILOT_ANALYSIS_ACCEPTED', installationId: res.locals.installationId });
      return inner(req, res);
    });
  app.use((error, req, res, next) => {
    if (error.type === 'entity.too.large') return res.status(413).json({ error: 'REQUEST_TOO_LARGE' });
    if (error instanceof SyntaxError && error.status === 400) return res.status(400).json({ error: 'INVALID_JSON' });
    return res.status(500).json({ error: 'INTERNAL_ERROR' });
  });
  app.use((req, res) => res.status(404).json({ error: 'NOT_FOUND' }));
  return app;
}

module.exports = { assertPilotConfig, createPilotApp };
