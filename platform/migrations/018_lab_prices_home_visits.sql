-- Lab services: a public price list per lab, and home sample collection that patients request and the lab confirms.

-- The tests a lab or imaging centre offers, with price (Syrian pounds) and how long the result takes. Shown on
-- syriahc.com and app.syriahc.com/lab once the lab is approved. "service" links a test to a kind in src/catalog.js.
CREATE TABLE lab_tests (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    facility_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name             text NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
    service          text CHECK (length(service) <= 40),
    price_syp        integer CHECK (price_syp BETWEEN 0 AND 100000000),   -- NULL: price on request
    turnaround_hours integer CHECK (turnaround_hours BETWEEN 0 AND 2000),
    notes            text CHECK (length(notes) <= 200),                   -- e.g. "fasting 8 hours"
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    UNIQUE (facility_id, name)
);

-- A patient asks a lab to take samples at home on a day and in a part of the day; the lab confirms (with an arrival
-- time), declines, cancels or marks it done. The address and phone are seen only by this lab and the patient.
CREATE TABLE home_visits (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    facility_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    patient_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    subject_id   uuid REFERENCES patients(id),
    visit_date   date NOT NULL,
    time_window  text NOT NULL CHECK (time_window IN ('morning', 'midday', 'afternoon', 'evening')),
    address      text NOT NULL CHECK (length(address) BETWEEN 5 AND 300),
    phone        text NOT NULL CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),
    tests        text CHECK (length(tests) <= 300),
    status       text NOT NULL DEFAULT 'requested'
                 CHECK (status IN ('requested', 'confirmed', 'declined', 'cancelled_by_patient', 'cancelled_by_lab', 'done')),
    arrival_time text CHECK (arrival_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
    lab_note     text CHECK (length(lab_note) <= 300),
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX home_visits_facility ON home_visits (facility_id, visit_date);
CREATE INDEX home_visits_patient ON home_visits (patient_id, created_at DESC);
