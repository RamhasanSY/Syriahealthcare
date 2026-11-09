-- Stage 2c: patients share single entries of their health file with a doctor, and see and revoke who has access.
-- A share (access_grant) is from the directory (1, 30 or 90 days), from booking (until 30 days after the appointment),
-- or from a QR code shown to the doctor (15 minutes). Revoking works at once, for the whole share or for one entry.

CREATE TABLE access_grants (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    patient_id     uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    doctor_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    granted_by     uuid REFERENCES users(id) ON DELETE SET NULL,
    source         text NOT NULL CHECK (source IN ('directory', 'booking', 'qr')),
    appointment_id uuid REFERENCES appointments(id) ON DELETE SET NULL,
    starts_at      timestamptz NOT NULL DEFAULT now(),
    expires_at     timestamptz NOT NULL,
    revoked_at     timestamptz,
    created_at     timestamptz NOT NULL DEFAULT now(),
    CHECK (expires_at > starts_at)
);
CREATE INDEX access_grants_doctor ON access_grants (doctor_id, expires_at DESC);
CREATE INDEX access_grants_patient ON access_grants (patient_id, created_at DESC);

-- The entries of a share. One entry can be taken out of a share without ending the rest.
CREATE TABLE access_grant_items (
    grant_id    uuid NOT NULL REFERENCES access_grants(id) ON DELETE CASCADE,
    document_id uuid NOT NULL REFERENCES clinical_documents(id) ON DELETE CASCADE,
    revoked_at  timestamptz,
    PRIMARY KEY (grant_id, document_id)
);
CREATE INDEX access_grant_items_document ON access_grant_items (document_id);

-- "Show to the doctor": a code the patient shows as QR; the first approved doctor who scans it within 15 minutes
-- gets a 15-minute share of the chosen entries. The code works once. Only its HMAC is stored.
CREATE TABLE share_codes (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    patient_id  uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
    code_hash   text NOT NULL UNIQUE,
    document_ids uuid[] NOT NULL CHECK (cardinality(document_ids) BETWEEN 1 AND 100),
    expires_at  timestamptz NOT NULL,
    used_at     timestamptz,
    used_by     uuid REFERENCES users(id) ON DELETE SET NULL,
    grant_id    uuid REFERENCES access_grants(id) ON DELETE SET NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- A patient can also take a scanned lab result away from a doctor's patient files.
ALTER TABLE patient_file_results ADD COLUMN revoked_at timestamptz;

-- Doctors confirm their email address and sign in with a second factor (an emailed code) before they see shared
-- entries. The session remembers when that happened; a device can be remembered for 30 days.
ALTER TABLE sessions ADD COLUMN second_factor_at timestamptz;
CREATE TABLE trusted_devices (
    token_hash text PRIMARY KEY,
    user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX trusted_devices_user ON trusted_devices (user_id);
