ALTER TABLE teachers
  ADD COLUMN google_sync_status ENUM('pending','synced','failed') NOT NULL DEFAULT 'pending';
