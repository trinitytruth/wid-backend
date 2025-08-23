CREATE TABLE IF NOT EXISTS profiles (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL DEFAULT 'Me',
  birth_year INT
);

CREATE TABLE IF NOT EXISTS consent (
  profile_id BIGINT PRIMARY KEY REFERENCES profiles(id),
  data_storage BOOLEAN DEFAULT TRUE,
  ai_disclosure BOOLEAN DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS approvers (
  id BIGSERIAL PRIMARY KEY,
  profile_id BIGINT REFERENCES profiles(id),
  email TEXT NOT NULL,
  status TEXT DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS answers (
  id BIGSERIAL PRIMARY KEY,
  profile_id BIGINT REFERENCES profiles(id),
  question TEXT NOT NULL,
  answer_text TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS media (
  id BIGSERIAL PRIMARY KEY,
  profile_id BIGINT REFERENCES profiles(id),
  answer_id BIGINT REFERENCES answers(id),
  type TEXT,
  url TEXT,
  duration_sec INT
);

CREATE TABLE IF NOT EXISTS answer_embeddings (
  answer_id   INTEGER PRIMARY KEY REFERENCES answers(id) ON DELETE CASCADE,
  content     TEXT NOT NULL,
  embedding   JSONB NOT NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMP NOT NULL DEFAULT NOW()
);

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS pin TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS profiles_name_key ON profiles (name);

-- Track updates on answers (for editing)
ALTER TABLE answers
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

-- Helpful indexes
CREATE INDEX IF NOT EXISTS answers_profile_id_idx ON answers (profile_id);
CREATE INDEX IF NOT EXISTS answers_created_at_idx ON answers (created_at);

-- Ensure your unique name index doesn't have a stray backslash
-- (If it already exists, this is fine.)
CREATE UNIQUE INDEX IF NOT EXISTS profiles_name_key ON profiles (name);

CREATE INDEX IF NOT EXISTS idx_answers_profile_id ON answers(profile_id);

