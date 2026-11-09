-- Measured values of lab results (sent by lab software as HL7 v2 OBX or FHIR Observation) are shown as a table.
-- The health file list says whether an entry has values; the values themselves are loaded (and recorded) one entry at a time.
CREATE OR REPLACE VIEW health_file_items AS
SELECT d.id, d.patient_id, d.source, d.category, d.title, d.document_date, d.created_at, d.updated_at, d.deleted_at,
       d.lab_result_id, COALESCE(f.pages, CASE WHEN d.lab_result_id IS NOT NULL THEN 1 ELSE 0 END) AS pages,
       COALESCE(f.bytes, r.size_bytes) AS size_bytes, p.facility_name AS lab_name,
       COALESCE(jsonb_typeof(r.observations) = 'array' AND jsonb_array_length(r.observations) > 0, false) AS has_values
FROM clinical_documents d
LEFT JOIN (SELECT document_id, count(*)::int AS pages, sum(size_bytes)::int AS bytes FROM clinical_document_files GROUP BY document_id) f
       ON f.document_id = d.id
LEFT JOIN lab_results r ON r.id = d.lab_result_id
LEFT JOIN facility_profiles p ON p.user_id = r.facility_id;
