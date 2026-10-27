const { loadConfig } = require('./config/env');
const { createApp } = require('./app');
const { createDatabasePool, checkRagDatabase } = require('./db/pool');
const { createKnowledgeRepository } = require('./db/knowledgeRepository');

async function main() {
  const config = loadConfig();
  let pool;
  let knowledgeRepository;
  if (config.ragEnabled) {
    pool = createDatabasePool(config.databaseUrl);
    try {
      await checkRagDatabase(pool);
    } catch {
      await pool.end();
      throw new Error('RAG database unavailable or not migrated; run npm run db:migrate');
    }
    knowledgeRepository = createKnowledgeRepository(pool);
  }
  const server = createApp(config, { knowledgeRepository }).listen(config.port, config.host, () => {
    process.stdout.write(`ApCiDa AI server listening at http://${config.host}:${config.port}\n`);
  });
  server.on('error', async (error) => {
    process.stderr.write(`Server listen failed: ${error.code || 'UNKNOWN'}\n`);
    if (pool) await pool.end();
    process.exitCode = 1;
  });
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
