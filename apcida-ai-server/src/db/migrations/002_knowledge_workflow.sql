ALTER TABLE rag_knowledge ADD COLUMN normalized_hash text;
ALTER TABLE rag_knowledge ADD COLUMN approved_by text;

CREATE UNIQUE INDEX rag_knowledge_normalized_hash_idx
  ON rag_knowledge (normalized_hash) WHERE normalized_hash IS NOT NULL;

CREATE TABLE rag_knowledge_staging (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  external_id text NOT NULL UNIQUE CHECK (char_length(external_id) BETWEEN 1 AND 128),
  content text NOT NULL CHECK (char_length(content) BETWEEN 1 AND 2000),
  label text NOT NULL CHECK (label IN ('SCAM', 'SAFE')),
  reviewer text NOT NULL CHECK (char_length(reviewer) BETWEEN 1 AND 100),
  reviewed_at timestamptz NOT NULL,
  source_reference text NOT NULL CHECK (char_length(source_reference) BETWEEN 1 AND 200),
  normalized_hash text NOT NULL UNIQUE,
  evaluation_corpus_sha256 text,
  embedding vector(768),
  embedding_model text CHECK (embedding_model = 'nomic-embed-text'),
  status text NOT NULL DEFAULT 'PENDING_EMBEDDING'
    CHECK (status IN ('PENDING_EMBEDDING', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED')),
  embedding_error text,
  embedded_at timestamptz,
  approved_by text,
  approved_at timestamptz,
  active_knowledge_id bigint UNIQUE REFERENCES rag_knowledge(id),
  rejection_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX rag_knowledge_staging_status_idx ON rag_knowledge_staging (status, id);
