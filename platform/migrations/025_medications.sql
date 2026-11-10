-- Medicine reminders (src/medications.js), part of the health file: per profile (own or a child's), with the times of day.
CREATE TABLE medications (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    patient_id  uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
    name        text NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
    dose        text CHECK (length(dose) <= 60),
    times       text[] NOT NULL CHECK (cardinality(times) BETWEEN 1 AND 6),   -- 'HH:MM', Syria time
    weekdays    smallint[] NOT NULL DEFAULT '{}' CHECK (cardinality(weekdays) <= 7),  -- 0 = Sunday; empty = every day
    start_date  date NOT NULL,
    end_date    date CHECK (end_date >= start_date),
    notes       text CHECK (length(notes) <= 200),
    show_name   boolean NOT NULL DEFAULT false,   -- the medicine's name in the notification (lock screen)
    active      boolean NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX medications_patient ON medications (patient_id);
CREATE INDEX medications_active ON medications (start_date) WHERE active;

-- One row per dose that was reminded or ticked: the unique key makes every reminder go out once.
CREATE TABLE medication_doses (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    medication_id uuid NOT NULL REFERENCES medications(id) ON DELETE CASCADE,
    scheduled_for timestamptz NOT NULL,
    reminded_at   timestamptz,
    taken_at      timestamptz,
    UNIQUE (medication_id, scheduled_for)
);
