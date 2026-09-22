CREATE TABLE IF NOT EXISTS ppob_pricing_tiers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  service_id TEXT NOT NULL,

  min_cost INTEGER NOT NULL DEFAULT 0,
  max_cost INTEGER,

  margin INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,

  sort_order INTEGER NOT NULL DEFAULT 0,

  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CHECK (min_cost >= 0),
  CHECK (max_cost IS NULL OR max_cost >= min_cost),
  CHECK (margin >= 0)
);

CREATE INDEX IF NOT EXISTS idx_ppob_pricing_tiers_lookup
ON ppob_pricing_tiers (
  provider,
  service_id,
  active,
  min_cost,
  max_cost
);

CREATE INDEX IF NOT EXISTS idx_ppob_pricing_tiers_service
ON ppob_pricing_tiers (
  provider,
  service_id
);
