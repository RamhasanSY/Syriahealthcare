-- Indexes for queries that would otherwise read whole tables as the platform grows.
-- "Who opened my file" (src/sharing.js, FHIR AuditEvent) looks up the audit trail by the patient in details.patient_id.
CREATE INDEX audit_log_patient ON audit_log ((details->>'patient_id'), created_at DESC);
-- FHIR Appointment?patient= and the health file's appointments list by the profile the appointment is for.
CREATE INDEX appointments_subject ON appointments (subject_id, starts_at DESC) WHERE subject_id IS NOT NULL;
