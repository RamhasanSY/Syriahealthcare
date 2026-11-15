-- Video consultations (src/video.js): a doctor offers them, a patient books an appointment as "video".
ALTER TABLE doctor_profiles ADD COLUMN video_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE appointments ADD COLUMN mode text NOT NULL DEFAULT 'in_person' CHECK (mode IN ('in_person', 'video'));
