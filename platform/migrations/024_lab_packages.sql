-- Lab packages (src/lab-packages.js): tests from a lab's own price list bundled at one price. A test that leaves the
-- price list leaves its packages too.
CREATE TABLE lab_packages (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    facility_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        text NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
    topic       text CHECK (length(topic) <= 40),      -- key from src/catalog.js packageTopics
    description text CHECK (length(description) <= 300),
    price_syp   integer NOT NULL CHECK (price_syp BETWEEN 0 AND 100000000),
    active      boolean NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (facility_id, name)
);

CREATE TABLE lab_package_tests (
    package_id uuid NOT NULL REFERENCES lab_packages(id) ON DELETE CASCADE,
    test_id    uuid NOT NULL REFERENCES lab_tests(id) ON DELETE CASCADE,
    PRIMARY KEY (package_id, test_id)
);
CREATE INDEX lab_package_tests_test ON lab_package_tests (test_id);
