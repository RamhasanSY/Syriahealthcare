-- People delete their own accounts (src/account-deletion.js). Patients are deleted at once. Doctors and facilities are
-- switched off at once and marked here; an administrator removes them for good with `npm run delete-account`, because
-- lab results and licence documents may have to be kept for a while.
ALTER TABLE users ADD COLUMN deletion_requested_at timestamptz;
