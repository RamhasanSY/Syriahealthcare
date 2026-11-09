-- Stage 2b: health file and patient master data (MDM / master patient index).
-- A person (patients) is separate from a login (users): one login can hold the own profile and children's profiles,
-- and two profiles of the same person can be merged later (merged_into). The phone number is only a way to reach
-- someone, never the key to a file. The health file stays switched off (HEALTH_FILE) until the privacy policy is ready.

CREATE TABLE patients (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    patient_number text NOT NULL UNIQUE CHECK (patient_number ~ '^SHC-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]$'),
    name           text NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
    birth_date     date CHECK (birth_date >= DATE '1900-01-01'),
    sex            text CHECK (sex IN ('female', 'male')),
    merged_into    uuid REFERENCES patients(id),
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT not_merged_into_itself CHECK (merged_into IS DISTINCT FROM id)
);

-- Other identifiers of a person (the SyriaHC number is also listed here, so lookups work one way for all of them).
CREATE TABLE patient_identifiers (
    patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    system     text NOT NULL CHECK (length(system) <= 200),
    value      text NOT NULL CHECK (length(value) <= 100),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (system, value)
);
CREATE INDEX patient_identifiers_patient ON patient_identifiers (patient_id);

-- Which login may open which profile: the own profile (exactly one) and children's profiles.
CREATE TABLE patient_access (
    user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    patient_id   uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    relationship text NOT NULL CHECK (relationship IN ('self', 'child')),
    created_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, patient_id)
);
CREATE UNIQUE INDEX patient_access_one_self ON patient_access (user_id) WHERE relationship = 'self';
CREATE INDEX patient_access_patient ON patient_access (patient_id);

-- Consent to keep a health file for a profile, with the version of the privacy policy it was given under.
CREATE TABLE consents (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    patient_id     uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    user_id        uuid REFERENCES users(id) ON DELETE SET NULL,
    scope          text NOT NULL CHECK (scope IN ('health_file')),
    policy_version text NOT NULL CHECK (length(policy_version) <= 40),
    given_at       timestamptz NOT NULL DEFAULT now(),
    withdrawn_at   timestamptz
);
CREATE UNIQUE INDEX consents_one_active ON consents (patient_id, scope) WHERE withdrawn_at IS NULL;

-- Entries of the health file: the patient's own uploads, and lab results the patient took over from a lab slip.
CREATE TABLE clinical_documents (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    patient_id    uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    source        text NOT NULL CHECK (source IN ('upload', 'lab_result')),
    lab_result_id uuid UNIQUE REFERENCES lab_results(id) ON DELETE CASCADE,
    category      text NOT NULL CHECK (category IN ('lab', 'imaging', 'report', 'prescription', 'discharge', 'vaccination', 'other')),
    title         text NOT NULL CHECK (length(title) BETWEEN 2 AND 120),
    document_date date,
    created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    deleted_at    timestamptz,   -- moved to the bin; removed for good after 30 days
    CONSTRAINT lab_result_source CHECK ((source = 'lab_result') = (lab_result_id IS NOT NULL))
);
CREATE INDEX clinical_documents_patient ON clinical_documents (patient_id, document_date DESC, created_at DESC);

-- The pages of an uploaded entry, encrypted at rest like every other document (AES-256-GCM).
CREATE TABLE clinical_document_files (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id uuid NOT NULL REFERENCES clinical_documents(id) ON DELETE CASCADE,
    page        int NOT NULL CHECK (page BETWEEN 1 AND 30),
    filename    text NOT NULL CHECK (length(filename) <= 200),
    mime        text NOT NULL CHECK (mime IN ('application/pdf', 'image/jpeg', 'image/png')),
    size_bytes  int NOT NULL CHECK (size_bytes > 0),
    sha256      text NOT NULL,
    storage_key text NOT NULL UNIQUE,
    iv          text NOT NULL,
    auth_tag    text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (document_id, page)
);

-- Lab slips printed from now on can be taken into the patient's own file. Taking one over needs the code and a second
-- detail only the patient knows: the birth year the lab entered, or the last 3 digits of the mobile number.
ALTER TABLE lab_results
    ADD COLUMN birth_year        smallint CHECK (birth_year BETWEEN 1900 AND 2100),
    ADD COLUMN slip_version      smallint NOT NULL DEFAULT 1,
    ADD COLUMN claim_attempts    int NOT NULL DEFAULT 0,
    ADD COLUMN claim_reported_at timestamptz;

-- For whom an appointment was booked (the own profile or a child's).
ALTER TABLE appointments ADD COLUMN subject_id uuid REFERENCES patients(id);

-- The health file as one list, newest first (used by the timeline and by FHIR DocumentReference).
CREATE VIEW health_file_items AS
SELECT d.id, d.patient_id, d.source, d.category, d.title, d.document_date, d.created_at, d.updated_at, d.deleted_at,
       d.lab_result_id, COALESCE(f.pages, CASE WHEN d.lab_result_id IS NOT NULL THEN 1 ELSE 0 END) AS pages,
       COALESCE(f.bytes, r.size_bytes) AS size_bytes, p.facility_name AS lab_name
FROM clinical_documents d
LEFT JOIN (SELECT document_id, count(*)::int AS pages, sum(size_bytes)::int AS bytes FROM clinical_document_files GROUP BY document_id) f
       ON f.document_id = d.id
LEFT JOIN lab_results r ON r.id = d.lab_result_id
LEFT JOIN facility_profiles p ON p.user_id = r.facility_id;
