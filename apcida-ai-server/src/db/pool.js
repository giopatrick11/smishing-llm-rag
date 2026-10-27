const { Pool } = require('pg');

function createDatabasePool(databaseUrl) {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 2,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 10000,
  });
  pool.on('error', () => {
    process.stderr.write('RAG database connection error\n');
  });
  return pool;
}

async function checkRagDatabase(pool) {
  const result = await pool.query(`SELECT current_database() AS database_name,
    current_setting('server_version_num')::integer AS version_number,
    EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS vector_enabled,
    to_regclass('public.rag_knowledge') IS NOT NULL AS knowledge_table_exists`);
  const state = result.rows[0];
  if (state?.database_name !== 'apcida' || state.version_number < 170000
    || state.version_number >= 180000 || !state.vector_enabled || !state.knowledge_table_exists) {
    throw new Error('Local PostgreSQL 17 RAG schema is unavailable; run npm run db:migrate');
  }
}

module.exports = { createDatabasePool, checkRagDatabase };
