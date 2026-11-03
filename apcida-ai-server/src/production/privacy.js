const { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes,
  timingSafeEqual } = require('node:crypto');

function createPrivacyCodec(keyHex) {
  if (typeof keyHex !== 'string' || !/^[0-9a-fA-F]{64}$/u.test(keyHex)) {
    throw new Error('PRODUCTION_DATA_KEY must be 32 random bytes encoded as hex');
  }
  const material = Buffer.from(keyHex, 'hex');
  const encryptionKey = Buffer.from(hkdfSync('sha256', material, Buffer.alloc(0),
    'apcida-production-response-v1', 32));
  const reportEncryptionKey = Buffer.from(hkdfSync('sha256', material, Buffer.alloc(0),
    'apcida-production-report-encryption-v1', 32));
  const hmacKey = Buffer.from(hkdfSync('sha256', material, Buffer.alloc(0),
    'apcida-production-request-v1', 32));
  const reportHmacKey = Buffer.from(hkdfSync('sha256', material, Buffer.alloc(0),
    'apcida-production-report-v1', 32));
  const encryptWith = (key, value) => {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]);
  };
  const decryptWith = (key, blob) => {
    if (!Buffer.isBuffer(blob) || blob.length < 29) throw new Error('Invalid encrypted content');
    const decipher = createDecipheriv('aes-256-gcm', key, blob.subarray(0, 12));
    decipher.setAuthTag(blob.subarray(12, 28));
    return JSON.parse(Buffer.concat([
      decipher.update(blob.subarray(28)), decipher.final(),
    ]).toString('utf8'));
  };
  return {
    reportHmac(report) {
      return createHmac('sha256', reportHmacKey).update(JSON.stringify(report)).digest('hex');
    },
    requestHmac(request) {
      return createHmac('sha256', hmacKey).update(JSON.stringify({
        messageId: request.messageId, sender: request.sender,
        text: request.text, receivedAt: request.receivedAt,
      })).digest('hex');
    },
    sameHmac(a, b) {
      return typeof a === 'string' && typeof b === 'string' &&
        /^[0-9a-f]{64}$/u.test(a) && /^[0-9a-f]{64}$/u.test(b) &&
        timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
    },
    encrypt(response) { return encryptWith(encryptionKey, response); },
    decrypt(blob) { return decryptWith(encryptionKey, blob); },
    encryptReport(report) { return encryptWith(reportEncryptionKey, report); },
    decryptReport(blob) { return decryptWith(reportEncryptionKey, blob); },
  };
}

module.exports = { createPrivacyCodec };
