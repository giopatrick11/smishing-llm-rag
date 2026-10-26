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
});

function loadConfig(environment = process.env) {
  const result = configSchema.safeParse(environment);
  if (!result.success) {
    const names = [...new Set(result.error.issues.map((issue) => issue.path.join('.')))];
    throw new Error(`Invalid configuration: ${names.join(', ')}`);
  }
  return {
    port: result.data.PORT,
    host: '127.0.0.1',
    ollamaUrl: result.data.OLLAMA_URL.replace(/\/$/, ''),
    model: result.data.OLLAMA_MODEL,
    apiKey: result.data.API_KEY,
    requestTimeoutMs: result.data.REQUEST_TIMEOUT_MS,
  };
}

module.exports = { loadConfig };
