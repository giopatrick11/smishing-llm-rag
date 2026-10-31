const { Client } = require('pg');
const { loadDatabaseUrl } = require('../config/env');

// This command is only for the separate Mac controlled-test cluster.
function assertControlledTarget(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid controlled target URL'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) ||
    url.hostname !== '127.0.0.1' || url.port !== '55436' ||
    url.pathname !== '/apcida' || url.search || url.hash) {
    throw new Error('Target must be the dedicated local apcida database on port 55436');
  }
  return url;
}

async function copyApprovedKnowledge(environment = process.env) {
  const sourceUrl = loadDatabaseUrl({ DATABASE_URL: environment.APCIDA_SOURCE_DATABASE_URL });
  const targetUrl = environment.APCIDA_TARGET_DATABASE_URL;
  assertControlledTarget(targetUrl);
  if (['55435', '55436'].includes(new URL(sourceUrl).port)) {
    throw new Error('RAG source must be the approved main database');
  }
  const source = new Client({ connectionString: sourceUrl, connectionTimeoutMillis: 5000 });
  const target = new Client({ connectionString: targetUrl, connectionTimeoutMillis: 5000 });
  await source.connect();
  try {
    await target.connect();
    try {
      await source.query('BEGIN READ ONLY');
      const sourceIdentity = await source.query('SELECT current_database() AS name');
      if (sourceIdentity.rows[0]?.name !== 'apcida') throw new Error('Unexpected RAG source database');
      const records = await source.query(`SELECT content, label, embedding::text AS embedding,
        embedding_model, source_type, source_reference, approved_at, is_active,
        normalized_hash, approved_by FROM rag_knowledge WHERE is_active = true`);
      if (records.rowCount !== 100) throw new Error('Expected exactly 100 active approved RAG records');
      await target.query('BEGIN');
      try {
        const existing = await target.query('SELECT count(*)::integer AS count FROM rag_knowledge');
        if (existing.rows[0]?.count !== 0) throw new Error('Controlled target RAG table is not empty');
        for (const row of records.rows) {
          await target.query(`INSERT INTO rag_knowledge (content, label, embedding,
            embedding_model, source_type, source_reference, approved_at, is_active,
            normalized_hash, approved_by) VALUES ($1,$2,$3::vector,$4,$5,$6,$7,$8,$9,$10)`,
          [row.content, row.label, row.embedding, row.embedding_model, row.source_type,
            row.source_reference, row.approved_at, row.is_active, row.normalized_hash,
            row.approved_by]);
        }
        await target.query('COMMIT');
      } catch (error) {
        await target.query('ROLLBACK');
        throw error;
      }
      await source.query('COMMIT');
      process.stdout.write(`Copied ${records.rowCount} approved RAG records into the separate controlled database.\n`);
    } finally { await target.end(); }
  } finally { await source.end(); }
}

if (require.main === module) copyApprovedKnowledge().catch((error) => {
  process.stderr.write(`Controlled RAG copy failed: ${error.message}\n`);
  process.exitCode = 1;
});

module.exports = { assertControlledTarget, copyApprovedKnowledge };
