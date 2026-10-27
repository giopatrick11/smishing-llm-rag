const { signature, findDuplicate } = require('./dedupe');
const { vectorLiteral } = require('../db/knowledgeRepository');
const { EMBEDDING_MODEL } = require('../services/embeddings');

async function withWriteTransaction(pool, action) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const lock = await client.query("SELECT pg_try_advisory_xact_lock(hashtext('apcida_rag_knowledge')) AS locked");
    if (!lock.rows[0].locked) throw new Error('Knowledge is locked by another import, approval, or RAG evaluation');
    const result = await action(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function knowledgeEntries(client) {
  const result = await client.query('SELECT id, content FROM rag_knowledge');
  return result.rows.map((row) => ({ id: `active-${row.id}`, signature: signature(row.content) }));
}

async function stageImport(pool, rows, evaluationCorpus = null) {
  return withWriteTransaction(pool, async (client) => {
    const existing = await client.query('SELECT id, external_id, content, status FROM rag_knowledge_staging');
    const references = [
      ...await knowledgeEntries(client),
      ...existing.rows.map((row) => ({ id: `staged-${row.id}`, signature: signature(row.content) })),
    ];
    const existingIds = new Set(existing.rows.map((row) => row.external_id));
    const candidates = [];
    for (const row of rows) {
      if (existingIds.has(row.externalId)) throw new Error(`Import row ${row.rowNumber} has an existing external_id`);
      const candidate = { id: `import-row-${row.rowNumber}`, signature: row.signature };
      const contamination = evaluationCorpus && findDuplicate(candidate, evaluationCorpus.entries);
      if (contamination) throw new Error(`Import row ${row.rowNumber} matches the evaluation corpus (${contamination.kind})`);
      const duplicate = findDuplicate(candidate, references);
      if (duplicate) throw new Error(`Import row ${row.rowNumber} duplicates existing knowledge (${duplicate.kind})`);
      references.push(candidate);
      candidates.push(row);
    }
    const ids = [];
    for (const row of candidates) {
      const inserted = await client.query(`INSERT INTO rag_knowledge_staging
        (external_id, content, label, reviewer, reviewed_at, source_reference, normalized_hash, evaluation_corpus_sha256)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`, [
        row.externalId, row.content, row.label, row.reviewer, row.reviewedAt,
        row.sourceReference, row.signature.hash, evaluationCorpus?.sha256 || null,
      ]);
      ids.push(inserted.rows[0].id);
    }
    return ids;
  });
}

async function embedPending(pool, embeddingService, ids = null) {
  const lockClient = await pool.connect();
  let locked = false;
  try {
    const lock = await lockClient.query("SELECT pg_try_advisory_lock(hashtext('apcida_rag_embedding')) AS locked");
    locked = lock.rows[0].locked;
    if (!locked) throw new Error('Another embedding command is already running');
    return await embedPendingLocked(pool, embeddingService, ids);
  } finally {
    try {
      if (locked) await lockClient.query("SELECT pg_advisory_unlock(hashtext('apcida_rag_embedding'))");
    } finally {
      lockClient.release();
    }
  }
}

async function embedPendingLocked(pool, embeddingService, ids) {
  const pending = await pool.query(`SELECT id, content FROM rag_knowledge_staging
    WHERE status = 'PENDING_EMBEDDING' AND ($1::bigint[] IS NULL OR id = ANY($1::bigint[]))
    ORDER BY id`, [ids]);
  let attempted = 0;
  let embedded = 0;
  let error = null;
  for (const row of pending.rows) {
    attempted += 1;
    try {
      const vector = await embeddingService.embed(row.content);
      const updated = await pool.query(`UPDATE rag_knowledge_staging
        SET embedding = $2::vector, embedding_model = $3, status = 'PENDING_APPROVAL',
          embedding_error = NULL, embedded_at = now()
        WHERE id = $1 AND status = 'PENDING_EMBEDDING'`, [row.id, vectorLiteral(vector), EMBEDDING_MODEL]);
      if (updated.rowCount === 1) embedded += 1;
    } catch (cause) {
      error = cause.code || 'EMBEDDING_ERROR';
      await pool.query(`UPDATE rag_knowledge_staging SET embedding_error = $2
        WHERE id = $1 AND status = 'PENDING_EMBEDDING'`, [row.id, error]);
      break;
    }
  }
  return { queued: pending.rows.length, attempted, embedded, error };
}

async function listPending(pool) {
  const result = await pool.query(`SELECT id, external_id, label, reviewer, reviewed_at,
    source_reference, status, embedding_error, evaluation_corpus_sha256
    FROM rag_knowledge_staging
    WHERE status IN ('PENDING_EMBEDDING', 'PENDING_APPROVAL') ORDER BY id`);
  return result.rows;
}

async function showEntry(pool, id) {
  const result = await pool.query(`SELECT id, external_id, content, label, reviewer, reviewed_at,
    source_reference, status, embedding_error, evaluation_corpus_sha256
    FROM rag_knowledge_staging WHERE id = $1`, [id]);
  if (!result.rows.length) throw new Error('Staged knowledge ID not found');
  return result.rows[0];
}

async function approveEntry(pool, id, approver) {
  return withWriteTransaction(pool, async (client) => {
    const staged = await client.query(`SELECT id, content, label, source_reference, normalized_hash,
      embedding::text AS embedding_text, status
      FROM rag_knowledge_staging WHERE id = $1 FOR UPDATE`, [id]);
    const row = staged.rows[0];
    if (!row || row.status !== 'PENDING_APPROVAL' || !row.embedding_text) {
      throw new Error('Entry is not ready for manual approval');
    }
    const duplicate = findDuplicate({ signature: signature(row.content) }, await knowledgeEntries(client));
    if (duplicate) throw new Error(`Entry duplicates active knowledge (${duplicate.kind})`);
    const inserted = await client.query(`INSERT INTO rag_knowledge
      (content, label, embedding, embedding_model, source_type, source_reference,
       normalized_hash, approved_by, approved_at)
      VALUES ($1, $2, $3::vector, $4, 'CURATED', $5, $6, $7, now()) RETURNING id`, [
      row.content, row.label, row.embedding_text, EMBEDDING_MODEL,
      row.source_reference, row.normalized_hash, approver,
    ]);
    const activeId = inserted.rows[0].id;
    await client.query(`UPDATE rag_knowledge_staging
      SET status = 'APPROVED', approved_by = $2, approved_at = now(), active_knowledge_id = $3
      WHERE id = $1`, [id, approver, activeId]);
    return activeId;
  });
}

async function rejectEntry(pool, id, approver, reason) {
  return withWriteTransaction(pool, async (client) => {
    const result = await client.query(`UPDATE rag_knowledge_staging
      SET status = 'REJECTED', approved_by = $2, approved_at = now(), rejection_reason = $3
      WHERE id = $1 AND status IN ('PENDING_EMBEDDING', 'PENDING_APPROVAL')`, [id, approver, reason]);
    if (result.rowCount !== 1) throw new Error('Entry is not pending');
  });
}

async function countActive(pool) {
  const result = await pool.query(`SELECT count(*)::integer AS count FROM rag_knowledge
    WHERE is_active = true AND approved_by IS NOT NULL AND approved_at <= now()`);
  return result.rows[0].count;
}

module.exports = {
  stageImport, embedPending, listPending, showEntry, approveEntry, rejectEntry,
  countActive, knowledgeEntries, withWriteTransaction,
};
