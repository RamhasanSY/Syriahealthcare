-- Pharmacies on duty (src/pharmacy-duty.js): night and holiday duties that pharmacies enter themselves.
-- The database refuses two duties of the same pharmacy that overlap.
CREATE TABLE pharmacy_duties (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    facility_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    starts_at   timestamptz NOT NULL,
    ends_at     timestamptz NOT NULL CHECK (ends_at > starts_at AND ends_at <= starts_at + interval '36 hours'),
    note        text CHECK (length(note) <= 120),
    created_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT no_overlapping_duties EXCLUDE USING gist (facility_id WITH =, tstzrange(starts_at, ends_at) WITH &&)
);
CREATE INDEX pharmacy_duties_time ON pharmacy_duties (starts_at, ends_at);
