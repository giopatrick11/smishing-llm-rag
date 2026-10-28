-- Separate from pilot identities. Routine request bodies and sender values are never stored.
CREATE TABLE IF NOT EXISTS production_installations (
    installation_id uuid PRIMARY KEY,
    label varchar(80) NOT NULL,
    token_hash char(64) NOT NULL UNIQUE,
    issued_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    CONSTRAINT production_installations_expiry CHECK (expires_at > issued_at),
    CONSTRAINT production_installations_hash CHECK (token_hash ~ '^[0-9a-f]{64}$')
);
CREATE INDEX IF NOT EXISTS production_installations_active_expiry
    ON production_installations (expires_at) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS production_rate_windows (
    installation_id uuid NOT NULL REFERENCES production_installations(installation_id) ON DELETE CASCADE,
    window_start timestamptz NOT NULL,
    request_count integer NOT NULL CHECK (request_count > 0),
    PRIMARY KEY (installation_id, window_start)
);
CREATE INDEX IF NOT EXISTS production_rate_windows_cleanup
    ON production_rate_windows (window_start);

CREATE TABLE IF NOT EXISTS production_inference_requests (
    installation_id uuid NOT NULL REFERENCES production_installations(installation_id) ON DELETE CASCADE,
    message_id uuid NOT NULL,
    request_hmac char(64) NOT NULL,
    status varchar(16) NOT NULL CHECK (status IN ('PROCESSING', 'COMPLETED')),
    lease_owner uuid NOT NULL,
    lease_until timestamptz NOT NULL,
    response_encrypted bytea,
    created_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    expires_at timestamptz NOT NULL,
    PRIMARY KEY (installation_id, message_id),
    CONSTRAINT production_request_hmac CHECK (request_hmac ~ '^[0-9a-f]{64}$'),
    CONSTRAINT production_response_state CHECK (
        (status = 'PROCESSING' AND response_encrypted IS NULL AND completed_at IS NULL)
        OR (status = 'COMPLETED' AND response_encrypted IS NOT NULL AND completed_at IS NOT NULL)
    )
);
CREATE INDEX IF NOT EXISTS production_inference_requests_cleanup
    ON production_inference_requests (expires_at);

-- One global inference slot across listener processes. A crashed owner expires.
CREATE TABLE IF NOT EXISTS production_inference_slot (
    slot_id smallint PRIMARY KEY CHECK (slot_id = 1),
    lease_owner uuid,
    lease_until timestamptz,
    CONSTRAINT production_slot_state CHECK (
        (lease_owner IS NULL AND lease_until IS NULL)
        OR (lease_owner IS NOT NULL AND lease_until IS NOT NULL)
    )
);
INSERT INTO production_inference_slot (slot_id) VALUES (1) ON CONFLICT DO NOTHING;
