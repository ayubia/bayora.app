require("dotenv").config({ override: true });
const express = require("express");
const path = require("path");
const crypto = require("crypto");
const Database = require("better-sqlite3");

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
            ORDER BY id DESC
        `).all();

        return res.json({
            success: true,
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
