ALTER TABLE grade_submissions
  ADD COLUMN semester VARCHAR(20) NOT NULL DEFAULT '' AFTER subject_id;
