-- Queue of emails that must arrive eventually (stage 2a). A row is sent once, or retried later with a growing pause.
CREATE TABLE email_outbox (
    id              bigserial PRIMARY KEY,
    to_address      text NOT NULL CHECK (length(to_address) <= 254),
    subject         text NOT NULL CHECK (length(subject) <= 300),
    body            text NOT NULL CHECK (length(body) <= 20000),
    attempts        int NOT NULL DEFAULT 0,
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    sent_at         timestamptz,
    failed_at       timestamptz,          -- given up after the last attempt
    last_error      text CHECK (length(last_error) <= 300),
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX email_outbox_due ON email_outbox (next_attempt_at) WHERE sent_at IS NULL AND failed_at IS NULL;
