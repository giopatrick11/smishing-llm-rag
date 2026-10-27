const { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } = require('../services/embeddings');

function vectorLiteral(vector) {
  if (!Array.isArray(vector) || vector.length !== EMBEDDING_DIMENSIONS
    || !vector.every((value) => typeof value === 'number' && Number.isFinite(value))) {
    throw new Error('Invalid embedding vector');
  }
  return `[${vector.join(',')}]`;
}

function createKnowledgeRepository(pool) {
  return {
    async search(vector, { limit = 3, minSimilarity = 0.72 } = {}) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 10
        || !Number.isFinite(minSimilarity) || minSimilarity < 0 || minSimilarity > 1) {
        throw new Error('Invalid RAG search options');
      }
      const result = await pool.query(`WITH nearest AS (
        SELECT id, content, label, embedding <=> $1::vector AS distance
        FROM rag_knowledge
        WHERE is_active = true AND approved_by IS NOT NULL
          AND approved_at <= now() AND embedding_model = $2
        ORDER BY embedding <=> $1::vector
        LIMIT $3
      )
      SELECT id, content, label, 1 - distance AS similarity
      FROM nearest
      WHERE 1 - distance >= $4
      ORDER BY distance`, [vectorLiteral(vector), EMBEDDING_MODEL, limit, minSimilarity]);
      return result.rows.map((row) => ({
        id: row.id,
        content: row.content,
        label: row.label,
        similarity: Number(row.similarity),
      }));
    },
  };
}

module.exports = { createKnowledgeRepository, vectorLiteral };
