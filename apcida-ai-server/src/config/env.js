require('dotenv').config({ quiet: true });

const { z } = require('zod');

const loopbackUrl = z.url().refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'http:'
      && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      && !url.username && !url.password
      && (url.pathname === '/' || url.pathname === '')
      && !url.search && !url.hash;
  } catch {
    return false;
  }
}, 'OLLAMA_URL must be a local HTTP origin');

const configSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  OLLAMA_URL: loopbackUrl.default('http://127.0.0.1:11434'),
  OLLAMA_MODEL: z.string().trim().min(1).default('gemma3:12b'),
  API_KEY: z.string().min(16),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300000).default(120000),
  RAG_ENABLED: z.enum(['true', 'false']).default('false'),
  RULES_ENABLED: z.enum(['true', 'false']).default('false'),
  RULES_SHADOW_MODE: z.enum(['true', 'false']).default('true'),
  VERDICT_POLICY: z.enum(['gemma', 'corroborated-warning', 'evidence-weighted']).default('gemma'),
});

function loadDatabaseUrl(environment = process.env) {
  const value = environment.DATABASE_URL;
  let url;
  let databaseName;
  try {
    url = new URL(value);
    databaseName = decodeURIComponent(url.pathname.slice(1));
  } catch {
    throw new Error('Invalid configuration: DATABASE_URL');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)
    || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || databaseName !== 'apcida'
    || url.search || url.hash) {
    throw new Error('DATABASE_URL must point to the local apcida PostgreSQL database');
  }
  return value;
}

function loadConfig(environment = process.env) {
  const result = configSchema.safeParse(environment);
  if (!result.success) {
    const names = [...new Set(result.error.issues.map((issue) => issue.path.join('.')))];
    throw new Error(`Invalid configuration: ${names.join(', ')}`);
  }
  if (result.data.RAG_ENABLED === 'true' && result.data.OLLAMA_MODEL !== 'gemma3:12b') {
    throw new Error('RAG requires OLLAMA_MODEL=gemma3:12b');
  }
  return {
    port: result.data.PORT,
    host: '127.0.0.1',
    ollamaUrl: result.data.OLLAMA_URL.replace(/\/$/, ''),
    model: result.data.OLLAMA_MODEL,
    apiKey: result.data.API_KEY,
    requestTimeoutMs: result.data.REQUEST_TIMEOUT_MS,
    ragEnabled: result.data.RAG_ENABLED === 'true',
    rulesEnabled: result.data.RULES_ENABLED === 'true',
    rulesShadowMode: result.data.RULES_SHADOW_MODE === 'true',
    verdictPolicy: result.data.VERDICT_POLICY,
    databaseUrl: result.data.RAG_ENABLED === 'true' ? loadDatabaseUrl(environment) : undefined,
  };
}

function loadEvaluationConfig(environment = process.env) {
  const result = configSchema.omit({ PORT: true, API_KEY: true }).safeParse(environment);
  if (!result.success) {
    const names = [...new Set(result.error.issues.map((issue) => issue.path.join('.')))];
    throw new Error(`Invalid evaluation configuration: ${names.join(', ')}`);
  }
  if (result.data.OLLAMA_MODEL !== 'gemma3:12b') {
    throw new Error('Evaluation requires OLLAMA_MODEL=gemma3:12b');
  }
  return {
    ollamaUrl: result.data.OLLAMA_URL.replace(/\/$/, ''),
    model: result.data.OLLAMA_MODEL,
    requestTimeoutMs: result.data.REQUEST_TIMEOUT_MS,
    rulesEnabled: result.data.RULES_ENABLED === 'true',
    rulesShadowMode: result.data.RULES_SHADOW_MODE === 'true',
    verdictPolicy: result.data.VERDICT_POLICY,
  };
}

module.exports = { loadConfig, loadEvaluationConfig, loadDatabaseUrl };
