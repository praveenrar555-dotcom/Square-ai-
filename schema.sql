CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  username      TEXT,
  password_hash TEXT NOT NULL,
  plan          TEXT NOT NULL DEFAULT 'free',
  settings      JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS conversations (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id         TEXT NOT NULL,
  title      TEXT NOT NULL,
  starred    BOOLEAN NOT NULL DEFAULT false,
  archived   BOOLEAN NOT NULL DEFAULT false,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS conversations_user_updated ON conversations (user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  user_id         TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  id              TEXT NOT NULL,
  position        INT  NOT NULL,
  role            TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  raw             TEXT NOT NULL,
  attachments     JSONB NOT NULL DEFAULT '[]',
  created_at      BIGINT NOT NULL,
  PRIMARY KEY (user_id, conversation_id, id),
  FOREIGN KEY (user_id, conversation_id) REFERENCES conversations (user_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS messages_conv_pos ON messages (user_id, conversation_id, position);

CREATE TABLE IF NOT EXISTS projects (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id         TEXT NOT NULL,
  data       JSONB NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, id)
);

CREATE TABLE IF NOT EXISTS usage_log (
  id         BIGSERIAL PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  model      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS usage_user_time ON usage_log (user_id, created_at);

CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL
);
