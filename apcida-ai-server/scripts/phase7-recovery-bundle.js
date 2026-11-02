#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const FILES = ['production.env', 'admin.key', 'tunnel.token', 'superuser.password'];
const KDF = { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };

function makeKey(passphrase, salt) {
  if (typeof passphrase !== 'string' || passphrase.length < 20) {
    throw new Error('Recovery passphrase must have at least 20 characters');
  }
  return crypto.scryptSync(passphrase, salt, 32, KDF);
}

function encryptEntries(entries, passphrase) {
  const salt = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', makeKey(passphrase, salt), iv);
  const payload = Buffer.from(JSON.stringify({ version: 1, entries }), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
  return Buffer.from(JSON.stringify({ format: 'apcida-recovery-v1',
    salt: salt.toString('base64'), iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64') }) + '\n');
}

function decryptEntries(envelope, passphrase) {
  const item = JSON.parse(envelope.toString('utf8'));
  if (item.format !== 'apcida-recovery-v1') throw new Error('Unknown recovery format');
  const salt = Buffer.from(item.salt, 'base64');
  const iv = Buffer.from(item.iv, 'base64');
  const tag = Buffer.from(item.tag, 'base64');
  if (salt.length !== 32 || iv.length !== 12 || tag.length !== 16) {
    throw new Error('Invalid recovery envelope');
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', makeKey(passphrase, salt), iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(item.ciphertext, 'base64')), decipher.final()]);
  const payload = JSON.parse(plaintext.toString('utf8'));
  if (payload.version !== 1 || !Array.isArray(payload.entries)) {
    throw new Error('Invalid recovery payload');
  }
  const names = new Set();
  for (const entry of payload.entries) {
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(entry.name) || names.has(entry.name)) {
      throw new Error('Invalid recovery entry name');
    }
    names.add(entry.name);
    const bytes = Buffer.from(entry.data, 'base64');
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== entry.sha256) {
      throw new Error('Recovery entry checksum mismatch');
    }
  }
  return payload.entries;
}

function entry(name, file) {
  const bytes = fs.readFileSync(file);
  return { name, data: bytes.toString('base64'),
    sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}

function exportBundle(privateRoot, databaseBackup, destination, passphrase, signingKeystore) {
  const entries = FILES.map((name) => entry(name, path.join(privateRoot, name)));
  entries.push(entry('apcida.pgcustom', databaseBackup));
  if (signingKeystore) entries.push(entry('release.keystore', signingKeystore));
  const encrypted = encryptEntries(entries, passphrase);
  const filename = `apcida-recovery-${new Date().toISOString().replace(/[:.]/g, '')}.enc`;
  const output = path.join(destination, filename);
  fs.writeFileSync(output, encrypted, { flag: 'wx', mode: 0o600 });
  try {
    const verified = decryptEntries(fs.readFileSync(output), passphrase);
    if (verified.length !== entries.length) throw new Error('Recovery verification failed');
  } catch (error) {
    fs.unlinkSync(output);
    throw error;
  }
  return output;
}

function restoreBundle(encryptedFile, destination, passphrase) {
  const entries = decryptEntries(fs.readFileSync(encryptedFile), passphrase);
  fs.mkdirSync(destination, { mode: 0o700 });
  for (const item of entries) {
    fs.writeFileSync(path.join(destination, item.name), Buffer.from(item.data, 'base64'),
      { flag: 'wx', mode: 0o600 });
  }
  return entries.map((item) => item.name);
}

async function main() {
  const [command, arg1, arg2, arg3, arg4] = process.argv.slice(2);
  const passphrase = (await new Promise((resolve, reject) => {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { input += chunk; });
    process.stdin.on('end', () => resolve(input));
    process.stdin.on('error', reject);
  }));
  if (command === 'export') {
    const output = exportBundle(arg1, arg2, arg3, passphrase, arg4);
    console.log(`Encrypted recovery bundle verified: ${output}`);
  } else if (command === 'verify') {
    const names = decryptEntries(fs.readFileSync(arg1), passphrase).map((item) => item.name);
    console.log(`Recovery bundle verified: ${names.join(', ')}`);
  } else if (command === 'restore') {
    const names = restoreBundle(arg1, arg2, passphrase);
    console.log(`Restored to private directory: ${arg2}; entries: ${names.join(', ')}`);
  } else {
    throw new Error('Usage: export <private-root> <database-backup> <destination-directory> [signing-keystore] | verify <bundle> | restore <bundle> <new-directory>');
  }
}

if (require.main === module) main().catch((error) => {
  console.error(`Recovery bundle failed: ${error.message}`);
  process.exitCode = 1;
});

module.exports = { encryptEntries, decryptEntries, exportBundle, restoreBundle };
