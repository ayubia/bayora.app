const path = require("path");
const Database = require("better-sqlite3");

const dbPath = path.join(
    __dirname,
    "..",
    "..",
    "database",
    "ppobku.db"
);

console.log("[SMM MIGRATION]");
console.log("[DATABASE]", dbPath);

const db = new Database(dbPath);

try {

    db.pragma("foreign_keys = ON");

    db.exec(`
        CREATE TABLE IF NOT EXISTS smm_providers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            api_url TEXT NOT NULL,
            api_key TEXT,
            active INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS smm_services (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            provider_id INTEGER,
            provider_service_id TEXT,
            platform TEXT NOT NULL,
            category TEXT NOT NULL,
            name TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            price INTEGER NOT NULL DEFAULT 0,
            min_quantity INTEGER NOT NULL DEFAULT 1,
            max_quantity INTEGER NOT NULL DEFAULT 1,
            refill INTEGER NOT NULL DEFAULT 0,
            cancel INTEGER NOT NULL DEFAULT 0,
            active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            updated_at TEXT,
            FOREIGN KEY (provider_id)
                REFERENCES smm_providers(id)
                ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS
            idx_smm_services_provider
            ON smm_services(provider_id);

        CREATE INDEX IF NOT EXISTS
            idx_smm_services_platform
            ON smm_services(platform);

        CREATE INDEX IF NOT EXISTS
            idx_smm_services_active
            ON smm_services(active);

        CREATE TABLE IF NOT EXISTS smm_orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_id TEXT UNIQUE NOT NULL,
            user_id INTEGER,
            service_id INTEGER NOT NULL,
            target TEXT NOT NULL,
            quantity INTEGER NOT NULL,
            price INTEGER NOT NULL DEFAULT 0,
            provider_order_id TEXT,
            status TEXT NOT NULL DEFAULT 'PENDING',
            start_count INTEGER,
            remains INTEGER,
            created_at TEXT NOT NULL,
            updated_at TEXT,
            FOREIGN KEY (user_id)
                REFERENCES users(id)
                ON DELETE SET NULL,
            FOREIGN KEY (service_id)
                REFERENCES smm_services(id)
                ON DELETE RESTRICT
        );

        CREATE INDEX IF NOT EXISTS
            idx_smm_orders_user
            ON smm_orders(user_id);

        CREATE INDEX IF NOT EXISTS
            idx_smm_orders_service
            ON smm_orders(service_id);

        CREATE INDEX IF NOT EXISTS
            idx_smm_orders_status
            ON smm_orders(status);

        CREATE INDEX IF NOT EXISTS
            idx_smm_orders_provider_order
            ON smm_orders(provider_order_id);
    `);

    console.log("[SMM] Tabel berhasil dibuat/diverifikasi.");

    const tables = db.prepare(`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
          AND name IN (
              'smm_providers',
              'smm_services',
              'smm_orders'
          )
        ORDER BY name
    `).all();

    console.log("[SMM] Tabel:");
    for (const table of tables) {
        console.log(" -", table.name);
    }

} catch (error) {

    console.error("[SMM MIGRATION ERROR]", error);
    process.exitCode = 1;

} finally {

    db.close();

}
