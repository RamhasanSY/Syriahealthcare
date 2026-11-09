-- Stage 2d: lab and clinic software sends results and documents directly (HL7 FHIR and HL7 v2 over HTTPS).
-- An administrator gives an approved facility a client with scopes (SMART v2 style, e.g. system/DiagnosticReport.c).
-- The secret is shown once and stored only as a hash. Access tokens live 15 minutes. When the facility is suspended or
-- switched off, its clients stop working at once (checked on every request, not only when a token is issued).

CREATE TABLE api_clients (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    facility_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name         text NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
    client_id    text NOT NULL UNIQUE CHECK (client_id ~ '^shc_[a-z0-9]{20}$'),
    secret_hash  text NOT NULL,
    scopes       text[] NOT NULL CHECK (cardinality(scopes) BETWEEN 1 AND 10),
    created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz,
    revoked_at   timestamptz
);
CREATE INDEX api_clients_facility ON api_clients (facility_id);

CREATE TABLE api_tokens (
    token_hash text PRIMARY KEY,
    client_id  uuid NOT NULL REFERENCES api_clients(id) ON DELETE CASCADE,
    scopes     text[] NOT NULL,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- Results and documents from software: the sender's own number makes a repeated send harmless, the values travel along
-- (LOINC code, value, UCUM unit), and a result can go straight into the patient's file when number and birth year match.
ALTER TABLE lab_results
    ADD COLUMN external_id   text CHECK (length(external_id) <= 100),
    ADD COLUMN source        text NOT NULL DEFAULT 'app' CHECK (source IN ('app', 'fhir', 'hl7v2')),
    ADD COLUMN category      text NOT NULL DEFAULT 'lab' CHECK (category IN ('lab', 'imaging', 'report', 'prescription', 'discharge', 'vaccination', 'other')),
    ADD COLUMN observations  jsonb,
    ADD COLUMN api_client_id uuid REFERENCES api_clients(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX lab_results_external ON lab_results (facility_id, external_id) WHERE external_id IS NOT NULL;
