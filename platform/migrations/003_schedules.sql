-- Opening hours and days off (Stage 1, step 3). Times are local to the clinic's time zone.

CREATE TABLE doctor_schedules (
    doctor_id           uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    timezone            text NOT NULL DEFAULT 'Asia/Damascus',
    slot_minutes        int  NOT NULL DEFAULT 20 CHECK (slot_minutes IN (10, 15, 20, 30, 45, 60)),
    booking_window_days int  NOT NULL DEFAULT 30 CHECK (booking_window_days BETWEEN 1 AND 90),
    min_notice_hours    int  NOT NULL DEFAULT 2  CHECK (min_notice_hours BETWEEN 0 AND 72),
    updated_at          timestamptz NOT NULL DEFAULT now()
);

-- Several ranges per day are allowed (e.g. 10:00–14:00 and 17:00–20:00). weekday: 0 = Sunday … 6 = Saturday.
CREATE TABLE weekly_hours (
    id         bigserial PRIMARY KEY,
    doctor_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    weekday    smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),
    starts_at  time NOT NULL,
    ends_at    time NOT NULL CHECK (ends_at > starts_at)
);
CREATE INDEX weekly_hours_doctor ON weekly_hours (doctor_id, weekday, starts_at);

-- Holidays, travel, conferences: whole days without appointments.
CREATE TABLE time_off (
    id         bigserial PRIMARY KEY,
    doctor_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    starts_on  date NOT NULL,
    ends_on    date NOT NULL CHECK (ends_on >= starts_on),
    note       text CHECK (length(note) <= 200),   -- private to the doctor
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX time_off_doctor ON time_off (doctor_id, ends_on);
