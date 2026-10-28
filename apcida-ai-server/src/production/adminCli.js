const fs = require('node:fs');
const { loadDatabaseUrl } = require('../config/env');
const { createDatabasePool } = require('../db/pool');
const { requireProductionAdmin } = require('./adminAuth');
const { createProductionRepository, checkProductionRepository } = require('./repository');
const { enrollProductionInstallation, revokeProductionInstallation,
  validateInstallationId } = require('./enrollment');

function parseCommand(args) {
  const [action, ...rest] = args;
  if (action === 'enroll' && rest.length === 5 && rest[0] === '--label'
    && rest[2] === '--out' && rest[4] === '--approve') {
    if (!rest[3].startsWith('/') || rest[3].includes('\n')) {
      throw new Error('Output must be an absolute file path');
    }
    return { action, label: rest[1], output: rest[3] };
  }
  if (['revoke', 'status'].includes(action) && rest.length === 2 && rest[0] === '--id') {
    return { action, id: validateInstallationId(rest[1]) };
  }
  throw new Error('Usage: enroll --label NAME --out /absolute/private/file --approve | revoke --id UUID | status --id UUID');
}

async function main(args = process.argv.slice(2), env = process.env) {
  const command = parseCommand(args);
  requireProductionAdmin(env);
  let fd;
  let pool;
  let completed = false;
  try {
    if (command.action === 'enroll') fd = fs.openSync(command.output, 'wx', 0o600);
    pool = createDatabasePool(loadDatabaseUrl(env));
    await checkProductionRepository(pool);
    const repository = createProductionRepository(pool);
    if (command.action === 'enroll') {
      const result = await enrollProductionInstallation(repository, { label: command.label });
      try {
        fs.writeFileSync(fd, `${result.token}\n`, { encoding: 'utf8' });
        fs.fsyncSync(fd);
      } catch {
        await repository.revoke(result.installationId);
        throw new Error('Could not write installation credential');
      }
      completed = true;
      process.stdout.write(`Production installation approved: ${result.installationId}; credential saved to private file. Expires ${new Date(result.expiresAt).toISOString()}\n`);
    } else if (command.action === 'revoke') {
      const revoked = await revokeProductionInstallation(repository, command.id);
      process.stdout.write(revoked ? 'Credential revoked.\n' : 'Credential already revoked or not found.\n');
    } else {
      const record = await repository.status(command.id);
      process.stdout.write(record
        ? `Installation ${record.installationId}: ${record.revokedAt ? 'revoked' : new Date(record.expiresAt) <= new Date() ? 'expired' : 'active'}\n`
        : 'Installation not found.\n');
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (command.action === 'enroll' && fd !== undefined && !completed) {
      try { fs.unlinkSync(command.output); } catch { /* best effort cleanup */ }
    }
    if (pool) await pool.end();
  }
}

if (require.main === module) main().catch(() => {
  process.stderr.write('Production admin command failed; check private configuration and arguments\n');
  process.exitCode = 1;
});

module.exports = { parseCommand, main };
