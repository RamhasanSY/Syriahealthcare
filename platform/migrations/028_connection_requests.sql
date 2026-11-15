-- An approved facility asks for a software connection on the "Connect your software" page (src/oauth.js).
-- One open request per facility. It closes when an administrator creates a connection for that facility, or closes it.
CREATE TABLE api_client_requests (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    facility_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    software     text NOT NULL CHECK (length(software) BETWEEN 2 AND 120),
    contact      text CHECK (length(contact) <= 300),
    created_at   timestamptz NOT NULL DEFAULT now(),
    closed_at    timestamptz,
    closed_by    uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX api_client_requests_one_open ON api_client_requests (facility_id) WHERE closed_at IS NULL;
