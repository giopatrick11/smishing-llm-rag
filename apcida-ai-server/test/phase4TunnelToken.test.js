const test = require('node:test');
const assert = require('node:assert/strict');
const { extractTunnelToken } = require('../scripts/phase4-save-rotated-tunnel-token');

function token(tunnelId) {
  return Buffer.from(JSON.stringify({ a: 'test-account', t: tunnelId,
    s: 'test-secret-with-sufficient-length' })).toString('base64url');
}

test('private tunnel capture accepts only the expected tunnel token', () => {
  const expected = token('44868837-d5e5-4210-be5c-1a9688beff7d');
  assert.equal(extractTunnelToken(`cloudflared tunnel run --token ${expected}`), expected);
  assert.equal(extractTunnelToken(`sudo cloudflared service install ${expected}`), expected);
  assert.throws(() => extractTunnelToken(token('00000000-0000-4000-8000-000000000000')),
    /valid token/);
  assert.throws(() => extractTunnelToken('cloudflared tunnel run --token not-a-token'),
    /valid token/);
});
