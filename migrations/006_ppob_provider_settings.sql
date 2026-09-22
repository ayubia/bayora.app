CREATE TABLE IF NOT EXISTS ppob_provider_settings (
  provider TEXT PRIMARY KEY,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO ppob_provider_settings (
  provider,
  active
) VALUES (
  'DIGIFLAZZ',
  1
);
