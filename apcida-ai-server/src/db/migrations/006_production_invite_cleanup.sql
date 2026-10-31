-- Removing an inactive installation must not be blocked by its used invitation.
ALTER TABLE production_enrollment_invites
    DROP CONSTRAINT production_enrollment_invites_installation_id_fkey;
ALTER TABLE production_enrollment_invites
    ADD CONSTRAINT production_enrollment_invites_installation_id_fkey
    FOREIGN KEY (installation_id) REFERENCES production_installations(installation_id)
    ON DELETE CASCADE;
