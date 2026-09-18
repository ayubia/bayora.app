const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const dbPath = path.join(__dirname, "database", "ppobku.db");

console.log("============================================================");
console.log("PPOBKU — MIGRASI KATALOG DIGIFLAZZ");
console.log("============================================================");
console.log("Database:", dbPath);

if (!fs.existsSync(dbPath)) {
  throw new Error("Database tidak ditemukan: " + dbPath);
}

const timestamp = new Date()
  .toISOString()
  .replace(/[:.]/g, "-");

const backupPath = path.join(
  __dirname,
  "database",
  `ppobku-before-digiflazz-${timestamp}.db`
);

const db = new Database(dbPath);

try {
  // ==========================================================
  // 1. BACKUP
  // ==========================================================
  console.log("");
  console.log("[1/7] Membuat backup database...");

  db.backup(backupPath)
    .then(() => {
      console.log("Backup berhasil:");
      console.log(backupPath);

      migrate();
    })
    .catch(err => {
      console.error("BACKUP GAGAL:", err.message);
      db.close();
      process.exit(1);
    });

  function migrate() {

    // ========================================================
    // 2. BACA CACHE DIGIFLAZZ
    // ========================================================
    console.log("");
    console.log("[2/7] Membaca cache Digiflazz...");

    const dgRows = db.prepare(`
      SELECT *
      FROM digiflazz_price_list
      WHERE category IN ('Pulsa', 'Data', 'E-Money', 'PLN')
    `).all();

    const products = dgRows.filter(
      p => p.buyer_sku_code !== "danacek"
    );

    console.log("Produk relevan:", products.length);

    if (products.length !== 50) {
      throw new Error(
        `ABORT: cache Digiflazz berisi ${products.length} produk relevan, bukan 50.`
      );
    }

    // ========================================================
    // 3. SERVICE
    // ========================================================
    console.log("");
    console.log("[3/7] Validasi service...");

    const serviceMap = {
      "Pulsa": "pulsa",
      "Data": "data",
      "E-Money": "ewallet",
      "PLN": "pln-token"
    };

    const serviceRows = db.prepare(`
      SELECT id
      FROM services
    `).all();

    const serviceIds = new Set(
      serviceRows.map(x => x.id)
    );

    for (const p of products) {
      const sid = serviceMap[p.category];

      if (!sid) {
        throw new Error(
          `Kategori tidak dikenal: ${p.category}`
        );
      }

      if (!serviceIds.has(sid)) {
        throw new Error(
          `Service tidak ditemukan: ${sid}`
        );
      }
    }

    console.log("Semua service valid.");

    // ========================================================
    // 4. TAMBAH FIELD DINAMIS
    // ========================================================
    console.log("");
    console.log("[4/7] Menyiapkan kolom harga dinamis...");

    const columns = db.prepare(`
      PRAGMA table_info(products)
    `).all();

    const names = new Set(
      columns.map(x => x.name)
    );

    if (!names.has("cost_price")) {
      db.exec(`
        ALTER TABLE products
        ADD COLUMN cost_price INTEGER NOT NULL DEFAULT 0
      `);

      console.log("+ cost_price");
    } else {
      console.log("= cost_price sudah ada");
    }

    if (!names.has("margin")) {
      db.exec(`
        ALTER TABLE products
        ADD COLUMN margin INTEGER NOT NULL DEFAULT 0
      `);

      console.log("+ margin");
    } else {
      console.log("= margin sudah ada");
    }

    if (!names.has("digiflazz_sku")) {
      db.exec(`
        ALTER TABLE products
        ADD COLUMN digiflazz_sku TEXT
      `);

      console.log("+ digiflazz_sku");
    } else {
      console.log("= digiflazz_sku sudah ada");
    }

    // ========================================================
    // ATURAN HARGA
    // ========================================================
    function marginRule(cost) {
      if (cost <= 50000) return 2500;
      if (cost <= 100000) return 3000;
      return 3500;
    }

    function sellingPrice(cost) {
      const margin = marginRule(cost);

      return Math.ceil(
        (cost + margin) / 500
      ) * 500;
    }

    // ========================================================
    // 5. MIGRASI
    // ========================================================
    console.log("");
    console.log("[5/7] Memasukkan 50 produk Digiflazz...");

    const existingRows = db.prepare(`
      SELECT id
      FROM products
    `).all();

    const existingIds = new Set(
      existingRows.map(x => x.id)
    );

    const insert = db.prepare(`
      INSERT INTO products (
        id,
        service_id,
        operator,
        name,
        price,
        info,
        active,
        sort_order,
        created_at,
        cost_price,
        margin,
        digiflazz_sku
      )
      VALUES (
        @id,
        @service_id,
        @operator,
        @name,
        @price,
        @info,
        1,
        @sort_order,
        @created_at,
        @cost_price,
        @margin,
        @digiflazz_sku
      )
    `);

    const update = db.prepare(`
      UPDATE products
      SET
        service_id = @service_id,
        operator = @operator,
        name = @name,
        price = @price,
        info = @info,
        active = 1,
        sort_order = @sort_order,
        cost_price = @cost_price,
        margin = @margin,
        digiflazz_sku = @digiflazz_sku
      WHERE id = @id
    `);

    const deactivate = db.prepare(`
      UPDATE products
      SET active = 0
      WHERE id = ?
    `);

    const activeSkuSet = new Set(
      products.map(p => p.buyer_sku_code)
    );

    let inserted = 0;
    let updated = 0;
    let deactivated = 0;

    const transaction = db.transaction(() => {

      const counters = {};

      // --------------------------------------------
      // INSERT / UPDATE
      // --------------------------------------------
      for (const p of products) {

        const serviceId = serviceMap[p.category];

        counters[serviceId] =
          (counters[serviceId] || 0) + 1;

        const cost = Number(p.price);
        const margin = marginRule(cost);
        const price = sellingPrice(cost);

        const row = {
          id: p.buyer_sku_code,
          service_id: serviceId,
          operator: p.brand || "",
          name: p.product_name || p.buyer_sku_code,
          price,
          info: p.product_name || "",
          sort_order: counters[serviceId],
          created_at:
            p.created_at ||
            new Date().toISOString(),
          cost_price: cost,
          margin,
          digiflazz_sku: p.buyer_sku_code
        };

        if (existingIds.has(row.id)) {
          update.run(row);
          updated++;
        } else {
          insert.run(row);
          inserted++;
        }
      }

      // --------------------------------------------
      // NONAKTIFKAN PRODUK LAMA
      // --------------------------------------------
      const allProducts = db.prepare(`
        SELECT id
        FROM products
      `).all();

      for (const p of allProducts) {

        if (!activeSkuSet.has(p.id)) {
          deactivate.run(p.id);
          deactivated++;
        }
      }
    });

    transaction();

    console.log("Inserted   :", inserted);
    console.log("Updated    :", updated);
    console.log("Deactivated:", deactivated);

    // ========================================================
    // 6. VERIFIKASI
    // ========================================================
    console.log("");
    console.log("[6/7] Verifikasi database...");

    const total = db.prepare(`
      SELECT COUNT(*) AS n
      FROM products
    `).get().n;

    const active = db.prepare(`
      SELECT COUNT(*) AS n
      FROM products
      WHERE active = 1
    `).get().n;

    const inactive = db.prepare(`
      SELECT COUNT(*) AS n
      FROM products
      WHERE active = 0
    `).get().n;

    const skuCount = db.prepare(`
      SELECT COUNT(*) AS n
      FROM products
      WHERE active = 1
      AND digiflazz_sku IS NOT NULL
      AND digiflazz_sku != ''
    `).get().n;

    const missingCost = db.prepare(`
      SELECT COUNT(*) AS n
      FROM products
      WHERE active = 1
      AND (cost_price IS NULL OR cost_price <= 0)
    `).get().n;

    console.log("");
    console.log("============================================================");
    console.log("HASIL");
    console.log("============================================================");
    console.log("Total products :", total);
    console.log("ACTIVE         :", active);
    console.log("INACTIVE       :", inactive);
    console.log("SKU Digiflazz  :", skuCount);
    console.log("Tanpa modal    :", missingCost);
    console.log("============================================================");

    if (active !== 50) {
      throw new Error(
        `Verifikasi gagal: ACTIVE=${active}, seharusnya 50`
      );
    }

    if (skuCount !== 50) {
      throw new Error(
        `Verifikasi gagal: SKU=${skuCount}, seharusnya 50`
      );
    }

    if (missingCost !== 0) {
      throw new Error(
        `Verifikasi gagal: ${missingCost} produk tidak punya modal`
      );
    }

    // ========================================================
    // 7. SAMPLE
    // ========================================================
    console.log("");
    console.log("[7/7] Contoh produk hasil migrasi:");
    console.log("");

    const sample = db.prepare(`
      SELECT
        id,
        operator,
        cost_price,
        price,
        margin,
        digiflazz_sku
      FROM products
      WHERE active = 1
      ORDER BY service_id, sort_order
      LIMIT 10
    `).all();

    for (const p of sample) {
      console.log(
        `${p.id.padEnd(14)} | ` +
        `${p.operator.padEnd(14)} | ` +
        `Modal Rp${Number(p.cost_price).toLocaleString("id-ID").padStart(9)} | ` +
        `Jual Rp${Number(p.price).toLocaleString("id-ID").padStart(9)} | ` +
        `Margin Rp${Number(p.margin).toLocaleString("id-ID")}`
      );
    }

    console.log("");
    console.log("============================================================");
    console.log("MIGRASI BERHASIL");
    console.log("============================================================");
    console.log("50 produk Digiflazz aktif.");
    console.log("Produk lama yang tidak tersedia dinonaktifkan.");
    console.log("Harga modal tersimpan.");
    console.log("Margin tersimpan.");
    console.log("SKU Digiflazz tersimpan.");
    console.log("Harga jual tersimpan.");
    console.log("");
    console.log("BACKUP DATABASE:");
    console.log(backupPath);
    console.log("============================================================");

    db.close();
  }

} catch (err) {

  console.error("");
  console.error("============================================================");
  console.error("MIGRASI GAGAL");
  console.error("============================================================");
  console.error(err.message);
  console.error("============================================================");

  db.close();
  process.exit(1);
}
