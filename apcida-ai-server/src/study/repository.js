function createStudyRepository(pool, codec, { retentionDays = 365 } = {}) {
  if (!pool?.connect || !pool?.query || !codec?.studyHmac || !codec?.encryptStudy || !codec?.decryptStudy) {
    throw new TypeError('Study database and codec required');
  }
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) {
    throw new TypeError('Study retention must be 1-3650 days');
  }
  const progressSql = `SELECT c.participant_label, count(*)::integer AS total
    FROM study.contributions c JOIN study.participants p USING (participant_id)
    WHERE p.installation_id = $1 AND p.participant_id = $2
    GROUP BY c.participant_label`;
  async function progress(installationId, participantId, query = pool) {
    const owner = await query.query('SELECT installation_id FROM study.participants WHERE participant_id = $1', [participantId]);
    if (owner.rowCount && owner.rows[0].installation_id !== installationId) return null;
    const result = await query.query(progressSql, [installationId, participantId]);
    const counts = { scamAccepted: 0, safeAccepted: 0, totalAccepted: 0 };
    for (const row of result.rows) {
      if (row.participant_label === 'SCAM') counts.scamAccepted = row.total;
      if (row.participant_label === 'SAFE') counts.safeAccepted = row.total;
    }
    counts.totalAccepted = counts.scamAccepted + counts.safeAccepted;
    return counts;
  }

  return {
    progress,
    async submit(installationId, batch) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const active = await client.query(`SELECT installation_id FROM public.production_installations
          WHERE installation_id = $1 AND revoked_at IS NULL AND expires_at > now() FOR UPDATE`, [installationId]);
        if (!active.rowCount) { await client.query('ROLLBACK'); return { kind: 'UNAUTHORIZED' }; }
        const payloadHmac = codec.studyHmac(JSON.stringify(batch));
        const prior = await client.query('SELECT participant_id, payload_hmac, response FROM study.batches WHERE batch_id = $1', [batch.batchId]);
        if (prior.rowCount) {
          await client.query('COMMIT');
          return prior.rows[0].participant_id === batch.participantId &&
            prior.rows[0].payload_hmac === payloadHmac
            ? { kind: 'ACCEPTED', response: prior.rows[0].response } : { kind: 'CONFLICT' };
        }
        const withdrawal = await client.query('SELECT withdrawn_at FROM study.withdrawals WHERE installation_id = $1', [installationId]);
        if (withdrawal.rowCount && new Date(withdrawal.rows[0].withdrawn_at).getTime() >= batch.submittedAt) {
          await client.query('ROLLBACK'); return { kind: 'UNAUTHORIZED' };
        }
        const owner = await client.query('SELECT installation_id FROM study.participants WHERE participant_id = $1', [batch.participantId]);
        if (owner.rowCount && owner.rows[0].installation_id !== installationId) {
          await client.query('ROLLBACK'); return { kind: 'UNAUTHORIZED' };
        }
        const participant = await client.query(`INSERT INTO study.participants
          (participant_id, installation_id, consent_version, consented_at, expires_at)
          VALUES ($1, $2, 1, to_timestamp($3::double precision / 1000),
            now() + $4::integer * interval '1 day')
          ON CONFLICT (participant_id) DO UPDATE SET
            expires_at = GREATEST(study.participants.expires_at, excluded.expires_at)
          WHERE study.participants.installation_id = excluded.installation_id
          RETURNING participant_id`,
        [batch.participantId, installationId, batch.submittedAt, retentionDays]);
        if (!participant.rowCount) { await client.query('ROLLBACK'); return { kind: 'UNAUTHORIZED' }; }
        let counts = await progress(installationId, batch.participantId, client);
        const acceptedClientIds = [];
        const rejectedClientIds = [];
        for (const item of batch.items) {
          const normalized = item.text.toLowerCase().replace(/\s+/gu, ' ');
          const contentHmac = codec.studyHmac(normalized);
          const existing = await client.query(`SELECT client_id, content_hmac, participant_label
            FROM study.contributions
            WHERE participant_id = $1 AND (client_id = $2 OR content_hmac = $3) LIMIT 1`,
          [batch.participantId, item.clientId, contentHmac]);
          if (existing.rowCount) {
            if (existing.rows[0].client_id === item.clientId &&
              existing.rows[0].content_hmac === contentHmac &&
              existing.rows[0].participant_label === item.reviewedCategory) {
              acceptedClientIds.push(item.clientId);
            } else rejectedClientIds.push(item.clientId);
            continue;
          }
          if (counts.totalAccepted >= 40) { rejectedClientIds.push(item.clientId); continue; }
          await client.query(`INSERT INTO study.contributions
            (participant_id, client_id, content_hmac, content_encrypted, local_suggestion,
             participant_label, reviewed_at) VALUES ($1, $2, $3, $4, $5, $6,
             to_timestamp($7::double precision / 1000))`,
          [batch.participantId, item.clientId, contentHmac, codec.encryptStudy({ text: item.text }),
            item.localSuggestion, item.reviewedCategory, item.reviewedAt]);
          acceptedClientIds.push(item.clientId);
          counts = { ...counts, totalAccepted: counts.totalAccepted + 1,
            scamAccepted: counts.scamAccepted + (item.reviewedCategory === 'SCAM' ? 1 : 0),
            safeAccepted: counts.safeAccepted + (item.reviewedCategory === 'SAFE' ? 1 : 0) };
        }
        const response = { acceptedClientIds, rejectedClientIds, progress: counts };
        await client.query(`INSERT INTO study.batches
          (batch_id, participant_id, payload_hmac, response, examined_count, offered_count,
           selected_count, selection_method)
          VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)`,
        [batch.batchId, batch.participantId, payloadHmac, JSON.stringify(response),
          batch.examinedCount, batch.offeredCount, batch.items.length, batch.selectionMethod]);
        await client.query('COMMIT');
        return { kind: 'ACCEPTED', response };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally { client.release(); }
    },
    async withdraw(installationId) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT installation_id FROM public.production_installations WHERE installation_id = $1 FOR UPDATE',
          [installationId]);
        await client.query(`INSERT INTO study.withdrawals (installation_id, withdrawn_at)
          VALUES ($1, now()) ON CONFLICT (installation_id) DO UPDATE SET withdrawn_at = excluded.withdrawn_at`,
        [installationId]);
        await client.query('DELETE FROM study.participants WHERE installation_id = $1', [installationId]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK'); throw error;
      } finally { client.release(); }
    },
    async purgeExpired() {
      const result = await pool.query('DELETE FROM study.participants WHERE expires_at <= now()');
      return result.rowCount;
    },
    async stats() {
      const [result, selection] = await Promise.all([pool.query(`SELECT count(*)::integer AS total,
        count(*) FILTER (WHERE p.status = 'COMPLETED')::integer AS completed,
        count(*) FILTER (WHERE p.status = 'ERROR')::integer AS errors,
        count(*) FILTER (WHERE e.label IN ('SCAM', 'SAFE'))::integer AS expert_labeled
        FROM study.contributions c
        LEFT JOIN study.predictions p ON p.contribution_id = c.id
        LEFT JOIN study.expert_labels e ON e.contribution_id = c.id
        WHERE c.excluded_at IS NULL`), pool.query(`SELECT
        coalesce(sum(examined_count), 0)::integer AS examined,
        coalesce(sum(offered_count), 0)::integer AS offered,
        coalesce(sum(selected_count), 0)::integer AS selected
        FROM study.batches`)]);
      const excluded = await pool.query('SELECT count(*)::integer AS total FROM study.contributions WHERE excluded_at IS NOT NULL');
      return { ...result.rows[0], ...selection.rows[0], excluded: excluded.rows[0].total };
    },
    async list(page = 1) {
      const result = await pool.query(`SELECT c.id, c.participant_id, c.local_suggestion,
        c.participant_label, c.created_at, c.excluded_at, p.status AS prediction_status,
        e.label AS expert_label FROM study.contributions c
        LEFT JOIN study.predictions p ON p.contribution_id = c.id
        LEFT JOIN study.expert_labels e ON e.contribution_id = c.id
        ORDER BY c.id DESC LIMIT 50 OFFSET $1`, [(page - 1) * 50]);
      return result.rows;
    },
    async get(id) {
      const result = await pool.query(`SELECT c.id, c.participant_id, c.content_encrypted,
        c.local_suggestion, c.participant_label, c.created_at, c.excluded_at,
        p.status AS prediction_status, p.classification, p.confidence, p.error_code,
        p.model_name, p.model_digest, p.pipeline_sha256, p.knowledge_sha256,
        c.exclusion_reason,
        e.label AS expert_label, e.reviewer, e.reviewed_at AS expert_reviewed_at
        FROM study.contributions c
        LEFT JOIN study.predictions p ON p.contribution_id = c.id
        LEFT JOIN study.expert_labels e ON e.contribution_id = c.id WHERE c.id = $1`, [id]);
      if (!result.rowCount) return null;
      const row = result.rows[0];
      return { ...row, text: codec.decryptStudy(row.content_encrypted).text, content_encrypted: undefined };
    },
    async label(id, label, reviewer) {
      const result = await pool.query(`INSERT INTO study.expert_labels (contribution_id, label, reviewer)
        SELECT id, $2, $3 FROM study.contributions WHERE id = $1 AND excluded_at IS NULL
        ON CONFLICT DO NOTHING RETURNING contribution_id`, [id, label, reviewer]);
      return result.rowCount === 1;
    },
    async queueNext(limit, { model, modelDigest, pipelineHash, knowledgeHash }) {
      const result = await pool.query(`WITH next AS (
        SELECT c.id FROM study.contributions c LEFT JOIN study.predictions p ON p.contribution_id = c.id
        WHERE c.excluded_at IS NULL AND p.contribution_id IS NULL
        ORDER BY c.id LIMIT $1 FOR UPDATE OF c SKIP LOCKED
      ) INSERT INTO study.predictions
        (contribution_id, batch_id, status, model_name, model_digest, pipeline_sha256, knowledge_sha256)
        SELECT id, $2, 'QUEUED', $3, $4, $5, $6 FROM next ON CONFLICT DO NOTHING
        RETURNING contribution_id`, [limit, require('node:crypto').randomUUID(), model,
          modelDigest, pipelineHash, knowledgeHash]);
      return result.rows.map((row) => row.contribution_id);
    },
    async resetRunning() {
      await pool.query("UPDATE study.predictions SET status = 'QUEUED', started_at = NULL WHERE status = 'RUNNING'");
    },
    async hasQueued() {
      const result = await pool.query("SELECT 1 FROM study.predictions WHERE status = 'QUEUED' LIMIT 1");
      return result.rowCount > 0;
    },
    async claimQueued() {
      const result = await pool.query(`WITH next AS (
        SELECT contribution_id FROM study.predictions WHERE status = 'QUEUED'
        ORDER BY contribution_id LIMIT 1 FOR UPDATE SKIP LOCKED
      ) UPDATE study.predictions p SET status = 'RUNNING', started_at = now()
        FROM next WHERE p.contribution_id = next.contribution_id
        RETURNING p.contribution_id`, []);
      if (!result.rowCount) return null;
      return this.get(result.rows[0].contribution_id);
    },
    async finish(id, result, errorCode = null) {
      await pool.query(`UPDATE study.predictions SET status = $2, classification = $3,
        confidence = $4, error_code = $5, finished_at = now()
        WHERE contribution_id = $1 AND status = 'RUNNING'`,
      [id, errorCode ? 'ERROR' : 'COMPLETED', errorCode ? null : result.classification,
        errorCode ? null : result.confidence, errorCode]);
    },
    async requeue(id) {
      await pool.query("UPDATE study.predictions SET status = 'QUEUED', started_at = NULL WHERE contribution_id = $1 AND status = 'RUNNING'", [id]);
    },
    async exclude(id, reason) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`UPDATE study.contributions SET excluded_at = now(), exclusion_reason = $2
          WHERE id = $1 AND excluded_at IS NULL`, [id, reason]);
        await client.query(`UPDATE study.predictions SET status = 'ERROR', error_code = $2,
          classification = NULL, confidence = NULL, finished_at = now()
          WHERE contribution_id = $1 AND status = 'RUNNING'`, [id, reason]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally { client.release(); }
    },
    async comparison() {
      const result = await pool.query(`SELECT e.label AS expert_label, p.status, p.classification,
        count(*)::integer AS total FROM study.contributions c
        JOIN study.expert_labels e ON e.contribution_id = c.id
        JOIN study.predictions p ON p.contribution_id = c.id
        WHERE c.excluded_at IS NULL GROUP BY e.label, p.status, p.classification`);
      return result.rows;
    },
    async exportRows() {
      const result = await pool.query(`SELECT c.id, c.participant_id, c.local_suggestion,
        c.participant_label, c.created_at, p.status, p.classification, p.confidence,
        p.error_code, p.model_name, p.model_digest, p.pipeline_sha256, p.knowledge_sha256,
        e.label AS expert_label, e.reviewer, e.reviewed_at AS expert_reviewed_at
        FROM study.contributions c
        LEFT JOIN study.predictions p ON p.contribution_id = c.id
        LEFT JOIN study.expert_labels e ON e.contribution_id = c.id
        WHERE c.excluded_at IS NULL ORDER BY c.id`);
      return result.rows;
    },
  };
}

module.exports = { createStudyRepository };
