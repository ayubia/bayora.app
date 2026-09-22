CREATE TABLE IF NOT EXISTS ppob_pricing_settings (
  provider TEXT PRIMARY KEY,
  default_margin INTEGER,
  service_fee INTEGER NOT NULL DEFAULT 0,
  pricing_enabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO ppob_pricing_settings (
  provider,
  default_margin,
  service_fee,
  pricing_enabled
) VALUES (
  'DIGIFLAZZ',
  NULL,
  0,
  0
);

CREATE TABLE IF NOT EXISTS ppob_category_margins (
  provider TEXT NOT NULL,
  service_id TEXT NOT NULL,
  margin INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (provider, service_id)
);

CREATE TABLE IF NOT EXISTS ppob_product_margin_overrides (
  provider TEXT NOT NULL,
  product_id TEXT NOT NULL,
  margin INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (provider, product_id)
);

CREATE INDEX IF NOT EXISTS idx_ppob_category_margins_service
ON ppob_category_margins(service_id);

CREATE INDEX IF NOT EXISTS idx_ppob_product_margin_overrides_product
ON ppob_product_margin_overrides(product_id);
