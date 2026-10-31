-- "Forgot password" for doctors, facilities and admins. The emailed link carries a random token;
-- only its SHA-256 hash is stored. Each link works once and expires after 30 minutes.

CREATE TABLE password_resets (
    token_hash  text PRIMARY KEY,
    user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at  timestamptz NOT NULL,
    used_at     timestamptz,
    ip          inet,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX password_resets_user_created ON password_resets (user_id, created_at DESC);
