-- Doctor profiles, licence documents and the admin review workflow (Stage 1, step 2).
-- draft -> pending (doctor submits) -> approved | rejected (admin decides); approved -> suspended (admin).
-- Editing an approved profile sends it back to pending, so patients only ever see reviewed details.

CREATE TYPE doctor_status AS ENUM ('draft', 'pending', 'approved', 'rejected', 'suspended');

CREATE TABLE doctor_profiles (
    user_id          uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    status           doctor_status NOT NULL DEFAULT 'draft',
    specialty        text,            -- key from src/catalog.js
    governorate      text,            -- key from src/catalog.js
    area             text CHECK (length(area) <= 120),
    clinic_name      text CHECK (length(clinic_name) <= 160),
    clinic_address   text CHECK (length(clinic_address) <= 300),
    clinic_phone     text CHECK (clinic_phone ~ '^\+[1-9][0-9]{7,14}$'),
    licence_number   text CHECK (length(licence_number) <= 60),
    bio              text CHECK (length(bio) <= 600),
    submitted_at     timestamptz,
    reviewed_at      timestamptz,
    reviewed_by      uuid REFERENCES users(id) ON DELETE SET NULL,
    review_note      text CHECK (length(review_note) <= 1000),  -- shown to the doctor
    updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX doctor_profiles_status ON doctor_profiles (status, submitted_at);

-- Uploaded licence and syndicate documents, encrypted at rest (AES-256-GCM). Only admins can open them.
CREATE TABLE doctor_documents (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    doctor_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind         text NOT NULL CHECK (kind IN ('licence', 'syndicate', 'other')),
    filename     text NOT NULL CHECK (length(filename) <= 200),
    mime         text NOT NULL CHECK (mime IN ('application/pdf', 'image/jpeg', 'image/png')),
    size_bytes   int NOT NULL CHECK (size_bytes > 0),
    sha256       text NOT NULL,
    storage_key  text NOT NULL UNIQUE,
    iv           text NOT NULL,
    auth_tag     text NOT NULL,
    uploaded_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX doctor_documents_doctor ON doctor_documents (doctor_id, uploaded_at);

-- Every doctor account gets a profile row (existing ones too).
INSERT INTO doctor_profiles (user_id) SELECT id FROM users WHERE role = 'doctor' ON CONFLICT DO NOTHING;
