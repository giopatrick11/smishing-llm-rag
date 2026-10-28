const { OllamaError } = require('./ollama');

const EMBEDDING_MODEL = 'nomic-embed-text';
const EMBEDDING_DIMENSIONS = 768;

function createEmbeddingService(config, fetchImpl = fetch) {
  async function embed(text, { signal } = {}) {
    let response;
    try {
      response = await fetchImpl(`${config.ollamaUrl}/api/embed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: EMBEDDING_MODEL, input: text }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(config.requestTimeoutMs)])
          : AbortSignal.timeout(config.requestTimeoutMs),
      });
    } catch (error) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw new OllamaError('EMBEDDING_TIMEOUT', 504);
      throw new OllamaError('EMBEDDING_UNAVAILABLE', 503);
    }
    if (!response.ok) {
      if ([429, 502, 503].includes(response.status)) throw new OllamaError('EMBEDDING_OVERLOADED', 503);
      if (response.status === 404) throw new OllamaError('EMBEDDING_MODEL_UNAVAILABLE', 503);
      throw new OllamaError('EMBEDDING_ERROR', 502);
    }
    let data;
    try {
      data = await response.json();
    } catch (error) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw new OllamaError('EMBEDDING_TIMEOUT', 504);
      throw new OllamaError('EMBEDDING_INVALID_RESPONSE', 502);
    }
    const vector = data?.embeddings?.[0];
    if (!Array.isArray(vector) || vector.length !== EMBEDDING_DIMENSIONS
      || !vector.every((value) => typeof value === 'number' && Number.isFinite(value))) {
      throw new OllamaError('EMBEDDING_INVALID_RESPONSE', 502);
    }
    return vector;
  }

  return { embed };
}

module.exports = { createEmbeddingService, EMBEDDING_MODEL, EMBEDDING_DIMENSIONS };
