-- Keep a distinct audit state when an unused invite is canceled by its owner.
ALTER TABLE production_enrollment_invites
  ADD COLUMN IF NOT EXISTS canceled_at timestamptz;
