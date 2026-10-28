const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const { OllamaError } = require('../services/ollama');
const { createProductionApp } = require('../production/createProductionApp');
const { createProductionRepository, checkProductionRepository } = require('../production/repository');
const { createPrivacyCodec } = require('../production/privacy');
const { enrollProductionInstallation } = require('../production/enrollment');

const stagingConfig = {
  model: 'gemma3:12b', ragEnabled: true, rulesEnabled: true,
  rulesShadowMode: true, verdictPolicy: 'gemma',
};

function stagingSettings(env = process.env) {
  if (env.APCIDA_STAGING_ENABLED !== 'true' || env.APCIDA_STAGING_BIND !== '127.0.0.1') {
    throw new Error('Isolated staging listener is disabled');
  }
  const url = new URL(env.APCIDA_STAGING_DATABASE_URL);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) ||
    url.hostname !== '127.0.0.1' || url.pathname !== '/apcida_staging' ||
    url.search || url.hash) throw new Error('A dedicated loopback apcida_staging database is required');
  const tokenFile = env.APCIDA_STAGING_TOKEN_FILE;
  const endpointFile = env.APCIDA_STAGING_ENDPOINT_FILE;
  if (!tokenFile || !endpointFile || !path.isAbsolute(tokenFile) || !path.isAbsolute(endpointFile)) {
    throw new Error('Private staging output paths are required');
  }
  return { databaseUrl: url.toString(), tokenFile, endpointFile,
    codec: createPrivacyCodec(env.APCIDA_STAGING_DATA_KEY) };
}

function syntheticAnalyzer() {
  let analyses = 0;
  return {
    get analyses() { return analyses; },
    async analyze(sms) {
      // This is test-only. No Ollama, RAG query, or approved knowledge is accessed.
      const fixture = /^STAGING SYNTHETIC: (SCAM|SAFE|SUSPICIOUS|TIMEOUT)(?:\s|$)/.exec(sms.text);
      if (!fixture) throw new Error('Synthetic fixture required');
      analyses++;
      if (fixture[1] === 'TIMEOUT') throw new OllamaError('OLLAMA_TIMEOUT', 504);
      return { classification: fixture[1], confidence: 'HIGH', rationale: 'Synthetic staging response' };
    },
  };
}

async function main(env = process.env) {
  const settings = stagingSettings(env);
  const pool = new Pool({ connectionString: settings.databaseUrl, max: 3,
    connectionTimeoutMillis: 3000, statement_timeout: 5000 });
  try {
    await checkProductionRepository(pool);
    const repository = createProductionRepository(pool);
    const valid = await enrollProductionInstallation(repository, { label: 'StagingSyntheticValid', days: 1 });
    const revoked = await enrollProductionInstallation(repository, { label: 'StagingSyntheticRevoked', days: 1 });
    const selfRevoke = await enrollProductionInstallation(repository,
      { label: 'StagingSyntheticSelfRevoke', days: 1 });
    const androidRevoke = await enrollProductionInstallation(repository,
      { label: 'StagingAndroidRevoke', days: 1 });
    await repository.revoke(revoked.installationId);
    fs.writeFileSync(settings.tokenFile, JSON.stringify({ validToken: valid.token,
      revokedToken: revoked.token, selfRevokeToken: selfRevoke.token,
      androidRevokeToken: androidRevoke.token }), { flag: 'wx', mode: 0o600 });
    const app = createProductionApp(stagingConfig, { repository,
      codec: settings.codec, analysisService: syntheticAnalyzer(), audit: () => {}, rateLimit: 30 });
    const server = app.listen(0, '127.0.0.1', () => {
      fs.writeFileSync(settings.endpointFile,
        `http://127.0.0.1:${server.address().port}`, { flag: 'wx', mode: 0o600 });
    });
    const shutdown = () => server.close(() => pool.end());
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
    return server;
  } catch (error) {
    await pool.end();
    throw error;
  }
}

if (require.main === module) main().catch(() => {
  process.stderr.write('Isolated staging setup failed\n');
  process.exitCode = 1;
});

module.exports = { stagingSettings, syntheticAnalyzer, main };
