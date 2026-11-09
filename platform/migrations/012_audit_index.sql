-- Stage 2a: the audit trail is read by who was affected (admin history, later "who opened my file") and by who acted.
CREATE INDEX audit_log_target ON audit_log (target_id, created_at DESC) WHERE target_id IS NOT NULL;
CREATE INDEX audit_log_actor  ON audit_log (actor_id, created_at DESC) WHERE actor_id IS NOT NULL;
