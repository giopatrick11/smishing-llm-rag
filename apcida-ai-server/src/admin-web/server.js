const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const dotenv = require('dotenv');

// This service uses only the private controlled-server settings, never the dev .env.
process.env.APCIDA_PRODUCTION_MODE = 'controlled-test';
const { createDatabasePool, checkRagDatabase } = require('../db/pool');
const { createPrivacyCodec } = require('../production/privacy');
const { loadEvaluationConfig } = require('../config/env');
const { loadEvaluationCorpus } = require('../knowledge/csv');
const { createEmbeddingService } = require('../services/embeddings');
const { createAdminApp } = require('./app');
const { createCloudflareTokenClient } = require('../production/inviteEnrollment');
const { createDeviceManagement } = require('./deviceManagement');
const { createStudyRepository } = require('../study/repository');
const { createStudyWorker } = require('../study/worker');
const { createProductionRepository } = require('../production/repository');
const { createAnalysisService } = require('../production/createProductionApp');
const { createKnowledgeRepository } = require('../db/knowledgeRepository');

const PRIVATE_ROOT = path.join(os.homedir(), 'Library/Application Support/ApCiDa/controlled-server');
const EVALUATION_CSV = path.resolve(__dirname, '../../../dataset/apcida_synthetic_sms_200.csv');

function readPrivate(name) {
  const file = path.join(PRIVATE_ROOT, name);
  const stat = fs.statSync(file);
  if ((stat.mode & 0o077) !== 0) throw new Error(`${name} must be readable only by the owner`);
  return fs.readFileSync(file, 'utf8').trim();
}

function privateLoginPassword(name) {
  const file = path.join(PRIVATE_ROOT, name);
  try {
    const fd = fs.openSync(file, 'wx', 0o600);
    try { fs.writeFileSync(fd, randomBytes(32).toString('hex') + '\n'); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const password = readPrivate(name);
  if (!/^[0-9a-f]{64}$/u.test(password)) throw new Error(`${name} has an invalid format`);
  return password;
}
function dashboardPassword() { return privateLoginPassword('dashboard-login.key'); }

async function main() {
  const privateEnv = dotenv.parse(readPrivate('production.env'));
  const dbPassword = readPrivate('dashboard-db.password');
  if (!/^[0-9a-f]{64}$/u.test(dbPassword)) throw new Error('Dashboard database password has an invalid format');
  const databaseUrl = `postgresql://apcida_review:${dbPassword}@127.0.0.1:55436/apcida`;
  const pool = createDatabasePool(databaseUrl, { statementTimeoutMillis: 10000 });
  try {
    await checkRagDatabase(pool);
    const reports = await pool.query("SELECT to_regclass('public.production_reports') AS table_name");
    if (!reports.rows[0]?.table_name) throw new Error('Report schema unavailable');
    const corpus = loadEvaluationCorpus(EVALUATION_CSV, 'sms_text');
    const config = loadEvaluationConfig({ ...privateEnv, APCIDA_PRODUCTION_MODE: 'controlled-test' });
    const codec = createPrivacyCodec(privateEnv.PRODUCTION_DATA_KEY);
    const studyEnabled = privateEnv.APCIDA_STUDY_ENABLED === 'true';
    if (studyEnabled) {
      const schema = await pool.query("SELECT to_regclass('study.contributions') AS table_name");
      if (!schema.rows[0]?.table_name) throw new Error('Study schema unavailable');
    }
    const studyRetentionDays = Number(privateEnv.APCIDA_STUDY_RETENTION_DAYS);
    if (studyEnabled && (!Number.isInteger(studyRetentionDays) ||
      studyRetentionDays < 1 || studyRetentionDays > 3650)) {
      throw new Error('APCIDA_STUDY_RETENTION_DAYS must be set to 1-3650');
    }
    const studyRepository = studyEnabled ? createStudyRepository(pool, codec,
      { retentionDays: studyRetentionDays }) : null;
    const studyWorker = studyEnabled ? createStudyWorker({ pool, repository: studyRepository,
      slotRepository: createProductionRepository(pool),
      analyzer: createAnalysisService(config, createKnowledgeRepository(pool)),
      model: config.model, ollamaUrl: config.ollamaUrl,
      requestTimeoutMs: config.requestTimeoutMs,
      audit: (event, id, elapsedMs) => process.stdout.write(`${new Date().toISOString()} ${event}${id ? ` id=${id}` : ''}${elapsedMs ? ` elapsed_ms=${elapsedMs}` : ''}\n`),
    }) : null;
    const cloudflare = createCloudflareTokenClient({ accountId: privateEnv.CLOUDFLARE_ACCOUNT_ID,
      apiToken: privateEnv.CLOUDFLARE_PROVISIONING_API_TOKEN });
    const app = createAdminApp({ pool, codec,
      loginPassword: dashboardPassword(), embeddingService: createEmbeddingService(config), corpus,
      expertLoginPassword: studyEnabled ? privateLoginPassword('study-expert-login.key') : null,
      deviceManagement: createDeviceManagement(pool, cloudflare),
      studyRepository, studyWorker,
      publicEnabled: privateEnv.ADMIN_DASHBOARD_PUBLIC_ENABLED === 'true' });
    const server = app.listen(3022, '127.0.0.1', () => {
      process.stdout.write('ApCiDa admin dashboard listening on 127.0.0.1:3022\n');
    });
    server.requestTimeout = 120000;
    if (studyWorker) await studyWorker.resume();
    server.headersTimeout = 15000;
    server.on('error', (error) => {
      process.stderr.write(`Admin dashboard listener failed: ${error.code || 'UNKNOWN'}\n`);
      pool.end();
    });
    const stop = () => server.close(() => pool.end());
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    return server;
  } catch (error) {
    await pool.end();
    throw error;
  }
}

if (require.main === module) main().catch((error) => {
  process.stderr.write(`Admin dashboard startup failed: ${error.message}\n`);
  process.exitCode = 1;
});

module.exports = { main, dashboardPassword };
