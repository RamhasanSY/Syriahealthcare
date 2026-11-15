-- Blood donation calls (src/blood.js). Blood banks and hospitals post what they need; the list is public.
CREATE TABLE blood_requests (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    facility_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blood_types    text[] NOT NULL CHECK (cardinality(blood_types) BETWEEN 1 AND 8
                       AND blood_types <@ ARRAY['O-', 'O+', 'A-', 'A+', 'B-', 'B+', 'AB-', 'AB+']),
    units          integer CHECK (units BETWEEN 1 AND 100),
    urgency        text NOT NULL DEFAULT 'normal' CHECK (urgency IN ('urgent', 'normal')),
    needed_by      date NOT NULL,
    governorate    text NOT NULL,
    contact_phone  text NOT NULL CHECK (contact_phone ~ '^\+[1-9][0-9]{7,14}$'),
    note           text CHECK (length(note) <= 300),
    status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
    notified_count integer NOT NULL DEFAULT 0,
    created_at     timestamptz NOT NULL DEFAULT now(),
    closed_at      timestamptz
);
CREATE INDEX blood_requests_open ON blood_requests (governorate, needed_by) WHERE status = 'open';
CREATE INDEX blood_requests_facility ON blood_requests (facility_id, created_at DESC);

-- Patients who want to be told about calls. The blood group is health data: only while HEALTH_FILE=on, with consent.
CREATE TABLE blood_donors (
    user_id            uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    blood_type         text NOT NULL CHECK (blood_type IN ('O-', 'O+', 'A-', 'A+', 'B-', 'B+', 'AB-', 'AB+')),
    governorate        text NOT NULL,
    phone              text NOT NULL CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),
    notify             boolean NOT NULL DEFAULT true,
    last_donation_date date,
    last_notified_at   timestamptz,
    consent_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX blood_donors_match ON blood_donors (governorate, blood_type) WHERE notify;

-- "I can donate": the donor's name, phone and blood group go to this facility only.
CREATE TABLE blood_responses (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id uuid NOT NULL REFERENCES blood_requests(id) ON DELETE CASCADE,
    donor_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blood_type text NOT NULL,
    phone      text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (request_id, donor_id)
);
