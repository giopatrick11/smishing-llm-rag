const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { createProductionRepository, checkProductionRepository } = require('../src/production/repository');
const { createPrivacyCodec } = require('../src/production/privacy');
const { issueInstallationCredential } = require('../src/production/security');

const url = process.env.APCIDA_TEST_DATABASE_URL;
const messageId = '6d5f9250-3a47-42a8-a06b-68f0b8a82691';

test('isolated PostgreSQL repository persists claims, encrypted replay, rate limits and recovery',
  { skip: !url }, async () => {
    const pool = new Pool({ connectionString: url, max: 3 });
    let reopened;
    try {
      await pool.query(fs.readFileSync(path.join(__dirname,
        '../src/db/migrations/004_production_inference.sql'), 'utf8'));
      await pool.query(fs.readFileSync(path.join(__dirname,
        '../src/db/migrations/007_production_reports.sql'), 'utf8'));
      await checkProductionRepository(pool);
      const repo = createProductionRepository(pool);
      const { tokenHash } = issueInstallationCredential();
      const installationId = randomUUID();
      await repo.createInstallation({ installationId, label: 'SyntheticDbTest', tokenHash,
        expiresAt: Date.now() + 86400000 });
      assert.equal((await repo.findByTokenHash(tokenHash)).installationId, installationId);
      assert.equal(await repo.countRequest(installationId, 2), true);
      assert.equal(await repo.countRequest(installationId, 2), true);
      assert.equal(await repo.countRequest(installationId, 2), false);
      const slotOwner = randomUUID();
      assert.equal(await repo.acquireSlot(slotOwner, 300), true);
      assert.equal(await repo.acquireSlot(randomUUID(), 300), false);
      await repo.releaseSlot(slotOwner);
      assert.equal(await repo.acquireSlot(slotOwner, 300), true);
      await pool.query(`UPDATE production_inference_slot
        SET lease_until = now() - interval '1 second' WHERE slot_id = 1`);
      const recoveredSlotOwner = randomUUID();
      assert.equal(await repo.acquireSlot(recoveredSlotOwner, 300), true);
      await repo.releaseSlot(slotOwner);
      assert.equal(await repo.acquireSlot(randomUUID(), 300), false);
      await repo.releaseSlot(recoveredSlotOwner);

      const codec = createPrivacyCodec('1a'.repeat(32));
      const report = { clientReportId: randomUUID(), reportType: 'Scam was not detected',
        remarks: 'Synthetic review', smsText: 'Synthetic private message',
        consentScope: 'REVIEW_AND_RAG_CANDIDATE', observedVerdict: 'SAFE', riskScore: 0 };
      const submission = { installationId, clientReportId: report.clientReportId,
        contentHmac: codec.reportHmac(report), encrypted: codec.encryptReport(report) };
      assert.equal(await repo.submitReport(submission), 'CREATED');
      assert.equal(await repo.submitReport(submission), 'REPLAY');
      assert.equal(await repo.submitReport({ ...submission,
        contentHmac: codec.reportHmac({ ...report, remarks: 'Changed' }) }), 'CONFLICT');
      const savedReport = await pool.query(`SELECT content_encrypted FROM production_reports
        WHERE installation_id = $1 AND client_report_id = $2`, [installationId, report.clientReportId]);
      assert.equal(savedReport.rows[0].content_encrypted.includes(Buffer.from(report.smsText)), false);
      assert.deepEqual(codec.decryptReport(savedReport.rows[0].content_encrypted), report);
      for (let index = 0; index < 19; index += 1) {
        const next = { ...report, clientReportId: randomUUID(), smsText: `Synthetic message ${index}` };
        assert.equal(await repo.submitReport({ installationId,
          clientReportId: next.clientReportId, contentHmac: codec.reportHmac(next),
          encrypted: codec.encryptReport(next) }), 'CREATED');
      }
      assert.equal(await repo.submitReport({ installationId, clientReportId: randomUUID(),
        contentHmac: codec.reportHmac(report), encrypted: codec.encryptReport(report) }), 'RATE_LIMITED');
      assert.equal(await repo.submitReport(submission), 'REPLAY');
      await pool.query(`UPDATE production_reports SET expires_at = now() - interval '1 second'
        WHERE installation_id = $1 AND client_report_id = $2`, [installationId, report.clientReportId]);
      assert.equal((await repo.purge(3600)).reports, 1);
      const sms = { messageId, sender: 'ManualTest', text: 'Synthetic database SMS',
        receivedAt: '2026-10-28T00:00:00Z' };
      const requestHmac = codec.requestHmac(sms);
      const first = { installationId, messageId, requestHmac,
        leaseOwner: randomUUID(), leaseSeconds: 300, retentionSeconds: 3600 };
      const simultaneous = await Promise.all([
        repo.claim(first), repo.claim({ ...first, leaseOwner: randomUUID() }),
      ]);
      assert.deepEqual(simultaneous.map((item) => item.kind).sort(), ['BUSY', 'CLAIMED']);
      assert.equal((await repo.claim({ ...first, leaseOwner: randomUUID(),
        requestHmac: codec.requestHmac({ ...sms, text: 'Changed synthetic text' }) })).kind, 'CONFLICT');
      const answer = { messageId, classification: 'SCAM', confidence: 'HIGH', rationale: 'Mock warning' };
      assert.equal(await repo.complete({ installationId, messageId,
        leaseOwner: first.leaseOwner, encrypted: codec.encrypt(answer) }), true);
      const stored = await pool.query(`SELECT response_encrypted, request_hmac FROM production_inference_requests
        WHERE installation_id = $1 AND message_id = $2`, [installationId, messageId]);
      assert.equal(stored.rows[0].response_encrypted.includes(Buffer.from(sms.text)), false);
      assert.equal(stored.rows[0].response_encrypted.includes(Buffer.from(answer.rationale)), false);
      assert.equal(stored.rows[0].request_hmac, requestHmac);
      const columns = await pool.query(`SELECT column_name FROM information_schema.columns
        WHERE table_name = 'production_inference_requests'`);
      assert.equal(columns.rows.some((row) => ['text', 'sender', 'sms_body'].includes(row.column_name)), false);

      await pool.end();
      reopened = new Pool({ connectionString: url, max: 2 });
      const afterRestart = createProductionRepository(reopened);
      assert.equal(await afterRestart.countRequest(installationId, 2), false);
      const replay = await afterRestart.claim({ ...first, leaseOwner: randomUUID() });
      assert.equal(replay.kind, 'REPLAY');
      assert.deepEqual(codec.decrypt(replay.encrypted), answer);

      const staleId = randomUUID();
      const old = { ...first, messageId: staleId, leaseOwner: randomUUID() };
      assert.equal((await afterRestart.claim(old)).kind, 'CLAIMED');
      await reopened.query(`UPDATE production_inference_requests SET lease_until = now() - interval '1 second'
        WHERE installation_id = $1 AND message_id = $2`, [installationId, staleId]);
      const replacement = { ...old, leaseOwner: randomUUID() };
      assert.equal((await afterRestart.claim(replacement)).kind, 'CLAIMED');
      assert.equal(await afterRestart.complete({ installationId, messageId: staleId,
        leaseOwner: old.leaseOwner, encrypted: codec.encrypt({ ...answer, messageId: staleId }) }), false);
      assert.equal(await afterRestart.complete({ installationId, messageId: staleId,
        leaseOwner: replacement.leaseOwner, encrypted: codec.encrypt({ ...answer, messageId: staleId }) }), true);
      await reopened.query(`UPDATE production_inference_requests SET expires_at = now() - interval '1 second'
        WHERE installation_id = $1`, [installationId]);
      assert.equal((await afterRestart.purge(3600)).requests, 2);
      assert.equal((await afterRestart.claim({ ...first,
        messageId: randomUUID(), leaseOwner: randomUUID() })).kind, 'CLAIMED');
      assert.equal(await afterRestart.revoke(installationId), true);
      assert.equal((await reopened.query(`SELECT count(*)::integer AS total FROM production_reports
        WHERE installation_id = $1`, [installationId])).rows[0].total, 0);
      assert.ok((await afterRestart.findByTokenHash(tokenHash)).revokedAt);
      const remaining = await reopened.query(`SELECT count(*)::integer AS count
        FROM production_inference_requests WHERE installation_id = $1`, [installationId]);
      assert.equal(remaining.rows[0].count, 0);
      const current = issueInstallationCredential();
      const currentId = randomUUID();
      await afterRestart.createInstallation({ installationId: currentId,
        label: 'CurrentSyntheticIdentity', tokenHash: current.tokenHash,
        expiresAt: Date.now() + 86400000 });
      await reopened.query(`UPDATE production_installations
        SET revoked_at = now() - interval '40 days' WHERE installation_id = $1`, [installationId]);
      assert.equal(await afterRestart.purgeInactiveInstallations(30), 1);
      assert.equal(await afterRestart.findByTokenHash(tokenHash), null);
      assert.equal((await afterRestart.findByTokenHash(current.tokenHash)).installationId, currentId);
      await assert.rejects(afterRestart.purgeInactiveInstallations(0), /Identity retention/);
    } finally {
      if (reopened) await reopened.end();
      else if (!pool.ended) await pool.end();
    }
  });
