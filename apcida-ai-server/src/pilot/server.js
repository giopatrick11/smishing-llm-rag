const { loadConfig } = require('../config/env');
const { createDatabasePool, checkRagDatabase } = require('../db/pool');
const { createKnowledgeRepository } = require('../db/knowledgeRepository');
const { createInstallationRepository, checkInstallationRepository } = require('./installationRepository');
const { assertPilotConfig, createPilotApp } = require('./createPilotApp');

function pilotPort(value = process.env.APCIDA_PILOT_PORT) {
  const port = value === undefined ? 3010 : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid APCIDA_PILOT_PORT');
  return port;
}

async function main() {
  const config = loadConfig();
  assertPilotConfig(config);
  const pool = createDatabasePool(config.databaseUrl);
  try {
    await checkRagDatabase(pool);
    await checkInstallationRepository(pool);
    const audit = ({ event, installationId }) => {
      process.stdout.write(`${new Date().toISOString()} ${event}${installationId ? ` installation=${installationId}` : ''}\n`);
    };
    const app = createPilotApp(config, {
      installationRepository: createInstallationRepository(pool),
      knowledgeRepository: createKnowledgeRepository(pool), audit,
    });
    const server = app.listen(pilotPort(), '127.0.0.1', () => {
      process.stdout.write(`Pilot listener bound to 127.0.0.1:${pilotPort()}\n`);
    });
    server.on('error', (error) => {
      process.stderr.write(`Pilot listen failed: ${error.code || 'UNKNOWN'}\n`);
      pool.end();
      process.exitCode = 1;
    });
    const shutdown = () => server.close(() => pool.end());
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  } catch (error) {
    await pool.end();
    throw error;
  }
}

if (require.main === module) main().catch((error) => {
  process.stderr.write(`Pilot startup failed: ${error.message}\n`);
  process.exitCode = 1;
});

module.exports = { pilotPort };
