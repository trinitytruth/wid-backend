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
