require("dotenv").config({ override: true });
const express = require("express");
const path = require("path");
const crypto = require("crypto");
const Database = require("better-sqlite3");
const axios = require("axios");
const multer = require("multer");
const { Resend } = require("resend");

const app = express();
const PORT = process.env.PORT || 3000;


/* =========================
   DIGITAL PRODUCT UPLOAD
========================= */

const digitalUploadRoot =
    process.env.NODE_ENV === "production"
        ? "/data/uploads/digital"
        : path.join(__dirname, "..", "uploads", "digital");

const digitalPreviewDir =
    path.join(digitalUploadRoot, "preview");

const digitalFileDir =
    path.join(digitalUploadRoot, "files");

const fs =
    require("fs");

fs.mkdirSync(
    digitalPreviewDir,
    { recursive: true }
);

fs.mkdirSync(
    digitalFileDir,
    { recursive: true }
);


const previewStorage =
    multer.diskStorage({

        destination:
            (req, file, cb) => {

                cb(
                    null,
                    digitalPreviewDir
                );

            },

        filename:
            (req, file, cb) => {

                const extension =
                    path.extname(
                        file.originalname
                    ).toLowerCase();

                const filename =
                    `${Date.now()}-${crypto.randomBytes(8).toString("hex")}${extension}`;

                cb(
                    null,
                    filename
                );

            }

    });


const digitalFileStorage =
    multer.diskStorage({

        destination:
            (req, file, cb) => {

                cb(
                    null,
                    digitalFileDir
                );

            },

        filename:
            (req, file, cb) => {

                const filename =
                    `${Date.now()}-${crypto.randomBytes(8).toString("hex")}.zip`;

                cb(
                    null,
                    filename
                );

            }

    });


const uploadPreview =
    multer({

        storage:
            previewStorage,

        limits: {
            fileSize:
                10 * 1024 * 1024
        },

        fileFilter:
            (req, file, cb) => {

                const allowed =
                    [
                        "image/jpeg",
                        "image/png",
                        "image/webp"
                    ];

                if (
                    allowed.includes(
                        file.mimetype
                    )
                ) {

                    cb(
                        null,
                        true
                    );

                    return;

                }

                cb(
                    new Error(
                        "Preview hanya boleh JPG, PNG, atau WEBP."
                    )
                );

            }

    });


const uploadDigitalFile =
    multer({

        storage:
            digitalFileStorage,

        limits: {
            fileSize:
                50 * 1024 * 1024
        },

        fileFilter:
            (req, file, cb) => {

                const extension =
                    path.extname(
                        file.originalname
                    ).toLowerCase();

                if (
                    extension === ".zip"
                ) {

                    cb(
                        null,
                        true
                    );

                    return;

                }

                cb(
                    new Error(
                        "File preset harus berupa ZIP."
                    )
                );

            }

    });




/* =========================
   DATABASE
========================= */

const dbPath = process.env.NODE_ENV === "production"
    ? "/data/ppobku.db"
    : path.join(__dirname, "..", "database", "ppobku.db");

console.log("[DATABASE] NODE_ENV:", process.env.NODE_ENV || "(undefined)");
console.log("[DATABASE] DB PATH:", dbPath);

const db = new Database(dbPath);

/* BAYORA_SECURE_DIGITAL_TOKEN_HELPER */

function createDigitalDownloadToken() {

    return crypto
        .randomBytes(32)
        .toString("hex");

}

function hashDigitalDownloadToken(token) {

    return crypto
        .createHash("sha256")
        .update(String(token))
        .digest("hex");

}

function createOrRefreshDigitalDownloadToken(
    transactionId
) {

    const token =
        createDigitalDownloadToken();

    const tokenHash =
        hashDigitalDownloadToken(token);

    const now =
        new Date();

    const expires =
        new Date(
            now.getTime() +
            1000 * 60 * 60 * 24 * 30
        );

    db.prepare(`
        INSERT INTO digital_download_tokens (
            transaction_id,
            token_hash,
            created_at,
            expires_at,
            download_count
        )
        VALUES (?, ?, ?, ?, 0)

        ON CONFLICT(transaction_id)
        DO UPDATE SET
            token_hash = excluded.token_hash,
            created_at = excluded.created_at,
            expires_at = excluded.expires_at
    `).run(
        transactionId,
        tokenHash,
        now.toISOString(),
        expires.toISOString()
    );

    return token;
}

function verifyDigitalDownloadToken(
    transactionId,
    token
) {

    if (
        !transactionId ||
        !token
    ) {
        return false;
    }

    const row =
        db.prepare(`
            SELECT
                transaction_id AS transactionId,
                token_hash AS tokenHash,
                expires_at AS expiresAt
            FROM digital_download_tokens
            WHERE transaction_id = ?
            LIMIT 1
        `).get(transactionId);

    if (!row) {
        return false;
    }

    if (
        row.expiresAt &&
        Date.now() >=
        new Date(row.expiresAt).getTime()
    ) {
        return false;
    }

    const suppliedHash =
        hashDigitalDownloadToken(token);

    return crypto.timingSafeEqual(
        Buffer.from(row.tokenHash, "hex"),
        Buffer.from(suppliedHash, "hex")
    );
}

function registerDigitalDownload(
    transactionId
) {

    db.prepare(`
        UPDATE digital_download_tokens
        SET download_count =
            download_count + 1
        WHERE transaction_id = ?
    `).run(transactionId);

}



/* BAYORA_SECURE_DIGITAL_DOWNLOAD_TABLE */

db.exec(`
    CREATE TABLE IF NOT EXISTS digital_download_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        transaction_id TEXT NOT NULL UNIQUE,
        token_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT,
        download_count INTEGER NOT NULL DEFAULT 0
    )
`);



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

/* ==========================================================
   DIGITAL TRANSACTION ITEMS
   Khusus transaksi Lightroom / produk digital.
   Tidak mengubah sistem transaksi PPOB.
========================================================== */

db.exec(`
    CREATE TABLE IF NOT EXISTS digital_transaction_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        transaction_id TEXT NOT NULL,
        product_id TEXT NOT NULL,
        product_name TEXT NOT NULL,
        price INTEGER NOT NULL DEFAULT 0,
        digital_file TEXT,
        created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS
        idx_digital_transaction_items_transaction
        ON digital_transaction_items(transaction_id);

    CREATE INDEX IF NOT EXISTS
        idx_digital_transaction_items_product
        ON digital_transaction_items(product_id);
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


/* ==========================================================
   ADMIN AUTHENTICATION
========================================================== */

db.exec(`
    CREATE TABLE IF NOT EXISTS admins (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'admin',
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS admin_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        admin_id INTEGER NOT NULL,
        token_hash TEXT UNIQUE NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (admin_id)
            REFERENCES admins(id)
            ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_admin_sessions_token
        ON admin_sessions(token_hash);

    CREATE INDEX IF NOT EXISTS idx_admin_sessions_admin
        ON admin_sessions(admin_id);
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

const deliveryStatusColumn =
    db.prepare("PRAGMA table_info(transactions)")
        .all()
        .some(column => column.name === "delivery_status");

if (!deliveryStatusColumn) {
    db.prepare(`
        ALTER TABLE transactions
        ADD COLUMN delivery_status TEXT NOT NULL DEFAULT 'PENDING'
    `).run();

    console.log(
        "[DB MIGRATION] Kolom transactions.delivery_status berhasil ditambahkan."
    );
}

const transactionColumns =
    db.prepare("PRAGMA table_info(transactions)").all();

const transactionColumnNames =
    transactionColumns.map(column => column.name);

const transactionMigrations = [
    ["user_id", "INTEGER"],
    ["payment_status", 'TEXT NOT NULL DEFAULT "PENDING"'],
    ["digiflazz_status", 'TEXT NOT NULL DEFAULT "PENDING"'],
    ["digiflazz_ref", "TEXT"],
    ["digiflazz_message", "TEXT"],
    ["digiflazz_rc", "TEXT"],
    ["digiflazz_sn", "TEXT"],
    ["payment_session_id", "TEXT"],
    ["payment_request_id", "TEXT"],
    ["refund_status", "TEXT"],
    ["refund_id", "TEXT"],
    ["refund_message", "TEXT"],
    ["refund_processed_at", "TEXT"],
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
   SERVICE TYPE MIGRATION
   ppob = layanan PPOB lama
   digital = produk digital
========================= */

const serviceColumns =
    db.prepare("PRAGMA table_info(services)").all();

const serviceColumnNames =
    serviceColumns.map(column => column.name);

if (!serviceColumnNames.includes("type")) {

    db.prepare(`
        ALTER TABLE services
        ADD COLUMN type TEXT NOT NULL DEFAULT 'ppob'
    `).run();

    console.log(
        "[DB MIGRATION] Kolom services.type berhasil ditambahkan. Default: ppob."
    );
}

db.prepare(`
    UPDATE services
    SET type = 'ppob'
    WHERE type IS NULL
       OR TRIM(type) = ''
`).run();



/* =========================
   PRODUCT DIGITAL MIGRATION
   Field khusus produk digital.
========================= */

const digitalProductColumns =
    db.prepare("PRAGMA table_info(products)").all();

const digitalProductColumnNames =
    digitalProductColumns.map(column => column.name);

/*
 * ==========================================================
 * DIGITAL PREVIEW GALLERY MIGRATION
 *
 * before_image  = foto BEFORE untuk katalog
 * after_image   = foto AFTER untuk katalog
 * gallery_images = daftar foto untuk detail produk
 *
 * Tidak mengubah flow PPOB.
 * ==========================================================
 */

const digitalPreviewMigrations = [
    ["before_image", "TEXT"],
    ["after_image", "TEXT"],
    ["gallery_images", "TEXT"]
];

for (
    const [columnName, columnDefinition]
    of digitalPreviewMigrations
) {

    if (
        !digitalProductColumnNames.includes(
            columnName
        )
    ) {

        db.prepare(
            `ALTER TABLE products ADD COLUMN ${columnName} ${columnDefinition}`
        ).run();

        console.log(
            `[DB MIGRATION] Kolom products.${columnName} berhasil ditambahkan.`
        );

    }

}



const productMigrations = [
    ["product_type", "TEXT NOT NULL DEFAULT 'ppob'"],
    ["preview_image", "TEXT"],
    ["digital_file", "TEXT"],
    ["mood", "TEXT NOT NULL DEFAULT ''"]
];

for (const [columnName, columnDefinition] of productMigrations) {

    if (!digitalProductColumnNames.includes(columnName)) {

        db.prepare(
            `ALTER TABLE products ADD COLUMN ${columnName} ${columnDefinition}`
        ).run();

        console.log(
            `[DB MIGRATION] Kolom products.${columnName} berhasil ditambahkan.`
        );
    }
}

db.prepare(`
    UPDATE products
    SET product_type = 'ppob'
    WHERE product_type IS NULL
       OR TRIM(product_type) = ''
`).run();


/* ==========================================================
   DIGITAL TRANSACTION — CUSTOMER & DEVICE
========================================================== */

    db.prepare("PRAGMA table_info(transactions)").all();

const digitalTransactionMigrations = [
    ["customer_email", "TEXT"],
    ["customer_whatsapp", "TEXT"],
    ["device", "TEXT"]
];

for (
    const [columnName, columnDefinition]
    of digitalTransactionMigrations
) {

    const exists =
        transactionColumns.some(
            column => column.name === columnName
        );

    if (!exists) {

        db.prepare(
            `ALTER TABLE transactions ADD COLUMN ${columnName} ${columnDefinition}`
        ).run();

        console.log(
            `[DB MIGRATION] Kolom transactions.${columnName} berhasil ditambahkan.`
        );
    }
}


/* ==========================================================
   DIGITAL PRODUCT — PDF PER DEVICE
========================================================== */

const pdfProductMigrations = [
    ["pdf_ios", "TEXT"],
    ["pdf_android", "TEXT"],
    ["pdf_mac", "TEXT"],
    ["pdf_windows", "TEXT"]
];

for (
    const [columnName, columnDefinition]
    of pdfProductMigrations
) {

    const columns =
        db.prepare(
            "PRAGMA table_info(products)"
        ).all();

    const exists =
        columns.some(
            column => column.name === columnName
        );

    if (!exists) {

        db.prepare(
            `ALTER TABLE products ADD COLUMN ${columnName} ${columnDefinition}`
        ).run();

        console.log(
            `[DB MIGRATION] Kolom products.${columnName} berhasil ditambahkan.`
        );
    }
}


/* ==========================================================
   DIGITAL TRANSACTION — FILE PDF DEVICE
========================================================== */

const digitalTransactionColumns =
    db.prepare(
        "PRAGMA table_info(digital_transaction_items)"
    ).all();

const hasDeviceFile =
    digitalTransactionColumns.some(
        column => column.name === "device_file"
    );

if (!hasDeviceFile) {

    db.prepare(`
        ALTER TABLE digital_transaction_items
        ADD COLUMN device_file TEXT
    `).run();

    console.log(
        "[DB MIGRATION] Kolom digital_transaction_items.device_file berhasil ditambahkan."
    );
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
   USER AUTHENTICATION
========================= */

db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        phone TEXT NOT NULL UNIQUE,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (user_id)
            REFERENCES users(id)
            ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_user_sessions_token
        ON user_sessions(token_hash);

    CREATE INDEX IF NOT EXISTS idx_user_sessions_user
        ON user_sessions(user_id);
`);

function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString("hex");

    const hash = crypto
        .scryptSync(password, salt, 64)
        .toString("hex");

    return `${salt}:${hash}`;
}

function verifyPassword(password, storedPassword) {
    const parts = String(storedPassword).split(":");

    if (parts.length !== 2) {
        return false;
    }

    const [salt, storedHash] = parts;

    const calculatedHash = crypto
        .scryptSync(password, salt, 64)
        .toString("hex");

    const storedBuffer = Buffer.from(storedHash, "hex");
    const calculatedBuffer = Buffer.from(calculatedHash, "hex");

    if (storedBuffer.length !== calculatedBuffer.length) {
        return false;
    }

    return crypto.timingSafeEqual(
        storedBuffer,
        calculatedBuffer
    );
}

function hashSessionToken(token) {
    return crypto
        .createHash("sha256")
        .update(token)
        .digest("hex");
}

function getSessionToken(req) {
    const cookieHeader = req.headers.cookie || "";
    const cookies = {};

    cookieHeader.split(";").forEach(part => {
        const index = part.indexOf("=");

        if (index === -1) {
            return;
        }

        const name = part.slice(0, index).trim();
        const value = part.slice(index + 1).trim();

        try {
            cookies[name] = decodeURIComponent(value);
        } catch {
            cookies[name] = value;
        }
    });

    return cookies.bayora_session || null;
}

function createUserSession(userId) {
    const token = crypto.randomBytes(32).toString("hex");
    const tokenHash = hashSessionToken(token);

    const now = new Date();

    const expires = new Date(
        now.getTime() + 30 * 24 * 60 * 60 * 1000
    );

    db.prepare(`
        INSERT INTO user_sessions (
            user_id,
            token_hash,
            expires_at,
            created_at
        )
        VALUES (?, ?, ?, ?)
    `).run(
        userId,
        tokenHash,
        expires.toISOString(),
        now.toISOString()
    );

    return token;
}

function getCurrentUser(req) {
    const token = getSessionToken(req);

    if (!token) {
        return null;
    }

    const tokenHash = hashSessionToken(token);

    const session = db.prepare(`
        SELECT
            s.id AS session_id,
            s.expires_at,
            u.id,
            u.name,
            u.phone,
            u.email,
            u.created_at
        FROM user_sessions s
        JOIN users u
            ON u.id = s.user_id
        WHERE s.token_hash = ?
        LIMIT 1
    `).get(tokenHash);

    if (!session) {
        return null;
    }

    if (
        new Date(session.expires_at).getTime() <=
        Date.now()
    ) {
        db.prepare(`
            DELETE FROM user_sessions
            WHERE id = ?
        `).run(session.session_id);

        return null;
    }

    return {
        id: session.id,
        name: session.name,
        phone: session.phone,
        email: session.email,
        created_at: session.created_at
    };
}

/* =========================
   AUTH: REGISTER
========================= */

app.post("/api/auth/register", (req, res) => {
    try {
        const name = String(req.body.name || "").trim();
        const phone = String(req.body.phone || "").trim();
        const email = String(req.body.email || "").trim().toLowerCase();
        const password = String(req.body.password || "");

        if (!name || !phone || !email || !password) {
            return res.status(400).json({
                success: false,
                error: "Semua field wajib diisi."
            });
        }

        if (password.length < 8) {
            return res.status(400).json({
                success: false,
                error: "Password minimal 8 karakter."
            });
        }

        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return res.status(400).json({
                success: false,
                error: "Format email tidak valid."
            });
        }

        const existing = db.prepare(`
            SELECT id
            FROM users
            WHERE email = ? OR phone = ?
            LIMIT 1
        `).get(email, phone);

        if (existing) {
            return res.status(409).json({
                success: false,
                error: "Email atau nomor HP sudah terdaftar."
            });
        }

        const now = new Date().toISOString();
        const passwordHash = hashPassword(password);

        const result = db.prepare(`
            INSERT INTO users (
                name,
                phone,
                email,
                password_hash,
                created_at,
                updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(
            name,
            phone,
            email,
            passwordHash,
            now,
            now
        );

        return res.status(201).json({
            success: true,
            message: "Registrasi berhasil.",
            user: {
                id: result.lastInsertRowid,
                name,
                phone,
                email
            }
        });

    } catch (error) {
        console.error("[AUTH REGISTER]", error);

        return res.status(500).json({
            success: false,
            error: "Gagal melakukan registrasi."
        });
    }
});

/* =========================
   AUTH: LOGIN
========================= */

app.post("/api/auth/login", (req, res) => {
    try {
        const identifier = String(
            req.body.identifier || ""
        ).trim();

        const password = String(
            req.body.password || ""
        );

        if (!identifier || !password) {
            return res.status(400).json({
                success: false,
                error: "Email/nomor HP dan password wajib diisi."
            });
        }

        const normalizedEmail = identifier.toLowerCase();

        const user = db.prepare(`
            SELECT
                id,
                name,
                phone,
                email,
                password_hash,
                created_at
            FROM users
            WHERE email = ? OR phone = ?
            LIMIT 1
        `).get(
            normalizedEmail,
            identifier
        );

        if (!user) {
            return res.status(401).json({
                success: false,
                error: "Email/nomor HP atau password salah."
            });
        }

        const passwordValid = verifyPassword(
            password,
            user.password_hash
        );

        if (!passwordValid) {
            return res.status(401).json({
                success: false,
                error: "Email/nomor HP atau password salah."
            });
        }

        const token = createUserSession(user.id);

        res.setHeader(
            "Set-Cookie",
            `bayora_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`
        );

        return res.json({
            success: true,
            message: "Login berhasil.",
            user: {
                id: user.id,
                name: user.name,
                phone: user.phone,
                email: user.email,
                created_at: user.created_at
            }
        });

    } catch (error) {
        console.error("[AUTH LOGIN]", error);

        return res.status(500).json({
            success: false,
            error: "Gagal melakukan login."
        });
    }
});

/* =========================
   AUTH: LOGOUT
========================= */

app.post("/api/auth/logout", (req, res) => {
    try {
        const token = getSessionToken(req);

        if (token) {
            const tokenHash = hashSessionToken(token);

            db.prepare(`
                DELETE FROM user_sessions
                WHERE token_hash = ?
            `).run(tokenHash);
        }

        res.setHeader(
            "Set-Cookie",
            [
                "bayora_session=",
                "Path=/",
                "HttpOnly",
                "SameSite=Lax",
                "Max-Age=0"
            ].join("; ")
        );

        return res.status(200).json({
            success: true,
            message: "Logout berhasil."
        });

    } catch (error) {
        console.error("[AUTH LOGOUT]", error);

        return res.status(500).json({
            success: false,
            error: "Gagal melakukan logout."
        });
    }
});

/* =========================
   AUTH: CURRENT USER
========================= */

app.get("/api/auth/me", (req, res) => {
    try {
        const user = getCurrentUser(req);

        if (!user) {
            return res.status(401).json({
                success: false,
                authenticated: false,
                error: "Belum login."
            });
        }

        return res.json({
            success: true,
            authenticated: true,
            user
        });

    } catch (error) {
        console.error("[AUTH ME]", error);

        return res.status(500).json({
            success: false,
            authenticated: false,
            error: "Gagal mengecek session."
        });
    }
});

/* =========================
   FRONTEND
========================= */


/* ==========================================================
   ACCOUNT PROFILE
========================================================== */

app.get("/api/auth/profile", (req, res) => {

    try {

        const user = getCurrentUser(req);

        if (!user) {
            return res.status(401).json({
                success: false,
                authenticated: false,
                error: "Belum login."
            });
        }

        return res.json({
            success: true,
            user
        });

    } catch (error) {

        console.error("[AUTH PROFILE]", error);

        return res.status(500).json({
            success: false,
            error: "Gagal mengambil profil."
        });
    }
});


/* ==========================================================
   ACCOUNT TRANSACTION HISTORY
========================================================== */

app.get("/api/auth/history", (req, res) => {

    try {

        const user = getCurrentUser(req);

        if (!user) {
            return res.status(401).json({
                success: false,
                authenticated: false,
                error: "Belum login."
            });
        }

        const transactions = db.prepare(`
            SELECT
                t.id,
                t.transaction_id AS transactionId,
                t.reference,
                t.service,
                t.target,
                t.operator,
                t.product_id AS productId,
                t.product_name AS productName,
                t.price,
                t.payment_method AS paymentMethod,
                t.status,
                t.payment_status AS paymentStatus,
                t.digiflazz_status AS digiflazzStatus,
                t.digiflazz_ref AS digiflazzRef,
                t.digiflazz_message AS digiflazzMessage,
                t.paid_at AS paidAt,
                t.processed_at AS processedAt,
                t.created_at AS createdAt
            FROM transactions t
            WHERE t.user_id = ?
            ORDER BY t.id DESC
        `).all(user.id);

        return res.json({
            success: true,
            count: transactions.length,
            transactions
        });

    } catch (error) {

        console.error("[AUTH HISTORY]", error);

        return res.status(500).json({
            success: false,
            error: "Gagal mengambil riwayat transaksi."
        });
    }
});


/* ==========================================================
   DELETE ACCOUNT
========================================================== */

app.delete("/api/auth/delete-account", (req, res) => {

    try {

        const user = getCurrentUser(req);

        if (!user) {
            return res.status(401).json({
                success: false,
                authenticated: false,
                error: "Belum login."
            });
        }

        const deleteAccount = db.transaction(() => {

            /*
             * Transaksi bisnis tidak dihapus.
             * Pemilik transaksi dilepas agar histori tetap aman.
             */
            db.prepare(`
                UPDATE transactions
                SET user_id = NULL
                WHERE user_id = ?
            `).run(user.id);

            /*
             * Hapus seluruh session akun.
             */
            db.prepare(`
                DELETE FROM user_sessions
                WHERE user_id = ?
            `).run(user.id);

            /*
             * Hapus akun.
             */
            const result = db.prepare(`
                DELETE FROM users
                WHERE id = ?
            `).run(user.id);

            return result.changes;
        });

        const deleted = deleteAccount();

        if (deleted !== 1) {
            return res.status(404).json({
                success: false,
                error: "Akun tidak ditemukan."
            });
        }

        res.setHeader(
            "Set-Cookie",
            "bayora_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"
        );

        return res.json({
            success: true,
            message: "Akun berhasil dihapus."
        });

    } catch (error) {

        console.error("[AUTH DELETE ACCOUNT]", error);

        return res.status(500).json({
            success: false,
            error: "Gagal menghapus akun."
        });
    }
});



app.use(
    express.static(
        path.join(__dirname, "..")
    )
);

/*
 * DIGITAL PRODUCT PREVIEW
 *
 * Preview gambar boleh diakses public.
 * File ZIP/PDF tetap private dan hanya
 * dikirim melalui endpoint download terproteksi.
 */
app.use(
    "/uploads/digital/preview",
    express.static(digitalPreviewDir)
);



/* =========================
   TEMP SAFE DIGIFLAZZ RETRY
========================= */

app.post("/api/debug/retry-transaction/:id", async (req, res) => {
    try {

        const adminPassword = req.headers["x-admin-password"];

        if (
            !adminPassword ||
            adminPassword !== process.env.ADMIN_PASSWORD
        ) {
            return res.status(401).json({
                success: false,
                error: "Unauthorized."
            });
        }

        const transactionId = req.params.id;

        if (transactionId !== "PPOB-1786893730544") {
            return res.status(400).json({
                success: false,
                error: "Endpoint ini hanya untuk transaksi yang sedang diperbaiki."
            });
        }

        const transaction = db.prepare(`
            SELECT
                transaction_id,
                payment_status,
                digiflazz_status,
                digiflazz_ref,
                digiflazz_message
            FROM transactions
            WHERE transaction_id = ?
        `).get(transactionId);

        if (!transaction) {
            return res.status(404).json({
                success: false,
                error: "Transaksi tidak ditemukan."
            });
        }

        if (transaction.payment_status !== "PAID") {
            return res.status(400).json({
                success: false,
                error: "Transaksi belum PAID.",
                transaction
            });
        }

        if (transaction.digiflazz_status === "SUCCESS") {
            return res.status(400).json({
                success: false,
                error: "Transaksi sudah SUCCESS. Tidak diulang.",
                transaction
            });
        }

        if (transaction.digiflazz_ref) {
            return res.status(400).json({
                success: false,
                error: "Transaksi sudah memiliki digiflazz_ref. Tidak diulang.",
                transaction
            });
        }

        db.prepare(`
            UPDATE transactions
            SET
                digiflazz_status = 'PENDING',
                digiflazz_message = NULL,
                processed_at = NULL
            WHERE transaction_id = ?
              AND payment_status = 'PAID'
              AND digiflazz_ref IS NULL
        `).run(transactionId);

        const result = await sendTransactionToDigiflazz(transactionId);

        return res.json({
            success: true,
            retry: true,
            result
        });

    } catch (error) {

        console.error("[SAFE DIGIFLAZZ RETRY]", error);

        return res.status(500).json({
            success: false,
            error:
                error.response?.data ||
                error.message ||
                "Retry Digiflazz gagal."
        });
    }
});

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

        const currentUser = getCurrentUser(req);

        const {
            service,
            target,
            operator,
            productId,
            productName,
            price,
            paymentMethod
        } = req.body;

        if (!currentUser) {
            return res.status(401).json({
                success: false,
                error: "Silakan login terlebih dahulu."
            });
        }

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
                user_id,
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
                @userId,
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
            userId: currentUser.id,
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
                t.id,
                t.transaction_id AS transactionId,
                t.reference,
                t.service,
                t.target,
                t.operator,
                t.product_id AS productId,
                t.product_name AS productName,
                t.price,
                t.payment_method AS paymentMethod,
                t.status,
                t.payment_status AS paymentStatus,
                p.product_type AS productType,
                t.created_at AS createdAt
            FROM transactions t
            LEFT JOIN products p
                ON p.id = t.product_id
            WHERE t.transaction_id = ?
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



/* ==========================================================
   CREATE DIGITAL TRANSACTION
   Khusus Lightroom / produk digital multi-produk.
   Tidak mengubah endpoint PPOB /api/transactions.
========================================================== */

app.post("/api/digital-transactions", (req, res) => {

    try {

        const {
            service,
            productIds,
            customerEmail,
            customerWhatsapp,
            device,
            paymentMethod = "xendit"
        } = req.body;


        if (
            !service ||
            !Array.isArray(productIds) ||
            !productIds.length ||
            !customerEmail ||
            !customerWhatsapp ||
            !device
        ) {

            return res.status(400).json({
                success: false,
                error: "Data pembelian digital belum lengkap."
            });

        }


        const email =
            String(customerEmail)
                .trim()
                .toLowerCase();

        const whatsapp =
            String(customerWhatsapp)
                .trim();

        const selectedDevice =
            String(device)
                .trim();


        if (
            !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
        ) {

            return res.status(400).json({
                success: false,
                error: "Format email tidak valid."
            });

        }


        if (!whatsapp) {

            return res.status(400).json({
                success: false,
                error: "Nomor WhatsApp wajib diisi."
            });

        }


        if (
            !["iOS", "Android", "MacOS", "Windows"].includes(
                selectedDevice
            )
        ) {

            return res.status(400).json({
                success: false,
                error: "Perangkat tidak valid."
            });

        }


        /*
         * Hilangkan duplikat product ID.
         */
        const uniqueProductIds =
            [
                ...new Set(
                    productIds
                        .map(id =>
                            String(id).trim()
                        )
                        .filter(Boolean)
                )
            ];


        if (!uniqueProductIds.length) {

            return res.status(400).json({
                success: false,
                error: "Tidak ada produk yang dipilih."
            });

        }


        /*
         * Ambil produk langsung dari database.
         * Harga dari browser TIDAK dipercaya.
         */
        const placeholders =
            uniqueProductIds
                .map(() => "?")
                .join(",");


        const products =
            db.prepare(`
                SELECT
                    id,
                    service_id,
                    name,
                    price,
                    active,
                    product_type,
                    preview_image,
                    digital_file,
                    pdf_ios,
                    pdf_android,
                    pdf_mac,
                    pdf_windows
                FROM products
                WHERE id IN (${placeholders})
            `).all(
                ...uniqueProductIds
            );


        if (
            products.length !==
            uniqueProductIds.length
        ) {

            return res.status(400).json({
                success: false,
                error: "Salah satu produk tidak ditemukan."
            });

        }


        const invalidProduct =
            products.find(product =>
                !Number(product.active) ||
                product.product_type !== "digital" ||
                !product.digital_file
            );


        if (invalidProduct) {

            return res.status(400).json({
                success: false,
                error:
                    `Produk "${invalidProduct.name}" tidak tersedia untuk pembelian digital.`
            });

        }


        /*
         * Pastikan seluruh produk memang
         * berasal dari layanan yang dikirim.
         */
        const invalidService =
            products.find(product =>
                product.service_id !== service
            );


        if (invalidService) {

            return res.status(400).json({
                success: false,
                error: "Produk tidak sesuai dengan layanan."
            });

        }


        const total =
            products.reduce(
                (sum, product) =>
                    sum +
                    Number(product.price || 0),
                0
            );


        if (
            !Number.isFinite(total) ||
            total <= 0
        ) {

            return res.status(400).json({
                success: false,
                error: "Total pembayaran tidak valid."
            });

        }


        const transactionId =
            "DIGITAL-" + Date.now();


        const reference =
            crypto
                .randomBytes(4)
                .toString("hex")
                .toUpperCase();


        const createdAt =
            new Date().toISOString();


        /*
         * Nama ringkas untuk tabel transactions.
         * Detail seluruh produk disimpan
         * di digital_transaction_items.
         */
        const productName =
            products.length === 1
                ? products[0].name
                : `${products[0].name} + ${products.length - 1} preset lainnya`;


        const transaction =
            db.transaction(() => {

                db.prepare(`
                    INSERT INTO transactions (
                        user_id,
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
                        customer_email,
                        customer_whatsapp,
                        device,
                        created_at
                    )
                    VALUES (
                        @userId,
                        @transactionId,
                        @reference,
                        @service,
                        @target,
                        NULL,
                        @productId,
                        @productName,
                        @price,
                        @paymentMethod,
                        'PENDING',
                        @customerEmail,
                        @customerWhatsapp,
                        @device,
                        @createdAt
                    )
                `).run({

                    userId:
                        null,

                    transactionId,

                    reference,

                    service,

                    target:
                        email,

                    productId:
                        products.length === 1
                            ? products[0].id
                            : null,

                    productName,

                    price:
                        total,

                    paymentMethod,

                    customerEmail:
                        email,

                    customerWhatsapp:
                        whatsapp,

                    device:
                        selectedDevice,

                    createdAt

                });


                const insertItem =
                    db.prepare(`
                        INSERT INTO digital_transaction_items (
                            transaction_id,
                            product_id,
                            product_name,
                            price,
                            digital_file,
                            device_file,
                            created_at
                        )
                        VALUES (
                            @transactionId,
                            @productId,
                            @productName,
                            @price,
                            @digitalFile,
                            @deviceFile,
                            @createdAt
                        )
                    `);


                for (
                    const product of products
                ) {

                    console.log("=== DIGITAL DEVICE DEBUG ===");
                    console.log({
                        selectedDevice,
                        productId: product.id,
                        pdf_ios: product.pdf_ios,
                        pdf_android: product.pdf_android,
                        pdf_mac: product.pdf_mac,
                        pdf_windows: product.pdf_windows
                    });

                    insertItem.run({

                        transactionId,

                        productId:
                            product.id,

                        productName:
                            product.name,

                        price:
                            Number(
                                product.price || 0
                            ),

                        digitalFile:
                            product.digital_file,

                        deviceFile:
                            selectedDevice === "iOS"
                                ? product.pdf_ios
                                : selectedDevice === "Android"
                                    ? product.pdf_android
                                    : selectedDevice === "MacOS"
                                        ? product.pdf_mac
                                        : selectedDevice === "Windows"
                                            ? product.pdf_windows
                                            : null,

                        createdAt

                    });

                }


                return db.prepare(`
                    SELECT
                        id,
                        transaction_id AS transactionId,
                        reference,
                        service,
                        target,
                        product_name AS productName,
                        price,
                        payment_method AS paymentMethod,
                        status,
                        payment_status AS paymentStatus,
                        created_at AS createdAt
                    FROM transactions
                    WHERE transaction_id = ?
                `).get(
                    transactionId
                );

            })();


        console.log("");
        console.log("==============================");
        console.log("DIGITAL TRANSAKSI TERSIMPAN");
        console.log({
            transaction,
            customerEmail: email,
            customerWhatsapp: whatsapp,
            device: selectedDevice,
            products:
                products.map(product => ({
                    id: product.id,
                    name: product.name,
                    price: product.price
                }))
        });
        console.log("==============================");
        console.log("");


        return res.status(201).json({

            success: true,

            message:
                "Transaksi digital berhasil disimpan.",

            transaction,

            customer: {
                email,
                whatsapp,
                device: selectedDevice
            },

            products:
                products.map(product => ({
                    id: product.id,
                    name: product.name,
                    price: Number(
                        product.price || 0
                    )
                })),

            total

        });

    } catch (error) {

        console.error(
            "Digital transaction error:",
            error
        );

        return res.status(500).json({

            success: false,

            error:
                "Gagal menyimpan transaksi digital."

        });

    }

});


/* =========================
   GET ALL TRANSACTIONS
========================= */

function requireRoles(...allowedRoles) {

    return (req, res, next) => {

        const admin = getCurrentAdmin(req);

        if (!admin) {

            return res.status(401).json({
                success: false,
                authenticated: false,
                error: "Admin belum login."
            });

        }

        if (!allowedRoles.includes(admin.role)) {

            return res.status(403).json({
                success: false,
                error: "Kamu tidak memiliki akses ke fitur ini."
            });

        }

        req.admin = admin;

        next();
    };

}


/*
 * Owner + Admin
 * Dipakai untuk pengelolaan layanan dan produk.
 */
const requireCatalogManager =
    requireRoles("owner", "admin");


/*
 * Owner + Admin + Support
 * Dipakai untuk membaca data admin.
 */
const requireAdminStaff =
    requireRoles("owner", "admin", "support");





app.get("/api/transactions", requireAdminStaff, (req, res) => {

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
   BAYORA SERVICE ICON UPLOAD
========================= */

const bayoraIconDir =
    path.join(
        __dirname,
        "..",
        "assets",
        "bayora-icons"
    );

fs.mkdirSync(
    bayoraIconDir,
    { recursive: true }
);

const bayoraIconStorage =
    multer.diskStorage({

        destination:
            (req, file, cb) => {

                cb(
                    null,
                    bayoraIconDir
                );

            },

        filename:
            (req, file, cb) => {

                const extension =
                    path.extname(
                        file.originalname
                    ).toLowerCase();

                const serviceId =
                    String(
                        req.body.serviceId ||
                        req.query.serviceId ||
                        "service"
                    )
                        .trim()
                        .toLowerCase()
                        .replace(
                            /[^a-z0-9_-]/g,
                            "-"
                        );

                const filename =
                    `${serviceId}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}${extension}`;

                cb(
                    null,
                    filename
                );

            }

    });

const uploadBayoraIcon =
    multer({

        storage:
            bayoraIconStorage,

        limits: {
            fileSize:
                5 * 1024 * 1024
        },

        fileFilter:
            (req, file, cb) => {

                const allowed =
                    [
                        "image/jpeg",
                        "image/png",
                        "image/webp"
                    ];

                if (
                    allowed.includes(
                        file.mimetype
                    )
                ) {

                    cb(
                        null,
                        true
                    );

                    return;

                }

                cb(
                    new Error(
                        "Icon hanya boleh JPG, PNG, atau WEBP."
                    )
                );

            }

    });

app.post(
    "/api/services/upload-icon",
    requireCatalogManager,
    (req, res) => {

        uploadBayoraIcon.single("file")(
            req,
            res,
            error => {

                if (error) {

                    console.error(
                        "[UPLOAD SERVICE ICON]",
                        error
                    );

                    return res.status(400).json({
                        success: false,
                        error:
                            error.message ||
                            "Gagal mengupload icon."
                    });

                }

                if (!req.file) {

                    return res.status(400).json({
                        success: false,
                        error:
                            "File icon belum dipilih."
                    });

                }

                const publicPath =
                    `/assets/bayora-icons/${req.file.filename}`;

                return res.json({
                    success: true,
                    path: publicPath,
                    filename: req.file.filename
                });

            }

        );

    }
);


/* =========================
   DIGITAL PRODUCT UPLOAD API
========================= */

app.post(
    "/api/products/upload-preview",
    requireCatalogManager,
    (req, res) => {

        uploadPreview.single("file")(req, res, error => {

            if (error) {

                console.error(
                    "[UPLOAD PREVIEW]",
                    error
                );

                return res.status(400).json({
                    success: false,
                    error:
                        error.message ||
                        "Gagal mengupload preview."
                });

            }

            if (!req.file) {

                return res.status(400).json({
                    success: false,
                    error:
                        "File preview belum dipilih."
                });

            }

            const relativePath =
                path.relative(
                        digitalUploadRoot,
                        req.file.path
                    ).split(path.sep).join("/");

            
                const publicPath =
                    "/uploads/digital/" + relativePath;

return res.json({
                success: true,
                file: {
                    originalName:
                        req.file.originalname,

                    filename:
                        req.file.filename,

                    path:
                        publicPath,

                    size:
                        req.file.size,

                    mimeType:
                        req.file.mimetype
                }
            });

        });

    }
);


/* =========================================================
   DIGITAL PRODUCT PDF UPLOAD
   PDF panduan per perangkat:
   iOS / Android / Mac / Windows
========================================================= */

const pdfStorage =
    multer.diskStorage({

        destination:
            (req, file, cb) => {

                cb(
                    null,
                    digitalFileDir
                );

            },

        filename:
            (req, file, cb) => {

                const filename =
                    `${Date.now()}-${crypto.randomBytes(8).toString("hex")}.pdf`;

                cb(
                    null,
                    filename
                );

            }

    });


const uploadDigitalPdf =
    multer({

        storage:
            pdfStorage,

        limits: {
            fileSize:
                20 * 1024 * 1024
        },

        fileFilter:
            (req, file, cb) => {

                const extension =
                    path.extname(
                        file.originalname
                    ).toLowerCase();

                if (
                    extension === ".pdf"
                ) {

                    cb(
                        null,
                        true
                    );

                    return;

                }

                cb(
                    new Error(
                        "File panduan harus berupa PDF."
                    )
                );

            }

    });


app.post(
    "/api/products/upload-pdf",
    requireCatalogManager,
    (req, res) => {

        uploadDigitalPdf.single("file")(
            req,
            res,
            error => {

                if (error) {

                    console.error(
                        "[UPLOAD DIGITAL PDF]",
                        error
                    );

                    return res.status(400).json({
                        success: false,
                        error:
                            error.message ||
                            "Gagal mengupload PDF."
                    });

                }

                if (!req.file) {

                    return res.status(400).json({
                        success: false,
                        error:
                            "File PDF belum dipilih."
                    });

                }

                const relativePath =
                    path.relative(
                        digitalUploadRoot,
                        req.file.path
                    )
                    .split(path.sep)
                    .join("/");

                
                const publicPath =
                    "/uploads/digital/" + relativePath;

return res.json({

                    success: true,

                    file: {

                        originalName:
                            req.file.originalname,

                        filename:
                            req.file.filename,

                        path:
                            publicPath,

                        size:
                            req.file.size,

                        mimeType:
                            req.file.mimetype

                    }

                });

            }

        );

    }

);


app.post(
    "/api/products/upload-file",
    requireCatalogManager,
    (req, res) => {

        uploadDigitalFile.single("file")(
            req,
            res,
            error => {

                console.log(
                    "[DIGITAL UPLOAD DEBUG]",
                    {
                        hasFile: !!req.file,
                        filename: req.file?.filename || "***NONE***",
                        path: req.file?.path || "***NONE***",
                        size: req.file?.size || 0
                    }
                );

                if (error) {

                    console.error(
                        "[UPLOAD DIGITAL FILE]",
                        error
                    );

                    return res.status(400).json({
                        success: false,
                        error:
                            error.message ||
                            "Gagal mengupload file preset."
                    });

                }

                if (!req.file) {

                    return res.status(400).json({
                        success: false,
                        error:
                            "File preset belum dipilih."
                    });

                }

                const relativePath =
                    path.relative(
                        digitalUploadRoot,
                        req.file.path
                    ).split(path.sep).join("/");

                const publicPath =
                    "/uploads/digital/" + relativePath;

                return res.json({
                    success: true,
                    file: {
                        originalName:
                            req.file.originalname,

                        filename:
                            req.file.filename,

                        path:
                            publicPath,

                        size:
                            req.file.size,

                        mimeType:
                            req.file.mimetype
                    }
                });

            }
        );

    }
);


/* =========================
   RESET TRANSACTIONS BY MONTH
========================= */

app.delete("/api/transactions", requireRoles("owner"), (req, res) => {

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



/* =========================================================
   XENDIT — SYNC PAYMENT SESSION STATUS
   Khusus transaksi Xendit.
   Tidak mengubah flow PPOB / Digiflazz.
========================================================= */

app.post(
    "/api/transactions/:id/sync-xendit",
    async (req, res) => {

        try {

            const transactionId =
                String(req.params.id || "").trim();

            if (!transactionId) {

                return res.status(400).json({
                    success: false,
                    error: "Transaction ID wajib diisi."
                });

            }

            /*
             * Hanya transaksi DIGITAL-* yang boleh
             * menggunakan endpoint ini.
             */
            if (!transactionId.startsWith("DIGITAL-")) {

                return res.status(400).json({
                    success: false,
                    error:
                        "Sync Xendit hanya untuk transaksi digital."
                });

            }

            const transaction =
                db.prepare(`
                    SELECT
                        id,
                        transaction_id AS transactionId,
                        payment_method AS paymentMethod,
                        payment_status AS paymentStatus,
                        status,
                        payment_session_id AS paymentSessionId,
                        payment_request_id AS paymentRequestId
                    FROM transactions
                    WHERE transaction_id = ?
                `).get(transactionId);

            if (!transaction) {

                return res.status(404).json({
                    success: false,
                    error: "Transaksi tidak ditemukan."
                });

            }

            /*
             * Pastikan benar-benar Xendit.
             */
            if (
                String(transaction.paymentMethod || "")
                    .toLowerCase() !== "xendit"
            ) {

                return res.status(400).json({
                    success: false,
                    error:
                        "Transaksi bukan pembayaran Xendit."
                });

            }

            /*
             * Sudah PAID tidak perlu request ke Xendit lagi.
             */
            if (
                transaction.paymentStatus === "PAID"
            ) {

                const downloadToken =
                    String(transaction.transactionId || "")
                        .startsWith("DIGITAL-")
                        ? createOrRefreshDigitalDownloadToken(
                            transaction.transactionId
                        )
                        : null;

                return res.json({
                    success: true,
                    changed: false,
                    paymentStatus: "PAID",
                    status: transaction.status,
                    downloadToken
                });

            }

            if (!transaction.paymentSessionId) {

                return res.status(409).json({
                    success: false,
                    error:
                        "payment_session_id belum tersedia."
                });

            }

            if (!process.env.XENDIT_SECRET_KEY) {

                console.error(
                    "[XENDIT SYNC] XENDIT_SECRET_KEY belum tersedia."
                );

                return res.status(500).json({
                    success: false,
                    error:
                        "XENDIT_SECRET_KEY belum tersedia."
                });

            }

            /*
             * Ambil status Payment Session langsung
             * dari Xendit.
             *
             * Endpoint resmi:
             * GET /sessions/{session_id}
             */
            const response =
                await axios.get(
                    "https://api.xendit.co/sessions/" +
                    encodeURIComponent(
                        transaction.paymentSessionId
                    ),
                    {
                        auth: {
                            username:
                                process.env.XENDIT_SECRET_KEY,
                            password: ""
                        },
                        timeout: 15000
                    }
                );

            const session =
                response.data || {};

            const sessionStatus =
                String(
                    session.status || ""
                ).toUpperCase();

            console.log(
                "[XENDIT SYNC]",
                {
                    transactionId,
                    paymentSessionId:
                        transaction.paymentSessionId,
                    sessionStatus
                }
            );

            /*
             * Payment Session COMPLETED =
             * pembayaran berhasil.
             */
            if (
                sessionStatus === "COMPLETED"
            ) {

                const paymentRequestId =
                    session.payment_request_id ||
                    transaction.paymentRequestId ||
                    null;

                const update =
                    db.prepare(`
                        UPDATE transactions
                        SET
                            status = 'SUCCESS',
                            payment_status = 'PAID',
                            payment_session_id = COALESCE(
                                payment_session_id,
                                ?
                            ),
                            payment_request_id = COALESCE(
                                payment_request_id,
                                ?
                            ),
                            paid_at = COALESCE(
                                paid_at,
                                CURRENT_TIMESTAMP
                            ),
                            processed_at = COALESCE(
                                processed_at,
                                CURRENT_TIMESTAMP
                            )
                        WHERE transaction_id = ?
                          AND payment_method = 'xendit'
                          AND payment_status != 'PAID'
                    `).run(
                        transaction.paymentSessionId,
                        paymentRequestId,
                        transactionId
                    );

                console.log(
                    "[XENDIT SYNC] PAYMENT PAID:",
                    {
                        transactionId,
                        changes: update.changes
                    }
                );

                const downloadToken =
                    String(transactionId || "")
                        .startsWith("DIGITAL-")
                        ? createOrRefreshDigitalDownloadToken(
                            transactionId
                        )
                        : null;

                return res.json({
                    success: true,
                    changed: update.changes > 0,
                    paymentStatus: "PAID",
                    status: "SUCCESS",
                    downloadToken
                });

            }

            /*
             * Session masih aktif / belum selesai.
             */
            if (
                sessionStatus === "ACTIVE" ||
                sessionStatus === "PENDING" ||
                sessionStatus === ""
            ) {

                return res.json({
                    success: true,
                    changed: false,
                    paymentStatus: "PENDING",
                    status: "PENDING",
                    xenditStatus:
                        sessionStatus || "UNKNOWN"
                });

            }

            /*
             * Jangan mengubah transaksi menjadi FAILED
             * sembarangan. Status final selain COMPLETED
             * dilaporkan ke frontend.
             */
            return res.json({
                success: true,
                changed: false,
                paymentStatus:
                    transaction.paymentStatus,
                status:
                    transaction.status,
                xenditStatus:
                    sessionStatus
            });

        } catch (error) {

            console.error(
                "[XENDIT SYNC ERROR]",
                error.response?.data ||
                error.message ||
                error
            );

            return res.status(502).json({
                success: false,
                error:
                    "Gagal memeriksa status pembayaran Xendit."
            });

        }

    }
);


/* =========================
   GET SINGLE TRANSACTION
========================= */

app.get("/api/transactions/:id", (req, res) => {

    try {

        const transaction = db.prepare(`
            SELECT
                t.id,
                t.transaction_id AS transactionId,
                t.reference,
                t.service,
                t.target,
                t.operator,
                t.product_id AS productId,
                t.product_name AS productName,
                t.device AS device,
                t.price,
                t.payment_method AS paymentMethod,
                t.status,
                t.payment_status AS paymentStatus,

                CASE
                    WHEN t.transaction_id LIKE 'DIGITAL-%'
                        THEN 'digital'
                    ELSE p.product_type
                END AS productType,

                t.created_at AS createdAt
            FROM transactions t
            LEFT JOIN products p
                ON p.id = t.product_id
            WHERE t.transaction_id = ?
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
    requireRoles("owner", "admin"),
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
            p.product_type,
            p.digital_file,
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

    /*
     * Produk digital tidak dikirim ke Digiflazz.
     * Pembayaran tetap diproses sebagai PAID,
     * sedangkan file digital akan diberikan melalui
     * mekanisme download khusus.
     */
    if (
        transaction.transaction_id.startsWith("DIGITAL-") ||
        transaction.product_type === "digital"
    ) {

        return {
            skipped: true,
            digital: true,
            reason: "PRODUK_DIGITAL",
            digitalFile: transaction.digital_file || null
        };

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

    /*
     * Simpan informasi penting dari respons Digiflazz
     * ke log tanpa pernah mencetak credential.
     */
    console.log(
        "[DIGIFLAZZ RESPONSE]",
        JSON.stringify({
            transaction_id: transaction.transaction_id,
            ref_id: result.ref_id || refId,
            status: result.status || null,
            rc: result.rc || null,
            sn: result.sn || null,
            message: result.message || null
        })
    );

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
            status = ?,
            digiflazz_status = ?,
            digiflazz_ref = ?,
            digiflazz_message = ?,
            digiflazz_rc = ?,
            digiflazz_sn = ?,
            processed_at = ?
        WHERE transaction_id = ?
    `).run(
        finalStatus,
        finalStatus,
        String(digiflazzRef),
        String(message),
        result.rc || null,
        result.sn || null,
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


/* ============================================================
   DIGIFLAZZ PENDING STATUS CHECKER
   Mengecek transaksi PAID yang masih PENDING menggunakan
   ref_id yang sama. Tidak membuat ref_id baru.
============================================================ */

async function checkPendingDigiflazzTransactions() {

    try {

        const pending = db.prepare(`
            SELECT
                t.transaction_id,
                t.reference,
                t.target,
                t.digiflazz_ref,
                p.digiflazz_sku
            FROM transactions t
            LEFT JOIN products p
                ON p.id = t.product_id
            WHERE t.payment_status = 'PAID'
              AND t.digiflazz_status = 'PENDING'
              AND t.digiflazz_ref IS NOT NULL
              AND t.digiflazz_ref != ''
              AND p.digiflazz_sku IS NOT NULL
              AND p.digiflazz_sku != ''
              AND (
                    t.processed_at IS NULL
                    OR datetime(t.processed_at) <= datetime('now', '-1 minute')
              )
            ORDER BY t.id ASC
            LIMIT 10
        `).all();

        if (!pending.length) {
            return;
        }

        const username =
            process.env.DIGIFLAZZ_USERNAME;

        const apiKey =
            process.env.DIGIFLAZZ_API_KEY;

        if (!username || !apiKey) {
            console.error(
                "[DIGIFLAZZ CHECKER] Credential belum dikonfigurasi."
            );
            return;
        }

        for (const transaction of pending) {

            try {

                /*
                 * Tandai waktu pengecekan sebelum request.
                 * Ini mencegah transaksi yang sama langsung
                 * dicek berulang kali.
                 */
                db.prepare(`
                    UPDATE transactions
                    SET processed_at = ?
                    WHERE transaction_id = ?
                      AND payment_status = 'PAID'
                      AND digiflazz_status = 'PENDING'
                `).run(
                    new Date().toISOString(),
                    transaction.transaction_id
                );

                const refId =
                    String(transaction.digiflazz_ref);

                const sign =
                    crypto
                        .createHash("md5")
                        .update(
                            username +
                            apiKey +
                            refId
                        )
                        .digest("hex");

                const payload = {
                    username,
                    buyer_sku_code:
                        transaction.digiflazz_sku,
                    customer_no:
                        String(transaction.target),
                    ref_id: refId,
                    sign
                };

                const response =
                    await axios.post(
                        "https://api.digiflazz.com/v1/transaction",
                        payload,
                        {
                            headers: {
                                "Content-Type":
                                    "application/json"
                            },
                            timeout: 30000
                        }
                    );

                const result =
                    response.data?.data || {};

                const status =
                    String(
                        result.status || ""
                    ).toLowerCase();

                const finalStatus =
                    status === "sukses"
                        ? "SUCCESS"
                        : status === "gagal"
                            ? "FAILED"
                            : "PENDING";

                const message =
                    result.message ||
                    "Tidak ada pesan dari Digiflazz.";

                db.prepare(`
                    UPDATE transactions
                    SET
                        status = ?,
                        digiflazz_status = ?,
                        digiflazz_ref = COALESCE(
                            ?,
                            digiflazz_ref
                        ),
                        digiflazz_message = ?,
                        digiflazz_rc = COALESCE(
                            ?,
                            digiflazz_rc
                        ),
                        digiflazz_sn = COALESCE(
                            ?,
                            digiflazz_sn
                        ),
                        processed_at = ?
                    WHERE transaction_id = ?
                `).run(
                    finalStatus,
                    finalStatus,
                    result.ref_id || null,
                    String(message),
                    result.rc || null,
                    result.sn || null,
                    new Date().toISOString(),
                    transaction.transaction_id
                );

                /*
                 * Jika Digiflazz GAGAL setelah pembayaran PAID,
                 * otomatis minta refund ke Xendit.
                 *
                 * Hanya transaksi yang mempunyai
                 * payment_request_id yang bisa direfund.
                 */
                if (finalStatus === "FAILED") {

                    try {

                        const refundResult =
                            await refundXenditTransaction(
                                transaction.transaction_id
                            );

                        console.log(
                            "[AUTO REFUND]",
                            transaction.transaction_id,
                            refundResult
                        );

                    } catch (refundError) {

                        console.error(
                            "[AUTO REFUND ERROR]",
                            transaction.transaction_id,
                            refundError.response?.data ||
                            refundError.message ||
                            refundError
                        );

                    }
                }

                console.log(
                    "[DIGIFLAZZ CHECKER]",
                    transaction.transaction_id,
                    finalStatus,
                    result.rc || "-",
                    result.sn || "-"
                );

            } catch (error) {

                console.error(
                    "[DIGIFLAZZ CHECKER]",
                    transaction.transaction_id,
                    error.response?.data ||
                    error.message
                );

                /*
                 * Jangan ubah menjadi FAILED hanya karena
                 * request pengecekan gagal. Transaksi tetap
                 * menunggu pengecekan berikutnya.
                 */
            }
        }

    } catch (error) {

        console.error(
            "[DIGIFLAZZ CHECKER] ERROR",
            error
        );
    }
}


/* ============================================================
   XENDIT REFUND
   Meminta refund menggunakan payment_request_id.
   Idempotent: transaksi yang sudah memiliki refund tidak
   boleh dikirim ke Xendit untuk kedua kalinya.
============================================================ */

async function refundXenditTransaction(transactionId) {

    const transaction = db.prepare(`
        SELECT
            transaction_id,
            reference,
            price,
            payment_status,
            payment_request_id,
            refund_status,
            refund_id,
            product_id
        FROM transactions
        WHERE transaction_id = ?
    `).get(transactionId);

    if (!transaction) {
        throw new Error("Transaksi tidak ditemukan.");
    }

    /*
     * Produk digital tidak boleh direfund.
     */
    if (transaction.product_id) {

        const product = db.prepare(`
            SELECT product_type
            FROM products
            WHERE id = ?
        `).get(transaction.product_id);

        if (product?.product_type === "digital") {
            throw new Error(
                "Produk digital tidak dapat direfund."
            );
        }
    }

    if (transaction.payment_status !== "PAID") {
        throw new Error("Transaksi belum PAID.");
    }

    if (!transaction.payment_request_id) {
        throw new Error(
            "payment_request_id Xendit tidak tersedia."
        );
    }

    /*
     * Jangan pernah membuat refund kedua.
     */
    if (
        transaction.refund_status === "PENDING" ||
        transaction.refund_status === "SUCCESS"
    ) {
        return {
            skipped: true,
            reason: "REFUND_SUDAH_DIPROSES",
            refund_status:
                transaction.refund_status,
            refund_id:
                transaction.refund_id || null
        };
    }

    if (!process.env.XENDIT_SECRET_KEY) {
        throw new Error(
            "XENDIT_SECRET_KEY belum tersedia."
        );
    }

    /*
     * Claim refund secara atomik sebelum request ke Xendit.
     * Ini mencegah dua proses mengirim refund bersamaan.
     */
    const claim = db.prepare(`
        UPDATE transactions
        SET
            refund_status = 'PROCESSING',
            refund_processed_at = ?
        WHERE transaction_id = ?
          AND payment_status = 'PAID'
          AND payment_request_id IS NOT NULL
          AND (
                refund_status IS NULL
                OR refund_status = ''
          )
    `).run(
        new Date().toISOString(),
        transactionId
    );

    if (claim.changes === 0) {

        const current = db.prepare(`
            SELECT
                transaction_id,
                refund_status,
                refund_id,
                refund_message
            FROM transactions
            WHERE transaction_id = ?
        `).get(transactionId);

        return {
            skipped: true,
            reason: "REFUND_SUDAH_DIAMBIL_ALIH_PROSES_LAIN",
            transaction: current
        };
    }

    try {

        const response = await axios.post(
            "https://api.xendit.co/refunds",
            {
                reference_id:
                    `REFUND-${transaction.transaction_id}`,
                payment_request_id:
                    transaction.payment_request_id,
                currency: "IDR",
                amount: transaction.price,
                reason: "CANCELLATION"
            },
            {
                auth: {
                    username:
                        process.env.XENDIT_SECRET_KEY,
                    password: ""
                },
                headers: {
                    "Content-Type":
                        "application/json"
                },
                timeout: 30000
            }
        );

        const refund =
            response.data || {};

        const refundId =
            refund.id ||
            refund.refund_id ||
            null;

        const refundStatus =
            String(
                refund.status || "PENDING"
            ).toUpperCase();

        db.prepare(`
            UPDATE transactions
            SET
                refund_status = ?,
                refund_id = COALESCE(
                    ?,
                    refund_id
                ),
                refund_message = ?,
                refund_processed_at = ?
            WHERE transaction_id = ?
        `).run(
            refundStatus === "SUCCEEDED"
                ? "SUCCESS"
                : "PENDING",
            refundId,
            JSON.stringify(refund),
            new Date().toISOString(),
            transactionId
        );

        console.log(
            "[XENDIT REFUND]",
            transactionId,
            refundStatus,
            refundId || "-"
        );

        return {
            success: true,
            refund_id: refundId,
            refund_status: refundStatus
        };

    } catch (error) {

        const message =
            error.response?.data
                ? JSON.stringify(
                    error.response.data
                )
                : error.message;

        db.prepare(`
            UPDATE transactions
            SET
                refund_status = 'FAILED',
                refund_message = ?,
                refund_processed_at = ?
            WHERE transaction_id = ?
        `).run(
            String(message),
            new Date().toISOString(),
            transactionId
        );

        console.error(
            "[XENDIT REFUND]",
            transactionId,
            message
        );

        throw error;
    }
}





/* ==========================================================
   RETRY DIGITAL PRODUCT EMAIL
   Untuk transaksi DIGITAL-* yang sudah PAID tetapi
   delivery sebelumnya gagal.
========================================================== */


app.post("/api/digital/retry-delivery/:transactionId", async (req, res) => {

    try {

        const retryToken =
            process.env.DIGITAL_RETRY_TOKEN;

        const receivedToken =
            req.headers["x-digital-retry-token"];

        if (
            !retryToken ||
            !receivedToken ||
            receivedToken !== retryToken
        ) {

            return res.status(401).json({
                success: false,
                error: "Unauthorized."
            });

        }

        const transactionId =
            String(req.params.transactionId || "").trim();

        if (!transactionId.startsWith("DIGITAL-")) {

            return res.status(400).json({
                success: false,
                error: "Transaction ID digital tidak valid."
            });

        }

        const transaction =
            db.prepare(`
                SELECT
                    transaction_id,
                    payment_status,
                    delivery_status,
                    customer_email
                FROM transactions
                WHERE transaction_id = ?
            `).get(transactionId);

        if (!transaction) {

            return res.status(404).json({
                success: false,
                error: "Transaksi digital tidak ditemukan."
            });

        }

        if (transaction.payment_status !== "PAID") {

            return res.status(400).json({
                success: false,
                error: "Transaksi belum PAID.",
                transaction
            });

        }

        if (transaction.delivery_status === "SENT") {

            return res.json({
                success: true,
                skipped: true,
                message: "Produk digital sudah terkirim.",
                transaction
            });

        }

        console.log(
            "[DIGITAL DELIVERY RETRY]",
            transactionId
        );

        const delivery =
            await sendDigitalProductEmail(
                transactionId
            );

        return res.json({
            success: true,
            retry: true,
            delivery
        });

    } catch (error) {

        console.error(
            "[DIGITAL DELIVERY RETRY ERROR]",
            error
        );

        return res.status(500).json({
            success: false,
            error:
                error.message ||
                "Gagal mengirim ulang produk digital."
        });

    }

});


/* ==========================================================
   DIGITAL PRODUCT EMAIL DELIVERY
   ZIP + PDF sesuai perangkat.
   Hanya dijalankan setelah pembayaran PAID.
========================================================== */

async function sendDigitalProductEmail(
    transactionId
) {

    const resendApiKey =
        process.env.RESEND_API_KEY;

    const fromEmail =
        process.env.RESEND_FROM_EMAIL;

    if (!resendApiKey) {
        throw new Error(
            "RESEND_API_KEY belum dikonfigurasi."
        );
    }

    if (!fromEmail) {
        throw new Error(
            "RESEND_FROM_EMAIL belum dikonfigurasi."
        );
    }

    const transaction =
        db.prepare(`
            SELECT
                t.transaction_id,
                t.payment_status,
                t.delivery_status,
                t.customer_email,
                t.product_name,
                t.device
            FROM transactions t
            WHERE t.transaction_id = ?
              AND t.transaction_id LIKE 'DIGITAL-%'
            LIMIT 1
        `).get(transactionId);

    if (!transaction) {
        throw new Error(
            "Transaksi digital tidak ditemukan."
        );
    }

    if (transaction.payment_status !== "PAID") {
        throw new Error(
            "Transaksi digital belum PAID."
        );
    }

    /*
     * Anti double-send.
     */
    if (transaction.delivery_status === "SENT") {
        return {
            skipped: true,
            reason: "DELIVERY_SUDAH_TERKIRIM"
        };
    }

    if (!transaction.customer_email) {
        throw new Error(
            "Email pelanggan tidak tersedia."
        );
    }

    const items =
        db.prepare(`
            SELECT
                product_id,
                product_name,
                digital_file,
                device_file
            FROM digital_transaction_items
            WHERE transaction_id = ?
            ORDER BY id ASC
        `).all(transactionId);

    if (!items.length) {
        throw new Error(
            "Item produk digital tidak ditemukan."
        );
    }

    const digitalStorageRoot =
        process.env.NODE_ENV === "production"
            ? "/data"
            : path.join(__dirname, "..");

    const attachments = [];

    for (const item of items) {

        if (item.digital_file) {

            let zipPath =
                path.resolve(
                    digitalStorageRoot,
                    String(item.digital_file)
                        .replace(/^\/+/, "")
                );

            /*
             * Jika file yang tersimpan pada transaksi lama
             * sudah tidak tersedia, gunakan digital_file terbaru
             * dari produk yang sama.
             */
            if (!fs.existsSync(zipPath) && item.product_id) {

                const product =
                    db.prepare(`
                        SELECT digital_file
                        FROM products
                        WHERE id = ?
                        LIMIT 1
                    `).get(item.product_id);

                if (product && product.digital_file) {

                    const fallbackPath =
                        path.resolve(
                            digitalStorageRoot,
                            String(product.digital_file)
                                .replace(/^\/+/, "")
                        );

                    if (fs.existsSync(fallbackPath)) {
                        zipPath = fallbackPath;
                    }
                }
            }

            const relativeZip =
                path.relative(
                    digitalStorageRoot,
                    zipPath
                );

            if (
                relativeZip.startsWith("..") ||
                path.isAbsolute(relativeZip) ||
                !fs.existsSync(zipPath)
            ) {
                throw new Error(
                    `File ZIP tidak ditemukan untuk produk "${item.product_name}".`
                );
            }

            attachments.push({
                filename:
                    path.basename(zipPath),
                content:
                    fs.readFileSync(zipPath)
            });
        }

        if (item.device_file) {

            const pdfPath =
                path.resolve(
                    digitalStorageRoot,
                    String(item.device_file)
                        .replace(/^\/+/, "")
                );

            const relativePdf =
                path.relative(
                    digitalStorageRoot,
                    pdfPath
                );

            if (
                relativePdf.startsWith("..") ||
                path.isAbsolute(relativePdf) ||
                !fs.existsSync(pdfPath)
            ) {
                throw new Error(
                    `PDF tidak ditemukan untuk produk "${item.product_name}".`
                );
            }

            attachments.push({
                filename:
                    path.basename(pdfPath),
                content:
                    fs.readFileSync(pdfPath)
            });
        }
    }

    if (!attachments.length) {
        throw new Error(
            "Tidak ada file digital yang dapat dikirim."
        );
    }

    /*
     * Claim delivery secara atomik.
     * Hanya proses pertama yang mendapat PENDING.
     */
    const claim =
        db.prepare(`
            UPDATE transactions
            SET
                delivery_status = 'PROCESSING'
            WHERE transaction_id = ?
              AND payment_status = 'PAID'
              AND transaction_id LIKE 'DIGITAL-%'
              AND (
                    delivery_status IS NULL
                    OR delivery_status = 'PENDING'
                    OR delivery_status = 'FAILED'
              )
        `).run(transactionId);

    if (claim.changes === 0) {

        const current =
            db.prepare(`
                SELECT
                    delivery_status
                FROM transactions
                WHERE transaction_id = ?
            `).get(transactionId);

        return {
            skipped: true,
            reason:
                "DELIVERY_SUDAH_DIAMBIL_ALIH_PROSES_LAIN",
            delivery_status:
                current?.delivery_status || null
        };
    }

    try {

        const resend =
            new Resend(resendApiKey);

        const device =
            transaction.device ||
            "perangkat yang dipilih";

        const downloadToken =
            createOrRefreshDigitalDownloadToken(
                transactionId
            );

        const publicBaseUrl =
            String(
                process.env.PUBLIC_BASE_URL ||
                process.env.APP_URL ||
                ""
            )
            .trim()
            .replace(/\/+$/, "");

        if (!publicBaseUrl) {
            throw new Error(
                "PUBLIC_BASE_URL atau APP_URL belum dikonfigurasi."
            );
        }

        const presetDownloadUrl =
            publicBaseUrl +
            "/api/digital-products/email-download/" +
            encodeURIComponent(transactionId) +
            "?token=" +
            encodeURIComponent(downloadToken);

        const guideDownloadUrl =
            publicBaseUrl +
            "/api/digital-products/email-guide-download/" +
            encodeURIComponent(transactionId) +
            "?token=" +
            encodeURIComponent(downloadToken);


        const result =
            await resend.emails.send({

                from: fromEmail,

                to: [
                    transaction.customer_email
                ],

                subject:
                    "BAYORA — Produk Lightroom Kamu Sudah Siap ✨",

                html: `
                    <div style="margin:0;padding:0;background:#f5f9ff;font-family:Arial,Helvetica,sans-serif;color:#10244d;">
                        <div style="max-width:620px;margin:0 auto;padding:40px 20px;">

                            <div style="background:#ffffff;border:1px solid rgba(20,201,244,.18);border-radius:20px;overflow:hidden;box-shadow:0 20px 55px rgba(6,26,69,.10);">

                                <!-- HEADER BAYORA -->
                                <div style="padding:34px 30px 30px;text-align:center;background:linear-gradient(100deg,#061a45,#0b2c68);">

                                    <div style="font-size:27px;font-weight:900;letter-spacing:-1px;color:#ffffff;">
                                        BAYORA
                                    </div>

                                    <div style="margin-top:8px;font-size:10px;font-weight:700;letter-spacing:2px;color:#14c9f4;">
                                        LIGHTROOM PRESETS
                                    </div>

                                    <div style="width:42px;height:4px;border-radius:999px;margin:18px auto 0;background:linear-gradient(90deg,#14c9f4,#1268ff);"></div>

                                </div>

                                <!-- CONTENT -->
                                <div style="padding:38px 34px 36px;">

                                    <div style="font-size:25px;font-weight:800;line-height:1.3;color:#10244d;margin-bottom:16px;">
                                        Pesanan kamu sudah siap ✨
                                    </div>

                                    <p style="font-size:15px;line-height:1.8;color:#64748b;margin:0 0 28px;">
                                        Terima kasih telah memilih <strong style="color:#1268ff;">BAYORA</strong>.
                                        Pembayaran kamu telah berhasil dikonfirmasi.
                                        Produk Lightroom yang kamu pesan kini sudah siap digunakan.
                                    </p>

                                    <!-- DETAIL PESANAN -->
                                    <div style="background:#f5f9ff;border:1px solid rgba(20,201,244,.18);border-radius:16px;padding:22px;margin-bottom:28px;">

                                        <div style="font-size:10px;font-weight:800;letter-spacing:1.7px;color:#1268ff;margin-bottom:15px;">
                                            DETAIL PESANAN
                                        </div>

                                        <div style="font-size:14px;line-height:1.7;color:#64748b;">
                                            <span>Produk</span>

                                            <strong style="float:right;color:#10244d;">
                                                ${transaction.product_name || "Lightroom Preset"}
                                            </strong>
                                        </div>

                                        <div style="margin-top:10px;font-size:14px;line-height:1.7;color:#64748b;">
                                            <span>Perangkat</span>

                                            <strong style="float:right;color:#10244d;">
                                                ${device}
                                            </strong>
                                        </div>

                                    </div>

                                    <p style="font-size:14px;line-height:1.8;color:#64748b;margin:0 0 24px;">
                                        File preset dan panduan penggunaan untuk perangkat yang kamu pilih
                                        sudah siap untuk di-download melalui tombol di bawah.
                                    </p>

                                    <!-- FILE DOWNLOAD -->
                                    <div style="border-top:1px solid rgba(20,201,244,.18);border-bottom:1px solid rgba(20,201,244,.18);padding:22px 0;margin-bottom:27px;">

                                        <div style="font-size:10px;font-weight:800;letter-spacing:1.7px;color:#1268ff;margin-bottom:18px;">
                                            FILE PESANAN
                                        </div>

                                        <a
                                            href="${presetDownloadUrl}"
                                            style="
                                                display:block;
                                                width:100%;
                                                box-sizing:border-box;
                                                padding:14px 20px;
                                                margin-bottom:12px;
                                                background:#1268ff;
                                                color:#ffffff;
                                                text-decoration:none;
                                                text-align:center;
                                                border-radius:10px;
                                                font-size:14px;
                                                font-weight:800;
                                            "
                                        >
                                            ↓&nbsp; Download Preset
                                        </a>

                                        <a
                                            href="${guideDownloadUrl}"
                                            style="
                                                display:block;
                                                width:100%;
                                                box-sizing:border-box;
                                                padding:14px 20px;
                                                background:#ffffff;
                                                color:#1268ff;
                                                text-decoration:none;
                                                text-align:center;
                                                border:1px solid #1268ff;
                                                border-radius:10px;
                                                font-size:14px;
                                                font-weight:800;
                                            "
                                        >
                                            ↓&nbsp; Download Panduan
                                        </a>

                                        <div style="margin-top:13px;font-size:12px;line-height:1.6;color:#94a3b8;text-align:center;">
                                            File tidak dilampirkan langsung.
                                            Gunakan tombol di atas untuk mengunduh file kamu.
                                        </div>

                                    </div>

                                    <p style="font-size:14px;line-height:1.8;color:#64748b;margin:0 0 25px;">
                                        Silakan download dan simpan file tersebut dengan baik
                                        agar dapat digunakan kembali kapan saja.
                                    </p>

                                    <!-- SUPPORT -->
                                    <div style="background:#f5f9ff;border-left:4px solid #ffd21c;border-radius:10px;padding:17px 18px;margin-bottom:28px;">

                                        <div style="font-size:13px;line-height:1.7;color:#64748b;">
                                            Mengalami kendala dengan file kamu?
                                            Silakan hubungi <strong style="color:#10244d;">BAYORA Support</strong>.
                                            Kami akan dengan senang hati membantu.
                                        </div>

                                    </div>

                                    <p style="font-size:14px;line-height:1.8;color:#64748b;margin:0;">
                                        Terima kasih sudah menjadi bagian dari
                                        <strong style="color:#1268ff;">BAYORA</strong> 🤍
                                    </p>

                                    <div style="margin-top:28px;font-size:14px;line-height:1.7;color:#64748b;">
                                        Dengan hangat,<br>
                                        <strong style="color:#10244d;letter-spacing:.5px;">BAYORA</strong>
                                    </div>

                                </div>

                                <!-- FOOTER -->
                                <div style="padding:24px 30px;text-align:center;background:#061a45;">

                                    
<div style="font-size:11px;color:#f5f9ff;line-height:1.7;">
                                        © BAYORA · Lightroom Presets
                                    </div>

                                    <div style="margin-top:6px;font-size:10px;color:#14c9f4;letter-spacing:.4px;">
                                        Create. Edit. Express yourself.
                                    </div>

                                </div>

                            </div>

                        </div>
                    </div>
                `,

            });

        if (result?.error) {
            throw new Error(
                result.error.message ||
                JSON.stringify(result.error)
            );
        }

        db.prepare(`
            UPDATE transactions
            SET
                delivery_status = 'SENT'
            WHERE transaction_id = ?
        `).run(transactionId);

        console.log(
            "[DIGITAL DELIVERY] Email berhasil dikirim:",
            transactionId,
            transaction.customer_email
        );

        console.log(
            "[RESEND EMAIL ID]",
            result?.data?.id ||
            result?.id ||
            "ID TIDAK TERSEDIA"
        );

        console.log(
            "[RESEND EMAIL TO]",
            transaction.customer_email
        );

        console.log(
            "[RESEND EMAIL FROM]",
            fromEmail
        );

        return {
            success: true,
            delivery_status: "SENT",
            email:
                transaction.customer_email
        };

    } catch (error) {

        db.prepare(`
            UPDATE transactions
            SET
                delivery_status = 'FAILED'
            WHERE transaction_id = ?
              AND delivery_status = 'PROCESSING'
        `).run(transactionId);

        console.error(
            "[DIGITAL DELIVERY ERROR]",
            transactionId,
            error.message || error
        );

        throw error;
    }
}


/* =========================
   XENDIT PAYMENT SESSION WEBHOOK
========================= */

app.post("/api/webhooks/xendit", async (req, res) => {

    try {

        /*
         * Verifikasi webhook Xendit menggunakan
         * x-callback-token.
         *
         * Token disimpan di environment variable agar
         * tidak pernah ditulis langsung di source code.
         */
        const callbackToken =
            process.env.XENDIT_WEBHOOK_TOKEN;

        if (!callbackToken) {

            console.error(
                "[XENDIT WEBHOOK] XENDIT_WEBHOOK_TOKEN belum dikonfigurasi."
            );

            return res.status(500).json({
                success: false,
                error:
                    "XENDIT_WEBHOOK_TOKEN belum dikonfigurasi."
            });
        }

        const receivedToken =
            req.headers["x-callback-token"];

        if (
            !receivedToken ||
            receivedToken !== callbackToken
        ) {

            console.warn(
                "[XENDIT WEBHOOK] Callback token tidak valid."
            );

            return res.status(401).json({
                success: false,
                error:
                    "Webhook token tidak valid."
            });
        }

        const event =
            req.body?.event;

        const data =
            req.body?.data || {};

        console.log("=== XENDIT WEBHOOK DEBUG ===");
        console.log({
            event,
            status: data?.status,
            reference_id: data?.reference_id,
            payment_session_id: data?.payment_session_id,
            payment_request_id: data?.payment_request_id
        });

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
                        digiflazz_status,
                        payment_session_id,
                        payment_request_id
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
                    status = 'SUCCESS',
                    payment_status = 'PAID',
                    payment_session_id = COALESCE(
                        ?,
                        payment_session_id
                    ),
                    payment_request_id = COALESCE(
                        ?,
                        payment_request_id
                    ),
                    paid_at = COALESCE(
                        paid_at,
                        ?
                    )
                WHERE transaction_id = ?
            `).run(
                data.payment_session_id || null,
                data.payment_request_id || null,
                new Date().toISOString(),
                transaction.transaction_id
            );

            /*
             * Kirim ke Digiflazz.
             *
             * Fungsi di dalamnya mempunyai claim atomik
             * untuk mencegah double-order.
             */
            let result;

            if (
                transaction.transaction_id.startsWith(
                    "DIGITAL-"
                )
            ) {

                result = {
                    skipped: true,
                    digital: true,
                    reason: "PRODUK_DIGITAL"
                };

                try {

                    const delivery =
                        await sendDigitalProductEmail(
                            transaction.transaction_id
                        );

                    result.delivery =
                        delivery;

                } catch (deliveryError) {

                    console.error(
                        "[DIGITAL DELIVERY WEBHOOK ERROR]",
                        transaction.transaction_id,
                        deliveryError.message ||
                        deliveryError
                    );

                    /*
                     * Pembayaran tetap PAID.
                     * Delivery gagal akan tercatat FAILED
                     * dan bisa diproses ulang tanpa refund.
                     */

                    result.delivery = {
                        success: false,
                        error:
                            deliveryError.message ||
                            "Pengiriman produk digital gagal."
                    };
                }

            } else {

                result =
                    await sendTransactionToDigiflazz(
                        transaction.transaction_id
                    );

            }

            return res.json({
                success: true,
                event,
                transaction_id:
                    transaction.transaction_id,
                digiflazz: result
            });
        }

        /*
         * Webhook hasil refund Xendit.
         *
         * Refund dibuat dengan payment_request_id.
         * Status final datang dari webhook Xendit.
         */
        if (
            event === "refund.succeeded" ||
            event === "refund.failed"
        ) {

            const refund =
                data || {};

            const paymentRequestId =
                refund.payment_request_id ||
                refund.payment_request?.id ||
                null;

            const refundId =
                refund.id ||
                refund.refund_id ||
                null;

            const referenceId =
                refund.reference_id ||
                null;

            if (
                !paymentRequestId &&
                !referenceId
            ) {
                console.warn(
                    "[XENDIT REFUND WEBHOOK] Identifier tidak ditemukan."
                );

                return res.json({
                    success: true,
                    ignored: true,
                    reason:
                        "REFUND_IDENTIFIER_TIDAK_DITEMUKAN"
                });
            }

            let transaction = null;

            if (paymentRequestId) {
                transaction = db.prepare(`
                    SELECT
                        transaction_id,
                        payment_request_id,
                        refund_status
                    FROM transactions
                    WHERE payment_request_id = ?
                `).get(paymentRequestId);
            }

            /*
             * Fallback ke reference_id yang kita buat:
             * REFUND-PPOB-XXXXXXXX
             */
            if (!transaction && referenceId) {

                const transactionId =
                    String(referenceId)
                        .replace(
                            /^REFUND-/i,
                            ""
                        );

                transaction = db.prepare(`
                    SELECT
                        transaction_id,
                        payment_request_id,
                        refund_status
                    FROM transactions
                    WHERE transaction_id = ?
                `).get(transactionId);
            }

            if (!transaction) {

                console.warn(
                    "[XENDIT REFUND WEBHOOK] Transaksi tidak ditemukan.",
                    paymentRequestId || referenceId
                );

                return res.json({
                    success: true,
                    ignored: true,
                    reason:
                        "TRANSAKSI_REFUND_TIDAK_DITEMUKAN"
                });
            }

            const finalRefundStatus =
                event === "refund.succeeded"
                    ? "SUCCESS"
                    : "FAILED";

            db.prepare(`
                UPDATE transactions
                SET
                    refund_status = ?,
                    refund_id = COALESCE(
                        ?,
                        refund_id
                    ),
                    refund_message = ?,
                    refund_processed_at = ?
                WHERE transaction_id = ?
            `).run(
                finalRefundStatus,
                refundId,
                JSON.stringify(refund),
                new Date().toISOString(),
                transaction.transaction_id
            );

            console.log(
                "[XENDIT REFUND WEBHOOK]",
                transaction.transaction_id,
                finalRefundStatus,
                refundId || "-"
            );

            return res.json({
                success: true,
                event,
                transaction_id:
                    transaction.transaction_id,
                refund_status:
                    finalRefundStatus,
                refund_id:
                    refundId
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
                status = ?,
                digiflazz_status = ?,
                digiflazz_ref = COALESCE(
                    ?,
                    digiflazz_ref
                ),
                digiflazz_message = ?,
                digiflazz_rc = COALESCE(
                    ?,
                    digiflazz_rc
                ),
                digiflazz_sn = COALESCE(
                    ?,
                    digiflazz_sn
                ),
                processed_at = ?
            WHERE transaction_id = ?
        `).run(
            finalStatus,
            finalStatus,
            data.ref_id || null,
            String(message),
            data.rc || null,
            data.sn || null,
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

                success_return_url:
                    process.env.PUBLIC_BASE_URL.replace(/\/$/, "") +
                    "/?payment=success&transactionId=" +
                    encodeURIComponent(transactionId),

                cancel_return_url:
                    process.env.PUBLIC_BASE_URL.replace(/\/$/, "") +
                    "/?payment=cancel&transactionId=" +
                    encodeURIComponent(transactionId),

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

        db.prepare(`
            UPDATE transactions
            SET payment_session_id = ?
            WHERE transaction_id = ?
        `).run(
            response.data.payment_session_id,
            transactionId
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




/* ==========================================================
   XENDIT PAYMENT — DIGITAL
   Khusus Lightroom / multi-product.
   Endpoint Xendit PPOB lama tetap tidak disentuh.
========================================================== */

app.post(
    "/api/payments/xendit-digital",
    async (req, res) => {

        try {

            const {
                transactionId,
                customerEmail,
                customerWhatsapp
            } = req.body;


            if (!transactionId) {

                return res.status(400).json({
                    success: false,
                    error: "transactionId wajib diisi."
                });

            }


            const transaction =
                db.prepare(`
                    SELECT
                        transaction_id AS transactionId,
                        reference,
                        service,
                        product_name AS productName,
                        price,
                        payment_status AS paymentStatus
                    FROM transactions
                    WHERE transaction_id = ?
                      AND transaction_id LIKE 'DIGITAL-%'
                    LIMIT 1
                `).get(transactionId);


            if (!transaction) {

                return res.status(404).json({
                    success: false,
                    error: "Transaksi digital tidak ditemukan."
                });

            }


            if (!Number.isFinite(
                Number(transaction.price)
            ) || Number(transaction.price) <= 0) {

                return res.status(400).json({
                    success: false,
                    error: "Total transaksi digital tidak valid."
                });

            }


            if (!process.env.XENDIT_SECRET_KEY) {

                return res.status(500).json({
                    success: false,
                    error:
                        "XENDIT_SECRET_KEY belum tersedia."
                });

            }


            const items =
                db.prepare(`
                    SELECT
                        product_id AS productId,
                        product_name AS productName,
                        price
                    FROM digital_transaction_items
                    WHERE transaction_id = ?
                    ORDER BY id ASC
                `).all(transactionId);


            if (!items.length) {

                return res.status(400).json({
                    success: false,
                    error:
                        "Item produk digital tidak ditemukan."
                });

            }


            const response =
                await axios.post(
                    "https://api.xendit.co/sessions",
                    {
                        reference_id:
                            transaction.reference,

                        session_type:
                            "PAY",

                        mode:
                            "PAYMENT_LINK",

                        amount:
                            Number(transaction.price),

                        currency:
                            "IDR",

                        country:
                            "ID",

                        locale:
                            "id",

                        success_return_url:
                            process.env.PUBLIC_BASE_URL.replace(
                                /\/$/,
                                ""
                            ) +
                            "/?payment=success&transactionId=" +
                            encodeURIComponent(
                                transactionId
                            ),

                        cancel_return_url:
                            process.env.PUBLIC_BASE_URL.replace(
                                /\/$/,
                                ""
                            ) +
                            "/?payment=cancel&transactionId=" +
                            encodeURIComponent(
                                transactionId
                            ),

                        customer: {

                            reference_id:
                                "CUST-" +
                                crypto.randomUUID(),

                            type:
                                "INDIVIDUAL",

                            email:
                                customerEmail ||
                                "customer@example.com",

                            individual_detail: {

                                given_names:
                                    "Pelanggan BAYORA"

                            }

                        }

                    },

                    {
                        auth: {

                            username:
                                process.env.XENDIT_SECRET_KEY,

                            password:
                                ""

                        },

                        headers: {

                            "Content-Type":
                                "application/json"

                        }

                    }

                );


            db.prepare(`
                UPDATE transactions
                SET payment_session_id = ?
                WHERE transaction_id = ?
            `).run(
                response.data.payment_session_id,
                transactionId
            );


            console.log("");
            console.log("==============================");
            console.log("XENDIT DIGITAL PAYMENT");
            console.log({
                transactionId,
                reference:
                    transaction.reference,
                total:
                    transaction.price,
                items:
                    items.length,
                customerEmail:
                    customerEmail || null,
                customerWhatsapp:
                    customerWhatsapp || null
            });
            console.log("==============================");
            console.log("");


            return res.json({

                success:
                    true,

                paymentSessionId:
                    response.data.payment_session_id,

                paymentUrl:
                    response.data.payment_link_url

            });


        } catch (error) {

            console.error(
                "Xendit digital error:",
                error.response?.data ||
                error.message
            );


            return res.status(500).json({

                success:
                    false,

                error:
                    "Gagal membuat pembayaran digital."

            });

        }

    }
);


/* =========================
   DIGITAL PRODUCT DOWNLOAD
========================= */


/*
 * =========================================================
 * BAYORA — EMAIL DOWNLOAD ENDPOINT
 * =========================================================
 *
 * Dipakai oleh tombol download di email.
 * Tidak menggunakan Authorization header karena link email
 * tidak dapat mengirim Bearer header seperti frontend.
 *
 * Token tetap diverifikasi menggunakan helper token yang sama.
 */

app.get(
    "/api/digital-products/email-download/:transactionId",
    (req, res) => {

        try {

            const transactionId =
                String(
                    req.params.transactionId || ""
                ).trim();

            const downloadToken =
                String(
                    req.query.token || ""
                ).trim();

            if (
                !transactionId ||
                !downloadToken ||
                !verifyDigitalDownloadToken(
                    transactionId,
                    downloadToken
                )
            ) {

                return res.status(401).send(
                    "Link download tidak valid atau sudah kedaluwarsa."
                );

            }

            const transaction =
                db.prepare(`
                    SELECT
                        t.transaction_id,
                        t.payment_status,
                        t.service,
                        t.product_name
                    FROM transactions t
                    WHERE t.transaction_id = ?
                    LIMIT 1
                `).get(transactionId);

            if (!transaction) {

                return res.status(404).send(
                    "Transaksi tidak ditemukan."
                );

            }

            if (
                transaction.payment_status !==
                "PAID"
            ) {

                return res.status(403).send(
                    "Pembayaran belum dikonfirmasi."
                );

            }

            if (
                transaction.service !==
                "lightroom-preset"
            ) {

                return res.status(400).send(
                    "Download email ini hanya tersedia untuk Lightroom Preset."
                );

            }

            const item =
                db.prepare(`
                    SELECT
                        digital_file
                    FROM digital_transaction_items
                    WHERE transaction_id = ?
                    ORDER BY id ASC
                    LIMIT 1
                `).get(transactionId);

            if (
                !item ||
                !item.digital_file
            ) {

                return res.status(404).send(
                    "File preset belum tersedia."
                );

            }

            const digitalStorageRoot =
                process.env.NODE_ENV === "production"
                    ? "/data"
                    : path.join(__dirname, "..");

            const relativeFile =
                String(
                    item.digital_file
                )
                .replace(/^\/+/, "");

            const filePath =
                path.resolve(
                    digitalStorageRoot,
                    relativeFile
                );

            const digitalRoot =
                path.resolve(
                    path.join(
                        digitalStorageRoot,
                        "uploads",
                        "digital",
                        "files"
                    )
                );

            if (
                filePath !== digitalRoot &&
                !filePath.startsWith(
                    digitalRoot + path.sep
                )
            ) {

                return res.status(400).send(
                    "Lokasi file tidak valid."
                );

            }

            const safeProductName =
                String(
                    transaction.product_name ||
                    "DIGITAL"
                )
                .trim()
                .replace(/[<>:"/\\|?*]+/g, "")
                .replace(/\s+/g, "-")
                .toUpperCase();

            let downloadFileName =
                "BAYORA-" +
                safeProductName +
                ".zip";

            if (
                !safeProductName.endsWith(
                    "-PRESET"
                )
            ) {

                downloadFileName =
                    "BAYORA-" +
                    safeProductName +
                    "-PRESET.zip";

            }

            return res.download(
                filePath,
                downloadFileName,
                error => {

                    if (error) {

                        console.error(
                            "[EMAIL DIGITAL DOWNLOAD]",
                            error
                        );

                    }

                }
            );

        } catch (error) {

            console.error(
                "[EMAIL DIGITAL DOWNLOAD]",
                error
            );

            return res.status(500).send(
                "Download gagal."
            );

        }

    }
);

app.get(
    "/api/digital-products/download/:transactionId",
    (req, res) => {

        try {

            const downloadToken =
                String(
                    req.headers.authorization || ""
                )
                .replace(/^Bearer\s+/i, "")
                .trim();

            if (
                !downloadToken ||
                !verifyDigitalDownloadToken(
                    String(
                        req.params.transactionId || ""
                    ).trim(),
                    downloadToken
                )
            ) {

                return res.status(401).json({
                    success: false,
                    error:
                        "Akses download tidak valid atau sudah kedaluwarsa."
                });

            }

            const transactionId =
                String(
                    req.params.transactionId || ""
                ).trim();

            if (!transactionId) {

                return res.status(400).json({
                    success: false,
                    error: "ID transaksi tidak valid."
                });

            }

            const transaction =
                db.prepare(`
                    SELECT
                        t.transaction_id,
                        t.user_id,
                        t.payment_status,
                        t.product_id,
                        t.product_name,
                        t.service,
                        p.service_id
                    FROM transactions t
                    LEFT JOIN products p
                        ON p.id = t.product_id
                    WHERE t.transaction_id = ?
                    LIMIT 1
                `).get(transactionId);

            if (!transaction) {

                return res.status(404).json({
                    success: false,
                    error: "Transaksi tidak ditemukan."
                });

            }

            if (
                transaction.payment_status !==
                "PAID"
            ) {

                return res.status(403).json({
                    success: false,
                    error:
                        "Pembayaran belum dikonfirmasi."
                });

            }

            const items =
                db.prepare(`
                    SELECT
                        product_id,
                        product_name,
                        digital_file
                    FROM digital_transaction_items
                    WHERE transaction_id = ?
                    ORDER BY id ASC
                `).all(transactionId);

            if (!items.length) {

                return res.status(404).json({
                    success: false,
                    error:
                        "File preset transaksi tidak ditemukan."
                });

            }

            const digitalStorageRoot =
                process.env.NODE_ENV === "production"
                    ? "/data"
                    : path.join(__dirname, "..");

            const digitalRoot =
                path.resolve(
                    path.join(
                        digitalStorageRoot,
                        "uploads",
                        "digital",
                        "files"
                    )
                );

            const files = [];

            for (const item of items) {

                if (!item.digital_file) {
                    continue;
                }

                const relativeFile =
                    String(
                        item.digital_file
                    )
                    .replace(/^\/+/, "");

                const filePath =
                    path.resolve(
                        digitalStorageRoot,
                        relativeFile
                    );

                if (
                    filePath === digitalRoot ||
                    !filePath.startsWith(
                        digitalRoot + path.sep
                    )
                ) {

                    console.error(
                        "[DIGITAL DOWNLOAD] Path tidak aman:",
                        item.digital_file
                    );

                    return res.status(400).json({
                        success: false,
                        error:
                            "Lokasi file digital tidak valid."
                    });

                }

                if (!fs.existsSync(filePath)) {

                    console.error(
                        "[DIGITAL DOWNLOAD] File tidak ditemukan:",
                        filePath
                    );

                    continue;
                }

                files.push({
                    path: filePath,
                    name:
                        item.product_name ||
                        "Preset"
                });

            }

            if (!files.length) {

                return res.status(404).json({
                    success: false,
                    error:
                        "File preset belum tersedia."
                });

            }

            /*
             * Jika hanya satu preset,
             * kirim ZIP asli secara langsung.
             */
            if (files.length === 1) {

                /*
                 * =================================================
                 * BAYORA — LIGHTROOM PRESET DOWNLOAD NAME
                 * =================================================
                 *
                 * Khusus service lightroom-preset.
                 * Layanan digital lainnya tetap memakai
                 * nama file lama.
                 */

                let downloadFileName =
                    files[0].name + ".zip";

                if (
                    transaction.service ===
                    "lightroom-preset"
                ) {

                    const safeProductName =
                        String(
                            transaction.product_name ||
                            files[0].name ||
                            "DIGITAL"
                        )
                        .trim()
                        .replace(/[<>:"/\\|?*]+/g, "")
                        .replace(/\s+/g, "-")
                        .toUpperCase();

                    downloadFileName =
                        "BAYORA-PRESET-" +
                        safeProductName +
                        ".zip";

                }

                return res.download(
                    files[0].path,
                    downloadFileName,
                    error => {

                        if (error) {

                            console.error(
                                "[DIGITAL DOWNLOAD]",
                                error
                            );

                        }

                    }
                );

            }

            /*
             * Multi-produk:
             * gabungkan seluruh ZIP menjadi satu ZIP.
             */
            const archiver =
                require("archiver");

            const safeName =
                String(
                    transaction.product_name ||
                    "BAYORA Presets"
                )
                .replace(
                    /[^a-zA-Z0-9._ -]/g,
                    ""
                )
                .trim() ||
                "BAYORA Presets";

            res.attachment(
                safeName + ".zip"
            );

            const archive =
                archiver("zip", {
                    zlib: {
                        level: 9
                    }
                });

            archive.on(
                "error",
                error => {

                    console.error(
                        "[DIGITAL DOWNLOAD ARCHIVE]",
                        error
                    );

                    if (!res.headersSent) {

                        res.status(500).json({
                            success: false,
                            error:
                                "Gagal membuat file ZIP."
                        });

                    } else {

                        res.end();

                    }

                }
            );

            archive.pipe(res);

            for (const file of files) {

                archive.file(
                    file.path,
                    {
                        name:
                            path.basename(
                                file.path
                            )
                    }
                );

            }

            archive.finalize();

        } catch (error) {

            console.error(
                "[DIGITAL DOWNLOAD ERROR]",
                error
            );

            if (!res.headersSent) {

                return res.status(500).json({
                    success: false,
                    error:
                        "Gagal menyediakan file digital."
                });

            }

        }

    }
);


/* =========================
   DIGITAL PRODUCT GUIDE DOWNLOAD
========================= */

/*
 * =========================================================
 * BAYORA — EMAIL GUIDE DOWNLOAD ENDPOINT
 * =========================================================
 *
 * Secure download panduan dari email.
 * Token menggunakan digital_download_tokens yang sama.
 */

app.get(
    "/api/digital-products/email-guide-download/:transactionId",
    (req, res) => {

        try {

            const transactionId =
                String(
                    req.params.transactionId || ""
                ).trim();

            const downloadToken =
                String(
                    req.query.token || ""
                ).trim();

            if (
                !transactionId ||
                !downloadToken ||
                !verifyDigitalDownloadToken(
                    transactionId,
                    downloadToken
                )
            ) {

                return res.status(401).send(
                    "Link download tidak valid atau sudah kedaluwarsa."
                );

            }

            const transaction =
                db.prepare(`
                    SELECT
                        t.transaction_id,
                        t.payment_status,
                        t.service,
                        t.device,
                        t.product_name
                    FROM transactions t
                    WHERE t.transaction_id = ?
                    LIMIT 1
                `).get(transactionId);

            if (!transaction) {

                return res.status(404).send(
                    "Transaksi tidak ditemukan."
                );

            }

            if (
                transaction.payment_status !==
                "PAID"
            ) {

                return res.status(403).send(
                    "Pembayaran belum dikonfirmasi."
                );

            }

            if (
                transaction.service !==
                "lightroom-preset"
            ) {

                return res.status(400).send(
                    "Download panduan ini hanya tersedia untuk Lightroom Preset."
                );

            }

            const item =
                db.prepare(`
                    SELECT
                        device_file
                    FROM digital_transaction_items
                    WHERE transaction_id = ?
                    ORDER BY id ASC
                    LIMIT 1
                `).get(transactionId);

            if (
                !item ||
                !item.device_file
            ) {

                return res.status(404).send(
                    "File panduan belum tersedia."
                );

            }

            const digitalStorageRoot =
                process.env.NODE_ENV === "production"
                    ? "/data"
                    : path.join(__dirname, "..");

            const relativeFile =
                String(
                    item.device_file
                )
                .replace(/^\/+/, "");

            const filePath =
                path.resolve(
                    digitalStorageRoot,
                    relativeFile
                );

            const digitalRoot =
                path.resolve(
                    path.join(
                        digitalStorageRoot,
                        "uploads",
                        "digital",
                        "files"
                    )
                );

            if (
                filePath === digitalRoot ||
                !filePath.startsWith(
                    digitalRoot + path.sep
                )
            ) {

                return res.status(400).send(
                    "Lokasi file panduan tidak valid."
                );

            }

            if (!fs.existsSync(filePath)) {

                return res.status(404).send(
                    "File panduan belum tersedia."
                );

            }

            let deviceName =
                String(
                    transaction.device || ""
                )
                .trim()
                .toLowerCase();

            if (deviceName === "ios") {
                deviceName = "IOS";
            } else if (
                deviceName === "android"
            ) {
                deviceName = "ANDROID";
            } else if (
                deviceName === "macos" ||
                deviceName === "mac"
            ) {
                deviceName = "MACOS";
            } else if (
                deviceName === "windows"
            ) {
                deviceName = "WINDOWS";
            } else {
                deviceName = "DEVICE";
            }

            const downloadFileName =
                "BAYORA-" +
                deviceName +
                "-PANDUAN.pdf";

            return res.download(
                filePath,
                downloadFileName,
                error => {

                    if (error) {

                        console.error(
                            "[EMAIL GUIDE DOWNLOAD]",
                            error
                        );

                    }

                }
            );

        } catch (error) {

            console.error(
                "[EMAIL GUIDE DOWNLOAD]",
                error
            );

            return res.status(500).send(
                "Download panduan gagal."
            );

        }

    }
);


app.get(
    "/api/digital-products/download-guide/:transactionId",
    (req, res) => {

        try {

            const downloadToken =
                String(
                    req.headers.authorization || ""
                )
                .replace(/^Bearer\s+/i, "")
                .trim();

            if (
                !downloadToken ||
                !verifyDigitalDownloadToken(
                    String(
                        req.params.transactionId || ""
                    ).trim(),
                    downloadToken
                )
            ) {

                return res.status(401).json({
                    success: false,
                    error:
                        "Akses download tidak valid atau sudah kedaluwarsa."
                });

            }

            const transactionId =
                String(
                    req.params.transactionId || ""
                ).trim();

            if (!transactionId) {

                return res.status(400).json({
                    success: false,
                    error: "ID transaksi tidak valid."
                });

            }

            const transaction =
                db.prepare(`
                    SELECT
                        t.transaction_id,
                        t.user_id,
                        t.payment_status,
                        t.product_id,
                        t.service,
                        t.device,
                        p.name AS product_name,
                        p.product_type,
                        p.service_id
                    FROM transactions t
                    LEFT JOIN products p
                        ON p.id = t.product_id
                    WHERE t.transaction_id = ?
                    LIMIT 1
                `).get(transactionId);

            if (!transaction) {

                return res.status(404).json({
                    success: false,
                    error: "Transaksi tidak ditemukan."
                });

            }

            if (
                transaction.payment_status !==
                "PAID"
            ) {

                return res.status(403).json({
                    success: false,
                    error: "Pembayaran belum dikonfirmasi."
                });

            }

            if (
                transaction.product_type !==
                "digital"
            ) {

                return res.status(400).json({
                    success: false,
                    error: "Transaksi ini bukan produk digital."
                });

            }

            const item =
                db.prepare(`
                    SELECT
                        device_file
                    FROM digital_transaction_items
                    WHERE transaction_id = ?
                    LIMIT 1
                `).get(transactionId);

            if (!item || !item.device_file) {

                return res.status(404).json({
                    success: false,
                    error: "Panduan penggunaan belum tersedia."
                });

            }

            const digitalStorageRoot =
                process.env.NODE_ENV === "production"
                    ? "/data"
                    : path.join(__dirname, "..");

            const relativeFile =
                String(
                    item.device_file
                )
                .replace(/^\/+/, "");

            const filePath =
                path.resolve(
                    digitalStorageRoot,
                    relativeFile
                );

            const digitalRoot =
                path.resolve(
                    path.join(
                        digitalStorageRoot,
                        "uploads",
                        "digital",
                        "files"
                    )
                );

            if (
                filePath !== digitalRoot &&
                !filePath.startsWith(
                    digitalRoot + path.sep
                )
            ) {

                console.error(
                    "[DIGITAL GUIDE DOWNLOAD] Path tidak aman:",
                    item.device_file
                );

                return res.status(400).json({
                    success: false,
                    error: "Lokasi file panduan tidak valid."
                });

            }

            /*
             * =================================================
             * BAYORA — LIGHTROOM GUIDE DOWNLOAD NAME
             * =================================================
             *
             * Khusus service lightroom-preset.
             * Nama perangkat ditentukan dari file panduan
             * yang dipilih saat transaksi.
             */

            let guideDownloadName =
                transaction.product_name +
                " - Panduan.pdf";

            if (
                transaction.service_id ===
                "lightroom-preset"
            ) {

                const device =
                    String(
                        transaction.device || ""
                    )
                    .trim()
                    .toLowerCase();

                let deviceName = "DEVICE";

                if (device === "ios") {

                    deviceName = "IOS";

                } else if (
                    device === "android"
                ) {

                    deviceName = "ANDROID";

                } else if (
                    device === "macos" ||
                    device === "mac"
                ) {

                    deviceName = "MACOS";

                } else if (
                    device === "windows"
                ) {

                    deviceName = "WINDOWS";

                }

                guideDownloadName =
                    "BAYORA-PANDUAN-" +
                    deviceName +
                    ".pdf";

            }

            return res.download(
                filePath,
                guideDownloadName,
                error => {

                    if (error) {

                        console.error(
                            "[DIGITAL GUIDE DOWNLOAD]",
                            error
                        );

                    }

                }
            );

        } catch (error) {

            console.error(
                "[DIGITAL GUIDE DOWNLOAD ERROR]",
                error
            );

            return res.status(500).json({
                success: false,
                error: "Gagal menyediakan file panduan."
            });

        }

    }
);


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
                created_at,
                type
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
                mood,
                active,
                sort_order,
                created_at,
                product_type,
                preview_image,
                digital_file,
                before_image,
                after_image,
                gallery_images
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

app.post("/api/services", requireCatalogManager, (req, res) => {

    try {

        const {
            id,
            title,
            icon,
            description,
            label,
            placeholder,
            active,
            sort_order,
            type
        } = req.body;

        const serviceType =
            type === "digital"
                ? "digital"
                : "ppob";

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
                type,
                created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
            serviceType,
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
   DUPLICATE DIGITAL SERVICE
========================= */

app.post("/api/services/:id/duplicate", requireCatalogManager, (req, res) => {

    try {

        const sourceId =
            String(req.params.id || "").trim();

        if (!sourceId) {
            return res.status(400).json({
                success: false,
                error: "ID layanan tidak valid."
            });
        }

        const source =
            db.prepare(`
                SELECT *
                FROM services
                WHERE id = ?
            `).get(sourceId);

        if (!source) {
            return res.status(404).json({
                success: false,
                error: "Layanan tidak ditemukan."
            });
        }

        /*
         * PPOB tidak boleh diduplikat.
         * Katalog PPOB berasal dari sinkronisasi Digiflazz.
         */
        if (source.type !== "digital") {
            return res.status(400).json({
                success: false,
                error: "Layanan PPOB tidak dapat diduplikat."
            });
        }

        /*
         * Buat ID layanan digital baru yang unik.
         */
        const baseServiceId =
            `${source.id}-copy`;

        let newServiceId =
            baseServiceId;

        let serviceCounter = 2;

        while (
            db.prepare(`
                SELECT 1
                FROM services
                WHERE id = ?
            `).get(newServiceId)
        ) {
            newServiceId =
                `${baseServiceId}-${serviceCounter}`;

            serviceCounter++;
        }

        /*
         * Ambil produk digital dari layanan asli.
         */
        const sourceProducts =
            db.prepare(`
                SELECT *
                FROM products
                WHERE service_id = ?
                  AND product_type = 'digital'
                ORDER BY sort_order ASC, name ASC
            `).all(sourceId);

        /*
         * Satu transaksi database:
         * layanan + seluruh produk digital.
         */
        db.transaction(() => {

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
                    type,
                    created_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                newServiceId,
                `${source.title} Copy`,
                source.icon,
                source.description,
                source.label,
                source.placeholder,
                source.active,
                source.sort_order,
                "digital",
                catalogNow()
            );

            const insertProduct =
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
                        created_at,
                        cost_price,
                        margin,
                        digiflazz_sku,
                        product_type,
                        preview_image,
                        digital_file,
                        before_image,
                        after_image,
                        gallery_images,
                        mood,
                        pdf_ios,
                        pdf_android,
                        pdf_mac,
                        pdf_windows
                    )
                    VALUES (
                        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
                    )
                `);

            for (const product of sourceProducts) {

                const baseProductId =
                    `${product.id}-copy`;

                let newProductId =
                    baseProductId;

                let productCounter = 2;

                while (
                    db.prepare(`
                        SELECT 1
                        FROM products
                        WHERE id = ?
                    `).get(newProductId)
                ) {
                    newProductId =
                        `${baseProductId}-${productCounter}`;

                    productCounter++;
                }

                insertProduct.run(
                    newProductId,
                    newServiceId,
                    product.operator,
                    product.name,
                    product.price,
                    product.info,
                    product.active,
                    product.sort_order,
                    catalogNow(),
                    product.cost_price,
                    product.margin,
                    product.digiflazz_sku,
                    product.product_type,
                    product.preview_image,
                    product.digital_file,
                    product.before_image,
                    product.after_image,
                    product.gallery_images,
                    product.mood,
                    product.pdf_ios,
                    product.pdf_android,
                    product.pdf_mac,
                    product.pdf_windows
                );

            }

        })();

        const service =
            db.prepare(`
                SELECT *
                FROM services
                WHERE id = ?
            `).get(newServiceId);

        const products =
            db.prepare(`
                SELECT *
                FROM products
                WHERE service_id = ?
                ORDER BY sort_order ASC, name ASC
            `).all(newServiceId);

        return res.status(201).json({
            success: true,
            service,
            products
        });

    } catch (error) {

        console.error(
            "[DUPLICATE DIGITAL SERVICE]",
            error
        );

        return res.status(500).json({
            success: false,
            error: "Gagal menduplikat layanan digital."
        });

    }

});


/* =========================
   UPDATE SERVICE
========================= */

app.put("/api/services/:id", requireCatalogManager, (req, res) => {

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
            sort_order,
            type
        } = req.body;

        const serviceType =
            type === undefined
                ? existing.type || "ppob"
                : type === "digital"
                    ? "digital"
                    : "ppob";

        db.prepare(`
            UPDATE services
            SET
                title = ?,
                icon = ?,
                description = ?,
                label = ?,
                placeholder = ?,
                active = ?,
                sort_order = ?,
                type = ?
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

            serviceType,

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

app.delete("/api/services/:id", requireCatalogManager, (req, res) => {

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

app.post("/api/products", requireCatalogManager, (req, res) => {

    try {

        const {
            id,
            service_id,
            operator,
            name,
            price,
            info,
            mood,
            active,
            sort_order,
            product_type,
            preview_image,
            digital_file,
            before_image,
            after_image,
            gallery_images,
            pdf_ios,
            pdf_android,
            pdf_mac,
            pdf_windows
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
                mood,
                active,
                sort_order,
                created_at,
                product_type,
                preview_image,
                digital_file,
                before_image,
                after_image,
                gallery_images,
                pdf_ios,
                pdf_android,
                pdf_mac,
                pdf_windows
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            productId,
            service_id,
            operator || null,
            String(name).trim(),
            numericPrice,
            info || "",
            mood || "",
            active === false ? 0 : 1,
            Number.isFinite(Number(sort_order))
                ? Number(sort_order)
                : 0,
            catalogNow(),
            product_type === "digital"
                ? "digital"
                : "ppob",
            preview_image || null,
            digital_file || null,
            before_image || null,
            after_image || null,
            gallery_images || null,
            pdf_ios || null,
            pdf_android || null,
            pdf_mac || null,
            pdf_windows || null
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
   DUPLICATE PRODUCT
========================= */

app.post("/api/products/:id/duplicate", requireCatalogManager, (req, res) => {

    try {

        const sourceId =
            String(req.params.id || "").trim();

        if (!sourceId) {
            return res.status(400).json({
                success: false,
                error: "ID produk tidak valid."
            });
        }

        const source =
            db.prepare(`
                SELECT *
                FROM products
                WHERE id = ?
            `).get(sourceId);

        if (!source) {
            return res.status(404).json({
                success: false,
                error: "Produk tidak ditemukan."
            });
        }

        /*
         * Buat ID baru yang unik.
         * Seluruh data produk asli tetap dipertahankan.
         */
        const baseId =
            `${source.id}-copy`;

        let newId =
            baseId;

        let counter = 2;

        while (
            db.prepare(`
                SELECT 1
                FROM products
                WHERE id = ?
            `).get(newId)
        ) {
            newId =
                `${baseId}-${counter}`;

            counter++;
        }

        const columns =
            Object.keys(source)
                .filter(column =>
                    column !== "id" &&
                    column !== "created_at"
                );

        const values =
            columns.map(column =>
                source[column]
            );

        const placeholders =
            columns.map(() => "?").join(", ");

        const insert =
            db.prepare(`
                INSERT INTO products (
                    id,
                    ${columns.join(", ")},
                    created_at
                )
                VALUES (
                    ?,
                    ${placeholders},
                    ?
                )
            `);

        insert.run(
            newId,
            ...values,
            catalogNow()
        );

        const product =
            db.prepare(`
                SELECT *
                FROM products
                WHERE id = ?
            `).get(newId);

        return res.status(201).json({
            success: true,
            message: "Produk berhasil diduplikat.",
            product
        });

    } catch (error) {

        console.error(
            "[DUPLICATE PRODUCT]",
            error
        );

        return res.status(500).json({
            success: false,
            error: "Gagal menduplikat produk."
        });

    }

});


/* =========================
   UPDATE PRODUCT
========================= */

app.put("/api/products/:id", requireCatalogManager, (req, res) => {

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
            mood,
            active,
            sort_order,
            product_type,
            preview_image,
            digital_file,
            before_image,
            after_image,
            gallery_images,
            pdf_ios,
            pdf_android,
            pdf_mac,
            pdf_windows
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

        console.log("=== PRODUCT UPDATE PDF DEBUG ===");
        console.log({
            productId,
            pdf_ios,
            pdf_android,
            pdf_mac,
            pdf_windows,
            existingPdfIos: existing.pdf_ios,
            existingPdfAndroid: existing.pdf_android,
            existingPdfMac: existing.pdf_mac,
            existingPdfWindows: existing.pdf_windows
        });

        db.prepare(`
            UPDATE products
            SET
                service_id = ?,
                operator = ?,
                name = ?,
                price = ?,
                info = ?,
                mood = ?,
                active = ?,
                sort_order = ?,
                product_type = ?,
                preview_image = ?,
                digital_file = ?,
                before_image = ?,
                after_image = ?,
                gallery_images = ?,
                pdf_ios = ?,
                pdf_android = ?,
                pdf_mac = ?,
                pdf_windows = ?
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

            mood === undefined
                ? (existing.mood || "")
                : mood,

            active === undefined
                ? existing.active
                : active ? 1 : 0,

            sort_order === undefined
                ? existing.sort_order
                : Number(sort_order),

            product_type === undefined
                ? existing.product_type
                : product_type === "digital"
                    ? "digital"
                    : "ppob",

            preview_image === undefined
                ? existing.preview_image
                : preview_image || null,

            digital_file === undefined
                ? existing.digital_file
                : digital_file || null,

            before_image === undefined
                ? existing.before_image
                : before_image || null,

            after_image === undefined
                ? existing.after_image
                : after_image || null,

            gallery_images === undefined
                ? existing.gallery_images
                : gallery_images || null,

            pdf_ios === undefined
                ? existing.pdf_ios
                : pdf_ios || null,

            pdf_android === undefined
                ? existing.pdf_android
                : pdf_android || null,

            pdf_mac === undefined
                ? existing.pdf_mac
                : pdf_mac || null,

            pdf_windows === undefined
                ? existing.pdf_windows
                : pdf_windows || null,

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

app.delete("/api/products/:id", requireCatalogManager, (req, res) => {

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



/* ==========================================================
   ADMIN AUTH HELPERS
========================================================== */

const ADMIN_SESSION_DAYS = 7;

function hashAdminPassword(password) {
    const salt = crypto.randomBytes(16).toString("hex");

    const hash = crypto
        .scryptSync(password, salt, 64)
        .toString("hex");

    return `${salt}:${hash}`;
}

function verifyAdminPassword(password, stored) {
    try {
        const parts = String(stored || "").split(":");

        if (parts.length !== 2) {
            return false;
        }

        const salt = parts[0];
        const storedHash = Buffer.from(parts[1], "hex");

        const derivedHash = crypto.scryptSync(
            password,
            salt,
            64
        );

        return (
            storedHash.length === derivedHash.length &&
            crypto.timingSafeEqual(
                storedHash,
                derivedHash
            )
        );

    } catch {
        return false;
    }
}

function hashAdminSessionToken(token) {
    return crypto
        .createHash("sha256")
        .update(token)
        .digest("hex");
}

function getAdminSessionToken(req) {

    const header = req.headers.cookie || "";

    const match = header.match(
        /(?:^|;\s*)bayora_admin_session=([^;]+)/
    );

    return match
        ? decodeURIComponent(match[1])
        : null;
}

function createAdminSession(adminId) {

    const token = crypto
        .randomBytes(32)
        .toString("hex");

    const tokenHash =
        hashAdminSessionToken(token);

    const now = new Date();

    const expires = new Date(
        now.getTime() +
        ADMIN_SESSION_DAYS *
        24 *
        60 *
        60 *
        1000
    );

    db.prepare(`
        INSERT INTO admin_sessions (
            admin_id,
            token_hash,
            expires_at,
            created_at
        )
        VALUES (?, ?, ?, ?)
    `).run(
        adminId,
        tokenHash,
        expires.toISOString(),
        now.toISOString()
    );

    return token;
}

function getCurrentAdmin(req) {

    const token = getAdminSessionToken(req);

    if (!token) {
        return null;
    }

    const tokenHash =
        hashAdminSessionToken(token);

    const session = db.prepare(`
        SELECT
            s.id AS session_id,
            s.expires_at,
            a.id,
            a.username,
            a.name,
            a.role,
            a.active
        FROM admin_sessions s
        JOIN admins a
            ON a.id = s.admin_id
        WHERE s.token_hash = ?
        LIMIT 1
    `).get(tokenHash);

    if (!session) {
        return null;
    }

    if (
        !session.active ||
        new Date(session.expires_at).getTime() <= Date.now()
    ) {

        db.prepare(`
            DELETE FROM admin_sessions
            WHERE id = ?
        `).run(session.session_id);

        return null;
    }

    return {
        id: session.id,
        username: session.username,
        name: session.name,
        role: session.role,
        session_id: session.session_id
    };
}

function requireAdmin(req, res, next) {

    const admin = getCurrentAdmin(req);

    if (!admin) {
        return res.status(401).json({
            success: false,
            authenticated: false,
            error: "Admin belum login."
        });
    }

    req.admin = admin;

    next();
}

function requireOwner(req, res, next) {

    const admin = getCurrentAdmin(req);

    if (!admin) {
        return res.status(401).json({
            success: false,
            authenticated: false,
            error: "Admin belum login."
        });
    }

    if (admin.role !== "owner") {
        return res.status(403).json({
            success: false,
            error: "Akses khusus Owner."
        });
    }

    req.admin = admin;

    next();
}


/* ==========================================================
   DEFAULT OWNER
========================================================== */

const existingOwner = db.prepare(`
    SELECT id
    FROM admins
    WHERE role = 'owner'
    LIMIT 1
`).get();

if (!existingOwner) {

    const envPassword =
        process.env.ADMIN_PASSWORD;

    if (envPassword) {

        const now =
            new Date().toISOString();

        const existingAdmin =
            db.prepare(`
                SELECT id
                FROM admins
                WHERE username = 'admin'
                LIMIT 1
            `).get();

        if (!existingAdmin) {

            db.prepare(`
                INSERT INTO admins (
                    username,
                    name,
                    password_hash,
                    role,
                    active,
                    created_at,
                    updated_at
                )
                VALUES (?, ?, ?, 'owner', 1, ?, ?)
            `).run(
                "admin",
                "BAYORA Owner",
                hashAdminPassword(
                    envPassword
                ),
                now,
                now
            );

            console.log(
                "[ADMIN] Default Owner dibuat dari ADMIN_PASSWORD."
            );
        }
    }
}


/* ==========================================================
   ADMIN LOGIN
========================================================== */

app.post(
    "/api/admin/login",
    (req, res) => {

        try {

            const {
                username,
                password
            } = req.body;

            if (
                typeof username !== "string" ||
                typeof password !== "string"
            ) {
                return res.status(400).json({
                    success: false,
                    error: "Username dan password wajib diisi."
                });
            }

            const admin = db.prepare(`
                SELECT
                    id,
                    username,
                    name,
                    password_hash,
                    role,
                    active
                FROM admins
                WHERE username = ?
                LIMIT 1
            `).get(username.trim());

            if (
                !admin ||
                !admin.active ||
                !verifyAdminPassword(
                    password,
                    admin.password_hash
                )
            ) {

                return res.status(401).json({
                    success: false,
                    error: "Username atau password salah."
                });
            }

            const token =
                createAdminSession(admin.id);

            res.setHeader(
                "Set-Cookie",
                [
                    `bayora_admin_session=${encodeURIComponent(token)}`,
                    "Path=/",
                    "HttpOnly",
                    "SameSite=Lax",
                    "Max-Age=604800"
                ].join("; ")
            );

            return res.json({
                success: true,
                message: "Login admin berhasil.",
                admin: {
                    id: admin.id,
                    username: admin.username,
                    name: admin.name,
                    role: admin.role
                }
            });

        } catch (error) {

            console.error("[ADMIN LOGIN]", error);

            return res.status(500).json({
                success: false,
                error: "Terjadi kesalahan pada server."
            });
        }
    }
);


/* ==========================================================
   ADMIN CURRENT SESSION
========================================================== */

app.get(
    "/api/admin/me",
    requireAdmin,
    (req, res) => {

        return res.json({
            success: true,
            authenticated: true,
            admin: {
                id: req.admin.id,
                username: req.admin.username,
                name: req.admin.name,
                role: req.admin.role
            }
        });
    }
);


/* ==========================================================
   ADMIN CHANGE OWN PASSWORD
========================================================== */

app.post(
    "/api/admin/change-password",
    requireAdmin,
    (req, res) => {

        try {

            const currentPassword =
                String(req.body.currentPassword || "");

            const newPassword =
                String(req.body.newPassword || "");

            const confirmPassword =
                String(req.body.confirmPassword || "");

            if (
                !currentPassword ||
                !newPassword ||
                !confirmPassword
            ) {
                return res.status(400).json({
                    success: false,
                    error: "Semua password wajib diisi."
                });
            }

            if (newPassword.length < 8) {
                return res.status(400).json({
                    success: false,
                    error: "Password baru minimal 8 karakter."
                });
            }

            if (newPassword !== confirmPassword) {
                return res.status(400).json({
                    success: false,
                    error: "Konfirmasi password tidak cocok."
                });
            }

            const admin = db.prepare(`
                SELECT id, password_hash
                FROM admins
                WHERE id = ?
                LIMIT 1
            `).get(req.admin.id);

            if (!admin) {
                return res.status(404).json({
                    success: false,
                    error: "Akun admin tidak ditemukan."
                });
            }

            if (
                !verifyAdminPassword(
                    currentPassword,
                    admin.password_hash
                )
            ) {
                return res.status(401).json({
                    success: false,
                    error: "Password saat ini salah."
                });
            }

            const passwordHash =
                hashAdminPassword(newPassword);

            const result = db.prepare(`
                UPDATE admins
                SET password_hash = ?,
                    updated_at = ?
                WHERE id = ?
            `).run(
                passwordHash,
                new Date().toISOString(),
                req.admin.id
            );

            if (result.changes !== 1) {
                return res.status(500).json({
                    success: false,
                    error: "Password gagal diperbarui."
                });
            }

            return res.json({
                success: true,
                message: "Password berhasil diperbarui."
            });

        } catch (error) {

            console.error(
                "[ADMIN CHANGE PASSWORD]",
                error
            );

            return res.status(500).json({
                success: false,
                error: "Terjadi kesalahan pada server."
            });
        }
    }
);


/* ==========================================================
   ADMIN LOGOUT
========================================================== */

app.post(
    "/api/admin/logout",
    (req, res) => {

        try {

            const token =
                getAdminSessionToken(req);

            if (token) {

                const tokenHash =
                    hashAdminSessionToken(token);

                db.prepare(`
                    DELETE FROM admin_sessions
                    WHERE token_hash = ?
                `).run(tokenHash);
            }

            res.setHeader(
                "Set-Cookie",
                [
                    "bayora_admin_session=",
                    "Path=/",
                    "HttpOnly",
                    "SameSite=Lax",
                    "Max-Age=0"
                ].join("; ")
            );

            return res.json({
                success: true,
                message: "Logout admin berhasil."
            });

        } catch (error) {

            console.error("[ADMIN LOGOUT]", error);

            return res.status(500).json({
                success: false,
                error: "Gagal melakukan logout."
            });
        }
    }
);


/* ==========================================================
   ADMIN MANAGEMENT — OWNER ONLY
========================================================== */

app.get(
    "/api/admin/admins",
    requireOwner,
    (req, res) => {

        const admins = db.prepare(`
            SELECT
                id,
                username,
                name,
                role,
                active,
                created_at,
                updated_at
            FROM admins
            ORDER BY id ASC
        `).all();

        return res.json({
            success: true,
            admins
        });
    }
);


app.post(
    "/api/admin/admins",
    requireOwner,
    (req, res) => {

        try {

            const {
                username,
                name,
                password,
                role = "admin"
            } = req.body;

            if (
                !username ||
                !name ||
                !password
            ) {
                return res.status(400).json({
                    success: false,
                    error: "Username, nama, dan password wajib diisi."
                });
            }

            if (
                !["owner", "admin", "support"].includes(role)
            ) {
                return res.status(400).json({
                    success: false,
                    error: "Role tidak valid."
                });
            }

            if (String(password).length < 8) {
                return res.status(400).json({
                    success: false,
                    error: "Password minimal 8 karakter."
                });
            }

            const now =
                new Date().toISOString();

            const passwordHash =
                hashAdminPassword(password);

            const result = db.prepare(`
                INSERT INTO admins (
                    username,
                    name,
                    password_hash,
                    role,
                    active,
                    created_at,
                    updated_at
                )
                VALUES (?, ?, ?, ?, 1, ?, ?)
            `).run(
                username.trim(),
                name.trim(),
                passwordHash,
                role,
                now,
                now
            );

            return res.json({
                success: true,
                message: "Admin berhasil ditambahkan.",
                id: result.lastInsertRowid
            });

        } catch (error) {

            if (
                String(error.message || "")
                    .includes("UNIQUE")
            ) {
                return res.status(409).json({
                    success: false,
                    error: "Username admin sudah digunakan."
                });
            }

            console.error(
                "[ADMIN CREATE]",
                error
            );

            return res.status(500).json({
                success: false,
                error: "Gagal menambahkan admin."
            });
        }
    }
);


app.patch(
    "/api/admin/admins/:id/password",
    requireOwner,
    (req, res) => {

        try {

            const id =
                Number(req.params.id);

            const password =
                String(
                    req.body.password || ""
                );

            if (!Number.isInteger(id)) {

                return res.status(400).json({
                    success: false,
                    error: "ID admin tidak valid."
                });

            }

            if (password.length < 8) {

                return res.status(400).json({
                    success: false,
                    error: "Password minimal 8 karakter."
                });

            }

            const admin =
                db.prepare(`
                    SELECT
                        id,
                        username,
                        name,
                        role
                    FROM admins
                    WHERE id = ?
                `).get(id);

            if (!admin) {

                return res.status(404).json({
                    success: false,
                    error: "Admin tidak ditemukan."
                });

            }

            /*
             * Password baru selalu di-hash dengan
             * mekanisme yang sama dengan password login.
             */

            const passwordHash =
                hashAdminPassword(password);

            const now =
                new Date().toISOString();

            const result =
                db.prepare(`
                    UPDATE admins
                    SET password_hash = ?,
                        updated_at = ?
                    WHERE id = ?
                `).run(
                    passwordHash,
                    now,
                    id
                );

            if (!result.changes) {

                return res.status(500).json({
                    success: false,
                    error: "Password gagal diperbarui."
                });

            }

            /*
             * Cabut semua session admin tersebut.
             * Jika Owner mereset password admin lain,
             * session Owner sendiri tidak terpengaruh.
             */

            db.prepare(`
                DELETE FROM admin_sessions
                WHERE admin_id = ?
            `).run(id);

            return res.json({
                success: true,
                message:
                    `Password admin "${admin.username}" berhasil direset.`
            });

        } catch (error) {

            console.error(
                "[ADMIN PASSWORD RESET]",
                error
            );

            return res.status(500).json({
                success: false,
                error: "Gagal mereset password admin."
            });

        }

    }
);



app.patch(
    "/api/admin/admins/:id/status",
    requireOwner,
    (req, res) => {

        const id =
            Number(req.params.id);

        if (!Number.isInteger(id)) {
            return res.status(400).json({
                success: false,
                error: "ID admin tidak valid."
            });
        }

        if (
            id === req.admin.id &&
            req.body.active === false
        ) {
            return res.status(400).json({
                success: false,
                error: "Kamu tidak dapat menonaktifkan akun sendiri."
            });
        }

        const active =
            req.body.active ? 1 : 0;

        const result = db.prepare(`
            UPDATE admins
            SET active = ?,
                updated_at = ?
            WHERE id = ?
        `).run(
            active,
            new Date().toISOString(),
            id
        );

        if (!result.changes) {
            return res.status(404).json({
                success: false,
                error: "Admin tidak ditemukan."
            });
        }

        return res.json({
            success: true,
            message: active
                ? "Admin diaktifkan."
                : "Admin dinonaktifkan."
        });
    }
);


app.delete(
    "/api/admin/admins/:id",
    requireOwner,
    (req, res) => {

        const id =
            Number(req.params.id);

        if (!Number.isInteger(id)) {
            return res.status(400).json({
                success: false,
                error: "ID admin tidak valid."
            });
        }

        if (id === req.admin.id) {
            return res.status(400).json({
                success: false,
                error: "Kamu tidak dapat menghapus akun sendiri."
            });
        }

        const result = db.prepare(`
            DELETE FROM admins
            WHERE id = ?
        `).run(id);

        if (!result.changes) {
            return res.status(404).json({
                success: false,
                error: "Admin tidak ditemukan."
            });
        }

        return res.json({
            success: true,
            message: "Admin berhasil dihapus."
        });
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
        WHERE product_type = 'ppob'
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
          AND product_type = 'ppob'
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
            product_type,
            cost_price,
            margin,
            digiflazz_sku
        )
        VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, 'ppob', ?, ?, ?)
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
        WHERE product_type = 'ppob'
          AND digiflazz_sku IS NOT NULL
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


/*
 * Cek transaksi Digiflazz yang masih PENDING
 * setiap 1 menit.
 *
 * Tidak membuat ref_id baru.
 */
setInterval(
    checkPendingDigiflazzTransactions,
    60 * 1000
);

console.log(
    "[DIGIFLAZZ CHECKER] Scheduler aktif: setiap 1 menit."
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
