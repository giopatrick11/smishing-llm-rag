const { createHash, randomBytes } = require('node:crypto');
const { isIP } = require('node:net');

// Preparation only. Nothing in src/app.js or src/server.js mounts this middleware.
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u; // 32 random bytes, unpadded base64url

function issueInstallationCredential() {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: hashInstallationToken(token) };
}

function hashInstallationToken(token) {
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) {
    throw new TypeError('Invalid installation credential format');
  }
  return createHash('sha256').update(token, 'ascii').digest('hex');
}

function validProductionOrigin(value, approvedHost) {
  if (typeof value !== 'string' || typeof approvedHost !== 'string'
    || !approvedHost || value !== value.trim()) return false;
  let url;
  try { url = new URL(value); } catch { return false; }
  const host = url.hostname.toLowerCase();
  const approved = approvedHost.toLowerCase();
  return url.protocol === 'https:' && host === approved
    && host.includes('.') && !isIP(host) && !host.endsWith('.local')
    && !host.endsWith('.internal') && host !== 'localhost'
    && !url.username && !url.password && !url.search && !url.hash
    && (url.pathname === '/' || url.pathname === '')
    && (url.port === '' || url.port === '443');
}

function createInstallationAuth({ findByTokenHash, now = Date.now, audit = () => {} }) {
  if (typeof findByTokenHash !== 'function') throw new TypeError('Credential lookup is required');
  return async function installationAuth(req, res, next) {
    const header = req.get('authorization');
    const match = typeof header === 'string' ? /^Bearer ([A-Za-z0-9_-]{43})$/u.exec(header) : null;
    if (!match) {
      audit({ event: 'INSTALL_AUTH_REJECTED' });
      return res.status(401).json({ error: 'UNAUTHORIZED' });
    }
    let record;
    try {
      record = await findByTokenHash(hashInstallationToken(match[1]));
    } catch {
      audit({ event: 'INSTALL_AUTH_STORE_UNAVAILABLE' });
      return res.status(503).json({ error: 'AUTH_UNAVAILABLE' });
    }
    if (!record || !record.installationId || record.revokedAt != null
      || !Number.isFinite(record.expiresAt) || record.expiresAt <= now()) {
      audit({ event: 'INSTALL_AUTH_REJECTED' });
      return res.status(401).json({ error: 'UNAUTHORIZED' });
    }
    res.locals.installationId = record.installationId;
    return next();
  };
}

// Single-process preparation. Production deployment needs a shared, bounded store.
function createInstallationRateLimiter({ limit = 30, windowMs = 60000, now = Date.now } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(windowMs) || windowMs < 1) {
    throw new TypeError('Invalid rate limit');
  }
  const windows = new Map();
  return function installationRateLimit(req, res, next) {
    const id = res.locals.installationId;
    if (!id) return res.status(401).json({ error: 'UNAUTHORIZED' });
    const time = now();
    const old = windows.get(id);
    const current = !old || old.resetAt <= time ? { count: 0, resetAt: time + windowMs } : old;
    current.count += 1;
    windows.set(id, current);
    if (current.count > limit) {
      res.set('Retry-After', String(Math.ceil((current.resetAt - time) / 1000)));
      return res.status(429).json({ error: 'RATE_LIMITED' });
    }
    return next();
  };
}

module.exports = {
  issueInstallationCredential, hashInstallationToken, validProductionOrigin,
  createInstallationAuth, createInstallationRateLimiter,
};
