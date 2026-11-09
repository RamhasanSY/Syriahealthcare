-- Pharmacies and blood banks can register as facilities too (src/catalog.js, facilityKinds).
-- They go through the same review as labs and hospitals, and approved ones appear on the website's
-- Pharmacies and Blood banks pages. Only labs and imaging centres can send lab results (src/results.js).
-- PostgreSQL named the inline CHECK from 005_facilities.sql facility_profiles_kind_check.

ALTER TABLE facility_profiles DROP CONSTRAINT facility_profiles_kind_check;
ALTER TABLE facility_profiles ADD CONSTRAINT facility_profiles_kind_check
    CHECK (kind IN ('lab', 'imaging', 'hospital', 'clinic', 'pharmacy', 'blood_bank'));
