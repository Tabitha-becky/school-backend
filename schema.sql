-- ═══════════════════════════════════════════════════════════════
--  EduTrack Kenya — Database Schema
--  Run this once to set up all tables
--  Command: psql -U postgres -d edutrack -f schema.sql
-- ═══════════════════════════════════════════════════════════════

-- Create database (run separately if needed)
-- CREATE DATABASE edutrack;

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ──────────────────────────────────────────────────────────────
--  SCHOOL USERS (Admins, Teachers, Principals)
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name        VARCHAR(120) NOT NULL,
  email       VARCHAR(120) UNIQUE NOT NULL,
  password    VARCHAR(255) NOT NULL,           -- bcrypt hash
  role        VARCHAR(20) NOT NULL DEFAULT 'teacher'
                CHECK (role IN ('admin', 'principal', 'teacher', 'bursar')),
  phone       VARCHAR(20),
  is_active   BOOLEAN DEFAULT TRUE,
  created_at  TIMESTAMP DEFAULT NOW(),
  updated_at  TIMESTAMP DEFAULT NOW()
);

-- ──────────────────────────────────────────────────────────────
--  CLASSES
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS classes (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name        VARCHAR(50) UNIQUE NOT NULL,     -- e.g. "Form 2A"
  level       VARCHAR(10) NOT NULL,            -- e.g. "Form 2"
  stream      VARCHAR(5),                      -- e.g. "A"
  class_teacher_id UUID REFERENCES users(id) ON DELETE SET NULL,
  capacity    INTEGER DEFAULT 40,
  created_at  TIMESTAMP DEFAULT NOW()
);

-- ──────────────────────────────────────────────────────────────
--  STUDENTS
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS students (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  adm_no          VARCHAR(30) UNIQUE NOT NULL,
  name            VARCHAR(120) NOT NULL,
  class_id        UUID REFERENCES classes(id) ON DELETE SET NULL,
  gender          VARCHAR(10) CHECK (gender IN ('Male', 'Female', 'Other')),
  date_of_birth   DATE,
  photo_url       VARCHAR(255),

  -- Parent / Guardian
  parent_name     VARCHAR(120),
  parent_phone    VARCHAR(20) NOT NULL,
  parent_email    VARCHAR(120),
  parent_phone2   VARCHAR(20),                 -- second contact

  -- Address
  address         TEXT,
  county          VARCHAR(50),

  -- System
  is_active       BOOLEAN DEFAULT TRUE,
  year_joined     INTEGER DEFAULT EXTRACT(YEAR FROM NOW()),
  created_at      TIMESTAMP DEFAULT NOW(),
  updated_at      TIMESTAMP DEFAULT NOW()
);

-- ──────────────────────────────────────────────────────────────
--  STUDENT HEALTH RECORDS  ← Your unique selling point 🏥
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS health_records (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  student_id          UUID UNIQUE NOT NULL REFERENCES students(id) ON DELETE CASCADE,

  blood_group         VARCHAR(5) CHECK (blood_group IN ('A+','A-','B+','B-','AB+','AB-','O+','O-','Unknown')),
  height_cm           DECIMAL(5,1),
  weight_kg           DECIMAL(5,1),

  -- Allergies (stored as text; you can make these arrays later)
  allergies           TEXT DEFAULT 'None',     -- e.g. "Peanuts, Dust, Bee stings"
  allergy_severity    VARCHAR(10) DEFAULT 'Low' CHECK (allergy_severity IN ('Low','Medium','High','Critical')),

  -- Chronic conditions
  chronic_conditions  TEXT DEFAULT 'None',     -- e.g. "Asthma, Diabetes"
  disabilities        TEXT DEFAULT 'None',

  -- Medication
  current_medication  TEXT DEFAULT 'None',     -- e.g. "Salbutamol inhaler – carry always"
  medication_notes    TEXT,                    -- dosage, timing, instructions for staff

  -- Emergency
  emergency_contact_name  VARCHAR(120),
  emergency_contact_phone VARCHAR(20),
  emergency_contact_rel   VARCHAR(50),         -- e.g. "Aunt", "Uncle"

  -- Insurance
  nhif_no             VARCHAR(30),
  private_insurance   VARCHAR(80),

  -- Last check
  last_checkup_date   DATE,
  notes               TEXT,                    -- general staff notes

  created_at          TIMESTAMP DEFAULT NOW(),
  updated_at          TIMESTAMP DEFAULT NOW()
);

-- ──────────────────────────────────────────────────────────────
--  SUBJECTS
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS subjects (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name        VARCHAR(80) UNIQUE NOT NULL,     -- e.g. "Mathematics"
  code        VARCHAR(10) UNIQUE,              -- e.g. "MAT101"
  is_compulsory BOOLEAN DEFAULT TRUE,
  created_at  TIMESTAMP DEFAULT NOW()
);

-- ──────────────────────────────────────────────────────────────
--  TEACHER → SUBJECT → CLASS assignments
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS teacher_subjects (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  teacher_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject_id  UUID NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  class_id    UUID NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  academic_year VARCHAR(10) DEFAULT '2024',
  UNIQUE (teacher_id, subject_id, class_id, academic_year)
);

-- ──────────────────────────────────────────────────────────────
--  ACADEMIC RECORDS (marks per student per subject per term)
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS academic_records (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  student_id  UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  subject_id  UUID NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  class_id    UUID NOT NULL REFERENCES classes(id),
  term        VARCHAR(20) NOT NULL,            -- e.g. "Term 1 2024"
  academic_year VARCHAR(10) DEFAULT '2024',

  -- Marks (out of 100 each)
  cat1        DECIMAL(5,1) CHECK (cat1 BETWEEN 0 AND 100),
  cat2        DECIMAL(5,1) CHECK (cat2 BETWEEN 0 AND 100),
  exam        DECIMAL(5,1) CHECK (exam BETWEEN 0 AND 100),
  average     DECIMAL(5,2) GENERATED ALWAYS AS (
                ROUND((COALESCE(cat1,0) + COALESCE(cat2,0) + COALESCE(exam,0)) / 3, 2)
              ) STORED,

  -- KCSE Grade (computed by app)
  grade       VARCHAR(3),                      -- A, A-, B+, ... E
  points      INTEGER,                         -- 12, 11, 10 ...

  entered_by  UUID REFERENCES users(id),
  created_at  TIMESTAMP DEFAULT NOW(),
  updated_at  TIMESTAMP DEFAULT NOW(),

  UNIQUE (student_id, subject_id, term, academic_year)
);

-- ──────────────────────────────────────────────────────────────
--  FEE STRUCTURE (what each class is supposed to pay)
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fee_structures (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  class_id      UUID NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  term          VARCHAR(20) NOT NULL,
  academic_year VARCHAR(10) DEFAULT '2024',
  tuition_fee   DECIMAL(10,2) NOT NULL,
  activity_fee  DECIMAL(10,2) DEFAULT 0,
  boarding_fee  DECIMAL(10,2) DEFAULT 0,
  other_fee     DECIMAL(10,2) DEFAULT 0,
  total_amount  DECIMAL(10,2) GENERATED ALWAYS AS (
                  tuition_fee + activity_fee + boarding_fee + other_fee
                ) STORED,
  UNIQUE (class_id, term, academic_year)
);

-- ──────────────────────────────────────────────────────────────
--  FEE PAYMENTS
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fee_payments (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  student_id      UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  term            VARCHAR(20) NOT NULL,
  academic_year   VARCHAR(10) DEFAULT '2024',

  amount_expected DECIMAL(10,2),              -- from fee structure
  amount_paid     DECIMAL(10,2) NOT NULL,
  payment_method  VARCHAR(20) NOT NULL
                    CHECK (payment_method IN ('M-Pesa','Cash','Bank','Cheque','Online')),
  reference_no    VARCHAR(60),               -- M-Pesa code, bank ref, receipt no.
  payment_date    DATE NOT NULL DEFAULT CURRENT_DATE,

  -- Running balance (app computes this)
  balance_before  DECIMAL(10,2) DEFAULT 0,
  balance_after   DECIMAL(10,2) DEFAULT 0,

  notes           TEXT,
  received_by     UUID REFERENCES users(id),  -- bursar who recorded it
  receipt_no      VARCHAR(30) UNIQUE,          -- auto-generated receipt number

  created_at      TIMESTAMP DEFAULT NOW()
);

-- ──────────────────────────────────────────────────────────────
--  ATTENDANCE
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS attendance (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  student_id  UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  class_id    UUID NOT NULL REFERENCES classes(id),
  date        DATE NOT NULL DEFAULT CURRENT_DATE,
  status      VARCHAR(10) NOT NULL DEFAULT 'present'
                CHECK (status IN ('present','absent','late','excused')),
  reason      TEXT,                           -- for absent/late/excused
  marked_by   UUID REFERENCES users(id),
  created_at  TIMESTAMP DEFAULT NOW(),
  UNIQUE (student_id, date)
);

-- ──────────────────────────────────────────────────────────────
--  SMS LOG (for Africa's Talking integration later)
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sms_logs (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  recipient   VARCHAR(20) NOT NULL,
  message     TEXT NOT NULL,
  type        VARCHAR(30),                    -- 'fee_reminder', 'exam_result', 'announcement'
  status      VARCHAR(20) DEFAULT 'pending'
                CHECK (status IN ('pending','sent','failed')),
  student_id  UUID REFERENCES students(id),
  sent_at     TIMESTAMP,
  created_at  TIMESTAMP DEFAULT NOW()
);

-- ──────────────────────────────────────────────────────────────
--  INDEXES (for fast queries)
-- ──────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_students_class       ON students(class_id);
CREATE INDEX IF NOT EXISTS idx_students_adm_no      ON students(adm_no);
CREATE INDEX IF NOT EXISTS idx_fee_payments_student  ON fee_payments(student_id);
CREATE INDEX IF NOT EXISTS idx_fee_payments_term     ON fee_payments(term, academic_year);
CREATE INDEX IF NOT EXISTS idx_academic_student      ON academic_records(student_id, term);
CREATE INDEX IF NOT EXISTS idx_attendance_date       ON attendance(date, class_id);

-- ──────────────────────────────────────────────────────────────
--  SEED DATA — Default admin account + subjects
-- ──────────────────────────────────────────────────────────────

-- Default subjects (Kenya curriculum)
INSERT INTO subjects (name, code, is_compulsory) VALUES
  ('Mathematics',         'MAT', TRUE),
  ('English',             'ENG', TRUE),
  ('Kiswahili',           'KSW', TRUE),
  ('Biology',             'BIO', FALSE),
  ('Chemistry',           'CHE', FALSE),
  ('Physics',             'PHY', FALSE),
  ('History & Government','HIS', FALSE),
  ('Geography',           'GEO', FALSE),
  ('C.R.E',               'CRE', FALSE),
  ('Business Studies',    'BST', FALSE),
  ('Agriculture',         'AGR', FALSE),
  ('Computer Studies',    'CST', FALSE)
ON CONFLICT (name) DO NOTHING;

-- Default classes
INSERT INTO classes (name, level, stream) VALUES
  ('Form 1A', 'Form 1', 'A'), ('Form 1B', 'Form 1', 'B'),
  ('Form 2A', 'Form 2', 'A'), ('Form 2B', 'Form 2', 'B'),
  ('Form 3A', 'Form 3', 'A'), ('Form 3B', 'Form 3', 'B'),
  ('Form 4A', 'Form 4', 'A'), ('Form 4B', 'Form 4', 'B')
ON CONFLICT (name) DO NOTHING;

-- NOTE: The default admin account is created by running: npm run setup-db
-- Default credentials:  admin@school.ac.ke / Admin@1234  (change immediately!)