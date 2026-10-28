const { createEmbeddingService } = require('./embeddings');

class RagError extends Error {
  constructor() {
    super('RAG_DATABASE_UNAVAILABLE');
    this.code = 'RAG_DATABASE_UNAVAILABLE';
    this.status = 503;
  }
}

function summarizeContext(examples) {
  const highest = (label) => Math.max(0, ...examples.filter((entry) => entry.label === label)
    .map((entry) => Number(entry.similarity)).filter(Number.isFinite));
  return { retrievedCount: examples.length, topScamSimilarity: highest('SCAM'), topSafeSimilarity: highest('SAFE') };
}

function createRagService(config, ollama, knowledgeRepository, fetchImpl, { includeContext = false } = {}) {
  if (!knowledgeRepository) throw new Error('RAG requires a knowledge repository');
  const embeddings = createEmbeddingService(config, fetchImpl);
  return {
    async analyze(sms, options = {}) {
      const vector = await embeddings.embed(sms.text, options);
      options.signal?.throwIfAborted();
      let examples;
      try {
        examples = await knowledgeRepository.search(vector);
      } catch {
        throw new RagError();
      }
      options.signal?.throwIfAborted();
      const result = await ollama.analyze(sms, examples, options);
      return includeContext ? { ...result, ragContext: summarizeContext(examples) } : result;
    },
  };
}

module.exports = { createRagService, RagError, summarizeContext };
