CREATE DATABASE IF NOT EXISTS teacher_grades CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE teacher_grades;

CREATE TABLE IF NOT EXISTS teachers (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  telegram_id BIGINT UNSIGNED NOT NULL,
  phone VARCHAR(32) NULL,
  telegram_username VARCHAR(64) NULL,
  telegram_display_name VARCHAR(255) NULL,
  full_name VARCHAR(255) NULL,
  verification_status ENUM('pending','verified','rejected') NOT NULL DEFAULT 'pending',
  registered_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  verified_at DATETIME NULL,
  verified_by VARCHAR(100) NULL,
  google_sync_status ENUM('pending','synced','failed') NOT NULL DEFAULT 'pending',
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_teachers_telegram_id (telegram_id),
  UNIQUE KEY uq_teachers_phone (phone),
  KEY idx_teachers_verification (verification_status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS subjects (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(255) NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_subjects_name (name),
  KEY idx_subjects_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS student_groups (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(255) NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_groups_name (name),
  KEY idx_groups_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS students (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  full_name VARCHAR(255) NOT NULL,
  group_id INT UNSIGNED NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_students_group (group_id),
  KEY idx_students_name (full_name),
  CONSTRAINT fk_students_group FOREIGN KEY (group_id) REFERENCES student_groups(id) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS grade_submissions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id CHAR(36) NOT NULL,
  teacher_id INT UNSIGNED NOT NULL,
  subject_id INT UNSIGNED NOT NULL,
  semester VARCHAR(20) NOT NULL,
  group_id INT UNSIGNED NOT NULL,
  student_id INT UNSIGNED NULL,
  student_name_snapshot VARCHAR(255) NOT NULL,
  grade VARCHAR(20) NOT NULL,
  submitted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  secretary_status ENUM('pending','read','needs_correction') NOT NULL DEFAULT 'pending',
  read_at DATETIME NULL,
  read_by VARCHAR(100) NULL,
  correction_comment TEXT NULL,
  google_sync_status ENUM('pending','synced','failed') NOT NULL DEFAULT 'pending',
  google_sheet_row INT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_grade_public_id (public_id),
  KEY idx_grades_teacher (teacher_id),
  KEY idx_grades_subject (subject_id),
  KEY idx_grades_group (group_id),
  KEY idx_grades_student (student_id),
  KEY idx_grades_secretary_status (secretary_status),
  CONSTRAINT fk_grade_teacher FOREIGN KEY (teacher_id) REFERENCES teachers(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_grade_subject FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_grade_group FOREIGN KEY (group_id) REFERENCES student_groups(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_grade_student FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS audit_log (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_or_admin VARCHAR(128) NOT NULL,
  action_type VARCHAR(100) NOT NULL,
  target_type VARCHAR(50) NULL,
  target_id BIGINT UNSIGNED NULL,
  previous_value JSON NULL,
  new_value JSON NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  metadata JSON NULL,
  PRIMARY KEY (id),
  KEY idx_audit_user (user_or_admin),
  KEY idx_audit_action (action_type),
  KEY idx_audit_target (target_type, target_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO subjects (name, is_active) VALUES
  ('Математика', 1),
  ('Фізика', 1),
  ('Інформатика', 1),
  ('Українська мова', 1),
  ('Література', 1)
ON DUPLICATE KEY UPDATE name = VALUES(name);

INSERT INTO student_groups (name, is_active) VALUES
  ('Група 101', 1),
  ('Група 201', 1),
  ('Група 301', 1),
  ('Група 401', 1)
ON DUPLICATE KEY UPDATE name = VALUES(name);
