-- Preserve earlier participant labels for audit, but never require or use them
-- for new contributions. Independent expert labels remain in study.expert_labels.
ALTER TABLE study.contributions
  RENAME COLUMN participant_label TO legacy_participant_label;
ALTER TABLE study.contributions
  ALTER COLUMN legacy_participant_label DROP NOT NULL;
