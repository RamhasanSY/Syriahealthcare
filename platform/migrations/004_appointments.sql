-- Appointments (Stage 1, step 4). A patient requests a free slot; the doctor confirms or declines (step 5).
-- The database itself refuses two active bookings that overlap for the same doctor or the same patient,
-- so two people clicking the same slot at the same moment cannot both get it.

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TYPE appointment_status AS ENUM ('requested', 'confirmed', 'declined', 'cancelled_by_patient', 'cancelled_by_doctor', 'completed', 'no_show');

CREATE TABLE appointments (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    doctor_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    patient_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    starts_at     timestamptz NOT NULL,
    ends_at       timestamptz NOT NULL CHECK (ends_at > starts_at),
    status        appointment_status NOT NULL DEFAULT 'requested',
    reason        text CHECK (length(reason) <= 300),       -- visible only to the patient and this doctor
    status_note   text CHECK (length(status_note) <= 300),  -- e.g. why it was declined or cancelled
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT no_double_booking_doctor EXCLUDE USING gist (doctor_id WITH =, tstzrange(starts_at, ends_at) WITH &&)
        WHERE (status IN ('requested', 'confirmed')),
    CONSTRAINT no_double_booking_patient EXCLUDE USING gist (patient_id WITH =, tstzrange(starts_at, ends_at) WITH &&)
        WHERE (status IN ('requested', 'confirmed'))
);
CREATE INDEX appointments_patient ON appointments (patient_id, starts_at DESC);
CREATE INDEX appointments_doctor ON appointments (doctor_id, starts_at);
