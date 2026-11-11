-- Operator-provisioned customers may use a username without an invented email.
-- Public registration remains email-only and cannot choose roles/usernames.
BEGIN;
ALTER TABLE workspace.accounts DROP CONSTRAINT IF EXISTS accounts_check;
ALTER TABLE workspace.accounts DROP CONSTRAINT IF EXISTS accounts_identity_check;
ALTER TABLE workspace.accounts ADD CONSTRAINT accounts_identity_check CHECK (
 (role='customer' AND customer_id IS NOT NULL AND
   ((email IS NOT NULL AND username IS NULL) OR (email IS NULL AND username IS NOT NULL)))
 OR (role='merchant_admin' AND customer_id IS NULL AND username IS NOT NULL AND email IS NULL)
);
COMMIT;
