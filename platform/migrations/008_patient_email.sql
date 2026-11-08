-- Patients can sign in with a code sent by email, as well as with a mobile number (SMS and WhatsApp do not reach
-- most Syrian numbers yet). A patient account needs at least one of the two; staff accounts are unchanged.
ALTER TABLE users DROP CONSTRAINT patient_has_phone;
ALTER TABLE users ADD CONSTRAINT patient_has_contact CHECK (role <> 'patient' OR phone IS NOT NULL OR email IS NOT NULL);
-- Set when a patient proves the address by entering an emailed code.
ALTER TABLE users ADD COLUMN email_verified_at timestamptz;

-- One-time sign-in codes now go to a phone or to an email address (exactly one of the two).
ALTER TABLE otp_codes ALTER COLUMN phone DROP NOT NULL;
ALTER TABLE otp_codes ADD COLUMN email text CHECK (email = lower(email));
ALTER TABLE otp_codes ADD CONSTRAINT otp_codes_one_destination CHECK (num_nonnulls(phone, email) = 1);
CREATE INDEX otp_codes_email_created ON otp_codes (email, created_at DESC) WHERE email IS NOT NULL;
