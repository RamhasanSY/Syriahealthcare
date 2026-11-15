-- Appointment comfort (src/appointment-comfort.js): a reminder before the appointment, moving it to another time,
-- and a waiting list per doctor.
ALTER TABLE appointments
    ADD COLUMN reminder_sent_at timestamptz,
    ADD COLUMN reschedule_count integer NOT NULL DEFAULT 0 CHECK (reschedule_count BETWEEN 0 AND 10);
CREATE INDEX appointments_reminder_due ON appointments (starts_at) WHERE status = 'confirmed' AND reminder_sent_at IS NULL;

-- A patient waiting for a free time with a doctor, for 30 days. notified_at keeps the messages to one per 6 hours.
CREATE TABLE waitlist_entries (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    patient_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    doctor_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  timestamptz NOT NULL DEFAULT now(),
    expires_at  timestamptz NOT NULL DEFAULT now() + interval '30 days',
    notified_at timestamptz,
    UNIQUE (patient_id, doctor_id)
);
CREATE INDEX waitlist_entries_doctor ON waitlist_entries (doctor_id, expires_at);
