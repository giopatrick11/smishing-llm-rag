const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { exportBundle, decryptEntries, restoreBundle } =
  require('../scripts/phase7-recovery-bundle');

test('encrypted recovery export verifies, restores, and rejects altered ciphertext', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apcida-recovery-test-'));
  try {
    const source = path.join(root, 'source');
    const destination = path.join(root, 'external');
    fs.mkdirSync(source);
    fs.mkdirSync(destination);
    for (const name of ['production.env', 'admin.key', 'tunnel.token', 'superuser.password']) {
      fs.writeFileSync(path.join(source, name), `private-${name}`);
    }
    const database = path.join(root, 'database.dump');
    fs.writeFileSync(database, 'synthetic database dump');
    const passphrase = 'a long private test passphrase 123';
    const encrypted = exportBundle(source, database, destination, passphrase);
    assert.equal(fs.readFileSync(encrypted, 'utf8').includes('private-production.env'), false);
    assert.equal(decryptEntries(fs.readFileSync(encrypted), passphrase).length, 5);
    assert.throws(() => decryptEntries(fs.readFileSync(encrypted), 'another long private passphrase 123'));
    const restored = path.join(root, 'restored');
    restoreBundle(encrypted, restored, passphrase);
    assert.equal(fs.readFileSync(path.join(restored, 'production.env'), 'utf8'),
      'private-production.env');
    assert.equal(fs.readFileSync(path.join(restored, 'apcida.pgcustom'), 'utf8'),
      'synthetic database dump');
    const changed = JSON.parse(fs.readFileSync(encrypted, 'utf8'));
    changed.ciphertext = `${changed.ciphertext[0] === 'A' ? 'B' : 'A'}${changed.ciphertext.slice(1)}`;
    assert.throws(() => decryptEntries(Buffer.from(JSON.stringify(changed)), passphrase));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
