-- Questions table (replaces data/questions.json)
CREATE TABLE math_questions (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL DEFAULT '解答',
  content TEXT NOT NULL,
  answer TEXT DEFAULT '',
  solution TEXT DEFAULT '',
  difficulty INTEGER DEFAULT 3,
  category TEXT NOT NULL DEFAULT '未分类',
  subcategory TEXT DEFAULT '',
  topic TEXT DEFAULT '',
  tags TEXT[] DEFAULT '{}',
  image TEXT,
  grade TEXT DEFAULT '',
  source TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_math_questions_category ON math_questions(category);
CREATE INDEX idx_math_questions_type ON math_questions(type);

ALTER TABLE math_questions ENABLE ROW LEVEL SECURITY;

-- All authenticated allowed users can read questions
CREATE POLICY "Allowed users can read questions"
  ON math_questions FOR SELECT
  USING (EXISTS (SELECT 1 FROM math_allowed_users WHERE user_id = auth.uid()));

-- Categories table (replaces data/categories.json)
CREATE TABLE math_categories (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  subcategories JSONB DEFAULT '[]',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE math_categories ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allowed users can read categories"
  ON math_categories FOR SELECT
  USING (EXISTS (SELECT 1 FROM math_allowed_users WHERE user_id = auth.uid()));

-- User baskets (replaces data/basket.json, isolated per user)
CREATE TABLE math_baskets (
  id SERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  question_id TEXT NOT NULL,
  added_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, question_id)
);

CREATE INDEX idx_math_baskets_user_id ON math_baskets(user_id);

ALTER TABLE math_baskets ENABLE ROW LEVEL SECURITY;

-- Users can only manage their own basket
CREATE POLICY "Users can read own basket"
  ON math_baskets FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert into own basket"
  ON math_baskets FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete from own basket"
  ON math_baskets FOR DELETE USING (auth.uid() = user_id);

-- Simple delete operation permission
CREATE POLICY "Users can remove from own basket"
  ON math_baskets FOR UPDATE USING (auth.uid() = user_id);

-- Allowed users (admin-managed whitelist)
CREATE TABLE math_allowed_users (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  added_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE math_allowed_users ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read allowed users"
  ON math_allowed_users FOR SELECT USING (true);

CREATE POLICY "Admins can insert allowed users"
  ON math_allowed_users FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM admins WHERE user_id = auth.uid()));

CREATE POLICY "Admins can delete allowed users"
  ON math_allowed_users FOR DELETE
  USING (EXISTS (SELECT 1 FROM admins WHERE user_id = auth.uid()));
