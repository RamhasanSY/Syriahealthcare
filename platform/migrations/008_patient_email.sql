-- Patients can sign in with an email address as well as a mobile number (SMS and WhatsApp do not reach most
-- Syrian numbers yet). A patient account needs at least one of the two; staff accounts are unchanged.
ALTER TABLE users DROP CONSTRAINT patient_has_phone;
ALTER TABLE users ADD CONSTRAINT patient_has_contact CHECK (role <> 'patient' OR phone IS NOT NULL OR email IS NOT NULL);
