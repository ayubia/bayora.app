function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=UTF-8"
    }
  });
}

import {
  scryptSync,
  randomBytes,
  createHash,
  timingSafeEqual
} from "node:crypto";

function sanitizeServiceId(value = "service") {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-") || "service";
}

function getExtension(filename = "") {
  const match = filename.match(/\.[^/.]+$/);
  return match ? match[0].toLowerCase() : "";
}

function generateFilename(prefix, originalName) {
  const extension = getExtension(originalName);

  return `${prefix}-${Date.now()}-${crypto
    .randomUUID()
    .replaceAll("-", "")
    .slice(0, 16)}${extension}`;
}


// ========================================
// AUTH HELPERS
// ========================================

function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");

  const hash = scryptSync(
    password,
    salt,
    64
  ).toString("hex");

  return `${salt}:${hash}`;
}

function verifyPassword(password, storedPassword) {
  const parts = String(storedPassword || "").split(":");

  if (parts.length !== 2) {
    return false;
  }

  const [salt, storedHash] = parts;

  try {
    const calculatedHash = scryptSync(
      password,
      salt,
      64
    ).toString("hex");

    const storedBuffer =
      Buffer.from(storedHash, "hex");

    const calculatedBuffer =
      Buffer.from(calculatedHash, "hex");

    if (
      storedBuffer.length !==
      calculatedBuffer.length
    ) {
      return false;
    }

    return timingSafeEqual(
      storedBuffer,
      calculatedBuffer
    );

  } catch {
    return false;
  }
}

function hashSessionToken(token) {
  return createHash("sha256")
    .update(token)
    .digest("hex");
}

function getSessionToken(request) {
  const cookieHeader =
    request.headers.get("Cookie") || "";

  const cookies = {};

  cookieHeader
    .split(";")
    .forEach((part) => {
      const index = part.indexOf("=");

      if (index === -1) {
        return;
      }

      const name =
        part.slice(0, index).trim();

      const value =
        part.slice(index + 1).trim();

      try {
        cookies[name] =
          decodeURIComponent(value);
      } catch {
        cookies[name] = value;
      }
    });

  return cookies.bayora_session || null;
}

async function createUserSession(
  db,
  userId
) {
  const token =
    randomBytes(32).toString("hex");

  const tokenHash =
    hashSessionToken(token);

  const now = new Date();

  const expires =
    new Date(
      now.getTime() +
      30 * 24 * 60 * 60 * 1000
    );

  await db
    .prepare(`
      INSERT INTO user_sessions (
        user_id,
        token_hash,
        expires_at,
        created_at
      )
      VALUES (?, ?, ?, ?)
    `)
    .bind(
      userId,
      tokenHash,
      expires.toISOString(),
      now.toISOString()
    )
    .run();

  return token;
}

async function getCurrentUser(
  request,
  db
) {
  const token =
    getSessionToken(request);

  if (!token) {
    return null;
  }

  const tokenHash =
    hashSessionToken(token);

  const session =
    await db
      .prepare(`
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
      `)
      .bind(tokenHash)
      .first();

  if (!session) {
    return null;
  }

  if (
    new Date(session.expires_at).getTime() <=
    Date.now()
  ) {
    await db
      .prepare(`
        DELETE FROM user_sessions
        WHERE id = ?
      `)
      .bind(session.session_id)
      .run();

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

async function serveR2Object(env, key) {
  const object = await env.ppobku_files.get(key);


  if (!object) {
    return new Response("File tidak ditemukan", {
      status: 404
    });
  }

  const headers = new Headers();

  object.writeHttpMetadata(headers);

  headers.set("etag", object.httpEtag);
  headers.set(
    "cache-control",
    "public, max-age=86400"
  );

  return new Response(object.body, {
    headers
  });
}


async function sendTransactionToDigiflazzWorker(env, transactionId) {
  const transaction = await env.ppobku_db.prepare(`
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
  `).bind(transactionId).first();

  if (!transaction) {
    throw new Error("Transaksi tidak ditemukan.");
  }

  if (
    String(transaction.transaction_id || "").startsWith("DIGITAL-") ||
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

  const claim = await env.ppobku_db.prepare(`
    UPDATE transactions
    SET
      digiflazz_status = 'PROCESSING',
      processed_at = ?
    WHERE transaction_id = ?
      AND payment_status = 'PAID'
      AND digiflazz_status = 'PENDING'
  `).bind(
    new Date().toISOString(),
    transactionId
  ).run();

  if (!claim.meta || claim.meta.changes === 0) {
    const current = await env.ppobku_db.prepare(`
      SELECT
        transaction_id,
        payment_status,
        digiflazz_status,
        digiflazz_ref,
        digiflazz_message
      FROM transactions
      WHERE transaction_id = ?
    `).bind(transactionId).first();

    return {
      skipped: true,
      reason: "TRANSAKSI_SUDAH_DIPROSES_ATAU_SEDANG_DIPROSES",
      transaction: current || null
    };
  }

  const username = env.DIGIFLAZZ_USERNAME;
  const apiKey = env.DIGIFLAZZ_API_KEY;

  if (!username || !apiKey) {
    await env.ppobku_db.prepare(`
      UPDATE transactions
      SET
        digiflazz_status = 'FAILED',
        digiflazz_message = ?,
        processed_at = ?
      WHERE transaction_id = ?
    `).bind(
      "Credential Digiflazz belum dikonfigurasi.",
      new Date().toISOString(),
      transactionId
    ).run();

    throw new Error("Credential Digiflazz belum dikonfigurasi.");
  }

  if (!transaction.digiflazz_sku) {
    await env.ppobku_db.prepare(`
      UPDATE transactions
      SET
        digiflazz_status = 'FAILED',
        digiflazz_message = ?,
        processed_at = ?
      WHERE transaction_id = ?
    `).bind(
      "Produk tidak memiliki digiflazz_sku.",
      new Date().toISOString(),
      transactionId
    ).run();

    throw new Error("Produk tidak memiliki digiflazz_sku.");
  }

  const refId = "PPOBKU-" + transaction.reference;

  const sign = createHash("md5")
    .update(username + apiKey + refId)
    .digest("hex");

  const payload = {
    username,
    buyer_sku_code: transaction.digiflazz_sku,
    customer_no: String(transaction.target),
    ref_id: refId,
    sign
  };

  if (env.PUBLIC_BASE_URL) {
    payload.cb_url =
      String(env.PUBLIC_BASE_URL).replace(/\/$/, "") +
      "/api/webhooks/digiflazz";
  }

  let response;
  let responseData;

  try {
    response = await fetch(
      "https://api.digiflazz.com/v1/transaction",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      }
    );

    responseData = await response.json().catch(() => ({}));

    if (!response.ok) {
      const errorMessage =
        responseData?.data?.message ||
        responseData?.message ||
        `Digiflazz HTTP ${response.status}`;

      await env.ppobku_db.prepare(`
        UPDATE transactions
        SET
          digiflazz_message = ?,
          processed_at = ?
        WHERE transaction_id = ?
      `).bind(
        String(errorMessage),
        new Date().toISOString(),
        transactionId
      ).run();

      throw new Error(String(errorMessage));
    }
  } catch (error) {
    await env.ppobku_db.prepare(`
      UPDATE transactions
      SET
        digiflazz_message = ?,
        processed_at = ?
      WHERE transaction_id = ?
    `).bind(
      String(error?.message || "Request ke Digiflazz gagal."),
      new Date().toISOString(),
      transactionId
    ).run();

    throw error;
  }

  const result = responseData?.data || {};

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

  const status = String(result.status || "").toLowerCase();

  const message =
    result.message ||
    "Tidak ada pesan dari Digiflazz.";

  const digiflazzRef = result.ref_id || refId;

  let finalStatus = "PROCESSING";

  if (status === "sukses") {
    finalStatus = "SUCCESS";
  } else if (status === "gagal") {
    finalStatus = "FAILED";
  } else if (status === "pending") {
    finalStatus = "PENDING";
  }

  await env.ppobku_db.prepare(`
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
  `).bind(
    finalStatus,
    finalStatus,
    String(digiflazzRef),
    String(message),
    result.rc || null,
    result.sn || null,
    new Date().toISOString(),
    transactionId
  ).run();

  return {
    skipped: false,
    status: finalStatus,
    ref_id: digiflazzRef,
    message
  };
}



async function sendTransactionToHaybiWorker(env, transactionId) {
  const transaction = await env.ppobku_db.prepare(`
    SELECT
      t.transaction_id,
      t.reference,
      t.target,
      t.payment_status,
      t.status,
      t.provider,
      t.haybi_status,
      t.haybi_ref,
      p.product_type,
      p.haybi_sku
    FROM transactions t
    LEFT JOIN products p
      ON p.id = t.product_id
    WHERE t.transaction_id = ?
  `).bind(transactionId).first();

  if (!transaction) {
    throw new Error("Transaksi tidak ditemukan.");
  }

  if (
    String(transaction.transaction_id || "").startsWith("DIGITAL-") ||
    transaction.product_type === "digital"
  ) {
    return {
      skipped: true,
      digital: true,
      reason: "PRODUK_DIGITAL"
    };
  }

  if (transaction.payment_status !== "PAID") {
    throw new Error("Pembayaran belum berstatus PAID.");
  }

  if (!transaction.haybi_sku) {
    throw new Error("Produk tidak memiliki haybi_sku.");
  }

  const username = env.HAYBI_USERNAME;
  const apiKey = env.HAYBI_API_KEY;

  if (!username || !apiKey) {
    throw new Error("Credential HAYBI belum dikonfigurasi.");
  }

  /*
   * Ref ID HARUS stabil.
   * Retry transaksi Bayora yang sama tidak boleh membuat ref baru.
   */
  const refId =
    transaction.haybi_ref ||
    ("BAYORA-" + transaction.reference);

  /*
   * Atomic claim.
   * Hanya transaksi yang belum pernah diklaim HAYBI yang boleh
   * melakukan POST /transaksi.
   */
  const claim = await env.ppobku_db.prepare(`
    UPDATE transactions
    SET
      provider = 'HAYBI',
      haybi_status = 'PROCESSING',
      haybi_ref = ?,
      processed_at = ?
    WHERE transaction_id = ?
      AND payment_status = 'PAID'
      AND provider IS NULL
      AND haybi_status IS NULL
      AND haybi_ref IS NULL
  `).bind(
    refId,
    new Date().toISOString(),
    transactionId
  ).run();

  if (!claim.meta || claim.meta.changes === 0) {
    const current = await env.ppobku_db.prepare(`
      SELECT
        transaction_id,
        payment_status,
        status,
        provider,
        haybi_status,
        haybi_ref,
        haybi_rc,
        haybi_message,
        haybi_sn
      FROM transactions
      WHERE transaction_id = ?
    `).bind(transactionId).first();

    return {
      skipped: true,
      reason: "TRANSAKSI_SUDAH_DIPROSES_ATAU_SEDANG_DIPROSES",
      transaction: current || null
    };
  }

  const sign = createHash("md5")
    .update(username + apiKey + refId)
    .digest("hex");

  const payload = {
    username,
    ref_id: refId,
    sign,
    produk: transaction.haybi_sku,
    no_tujuan: String(transaction.target)
  };

  let response;
  let data;

  try {
    response = await fetch(
      "https://haybi.id/api/h2h/transaksi",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      }
    );

    data = await response.json().catch(() => ({}));

    if (!response.ok) {
      const message =
        data?.pesan ||
        data?.message ||
        `HAYBI HTTP ${response.status}`;

      /*
       * Jangan otomatis membuka claim kembali.
       * Request yang timeout/error transport belum membuktikan
       * bahwa HAYBI tidak menerima order.
       */
      await env.ppobku_db.prepare(`
        UPDATE transactions
        SET
          haybi_message = ?,
          processed_at = ?
        WHERE transaction_id = ?
      `).bind(
        String(message),
        new Date().toISOString(),
        transactionId
      ).run();

      throw new Error(String(message));
    }
  } catch (error) {
    await env.ppobku_db.prepare(`
      UPDATE transactions
      SET
        haybi_message = ?,
        processed_at = ?
      WHERE transaction_id = ?
    `).bind(
      String(error?.message || "Request ke HAYBI gagal."),
      new Date().toISOString(),
      transactionId
    ).run();

    throw error;
  }

  const providerStatus =
    String(data?.status || "").toLowerCase();

  const rc = data?.rc || null;

  const message =
    data?.pesan ||
    data?.message ||
    "Transaksi diterima HAYBI.";

  /*
   * Berdasarkan dokumentasi HAYBI:
   * response awal transaksi normal adalah pending / RC 01.
   * SUCCESS hanya boleh diberikan bila provider benar-benar
   * mengembalikan status final sukses.
   */
  let finalStatus = "PENDING";

  if (providerStatus === "sukses" && rc !== "01") {
    finalStatus = "SUCCESS";
  } else if (
    providerStatus === "error" &&
    rc !== "01"
  ) {
    finalStatus = "FAILED";
  }

  await env.ppobku_db.prepare(`
    UPDATE transactions
    SET
      status = ?,
      provider = 'HAYBI',
      haybi_status = ?,
      haybi_ref = ?,
      haybi_rc = ?,
      haybi_message = ?,
      haybi_sn = ?,
      processed_at = ?
    WHERE transaction_id = ?
  `).bind(
    finalStatus,
    finalStatus,
    refId,
    rc,
    String(message),
    data?.sn || null,
    new Date().toISOString(),
    transactionId
  ).run();

  return {
    skipped: false,
    status: finalStatus,
    ref_id: refId,
    rc,
    message
  };
}


async function checkHaybiTransactionStatus(env, transactionId) {
  const transaction = await env.ppobku_db.prepare(`
    SELECT
      transaction_id,
      payment_status,
      provider,
      haybi_status,
      haybi_ref
    FROM transactions
    WHERE transaction_id = ?
  `).bind(transactionId).first();

  if (!transaction) {
    throw new Error("Transaksi tidak ditemukan.");
  }

  if (transaction.payment_status !== "PAID") {
    throw new Error("Pembayaran belum berstatus PAID.");
  }

  if (
    transaction.provider !== "HAYBI" ||
    !transaction.haybi_ref
  ) {
    throw new Error("Transaksi belum dikirim ke HAYBI.");
  }

  const username = env.HAYBI_USERNAME;
  const apiKey = env.HAYBI_API_KEY;

  if (!username || !apiKey) {
    throw new Error("Credential HAYBI belum dikonfigurasi.");
  }

  const refId = transaction.haybi_ref;

  const sign = createHash("md5")
    .update(username + apiKey + refId)
    .digest("hex");

  const response = await fetch(
    "https://haybi.id/api/h2h/cek-status",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        username,
        ref_id: refId,
        sign
      })
    }
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      data?.pesan ||
      data?.message ||
      `HAYBI HTTP ${response.status}`
    );
  }

  const providerStatus =
    String(data?.status || "").toLowerCase();

  const rc = data?.rc || null;

  const message =
    data?.pesan ||
    data?.message ||
    "Status HAYBI diperbarui.";

  let finalStatus = "PENDING";

  if (providerStatus === "sukses" && rc !== "01") {
    finalStatus = "SUCCESS";
  } else if (
    providerStatus === "error" &&
    rc !== "01"
  ) {
    finalStatus = "FAILED";
  }

  await env.ppobku_db.prepare(`
    UPDATE transactions
    SET
      status = ?,
      haybi_status = ?,
      haybi_rc = ?,
      haybi_message = ?,
      haybi_sn = ?,
      processed_at = ?
    WHERE transaction_id = ?
      AND provider = 'HAYBI'
  `).bind(
    finalStatus,
    finalStatus,
    rc,
    String(message),
    data?.sn || null,
    new Date().toISOString(),
    transactionId
  ).run();

  return {
    status: finalStatus,
    ref_id: refId,
    rc,
    message,
    sn: data?.sn || null
  };
}




export default {
  async fetch(request, env) {

    const url = new URL(request.url);










  // ==========================================================
  // ACCOUNT PROFILE
  // ==========================================================

  if (
    request.method === "GET" &&
    url.pathname === "/api/auth/profile"
  ) {
    try {
      const user = await getCurrentUser(request, env.ppobku_db);

      if (!user) {
        return Response.json({
          success: false,
          authenticated: false,
          error: "Belum login."
        }, { status: 401 });
      }

      return Response.json({
        success: true,
        user
      });
    } catch (error) {
      console.error("[AUTH PROFILE]", error);

      return Response.json({
        success: false,
        error: "Gagal mengambil profil."
      }, { status: 500 });
    }
  }


  // ==========================================================
  // ACCOUNT TRANSACTION HISTORY
  // ==========================================================

  if (
    request.method === "GET" &&
    url.pathname === "/api/auth/history"
  ) {
    try {
      const user = await getCurrentUser(request, env.ppobku_db);

      if (!user) {
        return Response.json({
          success: false,
          authenticated: false,
          error: "Belum login."
        }, { status: 401 });
      }

      const result = await env.ppobku_db.prepare(`
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
      `).bind(user.id).all();

      return Response.json({
        success: true,
        count: result.results?.length || 0,
        transactions: result.results || []
      });
    } catch (error) {
      console.error("[AUTH HISTORY]", error);

      return Response.json({
        success: false,
        error: "Gagal mengambil riwayat transaksi."
      }, { status: 500 });
    }
  }


  // ==========================================================
  // DELETE ACCOUNT
  // ==========================================================

  if (
    request.method === "DELETE" &&
    url.pathname === "/api/auth/delete-account"
  ) {
    try {
      const user = await getCurrentUser(request, env.ppobku_db);

      if (!user) {
        return Response.json({
          success: false,
          authenticated: false,
          error: "Belum login."
        }, { status: 401 });
      }

      await env.ppobku_db.prepare(`
        UPDATE transactions
        SET user_id = NULL
        WHERE user_id = ?
      `).bind(user.id).run();

      await env.ppobku_db.prepare(`
        DELETE FROM user_sessions
        WHERE user_id = ?
      `).bind(user.id).run();

      const result = await env.ppobku_db.prepare(`
        DELETE FROM users
        WHERE id = ?
      `).bind(user.id).run();

      if ((result.meta?.changes || 0) !== 1) {
        return Response.json({
          success: false,
          error: "Akun tidak ditemukan."
        }, { status: 404 });
      }

      return new Response(
        JSON.stringify({
          success: true,
          message: "Akun berhasil dihapus."
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Set-Cookie":
              "bayora_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"
          }
        }
      );

    } catch (error) {
      console.error("[AUTH DELETE ACCOUNT]", error);

      return Response.json({
        success: false,
        error: "Gagal menghapus akun."
      }, { status: 500 });
    }
  }





    // ========================================
    // AUTH: REGISTER
    // ========================================

    if (
      request.method === "POST" &&
      url.pathname === "/api/auth/register"
    ) {
      try {
        const body = await request.json();

        const name =
          String(body.name || "").trim();

        const phone =
          String(body.phone || "").trim();

        const email =
          String(body.email || "")
            .trim()
            .toLowerCase();

        const password =
          String(body.password || "");

        if (
          !name ||
          !phone ||
          !email ||
          !password
        ) {
          return Response.json(
            {
              success: false,
              error: "Semua field wajib diisi."
            },
            { status: 400 }
          );
        }

        if (password.length < 8) {
          return Response.json(
            {
              success: false,
              error:
                "Password minimal 8 karakter."
            },
            { status: 400 }
          );
        }

        if (
          !/^[^\s@]+@[^\s@]+\.[^\s@]+$/
            .test(email)
        ) {
          return Response.json(
            {
              success: false,
              error:
                "Format email tidak valid."
            },
            { status: 400 }
          );
        }

        const existing =
          await env.ppobku_db
            .prepare(`
              SELECT id
              FROM users
              WHERE email = ?
                 OR phone = ?
              LIMIT 1
            `)
            .bind(email, phone)
            .first();

        if (existing) {
          return Response.json(
            {
              success: false,
              error:
                "Email atau nomor HP sudah terdaftar."
            },
            { status: 409 }
          );
        }

        const now =
          new Date().toISOString();

        const passwordHash =
          hashPassword(password);

        const result =
          await env.ppobku_db
            .prepare(`
              INSERT INTO users (
                name,
                phone,
                email,
                password_hash,
                created_at,
                updated_at
              )
              VALUES (?, ?, ?, ?, ?, ?)
            `)
            .bind(
              name,
              phone,
              email,
              passwordHash,
              now,
              now
            )
            .run();

        return Response.json(
          {
            success: true,
            message:
              "Registrasi berhasil.",
            user: {
              id: result.meta.last_row_id,
              name,
              phone,
              email
            }
          },
          { status: 201 }
        );

      } catch (error) {
        console.error(
          "[AUTH REGISTER]",
          error
        );

        return Response.json(
          {
            success: false,
            error:
              "Gagal melakukan registrasi."
          },
          { status: 500 }
        );
      }
    }



    // ========================================
    // AUTH: LOGIN
    // ========================================

    if (
      request.method === "POST" &&
      url.pathname === "/api/auth/login"
    ) {
      try {
        const body = await request.json();

        const identifier =
          String(
            body.email ||
            body.phone ||
            body.identifier ||
            ""
          ).trim();

        const password =
          String(body.password || "");

        if (
          !identifier ||
          !password
        ) {
          return Response.json(
            {
              success: false,
              error:
                "Email/nomor HP dan password wajib diisi."
            },
            { status: 400 }
          );
        }

        const user =
          await env.ppobku_db
            .prepare(`
              SELECT
                id,
                name,
                phone,
                email,
                password_hash,
                created_at
              FROM users
              WHERE email = ?
                 OR phone = ?
              LIMIT 1
            `)
            .bind(
              identifier.toLowerCase(),
              identifier
            )
            .first();

        if (
          !user ||
          !verifyPassword(
            password,
            user.password_hash
          )
        ) {
          return Response.json(
            {
              success: false,
              error:
                "Email/nomor HP atau password salah."
            },
            { status: 401 }
          );
        }

        const token =
          await createUserSession(
            env.ppobku_db,
            user.id
          );

        const secure =
          url.protocol === "https:"
            ? "; Secure"
            : "";

        return new Response(
          JSON.stringify({
            success: true,
            message:
              "Login berhasil.",
            user: {
              id: user.id,
              name: user.name,
              phone: user.phone,
              email: user.email,
              created_at:
                user.created_at
            }
          }),
          {
            status: 200,
            headers: {
              "Content-Type":
                "application/json",
              "Set-Cookie":
                `bayora_session=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=2592000; SameSite=Lax${secure}`
            }
          }
        );

      } catch (error) {
        console.error(
          "[AUTH LOGIN]",
          error
        );

        return Response.json(
          {
            success: false,
            error:
              "Gagal melakukan login."
          },
          { status: 500 }
        );
      }
    }


    // ========================================
    // AUTH: LOGOUT
    // ========================================

    if (
      request.method === "POST" &&
      url.pathname === "/api/auth/logout"
    ) {
      try {
        const token =
          getSessionToken(request);

        if (token) {
          await env.ppobku_db
            .prepare(`
              DELETE FROM user_sessions
              WHERE token_hash = ?
            `)
            .bind(
              hashSessionToken(token)
            )
            .run();
        }

        return new Response(
          JSON.stringify({
            success: true,
            message:
              "Logout berhasil."
          }),
          {
            status: 200,
            headers: {
              "Content-Type":
                "application/json",
              "Set-Cookie":
                "bayora_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax"
            }
          }
        );

      } catch (error) {
        console.error(
          "[AUTH LOGOUT]",
          error
        );

        return Response.json(
          {
            success: false,
            error:
              "Gagal melakukan logout."
          },
          { status: 500 }
        );
      }
    }


    // ========================================
    // AUTH: CURRENT USER
    // ========================================

    if (
      request.method === "GET" &&
      url.pathname === "/api/auth/me"
    ) {
      try {
        const user =
          await getCurrentUser(
            request,
            env.ppobku_db
          );

        if (!user) {
          return Response.json(
            {
              success: false,
              authenticated: false,
              error: "Belum login."
            },
            { status: 401 }
          );
        }

        return Response.json({
          success: true,
          authenticated: true,
          user
        });

      } catch (error) {
        console.error(
          "[AUTH ME]",
          error
        );

        return Response.json(
          {
            success: false,
            authenticated: false,
            error:
              "Gagal mengecek session."
          },
          { status: 500 }
        );
      }
    }


    // ========================================
    // ADMIN AUTH
    // ========================================

    if (
      request.method === "POST" &&
      url.pathname === "/api/admin/login"
    ) {
      try {
        const body = await request.json().catch(() => null);

        const username =
          typeof body?.username === "string"
            ? body.username.trim()
            : "";

        const password =
          typeof body?.password === "string"
            ? body.password
            : "";

        if (!username || !password) {
          return json({
            success: false,
            error: "Username dan password wajib diisi."
          }, 400);
        }

        const result = await env.ppobku_db.prepare(`
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
        `).bind(username).all();

        const admin = result.results?.[0];

        if (
          !admin ||
          !admin.active ||
          !verifyPassword(
            password,
            admin.password_hash
          )
        ) {
          return json({
            success: false,
            error: "Username atau password salah."
          }, 401);
        }

        const token =
          randomBytes(32).toString("hex");

        const tokenHash =
          hashSessionToken(token);

        const now = new Date();

        const expires =
          new Date(
            now.getTime() +
            7 * 24 * 60 * 60 * 1000
          );

        await env.ppobku_db.prepare(`
          INSERT INTO admin_sessions (
            admin_id,
            token_hash,
            expires_at,
            created_at
          )
          VALUES (?, ?, ?, ?)
        `).bind(
          admin.id,
          tokenHash,
          expires.toISOString(),
          now.toISOString()
        ).run();

        const response = json({
          success: true,
          message: "Login admin berhasil.",
          admin: {
            id: admin.id,
            username: admin.username,
            name: admin.name,
            role: admin.role
          }
        });

        response.headers.set(
          "Set-Cookie",
          [
            `bayora_admin_session=${encodeURIComponent(token)}`,
            "Path=/",
            "HttpOnly",
            "SameSite=Lax",
            "Max-Age=604800"
          ].join("; ")
        );

        return response;

      } catch (error) {
        console.error("[ADMIN LOGIN]", error);

        return json({
          success: false,
          error: "Terjadi kesalahan pada server."
        }, 500);
      }
    }


    if (
      request.method === "GET" &&
      url.pathname === "/api/admin/me"
    ) {
      try {
        const cookieHeader =
          request.headers.get("Cookie") || "";

        const match =
          cookieHeader.match(
            /(?:^|;\s*)bayora_admin_session=([^;]+)/
          );

        if (!match) {
          return json({
            success: false,
            authenticated: false,
            error: "Admin belum login."
          }, 401);
        }

        let token;

        try {
          token =
            decodeURIComponent(match[1]);
        } catch {
          token = match[1];
        }

        const tokenHash =
          hashSessionToken(token);

        const result = await env.ppobku_db.prepare(`
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
        `).bind(tokenHash).all();

        const session =
          result.results?.[0];

        if (!session) {
          return json({
            success: false,
            authenticated: false,
            error: "Admin belum login."
          }, 401);
        }

        if (
          !session.active ||
          new Date(session.expires_at).getTime() <= Date.now()
        ) {
          await env.ppobku_db.prepare(`
            DELETE FROM admin_sessions
            WHERE id = ?
          `).bind(session.session_id).run();

          return json({
            success: false,
            authenticated: false,
            error: "Session admin sudah expired."
          }, 401);
        }

        return json({
          success: true,
          authenticated: true,
          admin: {
            id: session.id,
            username: session.username,
            name: session.name,
            role: session.role
          }
        });

      } catch (error) {
        console.error("[ADMIN ME]", error);

        return json({
          success: false,
          authenticated: false,
          error: "Gagal mengecek session."
        }, 500);
      }
    }


    if (
      request.method === "POST" &&
      url.pathname === "/api/admin/logout"
    ) {
      try {
        const cookieHeader =
          request.headers.get("Cookie") || "";

        const match =
          cookieHeader.match(
            /(?:^|;\s*)bayora_admin_session=([^;]+)/
          );

        if (match) {
          let token;

          try {
            token =
              decodeURIComponent(match[1]);
          } catch {
            token = match[1];
          }

          const tokenHash =
            hashSessionToken(token);

          await env.ppobku_db.prepare(`
            DELETE FROM admin_sessions
            WHERE token_hash = ?
          `).bind(tokenHash).run();
        }

        const response = json({
          success: true,
          message: "Logout admin berhasil."
        });

        response.headers.set(
          "Set-Cookie",
          [
            "bayora_admin_session=",
            "Path=/",
            "HttpOnly",
            "SameSite=Lax",
            "Max-Age=0"
          ].join("; ")
        );

        return response;

      } catch (error) {
        console.error("[ADMIN LOGOUT]", error);

        return json({
          success: false,
          error: "Gagal melakukan logout."
        }, 500);
      }
    }


    // ========================================
    // ADMIN — TAB ICON MANAGER
    // ========================================

    if (
      request.method === "POST" &&
      url.pathname === "/api/admin/tab-icons/upload"
    ) {
      try {
        // ------------------------------------
        // AUTH ADMIN
        // ------------------------------------

        const cookieHeader =
          request.headers.get("Cookie") || "";

        const match =
          cookieHeader.match(
            /(?:^|;\s*)bayora_admin_session=([^;]+)/
          );

        if (!match) {
          return json({
            success: false,
            authenticated: false,
            error: "Admin belum login."
          }, 401);
        }

        let sessionToken;

        try {
          sessionToken =
            decodeURIComponent(match[1]);
        } catch {
          sessionToken = match[1];
        }

        const sessionHash =
          hashSessionToken(sessionToken);

        const sessionResult =
          await env.ppobku_db.prepare(`
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
          `).bind(sessionHash).all();

        const admin =
          sessionResult.results?.[0];

        if (!admin) {
          return json({
            success: false,
            authenticated: false,
            error: "Session admin tidak valid."
          }, 401);
        }

        if (
          !admin.active ||
          new Date(admin.expires_at).getTime() <= Date.now()
        ) {
          await env.ppobku_db.prepare(`
            DELETE FROM admin_sessions
            WHERE id = ?
          `).bind(admin.session_id).run();

          return json({
            success: false,
            authenticated: false,
            error: "Session admin sudah expired."
          }, 401);
        }

        // Owner + Admin saja
        if (
          admin.role !== "owner" &&
          admin.role !== "admin"
        ) {
          return json({
            success: false,
            error: "Kamu tidak memiliki akses untuk mengganti icon."
          }, 403);
        }

        // ------------------------------------
        // FORM DATA
        // ------------------------------------

        const formData =
          await request.formData();

        const tab =
          String(
            formData.get("tab") || ""
          )
            .trim()
            .toLowerCase();

        const file =
          formData.get("file");

        const allowedTabs = {
          ppob: "layanan-ppob.png",
          digital: "produk-digital.png",
          smm: "smm.png"
        };

        if (!Object.prototype.hasOwnProperty.call(
          allowedTabs,
          tab
        )) {
          return json({
            success: false,
            error: "Tab tidak valid."
          }, 400);
        }

        if (
          !file ||
          typeof file.stream !== "function"
        ) {
          return json({
            success: false,
            error: "File icon belum dipilih."
          }, 400);
        }

        const allowedTypes = [
          "image/png",
          "image/jpeg",
          "image/webp"
        ];

        if (!allowedTypes.includes(file.type)) {
          return json({
            success: false,
            error: "Icon hanya boleh PNG, JPG, atau WEBP."
          }, 400);
        }

        if (file.size > 5 * 1024 * 1024) {
          return json({
            success: false,
            error: "Ukuran icon maksimal 5 MB."
          }, 400);
        }

        const filename =
          allowedTabs[tab];

        const key =
          `bayora-icons/${filename}`;

        // ------------------------------------
        // BACKUP ICON LAMA
        // ------------------------------------

        const oldObject =
          await env.ppobku_files.get(key);

        let backupKey = null;

        if (oldObject) {
          const backupTimestamp =
            new Date()
              .toISOString()
              .replace(/[:.]/g, "-");

          backupKey =
            `bayora-icons/tab-backups/${tab}-${backupTimestamp}.png`;

          const oldHeaders = {};

          oldObject.writeHttpMetadata(oldHeaders);

          await env.ppobku_files.put(
            backupKey,
            oldObject.body,
            {
              httpMetadata: {
                contentType:
                  oldHeaders["content-type"] ||
                  "image/png"
              }
            }
          );
        }

        // ------------------------------------
        // OVERWRITE ICON UTAMA
        // ------------------------------------

        await env.ppobku_files.put(
          key,
          file.stream(),
          {
            httpMetadata: {
              contentType: file.type,
              cacheControl:
                "no-cache, no-store, must-revalidate"
            }
          }
        );

        return json({
          success: true,
          message:
            `Icon ${tab.toUpperCase()} berhasil diganti.`,
          tab,
          path:
            `/assets/bayora-icons/${filename}`,
          backup:
            backupKey
              ? `/assets/${backupKey}`
              : null
        });

      } catch (error) {
        console.error(
          "[ADMIN TAB ICON UPLOAD]",
          error
        );

        return json({
          success: false,
          error:
            error?.message ||
            "Gagal mengganti icon tab."
        }, 500);
      }
    }

    // ========================================
    // SMM SERVICES
    // ========================================

    if (
      request.method === "GET" &&
      url.pathname === "/api/smm/services"
    ) {
      try {
        const platform =
          String(url.searchParams.get("platform") || "")
            .trim()
            .toLowerCase();

        const category =
          String(url.searchParams.get("category") || "")
            .trim()
            .toLowerCase();

        let sql = `
          SELECT
            id,
            provider_id AS providerId,
            provider_service_id AS providerServiceId,
            platform,
            category,
            name,
            description,
            icon,
            price,
            min_quantity AS minQuantity,
            max_quantity AS maxQuantity,
            refill,
            cancel,
            active,
            created_at AS createdAt,
            updated_at AS updatedAt
          FROM smm_services
          WHERE active = 1
        `;

        const params = [];

        if (platform) {
          sql += " AND LOWER(platform) = ?";
          params.push(platform);
        }

        if (category) {
          sql += " AND LOWER(category) = ?";
          params.push(category);
        }

        sql += " ORDER BY platform ASC, category ASC, name ASC";

        const result = await env.ppobku_db
          .prepare(sql)
          .bind(...params)
          .all();

        return Response.json({
          success: true,
          count: result.results.length,
          services: result.results
        });

      } catch (error) {
        console.error("[SMM SERVICES]", error);

        return Response.json(
          {
            success: false,
            error: "Gagal mengambil layanan SMM."
          },
          { status: 500 }
        );
      }
    }

    // ========================================
    // FRONTEND ROOT
    // ========================================

    if (
      request.method === "GET" &&
      url.pathname === "/"
    ) {
      const assetRequest = new Request(
        new URL("/index.html", request.url),
        request
      );

      return env.ASSETS.fetch(assetRequest);
    }

    // ========================================
    // UPLOAD SERVICE ICON
    // ========================================

    if (
      request.method === "POST" &&
      url.pathname === "/api/services/upload-icon"
    ) {
      try {

        // ------------------------------------
        // AUTH ADMIN
        // ------------------------------------

        const cookieHeader =
          request.headers.get("Cookie") || "";

        const match =
          cookieHeader.match(
            /(?:^|;\s*)bayora_admin_session=([^;]+)/
          );

        if (!match) {
          return json({
            success: false,
            authenticated: false,
            error: "Admin belum login."
          }, 401);
        }

        let sessionToken;

        try {
          sessionToken =
            decodeURIComponent(match[1]);
        } catch {
          sessionToken = match[1];
        }

        const sessionHash =
          hashSessionToken(sessionToken);

        const sessionResult =
          await env.ppobku_db.prepare(`
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
          `).bind(sessionHash).all();

        const admin =
          sessionResult.results?.[0];

        if (!admin) {
          return json({
            success: false,
            authenticated: false,
            error: "Session admin tidak valid."
          }, 401);
        }

        if (
          !admin.active ||
          new Date(admin.expires_at).getTime() <= Date.now()
        ) {
          await env.ppobku_db.prepare(`
            DELETE FROM admin_sessions
            WHERE id = ?
          `).bind(admin.session_id).run();

          return json({
            success: false,
            authenticated: false,
            error: "Session admin sudah expired."
          }, 401);
        }

        if (
          admin.role !== "owner" &&
          admin.role !== "admin"
        ) {
          return json({
            success: false,
            error: "Kamu tidak memiliki akses untuk upload file."
          }, 403);
        }


        const formData =
          await request.formData();

        const file = formData.get("file");

        const serviceId =
          formData.get("serviceId") ||
          url.searchParams.get("serviceId") ||
          "service";

        if (
          !file ||
          typeof file.stream !== "function"
        ) {
          return Response.json(
            {
              success: false,
              error: "File icon belum dipilih."
            },
            { status: 400 }
          );
        }

        const allowedTypes = [
          "image/jpeg",
          "image/png",
          "image/webp"
        ];

        if (
          !allowedTypes.includes(file.type)
        ) {
          return Response.json(
            {
              success: false,
              error:
                "Icon hanya boleh JPG, PNG, atau WEBP."
            },
            { status: 400 }
          );
        }

        if (
          file.size > 5 * 1024 * 1024
        ) {
          return Response.json(
            {
              success: false,
              error:
                "Ukuran icon maksimal 5 MB."
            },
            { status: 400 }
          );
        }

        const filename =
          generateFilename(
            sanitizeServiceId(serviceId),
            file.name
          );

        const key =
          `bayora-icons/${filename}`;

        await env.ppobku_files.put(
          key,
          file.stream(),
          {
            httpMetadata: {
              contentType: file.type
            }
          }
        );

        return Response.json({
          success: true,
          path:
            `/assets/bayora-icons/${filename}`,
          filename
        });

      } catch (error) {
        console.error(
          "[UPLOAD SERVICE ICON]",
          error
        );

        return Response.json(
          {
            success: false,
            error:
              error?.message ||
              "Gagal mengupload icon."
          },
          { status: 500 }
        );
      }
    }

    // ========================================
    // SERVE SERVICE ICON
    // ========================================

    if (
      request.method === "GET" &&
      url.pathname.startsWith(
        "/assets/bayora-icons/"
      )
    ) {
      try {
        const relativePath =
          decodeURIComponent(
            url.pathname.replace(
              "/assets/bayora-icons/",
              ""
            )
          );

        if (
          !relativePath ||
          relativePath.includes("..")
        ) {
          return new Response(
            "Invalid path",
            { status: 400 }
          );
        }

        const iconResponse =
          await serveR2Object(
            env,
            `bayora-icons/${relativePath}`
          );

        // ========================================
        // TAB ICON CACHE CONTROL
        // ========================================

        if (
          [
            "layanan-ppob.png",
            "produk-digital.png",
            "smm.png"
          ].includes(relativePath)
        ) {
          const headers =
            new Headers(iconResponse.headers);

          headers.set(
            "Cache-Control",
            "no-cache, no-store, must-revalidate"
          );

          return new Response(
            iconResponse.body,
            {
              status: iconResponse.status,
              statusText: iconResponse.statusText,
              headers
            }
          );
        }

        return iconResponse;

      } catch (error) {
        console.error(
          "[SERVE SERVICE ICON]",
          error
        );

        return new Response(
          "Gagal mengambil icon",
          { status: 500 }
        );
      }
    }

    // ========================================
    // UPLOAD DIGITAL PRODUCT PREVIEW
    // ========================================

    if (
      request.method === "POST" &&
      url.pathname ===
        "/api/products/upload-preview"
    ) {
      try {

        // ------------------------------------
        // AUTH ADMIN
        // ------------------------------------

        const cookieHeader =
          request.headers.get("Cookie") || "";

        const match =
          cookieHeader.match(
            /(?:^|;\s*)bayora_admin_session=([^;]+)/
          );

        if (!match) {
          return json({
            success: false,
            authenticated: false,
            error: "Admin belum login."
          }, 401);
        }

        let sessionToken;

        try {
          sessionToken =
            decodeURIComponent(match[1]);
        } catch {
          sessionToken = match[1];
        }

        const sessionHash =
          hashSessionToken(sessionToken);

        const sessionResult =
          await env.ppobku_db.prepare(`
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
          `).bind(sessionHash).all();

        const admin =
          sessionResult.results?.[0];

        if (!admin) {
          return json({
            success: false,
            authenticated: false,
            error: "Session admin tidak valid."
          }, 401);
        }

        if (
          !admin.active ||
          new Date(admin.expires_at).getTime() <= Date.now()
        ) {
          await env.ppobku_db.prepare(`
            DELETE FROM admin_sessions
            WHERE id = ?
          `).bind(admin.session_id).run();

          return json({
            success: false,
            authenticated: false,
            error: "Session admin sudah expired."
          }, 401);
        }

        if (
          admin.role !== "owner" &&
          admin.role !== "admin"
        ) {
          return json({
            success: false,
            error: "Kamu tidak memiliki akses untuk upload file."
          }, 403);
        }


        const formData =
          await request.formData();

        const file = formData.get("file");

        if (
          !file ||
          typeof file.stream !== "function"
        ) {
          return Response.json(
            {
              success: false,
              error:
                "File preview belum dipilih."
            },
            { status: 400 }
          );
        }

        const allowedTypes = [
          "image/jpeg",
          "image/png",
          "image/webp"
        ];

        if (
          !allowedTypes.includes(file.type)
        ) {
          return Response.json(
            {
              success: false,
              error:
                "File preview harus berupa JPG, PNG, atau WEBP."
            },
            { status: 400 }
          );
        }

        if (
          file.size > 10 * 1024 * 1024
        ) {
          return Response.json(
            {
              success: false,
              error:
                "Ukuran preview maksimal 10 MB."
            },
            { status: 400 }
          );
        }

        const filename =
          generateFilename(
            "preview",
            file.name
          );

        const key =
          `digital/preview/${filename}`;

        await env.ppobku_files.put(
          key,
          file.stream(),
          {
            httpMetadata: {
              contentType: file.type
            }
          }
        );

        const publicPath =
          `/uploads/digital/preview/${filename}`;

        return Response.json({
          success: true,
          file: {
            originalName: file.name,
            filename,
            path: publicPath,
            size: file.size,
            mimeType: file.type
          }
        });

      } catch (error) {
        console.error(
          "[UPLOAD PREVIEW]",
          error
        );

        return Response.json(
          {
            success: false,
            error:
              error?.message ||
              "Gagal mengupload preview."
          },
          { status: 500 }
        );
      }
    }

    // ========================================
    // SERVE DIGITAL PREVIEW
    // ========================================

    if (
      request.method === "GET" &&
      url.pathname.startsWith(
        "/uploads/digital/preview/"
      )
    ) {
      try {
        const relativePath =
          decodeURIComponent(
            url.pathname.replace(
              "/uploads/digital/preview/",
              ""
            )
          );

        if (
          !relativePath ||
          relativePath.includes("..")
        ) {
          return new Response(
            "Invalid path",
            { status: 400 }
          );
        }

        return await serveR2Object(
          env,
          `digital/preview/${relativePath}`
        );

      } catch (error) {
        console.error(
          "[SERVE DIGITAL PREVIEW]",
          error
        );

        return new Response(
          "Gagal mengambil preview",
          { status: 500 }
        );
      }
    }

    // ========================================
    // UPLOAD DIGITAL PRODUCT PDF
    // ========================================

    if (
      request.method === "POST" &&
      url.pathname === "/api/products/upload-pdf"
    ) {
      try {

        // ------------------------------------
        // AUTH ADMIN
        // ------------------------------------

        const cookieHeader =
          request.headers.get("Cookie") || "";

        const match =
          cookieHeader.match(
            /(?:^|;\s*)bayora_admin_session=([^;]+)/
          );

        if (!match) {
          return json({
            success: false,
            authenticated: false,
            error: "Admin belum login."
          }, 401);
        }

        let sessionToken;

        try {
          sessionToken =
            decodeURIComponent(match[1]);
        } catch {
          sessionToken = match[1];
        }

        const sessionHash =
          hashSessionToken(sessionToken);

        const sessionResult =
          await env.ppobku_db.prepare(`
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
          `).bind(sessionHash).all();

        const admin =
          sessionResult.results?.[0];

        if (!admin) {
          return json({
            success: false,
            authenticated: false,
            error: "Session admin tidak valid."
          }, 401);
        }

        if (
          !admin.active ||
          new Date(admin.expires_at).getTime() <= Date.now()
        ) {
          await env.ppobku_db.prepare(`
            DELETE FROM admin_sessions
            WHERE id = ?
          `).bind(admin.session_id).run();

          return json({
            success: false,
            authenticated: false,
            error: "Session admin sudah expired."
          }, 401);
        }

        if (
          admin.role !== "owner" &&
          admin.role !== "admin"
        ) {
          return json({
            success: false,
            error: "Kamu tidak memiliki akses untuk upload file."
          }, 403);
        }


        const formData = await request.formData();
        const file = formData.get("file");

        if (
          !file ||
          typeof file.stream !== "function"
        ) {
          return Response.json(
            {
              success: false,
              error: "File PDF belum dipilih."
            },
            { status: 400 }
          );
        }

        if (file.type !== "application/pdf") {
          return Response.json(
            {
              success: false,
              error: "File harus berupa PDF."
            },
            { status: 400 }
          );
        }

        if (file.size > 20 * 1024 * 1024) {
          return Response.json(
            {
              success: false,
              error: "Ukuran PDF maksimal 20 MB."
            },
            { status: 400 }
          );
        }

        const filename =
          generateFilename("digital", file.name)
            .replace(/\.[^/.]+$/, "") + ".pdf";

        const key =
          `digital/files/${filename}`;

        await env.ppobku_files.put(
          key,
          file.stream(),
          {
            httpMetadata: {
              contentType: "application/pdf"
            }
          }
        );

        const publicPath =
          `/uploads/digital/files/${filename}`;

        return Response.json({
          success: true,
          file: {
            originalName: file.name,
            filename,
            path: publicPath,
            size: file.size,
            mimeType: file.type
          }
        });

      } catch (error) {
        console.error(
          "[UPLOAD DIGITAL PDF]",
          error
        );

        return Response.json(
          {
            success: false,
            error:
              error?.message ||
              "Gagal mengupload PDF."
          },
          { status: 500 }
        );
      }
    }

    // ========================================
    // SERVE DIGITAL PRODUCT PDF
    // ========================================

    if (
      request.method === "GET" &&
      url.pathname.startsWith(
        "/uploads/digital/files/"
      )
    ) {
      try {
        const relativePath =
          decodeURIComponent(
            url.pathname.replace(
              "/uploads/digital/files/",
              ""
            )
          );

        if (
          !relativePath ||
          relativePath.includes("..")
        ) {
          return new Response(
            "Invalid path",
            { status: 400 }
          );
        }

        return await serveR2Object(
          env,
          `digital/files/${relativePath}`
        );

      } catch (error) {
        console.error(
          "[SERVE DIGITAL PDF]",
          error
        );

        return new Response(
          "Gagal mengambil PDF",
          { status: 500 }
        );
      }
    }


    // ========================================
    // GET CATALOG
    // ========================================

    if (
      request.method === "GET" &&
      url.pathname === "/api/catalog"
    ) {
      try {
        const servicesResult = await env.ppobku_db
          .prepare(`
            SELECT
              id,
              title,
              icon,
              description,
              '' AS short_description,
              label,
              placeholder,
              active,
              sort_order,
              created_at,
              type
            FROM services
            ORDER BY sort_order ASC, title ASC
          `)
          .all();

        const productsResult = await env.ppobku_db
          .prepare(`
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
          `)
          .all();

        return Response.json({
          success: true,
          services: servicesResult.results,
          products: productsResult.results
        });

      } catch (error) {
        console.error("[GET CATALOG]", error);

        return Response.json(
          {
            success: false,
            error: "Gagal mengambil katalog."
          },
          { status: 500 }
        );
      }
    }


    // ========================================
    // CREATE PPOB TRANSACTION
    // ========================================

    if (
      request.method === "POST" &&
      url.pathname === "/api/transactions"
    ) {
      try {
        const currentUser =
          await getCurrentUser(
            request,
            env.ppobku_db
          );

        if (!currentUser) {
          return Response.json(
            {
              success: false,
              error: "Silakan login terlebih dahulu."
            },
            { status: 401 }
          );
        }

        const body = await request.json();

        const {
          service,
          target,
          operator,
          productId,
          productName,
          price,
          paymentMethod
        } = body;

        if (
          !service ||
          !target ||
          !productName ||
          !paymentMethod
        ) {
          return Response.json(
            {
              success: false,
              error: "Data transaksi belum lengkap."
            },
            { status: 400 }
          );
        }

        const numericPrice = Number(price);

        if (
          !Number.isFinite(numericPrice) ||
          numericPrice < 0
        ) {
          return Response.json(
            {
              success: false,
              error: "Harga transaksi tidak valid."
            },
            { status: 400 }
          );
        }

        const transactionId =
          "PPOB-" + Date.now();

        const randomBytes =
          crypto.getRandomValues(
            new Uint8Array(4)
          );

        const reference =
          Array.from(randomBytes)
            .map(
              byte =>
                byte
                  .toString(16)
                  .padStart(2, "0")
            )
            .join("")
            .toUpperCase();

        const createdAt =
          new Date().toISOString();

        await env.ppobku_db
          .prepare(`
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
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?)
          `)
          .bind(
            currentUser.id,
            transactionId,
            reference,
            service,
            target,
            operator || null,
            productId || null,
            productName,
            numericPrice,
            paymentMethod,
            createdAt
          )
          .run();

        const transaction =
          await env.ppobku_db
            .prepare(`
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
            `)
            .bind(transactionId)
            .first();

        return Response.json(
          {
            success: true,
            message: "Transaksi berhasil disimpan.",
            transaction
          },
          { status: 201 }
        );

      } catch (error) {
        console.error(
          "[CREATE TRANSACTION]",
          error
        );

        return Response.json(
          {
            success: false,
            error: "Gagal menyimpan transaksi."
          },
          { status: 500 }
        );
      }
    }


    // ========================================
    // CREATE DIGITAL TRANSACTION
    // ========================================

    if (
      request.method === "POST" &&
      url.pathname === "/api/digital-transactions"
    ) {
      try {
        const body = await request.json();

        const {
          service,
          productIds,
          customerEmail,
          customerWhatsapp,
          device,
          paymentMethod = "xendit"
        } = body;

        if (
          !service ||
          !Array.isArray(productIds) ||
          !productIds.length ||
          !customerEmail ||
          !customerWhatsapp ||
          !device
        ) {
          return Response.json(
            {
              success: false,
              error:
                "Data pembelian digital belum lengkap."
            },
            { status: 400 }
          );
        }

        const email =
          String(customerEmail)
            .trim()
            .toLowerCase();

        const whatsapp =
          String(customerWhatsapp).trim();

        const selectedDevice =
          String(device).trim();

        if (
          !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
            email
          )
        ) {
          return Response.json(
            {
              success: false,
              error: "Format email tidak valid."
            },
            { status: 400 }
          );
        }

        if (!whatsapp) {
          return Response.json(
            {
              success: false,
              error: "Nomor WhatsApp wajib diisi."
            },
            { status: 400 }
          );
        }

        if (
          ![
            "iOS",
            "Android",
            "MacOS",
            "Windows"
          ].includes(selectedDevice)
        ) {
          return Response.json(
            {
              success: false,
              error: "Perangkat tidak valid."
            },
            { status: 400 }
          );
        }

        const uniqueProductIds = [
          ...new Set(
            productIds
              .map(id => String(id).trim())
              .filter(Boolean)
          )
        ];

        if (!uniqueProductIds.length) {
          return Response.json(
            {
              success: false,
              error: "Tidak ada produk yang dipilih."
            },
            { status: 400 }
          );
        }

        const placeholders =
          uniqueProductIds
            .map(() => "?")
            .join(",");

        const productsResult =
          await env.ppobku_db
            .prepare(`
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
            `)
            .bind(...uniqueProductIds)
            .all();

        const products =
          productsResult.results || [];

        if (
          products.length !==
          uniqueProductIds.length
        ) {
          return Response.json(
            {
              success: false,
              error:
                "Salah satu produk tidak ditemukan."
            },
            { status: 400 }
          );
        }

        const invalidProduct =
          products.find(
            product =>
              !Number(product.active) ||
              product.product_type !== "digital" ||
              !product.digital_file
          );

        if (invalidProduct) {
          return Response.json(
            {
              success: false,
              error:
                `Produk "${invalidProduct.name}" tidak tersedia untuk pembelian digital.`
            },
            { status: 400 }
          );
        }

        const invalidService =
          products.find(
            product =>
              product.service_id !== service
          );

        if (invalidService) {
          return Response.json(
            {
              success: false,
              error:
                "Produk tidak sesuai dengan layanan."
            },
            { status: 400 }
          );
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
          return Response.json(
            {
              success: false,
              error:
                "Total pembayaran tidak valid."
            },
            { status: 400 }
          );
        }

        const transactionId =
          "DIGITAL-" + Date.now();

        const randomBytes =
          crypto.getRandomValues(
            new Uint8Array(4)
          );

        const reference =
          Array.from(randomBytes)
            .map(
              byte =>
                byte
                  .toString(16)
                  .padStart(2, "0")
            )
            .join("")
            .toUpperCase();

        const createdAt =
          new Date().toISOString();

        const productName =
          products.length === 1
            ? products[0].name
            : `${products[0].name} + ${products.length - 1} preset lainnya`;

        const statements = [];

        statements.push(
          env.ppobku_db
            .prepare(`
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
                NULL,
                ?, ?, ?, ?, NULL, ?, ?, ?, ?,
                'PENDING', ?, ?, ?, ?
              )
            `)
            .bind(
              transactionId,
              reference,
              service,
              email,
              products.length === 1
                ? products[0].id
                : null,
              productName,
              total,
              paymentMethod,
              email,
              whatsapp,
              selectedDevice,
              createdAt
            )
        );

        for (const product of products) {
          const deviceFile =
            selectedDevice === "iOS"
              ? product.pdf_ios
              : selectedDevice === "Android"
                ? product.pdf_android
                : selectedDevice === "MacOS"
                  ? product.pdf_mac
                  : selectedDevice === "Windows"
                    ? product.pdf_windows
                    : null;

          statements.push(
            env.ppobku_db
              .prepare(`
                INSERT INTO digital_transaction_items (
                  transaction_id,
                  product_id,
                  product_name,
                  price,
                  digital_file,
                  device_file,
                  created_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?)
              `)
              .bind(
                transactionId,
                product.id,
                product.name,
                Number(product.price || 0),
                product.digital_file,
                deviceFile,
                createdAt
              )
          );
        }

        await env.ppobku_db.batch(
          statements
        );

        const transaction =
          await env.ppobku_db
            .prepare(`
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
            `)
            .bind(transactionId)
            .first();

        return Response.json(
          {
            success: true,
            message:
              "Transaksi digital berhasil disimpan.",
            transaction,
            customer: {
              email,
              whatsapp,
              device: selectedDevice
            },
            products: products.map(
              product => ({
                id: product.id,
                name: product.name,
                price: Number(
                  product.price || 0
                )
              })
            ),
            total
          },
          { status: 201 }
        );

      } catch (error) {
        console.error(
          "[CREATE DIGITAL TRANSACTION]",
          error
        );

        return Response.json(
          {
            success: false,
            error:
              "Gagal menyimpan transaksi digital."
          },
          { status: 500 }
        );
      }
    }


    // ========================================
    // HEALTH CHECK
    // ========================================

    if (
      request.method === "GET" &&
      url.pathname === "/api/health"
    ) {
      return Response.json({
        success: true,
        message: "PPOBKU server aktif",
        database: "connected"
      });
    }


    // ========================================
    
// =========================
// XENDIT PAYMENT
// =========================

if (url.pathname === "/api/payments/xendit" && request.method === "POST") {
  try {
    const currentUser =
      await getCurrentUser(
        request,
        env.ppobku_db
      );

    if (!currentUser) {
      return json({
        success: false,
        error: "Silakan login terlebih dahulu."
      }, 401);
    }

    const {
      transactionId,
      customerEmail,
      customerName
    } = await request.json();

    if (!transactionId) {
      return json({
        success: false,
        error: "transactionId wajib diisi."
      }, 400);
    }

    const transaction = await env.ppobku_db.prepare(`
      SELECT
        user_id AS userId,
        transaction_id AS transactionId,
        reference,
        product_name AS productName,
        price
      FROM transactions
      WHERE transaction_id = ?
    `).bind(transactionId).first();

    if (!transaction) {
      return json({
        success: false,
        error: "Transaksi tidak ditemukan."
      }, 404);
    }

    if (
      String(transaction.userId) !==
      String(currentUser.id)
    ) {
      return json({
        success: false,
        error: "Kamu tidak memiliki akses ke transaksi ini."
      }, 403);
    }

    if (!env.XENDIT_SECRET_KEY) {
      return json({
        success: false,
        error: "XENDIT_SECRET_KEY belum tersedia."
      }, 500);
    }

    if (!env.PUBLIC_BASE_URL) {
      return json({
        success: false,
        error: "PUBLIC_BASE_URL belum tersedia."
      }, 500);
    }

    const baseUrl = env.PUBLIC_BASE_URL.replace(/\/$/, "");

    const customerReferenceId =
      "CUST-" + crypto.randomUUID();

    const xenditResponse = await fetch(
      "https://api.xendit.co/sessions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization":
            "Basic " +
            btoa(env.XENDIT_SECRET_KEY + ":")
        },
        body: JSON.stringify({
          reference_id: transaction.reference,
          session_type: "PAY",
          mode: "PAYMENT_LINK",
          amount: Number(transaction.price),
          currency: "IDR",
          country: "ID",
          locale: "id",

          success_return_url:
            baseUrl +
            "/?payment=success&transactionId=" +
            encodeURIComponent(transactionId),

          cancel_return_url:
            baseUrl +
            "/?payment=cancel&transactionId=" +
            encodeURIComponent(transactionId),

          customer: {
            reference_id: customerReferenceId,
            type: "INDIVIDUAL",
            email:
              customerEmail || "test@example.com",
            individual_detail: {
              given_names:
                customerName || "Pelanggan"
            }
          }
        })
      }
    );

    const responseData =
      await xenditResponse.json();

    console.log(
      "[XENDIT SESSION RESPONSE CHECK]",
      JSON.stringify({
        paymentSessionId:
          responseData?.payment_session_id || null,
        paymentUrl:
          responseData?.payment_link_url || null,
        status:
          responseData?.status || null,
        allowedPaymentChannels:
          responseData?.allowed_payment_channels || null,
        paymentRequestId:
          responseData?.payment_request_id || null
      })
    );

    if (!xenditResponse.ok) {
      console.error(
        "Xendit error:",
        JSON.stringify(responseData)
      );

      return json({
        success: false,
        error: "Gagal membuat pembayaran Xendit."
      }, 500);
    }

    await env.ppobku_db.prepare(`
      UPDATE transactions
      SET
        payment_session_id = ?
      WHERE transaction_id = ?
    `).bind(
      responseData.payment_session_id || null,
      transactionId
    ).run();

    return json({
      success: true,
      paymentSessionId:
        responseData.payment_session_id,
      paymentUrl:
        responseData.payment_link_url
    });

  } catch (error) {
    console.error(
      "Xendit error:",
      error?.message || String(error)
    );

    return json({
      success: false,
      error: "Gagal membuat pembayaran Xendit."
    }, 500);
  }
}


// =========================
// XENDIT DIGITAL PAYMENT
// =========================

if (
  url.pathname === "/api/payments/xendit-digital" &&
  request.method === "POST"
) {
  try {
    const {
      transactionId,
      customerEmail,
      customerWhatsapp
    } = await request.json();

    if (!transactionId) {
      return json({
        success: false,
        error: "transactionId wajib diisi."
      }, 400);
    }

    const transaction = await env.ppobku_db.prepare(`
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
    `).bind(transactionId).first();

    if (!transaction) {
      return json({
        success: false,
        error: "Transaksi digital tidak ditemukan."
      }, 404);
    }

    if (
      !Number.isFinite(Number(transaction.price)) ||
      Number(transaction.price) <= 0
    ) {
      return json({
        success: false,
        error: "Total transaksi digital tidak valid."
      }, 400);
    }

    if (!env.XENDIT_SECRET_KEY) {
      return json({
        success: false,
        error: "XENDIT_SECRET_KEY belum tersedia."
      }, 500);
    }

    if (!env.PUBLIC_BASE_URL) {
      return json({
        success: false,
        error: "PUBLIC_BASE_URL belum tersedia."
      }, 500);
    }

    const itemsResult = await env.ppobku_db.prepare(`
      SELECT
        product_id AS productId,
        product_name AS productName,
        price
      FROM digital_transaction_items
      WHERE transaction_id = ?
      ORDER BY id ASC
    `).bind(transactionId).all();

    const items = itemsResult.results || [];

    if (!items.length) {
      return json({
        success: false,
        error: "Item produk digital tidak ditemukan."
      }, 400);
    }

    const baseUrl =
      env.PUBLIC_BASE_URL.replace(/\/$/, "");

    const customerReferenceId =
      "CUST-" + crypto.randomUUID();

    const xenditResponse = await fetch(
      "https://api.xendit.co/sessions",
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json",

          "Authorization":
            "Basic " +
            btoa(
              env.XENDIT_SECRET_KEY + ":"
            )
        },

        body: JSON.stringify({
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
            baseUrl +
            "/?payment=success&transactionId=" +
            encodeURIComponent(
              transactionId
            ),

          cancel_return_url:
            baseUrl +
            "/?payment=cancel&transactionId=" +
            encodeURIComponent(
              transactionId
            ),

          customer: {
            reference_id:
              customerReferenceId,

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
        })
      }
    );

    const responseData =
      await xenditResponse.json();

    console.log(
      "[XENDIT DIGITAL SESSION RESPONSE]",
      JSON.stringify({
        paymentSessionId:
          responseData?.payment_session_id ||
          null,

        paymentUrl:
          responseData?.payment_link_url ||
          null,

        status:
          responseData?.status ||
          null,

        paymentRequestId:
          responseData?.payment_request_id ||
          null
      })
    );

    if (!xenditResponse.ok) {
      console.error(
        "Xendit digital error:",
        JSON.stringify(responseData)
      );

      return json({
        success: false,
        error:
          "Gagal membuat pembayaran Xendit."
      }, 500);
    }

    await env.ppobku_db.prepare(`
      UPDATE transactions
      SET payment_session_id = ?
      WHERE transaction_id = ?
    `).bind(
      responseData.payment_session_id ||
        null,
      transactionId
    ).run();

    

    return json({
      success: true,

      paymentSessionId:
        responseData.payment_session_id,

      paymentUrl:
        responseData.payment_link_url
    });

  } catch (error) {
    console.error(
      "Xendit digital error:",
      error?.message ||
      String(error)
    );

    return json({
      success: false,
      error:
        "Gagal membuat pembayaran Xendit."
    }, 500);
  }
}


// ==========================================================
// TRANSACTION STATUS + XENDIT DIGITAL SYNC
// ==========================================================

function hashDigitalDownloadTokenWorker(token) {
  return createHash("sha256")
    .update(String(token))
    .digest("hex");
}

async function createOrRefreshDigitalDownloadTokenWorker(
  env,
  transactionId
) {
  const token = randomBytes(32).toString("hex");

  const tokenHash =
    hashDigitalDownloadTokenWorker(token);

  const now = new Date();

  const expires = new Date(
    now.getTime() + 1000 * 60 * 60 * 24 * 30
  );

  await env.ppobku_db.prepare(`
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
  `).bind(
    transactionId,
    tokenHash,
    now.toISOString(),
    expires.toISOString()
  ).run();

  return token;
}



/* ==========================================================
   DIGITAL DOWNLOAD TOKEN VERIFICATION
========================================================== */

async function verifyDigitalDownloadTokenWorker(
  env,
  transactionId,
  token
) {
  if (!transactionId || !token) return false;

  const row =
    await env.ppobku_db.prepare(`
      SELECT
        transaction_id AS transactionId,
        token_hash AS tokenHash,
        expires_at AS expiresAt
      FROM digital_download_tokens
      WHERE transaction_id = ?
      LIMIT 1
    `).bind(transactionId).first();

  if (!row || !row.tokenHash) return false;

  if (
    row.expiresAt &&
    Date.now() >=
      new Date(row.expiresAt).getTime()
  ) {
    return false;
  }

  const suppliedHash =
    await hashDigitalDownloadTokenWorker(token);

  return suppliedHash === String(row.tokenHash);
}


/* ==========================================================
   R2 DIGITAL FILE HELPER
========================================================== */

function digitalR2Key(value) {
  const raw =
    String(value || "")
      .trim()
      .replace(/^\/+/, "");

  if (!raw) return null;

  /*
   * Database menyimpan path:
   * /uploads/digital/files/nama.zip
   *
   * R2 key:
   * digital/files/nama.zip
   */
  if (
    raw.startsWith("uploads/digital/files/")
  ) {
    return raw.slice("uploads/".length);
  }

  if (
    raw.startsWith("digital/files/")
  ) {
    return raw;
  }

  return null;
}


async function getDigitalR2Object(
  env,
  storedPath
) {
  const key = digitalR2Key(storedPath);

  if (!key) return null;

  return await env.ppobku_files.get(key);
}


/* ==========================================================
   DIGITAL FILE DOWNLOAD
========================================================== */

if (
  request.method === "GET" &&
  url.pathname.startsWith(
    "/api/digital-products/download/"
  )
) {
  try {
    const transactionId =
      decodeURIComponent(
        url.pathname.slice(
          "/api/digital-products/download/".length
        )
      ).trim();

    const authorization =
      request.headers.get("Authorization") || "";

    const bearerToken =
      authorization
        .replace(/^Bearer\s+/i, "")
        .trim();

    const queryToken =
      url.searchParams.get("token") || "";

    const downloadToken =
      bearerToken || queryToken;

    if (
      !transactionId ||
      !(await verifyDigitalDownloadTokenWorker(
        env,
        transactionId,
        downloadToken
      ))
    ) {
      return json({
        success: false,
        error:
          "Akses download tidak valid atau sudah kedaluwarsa."
      }, 401);
    }

    const transaction =
      await env.ppobku_db.prepare(`
        SELECT
          t.transaction_id AS transactionId,
          t.payment_status AS paymentStatus,
          t.product_name AS productName,
          t.service,
          t.product_id AS productId
        FROM transactions t
        WHERE t.transaction_id = ?
        LIMIT 1
      `).bind(transactionId).first();

    if (!transaction) {
      return json({
        success: false,
        error: "Transaksi tidak ditemukan."
      }, 404);
    }

    if (
      transaction.paymentStatus !== "PAID"
    ) {
      return json({
        success: false,
        error:
          "Pembayaran belum dikonfirmasi."
      }, 403);
    }

    const itemsResult =
      await env.ppobku_db.prepare(`
        SELECT
          product_id AS productId,
          product_name AS productName,
          digital_file AS digitalFile
        FROM digital_transaction_items
        WHERE transaction_id = ?
        ORDER BY id ASC
      `).bind(transactionId).all();

    const items =
      itemsResult.results || [];

    if (!items.length) {
      return json({
        success: false,
        error:
          "File preset transaksi tidak ditemukan."
      }, 404);
    }

    const files = [];

    for (const item of items) {
      if (!item.digitalFile) continue;

      let object =
        await getDigitalR2Object(
          env,
          item.digitalFile
        );

      /*
       * Jika file transaksi lama sudah tidak ada,
       * coba digital_file terbaru dari products.
       */
      if (!object && item.productId) {
        const product =
          await env.ppobku_db.prepare(`
            SELECT digital_file AS digitalFile
            FROM products
            WHERE id = ?
            LIMIT 1
          `).bind(item.productId).first();

        if (product?.digitalFile) {
          object =
            await getDigitalR2Object(
              env,
              product.digitalFile
            );
        }
      }

      if (!object) {
        console.error(
          "[DIGITAL DOWNLOAD] R2 object tidak ditemukan:",
          item.digitalFile
        );
        continue;
      }

      files.push({
        object,
        name:
          item.productName ||
          "Preset"
      });
    }

    if (!files.length) {
      return json({
        success: false,
        error:
          "File preset belum tersedia."
      }, 404);
    }

    /*
     * Cloudflare Worker tidak bisa membuat ZIP baru
     * dengan archiver seperti server Node lama.
     *
     * Untuk single preset, kirim ZIP asli.
     */
    if (files.length === 1) {
      let downloadFileName =
        files[0].name + ".zip";

      if (
        transaction.service ===
        "lightroom-preset"
      ) {
        const safeProductName =
          String(
            transaction.productName ||
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

      const headers =
        new Headers();

      files[0].object.writeHttpMetadata(
        headers
      );

      headers.set(
        "Content-Disposition",
        `attachment; filename="${downloadFileName}"`
      );

      if (!headers.get("Content-Type")) {
        headers.set(
          "Content-Type",
          "application/zip"
        );
      }

      return new Response(
        files[0].object.body,
        {
          status: 200,
          headers
        }
      );
    }

    return json({
      success: false,
      error:
        "Transaksi multi-produk belum mendukung penggabungan ZIP di Cloudflare Worker."
    }, 501);

  } catch (error) {
    console.error(
      "[DIGITAL DOWNLOAD ERROR]",
      error?.message || String(error)
    );

    return json({
      success: false,
      error:
        "Gagal menyediakan file digital."
    }, 500);
  }
}


/* ==========================================================
   DIGITAL GUIDE DOWNLOAD
========================================================== */

if (
  request.method === "GET" &&
  url.pathname.startsWith(
    "/api/digital-products/download-guide/"
  )
) {
  try {
    const transactionId =
      decodeURIComponent(
        url.pathname.slice(
          "/api/digital-products/download-guide/".length
        )
      ).trim();

    const authorization =
      request.headers.get("Authorization") || "";

    const bearerToken =
      authorization
        .replace(/^Bearer\s+/i, "")
        .trim();

    const queryToken =
      url.searchParams.get("token") || "";

    const downloadToken =
      bearerToken || queryToken;

    if (
      !transactionId ||
      !(await verifyDigitalDownloadTokenWorker(
        env,
        transactionId,
        downloadToken
      ))
    ) {
      return json({
        success: false,
        error:
          "Akses download tidak valid atau sudah kedaluwarsa."
      }, 401);
    }

    const transaction =
      await env.ppobku_db.prepare(`
        SELECT
          transaction_id AS transactionId,
          payment_status AS paymentStatus,
          service,
          device,
          product_id AS productId,
          product_name AS productName
        FROM transactions
        WHERE transaction_id = ?
        LIMIT 1
      `).bind(transactionId).first();

    if (!transaction) {
      return json({
        success: false,
        error: "Transaksi tidak ditemukan."
      }, 404);
    }

    if (
      transaction.paymentStatus !== "PAID"
    ) {
      return json({
        success: false,
        error:
          "Pembayaran belum dikonfirmasi."
      }, 403);
    }

    const item =
      await env.ppobku_db.prepare(`
        SELECT
          device_file AS deviceFile
        FROM digital_transaction_items
        WHERE transaction_id = ?
        LIMIT 1
      `).bind(transactionId).first();

    if (!item?.deviceFile) {
      return json({
        success: false,
        error:
          "Panduan penggunaan belum tersedia."
      }, 404);
    }

    const object =
      await getDigitalR2Object(
        env,
        item.deviceFile
      );

    if (!object) {
      return json({
        success: false,
        error:
          "File panduan belum tersedia."
      }, 404);
    }

    const device =
      String(
        transaction.device ||
        "DEVICE"
      )
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9_-]+/g, "-");

    const downloadFileName =
      "BAYORA-" +
      device +
      "-PANDUAN.pdf";

    const headers =
      new Headers();

    object.writeHttpMetadata(headers);

    headers.set(
      "Content-Disposition",
      `attachment; filename="${downloadFileName}"`
    );

    headers.set(
      "Content-Type",
      "application/pdf"
    );

    return new Response(
      object.body,
      {
        status: 200,
        headers
      }
    );

  } catch (error) {
    console.error(
      "[DIGITAL GUIDE DOWNLOAD ERROR]",
      error?.message || String(error)
    );

    return json({
      success: false,
      error:
        "Gagal menyediakan file panduan."
    }, 500);
  }
}


/* ==========================================================
   EMAIL DOWNLOAD REDIRECT
========================================================== */

if (
  request.method === "GET" &&
  (
    url.pathname.startsWith(
      "/api/digital-products/email-download/"
    ) ||
    url.pathname.startsWith(
      "/api/digital-products/email-guide-download/"
    )
  )
) {
  /*
   * Endpoint email memakai token query.
   * Redirect ke endpoint download utama dengan token
   * yang sama agar hanya ada satu implementasi R2.
   */
  const isGuide =
    url.pathname.startsWith(
      "/api/digital-products/email-guide-download/"
    );

  const prefix =
    isGuide
      ? "/api/digital-products/email-guide-download/"
      : "/api/digital-products/email-download/";

  const transactionId =
    decodeURIComponent(
      url.pathname.slice(prefix.length)
    ).trim();

  const token =
    url.searchParams.get("token") || "";

  if (!transactionId || !token) {
    return json({
      success: false,
      error:
        "Link download tidak valid."
    }, 400);
  }

  const target =
    new URL(request.url);

  target.pathname =
    isGuide
      ? "/api/digital-products/download-guide/" +
        encodeURIComponent(transactionId)
      : "/api/digital-products/download/" +
        encodeURIComponent(transactionId);

  target.search = "";

  target.searchParams.set(
    "token",
    token
  );

  return Response.redirect(
    target.toString(),
    302
  );
}


/* ==========================================================
   DIGITAL PRODUCT EMAIL DELIVERY — RESEND
========================================================== */

async function sendDigitalProductEmailWorker(
  env,
  transactionId
) {
  const resendApiKey =
    env.RESEND_API_KEY;

  const fromEmail =
    env.RESEND_FROM_EMAIL;

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
    await env.ppobku_db.prepare(`
      SELECT
        transaction_id AS transactionId,
        payment_status AS paymentStatus,
        delivery_status AS deliveryStatus,
        customer_email AS customerEmail,
        product_name AS productName,
        device
      FROM transactions
      WHERE transaction_id = ?
        AND transaction_id LIKE 'DIGITAL-%'
      LIMIT 1
    `).bind(transactionId).first();

  if (!transaction) {
    throw new Error(
      "Transaksi digital tidak ditemukan."
    );
  }

  if (
    transaction.paymentStatus !== "PAID"
  ) {
    throw new Error(
      "Transaksi digital belum PAID."
    );
  }

  if (
    transaction.deliveryStatus === "SENT"
  ) {
    return {
      skipped: true,
      reason:
        "DELIVERY_SUDAH_TERKIRIM"
    };
  }

  if (!transaction.customerEmail) {
    throw new Error(
      "Email pelanggan tidak tersedia."
    );
  }

  const claim =
    await env.ppobku_db.prepare(`
      UPDATE transactions
      SET delivery_status = 'PROCESSING'
      WHERE transaction_id = ?
        AND payment_status = 'PAID'
        AND transaction_id LIKE 'DIGITAL-%'
        AND (
          delivery_status IS NULL
          OR delivery_status = 'PENDING'
          OR delivery_status = 'FAILED'
        )
    `).bind(transactionId).run();

  if (
    Number(claim.meta?.changes || 0) === 0
  ) {
    const current =
      await env.ppobku_db.prepare(`
        SELECT delivery_status AS deliveryStatus
        FROM transactions
        WHERE transaction_id = ?
        LIMIT 1
      `).bind(transactionId).first();

    return {
      skipped: true,
      reason:
        "DELIVERY_SUDAH_DIAMBIL_ALIH_PROSES_LAIN",
      deliveryStatus:
        current?.deliveryStatus || null
    };
  }

  try {
    const downloadToken =
      await createOrRefreshDigitalDownloadTokenWorker(
        env,
        transactionId
      );

    const publicBaseUrl =
      String(
        env.PUBLIC_BASE_URL ||
        env.APP_URL ||
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

    const html = `
      <div style="margin:0;padding:0;background:#f5f9ff;font-family:Arial,Helvetica,sans-serif;color:#10244d;">
        <div style="max-width:620px;margin:0 auto;padding:40px 20px;">
          <div style="background:#ffffff;border:1px solid rgba(20,201,244,.18);border-radius:20px;overflow:hidden;box-shadow:0 20px 55px rgba(6,26,69,.10);">

            <div style="padding:34px 30px 30px;text-align:center;background:linear-gradient(100deg,#061a45,#0b2c68);">
              <div style="font-size:27px;font-weight:900;letter-spacing:-1px;color:#ffffff;">
                BAYORA
              </div>
              <div style="margin-top:8px;font-size:10px;font-weight:700;letter-spacing:2px;color:#14c9f4;">
                LIGHTROOM PRESETS
              </div>
              <div style="width:42px;height:4px;border-radius:999px;margin:18px auto 0;background:linear-gradient(90deg,#14c9f4,#1268ff);"></div>
            </div>

            <div style="padding:38px 34px 36px;">
              <div style="font-size:25px;font-weight:800;line-height:1.3;color:#10244d;margin-bottom:16px;">
                Pesanan kamu sudah siap ✨
              </div>

              <p style="font-size:15px;line-height:1.8;color:#64748b;margin:0 0 28px;">
                Terima kasih telah memilih <strong style="color:#1268ff;">BAYORA</strong>.
                Pembayaran kamu telah berhasil dikonfirmasi.
                Produk Lightroom yang kamu pesan kini sudah siap digunakan.
              </p>

              <div style="background:#f5f9ff;border:1px solid rgba(20,201,244,.18);border-radius:16px;padding:22px;margin-bottom:28px;">
                <div style="font-size:10px;font-weight:800;letter-spacing:1.7px;color:#1268ff;margin-bottom:15px;">
                  DETAIL PESANAN
                </div>

                <div style="font-size:14px;line-height:1.7;color:#64748b;">
                  <span>Produk</span>
                  <strong style="float:right;color:#10244d;">
                    ${transaction.productName || "Lightroom Preset"}
                  </strong>
                </div>

                <div style="margin-top:10px;font-size:14px;line-height:1.7;color:#64748b;">
                  <span>Perangkat</span>
                  <strong style="float:right;color:#10244d;">
                    ${transaction.device || "perangkat yang dipilih"}
                  </strong>
                </div>
              </div>

              <p style="font-size:14px;line-height:1.8;color:#64748b;margin:0 0 24px;">
                File preset dan panduan penggunaan untuk perangkat yang kamu pilih
                sudah siap untuk di-download melalui tombol di bawah.
              </p>

              <div style="border-top:1px solid rgba(20,201,244,.18);border-bottom:1px solid rgba(20,201,244,.18);padding:22px 0;margin-bottom:27px;">
                <div style="font-size:10px;font-weight:800;letter-spacing:1.7px;color:#1268ff;margin-bottom:18px;">
                  FILE PESANAN
                </div>

                <a href="${presetDownloadUrl}"
                   style="display:block;width:100%;box-sizing:border-box;padding:14px 20px;margin-bottom:12px;background:#1268ff;color:#ffffff;text-decoration:none;text-align:center;border-radius:10px;font-size:14px;font-weight:800;">
                  ↓&nbsp; Download Preset
                </a>

                <a href="${guideDownloadUrl}"
                   style="display:block;width:100%;box-sizing:border-box;padding:14px 20px;background:#ffffff;color:#1268ff;text-decoration:none;text-align:center;border:1px solid #1268ff;border-radius:10px;font-size:14px;font-weight:800;">
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
    `;

    const resendResponse =
      await fetch(
        "https://api.resend.com/emails",
        {
          method: "POST",
          headers: {
            "Authorization":
              "Bearer " + resendApiKey,
            "Content-Type":
              "application/json"
          },
          body: JSON.stringify({
            from: fromEmail,
            to: [
              transaction.customerEmail
            ],
            subject:
              "BAYORA — Produk Lightroom Kamu Sudah Siap ✨",
            html
          })
        }
      );

    const resendData =
      await resendResponse.json();

    if (!resendResponse.ok) {
      throw new Error(
        resendData?.message ||
        resendData?.error ||
        JSON.stringify(resendData)
      );
    }

    await env.ppobku_db.prepare(`
      UPDATE transactions
      SET delivery_status = 'SENT'
      WHERE transaction_id = ?
    `).bind(transactionId).run();

    console.log(
      "[DIGITAL DELIVERY] Email berhasil dikirim:",
      JSON.stringify({
        transactionId
      })
    );

    console.log(
      "[RESEND EMAIL ID]",
      resendData?.id ||
      "ID TIDAK TERSEDIA"
    );

    return {
      success: true,
      deliveryStatus: "SENT",
      email: transaction.customerEmail
    };

  } catch (error) {
    await env.ppobku_db.prepare(`
      UPDATE transactions
      SET delivery_status = 'FAILED'
      WHERE transaction_id = ?
        AND delivery_status = 'PROCESSING'
    `).bind(transactionId).run();

    console.error(
      "[DIGITAL DELIVERY ERROR]",
      transactionId,
      error?.message || String(error)
    );

    throw error;
  }
}



/* ==========================================================
   POST /api/transactions/:id/sync-xendit-ppob
   Sinkronisasi pembayaran Xendit untuk PPOB lalu HAYBI
========================================================== */

if (
  request.method === "POST" &&
  url.pathname.startsWith("/api/transactions/") &&
  url.pathname.endsWith("/sync-xendit-ppob")
) {
  try {
    const currentUser =
      await getCurrentUser(
        request,
        env.ppobku_db
      );

    if (!currentUser) {
      return json({
        success: false,
        error: "Silakan login terlebih dahulu."
      }, 401);
    }

    const transactionId = decodeURIComponent(
      url.pathname
        .slice("/api/transactions/".length)
        .replace(/\/sync-xendit-ppob$/, "")
    ).trim();

    if (!transactionId) {
      return json({
        success: false,
        error: "Transaction ID wajib diisi."
      }, 400);
    }

    if (transactionId.startsWith("DIGITAL-")) {
      return json({
        success: false,
        error: "Route ini hanya untuk transaksi PPOB."
      }, 400);
    }

    const transaction =
      await env.ppobku_db.prepare(`
        SELECT
          t.user_id AS userId,
          t.transaction_id AS transactionId,
          t.payment_method AS paymentMethod,
          t.payment_status AS paymentStatus,
          t.status,
          t.payment_session_id AS paymentSessionId,
          t.payment_request_id AS paymentRequestId,
          t.digiflazz_status AS digiflazzStatus,
          t.digiflazz_ref AS digiflazzRef,
          p.product_type AS productType,
          p.digiflazz_sku AS digiflazzSku
        FROM transactions t
        LEFT JOIN products p
          ON p.id = t.product_id
        WHERE t.transaction_id = ?
        LIMIT 1
      `).bind(transactionId).first();

    if (!transaction) {
      return json({
        success: false,
        error: "Transaksi tidak ditemukan."
      }, 404);
    }

    if (
      String(transaction.userId) !==
      String(currentUser.id)
    ) {
      return json({
        success: false,
        error: "Kamu tidak memiliki akses ke transaksi ini."
      }, 403);
    }

    if (transaction.productType === "digital") {
      return json({
        success: false,
        error: "Produk digital harus menggunakan sync digital."
      }, 400);
    }

    if (
      String(transaction.paymentMethod || "")
        .toLowerCase() !== "xendit"
    ) {
      return json({
        success: false,
        error: "Transaksi bukan pembayaran Xendit."
      }, 400);
    }

    /*
     * Jika pembayaran sebelumnya sudah berhasil disinkronkan,
     * jangan memeriksa/mengubah pembayaran lagi.
     *
     * Cukup lanjutkan fulfillment HAYBI.
     * Helper memiliki anti-double-order sendiri.
     */
    if (transaction.paymentStatus === "PAID") {
      const haybi =
        await sendTransactionToHaybiWorker(
          env,
          transactionId
        );

      return json({
        success: true,
        changed: false,
        paymentStatus: "PAID",
        haybi
      });
    }

    if (!transaction.paymentSessionId) {
      return json({
        success: false,
        error: "payment_session_id belum tersedia."
      }, 409);
    }

    if (!env.XENDIT_SECRET_KEY) {
      console.error(
        "[XENDIT PPOB SYNC] XENDIT_SECRET_KEY belum tersedia."
      );

      return json({
        success: false,
        error: "XENDIT_SECRET_KEY belum tersedia."
      }, 500);
    }

    const xenditResponse = await fetch(
      "https://api.xendit.co/sessions/" +
      encodeURIComponent(transaction.paymentSessionId),
      {
        method: "GET",
        headers: {
          "Authorization":
            "Basic " +
            btoa(env.XENDIT_SECRET_KEY + ":")
        }
      }
    );

    const session =
      await xenditResponse.json().catch(() => ({}));

    if (!xenditResponse.ok) {
      console.error(
        "[XENDIT PPOB SYNC ERROR]",
        JSON.stringify(session)
      );

      return json({
        success: false,
        error: "Gagal memeriksa status pembayaran Xendit."
      }, 502);
    }

    const sessionStatus =
      String(session?.status || "")
        .toUpperCase();

    console.log(
      "[XENDIT PPOB SYNC]",
      JSON.stringify({
        transactionId,
        paymentSessionId:
          transaction.paymentSessionId,
        sessionStatus,
        paymentRequestId:
          session?.payment_request_id || null
      })
    );

    if (sessionStatus === "COMPLETED") {
      const paymentRequestId =
        session?.payment_request_id ||
        transaction.paymentRequestId ||
        null;

      /*
       * PPOB belum SUCCESS pada tahap ini.
       * Ini baru menandai pembayaran sebagai PAID.
       * SUCCESS ditentukan oleh respons HAYBI.
       */
      const update =
        await env.ppobku_db.prepare(`
          UPDATE transactions
          SET
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
            )
          WHERE transaction_id = ?
            AND payment_method = 'xendit'
            AND payment_status != 'PAID'
        `).bind(
          transaction.paymentSessionId,
          paymentRequestId,
          transactionId
        ).run();

      console.log(
        "[XENDIT PPOB SYNC] PAYMENT PAID:",
        JSON.stringify({
          transactionId,
          changes: update.meta?.changes ?? null
        })
      );

      const haybi =
        await sendTransactionToHaybiWorker(
          env,
          transactionId
        );

      return json({
        success: true,
        changed:
          Number(update.meta?.changes || 0) > 0,
        paymentStatus: "PAID",
        haybi
      });
    }

    if (
      sessionStatus === "ACTIVE" ||
      sessionStatus === "PENDING" ||
      sessionStatus === ""
    ) {
      return json({
        success: true,
        changed: false,
        paymentStatus: "PENDING",
        status: "PENDING",
        xenditStatus:
          sessionStatus || "UNKNOWN"
      });
    }

    return json({
      success: true,
      changed: false,
      paymentStatus: transaction.paymentStatus,
      status: transaction.status,
      xenditStatus: sessionStatus
    });

  } catch (error) {
    console.error(
      "[XENDIT PPOB SYNC ERROR]",
      error?.stack ||
      error?.message ||
      String(error)
    );

    return json({
      success: false,
      error:
        error?.message ||
        "Gagal melakukan sinkronisasi pembayaran PPOB."
    }, 500);
  }
}


/* ==========================================================
   POST /api/transactions/:id/sync-xendit
   Khusus transaksi DIGITAL-*
========================================================== */

if (
  request.method === "POST" &&
  url.pathname.startsWith("/api/transactions/") &&
  url.pathname.endsWith("/sync-xendit")
) {
  try {
    const transactionId = decodeURIComponent(
      url.pathname
        .slice("/api/transactions/".length)
        .replace(/\/sync-xendit$/, "")
    ).trim();

    if (!transactionId) {
      return json({
        success: false,
        error: "Transaction ID wajib diisi."
      }, 400);
    }

    if (!transactionId.startsWith("DIGITAL-")) {
      return json({
        success: false,
        error:
          "Sync Xendit hanya untuk transaksi digital."
      }, 400);
    }

    const transaction =
      await env.ppobku_db.prepare(`
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
        LIMIT 1
      `).bind(transactionId).first();

    if (!transaction) {
      return json({
        success: false,
        error: "Transaksi tidak ditemukan."
      }, 404);
    }

    if (
      String(transaction.paymentMethod || "")
        .toLowerCase() !== "xendit"
    ) {
      return json({
        success: false,
        error: "Transaksi bukan pembayaran Xendit."
      }, 400);
    }

    if (transaction.paymentStatus === "PAID") {
      const downloadToken =
        await createOrRefreshDigitalDownloadTokenWorker(
          env,
          transaction.transactionId
        );

      return json({
        success: true,
        changed: false,
        paymentStatus: "PAID",
        status: transaction.status,
        downloadToken
      });
    }

    if (!transaction.paymentSessionId) {
      return json({
        success: false,
        error: "payment_session_id belum tersedia."
      }, 409);
    }

    if (!env.XENDIT_SECRET_KEY) {
      console.error(
        "[XENDIT SYNC] XENDIT_SECRET_KEY belum tersedia."
      );

      return json({
        success: false,
        error: "XENDIT_SECRET_KEY belum tersedia."
      }, 500);
    }

    const xenditResponse = await fetch(
      "https://api.xendit.co/sessions/" +
      encodeURIComponent(transaction.paymentSessionId),
      {
        method: "GET",
        headers: {
          "Authorization":
            "Basic " +
            btoa(env.XENDIT_SECRET_KEY + ":")
        }
      }
    );

    const session =
      await xenditResponse.json();

    if (!xenditResponse.ok) {
      console.error(
        "[XENDIT SYNC ERROR]",
        JSON.stringify(session)
      );

      return json({
        success: false,
        error:
          "Gagal memeriksa status pembayaran Xendit."
      }, 502);
    }

    const sessionStatus =
      String(session?.status || "")
        .toUpperCase();

    console.log(
      "[XENDIT SYNC]",
      JSON.stringify({
        transactionId,
        paymentSessionId:
          transaction.paymentSessionId,
        sessionStatus,
        paymentRequestId:
          session?.payment_request_id || null
      })
    );

    if (sessionStatus === "COMPLETED") {
      const paymentRequestId =
        session?.payment_request_id ||
        transaction.paymentRequestId ||
        null;

      const update =
        await env.ppobku_db.prepare(`
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
        `).bind(
          transaction.paymentSessionId,
          paymentRequestId,
          transactionId
        ).run();

      console.log(
        "[XENDIT SYNC] PAYMENT PAID:",
        JSON.stringify({
          transactionId,
          changes: update.meta?.changes ?? null
        })
      );

      const changed =
        Number(update.meta?.changes || 0) > 0;

      const downloadToken =
        await createOrRefreshDigitalDownloadTokenWorker(
          env,
          transactionId
        );

      /*
       * Kirim email hanya ketika status benar-benar
       * berubah menjadi PAID pada proses ini.
       *
       * Jangan await, supaya respons pembayaran tidak
       * tertahan oleh Resend.
       */
      if (changed) {
        try {
          await sendDigitalProductEmailWorker(
            env,
            transactionId
          );
        } catch (emailError) {
          console.error(
            "[XENDIT SYNC] Gagal mengirim email digital:",
            emailError?.message ||
            String(emailError)
          );
        }
      }

      return json({
        success: true,
        changed,
        paymentStatus: "PAID",
        status: "SUCCESS",
        downloadToken
      });
    }

    if (
      sessionStatus === "ACTIVE" ||
      sessionStatus === "PENDING" ||
      sessionStatus === ""
    ) {
      return json({
        success: true,
        changed: false,
        paymentStatus: "PENDING",
        status: "PENDING",
        xenditStatus:
          sessionStatus || "UNKNOWN"
      });
    }

    return json({
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
      error?.message || String(error)
    );

    return json({
      success: false,
      error:
        "Gagal memeriksa status pembayaran Xendit."
    }, 502);
  }
}


/* ==========================================================
   GET /api/transactions/:id
========================================================== */

if (
  request.method === "GET" &&
  url.pathname.startsWith("/api/transactions/")
) {
  try {
    const transactionId = decodeURIComponent(
      url.pathname.slice(
        "/api/transactions/".length
      )
    ).trim();

    if (
      !transactionId ||
      transactionId.includes("/")
    ) {
      return json({
        success: false,
        error: "Transaction ID tidak valid."
      }, 400);
    }

    const transaction =
      await env.ppobku_db.prepare(`
        SELECT
          t.id,
          t.user_id AS userId,
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
          t.provider,
          t.haybi_status AS haybiStatus,
          t.haybi_ref AS haybiRef,
          t.haybi_rc AS haybiRc,
          t.haybi_message AS haybiMessage,
          t.haybi_sn AS haybiSn,

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
        LIMIT 1
      `).bind(transactionId).first();

    if (!transaction) {
      return json({
        success: false,
        error: "Transaksi tidak ditemukan."
      }, 404);
    }

    /*
     * DIGITAL tetap mendukung guest checkout.
     *
     * Transaksi non-digital/PPOB dibuat oleh user login,
     * sehingga status transaksi hanya boleh dibaca oleh
     * pemilik transaksi tersebut.
     */
    if (transaction.productType !== "digital") {
      const currentUser =
        await getCurrentUser(
          request,
          env.ppobku_db
        );

      if (!currentUser) {
        return json({
          success: false,
          error: "Silakan login terlebih dahulu."
        }, 401);
      }

      if (
        String(transaction.userId) !==
        String(currentUser.id)
      ) {
        return json({
          success: false,
          error: "Kamu tidak memiliki akses ke transaksi ini."
        }, 403);
      }
    }

    /*
     * GET tidak pernah membuat order baru.
     *
     * Jika order PPOB sudah pernah dikirim ke HAYBI dan masih
     * menunggu hasil final, polling frontend boleh mengecek
     * status order tersebut menggunakan ref_id yang sama.
     */
    if (
      transaction.productType !== "digital" &&
      transaction.paymentStatus === "PAID" &&
      transaction.provider === "HAYBI" &&
      transaction.haybiRef &&
      (
        transaction.haybiStatus === "PENDING" ||
        transaction.haybiStatus === "PROCESSING"
      )
    ) {
      try {
        await checkHaybiTransactionStatus(
          env,
          transactionId
        );

        /*
         * Ambil ulang data setelah cek-status supaya frontend
         * langsung menerima status terbaru dari D1.
         */
        const updated =
          await env.ppobku_db.prepare(`
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
              t.provider,
              t.haybi_status AS haybiStatus,
              t.haybi_ref AS haybiRef,
              t.haybi_rc AS haybiRc,
              t.haybi_message AS haybiMessage,
              t.haybi_sn AS haybiSn,

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
            LIMIT 1
          `).bind(transactionId).first();

        if (updated) {
          return json({
            success: true,
            transaction: updated
          });
        }

      } catch (haybiError) {
        /*
         * Gangguan cek-status provider tidak membuat endpoint
         * transaksi ikut gagal. Frontend tetap menerima status
         * terakhir yang tersimpan di database.
         */
        console.error(
          "[HAYBI STATUS CHECK ERROR]",
          transactionId,
          haybiError?.message || String(haybiError)
        );
      }
    }

    return json({
      success: true,
      transaction
    });

  } catch (error) {
    console.error(
      "[GET TRANSACTION ERROR]",
      error?.message || String(error)
    );

    return json({
      success: false,
      error: "Gagal mengambil transaksi."
    }, 500);
  }
}


// 404
    // ========================================

    return Response.json(
      {
        success: false,
        message: "Endpoint tidak ditemukan"
      },
      { status: 404 }
    );
  }
};