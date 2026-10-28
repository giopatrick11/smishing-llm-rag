const { randomUUID } = require('node:crypto');
const { issueInstallationCredential } = require('./security');

function validateLabel(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,79}$/u.test(value)) {
    throw new TypeError('Installation label must be 1-80 simple characters');
  }
  return value;
}

function validateInstallationId(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new TypeError('A valid installation ID is required');
  }
  return value;
}

async function enrollProductionInstallation(repository, { label, days = 30, now = Date.now } = {}) {
  validateLabel(label);
  if (!Number.isInteger(days) || days < 1 || days > 90) throw new TypeError('Expiry must be 1-90 days');
  const installationId = randomUUID();
  const { token, tokenHash } = issueInstallationCredential();
  const expiresAt = now() + days * 86400000;
  await repository.createInstallation({ installationId, label, tokenHash, expiresAt });
  return { installationId, token, expiresAt };
}

async function revokeProductionInstallation(repository, installationId) {
  return repository.revoke(validateInstallationId(installationId));
}

module.exports = { validateInstallationId, enrollProductionInstallation,
  revokeProductionInstallation };
