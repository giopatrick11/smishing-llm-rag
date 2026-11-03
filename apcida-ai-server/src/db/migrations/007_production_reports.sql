-- User-submitted detection feedback. Report content is encrypted by the application
-- before insertion and is never read by the RAG retrieval path.
CREATE TABLE production_reports (
    installation_id uuid NOT NULL REFERENCES production_installations(installation_id) ON DELETE CASCADE,
    client_report_id uuid NOT NULL,
    content_hmac char(64) NOT NULL CHECK (content_hmac ~ '^[0-9a-f]{64}$'),
    content_encrypted bytea NOT NULL,
    review_status varchar(12) NOT NULL DEFAULT 'PENDING'
      CHECK (review_status IN ('PENDING', 'REVIEWED', 'DISMISSED')),
    reviewed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
    PRIMARY KEY (installation_id, client_report_id)
);
CREATE INDEX production_reports_expiry ON production_reports (expires_at);
CREATE INDEX production_reports_daily_limit ON production_reports (installation_id, created_at);
