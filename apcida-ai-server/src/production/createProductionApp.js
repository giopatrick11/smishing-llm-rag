const express = require('express');
const { randomUUID } = require('node:crypto');
const { createOllamaService, OllamaError } = require('../services/ollama');
const { createRagService, RagError } = require('../services/rag');
const { createHybridService } = require('../services/hybrid');
const { createRateLimiter } = require('../middleware/rateLimit');
const { createInstallationAuth } = require('./security');
const { validateProductionRequest, validateProductionResponse } = require('./smsContract');
const { startAnalysisDeadline } = require('./deadline');

function assertProductionConfig(config) {
  if (config.model !== 'gemma3:12b' || !config.ragEnabled || !config.rulesEnabled
    || !config.rulesShadowMode || config.verdictPolicy !== 'gemma') {
    throw new Error('Production listener requires frozen Gemma 3 12B, RAG, and shadow-rule configuration');
  }
}

function createAnalysisService(config, knowledgeRepository, fetchImpl) {
  const ollama = createOllamaService(config, fetchImpl);
  const rag = createRagService(config, ollama, knowledgeRepository, fetchImpl, { includeContext: true });
  return createHybridService(rag, { shadowMode: true, verdictPolicy: 'gemma' });
}

function createProductionApp(config, { repository, codec, knowledgeRepository, fetchImpl,
  analysisService, audit = () => {}, rateLimit = 10, leaseSeconds = 300,
  retentionSeconds = 86400, deadlineMs = 90000 } = {}) {
  assertProductionConfig(config);
  if (!repository || !['findByTokenHash', 'isActive', 'revoke', 'countRequest', 'claim', 'complete', 'release',
    'acquireSlot', 'releaseSlot']
    .every((method) => typeof repository[method] === 'function')) {
    throw new TypeError('Production repository required');
  }
  if (!codec?.requestHmac || !codec?.encrypt || !codec?.decrypt) {
    throw new TypeError('Production privacy codec required');
  }
  if (!Number.isInteger(rateLimit) || rateLimit < 1 ||
    !Number.isInteger(leaseSeconds) || leaseSeconds < 1 ||
    !Number.isInteger(retentionSeconds) || retentionSeconds < leaseSeconds ||
    !Number.isInteger(deadlineMs) || deadlineMs < 10 || deadlineMs > 100000) {
    throw new TypeError('Invalid production limits');
  }
  const analyzer = analysisService || createAnalysisService(config, knowledgeRepository, fetchImpl);
  const app = express();
  app.disable('x-powered-by');
  app.disable('etag');
  app.use((req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    next();
  });
  app.get('/health', (req, res) => res.json({ status: 'ok' }));
  const safeAudit = (event) => { try { audit(event); } catch { /* never log request data */ } };
  const auth = createInstallationAuth({
    findByTokenHash: repository.findByTokenHash.bind(repository), audit: safeAudit,
  });
  let busy = false; // This controlled listener runs as exactly one process.
  // A consent-revoked installation can invalidate its own credential and erase its
  // response cache. Android does not invoke this route until a reviewed rollout.
  app.delete('/api/v1/installations/me', createRateLimiter({ limit: 30 }), auth,
    async (req, res) => {
      if (req.get('transfer-encoding') ||
        (req.get('content-length') && req.get('content-length') !== '0')) {
        return res.status(400).json({ error: 'INVALID_REQUEST' });
      }
      try {
        await repository.revoke(res.locals.installationId);
        safeAudit({ event: 'PRODUCTION_INSTALLATION_SELF_REVOKED',
          installationId: res.locals.installationId });
        return res.status(204).end();
      } catch {
        return res.status(503).json({ error: 'DATABASE_UNAVAILABLE' });
      }
    });
  app.post('/api/v1/sms/analyze', createRateLimiter({ limit: 30 }), auth,
    express.json({ limit: '8kb', strict: true }), async (req, res) => {
      if (req.get('x-apcida-pilot-synthetic') !== undefined) {
        return res.status(400).json({ error: 'INVALID_REQUEST' });
      }
      const sms = validateProductionRequest(req.body, req.get('idempotency-key'));
      if (!sms) return res.status(400).json({ error: 'INVALID_REQUEST' });
      const deadlineAt = Date.now() + deadlineMs;
      const installationId = res.locals.installationId;
      let allowed;
      try { allowed = await repository.countRequest(installationId, rateLimit); }
      catch { return res.status(503).json({ error: 'DATABASE_UNAVAILABLE' }); }
      if (!allowed) {
        res.set('Retry-After', '60');
        return res.status(429).json({ error: 'RATE_LIMITED' });
      }
      const leaseOwner = randomUUID();
      let claim;
      try {
        claim = await repository.claim({ installationId, messageId: sms.messageId,
          requestHmac: codec.requestHmac(sms), leaseOwner, leaseSeconds, retentionSeconds });
      } catch { return res.status(503).json({ error: 'DATABASE_UNAVAILABLE' }); }
      if (claim.kind === 'CONFLICT') return res.status(409).json({ error: 'MESSAGE_ID_CONFLICT' });
      if (claim.kind === 'BUSY') {
        res.set('Retry-After', '3');
        return res.status(409).json({ error: 'REQUEST_IN_PROGRESS' });
      }
      if (claim.kind === 'REPLAY') {
        if (Date.now() >= deadlineAt) return res.status(504).json({ error: 'ANALYSIS_DEADLINE' });
        let activeForReplay;
        try { activeForReplay = await repository.isActive(installationId); }
        catch { return res.status(503).json({ error: 'DATABASE_UNAVAILABLE' }); }
        if (!activeForReplay) return res.status(401).json({ error: 'UNAUTHORIZED' });
        try {
          const cached = codec.decrypt(claim.encrypted);
          if (!validateProductionResponse(cached, sms.messageId)) throw new Error('Invalid cache');
          return res.json(cached);
        } catch { return res.status(503).json({ error: 'CACHE_UNAVAILABLE' }); }
      }
      if (claim.kind !== 'CLAIMED') return res.status(503).json({ error: 'DATABASE_UNAVAILABLE' });
      let slot;
      try { slot = await repository.acquireSlot(leaseOwner, leaseSeconds); }
      catch {
        try { await repository.release({ installationId, messageId: sms.messageId, leaseOwner }); }
        catch { /* stale lease is recoverable */ }
        return res.status(503).json({ error: 'DATABASE_UNAVAILABLE' });
      }
      if (!slot) {
        try { await repository.release({ installationId, messageId: sms.messageId, leaseOwner }); }
        catch { /* stale lease is recoverable */ }
        res.set('Retry-After', '3');
        return res.status(429).json({ error: 'INFERENCE_BUSY' });
      }
      if (busy) {
        await Promise.allSettled([
          repository.release({ installationId, messageId: sms.messageId, leaseOwner }),
          repository.releaseSlot(leaseOwner),
        ]);
        res.set('Retry-After', '3');
        return res.status(429).json({ error: 'INFERENCE_BUSY' });
      }
      let activeBeforeInference;
      try { activeBeforeInference = await repository.isActive(installationId); }
      catch {
        await Promise.allSettled([
          repository.release({ installationId, messageId: sms.messageId, leaseOwner }),
          repository.releaseSlot(leaseOwner),
        ]);
        return res.status(503).json({ error: 'DATABASE_UNAVAILABLE' });
      }
      if (!activeBeforeInference) {
        await Promise.allSettled([
          repository.release({ installationId, messageId: sms.messageId, leaseOwner }),
          repository.releaseSlot(leaseOwner),
        ]);
        return res.status(401).json({ error: 'UNAUTHORIZED' });
      }
      busy = true;
      safeAudit({ event: 'PRODUCTION_ANALYSIS_ACCEPTED', installationId });
      const cleanup = async () => {
        busy = false;
        // A completed row is retained for replay; only an unfinished lease is deleted.
        await Promise.allSettled([
          repository.release({ installationId, messageId: sms.messageId, leaseOwner }),
          repository.releaseSlot(leaseOwner),
        ]);
      };
      let cleanupAfterTask = false;
      let onClientClose;
      try {
        const remaining = deadlineAt - Date.now();
        if (remaining <= 0) return res.status(504).json({ error: 'ANALYSIS_DEADLINE' });
        const execution = startAnalysisDeadline(analyzer, sms, remaining);
        onClientClose = () => { if (!res.writableEnded) execution.cancel(); };
        res.once('close', onClientClose);
        const outcome = await execution.outcome;
        if (outcome.kind === 'DEADLINE') {
          // An uncooperative analyzer must not permit another inference until it settles.
          cleanupAfterTask = true;
          execution.settled.then(cleanup);
          return res.status(504).json({ error: 'ANALYSIS_DEADLINE' });
        }
        if (outcome.kind === 'ERROR') throw outcome.error;
        if (Date.now() >= deadlineAt || execution.signal.aborted) {
          return res.status(504).json({ error: 'ANALYSIS_DEADLINE' });
        }
        const analysis = outcome.value;
        let active;
        try { active = await repository.isActive(installationId); }
        catch { return res.status(503).json({ error: 'DATABASE_UNAVAILABLE' }); }
        if (!active) return res.status(401).json({ error: 'UNAUTHORIZED' });
        const answer = { messageId: sms.messageId, classification: analysis.classification,
          confidence: analysis.confidence, rationale: analysis.rationale };
        if (!validateProductionResponse(answer, sms.messageId)) {
          return res.status(502).json({ error: 'AI_INVALID_RESPONSE' });
        }
        const encrypted = codec.encrypt(answer);
        const saved = await repository.complete({ installationId,
          messageId: sms.messageId, leaseOwner, encrypted });
        if (!saved) return res.status(503).json({ error: 'DATABASE_UNAVAILABLE' });
        // Completion and consent revocation can race; do not emit a verdict if
        // the installation was invalidated while the response was being stored.
        let activeAfterCompletion;
        try { activeAfterCompletion = await repository.isActive(installationId); }
        catch { return res.status(503).json({ error: 'DATABASE_UNAVAILABLE' }); }
        if (!activeAfterCompletion) return res.status(401).json({ error: 'UNAUTHORIZED' });
        if (Date.now() >= deadlineAt || execution.signal.aborted) {
          return res.status(504).json({ error: 'ANALYSIS_DEADLINE' });
        }
        // Complete slot cleanup before exposing success to a sequential client.
        // Otherwise its next message can spuriously receive INFERENCE_BUSY.
        await cleanup();
        cleanupAfterTask = true;
        try { activeAfterCompletion = await repository.isActive(installationId); }
        catch { return res.status(503).json({ error: 'DATABASE_UNAVAILABLE' }); }
        if (!activeAfterCompletion) return res.status(401).json({ error: 'UNAUTHORIZED' });
        if (Date.now() >= deadlineAt || execution.signal.aborted) {
          return res.status(504).json({ error: 'ANALYSIS_DEADLINE' });
        }
        return res.json(answer);
      } catch (error) {
        if (Date.now() >= deadlineAt) {
          return res.status(504).json({ error: 'ANALYSIS_DEADLINE' });
        }
        if (error instanceof OllamaError || error instanceof RagError) {
          return res.status(error.status).json({ error: error.code });
        }
        return res.status(503).json({ error: 'ANALYSIS_UNAVAILABLE' });
      } finally {
        if (onClientClose) res.off('close', onClientClose);
        if (!cleanupAfterTask) await cleanup();
      }
    });
  app.use((error, req, res, next) => {
    if (error.type === 'entity.too.large') return res.status(413).json({ error: 'REQUEST_TOO_LARGE' });
    if (error instanceof SyntaxError && error.status === 400) return res.status(400).json({ error: 'INVALID_JSON' });
    return res.status(500).json({ error: 'INTERNAL_ERROR' });
  });
  app.use((req, res) => res.status(404).json({ error: 'NOT_FOUND' }));
  return app;
}

module.exports = { assertProductionConfig, createProductionApp, createAnalysisService };
