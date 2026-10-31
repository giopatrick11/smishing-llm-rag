-- One-use, short-lived beta enrollment invitations. Only hashes are stored.
ALTER TABLE production_installations ADD COLUMN IF NOT EXISTS cf_service_token_id varchar(80);
CREATE TABLE IF NOT EXISTS production_enrollment_invites (
    invite_hash char(64) PRIMARY KEY CHECK (invite_hash ~ '^[0-9a-f]{64}$'),
    label varchar(80) NOT NULL,
    expires_at timestamptz NOT NULL,
    claimed_by uuid,
    claim_until timestamptz,
    used_at timestamptz,
    installation_id uuid REFERENCES production_installations(installation_id),
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT production_invite_claim_pair CHECK ((claimed_by IS NULL) = (claim_until IS NULL)),
    CONSTRAINT production_invite_used_pair CHECK ((used_at IS NULL) = (installation_id IS NULL))
);
CREATE INDEX IF NOT EXISTS production_invites_expiry ON production_enrollment_invites (expires_at);
