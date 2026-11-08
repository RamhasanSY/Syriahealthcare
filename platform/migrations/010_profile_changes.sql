-- Changes to an approved profile that identify the professional or the place wait here until an administrator decides
-- (stage 2a). Other details apply at once. The profile stays approved and visible while changes wait.
ALTER TABLE doctor_profiles   ADD COLUMN pending_changes jsonb, ADD COLUMN changes_submitted_at timestamptz;
ALTER TABLE facility_profiles ADD COLUMN pending_changes jsonb, ADD COLUMN changes_submitted_at timestamptz;
