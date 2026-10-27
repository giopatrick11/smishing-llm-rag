CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE rag_knowledge (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  content text NOT NULL CHECK (char_length(content) BETWEEN 1 AND 2000),
  label text NOT NULL CHECK (label IN ('SCAM', 'SAFE')),
  embedding vector(768) NOT NULL,
  embedding_model text NOT NULL CHECK (embedding_model = 'nomic-embed-text'),
  source_type text NOT NULL CHECK (source_type IN ('CURATED', 'USER_APPROVED')),
  source_reference text,
  approved_at timestamptz NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX rag_knowledge_embedding_cosine_idx
  ON rag_knowledge USING hnsw (embedding vector_cosine_ops);
