-- Accounts, sign-in and audit trail for the Syria Healthcare platform (Stage 1).
-- Patients sign in with a phone number and an SMS code; doctors and admins with email and password.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE user_role AS ENUM ('patient', 'doctor', 'admin');

CREATE TABLE users (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    role          user_role NOT NULL,
    name          text NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
    phone         text UNIQUE CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),
    email         text UNIQUE CHECK (email = lower(email) AND email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
    password_hash text,
    language      text NOT NULL DEFAULT 'ar' CHECK (language IN ('ar', 'en')),
    consented_at  timestamptz,
    disabled_at   timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now(),
    -- Patients are identified by phone; doctors and admins by email and password.
    CONSTRAINT patient_has_phone CHECK (role <> 'patient' OR phone IS NOT NULL),
    CONSTRAINT staff_has_password CHECK (role = 'patient' OR (email IS NOT NULL AND password_hash IS NOT NULL))
);

-- One-time SMS codes. Only an HMAC of the code is stored.
CREATE TABLE otp_codes (
    id          bigserial PRIMARY KEY,
    phone       text NOT NULL,
    code_hash   text NOT NULL,
    attempts    int NOT NULL DEFAULT 0,
    expires_at  timestamptz NOT NULL,
    consumed_at timestamptz,
    ip          inet,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX otp_codes_phone_created ON otp_codes (phone, created_at DESC);

-- Sessions. The browser holds a random token; only its SHA-256 hash is stored.
CREATE TABLE sessions (
    token_hash  text PRIMARY KEY,
    user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at  timestamptz NOT NULL,
    last_seen   timestamptz NOT NULL DEFAULT now(),
    user_agent  text,
    ip          inet,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user ON sessions (user_id);

-- Failed password sign-ins, for per-account lockout.
CREATE TABLE login_failures (
    id         bigserial PRIMARY KEY,
    email      text NOT NULL,
    ip         inet,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_failures_email_created ON login_failures (email, created_at DESC);

-- Who did what. Admin actions on doctors and accounts are always recorded here.
CREATE TABLE audit_log (
    id         bigserial PRIMARY KEY,
    actor_id   uuid REFERENCES users(id) ON DELETE SET NULL,
    action     text NOT NULL,
    target_id  uuid,
    details    jsonb NOT NULL DEFAULT '{}',
    ip         inet,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_created ON audit_log (created_at DESC);
