-- Separate pilot identity store. No SMS text, sender, verdict, or RAG records.
CREATE TABLE IF NOT EXISTS pilot_installations (
    installation_id uuid PRIMARY KEY,
    label varchar(80) NOT NULL,
    token_hash char(64) NOT NULL UNIQUE,
    issued_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    CONSTRAINT pilot_installations_expiry CHECK (expires_at > issued_at),
    CONSTRAINT pilot_installations_hash CHECK (token_hash ~ '^[0-9a-f]{64}$')
);
CREATE INDEX IF NOT EXISTS pilot_installations_active_expiry
    ON pilot_installations (expires_at) WHERE revoked_at IS NULL;
