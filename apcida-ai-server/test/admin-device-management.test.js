const test = require('node:test');
const assert = require('node:assert/strict');
const { createDeviceManagement } = require('../src/admin-web/deviceManagement');

const PHONE_ID = '232288ec-44cd-44d3-8721-a6d9ad784a29';

test('revoking a phone blocks backend access before Cloudflare cleanup', async () => {
  const steps = [];
  const pool = {
    async query(sql) {
      if (sql.includes('SELECT revoked_at')) return { rows: [{ revoked_at: null,
        cf_service_token_id: 'cf-token-id' }] };
      if (sql.startsWith('UPDATE production_installations SET cf_service_token_id = NULL')) {
        steps.push('token cleanup recorded');
        return { rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    async connect() {
      return {
        async query(sql) {
          if (sql.startsWith('UPDATE production_installations SET revoked_at')) {
            steps.push('backend revoked');
            return { rowCount: 1 };
          }
          if (sql.startsWith('SELECT to_regclass')) return { rows: [{ table_name: 'production_reports' }] };
          if (sql.startsWith('DELETE FROM production_reports')) steps.push('reports deleted');
          return { rowCount: 1 };
        },
        release() {},
      };
    },
  };
  const cloudflare = { async remove(id) {
    assert.equal(id, 'cf-token-id');
    steps.push('Cloudflare token removed');
  } };
  const manager = createDeviceManagement(pool, cloudflare);
  assert.deepEqual(await manager.revoke(PHONE_ID), { found: true,
    cloudflareCleanupPending: false });
  assert.deepEqual(steps, ['backend revoked', 'reports deleted',
    'Cloudflare token removed', 'token cleanup recorded']);
});

test('Cloudflare outage leaves already revoked phone marked for cleanup retry', async () => {
  const pool = {
    async query(sql) {
      if (sql.includes('SELECT revoked_at')) return { rows: [{ revoked_at: new Date(),
        cf_service_token_id: 'cf-token-id' }] };
      throw new Error(`Unexpected query: ${sql}`);
    },
    async connect() { throw new Error('Backend revoke should not repeat'); },
  };
  const manager = createDeviceManagement(pool, { async remove() { throw new Error('offline'); } });
  assert.deepEqual(await manager.revoke(PHONE_ID), { found: true,
    cloudflareCleanupPending: true });
});
