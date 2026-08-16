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
        payment_status TEXT NOT NULL DEFAULT "PENDING",
        digiflazz_status TEXT NOT NULL DEFAULT "PENDING",
        digiflazz_ref TEXT,
        digiflazz_message TEXT,
        paid_at TEXT,
        processed_at TEXT,
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
   DATABASE MIGRATION
========================= */

// Tambahkan kolom cost_price ke database lama
// tanpa menghapus atau mengubah data yang sudah ada.
const productColumns = db
    .prepare("PRAGMA table_info(products)")
    .all();

const hasCostPrice = productColumns.some(
    column => column.name === "cost_price"
);

if (!hasCostPrice) {
    db.prepare(
        "ALTER TABLE products ADD COLUMN cost_price INTEGER NOT NULL DEFAULT 0"
    ).run();

    console.log(
        "[DB MIGRATION] Kolom products.cost_price berhasil ditambahkan."
    );
}

// Tambahkan kolom margin ke database lama
// tanpa menghapus atau mengubah data yang sudah ada.
const hasMargin = productColumns.some(
    column => column.name === "margin"
);

if (!hasMargin) {
    db.prepare(
        "ALTER TABLE products ADD COLUMN margin INTEGER NOT NULL DEFAULT 0"
    ).run();

    console.log(
        "[DB MIGRATION] Kolom products.margin berhasil ditambahkan."
    );
}

// Tambahkan kolom digiflazz_sku ke database lama
// tanpa menghapus atau mengubah data yang sudah ada.
const hasDigiflazzSku = productColumns.some(
    column => column.name === "digiflazz_sku"
);

if (!hasDigiflazzSku) {
    db.prepare(
        "ALTER TABLE products ADD COLUMN digiflazz_sku TEXT"
    ).run();

    console.log(
        "[DB MIGRATION] Kolom products.digiflazz_sku berhasil ditambahkan."
    );
}

/* =========================
   PAYMENT / DIGIFLAZZ MIGRATION
========================= */

const transactionColumns =
    db.prepare("PRAGMA table_info(transactions)").all();

const transactionColumnNames =
    transactionColumns.map(column => column.name);

const transactionMigrations = [
    ["payment_status", 'TEXT NOT NULL DEFAULT "PENDING"'],
    ["digiflazz_status", 'TEXT NOT NULL DEFAULT "PENDING"'],
    ["digiflazz_ref", "TEXT"],
    ["digiflazz_message", "TEXT"],
    ["paid_at", "TEXT"],
    ["processed_at", "TEXT"]
];

for (const [columnName, columnDefinition] of transactionMigrations) {

    if (!transactionColumnNames.includes(columnName)) {

        db.prepare(
            `ALTER TABLE transactions ADD COLUMN ${columnName} ${columnDefinition}`
        ).run();

        console.log(
            `[DB MIGRATION] Kolom transactions.${columnName} berhasil ditambahkan.`
        );
    }
}


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



/* ============================================================
   XENDIT → DIGIFLAZZ AUTOMATION
   Pembayaran Xendit berhasil → kirim transaksi ke Digiflazz.
   ============================================================ */

function digiflazzSign(refId) {
    const username = process.env.DIGIFLAZZ_USERNAME;
    const apiKey = process.env.DIGIFLAZZ_API_KEY;

    if (!username || !apiKey) {
        throw new Error("Credential Digiflazz belum dikonfigurasi.");
    }

    return crypto
        .createHash("md5")
        .update(username + apiKey + refId)
        .digest("hex");
}


async function sendTransactionToDigiflazz(transactionId) {

    const transaction = db.prepare(`
        SELECT
            t.id,
            t.transaction_id,
            t.reference,
            t.target,
            t.product_id,
            t.product_name,
            t.price,
            t.payment_status,
            t.digiflazz_status,
            t.digiflazz_ref,
            p.digiflazz_sku,
            p.cost_price
        FROM transactions t
        LEFT JOIN products p
            ON p.id = t.product_id
        WHERE t.transaction_id = ?
    `).get(transactionId);

    if (!transaction) {
        throw new Error("Transaksi tidak ditemukan.");
    }

    if (transaction.payment_status !== "PAID") {
        throw new Error("Pembayaran belum berstatus PAID.");
    }

    /*
     * Anti-double-order:
     * hanya transaksi dengan status PENDING yang boleh di-claim.
     *
     * Setelah berhasil di-claim menjadi PROCESSING,
     * webhook kedua tidak akan mengirim order kedua.
     */
    const claim = db.prepare(`
        UPDATE transactions
        SET
            digiflazz_status = 'PROCESSING',
            processed_at = ?
        WHERE transaction_id = ?
          AND payment_status = 'PAID'
          AND digiflazz_status = 'PENDING'
    `).run(
        new Date().toISOString(),
        transactionId
    );

    if (claim.changes === 0) {

        const current = db.prepare(`
            SELECT
                transaction_id,
                payment_status,
                digiflazz_status,
                digiflazz_ref,
                digiflazz_message
            FROM transactions
            WHERE transaction_id = ?
        `).get(transactionId);

        return {
            skipped: true,
            reason: "TRANSAKSI_SUDAH_DIPROSES_ATAU_SEDANG_DIPROSES",
            transaction: current
        };
    }

    const username = process.env.DIGIFLAZZ_USERNAME;
    const apiKey = process.env.DIGIFLAZZ_API_KEY;

    if (!username || !apiKey) {
        db.prepare(`
            UPDATE transactions
            SET
                digiflazz_status = 'FAILED',
                digiflazz_message = ?,
                processed_at = ?
            WHERE transaction_id = ?
        `).run(
            "Credential Digiflazz belum dikonfigurasi.",
            new Date().toISOString(),
            transactionId
        );

        throw new Error("Credential Digiflazz belum dikonfigurasi.");
    }

    if (!transaction.digiflazz_sku) {

        db.prepare(`
            UPDATE transactions
            SET
                digiflazz_status = 'FAILED',
                digiflazz_message = ?,
                processed_at = ?
            WHERE transaction_id = ?
        `).run(
            "Produk tidak memiliki digiflazz_sku.",
            new Date().toISOString(),
            transactionId
        );

        throw new Error(
            "Produk tidak memiliki digiflazz_sku."
        );
    }

    /*
     * ref_id harus stabil dan unik.
     * Kita gunakan reference transaksi PPOBKU.
     * Jika request perlu diulang karena Pending,
     * ref_id yang sama dipakai lagi.
     */
    const refId = "PPOBKU-" + transaction.reference;

    const sign = digiflazzSign(refId);

    const payload = {
        username,
        buyer_sku_code: transaction.digiflazz_sku,
        customer_no: String(transaction.target),
        ref_id: refId,
        sign
    };

    /*
     * cb_url opsional.
     * Jika PUBLIC_BASE_URL tersedia, Digiflazz bisa
     * mengirim callback ketika transaksi Pending berubah.
     */
    if (process.env.PUBLIC_BASE_URL) {
        payload.cb_url =
            process.env.PUBLIC_BASE_URL.replace(/\/$/, "") +
            "/api/webhooks/digiflazz";
    }

    let response;

    try {

        response = await axios.post(
            "https://api.digiflazz.com/v1/transaction",
            payload,
            {
                headers: {
                    "Content-Type": "application/json"
                },
                timeout: 30000
            }
        );

    } catch (error) {

        const errorData =
            error.response?.data || {};

        const errorMessage =
            errorData?.data?.message ||
            errorData?.message ||
            error.message ||
            "Request ke Digiflazz gagal.";

        /*
         * Tetap simpan PROCESSING jika request tidak mendapat
         * jawaban yang dapat dipercaya.
         *
         * Jangan langsung mengirim ulang dengan ref_id baru.
         * ref_id yang sama harus digunakan untuk pengecekan.
         */
        db.prepare(`
            UPDATE transactions
            SET
                digiflazz_message = ?,
                processed_at = ?
            WHERE transaction_id = ?
        `).run(
            String(errorMessage),
            new Date().toISOString(),
            transactionId
        );

        throw error;
    }

    const result =
        response.data?.data || {};

    const status =
        String(result.status || "").toLowerCase();

    const message =
        result.message ||
        "Tidak ada pesan dari Digiflazz.";

    const digiflazzRef =
        result.ref_id ||
        refId;

    let finalStatus = "PROCESSING";

    if (status === "sukses") {
        finalStatus = "SUCCESS";
    } else if (status === "gagal") {
        finalStatus = "FAILED";
    } else if (status === "pending") {
        finalStatus = "PENDING";
    }

    db.prepare(`
        UPDATE transactions
        SET
            digiflazz_status = ?,
            digiflazz_ref = ?,
            digiflazz_message = ?,
            processed_at = ?
        WHERE transaction_id = ?
    `).run(
        finalStatus,
        String(digiflazzRef),
        String(message),
        new Date().toISOString(),
        transactionId
    );

    return {
        skipped: false,
        status: finalStatus,
        ref_id: digiflazzRef,
        message
    };
}


/* =========================
   XENDIT PAYMENT SESSION WEBHOOK
========================= */

app.post("/api/webhooks/xendit", async (req, res) => {

    try {

        const event =
            req.body?.event;

        const data =
            req.body?.data || {};

        console.log(
            "[XENDIT WEBHOOK]",
            JSON.stringify(req.body, null, 2)
        );

        /*
         * Kita hanya memproses Payment Session yang selesai.
         */
        if (event === "payment_session.completed") {

            if (String(data.status).toUpperCase() !== "COMPLETED") {

                return res.json({
                    success: true,
                    ignored: true,
                    message:
                        "Payment Session belum COMPLETED."
                });
            }

            const reference =
                data.reference_id;

            if (!reference) {

                return res.status(400).json({
                    success: false,
                    error:
                        "reference_id tidak ditemukan."
                });
            }

            const transaction =
                db.prepare(`
                    SELECT
                        transaction_id,
                        reference,
                        payment_status,
                        digiflazz_status
                    FROM transactions
                    WHERE reference = ?
                `).get(reference);

            if (!transaction) {

                console.warn(
                    "[XENDIT WEBHOOK] Transaksi tidak ditemukan:",
                    reference
                );

                return res.status(404).json({
                    success: false,
                    error: "Transaksi tidak ditemukan."
                });
            }

            /*
             * Tandai pembayaran PAID.
             */
            db.prepare(`
                UPDATE transactions
                SET
                    payment_status = 'PAID',
                    paid_at = COALESCE(
                        paid_at,
                        ?
                    )
                WHERE transaction_id = ?
            `).run(
                new Date().toISOString(),
                transaction.transaction_id
            );

            /*
             * Kirim ke Digiflazz.
             *
             * Fungsi di dalamnya mempunyai claim atomik
             * untuk mencegah double-order.
             */
            const result =
                await sendTransactionToDigiflazz(
                    transaction.transaction_id
                );

            return res.json({
                success: true,
                event,
                transaction_id:
                    transaction.transaction_id,
                digiflazz: result
            });
        }

        /*
         * Event expired tidak boleh dikirim ke Digiflazz.
         */
        if (event === "payment_session.expired") {

            const reference =
                data.reference_id;

            if (reference) {

                db.prepare(`
                    UPDATE transactions
                    SET payment_status = 'EXPIRED'
                    WHERE reference = ?
                      AND payment_status = 'PENDING'
                `).run(reference);
            }

            return res.json({
                success: true,
                ignored: true,
                message: "Payment Session expired."
            });
        }

        return res.json({
            success: true,
            ignored: true,
            event
        });

    } catch (error) {

        console.error(
            "[XENDIT WEBHOOK ERROR]",
            error.response?.data ||
            error.message ||
            error
        );

        /*
         * Kembalikan 500 supaya Xendit mengetahui bahwa
         * webhook belum berhasil diproses.
         */
        return res.status(500).json({
            success: false,
            error:
                "Webhook Xendit gagal diproses."
        });
    }
});


/* =========================
   DIGIFLAZZ CALLBACK WEBHOOK
========================= */

app.post("/api/webhooks/digiflazz", (req, res) => {

    try {

        const data =
            req.body?.data ||
            req.body ||
            {};

        const refId =
            data.ref_id;

        if (!refId) {

            return res.status(400).json({
                success: false,
                error: "ref_id tidak ditemukan."
            });
        }

        /*
         * Kita membuat ref_id:
         * PPOBKU-XXXXXXXX
         *
         * sehingga reference asli adalah bagian setelah
         * prefix tersebut.
         */
        const reference =
            String(refId).replace(
                /^PPOBKU-/i,
                ""
            );

        const transaction =
            db.prepare(`
                SELECT
                    transaction_id,
                    reference,
                    payment_status
                FROM transactions
                WHERE reference = ?
            `).get(reference);

        if (!transaction) {

            console.warn(
                "[DIGIFLAZZ CALLBACK] Transaksi tidak ditemukan:",
                refId
            );

            /*
             * Tetap 200 agar callback tidak terus diulang
             * untuk transaksi yang memang bukan milik kita.
             */
            return res.json({
                success: true,
                ignored: true
            });
        }

        const status =
            String(data.status || "").toLowerCase();

        let finalStatus =
            "PROCESSING";

        if (status === "sukses") {
            finalStatus = "SUCCESS";
        } else if (status === "gagal") {
            finalStatus = "FAILED";
        } else if (status === "pending") {
            finalStatus = "PENDING";
        }

        const message =
            data.message ||
            "Update status dari Digiflazz.";

        db.prepare(`
            UPDATE transactions
            SET
                digiflazz_status = ?,
                digiflazz_ref = COALESCE(
                    ?,
                    digiflazz_ref
                ),
                digiflazz_message = ?,
                processed_at = ?
            WHERE transaction_id = ?
        `).run(
            finalStatus,
            data.ref_id || null,
            String(message),
            new Date().toISOString(),
            transaction.transaction_id
        );

        console.log(
            "[DIGIFLAZZ CALLBACK]",
            transaction.transaction_id,
            finalStatus,
            message
        );

        return res.json({
            success: true
        });

    } catch (error) {

        console.error(
            "[DIGIFLAZZ CALLBACK ERROR]",
            error
        );

        return res.status(500).json({
            success: false,
            error: "Callback Digiflazz gagal diproses."
        });
    }
});


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
                    reference_id: "CUST-" + crypto.randomUUID(),
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
   DIGIFLAZZ LOCAL PRICE CACHE
   better-sqlite3
========================= */

/*
 * Cache Price List Digiflazz.
 *
 * PENTING:
 * - Tidak mengubah tabel products.
 * - Tidak mengubah harga jual.
 * - Tidak melakukan transaksi.
 * - Hanya menyimpan Price List Digiflazz.
 */

db.exec(`
    CREATE TABLE IF NOT EXISTS digiflazz_price_list (
        buyer_sku_code TEXT PRIMARY KEY,
        product_name TEXT NOT NULL DEFAULT '',
        category TEXT NOT NULL DEFAULT '',
        brand TEXT NOT NULL DEFAULT '',
        type TEXT NOT NULL DEFAULT '',
        seller_name TEXT NOT NULL DEFAULT '',
        price INTEGER NOT NULL DEFAULT 0,
        buyer_product_status INTEGER NOT NULL DEFAULT 0,
        seller_product_status INTEGER NOT NULL DEFAULT 0,
        unlimited_stock INTEGER NOT NULL DEFAULT 0,
        stock INTEGER NOT NULL DEFAULT 0,
        multi INTEGER NOT NULL DEFAULT 0,
        start_cut_off TEXT NOT NULL DEFAULT '',
        end_cut_off TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        synced_at TEXT NOT NULL DEFAULT ''
    )
`);

console.log("Tabel digiflazz_price_list siap.");


/*
 * SYNC PRICE LIST
 *
 * Hanya menyimpan ke cache lokal.
 * Tabel products TIDAK disentuh.
 */

/* ============================================================
   DIGIFLAZZ → PPOBKU AUTO CATALOG SYNC
   Harga jual mengikuti harga modal Digiflazz.
   TRANSAKSI LIVE TIDAK DIUBAH.
   ============================================================ */

function calculateDynamicPrice(cost, productName = "", serviceId = "") {
    cost = Number(cost) || 0;

    /*
     * BAYORA PRICING RULE
     * -------------------
     * Harga jual dibuat stabil berdasarkan nominal produk,
     * bukan margin tetap dari Digiflazz.
     *
     * Untuk pulsa:
     * 5K   -> 7K
     * 10K  -> 12K
     * 15K  -> 17K
     * 20K  -> 22K
     * 25K  -> 27K
     * 30K  -> 32K
     * 50K  -> 52K
     * 100K -> 102K
     *
     * Jika harga target <= modal, otomatis dinaikkan
     * agar transaksi tetap menghasilkan keuntungan.
     */

    const name = String(productName || "").toLowerCase();
    const service = String(serviceId || "").toLowerCase();

    let targetPrice = 0;

    if (service === "pulsa" || /pulsa|telkomsel|axis|indosat|tri|smartfren|xl/.test(name)) {
        const nominalMatch = name.match(/(?:rp\.?\s*)?(\d+(?:[.,]\d+)?)\s*(?:k|rb|000)?\b/);

        if (nominalMatch) {
            let nominal = Number(
                nominalMatch[1].replace(",", ".")
            );

            const suffix = nominalMatch[0].toLowerCase();

            if (suffix.includes("k") || suffix.includes("rb")) {
                nominal *= 1000;
            } else if (nominal < 1000) {
                nominal *= 1000;
            }

            const pulsaPrices = {
                5000: 7000,
                10000: 12000,
                15000: 17000,
                20000: 22000,
                25000: 27000,
                30000: 32000,
                50000: 52000,
                100000: 102000
            };

            targetPrice = pulsaPrices[Math.round(nominal)] || 0;
        }
    }

    /*
     * Untuk produk non-pulsa, pertahankan harga berbasis modal
     * yang wajar sampai aturan nominal spesifik ditetapkan.
     */
    if (!targetPrice) {
        let targetMargin;

        if (cost <= 20000) {
            targetMargin = 2000;
        } else if (cost <= 50000) {
            targetMargin = 2500;
        } else if (cost <= 100000) {
            targetMargin = 3000;
        } else {
            targetMargin = 3500;
        }

        targetPrice = Math.ceil(
            (cost + targetMargin) / 500
        ) * 500;
    }

    /*
     * JANGAN PERNAH MENJUAL DI BAWAH MODAL.
     * Minimum profit Rp500.
     */
    const minimumPrice = cost + 500;

    if (targetPrice < minimumPrice) {
        targetPrice = Math.ceil(minimumPrice / 500) * 500;
    }

    const actualMargin = targetPrice - cost;

    return {
        price: targetPrice,
        margin: actualMargin
    };
}

function syncDigiflazzCatalogFromCache() {

    /*
     * Semua kategori Digiflazz yang dianggap sebagai produk
     * katalog PPOBKU.
     *
     * danacek sengaja tidak dijual sebagai produk karena
     * merupakan layanan cek nama DANA, bukan top-up.
     */
    const serviceConfig = {
        "Pulsa": {
            id: "pulsa",
            title: "Pulsa",
            icon: "📱",
            description: "Isi pulsa semua operator",
            label: "Nomor HP",
            placeholder: "08xxxxxxxxxx",
            sort_order: 1
        },

        "Data": {
            id: "data",
            title: "Paket Data",
            icon: "🌐",
            description: "Paket internet semua operator",
            label: "Nomor HP",
            placeholder: "08xxxxxxxxxx",
            sort_order: 2
        },

        "PLN": {
            id: "pln-token",
            title: "Token PLN",
            icon: "⚡",
            description: "Beli token listrik prabayar",
            label: "Nomor Meter / ID Pelanggan",
            placeholder: "Masukkan nomor meter",
            sort_order: 3
        },

        "E-Money": {
            id: "ewallet",
            title: "E-Wallet",
            icon: "💳",
            description: "Top up saldo e-wallet",
            label: "Nomor HP",
            placeholder: "08xxxxxxxxxx",
            sort_order: 4
        },

        "Games": {
            id: "games",
            title: "Games",
            icon: "🎮",
            description: "Top up game",
            label: "User ID",
            placeholder: "Masukkan User ID",
            sort_order: 5
        },

        "Aktivasi Voucher": {
            id: "aktivasi-voucher",
            title: "Aktivasi Voucher",
            icon: "🎟️",
            description: "Aktivasi voucher digital",
            label: "Nomor HP",
            placeholder: "08xxxxxxxxxx",
            sort_order: 6
        },

        "Paket SMS & Telpon": {
            id: "paket-sms-telpon",
            title: "Paket SMS & Telpon",
            icon: "☎️",
            description: "Paket SMS dan telepon",
            label: "Nomor HP",
            placeholder: "08xxxxxxxxxx",
            sort_order: 7
        },

        "TV": {
            id: "tv",
            title: "TV",
            icon: "📺",
            description: "Bayar atau isi layanan TV",
            label: "ID Pelanggan",
            placeholder: "Masukkan ID pelanggan",
            sort_order: 8
        },

        "Masa Aktif": {
            id: "masa-aktif",
            title: "Masa Aktif",
            icon: "📅",
            description: "Tambah masa aktif kartu",
            label: "Nomor HP",
            placeholder: "08xxxxxxxxxx",
            sort_order: 9
        },

        "Aktivasi Perdana": {
            id: "aktivasi-perdana",
            title: "Aktivasi Perdana",
            icon: "📲",
            description: "Aktivasi kartu perdana",
            label: "Nomor HP",
            placeholder: "08xxxxxxxxxx",
            sort_order: 10
        },

        "Voucher": {
            id: "voucher",
            title: "Voucher",
            icon: "🎫",
            description: "Pembelian voucher",
            label: "Nomor HP",
            placeholder: "08xxxxxxxxxx",
            sort_order: 11
        },

        "Gas": {
            id: "gas",
            title: "Gas",
            icon: "🔥",
            description: "Pembayaran layanan gas",
            label: "Nomor Pelanggan",
            placeholder: "Masukkan nomor pelanggan",
            sort_order: 12
        }
    };

    const rows = db.prepare(`
        SELECT *
        FROM digiflazz_price_list
        WHERE buyer_sku_code IS NOT NULL
          AND buyer_sku_code != ''
          AND buyer_sku_code != 'danacek'
        ORDER BY category, brand, price, buyer_sku_code
    `).all();

    if (!rows.length) {
        throw new Error("Cache Digiflazz kosong.");
    }

    /*
     * Pastikan semua service Digiflazz tersedia di PPOBKU.
     */
    const upsertService = db.prepare(`
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
        VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
        ON CONFLICT(id)
        DO UPDATE SET
            title = excluded.title,
            icon = excluded.icon,
            description = excluded.description,
            label = excluded.label,
            placeholder = excluded.placeholder,
            active = 1,
            sort_order = excluded.sort_order
    `);

    /*
     * Produk yang sudah ada tetap di-update.
     * Produk baru otomatis INSERT.
     */
    const existing = db.prepare(`
        SELECT id
        FROM products
    `).all();

    const existingIds = new Set(
        existing.map(row => row.id)
    );

    const updateProduct = db.prepare(`
        UPDATE products
        SET
            service_id = ?,
            operator = ?,
            name = ?,
            price = ?,
            info = ?,
            active = 1,
            sort_order = ?,
            cost_price = ?,
            margin = ?,
            digiflazz_sku = ?
        WHERE id = ?
    `);

    const insertProduct = db.prepare(`
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
        VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
    `);

    /*
     * Semua SKU Digiflazz yang sedang ada di cache.
     * Produk PPOBKU yang sebelumnya berasal dari Digiflazz
     * tetapi sudah tidak ada di cache akan dinonaktifkan.
     */
    const cachedSkus = new Set(
        rows.map(p => p.buyer_sku_code)
    );

    const deactivateOld = db.prepare(`
        UPDATE products
        SET active = 0
        WHERE digiflazz_sku IS NOT NULL
          AND digiflazz_sku != ''
    `);

    let inserted = 0;
    let updated = 0;
    let skipped = 0;

    const counters = {};

    const transaction = db.transaction(() => {

        /*
         * Pastikan service yang digunakan oleh cache aktif.
         */
        for (const config of Object.values(serviceConfig)) {
            upsertService.run(
                config.id,
                config.title,
                config.icon,
                config.description,
                config.label,
                config.placeholder,
                config.sort_order,
                new Date().toISOString()
            );
        }

        /*
         * Nonaktifkan dulu produk Digiflazz lama.
         * Produk yang masih tersedia akan diaktifkan kembali
         * ketika loop di bawah berjalan.
         */
        deactivateOld.run();

        for (const p of rows) {

            const config = serviceConfig[p.category];

            /*
             * Kalau suatu saat Digiflazz menambah kategori baru
             * yang belum kita kenal, jangan memasukkannya secara
             * sembarangan ke service yang salah.
             */
            if (!config) {
                skipped++;
                continue;
            }

            const serviceId = config.id;

            counters[serviceId] =
                (counters[serviceId] || 0) + 1;

            const cost = Number(p.price) || 0;

            const dynamic =
                calculateDynamicPrice(
                    cost,
                    p.product_name || sku,
                    serviceId
                );

            const sku =
                p.buyer_sku_code;

            const operator =
                p.brand || "";

            const name =
                p.product_name ||
                sku;

            const info =
                p.product_name ||
                "";

            const createdAt =
                p.created_at ||
                new Date().toISOString();

            if (existingIds.has(sku)) {

                updateProduct.run(
                    serviceId,
                    operator,
                    name,
                    dynamic.price,
                    info,
                    counters[serviceId],
                    cost,
                    dynamic.margin,
                    sku,
                    sku
                );

                updated++;

            } else {

                insertProduct.run(
                    sku,
                    serviceId,
                    operator,
                    name,
                    dynamic.price,
                    info,
                    counters[serviceId],
                    createdAt,
                    cost,
                    dynamic.margin,
                    sku
                );

                inserted++;
            }
        }
    });

    transaction();

    const active = db.prepare(`
        SELECT COUNT(*) AS total
        FROM products
        WHERE active = 1
    `).get().total;

    const serviceCounts = db.prepare(`
        SELECT
            service_id,
            COUNT(*) AS total
        FROM products
        WHERE active = 1
        GROUP BY service_id
        ORDER BY service_id
    `).all();

    return {
        source_products: rows.length,
        inserted,
        updated,
        skipped,
        active_products: active,
        service_counts: serviceCounts
    };
}

/*
 * Endpoint khusus sinkronisasi:
 *
 * 1. Refresh price list Digiflazz menggunakan endpoint lama.
 * 2. Baca cache terbaru.
 * 3. Update catalog PPOBKU.
 *
 * Tidak melakukan transaksi pembelian.
 */
app.post("/api/digiflazz/sync-catalog", async (req, res) => {

    try {

        let refresh = {
            success: false,
            synced: false,
            count: 0
        };

        /*
         * Coba refresh Price List Digiflazz.
         * Kalau Digiflazz sedang gagal/502, JANGAN
         * langsung menggagalkan katalog.
         */
        try {

            const response = await axios.post(
                `http://127.0.0.1:${PORT}/api/digiflazz/sync-price-list`,
                {},
                {
                    timeout: 60000
                }
            );

            refresh = response.data || {};

        } catch (refreshError) {

            console.warn(
                "[DIGIFLAZZ] Refresh Price List gagal:",
                refreshError.message
            );

            /*
             * Cache lokal tetap dipakai sebagai fallback.
             */
        }

        /*
         * Pastikan cache lokal masih mempunyai data.
         */
        const cacheCount = db.prepare(`
            SELECT COUNT(*) AS total
            FROM digiflazz_price_list
        `).get().total;

        if (cacheCount === 0) {

            return res.status(502).json({
                success: false,
                mode: "AUTO_CATALOG_SYNC",
                message:
                    "Price List Digiflazz gagal diperbarui dan cache lokal kosong."
            });

        }

        /*
         * Gunakan cache terakhir yang tersedia.
         */
        const result =
            syncDigiflazzCatalogFromCache();

        res.json({
            success: true,
            mode: "AUTO_CATALOG_SYNC",
            price_list_refresh: {
                success: !!refresh.success,
                synced: !!refresh.synced,
                count: Number(refresh.count || 0),
                cache_count: cacheCount
            },
            ...result,
            message:
                refresh.success
                    ? "Price List Digiflazz berhasil diperbarui dan katalog PPOBKU ikut disinkronkan."
                    : "Refresh Digiflazz gagal sementara, tetapi katalog PPOBKU berhasil disinkronkan menggunakan cache lokal terakhir."
        });

    } catch (error) {

        console.error(
            "[DIGIFLAZZ SYNC CATALOG]",
            error
        );

        res.status(500).json({
            success: false,
            message:
                "Sinkronisasi katalog gagal.",
            error: error.message
        });
    }
});



/* ============================================================
   PPOBKU_DIGIFLAZZ_AUTO_SYNC_V1

   AUTO SYNC:
   - setiap 1 jam
   - tidak menyentuh transaksi live
   - cache lama dipertahankan jika Digiflazz gagal
   ============================================================ */

const DIGIFLAZZ_AUTO_SYNC_INTERVAL =
    60 * 60 * 1000; // 1 jam

let digiflazzAutoSyncRunning = false;

let digiflazzAutoSyncStatus = {
    running: false,
    last_attempt: null,
    last_success: null,
    last_failure: null,
    last_result: null,
    last_error: null
};


/*
 * Jalankan satu kali proses auto-sync.
 */
async function runDigiflazzAutoSync() {

    if (digiflazzAutoSyncRunning) {

        console.log(
            "[DIGIFLAZZ AUTO SYNC] Sync sebelumnya masih berjalan. Dilewati."
        );

        return;
    }

    digiflazzAutoSyncRunning = true;

    digiflazzAutoSyncStatus.running = true;
    digiflazzAutoSyncStatus.last_attempt =
        new Date().toISOString();

    console.log(
        "[DIGIFLAZZ AUTO SYNC] Memulai sinkronisasi otomatis..."
    );

    try {

        const response = await axios.post(
            `http://127.0.0.1:${PORT}/api/digiflazz/sync-catalog`,
            {},
            {
                timeout: 120000
            }
        );

        const result = response.data || {};

        digiflazzAutoSyncStatus.last_result = result;
        digiflazzAutoSyncStatus.last_error = null;

        /*
         * success utama berarti katalog berhasil diproses.
         * Bisa saja refresh Digiflazz gagal tetapi fallback
         * cache berhasil digunakan.
         */
        if (result.success) {

            digiflazzAutoSyncStatus.last_success =
                new Date().toISOString();

            console.log(
                "[DIGIFLAZZ AUTO SYNC] Berhasil.",
                JSON.stringify(result)
            );

        } else {

            digiflazzAutoSyncStatus.last_failure =
                new Date().toISOString();

            console.warn(
                "[DIGIFLAZZ AUTO SYNC] Gagal.",
                JSON.stringify(result)
            );
        }

    } catch (error) {

        digiflazzAutoSyncStatus.last_failure =
            new Date().toISOString();

        digiflazzAutoSyncStatus.last_error =
            error.message;

        console.error(
            "[DIGIFLAZZ AUTO SYNC] Error:",
            error.message
        );

    } finally {

        digiflazzAutoSyncRunning = false;
        digiflazzAutoSyncStatus.running = false;
    }
}


/*
 * Status auto-sync.
 *
 * Endpoint:
 * GET /api/digiflazz/auto-sync/status
 */

/*
 * Manual trigger untuk testing satu siklus Auto Sync.
 *
 * Tidak mengubah interval scheduler.
 * Tidak melakukan transaksi live.
 */
app.post("/api/digiflazz/auto-sync/run", async (req, res) => {

    try {

        if (digiflazzAutoSyncRunning) {

            return res.status(409).json({
                success: false,
                message:
                    "Auto Sync sedang berjalan."
            });
        }

        await runDigiflazzAutoSync();

        res.json({
            success: true,
            mode: "MANUAL_AUTO_SYNC_TEST",
            status: digiflazzAutoSyncStatus
        });

    } catch (error) {

        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});


app.get("/api/digiflazz/auto-sync/status", (req, res) => {

    try {

        const cache = db.prepare(`
            SELECT
                COUNT(*) AS total,
                MAX(synced_at) AS last_cache_sync
            FROM digiflazz_price_list
        `).get();

        const products = db.prepare(`
            SELECT
                COUNT(*) AS total,
                SUM(
                    CASE
                        WHEN active = 1 THEN 1
                        ELSE 0
                    END
                ) AS active
            FROM products
        `).get();

        res.json({
            success: true,

            scheduler: {
                enabled: true,
                interval_minutes: 60,
                running:
                    digiflazzAutoSyncStatus.running
            },

            last_attempt:
                digiflazzAutoSyncStatus.last_attempt,

            last_success:
                digiflazzAutoSyncStatus.last_success,

            last_failure:
                digiflazzAutoSyncStatus.last_failure,

            last_error:
                digiflazzAutoSyncStatus.last_error,

            last_result:
                digiflazzAutoSyncStatus.last_result,

            cache: {
                total: Number(cache.total || 0),
                last_sync:
                    cache.last_cache_sync || null
            },

            catalog: {
                total: Number(products.total || 0),
                active: Number(products.active || 0)
            }
        });

    } catch (error) {

        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});


/*
 * Scheduler 1 jam.
 *
 * Tidak melakukan sync langsung ketika server baru
 * dinyalakan. Sync pertama dilakukan setelah 1 jam.
 *
 * Ini sengaja agar startup PPOBKU tidak bergantung
 * kepada availability Digiflazz.
 */
setInterval(
    runDigiflazzAutoSync,
    DIGIFLAZZ_AUTO_SYNC_INTERVAL
);

console.log(
    "[DIGIFLAZZ AUTO SYNC] Scheduler aktif: setiap 60 menit."
);


app.get("/api/digiflazz/catalog-preview", (req, res) => {

    try {

        const rows = db.prepare(`
            SELECT
                id,
                service_id,
                operator,
                name,
                cost_price,
                price,
                margin,
                digiflazz_sku,
                active
            FROM products
            WHERE active = 1
            ORDER BY service_id, sort_order
        `).all();

        res.json({
            success: true,
            count: rows.length,
            products: rows
        });

    } catch (error) {

        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});


app.post("/api/digiflazz/sync-price-list", async (req, res) => {

    try {

        const username = process.env.DIGIFLAZZ_USERNAME;
        const apiKey = process.env.DIGIFLAZZ_API_KEY;

        if (!username || !apiKey) {

            return res.status(500).json({
                success: false,
                error: "Credential Digiflazz belum dikonfigurasi."
            });

        }

        const sign = crypto
            .createHash("md5")
            .update(username + apiKey + "pricelist")
            .digest("hex");

        const response = await axios.post(
            "https://api.digiflazz.com/v1/price-list",
            {
                cmd: "prepaid",
                username,
                sign
            },
            {
                headers: {
                    "Content-Type": "application/json"
                },
                timeout: 30000
            }
        );

        console.log(
            "[DIGIFLAZZ PRICE LIST RESPONSE]",
            JSON.stringify(response.data, null, 2)
        );

        /*
         * Digiflazz normal:
         * response.data.data = array produk.
         *
         * Jika terkena rate limit, Digiflazz mengembalikan:
         * {
         *   data: {
         *     rc: "83",
         *     message: "Anda telah mencapai limitasi pengecekan pricelist..."
         *   }
         * }
         *
         * RC 83 bukan berarti cache rusak.
         * Gunakan cache lokal terakhir dan jangan menimpanya.
         */
        const apiData = response.data?.data;

        if (!Array.isArray(apiData)) {

            const rc = String(apiData?.rc || "");

            if (rc === "83") {

                const cacheCount = db.prepare(`
                    SELECT COUNT(*) AS total
                    FROM digiflazz_price_list
                `).get().total;

                console.warn(
                    "[DIGIFLAZZ] RC 83 - Price List terkena rate limit. Cache lokal tetap digunakan.",
                    "cache_count:",
                    cacheCount
                );

                return res.json({
                    success: true,
                    synced: false,
                    mode: "RATE_LIMIT_CACHE",
                    count: 0,
                    cache_count: cacheCount,
                    rc: "83",
                    message:
                        "Digiflazz sedang membatasi pengecekan Price List. Cache lokal terakhir tetap digunakan."
                });
            }

            return res.status(502).json({
                success: false,
                synced: false,
                count: 0,
                message:
                    "Digiflazz mengembalikan Price List kosong/tidak valid. Cache lokal tidak diubah."
            });

        }

        const products = apiData;

        /*
         * SAFETY:
         * Jangan pernah menghapus cache jika API
         * mengembalikan array kosong.
         */
        if (products.length === 0) {

            return res.status(502).json({
                success: false,
                synced: false,
                count: 0,
                message:
                    "Digiflazz mengembalikan Price List kosong. Cache lokal tidak diubah."
            });

        }

        const now = new Date().toISOString();

        const insert = db.prepare(`
            INSERT INTO digiflazz_price_list (
                buyer_sku_code,
                product_name,
                category,
                brand,
                type,
                seller_name,
                price,
                buyer_product_status,
                seller_product_status,
                unlimited_stock,
                stock,
                multi,
                start_cut_off,
                end_cut_off,
                description,
                synced_at
            )
            VALUES (
                @buyer_sku_code,
                @product_name,
                @category,
                @brand,
                @type,
                @seller_name,
                @price,
                @buyer_product_status,
                @seller_product_status,
                @unlimited_stock,
                @stock,
                @multi,
                @start_cut_off,
                @end_cut_off,
                @description,
                @synced_at
            )
            ON CONFLICT(buyer_sku_code)
            DO UPDATE SET
                product_name = excluded.product_name,
                category = excluded.category,
                brand = excluded.brand,
                type = excluded.type,
                seller_name = excluded.seller_name,
                price = excluded.price,
                buyer_product_status =
                    excluded.buyer_product_status,
                seller_product_status =
                    excluded.seller_product_status,
                unlimited_stock =
                    excluded.unlimited_stock,
                stock = excluded.stock,
                multi = excluded.multi,
                start_cut_off =
                    excluded.start_cut_off,
                end_cut_off =
                    excluded.end_cut_off,
                description =
                    excluded.description,
                synced_at =
                    excluded.synced_at
        `);

        const sync = db.transaction((items) => {

            for (const item of items) {

                insert.run({
                    buyer_sku_code:
                        item.buyer_sku_code || "",

                    product_name:
                        item.product_name || "",

                    category:
                        item.category || "",

                    brand:
                        item.brand || "",

                    type:
                        item.type || "",

                    seller_name:
                        item.seller_name || "",

                    price:
                        Number(item.price) || 0,

                    buyer_product_status:
                        item.buyer_product_status ? 1 : 0,

                    seller_product_status:
                        item.seller_product_status ? 1 : 0,

                    unlimited_stock:
                        item.unlimited_stock ? 1 : 0,

                    stock:
                        Number(item.stock) || 0,

                    multi:
                        item.multi ? 1 : 0,

                    start_cut_off:
                        item.start_cut_off || "",

                    end_cut_off:
                        item.end_cut_off || "",

                    description:
                        item.desc || "",

                    synced_at: now
                });

            }

        });

        sync(products);

        return res.json({
            success: true,
            synced: true,
            mode: "CACHE_ONLY",
            count: products.length,
            message:
                "Price List berhasil disimpan ke cache lokal. Tabel products PPOBKU tidak diubah."
        });

    } catch (error) {

        console.error(
            "Digiflazz sync error:",
            error.response?.data || error.message
        );

        return res.status(500).json({
            success: false,
            synced: false,
            error:
                error.response?.data?.message ||
                error.message ||
                "Gagal sinkronisasi Price List."
        });

    }

});


/*
 * CACHE SUMMARY
 *
 * READ-ONLY.
 * Tidak memanggil Digiflazz.
 */
app.get("/api/digiflazz/cache/summary", (req, res) => {

    try {

        const total = db.prepare(`
            SELECT
                COUNT(*) AS total,
                MAX(synced_at) AS last_sync
            FROM digiflazz_price_list
        `).get();

        const categories = db.prepare(`
            SELECT
                category,
                COUNT(*) AS count
            FROM digiflazz_price_list
            GROUP BY category
            ORDER BY count DESC
        `).all();

        return res.json({
            success: true,
            source: "LOCAL_CACHE",
            total: total?.total || 0,
            last_sync: total?.last_sync || null,
            categories
        });

    } catch (error) {

        return res.status(500).json({
            success: false,
            error: error.message
        });

    }

});


/*
 * CACHE PRODUCTS
 *
 * READ-ONLY.
 */
app.get("/api/digiflazz/cache", (req, res) => {

    try {

        const products = db.prepare(`
            SELECT
                buyer_sku_code,
                product_name,
                category,
                brand,
                type,
                seller_name,
                price,
                buyer_product_status,
                seller_product_status,
                unlimited_stock,
                stock,
                multi,
                start_cut_off,
                end_cut_off,
                description,
                synced_at
            FROM digiflazz_price_list
            ORDER BY category, brand, price
        `).all();

        return res.json({
            success: true,
            source: "LOCAL_CACHE",
            count: products.length,
            products
        });

    } catch (error) {

        return res.status(500).json({
            success: false,
            error: error.message
        });

    }

});


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
