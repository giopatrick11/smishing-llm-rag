const fs = require('node:fs');
const path = require('node:path');

const expectedTunnelId = '44868837-d5e5-4210-be5c-1a9688beff7d';
const privateRoot = path.join(process.env.HOME || '', 'Library/Application Support/ApCiDa/controlled-server');
const tokenPath = path.join(privateRoot, 'tunnel.token');

function extractTunnelToken(value) {
  const candidates = value.match(/eyJ[A-Za-z0-9_+\/-]{80,}={0,2}/g) || [];
  for (const candidate of candidates) {
    try {
      const decoded = JSON.parse(Buffer.from(candidate, 'base64url').toString('utf8'));
      if (decoded?.t === expectedTunnelId && typeof decoded?.s === 'string' &&
        typeof decoded?.a === 'string') return candidate;
    } catch { /* keep searching without displaying clipboard contents */ }
  }
  throw new Error('Clipboard does not contain a valid token for the apcida-pilot tunnel');
}

function saveToken(value) {
  if (fs.statSync(privateRoot).mode.toString(8).slice(-3) !== '700') {
    throw new Error('Private controlled-server directory must be mode 0700');
  }
  const token = extractTunnelToken(value);
  const fd = fs.openSync(tokenPath, 'wx', 0o600);
  try { fs.writeFileSync(fd, `${token}\n`, 'utf8'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  process.stdout.write('New tunnel token saved privately. No token value was displayed.\n');
}

if (require.main === module) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', () => {
    try { saveToken(input); }
    catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
  });
}

module.exports = { extractTunnelToken, saveToken };
