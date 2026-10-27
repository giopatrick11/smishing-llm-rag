const { withWriteTransaction } = require('./adminRepository');
const { checkStagedEntry, loadReferences, REVIEW_COLUMNS, insertApprovedRows } = require('./batchReview');

async function getApproveAllPreview(pool, corpus) {
  if (!corpus) throw new Error('Evaluation corpus is required for approve-all');
  const result = await pool.query(`SELECT ${REVIEW_COLUMNS} FROM rag_knowledge_staging
    WHERE status = 'PENDING_APPROVAL' ORDER BY id`);
  const references = await loadReferences(pool);
  const entries = result.rows.map((row) => ({
    id: String(row.id),
    problems: checkStagedEntry(row, references, corpus),
  }));
  return {
    pendingCount: entries.length,
    eligibleIds: entries.filter((entry) => !entry.problems.length).map((entry) => entry.id),
    blocked: entries.filter((entry) => entry.problems.length),
    snapshotIds: entries.map((entry) => entry.id),
  };
}

function parseIds(input, allowedIds) {
  if (!input.trim()) return [];
  const ids = input.split(',').map((value) => value.trim());
  const allowed = new Set(allowedIds.map(String));
  if (ids.some((id) => !/^\d+$/.test(id) || !allowed.has(id)) || new Set(ids).size !== ids.length) {
    throw new Error('Use distinct staged IDs from the displayed pending set');
  }
  return ids;
}

function createApprovalPlan(preview, excludedIds, rejectedIds, rejectionReason = null) {
  const pending = new Set(preview.snapshotIds);
  const excluded = new Set(excludedIds);
  const rejected = new Set(rejectedIds);
  if (excluded.size !== excludedIds.length || rejected.size !== rejectedIds.length
    || [...excluded, ...rejected].some((id) => !pending.has(id))
    || [...excluded].some((id) => rejected.has(id))) {
    throw new Error('Excluded and rejected IDs must be distinct pending entries');
  }
  if (rejected.size && (!rejectionReason || !rejectionReason.trim() || rejectionReason.length > 300)) {
    throw new Error('A short rejection reason is required');
  }
  const unresolved = preview.blocked.filter((entry) => !excluded.has(entry.id) && !rejected.has(entry.id));
  if (unresolved.length) throw new Error(`Blocked IDs must be excluded or rejected: ${unresolved.map((entry) => entry.id).join(', ')}`);
  const approveIds = preview.eligibleIds.filter((id) => !excluded.has(id) && !rejected.has(id));
  if (!approveIds.length && !rejected.size) throw new Error('No entries selected for approval or rejection');
  return {
    snapshotIds: preview.snapshotIds,
    approveIds,
    excludeIds: excludedIds,
    rejectIds: rejectedIds,
    rejectionReason: rejected.size ? rejectionReason.trim() : null,
  };
}

async function applyApproveAll(pool, plan, approver, corpus) {
  if (!corpus) throw new Error('Evaluation corpus is required for approve-all');
  if (typeof approver !== 'string' || !approver.trim() || approver.length > 100) throw new Error('Administrator identity is required');
  return withWriteTransaction(pool, async (client) => {
    const result = await client.query(`SELECT ${REVIEW_COLUMNS}, embedding::text AS embedding_text
      FROM rag_knowledge_staging WHERE status = 'PENDING_APPROVAL' ORDER BY id FOR UPDATE`);
    const rows = result.rows;
    const currentIds = rows.map((row) => String(row.id));
    if (currentIds.length !== plan.snapshotIds.length || currentIds.some((id, index) => id !== plan.snapshotIds[index])) {
      throw new Error('Pending entries changed since preview; run approve-all again');
    }
    const approvedSet = new Set(plan.approveIds);
    const rejectedSet = new Set(plan.rejectIds);
    const excludedSet = new Set(plan.excludeIds);
    if (approvedSet.size !== plan.approveIds.length || rejectedSet.size !== plan.rejectIds.length
      || excludedSet.size !== plan.excludeIds.length
      || [...approvedSet, ...rejectedSet, ...excludedSet].some((id) => !currentIds.includes(id))
      || approvedSet.size + rejectedSet.size + excludedSet.size !== currentIds.length
      || [...approvedSet].some((id) => rejectedSet.has(id) || excludedSet.has(id))
      || [...rejectedSet].some((id) => excludedSet.has(id))) {
      throw new Error('Approval plan contains invalid or overlapping IDs');
    }
    if (rejectedSet.size && (!plan.rejectionReason || !plan.rejectionReason.trim() || plan.rejectionReason.length > 300)) {
      throw new Error('A short rejection reason is required');
    }
    const references = await loadReferences(client);
    const approvedRows = rows.filter((row) => approvedSet.has(String(row.id)));
    for (const row of approvedRows) {
      const problems = checkStagedEntry(row, references, corpus);
      if (!row.embedding_text || problems.length) {
        throw new Error(`Staged ID ${row.id} cannot be approved: ${problems.join(', ') || 'NOT_EMBEDDED'}`);
      }
    }
    if (rejectedSet.size) {
      const rejected = await client.query(`UPDATE rag_knowledge_staging
        SET status = 'REJECTED', approved_by = $2, approved_at = now(), rejection_reason = $3
        WHERE id = ANY($1::bigint[]) AND status = 'PENDING_APPROVAL'`, [
        [...rejectedSet], approver.trim(), plan.rejectionReason,
      ]);
      if (rejected.rowCount !== rejectedSet.size) throw new Error('Some rejected entries changed during approval');
    }
    const approved = await insertApprovedRows(client, approvedRows, approver);
    return { approved: approved.length, rejected: rejectedSet.size, excluded: excludedSet.size };
  });
}

module.exports = { getApproveAllPreview, parseIds, createApprovalPlan, applyApproveAll };
