require("dotenv").config({ override: true });
const express = require("express");
const path = require("path");
const crypto = require("crypto");
const Database = require("better-sqlite3");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;


/* =========================
   DATABASE
========================= */

const dbPath = process.env.NODE_ENV === "production"
    ? "/data/ppobku.db"
    : path.join(__dirname, "..", "database", "ppobku.db");

const db = new Database(dbPath);

db.pragma("journal_mode = WAL");

db.exec(`
    CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        transaction_id TEXT UNIQUE NOT NULL,
        reference TEXT NOT NULL,
        service TEXT NOT NULL,
        target TEXT NOT NULL,
        operator TEXT,
        product_id TEXT,
        product_name TEXT NOT NULL,
        price INTEGER NOT NULL,
        payment_method TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT "PENDING",
        created_at TEXT NOT NULL
    );
`);



    /* =========================
       CATALOG: SERVICES & PRODUCTS
    ========================= */

    db.exec(`
        CREATE TABLE IF NOT EXISTS services (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            icon TEXT NOT NULL DEFAULT "📦",
            description TEXT NOT NULL DEFAULT "",
            label TEXT NOT NULL DEFAULT "Nomor Tujuan",
            placeholder TEXT NOT NULL DEFAULT "",
            active INTEGER NOT NULL DEFAULT 1,
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS products (
            id TEXT PRIMARY KEY,
            service_id TEXT NOT NULL,
            operator TEXT,
            name TEXT NOT NULL,
            price INTEGER NOT NULL DEFAULT 0,
            info TEXT NOT NULL DEFAULT "",
            active INTEGER NOT NULL DEFAULT 1,
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            FOREIGN KEY (service_id)
                REFERENCES services(id)
                ON DELETE CASCADE
        );
    `);


/* =========================
   MIDDLEWARE
========================= */

app.use(express.json());

app.use(
    express.urlencoded({
        extended: true
    })
);


/* =========================
   FRONTEND
========================= */

app.use(
    express.static(
        path.join(__dirname, "..")
    )
);


/* =========================
   HEALTH CHECK
========================= */

app.get("/api/health", (req, res) => {

    res.json({
        success: true,
        message: "PPOBKU server aktif",
        database: "connected"
    });

});


/* =========================
   CREATE TRANSACTION
========================= */

app.post("/api/transactions", (req, res) => {

    try {

        const {
            service,
            target,
            operator,
            productId,
            productName,
            price,
            paymentMethod
        } = req.body;

        if (
            !service ||
            !target ||
            !productName ||
            !paymentMethod
        ) {

            return res.status(400).json({
                success: false,
                error: "Data transaksi belum lengkap."
            });

        }

        const numericPrice = Number(price);

        if (
            !Number.isFinite(numericPrice) ||
            numericPrice < 0
        ) {

            return res.status(400).json({
                success: false,
                error: "Harga transaksi tidak valid."
            });

        }

        const transactionId =
            "PPOB-" + Date.now();

        const reference =
            crypto
                .randomBytes(4)
                .toString("hex")
                .toUpperCase();

        const createdAt =
            new Date().toISOString();

        const insert = db.prepare(`
            INSERT INTO transactions (
                transaction_id,
                reference,
                service,
                target,
                operator,
                product_id,
                product_name,
                price,
                payment_method,
                status,
                created_at
            )
            VALUES (
                @transactionId,
                @reference,
                @service,
                @target,
                @operator,
                @productId,
                @productName,
                @price,
                @paymentMethod,
                'PENDING',
                @createdAt
            )
        `);

        insert.run({
            transactionId,
            reference,
            service,
            target,
            operator: operator || null,
            productId: productId || null,
            productName,
            price: numericPrice,
            paymentMethod,
            createdAt
        });

        const transaction = db.prepare(`
            SELECT
                id,
                transaction_id AS transactionId,
                reference,
                service,
                target,
                operator,
                product_id AS productId,
                product_name AS productName,
                price,
                payment_method AS paymentMethod,
                status,
                created_at AS createdAt
            FROM transactions
            WHERE transaction_id = ?
        `).get(transactionId);

        console.log("");
        console.log("==============================");
        console.log("TRANSAKSI TERSIMPAN");
        console.log(transaction);
        console.log("==============================");
        console.log("");

        return res.status(201).json({
            success: true,
            message: "Transaksi berhasil disimpan.",
            transaction
        });

    } catch (error) {

        console.error("Transaction error:", error);

        return res.status(500).json({
            success: false,
            error: "Gagal menyimpan transaksi."
        });

    }

});


/* =========================
   GET ALL TRANSACTIONS
========================= */

app.get("/api/transactions", (req, res) => {

    try {

        const month =
            /^\d{4}-\d{2}$/.test(req.query.month || "")
                ? req.query.month
                : new Date().toISOString().slice(0, 7);

        const transactions = db.prepare(`
            SELECT
                id,
                transaction_id AS transactionId,
                reference,
                service,
                target,
                operator,
                product_id AS productId,
                product_name AS productName,
                price,
                payment_method AS paymentMethod,
                status,
                created_at AS createdAt
            FROM transactions
            WHERE substr(created_at, 1, 7) = ?
            ORDER BY id DESC
        `).all(month);

        return res.json({
            success: true,
            month,
            count: transactions.length,
            transactions
        });

    } catch (error) {

        console.error(error);

        return res.status(500).json({
            success: false,
            error: "Gagal mengambil transaksi."
        });

    }

});


/* =========================
   RESET TRANSACTIONS BY MONTH
========================= */

app.delete("/api/transactions", (req, res) => {

    try {

        const month =
            /^\d{4}-\d{2}$/.test(req.body?.month || "")
                ? req.body.month
                : new Date().toISOString().slice(0, 7);

        const result = db.prepare(`
            DELETE FROM transactions
            WHERE substr(created_at, 1, 7) = ?
        `).run(month);

        return res.json({
            success: true,
            message: `Transaksi bulan ${month} berhasil direset.`,
            deleted: result.changes,
            month
        });

    } catch (error) {

        console.error(error);

        return res.status(500).json({
            success: false,
            error: "Gagal mereset transaksi."
        });

    }

});


/* =========================
   GET SINGLE TRANSACTION
========================= */

app.get("/api/transactions/:id", (req, res) => {

    try {

        const transaction = db.prepare(`
            SELECT
                id,
                transaction_id AS transactionId,
                reference,
                service,
                target,
                operator,
                product_id AS productId,
                product_name AS productName,
                price,
                payment_method AS paymentMethod,
                status,
                created_at AS createdAt
            FROM transactions
            WHERE transaction_id = ?
        `).get(req.params.id);

        if (!transaction) {

            return res.status(404).json({
                success: false,
                error: "Transaksi tidak ditemukan."
            });

        }

        return res.json({
            success: true,
            transaction
        });

    } catch (error) {

        console.error(error);

        return res.status(500).json({
            success: false,
            error: "Gagal mengambil transaksi."
        });

    }

});


/* =========================
   UPDATE TRANSACTION STATUS
========================= */

app.patch(
    "/api/transactions/:id/status",
    (req, res) => {

        try {

            const { status } = req.body;

            const allowedStatuses = [
                "PENDING",
                "SUCCESS",
                "FAILED"
            ];

            if (!allowedStatuses.includes(status)) {

                return res.status(400).json({
                    success: false,
                    error: "Status transaksi tidak valid."
                });

            }

            const result = db.prepare(`
                UPDATE transactions
                SET status = ?
                WHERE transaction_id = ?
            `).run(
                status,
                req.params.id
            );

            if (result.changes === 0) {

                return res.status(404).json({
                    success: false,
                    error: "Transaksi tidak ditemukan."
                });

            }

            const transaction = db.prepare(`
                SELECT
                    id,
                    transaction_id AS transactionId,
                    reference,
                    service,
                    target,
                    operator,
                    product_id AS productId,
                    product_name AS productName,
                    price,
                    payment_method AS paymentMethod,
                    status,
                    created_at AS createdAt
                FROM transactions
                WHERE transaction_id = ?
            `).get(req.params.id);

            return res.json({
                success: true,
                message: "Status transaksi diperbarui.",
                transaction
            });

        } catch (error) {

            console.error(error);

            return res.status(500).json({
                success: false,
                error: "Gagal memperbarui status."
            });

        }

    }
);


/* =========================
   XENDIT PAYMENT
========================= */

app.post("/api/payments/xendit", async (req, res) => {
    try {
        const {
            transactionId,
            customerEmail,
            customerName
        } = req.body;

        if (!transactionId) {
            return res.status(400).json({
                success: false,
                error: "transactionId wajib diisi."
            });
        }

        const transaction = db.prepare(`
            SELECT
                transaction_id AS transactionId,
                reference,
                product_name AS productName,
                price
            FROM transactions
            WHERE transaction_id = ?
        `).get(transactionId);

        if (!transaction) {
            return res.status(404).json({
                success: false,
                error: "Transaksi tidak ditemukan."
            });
        }

        if (!process.env.XENDIT_SECRET_KEY) {
            return res.status(500).json({
                success: false,
                error: "XENDIT_SECRET_KEY belum tersedia."
            });
        }

        const response = await axios.post(
            "https://api.xendit.co/sessions",
            {
                reference_id: transaction.reference,
                session_type: "PAY",
                mode: "PAYMENT_LINK",
                amount: transaction.price,
                currency: "IDR",
                country: "ID",
                locale: "id",
                customer: {
                    reference_id: "CUST" + transaction.reference,
                    type: "INDIVIDUAL",
                    email: customerEmail || "test@example.com",
                    individual_detail: {
                        given_names: customerName || "Pelanggan"
                    }
                }
            },
            {
                auth: {
                    username: process.env.XENDIT_SECRET_KEY,
                    password: ""
                },
                headers: {
                    "Content-Type": "application/json"
                }
            }
        );

        return res.json({
            success: true,
            paymentSessionId: response.data.payment_session_id,
            paymentUrl: response.data.payment_link_url
        });

    } catch (error) {
        console.error(
            "Xendit error:",
            error.response?.data || error.message
        );

        return res.status(500).json({
            success: false,
            error: "Gagal membuat pembayaran Xendit."
        });
    }
});


/* =========================
   CATALOG API
========================= */

function catalogNow() {
    return new Date().toISOString();
}


/* =========================
   GET CATALOG
========================= */

app.get("/api/catalog", (req, res) => {

    try {

        const services = db.prepare(`
            SELECT
                id,
                title,
                icon,
                description,
                label,
                placeholder,
                active,
                sort_order,
                created_at
            FROM services
            ORDER BY sort_order ASC, title ASC
        `).all();

        const products = db.prepare(`
            SELECT
                id,
                service_id,
                operator,
                name,
                price,
                info,
                active,
                sort_order,
                created_at
            FROM products
            ORDER BY sort_order ASC, name ASC
        `).all();

        return res.json({
            success: true,
            services,
            products
        });

    } catch (error) {

        console.error(error);

        return res.status(500).json({
            success: false,
            error: "Gagal mengambil katalog."
        });

    }

});


/* =========================
   CREATE SERVICE
========================= */

app.post("/api/services", (req, res) => {

    try {

        const {
            id,
            title,
            icon,
            description,
            label,
            placeholder,
            active,
            sort_order
        } = req.body;

        if (!id || !title) {

            return res.status(400).json({
                success: false,
                error: "ID dan nama layanan wajib diisi."
            });

        }

        const serviceId =
            String(id).trim().toLowerCase();

        const exists =
            db.prepare(`
                SELECT id
                FROM services
                WHERE id = ?
            `).get(serviceId);

        if (exists) {

            return res.status(409).json({
                success: false,
                error: "ID layanan sudah digunakan."
            });

        }

        db.prepare(`
            INSERT INTO services (
                id,
                title,
                icon,
                description,
                label,
                placeholder,
                active,
                sort_order,
                created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            serviceId,
            String(title).trim(),
            icon || "📦",
            description || "",
            label || "Nomor Tujuan",
            placeholder || "",
            active === false ? 0 : 1,
            Number.isFinite(Number(sort_order))
                ? Number(sort_order)
                : 0,
            catalogNow()
        );

        const service =
            db.prepare(`
                SELECT *
                FROM services
                WHERE id = ?
            `).get(serviceId);

        return res.status(201).json({
            success: true,
            service
        });

    } catch (error) {

        console.error(error);

        return res.status(500).json({
            success: false,
            error: "Gagal menambahkan layanan."
        });

    }

});


/* =========================
   UPDATE SERVICE
========================= */

app.put("/api/services/:id", (req, res) => {

    try {

        const serviceId =
            req.params.id;

        const existing =
            db.prepare(`
                SELECT *
                FROM services
                WHERE id = ?
            `).get(serviceId);

        if (!existing) {

            return res.status(404).json({
                success: false,
                error: "Layanan tidak ditemukan."
            });

        }

        const {
            title,
            icon,
            description,
            label,
            placeholder,
            active,
            sort_order
        } = req.body;

        db.prepare(`
            UPDATE services
            SET
                title = ?,
                icon = ?,
                description = ?,
                label = ?,
                placeholder = ?,
                active = ?,
                sort_order = ?
            WHERE id = ?
        `).run(
            title !== undefined
                ? String(title).trim()
                : existing.title,

            icon !== undefined
                ? icon
                : existing.icon,

            description !== undefined
                ? description
                : existing.description,

            label !== undefined
                ? label
                : existing.label,

            placeholder !== undefined
                ? placeholder
                : existing.placeholder,

            active === undefined
                ? existing.active
                : active ? 1 : 0,

            sort_order === undefined
                ? existing.sort_order
                : Number(sort_order),

            serviceId
        );

        const service =
            db.prepare(`
                SELECT *
                FROM services
                WHERE id = ?
            `).get(serviceId);

        return res.json({
            success: true,
            service
        });

    } catch (error) {

        console.error(error);

        return res.status(500).json({
            success: false,
            error: "Gagal mengubah layanan."
        });

    }

});


/* =========================
   DELETE SERVICE
========================= */

app.delete("/api/services/:id", (req, res) => {

    try {

        const serviceId =
            req.params.id;

        const result =
            db.prepare(`
                DELETE FROM services
                WHERE id = ?
            `).run(serviceId);

        if (result.changes === 0) {

            return res.status(404).json({
                success: false,
                error: "Layanan tidak ditemukan."
            });

        }

        db.prepare(`
            DELETE FROM products
            WHERE service_id = ?
        `).run(serviceId);

        return res.json({
            success: true,
            message: "Layanan berhasil dihapus."
        });

    } catch (error) {

        console.error(error);

        return res.status(500).json({
            success: false,
            error: "Gagal menghapus layanan."
        });

    }

});


/* =========================
   CREATE PRODUCT
========================= */

app.post("/api/products", (req, res) => {

    try {

        const {
            id,
            service_id,
            operator,
            name,
            price,
            info,
            active,
            sort_order
        } = req.body;

        if (!id || !service_id || !name) {

            return res.status(400).json({
                success: false,
                error: "ID, layanan, dan nama produk wajib diisi."
            });

        }

        const productId =
            String(id).trim().toLowerCase();

        const service =
            db.prepare(`
                SELECT id
                FROM services
                WHERE id = ?
            `).get(service_id);

        if (!service) {

            return res.status(400).json({
                success: false,
                error: "Layanan tidak ditemukan."
            });

        }

        const exists =
            db.prepare(`
                SELECT id
                FROM products
                WHERE id = ?
            `).get(productId);

        if (exists) {

            return res.status(409).json({
                success: false,
                error: "ID produk sudah digunakan."
            });

        }

        const numericPrice =
            Number(price);

        if (
            !Number.isFinite(numericPrice) ||
            numericPrice < 0
        ) {

            return res.status(400).json({
                success: false,
                error: "Harga produk tidak valid."
            });

        }

        db.prepare(`
            INSERT INTO products (
                id,
                service_id,
                operator,
                name,
                price,
                info,
                active,
                sort_order,
                created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            productId,
            service_id,
            operator || null,
            String(name).trim(),
            numericPrice,
            info || "",
            active === false ? 0 : 1,
            Number.isFinite(Number(sort_order))
                ? Number(sort_order)
                : 0,
            catalogNow()
        );

        const product =
            db.prepare(`
                SELECT *
                FROM products
                WHERE id = ?
            `).get(productId);

        return res.status(201).json({
            success: true,
            product
        });

    } catch (error) {

        console.error(error);

        return res.status(500).json({
            success: false,
            error: "Gagal menambahkan produk."
        });

    }

});


/* =========================
   UPDATE PRODUCT
========================= */

app.put("/api/products/:id", (req, res) => {

    try {

        const productId =
            req.params.id;

        const existing =
            db.prepare(`
                SELECT *
                FROM products
                WHERE id = ?
            `).get(productId);

        if (!existing) {

            return res.status(404).json({
                success: false,
                error: "Produk tidak ditemukan."
            });

        }

        const {
            service_id,
            operator,
            name,
            price,
            info,
            active,
            sort_order
        } = req.body;

        const targetService =
            service_id || existing.service_id;

        const service =
            db.prepare(`
                SELECT id
                FROM services
                WHERE id = ?
            `).get(targetService);

        if (!service) {

            return res.status(400).json({
                success: false,
                error: "Layanan tidak ditemukan."
            });

        }

        const targetPrice =
            price === undefined
                ? existing.price
                : Number(price);

        if (
            !Number.isFinite(targetPrice) ||
            targetPrice < 0
        ) {

            return res.status(400).json({
                success: false,
                error: "Harga produk tidak valid."
            });

        }

        db.prepare(`
            UPDATE products
            SET
                service_id = ?,
                operator = ?,
                name = ?,
                price = ?,
                info = ?,
                active = ?,
                sort_order = ?
            WHERE id = ?
        `).run(
            targetService,

            operator === undefined
                ? existing.operator
                : operator,

            name === undefined
                ? existing.name
                : String(name).trim(),

            targetPrice,

            info === undefined
                ? existing.info
                : info,

            active === undefined
                ? existing.active
                : active ? 1 : 0,

            sort_order === undefined
                ? existing.sort_order
                : Number(sort_order),

            productId
        );

        const product =
            db.prepare(`
                SELECT *
                FROM products
                WHERE id = ?
            `).get(productId);

        return res.json({
            success: true,
            product
        });

    } catch (error) {

        console.error(error);

        return res.status(500).json({
            success: false,
            error: "Gagal mengubah produk."
        });

    }

});


/* =========================
   DELETE PRODUCT
========================= */

app.delete("/api/products/:id", (req, res) => {

    try {

        const productId =
            req.params.id;

        const result =
            db.prepare(`
                DELETE FROM products
                WHERE id = ?
            `).run(productId);

        if (result.changes === 0) {

            return res.status(404).json({
                success: false,
                error: "Produk tidak ditemukan."
            });

        }

        return res.json({
            success: true,
            message: "Produk berhasil dihapus."
        });

    } catch (error) {

        console.error(error);

        return res.status(500).json({
            success: false,
            error: "Gagal menghapus produk."
        });

    }

});


/* =========================
   ADMIN LOGIN
========================= */

app.post(
    "/api/admin/login",
    (req, res) => {

        try {

            const {
                username,
                password
            } = req.body;

            const ADMIN_USERNAME = "admin";
            const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

            if (
                username !== ADMIN_USERNAME ||
                password !== ADMIN_PASSWORD
            ) {

                return res.status(401).json({
                    success: false,
                    error: "Username atau password salah."
                });

            }

            return res.json({
                success: true,
                message: "Login berhasil."
            });

        } catch (error) {

            console.error(error);

            return res.status(500).json({
                success: false,
                error: "Terjadi kesalahan pada server."
            });

        }

    }
);


/* =========================
   START SERVER
========================= */

app.listen(
    PORT,
    "0.0.0.0",
    () => {

        console.log(
            `PPOBKU berjalan di http://localhost:${PORT}`
        );

        console.log(
            "Database SQLite terhubung."
        );

    }
);
