const { loadConfig } = require('../config/env');
const { createDatabasePool, checkRagDatabase } = require('../db/pool');
const { createKnowledgeRepository } = require('../db/knowledgeRepository');
const { createProductionRepository, checkProductionRepository } = require('./repository');
const { createPrivacyCodec } = require('./privacy');
const { assertProductionConfig, createProductionApp } = require('./createProductionApp');

function productionSettings(env = process.env) {
  if (env.APCIDA_PRODUCTION_ENABLED !== 'true' ||
    env.APCIDA_PRODUCTION_MODE !== 'controlled-test') {
    throw new Error('Production listener is disabled; controlled-test opt-in is required');
  }
  if (env.APCIDA_PRODUCTION_BIND !== '127.0.0.1') {
    throw new Error('Production listener must bind to 127.0.0.1');
  }
  const port = env.APCIDA_PRODUCTION_PORT === undefined ? 3020 : Number(env.APCIDA_PRODUCTION_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535 ||
    [3000, 3010, 5432, 11434].includes(port)) throw new Error('Invalid production port');
  const retentionHours = env.APCIDA_PRODUCTION_RETENTION_HOURS === undefined
    ? 24 : Number(env.APCIDA_PRODUCTION_RETENTION_HOURS);
  if (!Number.isInteger(retentionHours) || retentionHours < 1 || retentionHours > 72) {
    throw new Error('Production retention must be 1-72 hours');
  }
  const rateLimit = env.APCIDA_PRODUCTION_RATE_LIMIT === undefined
    ? 10 : Number(env.APCIDA_PRODUCTION_RATE_LIMIT);
  if (!Number.isInteger(rateLimit) || rateLimit < 1 || rateLimit > 60) {
    throw new Error('Production rate limit must be 1-60 requests per installation per minute');
  }
  const deadlineMs = env.APCIDA_PRODUCTION_DEADLINE_MS === undefined
    ? 90000 : Number(env.APCIDA_PRODUCTION_DEADLINE_MS);
  if (!Number.isInteger(deadlineMs) || deadlineMs < 1000 || deadlineMs > 100000) {
    throw new Error('Production deadline must be 1000-100000 ms');
  }
  const identityRetentionDays = env.APCIDA_PRODUCTION_IDENTITY_RETENTION_DAYS === undefined
    ? null : Number(env.APCIDA_PRODUCTION_IDENTITY_RETENTION_DAYS);
  if (identityRetentionDays !== null && (!Number.isInteger(identityRetentionDays) ||
    identityRetentionDays < 1 || identityRetentionDays > 3650)) {
    throw new Error('Identity retention must be 1-3650 days when explicitly enabled');
  }
  return { port, retentionSeconds: retentionHours * 3600, rateLimit, deadlineMs, identityRetentionDays,
    codec: createPrivacyCodec(env.PRODUCTION_DATA_KEY) };
}

async function main(env = process.env) {
  const settings = productionSettings(env);
  const config = loadConfig(env);
  assertProductionConfig(config);
  const pool = createDatabasePool(config.databaseUrl, { statementTimeoutMillis: 10000 });
  try {
    await checkRagDatabase(pool);
    await checkProductionRepository(pool);
    const repository = createProductionRepository(pool);
    const purge = async () => {
      await repository.purge(settings.retentionSeconds);
      if (settings.identityRetentionDays !== null) {
        await repository.purgeInactiveInstallations(settings.identityRetentionDays);
      }
    };
    await purge();
    const audit = ({ event, installationId }) => {
      process.stdout.write(`${new Date().toISOString()} ${event}${installationId ? ` installation=${installationId}` : ''}\n`);
    };
    const app = createProductionApp(config, { repository, codec: settings.codec,
      knowledgeRepository: createKnowledgeRepository(pool), audit,
      retentionSeconds: settings.retentionSeconds, rateLimit: settings.rateLimit,
      deadlineMs: settings.deadlineMs });
    const server = app.listen(settings.port, '127.0.0.1', () => {
      process.stdout.write(`Controlled production test listener bound to 127.0.0.1:${settings.port}\n`);
    });
    const purgeTimer = setInterval(() => purge()
      .catch(() => process.stderr.write('Production retention cleanup unavailable\n')), 3600000);
    purgeTimer.unref();
    server.on('error', (error) => {
      process.stderr.write(`Production listener failed: ${error.code || 'UNKNOWN'}\n`);
      clearInterval(purgeTimer);
      pool.end();
      process.exitCode = 1;
    });
    const shutdown = () => {
      clearInterval(purgeTimer);
      server.close(() => pool.end());
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    return server;
  } catch (error) {
    await pool.end();
    throw error;
  }
}

if (require.main === module) main().catch(() => {
  process.stderr.write('Controlled production listener startup failed; check private configuration and schema\n');
  process.exitCode = 1;
});

module.exports = { productionSettings, main };
