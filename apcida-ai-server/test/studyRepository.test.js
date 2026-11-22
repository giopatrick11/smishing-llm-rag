const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { createPrivacyCodec } = require('../src/production/privacy');
const { createStudyRepository } = require('../src/study/repository');

test('disposable PostgreSQL stores consented batches, enforces quota, and deletes on withdrawal',
  { skip: !process.env.STUDY_TEST_DB_URL }, async () => {
    const url = new URL(process.env.STUDY_TEST_DB_URL);
    assert.equal(url.hostname, '127.0.0.1');
    assert.equal(url.pathname, '/apcida_study_test');
    const pool = new Pool({ connectionString: url.toString() });
    const codec = createPrivacyCodec('15'.repeat(32));
    const repository = createStudyRepository(pool, codec, { retentionDays: 365 });
    const installationId = randomUUID();
    const participantId = randomUUID();
    try {
      await pool.query(`CREATE TABLE public.production_installations (
        installation_id uuid PRIMARY KEY, revoked_at timestamptz, expires_at timestamptz NOT NULL)`);
      await pool.query(fs.readFileSync(path.join(__dirname,
        '../src/db/migrations/009_study_contributions.sql'), 'utf8'));
      const oldInstallationId = randomUUID();
      const oldParticipantId = randomUUID();
      await pool.query(`INSERT INTO public.production_installations (installation_id, expires_at)
        VALUES ($1, now() + interval '1 day')`, [oldInstallationId]);
      await pool.query(`INSERT INTO study.participants
        (participant_id, installation_id, consent_version, consented_at, expires_at)
        VALUES ($1, $2, 1, now(), now() + interval '1 day')`, [oldParticipantId, oldInstallationId]);
      await pool.query(`INSERT INTO study.contributions
        (participant_id, client_id, content_hmac, content_encrypted, local_suggestion,
         participant_label, reviewed_at) VALUES ($1, $2, $3, $4, 'UNVERIFIED', 'SCAM', now())`,
      [oldParticipantId, 'f'.repeat(64), 'e'.repeat(64),
        codec.encryptStudy({ text: 'Earlier reviewed message' })]);
      await pool.query(fs.readFileSync(path.join(__dirname,
        '../src/db/migrations/010_unlabeled_study_contributions.sql'), 'utf8'));
      const preserved = await pool.query(`SELECT legacy_participant_label
        FROM study.contributions WHERE participant_id = $1`, [oldParticipantId]);
      assert.equal(preserved.rows[0].legacy_participant_label, 'SCAM');
      await pool.query('DELETE FROM public.production_installations WHERE installation_id = $1', [oldInstallationId]);
      await pool.query(`INSERT INTO public.production_installations (installation_id, expires_at)
        VALUES ($1, now() + interval '1 day')`, [installationId]);
      const make = (start, count) => ({ batchId: randomUUID(), participantId,
        submittedAt: Date.now(), consentScope: 'STUDY_EVALUATION_ONLY',
        examinedCount: count, offeredCount: count,
        selectionMethod: 'RECENT_INBOX_PARTICIPANT_REVIEW',
        items: Array.from({ length: count }, (_, index) => ({
          clientId: (start + index).toString(16).padStart(64, '0'),
          text: `Research example ${start + index} [link]`,
          localSuggestion: 'UNVERIFIED',
          reviewedAt: Date.now() - 1000,
        })) });
      const first = make(1, 20);
      const accepted = await repository.submit(installationId, first);
      assert.equal(accepted.kind, 'ACCEPTED');
      assert.equal(accepted.response.progress.totalAccepted, 20);
      assert.deepEqual(Object.keys(accepted.response.progress), ['totalAccepted']);
      assert.deepEqual((await repository.submit(installationId, first)).response, accepted.response);
      const second = await repository.submit(installationId, make(21, 20));
      assert.equal(second.response.progress.totalAccepted, 40);
      const overflow = await repository.submit(installationId, make(41, 1));
      assert.equal(overflow.response.rejectedClientIds.length, 1);
      assert.equal((await repository.progress(installationId, participantId)).totalAccepted, 40);
      const unlabeled = await pool.query('SELECT count(*)::integer AS total FROM study.contributions WHERE legacy_participant_label IS NULL');
      assert.equal(unlabeled.rows[0].total, 40);
      const queued = await repository.queueNext(10, { model: 'gemma3:12b',
        modelDigest: 'test-digest', pipelineHash: 'a'.repeat(64), knowledgeHash: 'b'.repeat(64) });
      assert.equal(queued.length, 10);
      const item = await repository.claimQueued();
      assert.equal(item.text, 'Research example 1 [link]');
      await repository.finish(item.id, { classification: 'SAFE', confidence: 'HIGH' });
      assert.equal(await repository.label(item.id, 'SAFE', 'Expert'), true);
      assert.equal(await repository.label(item.id, 'SCAM', 'Other'), false);
      assert.equal((await repository.comparison())[0].total, 1);
      assert.equal((await repository.stats()).total, 40);
      const overlap = await repository.claimQueued();
      await repository.exclude(overlap.id, 'RAG_OVERLAP_EXACT');
      assert.equal((await repository.stats()).total, 39);
      assert.equal((await repository.stats()).excluded, 1);
      assert.equal((await repository.get(overlap.id)).exclusion_reason, 'RAG_OVERLAP_EXACT');
      await repository.withdraw(installationId);
      assert.equal((await repository.progress(installationId, participantId)).totalAccepted, 0);
      assert.equal((await repository.list()).length, 0);
      assert.equal((await repository.submit(installationId, first)).kind, 'UNAUTHORIZED');
    } finally { await pool.end(); }
  });
