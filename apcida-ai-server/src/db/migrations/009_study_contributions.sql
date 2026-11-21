-- Consented thesis data stays outside reports, inference cache, and RAG knowledge.
CREATE SCHEMA IF NOT EXISTS study;

CREATE TABLE study.participants (
  participant_id uuid PRIMARY KEY,
  installation_id uuid NOT NULL UNIQUE REFERENCES public.production_installations(installation_id) ON DELETE CASCADE,
  consent_version integer NOT NULL CHECK (consent_version = 1),
  consented_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  withdrawn_at timestamptz
);
CREATE INDEX study_participants_expiry_idx ON study.participants (expires_at);

CREATE TABLE study.withdrawals (
  installation_id uuid PRIMARY KEY REFERENCES public.production_installations(installation_id) ON DELETE CASCADE,
  withdrawn_at timestamptz NOT NULL
);

CREATE TABLE study.batches (
  batch_id uuid PRIMARY KEY,
  participant_id uuid NOT NULL REFERENCES study.participants(participant_id) ON DELETE CASCADE,
  payload_hmac char(64) NOT NULL,
  response jsonb NOT NULL,
  examined_count integer NOT NULL CHECK (examined_count BETWEEN 1 AND 1000),
  offered_count integer NOT NULL CHECK (offered_count BETWEEN 1 AND 40),
  selected_count integer NOT NULL CHECK (selected_count BETWEEN 1 AND 20),
  selection_method text NOT NULL CHECK (selection_method = 'RECENT_INBOX_PARTICIPANT_REVIEW'),
  submitted_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE study.contributions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  participant_id uuid NOT NULL REFERENCES study.participants(participant_id) ON DELETE CASCADE,
  client_id char(64) NOT NULL,
  content_hmac char(64) NOT NULL,
  content_encrypted bytea NOT NULL,
  local_suggestion text NOT NULL CHECK (local_suggestion IN ('SCAM', 'SAFE', 'SUSPICIOUS', 'UNVERIFIED')),
  participant_label text NOT NULL CHECK (participant_label IN ('SCAM', 'SAFE')),
  reviewed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  excluded_at timestamptz,
  exclusion_reason text,
  UNIQUE (participant_id, client_id),
  UNIQUE (participant_id, content_hmac)
);
CREATE INDEX study_contributions_created_idx ON study.contributions (created_at, id);

CREATE TABLE study.predictions (
  contribution_id bigint PRIMARY KEY REFERENCES study.contributions(id) ON DELETE CASCADE,
  batch_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('QUEUED', 'RUNNING', 'COMPLETED', 'ERROR')),
  classification text CHECK (classification IN ('SCAM', 'SAFE', 'SUSPICIOUS')),
  confidence text CHECK (confidence IN ('HIGH', 'MEDIUM', 'LOW')),
  error_code text,
  model_name text NOT NULL,
  model_digest text NOT NULL,
  pipeline_sha256 char(64) NOT NULL,
  knowledge_sha256 char(64) NOT NULL,
  started_at timestamptz,
  finished_at timestamptz,
  CHECK ((status = 'COMPLETED' AND classification IS NOT NULL AND confidence IS NOT NULL AND error_code IS NULL)
    OR (status = 'ERROR' AND classification IS NULL AND error_code IS NOT NULL)
    OR (status IN ('QUEUED', 'RUNNING') AND classification IS NULL AND error_code IS NULL))
);
CREATE INDEX study_predictions_status_idx ON study.predictions (status, contribution_id);

CREATE TABLE study.expert_labels (
  contribution_id bigint PRIMARY KEY REFERENCES study.contributions(id) ON DELETE CASCADE,
  label text NOT NULL CHECK (label IN ('SCAM', 'SAFE', 'INSUFFICIENT_EVIDENCE')),
  reviewer text NOT NULL CHECK (char_length(reviewer) BETWEEN 1 AND 100),
  reviewed_at timestamptz NOT NULL DEFAULT now()
);
