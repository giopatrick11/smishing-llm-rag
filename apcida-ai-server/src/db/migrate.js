const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { Client } = require('pg');
const { loadDatabaseUrl } = require('../config/env');

function shouldApplyMigration(file, { includeProduction = false } = {}) {
  return file !== '004_production_inference.sql' || includeProduction;
}

async function runMigrations(databaseUrl = loadDatabaseUrl(), { includeProduction = false } = {}) {
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('apcida_schema_migrations'))");
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const migrationsDir = path.join(__dirname, 'migrations');
    const files = fs.readdirSync(migrationsDir).filter((file) => /^\d+_[a-z0-9_]+\.sql$/.test(file)).sort();
    const applied = [];
    for (const file of files) {
      // Production inference tables require a separate controlled rollout decision.
      if (!shouldApplyMigration(file, { includeProduction })) continue;
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const existing = await client.query('SELECT checksum FROM schema_migrations WHERE version = $1', [file]);
      if (existing.rows.length) {
        if (existing.rows[0].checksum !== checksum) throw new Error(`Migration checksum mismatch: ${file}`);
        continue;
      }
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [file, checksum]);
      applied.push(file);
    }
    await client.query('COMMIT');
    return applied;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  const includeProduction = process.env.APCIDA_APPLY_PRODUCTION_SCHEMA === 'true';
  if (includeProduction && process.env.APCIDA_PRODUCTION_MODE !== 'controlled-test') {
    process.stderr.write('Production schema requires controlled-test mode\n');
    process.exitCode = 1;
  } else runMigrations(undefined, { includeProduction }).then((applied) => {
    process.stdout.write(applied.length ? `Applied migrations: ${applied.join(', ')}\n` : 'Database is up to date.\n');
  }).catch((error) => {
    process.stderr.write(`Migration failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { runMigrations, shouldApplyMigration };
