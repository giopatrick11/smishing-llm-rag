const fs = require('node:fs');
const { loadDatabaseUrl } = require('../config/env');
const { createDatabasePool } = require('../db/pool');
const { requireProductionAdmin } = require('./adminAuth');
const { createPrivacyCodec } = require('./privacy');

function parseArgs(args) {
  const [action, ...rest] = args;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
  if (action === 'list' && rest.length === 0) return { action };
  if (['inspect', 'review', 'dismiss'].includes(action) && rest[0] === '--id' &&
      uuid.test(rest[1] || '') && rest[2] === '--installation-id' && uuid.test(rest[3] || '')) {
    if (action === 'inspect' && rest.length === 6 && rest[4] === '--out' &&
        rest[5]?.startsWith('/') && !rest[5].includes('\n')) {
      return { action, id: rest[1], installationId: rest[3], out: rest[5] };
    }
    if (action !== 'inspect' && rest.length === 4) {
      return { action, id: rest[1], installationId: rest[3] };
    }
  }
  throw new Error('Usage: list | inspect --id UUID --installation-id UUID --out /absolute/private/file | review|dismiss --id UUID --installation-id UUID');
}

async function main(args = process.argv.slice(2), env = process.env) {
  const command = parseArgs(args);
  requireProductionAdmin(env);
  const pool = createDatabasePool(loadDatabaseUrl(env));
  try {
    if (command.action === 'list') {
      const result = await pool.query(`SELECT client_report_id AS id, installation_id AS "installationId", review_status AS status,
        created_at AS "createdAt", expires_at AS "expiresAt"
        FROM production_reports ORDER BY created_at DESC LIMIT 100`);
      for (const row of result.rows) process.stdout.write(`${row.id} installation=${row.installationId} ${row.status} ${row.createdAt.toISOString()} expires=${row.expiresAt.toISOString()}\n`);
      if (!result.rows.length) process.stdout.write('No reports.\n');
    } else if (command.action === 'inspect') {
      const result = await pool.query(`SELECT content_encrypted FROM production_reports
        WHERE client_report_id = $1 AND installation_id = $2`,
      [command.id, command.installationId]);
      if (result.rowCount !== 1) throw new Error('Report unavailable or ID ambiguous');
      const content = createPrivacyCodec(env.PRODUCTION_DATA_KEY).decryptReport(result.rows[0].content_encrypted);
      const fd = fs.openSync(command.out, 'wx', 0o600);
      let completed = false;
      try {
        fs.writeFileSync(fd, `${JSON.stringify(content, null, 2)}\n`);
        fs.fsyncSync(fd);
        completed = true;
      } finally {
        fs.closeSync(fd);
        if (!completed) fs.unlinkSync(command.out);
      }
      process.stdout.write('Decrypted report saved to private file; remove it after review.\n');
    } else {
      const status = command.action === 'review' ? 'REVIEWED' : 'DISMISSED';
      const result = await pool.query(`UPDATE production_reports SET review_status = $2,
        reviewed_at = now() WHERE client_report_id = $1 AND installation_id = $3
        AND review_status = 'PENDING' RETURNING client_report_id`,
      [command.id, status, command.installationId]);
      process.stdout.write(result.rowCount === 1 ? `Report ${status.toLowerCase()}. No RAG record was added.\n`
        : 'No pending report matched.\n');
    }
  } finally { await pool.end(); }
}

if (require.main === module) main().catch(() => {
  process.stderr.write('Report review command failed; check private configuration and arguments\n');
  process.exitCode = 1;
});

module.exports = { parseArgs, main };
