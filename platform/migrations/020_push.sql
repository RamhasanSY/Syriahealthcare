-- Notifications on the phone or computer (Web Push, src/push.js). One row per browser that said yes; the keys let the
-- server encrypt messages that only that browser can read. A browser the push service no longer knows is removed.
CREATE TABLE push_subscriptions (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint     text NOT NULL UNIQUE CHECK (length(endpoint) <= 1000),
    p256dh       text NOT NULL CHECK (length(p256dh) <= 200),
    auth         text NOT NULL CHECK (length(auth) <= 100),
    user_agent   text CHECK (length(user_agent) <= 200),
    failures     integer NOT NULL DEFAULT 0,
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_sent_at timestamptz
);
CREATE INDEX push_subscriptions_user ON push_subscriptions (user_id);
