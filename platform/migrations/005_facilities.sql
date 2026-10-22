-- Labs, imaging centres, hospitals and clinics (Stage 1, facilities).
-- Same review workflow as doctors: draft -> pending -> approved | rejected; approved -> suspended.
-- Approved facilities are copied to the public website's Labs and Hospitals pages.

ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'facility';

CREATE TABLE facility_profiles (
    user_id          uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    kind             text NOT NULL CHECK (kind IN ('lab', 'imaging', 'hospital', 'clinic')),
    status           doctor_status NOT NULL DEFAULT 'draft',
    facility_name    text CHECK (length(facility_name) <= 160),
    governorate      text,            -- key from src/catalog.js
    area             text CHECK (length(area) <= 120),
    address          text CHECK (length(address) <= 300),
    phone            text CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),
    licence_number   text CHECK (length(licence_number) <= 60),
    services         text[] NOT NULL DEFAULT '{}' CHECK (cardinality(services) <= 30),  -- keys from src/catalog.js
    emergency        boolean NOT NULL DEFAULT false,  -- hospitals and clinics with an emergency department
    opening_hours    text CHECK (length(opening_hours) <= 200),
    description      text CHECK (length(description) <= 600),
    submitted_at     timestamptz,
    reviewed_at      timestamptz,
    reviewed_by      uuid REFERENCES users(id) ON DELETE SET NULL,
    review_note      text CHECK (length(review_note) <= 1000),  -- shown to the facility
    updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX facility_profiles_status ON facility_profiles (status, submitted_at);

-- Facility licences are stored in doctor_documents too: its doctor_id is the owning account, doctor or facility.
COMMENT ON COLUMN doctor_documents.doctor_id IS 'Owning account (doctor or facility)';
