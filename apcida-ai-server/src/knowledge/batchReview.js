const { signature, findDuplicate } = require('./dedupe');
const { withWriteTransaction } = require('./adminRepository');
const { EMBEDDING_MODEL } = require('../services/embeddings');

function validatePage(page, pageSize) {
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 20) {
    throw new Error('Page must be positive and page size must be 1 to 20');
  }
}

function referenceSignatures(activeRows, stagedRows) {
  return [
    ...activeRows.map((row) => ({ id: `active-${row.id}`, signature: signature(row.content) })),
    ...stagedRows.map((row) => ({ id: `staged-${row.id}`, signature: signature(row.content) })),
  ];
}

function checkStagedEntry(row, references, corpus) {
  const problems = [];
  const validText = typeof row.content === 'string' && row.content.trim().length > 0 && row.content.length <= 2000;
  let currentSignature;
  if (validText) {
    try { currentSignature = signature(row.content); } catch { /* reported below */ }
  }
  if (!currentSignature) problems.push('INVALID_CONTENT');
  if (typeof row.external_id !== 'string' || !row.external_id.trim() || row.external_id.length > 128) problems.push('INVALID_MESSAGE_ID');
  if (!['SCAM', 'SAFE'].includes(row.label)) problems.push('INVALID_LABEL');
  if (typeof row.reviewer !== 'string' || !row.reviewer.trim() || row.reviewer.length > 100
    || !(row.reviewed_at instanceof Date) || !Number.isFinite(row.reviewed_at.getTime())
    || typeof row.source_reference !== 'string' || !row.source_reference.trim() || row.source_reference.length > 200) {
    problems.push('INVALID_REVIEW_METADATA');
  }
  if (row.status !== 'PENDING_APPROVAL' || !row.has_embedding || row.embedding_model !== EMBEDDING_MODEL
    || row.embedding_error || !(row.embedded_at instanceof Date) || !Number.isFinite(row.embedded_at.getTime())) {
    problems.push('NOT_READY_FOR_APPROVAL');
  }
  if (currentSignature && row.normalized_hash !== currentSignature.hash) problems.push('CONTENT_HASH_MISMATCH');
  if (!row.evaluation_corpus_sha256) problems.push('CORPUS_UNCHECKED');
  else if (row.evaluation_corpus_sha256 !== corpus.sha256) problems.push('CORPUS_MISMATCH');
  if (currentSignature) {
    const candidate = { signature: currentSignature };
    const contaminated = findDuplicate(candidate, corpus.entries);
    if (contaminated) problems.push(`EVALUATION_${contaminated.kind}`);
    const otherReferences = references.filter((reference) => reference.id !== `staged-${row.id}`);
    const duplicate = findDuplicate(candidate, otherReferences);
    if (duplicate) problems.push(`KNOWLEDGE_${duplicate.kind}`);
  }
  return problems;
}

async function loadReferences(client) {
  const [active, staged] = await Promise.all([
    client.query('SELECT id, content FROM rag_knowledge'),
    client.query('SELECT id, content FROM rag_knowledge_staging'),
  ]);
  return referenceSignatures(active.rows, staged.rows);
}

const REVIEW_COLUMNS = `id, external_id, content, label, reviewer, reviewed_at,
  source_reference, normalized_hash, evaluation_corpus_sha256, status,
  embedding_model, embedding_error, embedded_at, embedding IS NOT NULL AS has_embedding`;

async function getReviewPage(pool, { page = 1, pageSize = 10, corpus }) {
  validatePage(page, pageSize);
  if (!corpus) throw new Error('Evaluation corpus is required for batch review');
  const count = await pool.query(`SELECT count(*)::integer AS total FROM rag_knowledge_staging
    WHERE status IN ('PENDING_EMBEDDING', 'PENDING_APPROVAL')`);
  const total = count.rows[0].total;
  const pages = Math.ceil(total / pageSize);
  if (total > 0 && page > pages) throw new Error(`Page ${page} is beyond the ${pages} pending pages`);
  const result = await pool.query(`SELECT ${REVIEW_COLUMNS} FROM rag_knowledge_staging
    WHERE status IN ('PENDING_EMBEDDING', 'PENDING_APPROVAL')
    ORDER BY id LIMIT $1 OFFSET $2`, [pageSize, (page - 1) * pageSize]);
  const references = await loadReferences(pool);
  return {
    page, pageSize, pages, total,
    entries: result.rows.map((row) => ({
      ...row,
      duplicateCheckStatus: checkStagedEntry(row, references, corpus),
    })),
  };
}

async function approveBatch(pool, ids, approver, corpus) {
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 20
    || ids.some((id) => !/^\d+$/.test(String(id))) || new Set(ids.map(String)).size !== ids.length) {
    throw new Error('Select 1 to 20 distinct staged IDs');
  }
  if (typeof approver !== 'string' || !approver.trim() || approver.length > 100) throw new Error('Administrator identity is required');
  if (!corpus) throw new Error('Evaluation corpus is required for batch approval');
  return withWriteTransaction(pool, async (client) => {
    const selected = await client.query(`SELECT ${REVIEW_COLUMNS}, embedding::text AS embedding_text
      FROM rag_knowledge_staging WHERE id = ANY($1::bigint[]) ORDER BY id FOR UPDATE`, [ids]);
    if (selected.rows.length !== ids.length) throw new Error('One or more selected entries no longer exist');
    const references = await loadReferences(client);
    for (const row of selected.rows) {
      const problems = checkStagedEntry(row, references, corpus);
      if (!row.embedding_text || problems.length) {
        throw new Error(`Staged ID ${row.id} cannot be approved: ${problems.join(', ') || 'NOT_EMBEDDED'}`);
      }
    }
    return insertApprovedRows(client, selected.rows, approver);
  });
}

async function insertApprovedRows(client, rows, approver) {
  const approved = [];
  for (const row of rows) {
    const inserted = await client.query(`INSERT INTO rag_knowledge
      (content, label, embedding, embedding_model, source_type, source_reference,
       normalized_hash, approved_by, approved_at)
      VALUES ($1, $2, $3::vector, $4, 'CURATED', $5, $6, $7, now()) RETURNING id`, [
      row.content, row.label, row.embedding_text, EMBEDDING_MODEL,
      row.source_reference, row.normalized_hash, approver.trim(),
    ]);
    const activeId = inserted.rows[0].id;
    await client.query(`UPDATE rag_knowledge_staging
      SET status = 'APPROVED', approved_by = $2, approved_at = now(), active_knowledge_id = $3
      WHERE id = $1`, [row.id, approver.trim(), activeId]);
    approved.push({ stagedId: row.id, activeId });
  }
  return approved;
}

function parseSelectedIds(answer, pageEntries) {
  const trimmed = answer.trim();
  if (!trimmed) return [];
  const ids = trimmed.split(',').map((item) => item.trim());
  const allowed = new Set(pageEntries.map((entry) => String(entry.id)));
  if (ids.length > 20 || ids.some((id) => !/^\d+$/.test(id) || !allowed.has(id)) || new Set(ids).size !== ids.length) {
    throw new Error('Select distinct numeric IDs shown on this page, separated by commas');
  }
  return ids;
}

module.exports = {
  getReviewPage, approveBatch, checkStagedEntry, parseSelectedIds, validatePage,
  loadReferences, REVIEW_COLUMNS, insertApprovedRows,
};
