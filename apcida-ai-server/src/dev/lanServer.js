const { isIP } = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { loadConfig } = require('../config/env');
const { createApp } = require('../app');
const { createDatabasePool, checkRagDatabase } = require('../db/pool');
const { createKnowledgeRepository } = require('../db/knowledgeRepository');

const manualHtml = fs.readFileSync(path.join(__dirname, 'manualTest.html'));
const manualScript = fs.readFileSync(path.join(__dirname, 'manualTest.js'));

function privateLanHost(value) {
  if (typeof value !== 'string' || isIP(value) !== 4) {
    throw new Error('APCIDA_DEV_LAN_HOST must be a private IPv4 address assigned to this Mac');
  }
  const [first, second] = value.split('.').map(Number);
  if (first === 10 || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)) return value;
  throw new Error('APCIDA_DEV_LAN_HOST must be a private IPv4 address assigned to this Mac');
}

function assertManualDevConfig(config) {
  if (config.model !== 'gemma3:12b' || !config.rulesShadowMode || config.verdictPolicy !== 'gemma') {
    throw new Error('Manual LAN testing requires Gemma 3 12B and the shadow-mode Gemma verdict');
  }
  if (config.apiKey === 'replace-with-a-long-random-secret') {
    throw new Error('Set a private random API_KEY before manual LAN testing');
  }
}

function createLanApp(config, dependencies = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.disable('etag');
  const noStore = (req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache',
      'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
    next();
  };
  app.get('/manual-test', noStore, (req, res) => {
    res.set({ 'Content-Security-Policy': "default-src 'none'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'X-Frame-Options': 'DENY' });
    res.type('html').send(manualHtml);
  });
  app.get('/manual-test.js', noStore, (req, res) => res.type('js').send(manualScript));
  app.use('/api/sms/analyze', noStore);
  app.use(createApp(config, dependencies));
  return app;
}

async function main() {
  const host = privateLanHost(process.env.APCIDA_DEV_LAN_HOST);
  const config = loadConfig();
  assertManualDevConfig(config);
  let pool;
  try {
    if (config.ragEnabled) {
      pool = createDatabasePool(config.databaseUrl);
      await checkRagDatabase(pool);
    }
    const knowledgeRepository = pool ? createKnowledgeRepository(pool) : undefined;
    const server = createLanApp(config, { knowledgeRepository }).listen(config.port, host, () => {
      process.stdout.write(`Manual development server listening at http://${host}:${config.port}\n`);
    });
    server.on('error', async (error) => {
      process.stderr.write(`Manual development server listen failed: ${error.code || 'UNKNOWN'}\n`);
      if (pool) await pool.end();
      process.exitCode = 1;
    });
    const shutdown = () => server.close(async () => {
      if (pool) await pool.end();
    });
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  } catch (error) {
    if (pool) await pool.end();
    throw error;
  }
}

if (require.main === module) main().catch((error) => {
  process.stderr.write(`Manual development server failed: ${error.message}\n`);
  process.exitCode = 1;
});

module.exports = { privateLanHost, assertManualDevConfig, createLanApp };
