-- Reviews of doctors (src/reviews.js): one per completed appointment, checked by an administrator before it is public.
CREATE TABLE doctor_reviews (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    appointment_id uuid NOT NULL UNIQUE REFERENCES appointments(id) ON DELETE CASCADE,
    doctor_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    patient_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    rating         smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
    comment        text CHECK (length(comment) <= 500),
    show_name      boolean NOT NULL DEFAULT false,      -- "Lina N." instead of "Patient"
    status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    review_note    text CHECK (length(review_note) <= 300),   -- the administrator's reason
    reviewed_by    uuid REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at    timestamptz,
    report_reason  text CHECK (length(report_reason) <= 300), -- the doctor's report
    reported_at    timestamptz,
    reply          text CHECK (length(reply) <= 500),         -- the doctor's public answer
    reply_at       timestamptz,
    created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX doctor_reviews_doctor ON doctor_reviews (doctor_id, created_at DESC) WHERE status = 'approved';
CREATE INDEX doctor_reviews_pending ON doctor_reviews (created_at) WHERE status = 'pending';
