-- Doctors and facilities confirm their email before their account exists. Until then the form waits here with a
-- 6-digit code that went to the address. An address that already has an account gets a row too, whose code can never
-- match, and an email saying so: the answer on screen is the same either way, so nobody learns who is registered.
CREATE TABLE staff_signups (
    id            bigserial PRIMARY KEY,
    email         text NOT NULL,
    role          text NOT NULL CHECK (role IN ('doctor', 'facility')),
    kind          text,                -- facility kind (lab, hospital, ...); NULL for doctors
    name          text NOT NULL,
    password_hash text,                -- scrypt hash from the form; NULL when the address already has an account
    language      text NOT NULL DEFAULT 'ar',
    code_hash     text NOT NULL,       -- HMAC of the code
    attempts      int NOT NULL DEFAULT 0,
    expires_at    timestamptz NOT NULL,
    consumed_at   timestamptz,
    ip            inet,
    created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX staff_signups_email ON staff_signups (email, created_at DESC);
