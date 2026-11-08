-- Second factor for administrators (stage 2a): after the right password, a 6-digit code goes to the account's email.
-- The browser keeps a one-time challenge token between the two steps, so the code is useless without the password step.
CREATE TABLE staff_login_codes (
    id          bigserial PRIMARY KEY,
    user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  text NOT NULL UNIQUE,   -- SHA-256 of the challenge token
    code_hash   text NOT NULL,          -- HMAC of the code
    attempts    int NOT NULL DEFAULT 0,
    expires_at  timestamptz NOT NULL,
    consumed_at timestamptz,
    ip          inet,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX staff_login_codes_user ON staff_login_codes (user_id, created_at DESC);
