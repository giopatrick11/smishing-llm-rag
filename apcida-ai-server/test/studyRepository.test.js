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
      await pool.query(`INSERT INTO public.production_installations (installation_id, expires_at)
        VALUES ($1, now() + interval '1 day')`, [installationId]);
      const make = (start, count) => ({ batchId: randomUUID(), participantId,
        submittedAt: Date.now(), consentScope: 'STUDY_EVALUATION_ONLY',
        examinedCount: count, offeredCount: count,
        selectionMethod: 'RECENT_INBOX_PARTICIPANT_REVIEW',
        items: Array.from({ length: count }, (_, index) => ({
          clientId: (start + index).toString(16).padStart(64, '0'),
          text: `Research example ${start + index} [link]`,
          localSuggestion: 'UNVERIFIED', reviewedCategory: 'SAFE',
          reviewedAt: Date.now() - 1000,
        })) });
      const first = make(1, 20);
      const accepted = await repository.submit(installationId, first);
      assert.equal(accepted.kind, 'ACCEPTED');
      assert.equal(accepted.response.progress.totalAccepted, 20);
      assert.deepEqual((await repository.submit(installationId, first)).response, accepted.response);
      const second = await repository.submit(installationId, make(21, 20));
      assert.equal(second.response.progress.totalAccepted, 40);
      const overflow = await repository.submit(installationId, make(41, 1));
      assert.equal(overflow.response.rejectedClientIds.length, 1);
      assert.equal((await repository.progress(installationId, participantId)).totalAccepted, 40);
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
