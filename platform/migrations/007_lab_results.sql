-- Lab results handed to patients as a QR code (Stage 1, results).
-- An approved lab or imaging centre uploads a result for a patient (name and mobile) and prints a QR code.
-- The code holds only a random key, never the result: an approved doctor scans it and the result is added to that
-- doctor's patient file. The file is encrypted at rest (AES-256-GCM), like licence documents.

CREATE TABLE lab_results (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    facility_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    patient_name    text NOT NULL CHECK (length(patient_name) BETWEEN 2 AND 120),
    patient_phone   text NOT NULL CHECK (patient_phone ~ '^\+[1-9][0-9]{7,14}$'),
    title           text NOT NULL CHECK (length(title) BETWEEN 2 AND 120),  -- e.g. "Complete blood count"
    code_hash       text NOT NULL UNIQUE,   -- HMAC of the QR code; a new code replaces the old one
    code_expires_at timestamptz NOT NULL,
    filename        text NOT NULL CHECK (length(filename) <= 200),
    mime            text NOT NULL CHECK (mime IN ('application/pdf', 'image/jpeg', 'image/png')),
    size_bytes      int NOT NULL CHECK (size_bytes > 0),
    sha256          text NOT NULL,
    storage_key     text NOT NULL UNIQUE,
    iv              text NOT NULL,
    auth_tag        text NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX lab_results_facility ON lab_results (facility_id, created_at DESC);

-- A doctor's patient file: the results this doctor has scanned. Several doctors may add the same result.
CREATE TABLE patient_file_results (
    doctor_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    result_id  uuid NOT NULL REFERENCES lab_results(id) ON DELETE CASCADE,
    added_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (doctor_id, result_id)
);
CREATE INDEX patient_file_results_doctor ON patient_file_results (doctor_id, added_at DESC);
