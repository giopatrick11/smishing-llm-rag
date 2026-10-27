const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { createPilotApp } = require('../src/pilot/createPilotApp');
const { issueInstallationCredential } = require('../src/production/security');

const config = {
  model: 'gemma3:12b', ragEnabled: true, rulesEnabled: true,
  rulesShadowMode: true, verdictPolicy: 'gemma', apiKey: 'a-private-internal-key-for-tests',
  ollamaUrl: 'http://127.0.0.1:11434', requestTimeoutMs: 1000,
};

test('pilot returns AI timeout as an error, never a SAFE verdict', async () => {
  const credential = issueInstallationCredential();
  const app = createPilotApp(config, {
    installationRepository: {
      async findByTokenHash(hash) {
        return hash === credential.tokenHash
          ? { installationId: 'synthetic-installation', expiresAt: Date.now() + 60000, revokedAt: null }
          : null;
      },
    },
    knowledgeRepository: { async search() { return []; } },
    fetchImpl: async (url) => {
      if (url.endsWith('/api/embed')) {
        return { ok: true, json: async () => ({ embeddings: [Array(768).fill(0)] }) };
      }
      throw Object.assign(new Error('inference timeout'), { name: 'TimeoutError' });
    },
  });
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/sms/analyze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${credential.token}`,
        'x-apcida-pilot-synthetic': 'true' },
      body: JSON.stringify({ messageId: 'pilot-timeout123', sender: 'ManualTest',
        text: 'Synthetic test message', receivedAt: '2026-01-01T00:00:00Z' }),
    });
    assert.equal(response.status, 504);
    assert.deepEqual(await response.json(), { error: 'OLLAMA_TIMEOUT' });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
