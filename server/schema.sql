CREATE TABLE IF NOT EXISTS license_users (
  id SERIAL PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  license_key_hash TEXT NOT NULL UNIQUE,
  license_key_last4 TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  duration_hours INTEGER NOT NULL DEFAULT 24 CHECK (duration_hours > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  activated_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ,
  activation_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS license_users_status_idx
  ON license_users (status);

CREATE INDEX IF NOT EXISTS license_users_expires_at_idx
  ON license_users (expires_at);