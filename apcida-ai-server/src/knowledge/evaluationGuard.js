const { createHash } = require('node:crypto');
const { signature, findDuplicate } = require('./dedupe');

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function lockAndCheckRagKnowledge(pool, evaluationRows) {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock_shared(hashtext('apcida_rag_knowledge'))");
    const result = await client.query(`SELECT id, content, label, embedding_model,
      md5(embedding::text) AS embedding_hash, approved_by, approved_at
      FROM rag_knowledge WHERE is_active = true AND approved_by IS NOT NULL
        AND approved_at <= now() ORDER BY id`);
    const references = evaluationRows.map((row) => ({ id: row.messageId, signature: signature(row.text) }));
    for (const row of result.rows) {
      const duplicate = findDuplicate({ signature: signature(row.content) }, references);
      if (duplicate) {
        throw new Error(`RAG evaluation blocked: active knowledge ID ${row.id} ${duplicate.kind} matches evaluation message ID ${duplicate.referenceId}`);
      }
    }
    const fingerprintRows = result.rows.map((row) => ({
      id: row.id,
      contentSha256: sha256(row.content),
      label: row.label,
      embeddingModel: row.embedding_model,
      embeddingHash: row.embedding_hash,
      approvedBy: row.approved_by,
      approvedAt: row.approved_at,
    }));
    return {
      fingerprint: sha256(JSON.stringify(fingerprintRows)),
      activeCount: result.rows.length,
      async release() {
        try {
          await client.query("SELECT pg_advisory_unlock_shared(hashtext('apcida_rag_knowledge'))");
        } finally {
          client.release();
        }
      },
    };
  } catch (error) {
    try {
      await client.query("SELECT pg_advisory_unlock_shared(hashtext('apcida_rag_knowledge'))");
    } finally {
      client.release();
    }
    throw error;
  }
}

module.exports = { lockAndCheckRagKnowledge };
