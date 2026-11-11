CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  hash TEXT NOT NULL,
  password_copy TEXT,
  must_change INTEGER NOT NULL DEFAULT 1,
  totp TEXT,
  totp_step INTEGER NOT NULL DEFAULT -1,
  setup_until INTEGER
) STRICT;

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  csrf TEXT NOT NULL,
  pending_totp TEXT,
  last_seen INTEGER NOT NULL,
  expires INTEGER NOT NULL
) STRICT;
CREATE INDEX sessions_account ON sessions(account_id);

CREATE TABLE audit (
  id INTEGER PRIMARY KEY,
  time INTEGER NOT NULL,
  actor TEXT,
  target TEXT,
  action TEXT NOT NULL,
  outcome TEXT NOT NULL
) STRICT;
