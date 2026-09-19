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





// ========================================
// SMM PROVIDER — DJURAGANSOSMED
// SAFE ADAPTER: BALANCE + SERVICES ONLY
// ========================================

async function callDjuraganSosmedWorker(
  env,
  action
) {
  const allowedActions = new Set([
    "balance",
    "services"
  ]);

  const cleanAction =
    String(action || "")
      .trim()
      .toLowerCase();

  if (!allowedActions.has(cleanAction)) {
    throw new Error(
      "Aksi DjuraganSosmed tidak diizinkan."
    );
  }

  const apiKey =
    String(
      env.DJURAGANSOSMED_API_KEY || ""
    ).trim();

  if (!apiKey) {
    throw new Error(
      "DJURAGANSOSMED_API_KEY belum dikonfigurasi."
    );
  }

  const apiUrl =
    "https://djuragansosmed.com/api/v2";

  const body =
    new URLSearchParams();

  body.set("key", apiKey);
  body.set("action", cleanAction);

  const response =
    await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type":
          "application/x-www-form-urlencoded"
      },
      body: body.toString()
    });

  const raw =
    await response.text();

  let data;

  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(
      `DjuraganSosmed mengembalikan response non-JSON (HTTP ${response.status}).`
    );
  }

  if (!response.ok) {
    throw new Error(
      `DjuraganSosmed HTTP ${response.status}.`
    );
  }

  return data;
}


// ========================================
// SMM — DJURAGANSOSMED AUTOMATIC CATALOG SYNC
// CATALOG ONLY — NEVER CREATES PROVIDER ORDERS
// ========================================

async function syncDjuraganSosmedCatalogWorker(env) {
  const CHUNK_SIZE = 100;
  const MIN_CATALOG_SIZE = 100;
  const MIN_VALID_RATIO = 0.8;
  const MIN_EXISTING_RATIO = 0.7;

  const now = new Date().toISOString();

  const provider =
    await env.ppobku_db.prepare(`
      SELECT id, name, active
      FROM smm_providers
      WHERE LOWER(name) = 'djuragansosmed'
      LIMIT 1
    `).first();

  if (!provider) {
    throw new Error(
      "Provider DjuraganSosmed tidak ditemukan."
    );
  }

  if (Number(provider.active) !== 1) {
    throw new Error(
      "Provider DjuraganSosmed sedang nonaktif."
    );
  }

  const providerId = Number(provider.id);

  const saveError = async message => {
    try {
      await env.ppobku_db.prepare(`
        INSERT INTO smm_sync_state (
          provider_id,
          offset,
          catalog_total,
          processed_total,
          last_run_at,
          last_error
        )
        VALUES (?, 0, 0, 0, ?, ?)
        ON CONFLICT(provider_id)
        DO UPDATE SET
          last_run_at = excluded.last_run_at,
          last_error = excluded.last_error
      `)
        .bind(
          providerId,
          now,
          String(message || "Unknown sync error")
            .slice(0, 1000)
        )
        .run();
    } catch (stateError) {
      console.error(
        "[SMM AUTO SYNC STATE ERROR]",
        stateError?.message || String(stateError)
      );
    }
  };

  try {
    const settings =
      await env.ppobku_db.prepare(`
        SELECT margin_percent
        FROM smm_settings
        WHERE id = 1
        LIMIT 1
      `).first();

    const marginPercent =
      Number(settings?.margin_percent || 0);

    if (
      !Number.isFinite(marginPercent) ||
      marginPercent < 0
    ) {
      throw new Error(
        "Margin global SMM tidak valid."
      );
    }

    const data =
      await callDjuraganSosmedWorker(
        env,
        "services"
      );

    const catalog =
      Array.isArray(data)
        ? data
        : (
            Array.isArray(data?.services)
              ? data.services
              : []
          );

    if (catalog.length < MIN_CATALOG_SIZE) {
      throw new Error(
        `Katalog DjuraganSosmed tidak wajar (${catalog.length} layanan).`
      );
    }

    const detectPlatform = service => {
      const source =
        `${service?.category || ""} ${service?.name || ""}`
          .normalize("NFKC")
          .toLowerCase();

      const rules = [
        ["Instagram", ["instagram", " ig ", "ig ", " ig", "[ig]", "|ig "]],
        ["TikTok", ["tiktok", "tik tok"]],
        ["YouTube", ["youtube"]],
        ["Facebook", ["facebook"]],
        ["X / Twitter", ["twitter", "x/twitter", "x - twitter"]],
        ["Threads", ["threads"]],
        ["Telegram", ["telegram"]],
        ["Shopee", ["shopee"]],
        ["WhatsApp", ["whatsapp"]],
        ["Spotify", ["spotify"]],
        ["Lazada", ["lazada"]],
        ["Tokopedia", ["tokopedia"]],
        ["Pinterest", ["pinterest"]],
        ["LinkedIn", ["linkedin"]],
        ["Discord", ["discord"]],
        ["SoundCloud", ["soundcloud"]],
        ["Roblox", ["roblox"]],
        ["Kick", ["kick.com", "kick "]],
        ["Website", ["website", "web traffic", "mobile traffic"]]
      ];

      for (const [platform, keywords] of rules) {
        if (
          keywords.some(keyword =>
            source.includes(keyword)
          )
        ) {
          return platform;
        }
      }

      return "Other";
    };

    const validServices = [];

    for (const service of catalog) {
      const providerServiceId =
        String(service?.service || "").trim();

      const providerRate =
        Number(service?.rate);

      const minQuantity =
        Number(service?.min);

      const maxQuantity =
        Number(service?.max);

      if (
        !providerServiceId ||
        !Number.isFinite(providerRate) ||
        providerRate < 0 ||
        !Number.isFinite(minQuantity) ||
        !Number.isFinite(maxQuantity) ||
        minQuantity < 1 ||
        maxQuantity < minQuantity
      ) {
        continue;
      }

      const providerType =
        String(service?.type || "")
          .trim()
          .toLowerCase();

      validServices.push({
        providerServiceId,
        providerRate,
        minQuantity,
        maxQuantity,
        platform: detectPlatform(service),
        category:
          String(service?.category || ""),
        name:
          String(service?.name || ""),
        providerType,
        refill:
          service?.refill === true ? 1 : 0,
        cancel:
          service?.cancel === true ? 1 : 0,
        dripfeed:
          service?.dripfeed === true ? 1 : 0,
        supported:
          providerType === "default" &&
          providerRate > 0
      });
    }

    /*
     * Stable ordering is required because sync progress uses
     * an offset across multiple scheduled invocations.
     */
    validServices.sort((a, b) =>
      a.providerServiceId.localeCompare(
        b.providerServiceId,
        undefined,
        {
          numeric: true,
          sensitivity: "base"
        }
      )
    );

    const catalogFingerprint =
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(
          validServices
            .map(service =>
              service.providerServiceId
            )
            .join("\n")
        )
      );

    const catalogFingerprintHex =
      Array.from(
        new Uint8Array(catalogFingerprint)
      )
        .map(byte =>
          byte.toString(16).padStart(2, "0")
        )
        .join("");

    if (
      validServices.length < MIN_CATALOG_SIZE ||
      validServices.length <
        Math.floor(
          catalog.length * MIN_VALID_RATIO
        )
    ) {
      throw new Error(
        `Katalog valid tidak mencukupi (${validServices.length}/${catalog.length}).`
      );
    }

    const existingCountRow =
      await env.ppobku_db.prepare(`
        SELECT COUNT(*) AS total
        FROM smm_services
        WHERE provider_id = ?
      `)
        .bind(providerId)
        .first();

    const existingCount =
      Number(existingCountRow?.total || 0);

    if (
      existingCount >= MIN_CATALOG_SIZE &&
      validServices.length <
        Math.floor(
          existingCount * MIN_EXISTING_RATIO
        )
    ) {
      throw new Error(
        `Katalog provider turun tidak wajar (${validServices.length}/${existingCount}).`
      );
    }

    let state =
      await env.ppobku_db.prepare(`
        SELECT
          provider_id AS providerId,
          offset,
          cycle_id AS cycleId,
          catalog_total AS catalogTotal,
          processed_total AS processedTotal,
          cycle_started_at AS cycleStartedAt,
          catalog_fingerprint AS catalogFingerprint
        FROM smm_sync_state
        WHERE provider_id = ?
        LIMIT 1
      `)
        .bind(providerId)
        .first();

    let offset =
      Math.max(
        0,
        Number(state?.offset || 0)
      );

    /*
     * Bila katalog berubah ukuran di tengah siklus,
     * mulai siklus baru dari awal. Ini mencegah offset
     * lama menunjuk ke susunan katalog yang berbeda.
     */
    const previousCatalogTotal =
      Number(state?.catalogTotal || 0);

    const previousCatalogFingerprint =
      String(state?.catalogFingerprint || "");

    let cycleId =
      String(state?.cycleId || "");

    let cycleStartedAt =
      state?.cycleStartedAt || null;

    if (
      !cycleId ||
      offset >= validServices.length ||
      (
        previousCatalogTotal > 0 &&
        previousCatalogTotal !== validServices.length
      ) ||
      (
        previousCatalogFingerprint &&
        previousCatalogFingerprint !==
          catalogFingerprintHex
      )
    ) {
      offset = 0;
      cycleId =
        `${Date.now()}-${crypto.randomUUID()}`;
      cycleStartedAt = now;

      await env.ppobku_db.prepare(`
        INSERT INTO smm_sync_state (
          provider_id,
          offset,
          cycle_id,
          catalog_total,
          processed_total,
          cycle_started_at,
          last_run_at,
          last_error,
          catalog_fingerprint
        )
        VALUES (?, 0, ?, ?, 0, ?, ?, NULL, ?)
        ON CONFLICT(provider_id)
        DO UPDATE SET
          offset = 0,
          cycle_id = excluded.cycle_id,
          catalog_total = excluded.catalog_total,
          processed_total = 0,
          cycle_started_at =
            excluded.cycle_started_at,
          last_run_at = excluded.last_run_at,
          last_error = NULL,
          catalog_fingerprint =
            excluded.catalog_fingerprint
      `)
        .bind(
          providerId,
          cycleId,
          validServices.length,
          cycleStartedAt,
          now,
          catalogFingerprintHex
        )
        .run();
    }

    const chunk =
      validServices.slice(
        offset,
        offset + CHUNK_SIZE
      );

    if (!chunk.length) {
      throw new Error(
        "Chunk auto-sync kosong secara tidak wajar."
      );
    }

    const statements = [];

    for (const service of chunk) {
      const sellingRate =
        Math.ceil(
          service.providerRate *
          (1 + marginPercent / 100)
        );

      statements.push(
        env.ppobku_db.prepare(`
          INSERT INTO smm_services (
            provider_id,
            provider_service_id,
            platform,
            category,
            name,
            description,
            price,
            min_quantity,
            max_quantity,
            refill,
            cancel,
            active,
            created_at,
            updated_at,
            provider_type,
            provider_rate,
            dripfeed,
            provider_category
          )
          VALUES (
            ?, ?, ?, ?, ?, '',
            ?, ?, ?, ?, ?,
            ?, ?, ?,
            ?, ?, ?, ?
          )
          ON CONFLICT(
            provider_id,
            provider_service_id
          )
          DO UPDATE SET
            platform = excluded.platform,
            category = excluded.category,
            name = excluded.name,
            price = excluded.price,
            min_quantity = excluded.min_quantity,
            max_quantity = excluded.max_quantity,
            refill = excluded.refill,
            cancel = excluded.cancel,
            active = excluded.active,
            updated_at = excluded.updated_at,
            provider_type =
              excluded.provider_type,
            provider_rate =
              excluded.provider_rate,
            dripfeed =
              excluded.dripfeed,
            provider_category =
              excluded.provider_category
        `).bind(
          providerId,
          service.providerServiceId,
          service.platform,
          service.category,
          service.name,
          sellingRate,
          service.minQuantity,
          service.maxQuantity,
          service.refill,
          service.cancel,
          service.supported ? 1 : 0,
          now,
          now,
          service.providerType,
          service.providerRate,
          service.dripfeed,
          service.category
        )
      );
    }

    await env.ppobku_db.batch(statements);

    const nextOffset =
      offset + chunk.length;

    const cycleComplete =
      nextOffset >= validServices.length;

    if (!cycleComplete) {
      await env.ppobku_db.prepare(`
        UPDATE smm_sync_state
        SET
          offset = ?,
          catalog_total = ?,
          processed_total = ?,
          last_run_at = ?,
          last_error = NULL,
          catalog_fingerprint = ?
        WHERE provider_id = ?
          AND cycle_id = ?
      `)
        .bind(
          nextOffset,
          validServices.length,
          nextOffset,
          now,
          catalogFingerprintHex,
          providerId,
          cycleId
        )
        .run();

      return {
        success: true,
        cycleComplete: false,
        providerId,
        cycleId,
        offset,
        processedThisRun: chunk.length,
        nextOffset,
        catalogTotal: validServices.length,
        marginPercent,
        syncedAt: now
      };
    }

    /*
     * Seluruh chunk dalam siklus sudah berhasil.
     * Baru sekarang kita boleh mencari layanan yang
     * benar-benar hilang dari katalog provider.
     */
    const current =
      await env.ppobku_db.prepare(`
        SELECT provider_service_id
        FROM smm_services
        WHERE provider_id = ?
      `)
        .bind(providerId)
        .all();

    const providerIds =
      new Set(
        validServices.map(
          service =>
            service.providerServiceId
        )
      );

    const missingIds =
      (current.results || [])
        .map(row =>
          String(
            row.provider_service_id || ""
          )
        )
        .filter(
          id =>
            id &&
            !providerIds.has(id)
        );

    /*
     * Guard tambahan sebelum destructive disable.
     */
    if (
      existingCount >= MIN_CATALOG_SIZE &&
      validServices.length <
        Math.floor(
          existingCount * MIN_EXISTING_RATIO
        )
    ) {
      throw new Error(
        "Mass-disable dibatalkan oleh safety guard."
      );
    }

    for (
      let index = 0;
      index < missingIds.length;
      index += 50
    ) {
      const ids =
        missingIds.slice(
          index,
          index + 50
        );

      if (!ids.length) continue;

      const placeholders =
        ids.map(() => "?").join(",");

      await env.ppobku_db.prepare(`
        UPDATE smm_services
        SET
          active = 0,
          updated_at = ?
        WHERE provider_id = ?
          AND provider_service_id
            IN (${placeholders})
      `)
        .bind(
          now,
          providerId,
          ...ids
        )
        .run();
    }

    await env.ppobku_db.prepare(`
      UPDATE smm_sync_state
      SET
        offset = 0,
        cycle_id = NULL,
        catalog_total = ?,
        processed_total = ?,
        cycle_started_at = NULL,
        last_run_at = ?,
        last_success_at = ?,
        last_error = NULL,
        catalog_fingerprint = ?
      WHERE provider_id = ?
        AND cycle_id = ?
    `)
      .bind(
        validServices.length,
        validServices.length,
        now,
        now,
        catalogFingerprintHex,
        providerId,
        cycleId
      )
      .run();

    return {
      success: true,
      cycleComplete: true,
      providerId,
      cycleId,
      processedThisRun: chunk.length,
      catalogTotal: validServices.length,
      disabledMissing: missingIds.length,
      marginPercent,
      syncedAt: now
    };

  } catch (error) {
    await saveError(
      error?.message || String(error)
    );

    throw error;
  }
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
    // ADMIN — DJURAGANSOSMED BALANCE TEST
    // ========================================

    if (
      request.method === "GET" &&
      url.pathname ===
        "/api/admin/smm/provider/djuragansosmed/balance"
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

        const session =
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
            INNER JOIN admins a
              ON a.id = s.admin_id
            WHERE s.token_hash = ?
            LIMIT 1
          `)
          .bind(tokenHash)
          .first();

        if (!session) {
          return json({
            success: false,
            error: "Session admin tidak valid."
          }, 401);
        }

        if (
          !session.active ||
          new Date(
            session.expires_at
          ).getTime() <= Date.now()
        ) {
          await env.ppobku_db.prepare(`
            DELETE FROM admin_sessions
            WHERE id = ?
          `)
          .bind(session.session_id)
          .run();

          return json({
            success: false,
            error: "Session admin sudah expired."
          }, 401);
        }

        // ------------------------------------
        // PROVIDER MUST EXIST
        // ------------------------------------

        const provider =
          await env.ppobku_db.prepare(`
            SELECT
              id,
              name,
              api_url,
              active
            FROM smm_providers
            WHERE LOWER(name) =
              'djuragansosmed'
            LIMIT 1
          `)
          .first();

        if (!provider) {
          return json({
            success: false,
            error:
              "Provider DjuraganSosmed belum terdaftar."
          }, 404);
        }

        // Provider boleh active=0.
        // Endpoint ini hanya untuk test admin.

        const data =
          await callDjuraganSosmedWorker(
            env,
            "balance"
          );

        return json({
          success: true,
          provider: "DjuraganSosmed",
          providerActive:
            Number(provider.active) === 1,
          data
        });

      } catch (error) {
        console.error(
          "[DJURAGANSOSMED BALANCE]",
          String(
            error?.message ||
            "Provider request failed."
          )
        );

        return json({
          success: false,
          error:
            error?.message ||
            "Gagal mengambil saldo DjuraganSosmed."
        }, 502);
      }
    }


    // ========================================
    // ADMIN — DJURAGANSOSMED SERVICES TEST
    // READ ONLY
    // ========================================

    if (
      request.method === "GET" &&
      url.pathname ===
        "/api/admin/smm/provider/djuragansosmed/services"
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

        const session =
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
            INNER JOIN admins a
              ON a.id = s.admin_id
            WHERE s.token_hash = ?
            LIMIT 1
          `)
          .bind(tokenHash)
          .first();

        if (!session) {
          return json({
            success: false,
            error: "Session admin tidak valid."
          }, 401);
        }

        if (
          !session.active ||
          new Date(
            session.expires_at
          ).getTime() <= Date.now()
        ) {
          await env.ppobku_db.prepare(`
            DELETE FROM admin_sessions
            WHERE id = ?
          `)
          .bind(session.session_id)
          .run();

          return json({
            success: false,
            error: "Session admin sudah expired."
          }, 401);
        }

        const provider =
          await env.ppobku_db.prepare(`
            SELECT
              id,
              name,
              active
            FROM smm_providers
            WHERE LOWER(name) =
              'djuragansosmed'
            LIMIT 1
          `)
          .first();

        if (!provider) {
          return json({
            success: false,
            error:
              "Provider DjuraganSosmed belum terdaftar."
          }, 404);
        }

        const data =
          await callDjuraganSosmedWorker(
            env,
            "services"
          );

        const services =
          Array.isArray(data)
            ? data
            : (
                Array.isArray(data?.services)
                  ? data.services
                  : []
              );

        return json({
          success: true,
          provider: "DjuraganSosmed",
          providerActive:
            Number(provider.active) === 1,
          count: services.length,
          services
        });

      } catch (error) {
        console.error(
          "[DJURAGANSOSMED SERVICES]",
          String(
            error?.message ||
            "Provider request failed."
          )
        );

        return json({
          success: false,
          error:
            error?.message ||
            "Gagal mengambil layanan DjuraganSosmed."
        }, 502);
      }
    }


    // ========================================
    // ADMIN — DJURAGANSOSMED CATALOG SUMMARY
    // READ ONLY
    // ========================================

    if (
      request.method === "GET" &&
      url.pathname ===
        "/api/admin/smm/provider/djuragansosmed/summary"
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

        const session =
          await env.ppobku_db.prepare(`
            SELECT
              s.id AS session_id,
              s.expires_at,
              a.id,
              a.active
            FROM admin_sessions s
            INNER JOIN admins a
              ON a.id = s.admin_id
            WHERE s.token_hash = ?
            LIMIT 1
          `)
          .bind(tokenHash)
          .first();

        if (!session) {
          return json({
            success: false,
            error: "Session admin tidak valid."
          }, 401);
        }

        if (
          !session.active ||
          new Date(
            session.expires_at
          ).getTime() <= Date.now()
        ) {
          await env.ppobku_db.prepare(`
            DELETE FROM admin_sessions
            WHERE id = ?
          `)
          .bind(session.session_id)
          .run();

          return json({
            success: false,
            error: "Session admin sudah expired."
          }, 401);
        }

        // ------------------------------------
        // GET PROVIDER SERVICES
        // ------------------------------------

        const data =
          await callDjuraganSosmedWorker(
            env,
            "services"
          );

        const services =
          Array.isArray(data)
            ? data
            : (
                Array.isArray(data?.services)
                  ? data.services
                  : []
              );

        // ------------------------------------
        // ANALYSIS
        // ------------------------------------

        const typeCounts = {};
        const platformCounts = {};
        const categoryCounts = {};

        let refillCount = 0;
        let cancelCount = 0;
        let dripfeedCount = 0;

        let minRate = null;
        let maxRate = null;

        const detectPlatform = (service) => {
          const source =
            `${service?.category || ""} ${service?.name || ""}`
              .toLowerCase();

          const rules = [
            ["Instagram", [
              "instagram"
            ]],
            ["TikTok", [
              "tiktok",
              "tik tok"
            ]],
            ["YouTube", [
              "youtube"
            ]],
            ["Facebook", [
              "facebook"
            ]],
            ["X / Twitter", [
              "twitter",
              "x/twitter"
            ]],
            ["Threads", [
              "threads"
            ]],
            ["Shopee", [
              "shopee"
            ]],
            ["Telegram", [
              "telegram"
            ]],
            ["WhatsApp", [
              "whatsapp"
            ]],
            ["Spotify", [
              "spotify"
            ]],
            ["Lazada", [
              "lazada"
            ]],
            ["Tokopedia", [
              "tokopedia"
            ]]
          ];

          for (const [platform, keywords] of rules) {
            if (
              keywords.some(
                keyword => source.includes(keyword)
              )
            ) {
              return platform;
            }
          }

          return "Other";
        };

        for (const service of services) {
          const type =
            String(service?.type || "Unknown");

          const category =
            String(
              service?.category || "Unknown"
            );

          const platform =
            detectPlatform(service);

          typeCounts[type] =
            (typeCounts[type] || 0) + 1;

          categoryCounts[category] =
            (categoryCounts[category] || 0) + 1;

          platformCounts[platform] =
            (platformCounts[platform] || 0) + 1;

          if (service?.refill === true) {
            refillCount++;
          }

          if (service?.cancel === true) {
            cancelCount++;
          }

          if (service?.dripfeed === true) {
            dripfeedCount++;
          }

          const rate =
            Number(service?.rate);

          if (Number.isFinite(rate)) {
            if (
              minRate === null ||
              rate < minRate
            ) {
              minRate = rate;
            }

            if (
              maxRate === null ||
              rate > maxRate
            ) {
              maxRate = rate;
            }
          }
        }

        const sortCounts = (object) =>
          Object.entries(object)
            .sort((a, b) => b[1] - a[1])
            .map(([name, count]) => ({
              name,
              count
            }));

        return json({
          success: true,
          provider: "DjuraganSosmed",

          totalServices:
            services.length,

          rates: {
            minimum: minRate,
            maximum: maxRate
          },

          features: {
            refill: refillCount,
            cancel: cancelCount,
            dripfeed: dripfeedCount
          },

          types:
            sortCounts(typeCounts),

          platforms:
            sortCounts(platformCounts),

          categories: {
            total:
              Object.keys(
                categoryCounts
              ).length,

            breakdown:
              sortCounts(
                categoryCounts
              )
          }
        });

      } catch (error) {
        console.error(
          "[DJURAGANSOSMED SUMMARY]",
          String(
            error?.message ||
            "Summary failed."
          )
        );

        return json({
          success: false,
          error:
            error?.message ||
            "Gagal menganalisis katalog DjuraganSosmed."
        }, 502);
      }
    }


    // ========================================
    // ADMIN — DJURAGANSOSMED SYNC PREVIEW
    // READ ONLY — NO IMPORT / NO ORDER
    // ========================================

    if (
      request.method === "GET" &&
      url.pathname ===
        "/api/admin/smm/provider/djuragansosmed/sync-preview"
    ) {
      try {
        // -----------------------------
        // ADMIN AUTH
        // -----------------------------

        const cookieHeader =
          request.headers.get("Cookie") || "";

        const match =
          cookieHeader.match(
            /(?:^|;\s*)bayora_admin_session=([^;]+)/
          );

        if (!match) {
          return json({
            success: false,
            error: "Admin belum login."
          }, 401);
        }

        let token;

        try {
          token = decodeURIComponent(match[1]);
        } catch {
          token = match[1];
        }

        const tokenHash =
          hashSessionToken(token);

        const session =
          await env.ppobku_db.prepare(`
            SELECT
              s.id AS session_id,
              s.expires_at,
              a.id,
              a.active
            FROM admin_sessions s
            INNER JOIN admins a
              ON a.id = s.admin_id
            WHERE s.token_hash = ?
            LIMIT 1
          `)
          .bind(tokenHash)
          .first();

        if (!session) {
          return json({
            success: false,
            error: "Session admin tidak valid."
          }, 401);
        }

        if (
          !session.active ||
          new Date(session.expires_at).getTime()
            <= Date.now()
        ) {
          await env.ppobku_db.prepare(`
            DELETE FROM admin_sessions
            WHERE id = ?
          `)
          .bind(session.session_id)
          .run();

          return json({
            success: false,
            error: "Session admin sudah expired."
          }, 401);
        }

        // -----------------------------
        // PROVIDER
        // -----------------------------

        const provider =
          await env.ppobku_db.prepare(`
            SELECT
              id,
              name,
              active
            FROM smm_providers
            WHERE name = 'DjuraganSosmed'
            LIMIT 1
          `)
          .first();

        if (!provider) {
          return json({
            success: false,
            error:
              "Provider DjuraganSosmed tidak ditemukan."
          }, 404);
        }

        // -----------------------------
        // GLOBAL MARGIN
        // -----------------------------

        const settings =
          await env.ppobku_db.prepare(`
            SELECT margin_percent
            FROM smm_settings
            WHERE id = 1
            LIMIT 1
          `)
          .first();

        const marginPercent =
          Number(settings?.margin_percent || 0);

        // -----------------------------
        // EXISTING PROVIDER IDS
        // -----------------------------

        const existingResult =
          await env.ppobku_db.prepare(`
            SELECT provider_service_id
            FROM smm_services
            WHERE provider_id = ?
          `)
          .bind(provider.id)
          .all();

        const existingIds =
          new Set(
            (existingResult.results || [])
              .map(row =>
                String(row.provider_service_id || "")
              )
              .filter(Boolean)
          );

        // -----------------------------
        // FETCH PROVIDER CATALOG
        // -----------------------------

        const data =
          await callDjuraganSosmedWorker(
            env,
            "services"
          );

        const services =
          Array.isArray(data)
            ? data
            : (
                Array.isArray(data?.services)
                  ? data.services
                  : []
              );

        // -----------------------------
        // PLATFORM DETECTION
        // -----------------------------

        const detectPlatform = service => {
          const source =
            `${service?.category || ""} ${service?.name || ""}`
              .normalize("NFKC")
              .toLowerCase();

          const rules = [
            ["Instagram", [
              "instagram",
              " ig ",
              "ig ",
              " ig",
              "[ig]",
              "|ig "
            ]],
            ["TikTok", ["tiktok", "tik tok"]],
            ["YouTube", ["youtube"]],
            ["Facebook", ["facebook"]],
            ["X / Twitter", [
              "twitter",
              "x/twitter",
              "x - twitter"
            ]],
            ["Threads", ["threads"]],
            ["Telegram", ["telegram"]],
            ["Shopee", ["shopee"]],
            ["WhatsApp", ["whatsapp"]],
            ["Spotify", ["spotify"]],
            ["Lazada", ["lazada"]],
            ["Tokopedia", ["tokopedia"]],
            ["Pinterest", ["pinterest"]],
            ["LinkedIn", ["linkedin"]],
            ["Discord", ["discord"]],
            ["SoundCloud", ["soundcloud"]],
            ["Roblox", ["roblox"]],
            ["Kick", ["kick.com", "kick "]],
            ["Website", [
              "website",
              "web traffic",
              "mobile traffic"
            ]]
          ];

          for (const [platform, keywords] of rules) {
            if (
              keywords.some(keyword =>
                source.includes(keyword)
              )
            ) {
              return platform;
            }
          }

          return "Other";
        };

        // -----------------------------
        // PREVIEW
        // -----------------------------

        let newCount = 0;
        let updateCount = 0;
        let invalidCount = 0;

        const platformCounts = {};
        const samples = [];

        for (const service of services) {
          const providerServiceId =
            String(service?.service || "").trim();

          const providerRate =
            Number(service?.rate);

          const minQuantity =
            Number(service?.min);

          const maxQuantity =
            Number(service?.max);

          if (
            !providerServiceId ||
            !Number.isFinite(providerRate) ||
            providerRate < 0 ||
            !Number.isFinite(minQuantity) ||
            !Number.isFinite(maxQuantity) ||
            minQuantity < 1 ||
            maxQuantity < minQuantity
          ) {
            invalidCount++;
            continue;
          }

          if (existingIds.has(providerServiceId)) {
            updateCount++;
          } else {
            newCount++;
          }

          const platform =
            detectPlatform(service);

          platformCounts[platform] =
            (platformCounts[platform] || 0) + 1;

          /*
           * Standard SMM rate:
           * provider rate is normally per 1000 units.
           *
           * price below is therefore Bayora's
           * selling rate per 1000, NOT the total
           * order price.
           */
          const sellingRate =
            Math.ceil(
              providerRate *
              (1 + marginPercent / 100)
            );

          if (samples.length < 10) {
            samples.push({
              providerServiceId,
              platform,
              category:
                String(service?.category || ""),
              name:
                String(service?.name || ""),
              type:
                String(service?.type || ""),
              providerRate,
              marginPercent,
              sellingRate,
              minQuantity,
              maxQuantity,
              refill:
                service?.refill === true,
              cancel:
                service?.cancel === true,
              dripfeed:
                service?.dripfeed === true,
              initialActive: false
            });
          }
        }

        const platformBreakdown =
          Object.entries(platformCounts)
            .sort((a, b) => b[1] - a[1])
            .map(([name, count]) => ({
              name,
              count
            }));

        return json({
          success: true,

          mode: "PREVIEW_ONLY",

          provider: {
            id: provider.id,
            name: provider.name,
            active:
              Number(provider.active) === 1
          },

          marginPercent,

          catalog: {
            received: services.length,
            valid:
              newCount + updateCount,
            invalid: invalidCount,
            wouldInsert: newCount,
            wouldUpdate: updateCount
          },

          safety: {
            databaseWrite: false,
            providerOrder: false,
            importedServicesInitialActive: false
          },

          platforms:
            platformBreakdown,

          samples
        });

      } catch (error) {
        console.error(
          "[DJURAGANSOSMED SYNC PREVIEW]",
          String(
            error?.message ||
            "Preview failed."
          )
        );

        return json({
          success: false,
          error:
            error?.message ||
            "Gagal membuat preview sinkronisasi."
        }, 502);
      }
    }


    // ========================================
    // ADMIN — DJURAGANSOSMED PROVIDER STATUS
    // GET = READ / PUT = ACTIVE TOGGLE ONLY
    // NO SERVICE CHANGE / NO PROVIDER API / NO ORDER
    // ========================================

    if (
      (
        request.method === "GET" ||
        request.method === "PUT"
      ) &&
      url.pathname ===
        "/api/admin/smm/provider/djuragansosmed/status"
    ) {
      try {
        // -----------------------------
        // ADMIN AUTH
        // -----------------------------

        const cookieHeader =
          request.headers.get("Cookie") || "";

        const match =
          cookieHeader.match(
            /(?:^|;\s*)bayora_admin_session=([^;]+)/
          );

        if (!match) {
          return json({
            success: false,
            error: "Admin belum login."
          }, 401);
        }

        let token;

        try {
          token = decodeURIComponent(match[1]);
        } catch {
          token = match[1];
        }

        const tokenHash =
          hashSessionToken(token);

        const session =
          await env.ppobku_db.prepare(`
            SELECT
              s.id AS session_id,
              s.expires_at,
              a.id,
              a.active
            FROM admin_sessions s
            INNER JOIN admins a
              ON a.id = s.admin_id
            WHERE s.token_hash = ?
            LIMIT 1
          `)
          .bind(tokenHash)
          .first();

        if (
          !session ||
          !session.active ||
          new Date(session.expires_at).getTime()
            <= Date.now()
        ) {
          return json({
            success: false,
            error:
              "Session admin tidak valid atau expired."
          }, 401);
        }

        // -----------------------------
        // DJURAGAN PROVIDER
        // -----------------------------

        const provider =
          await env.ppobku_db.prepare(`
            SELECT
              id,
              name,
              active
            FROM smm_providers
            WHERE LOWER(name) = 'djuragansosmed'
            LIMIT 1
          `)
          .first();

        if (!provider) {
          return json({
            success: false,
            error:
              "Provider DjuraganSosmed tidak ditemukan."
          }, 404);
        }

        // -----------------------------
        // CURRENT SAFETY STATE
        // -----------------------------

        const stats =
          await env.ppobku_db.prepare(`
            SELECT
              COUNT(*) AS total_services,

              SUM(
                CASE
                  WHEN active = 1
                  THEN 1
                  ELSE 0
                END
              ) AS active_services,

              SUM(
                CASE
                  WHEN active = 1
                   AND (
                     provider_rate IS NULL
                     OR provider_rate <= 0
                   )
                  THEN 1
                  ELSE 0
                END
              ) AS unsafe_rate_active,

              SUM(
                CASE
                  WHEN active = 1
                   AND LOWER(
                     TRIM(
                       COALESCE(
                         provider_type,
                         ''
                       )
                     )
                   ) <> 'default'
                  THEN 1
                  ELSE 0
                END
              ) AS unsafe_type_active

            FROM smm_services
            WHERE provider_id = ?
          `)
          .bind(provider.id)
          .first();

        const state = {
          total:
            Number(stats?.total_services || 0),

          active:
            Number(stats?.active_services || 0),

          unsafeRateActive:
            Number(stats?.unsafe_rate_active || 0),

          unsafeTypeActive:
            Number(stats?.unsafe_type_active || 0)
        };

        if (request.method === "GET") {
          return json({
            success: true,
            provider: {
              id: provider.id,
              name: provider.name,
              active:
                Number(provider.active) === 1
            },
            services: state
          });
        }

        // -----------------------------
        // PUT ACTIVE ONLY
        // -----------------------------

        let body;

        try {
          body = await request.json();
        } catch {
          return json({
            success: false,
            error: "Body JSON tidak valid."
          }, 400);
        }

        if (
          body === null ||
          typeof body !== "object" ||
          !Object.prototype.hasOwnProperty.call(
            body,
            "active"
          )
        ) {
          return json({
            success: false,
            error:
              "Hanya perubahan status active yang diizinkan."
          }, 400);
        }

        const active =
          Number(body.active);

        if (
          active !== 0 &&
          active !== 1
        ) {
          return json({
            success: false,
            error:
              "Status active harus 0 atau 1."
          }, 400);
        }

        if (
          active === 1 &&
          (
            state.unsafeRateActive > 0 ||
            state.unsafeTypeActive > 0
          )
        ) {
          return json({
            success: false,
            error:
              "Provider tidak dapat diaktifkan karena masih ada layanan aktif yang tidak aman.",
            services: state
          }, 400);
        }

        await env.ppobku_db.prepare(`
          UPDATE smm_providers
          SET active = ?
          WHERE id = ?
        `)
        .bind(
          active,
          provider.id
        )
        .run();

        return json({
          success: true,
          provider: {
            id: provider.id,
            name: provider.name,
            active:
              active === 1
          },
          services: state,
          safety: {
            serviceChange: false,
            providerApiCall: false,
            providerOrder: false
          }
        });

      } catch (error) {
        console.error(
          "[DJURAGANSOSMED PROVIDER STATUS]",
          error
        );

        return json({
          success: false,
          error:
            "Gagal memperbarui status provider DjuraganSosmed."
        }, 500);
      }
    }


    // ========================================
    // ADMIN — DJURAGANSOSMED GLOBAL MARGIN
    // GET = READ / PUT = UPDATE + REPRICE
    // NO PROVIDER ORDER / NO ACTIVE CHANGE
    // ========================================

    if (
      (
        request.method === "GET" ||
        request.method === "PUT"
      ) &&
      url.pathname ===
        "/api/admin/smm/provider/djuragansosmed/margin"
    ) {
      try {
        // -----------------------------
        // ADMIN AUTH
        // -----------------------------

        const cookieHeader =
          request.headers.get("Cookie") || "";

        const match =
          cookieHeader.match(
            /(?:^|;\s*)bayora_admin_session=([^;]+)/
          );

        if (!match) {
          return json({
            success: false,
            error: "Admin belum login."
          }, 401);
        }

        let token;

        try {
          token = decodeURIComponent(match[1]);
        } catch {
          token = match[1];
        }

        const tokenHash =
          hashSessionToken(token);

        const session =
          await env.ppobku_db.prepare(`
            SELECT
              s.id AS session_id,
              s.expires_at,
              a.id,
              a.active
            FROM admin_sessions s
            INNER JOIN admins a
              ON a.id = s.admin_id
            WHERE s.token_hash = ?
            LIMIT 1
          `)
          .bind(tokenHash)
          .first();

        if (
          !session ||
          !session.active ||
          new Date(session.expires_at).getTime()
            <= Date.now()
        ) {
          return json({
            success: false,
            error:
              "Session admin tidak valid atau expired."
          }, 401);
        }

        // -----------------------------
        // DJURAGAN PROVIDER
        // -----------------------------

        const provider =
          await env.ppobku_db.prepare(`
            SELECT id, name, active
            FROM smm_providers
            WHERE LOWER(name) = 'djuragansosmed'
            LIMIT 1
          `)
          .first();

        if (!provider) {
          return json({
            success: false,
            error:
              "Provider DjuraganSosmed tidak ditemukan."
          }, 404);
        }

        // -----------------------------
        // GET CURRENT MARGIN
        // -----------------------------

        if (request.method === "GET") {
          const settings =
            await env.ppobku_db.prepare(`
              SELECT
                margin_percent,
                updated_at
              FROM smm_settings
              WHERE id = 1
              LIMIT 1
            `)
            .first();

          const stats =
            await env.ppobku_db.prepare(`
              SELECT
                COUNT(*) AS total_services,
                SUM(
                  CASE WHEN active = 1
                  THEN 1 ELSE 0 END
                ) AS active_services,
                SUM(
                  CASE WHEN provider_rate = 0
                  THEN 1 ELSE 0 END
                ) AS zero_rate_services
              FROM smm_services
              WHERE provider_id = ?
            `)
            .bind(provider.id)
            .first();

          return json({
            success: true,
            provider: {
              id: provider.id,
              name: provider.name,
              active:
                Number(provider.active) === 1
            },
            marginPercent:
              Number(settings?.margin_percent || 0),
            updatedAt:
              settings?.updated_at || null,
            services: {
              total:
                Number(stats?.total_services || 0),
              active:
                Number(stats?.active_services || 0),
              zeroRate:
                Number(stats?.zero_rate_services || 0)
            }
          });
        }

        // -----------------------------
        // PUT NEW MARGIN
        // -----------------------------

        let body;

        try {
          body = await request.json();
        } catch {
          return json({
            success: false,
            error: "Body JSON tidak valid."
          }, 400);
        }

        const marginPercent =
          Number(body?.marginPercent);

        if (
          !Number.isFinite(marginPercent) ||
          marginPercent < 0 ||
          marginPercent > 1000
        ) {
          return json({
            success: false,
            error:
              "Margin harus berupa angka 0 sampai 1000."
          }, 400);
        }

        // Maksimal 2 angka desimal.
        const normalizedMargin =
          Math.round(marginPercent * 100) / 100;

        const now =
          new Date().toISOString();

        /*
         * price = selling rate per 1000.
         *
         * SQLite CEIL() tidak kita andalkan.
         * Untuk angka positif:
         * CAST(x AS INTEGER) + (x > CAST(x AS INTEGER))
         * ekuivalen dengan Math.ceil(x).
         *
         * active sengaja TIDAK diubah.
         */

        const factor =
          1 + normalizedMargin / 100;

        const updateSettings =
          env.ppobku_db.prepare(`
            UPDATE smm_settings
            SET
              margin_percent = ?,
              updated_at = ?
            WHERE id = 1
          `)
          .bind(
            normalizedMargin,
            now
          );

        const repriceServices =
          env.ppobku_db.prepare(`
            UPDATE smm_services
            SET
              price =
                CAST(
                  provider_rate * ?
                  AS INTEGER
                ) +
                CASE
                  WHEN provider_rate * ? >
                    CAST(
                      provider_rate * ?
                      AS INTEGER
                    )
                  THEN 1
                  ELSE 0
                END,
              updated_at = ?
            WHERE provider_id = ?
              AND provider_rate IS NOT NULL
              AND provider_rate >= 0
          `)
          .bind(
            factor,
            factor,
            factor,
            now,
            provider.id
          );

        await env.ppobku_db.batch([
          updateSettings,
          repriceServices
        ]);

        const stats =
          await env.ppobku_db.prepare(`
            SELECT
              COUNT(*) AS total_services,
              SUM(
                CASE WHEN active = 1
                THEN 1 ELSE 0 END
              ) AS active_services,
              SUM(
                CASE WHEN active = 0
                THEN 1 ELSE 0 END
              ) AS inactive_services,
              SUM(
                CASE WHEN provider_rate = 0
                THEN 1 ELSE 0 END
              ) AS zero_rate_services
            FROM smm_services
            WHERE provider_id = ?
          `)
          .bind(provider.id)
          .first();

        return json({
          success: true,
          provider: {
            id: provider.id,
            name: provider.name,
            active:
              Number(provider.active) === 1
          },
          marginPercent:
            normalizedMargin,
          repriced:
            Number(stats?.total_services || 0),
          services: {
            total:
              Number(stats?.total_services || 0),
            active:
              Number(stats?.active_services || 0),
            inactive:
              Number(stats?.inactive_services || 0),
            zeroRate:
              Number(stats?.zero_rate_services || 0)
          },
          safety: {
            providerOrder: false,
            providerActiveChanged: false,
            serviceActiveChanged: false,
            sosmedlyPricesChanged: false
          }
        });

      } catch (error) {
        console.error(
          "[DJURAGANSOSMED MARGIN]",
          String(
            error?.message ||
            "Margin update failed."
          )
        );

        return json({
          success: false,
          error:
            error?.message ||
            "Gagal memproses margin DjuraganSosmed."
        }, 500);
      }
    }



    // ========================================
    // ADMIN — DJURAGANSOSMED CHUNK IMPORT
    // SAFE: ADMIN ONLY / NO PROVIDER ORDER
    // ========================================

    if (
      request.method === "POST" &&
      url.pathname ===
        "/api/admin/smm/provider/djuragansosmed/import"
    ) {
      try {
        // -----------------------------
        // ADMIN AUTH
        // -----------------------------

        const cookieHeader =
          request.headers.get("Cookie") || "";

        const match =
          cookieHeader.match(
            /(?:^|;\s*)bayora_admin_session=([^;]+)/
          );

        if (!match) {
          return json({
            success: false,
            error: "Admin belum login."
          }, 401);
        }

        let token;

        try {
          token = decodeURIComponent(match[1]);
        } catch {
          token = match[1];
        }

        const tokenHash =
          hashSessionToken(token);

        const session =
          await env.ppobku_db.prepare(`
            SELECT
              s.id AS session_id,
              s.expires_at,
              a.id,
              a.active
            FROM admin_sessions s
            INNER JOIN admins a
              ON a.id = s.admin_id
            WHERE s.token_hash = ?
            LIMIT 1
          `)
          .bind(tokenHash)
          .first();

        if (
          !session ||
          !session.active ||
          new Date(session.expires_at).getTime()
            <= Date.now()
        ) {
          return json({
            success: false,
            error: "Session admin tidak valid atau expired."
          }, 401);
        }

        // -----------------------------
        // PROVIDER + SETTINGS
        // -----------------------------

        const provider =
          await env.ppobku_db.prepare(`
            SELECT id, name, active
            FROM smm_providers
            WHERE name = 'DjuraganSosmed'
            LIMIT 1
          `)
          .first();

        if (!provider) {
          return json({
            success: false,
            error:
              "Provider DjuraganSosmed tidak ditemukan."
          }, 404);
        }

        const settings =
          await env.ppobku_db.prepare(`
            SELECT margin_percent
            FROM smm_settings
            WHERE id = 1
            LIMIT 1
          `)
          .first();

        const marginPercent =
          Number(settings?.margin_percent || 0);

        if (
          !Number.isFinite(marginPercent) ||
          marginPercent < 0
        ) {
          return json({
            success: false,
            error: "Margin global tidak valid."
          }, 400);
        }

        // -----------------------------
        // CHUNK PARAMETERS
        // -----------------------------

        const offsetRaw =
          Number(url.searchParams.get("offset") || 0);

        const limitRaw =
          Number(url.searchParams.get("limit") || 100);

        const offset =
          Number.isInteger(offsetRaw) && offsetRaw >= 0
            ? offsetRaw
            : 0;

        const limit =
          Number.isInteger(limitRaw)
            ? Math.min(
                Math.max(limitRaw, 1),
                100
              )
            : 100;

        const confirmed =
          url.searchParams.get("confirm") === "IMPORT";

        // -----------------------------
        // FETCH PROVIDER CATALOG
        // -----------------------------

        const data =
          await callDjuraganSosmedWorker(
            env,
            "services"
          );

        const services =
          Array.isArray(data)
            ? data
            : (
                Array.isArray(data?.services)
                  ? data.services
                  : []
              );

        const chunk =
          services.slice(
            offset,
            offset + limit
          );

        // -----------------------------
        // SAME PLATFORM DETECTOR
        // -----------------------------

        const detectPlatform = service => {
          const source =
            `${service?.category || ""} ${service?.name || ""}`
              .normalize("NFKC")
              .toLowerCase();

          const rules = [
            ["Instagram", [
              "instagram",
              " ig ",
              "ig ",
              " ig",
              "[ig]",
              "|ig "
            ]],
            ["TikTok", ["tiktok", "tik tok"]],
            ["YouTube", ["youtube"]],
            ["Facebook", ["facebook"]],
            ["X / Twitter", [
              "twitter",
              "x/twitter",
              "x - twitter"
            ]],
            ["Threads", ["threads"]],
            ["Telegram", ["telegram"]],
            ["Shopee", ["shopee"]],
            ["WhatsApp", ["whatsapp"]],
            ["Spotify", ["spotify"]],
            ["Lazada", ["lazada"]],
            ["Tokopedia", ["tokopedia"]],
            ["Pinterest", ["pinterest"]],
            ["LinkedIn", ["linkedin"]],
            ["Discord", ["discord"]],
            ["SoundCloud", ["soundcloud"]],
            ["Roblox", ["roblox"]],
            ["Kick", ["kick.com", "kick "]],
            ["Website", [
              "website",
              "web traffic",
              "mobile traffic"
            ]]
          ];

          for (const [platform, keywords] of rules) {
            if (
              keywords.some(keyword =>
                source.includes(keyword)
              )
            ) {
              return platform;
            }
          }

          return "Other";
        };

        // -----------------------------
        // VALIDATE + BUILD STATEMENTS
        // -----------------------------

        const statements = [];
        const samples = [];

        let valid = 0;
        let invalid = 0;

        const now =
          new Date().toISOString();

        for (const service of chunk) {
          const providerServiceId =
            String(service?.service || "").trim();

          const providerRate =
            Number(service?.rate);

          const minQuantity =
            Number(service?.min);

          const maxQuantity =
            Number(service?.max);

          if (
            !providerServiceId ||
            !Number.isFinite(providerRate) ||
            providerRate < 0 ||
            !Number.isFinite(minQuantity) ||
            !Number.isFinite(maxQuantity) ||
            minQuantity < 1 ||
            maxQuantity < minQuantity
          ) {
            invalid++;
            continue;
          }

          valid++;

          const platform =
            detectPlatform(service);

          const providerCategory =
            String(service?.category || "");

          const name =
            String(service?.name || "");

          const providerType =
            String(service?.type || "");

          const sellingRate =
            Math.ceil(
              providerRate *
              (1 + marginPercent / 100)
            );

          const refill =
            service?.refill === true ? 1 : 0;

          const cancel =
            service?.cancel === true ? 1 : 0;

          const dripfeed =
            service?.dripfeed === true ? 1 : 0;

          if (samples.length < 5) {
            samples.push({
              providerServiceId,
              platform,
              providerRate,
              sellingRate,
              minQuantity,
              maxQuantity,
              initialActive: false
            });
          }

          statements.push(
            env.ppobku_db.prepare(`
              INSERT INTO smm_services (
                provider_id,
                provider_service_id,
                platform,
                category,
                name,
                description,
                price,
                min_quantity,
                max_quantity,
                refill,
                cancel,
                active,
                created_at,
                updated_at,
                provider_type,
                provider_rate,
                dripfeed,
                provider_category
              )
              VALUES (
                ?, ?, ?, ?, ?, '',
                ?, ?, ?, ?, ?,
                0, ?, ?,
                ?, ?, ?, ?
              )
              ON CONFLICT(
                provider_id,
                provider_service_id
              )
              DO UPDATE SET
                platform = excluded.platform,
                category = excluded.category,
                name = excluded.name,
                price = excluded.price,
                min_quantity = excluded.min_quantity,
                max_quantity = excluded.max_quantity,
                refill = excluded.refill,
                cancel = excluded.cancel,
                updated_at = excluded.updated_at,
                provider_type = excluded.provider_type,
                provider_rate = excluded.provider_rate,
                dripfeed = excluded.dripfeed,
                provider_category =
                  excluded.provider_category
            `)
            .bind(
              provider.id,
              providerServiceId,
              platform,
              providerCategory,
              name,
              sellingRate,
              minQuantity,
              maxQuantity,
              refill,
              cancel,
              now,
              now,
              providerType,
              providerRate,
              dripfeed,
              providerCategory
            )
          );
        }

        // -----------------------------
        // DEFAULT = DRY RUN
        // -----------------------------

        if (!confirmed) {
          return json({
            success: true,
            mode: "DRY_RUN",
            provider: {
              id: provider.id,
              name: provider.name,
              active:
                Number(provider.active) === 1
            },
            marginPercent,
            catalogTotal: services.length,
            chunk: {
              offset,
              requestedLimit: limit,
              received: chunk.length,
              valid,
              invalid,
              nextOffset:
                offset + chunk.length,
              hasMore:
                offset + chunk.length <
                services.length
            },
            safety: {
              databaseWrite: false,
              providerOrder: false,
              newServicesInitialActive: false,
              existingActivePreserved: true
            },
            samples
          });
        }

        // -----------------------------
        // CONFIRMED DATABASE WRITE
        // -----------------------------

        if (statements.length > 0) {
          await env.ppobku_db.batch(
            statements
          );
        }

        return json({
          success: true,
          mode: "IMPORTED",
          provider: {
            id: provider.id,
            name: provider.name,
            active:
              Number(provider.active) === 1
          },
          marginPercent,
          catalogTotal: services.length,
          chunk: {
            offset,
            requestedLimit: limit,
            received: chunk.length,
            written: statements.length,
            invalid,
            nextOffset:
              offset + chunk.length,
            hasMore:
              offset + chunk.length <
              services.length
          },
          safety: {
            providerOrder: false,
            newServicesInitialActive: false,
            existingActivePreserved: true
          }
        });

      } catch (error) {
        console.error(
          "[DJURAGANSOSMED IMPORT]",
          String(
            error?.message ||
            "Import failed."
          )
        );

        return json({
          success: false,
          error:
            error?.message ||
            "Gagal mengimpor layanan DjuraganSosmed."
        }, 502);
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
            s.id,
            s.provider_id AS providerId,
            s.provider_service_id AS providerServiceId,
            s.platform,
            s.category,
            s.name,
            s.description,
            s.icon,
            s.price,
            s.min_quantity AS minQuantity,
            s.max_quantity AS maxQuantity,
            s.refill,
            s.cancel,
            s.active,
            s.created_at AS createdAt,
            s.updated_at AS updatedAt
          FROM smm_services s
          INNER JOIN smm_providers p
            ON p.id = s.provider_id
          WHERE s.active = 1
            AND p.active = 1
        `;

        const params = [];

        if (platform) {
          sql += " AND LOWER(s.platform) = ?";
          params.push(platform);
        }

        if (category) {
          sql += " AND LOWER(s.category) = ?";
          params.push(category);
        }

        sql += " ORDER BY s.platform ASC, s.category ASC, s.name ASC";

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
    // SMM — CREATE LOCAL ORDER
    // ========================================
    // Local order only.
    // This route NEVER submits an order to the provider.
    if (
      request.method === "POST" &&
      url.pathname === "/api/smm/transactions"
    ) {
      try {
        const user =
          await getCurrentUser(
            request,
            env.ppobku_db
          );

        if (!user) {
          return Response.json({
            success: false,
            error: "Silakan login terlebih dahulu."
          }, { status: 401 });
        }

        let body;

        try {
          body = await request.json();
        } catch {
          return Response.json({
            success: false,
            error: "Data transaksi tidak valid."
          }, { status: 400 });
        }

        const numericServiceId =
          Number(body?.serviceId);

        const numericQuantity =
          Number(body?.quantity);

        const cleanTarget =
          String(body?.target || "").trim();

        if (
          !Number.isInteger(numericServiceId) ||
          numericServiceId <= 0
        ) {
          return Response.json({
            success: false,
            error: "Layanan SMM tidak valid."
          }, { status: 400 });
        }

        if (!cleanTarget) {
          return Response.json({
            success: false,
            error: "Target wajib diisi."
          }, { status: 400 });
        }

        if (cleanTarget.length > 2048) {
          return Response.json({
            success: false,
            error: "Target terlalu panjang."
          }, { status: 400 });
        }

        if (
          !Number.isInteger(numericQuantity) ||
          numericQuantity <= 0
        ) {
          return Response.json({
            success: false,
            error:
              "Quantity harus berupa angka bulat lebih dari 0."
          }, { status: 400 });
        }

        /*
         * IMPORTANT:
         * - price is always read from D1
         * - service must be active
         * - provider must also be active
         *
         * Therefore the provider kill switch also blocks checkout.
         */
        const service =
          await env.ppobku_db
            .prepare(`
              SELECT
                s.id,
                s.provider_id AS providerId,
                s.provider_service_id AS providerServiceId,
                s.platform,
                s.category,
                s.name,
                s.price,
                s.min_quantity AS minQuantity,
                s.max_quantity AS maxQuantity,
                s.refill,
                s.cancel,
                s.active,
                p.name AS providerName,
                p.active AS providerActive
              FROM smm_services s
              INNER JOIN smm_providers p
                ON p.id = s.provider_id
              WHERE s.id = ?
              LIMIT 1
            `)
            .bind(numericServiceId)
            .first();

        if (!service) {
          return Response.json({
            success: false,
            error: "Layanan SMM tidak ditemukan."
          }, { status: 404 });
        }

        if (
          Number(service.active) !== 1 ||
          Number(service.providerActive) !== 1
        ) {
          return Response.json({
            success: false,
            error: "Layanan SMM belum tersedia."
          }, { status: 400 });
        }

        const minQuantity =
          Number(service.minQuantity);

        const maxQuantity =
          Number(service.maxQuantity);

        const pricePerThousand =
          Number(service.price);

        if (
          !Number.isInteger(minQuantity) ||
          !Number.isInteger(maxQuantity) ||
          minQuantity < 1 ||
          maxQuantity < minQuantity
        ) {
          return Response.json({
            success: false,
            error:
              "Konfigurasi quantity layanan tidak valid."
          }, { status: 500 });
        }

        if (
          !Number.isFinite(pricePerThousand) ||
          pricePerThousand <= 0
        ) {
          return Response.json({
            success: false,
            error: "Harga layanan SMM tidak valid."
          }, { status: 500 });
        }

        if (numericQuantity < minQuantity) {
          return Response.json({
            success: false,
            error:
              `Minimum quantity untuk layanan ini adalah ${minQuantity}.`
          }, { status: 400 });
        }

        if (numericQuantity > maxQuantity) {
          return Response.json({
            success: false,
            error:
              `Maximum quantity untuk layanan ini adalah ${maxQuantity}.`
          }, { status: 400 });
        }

        /*
         * SMM selling rate is stored per 1,000 units.
         */
        const totalPrice =
          Math.ceil(
            (pricePerThousand / 1000) *
            numericQuantity
          );

        if (
          !Number.isSafeInteger(totalPrice) ||
          totalPrice <= 0
        ) {
          return Response.json({
            success: false,
            error: "Total harga tidak valid."
          }, { status: 400 });
        }

        const now =
          new Date().toISOString();

        const orderId =
          "SMM-" +
          Date.now() +
          "-" +
          randomBytes(4)
            .toString("hex")
            .toUpperCase();

        /*
         * Safety boundary:
         *
         * A newly-created order is deliberately BLOCKED from provider
         * submission. Payment handling will be implemented separately.
         *
         * No provider API call exists in this route.
         */
        await env.ppobku_db
          .prepare(`
            INSERT INTO smm_orders (
              order_id,
              user_id,
              service_id,
              target,
              quantity,
              price,
              provider_order_id,
              status,
              start_count,
              remains,
              created_at,
              updated_at,
              payment_status,
              payment_session_id,
              payment_request_id,
              paid_at,
              submission_status,
              submission_claimed_at,
              provider_message,
              legacy
            )
            VALUES (
              ?,
              ?,
              ?,
              ?,
              ?,
              ?,
              NULL,
              'PENDING_PAYMENT',
              NULL,
              ?,
              ?,
              ?,
              'PENDING',
              NULL,
              NULL,
              NULL,
              'BLOCKED',
              NULL,
              NULL,
              0
            )
          `)
          .bind(
            orderId,
            user.id,
            numericServiceId,
            cleanTarget,
            numericQuantity,
            totalPrice,
            numericQuantity,
            now,
            now
          )
          .run();

        const order =
          await env.ppobku_db
            .prepare(`
              SELECT
                o.id,
                o.order_id AS orderId,
                o.user_id AS userId,
                o.service_id AS serviceId,
                s.provider_service_id AS providerServiceId,
                s.platform,
                s.category,
                s.name AS serviceName,
                o.target,
                o.quantity,
                s.price AS pricePerThousand,
                o.price,
                o.status,
                o.payment_status AS paymentStatus,
                o.submission_status AS submissionStatus,
                o.created_at AS createdAt,
                o.updated_at AS updatedAt
              FROM smm_orders o
              INNER JOIN smm_services s
                ON s.id = o.service_id
              WHERE o.order_id = ?
              LIMIT 1
            `)
            .bind(orderId)
            .first();

        if (!order) {
          throw new Error(
            "SMM order created but could not be reloaded."
          );
        }

        return Response.json({
          success: true,
          message: "Order SMM berhasil dibuat.",
          order
        }, { status: 201 });

      } catch (error) {
        console.error(
          "[SMM TRANSACTION ERROR]",
          error
        );

        return Response.json({
          success: false,
          error: "Gagal membuat transaksi SMM."
        }, { status: 500 });
      }
    }



    // ========================================
    // XENDIT SMM PAYMENT
    // ========================================
    // Creates/reuses a payment session only.
    // Atomic D1 claim prevents concurrent session creation.
    // This route NEVER submits an order to the provider.
    if (
      request.method === "POST" &&
      url.pathname === "/api/payments/xendit-smm"
    ) {
      try {
        const user =
          await getCurrentUser(
            request,
            env.ppobku_db
          );

        if (!user) {
          return json({
            success: false,
            error: "Silakan login terlebih dahulu."
          }, 401);
        }

        const body = await request.json();

        const orderId =
          String(body?.orderId || "").trim();

        if (!orderId) {
          return json({
            success: false,
            error: "orderId wajib diisi."
          }, 400);
        }

        let order =
          await env.ppobku_db.prepare(`
            SELECT
              o.id,
              o.order_id AS orderId,
              o.user_id AS userId,
              o.service_id AS serviceId,
              o.price,
              o.status,
              o.payment_status AS paymentStatus,
              o.payment_session_id AS paymentSessionId,
              o.payment_request_id AS paymentRequestId,
              o.payment_url AS paymentUrl,
              o.payment_session_status AS paymentSessionStatus,
              o.payment_session_claimed_at AS paymentSessionClaimedAt,
              o.legacy,
              o.submission_status AS submissionStatus,
              s.name AS serviceName,
              s.active AS serviceActive,
              p.active AS providerActive
            FROM smm_orders o
            JOIN smm_services s
              ON s.id = o.service_id
            JOIN smm_providers p
              ON p.id = s.provider_id
            WHERE o.order_id = ?
            LIMIT 1
          `)
            .bind(orderId)
            .first();

        if (!order) {
          return json({
            success: false,
            error: "Order SMM tidak ditemukan."
          }, 404);
        }

        if (
          String(order.userId) !==
          String(user.id)
        ) {
          return json({
            success: false,
            error:
              "Kamu tidak memiliki akses ke order ini."
          }, 403);
        }

        if (Number(order.legacy) !== 0) {
          return json({
            success: false,
            error:
              "Order lama tidak dapat menggunakan pembayaran ini."
          }, 400);
        }

        if (
          String(order.paymentStatus || "")
            .toUpperCase() === "PAID" ||
          String(order.status || "")
            .toUpperCase() === "PAID"
        ) {
          return json({
            success: false,
            error: "Order ini sudah dibayar."
          }, 409);
        }

        if (
          String(order.status || "")
            .toUpperCase() !== "PENDING_PAYMENT" ||
          String(order.paymentStatus || "")
            .toUpperCase() !== "PENDING"
        ) {
          return json({
            success: false,
            error:
              "Status order tidak dapat diproses untuk pembayaran."
          }, 409);
        }

        if (
          Number(order.serviceActive) !== 1 ||
          Number(order.providerActive) !== 1
        ) {
          return json({
            success: false,
            error: "Layanan SMM belum tersedia."
          }, 400);
        }

        if (
          !Number.isFinite(Number(order.price)) ||
          !Number.isSafeInteger(Number(order.price)) ||
          Number(order.price) <= 0
        ) {
          return json({
            success: false,
            error: "Total order SMM tidak valid."
          }, 400);
        }

        const sessionState =
          String(
            order.paymentSessionStatus || "NONE"
          ).toUpperCase();

        if (
          sessionState === "CREATED" &&
          order.paymentSessionId &&
          order.paymentUrl
        ) {
          return json({
            success: true,
            reused: true,
            paymentSessionId:
              order.paymentSessionId,
            paymentRequestId:
              order.paymentRequestId || null,
            paymentUrl:
              order.paymentUrl
          });
        }

        if (
          sessionState === "CREATING"
        ) {
          return json({
            success: false,
            error:
              "Sesi pembayaran sedang dibuat. Silakan tunggu dan periksa kembali."
          }, 409);
        }

        if (
          sessionState === "AMBIGUOUS"
        ) {
          return json({
            success: false,
            error:
              "Status pembuatan sesi pembayaran perlu diperiksa sebelum mencoba lagi."
          }, 409);
        }

        if (
          sessionState !== "NONE"
        ) {
          return json({
            success: false,
            error:
              "Status sesi pembayaran tidak valid."
          }, 409);
        }

        if (
          order.paymentSessionId ||
          order.paymentUrl
        ) {
          return json({
            success: false,
            error:
              "Metadata sesi pembayaran tidak konsisten."
          }, 409);
        }

        if (!env.XENDIT_SECRET_KEY) {
          return json({
            success: false,
            error:
              "XENDIT_SECRET_KEY belum tersedia."
          }, 500);
        }

        if (!env.PUBLIC_BASE_URL) {
          return json({
            success: false,
            error:
              "PUBLIC_BASE_URL belum tersedia."
          }, 500);
        }

        const email =
          String(user.email || "").trim();

        if (!email) {
          return json({
            success: false,
            error:
              "Email akun diperlukan untuk pembayaran."
          }, 400);
        }

        const customerName =
          String(
            user.name || "Pelanggan BAYORA"
          ).trim() ||
          "Pelanggan BAYORA";

        // Atomic claim BEFORE contacting Xendit.
        // Only one concurrent request can move NONE -> CREATING.
        const claimedAt =
          new Date().toISOString();

        const claimResult =
          await env.ppobku_db.prepare(`
            UPDATE smm_orders
            SET
              payment_session_status = 'CREATING',
              payment_session_claimed_at = ?,
              updated_at = ?
            WHERE order_id = ?
              AND user_id = ?
              AND legacy = 0
              AND status = 'PENDING_PAYMENT'
              AND payment_status = 'PENDING'
              AND payment_session_status = 'NONE'
              AND payment_session_id IS NULL
              AND payment_url IS NULL
          `)
            .bind(
              claimedAt,
              claimedAt,
              order.orderId,
              user.id
            )
            .run();

        if (
          Number(
            claimResult.meta?.changes || 0
          ) !== 1
        ) {
          const latest =
            await env.ppobku_db.prepare(`
              SELECT
                payment_status AS paymentStatus,
                status,
                payment_session_status AS paymentSessionStatus,
                payment_session_id AS paymentSessionId,
                payment_request_id AS paymentRequestId,
                payment_url AS paymentUrl
              FROM smm_orders
              WHERE order_id = ?
              LIMIT 1
            `)
              .bind(order.orderId)
              .first();

          if (
            String(
              latest?.paymentSessionStatus || ""
            ).toUpperCase() === "CREATED" &&
            latest?.paymentSessionId &&
            latest?.paymentUrl
          ) {
            return json({
              success: true,
              reused: true,
              paymentSessionId:
                latest.paymentSessionId,
              paymentRequestId:
                latest.paymentRequestId ||
                null,
              paymentUrl:
                latest.paymentUrl
            });
          }

          if (
            String(
              latest?.paymentSessionStatus || ""
            ).toUpperCase() === "CREATING"
          ) {
            return json({
              success: false,
              error:
                "Sesi pembayaran sedang dibuat. Silakan tunggu dan periksa kembali."
            }, 409);
          }

          if (
            String(
              latest?.paymentSessionStatus || ""
            ).toUpperCase() === "AMBIGUOUS"
          ) {
            return json({
              success: false,
              error:
                "Status pembuatan sesi pembayaran perlu diperiksa sebelum mencoba lagi."
            }, 409);
          }

          return json({
            success: false,
            error:
              "Status pembayaran berubah. Silakan periksa kembali order."
          }, 409);
        }

        const baseUrl =
          env.PUBLIC_BASE_URL.replace(/\/$/, "");

        const customerReferenceId =
          "CUST-" + crypto.randomUUID();

        let xenditResponse;
        let responseData = {};

        try {
          xenditResponse = await fetch(
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
                reference_id: order.orderId,
                session_type: "PAY",
                mode: "PAYMENT_LINK",
                amount: Number(order.price),
                currency: "IDR",
                country: "ID",
                locale: "id",

                success_return_url:
                  baseUrl +
                  "/?payment=success&smmOrderId=" +
                  encodeURIComponent(
                    order.orderId
                  ),

                cancel_return_url:
                  baseUrl +
                  "/?payment=cancel&smmOrderId=" +
                  encodeURIComponent(
                    order.orderId
                  ),

                customer: {
                  reference_id:
                    customerReferenceId,
                  type: "INDIVIDUAL",
                  email,
                  individual_detail: {
                    given_names:
                      customerName
                  }
                }
              })
            }
          );

          try {
            responseData =
              await xenditResponse.json();
          } catch {
            responseData = {};
          }

        } catch (fetchError) {
          // The request may have reached Xendit.
          // Never retry automatically.
          await env.ppobku_db.prepare(`
            UPDATE smm_orders
            SET
              payment_session_status = 'AMBIGUOUS',
              updated_at = ?
            WHERE order_id = ?
              AND payment_session_status = 'CREATING'
          `)
            .bind(
              new Date().toISOString(),
              order.orderId
            )
            .run();

          console.error(
            "[XENDIT SMM TRANSPORT ERROR]",
            fetchError?.message ||
            String(fetchError)
          );

          return json({
            success: false,
            error:
              "Status pembuatan pembayaran belum dapat dipastikan. Jangan mencoba pembayaran ulang terlebih dahulu."
          }, 502);
        }

        console.log(
          "[XENDIT SMM SESSION RESPONSE]",
          JSON.stringify({
            orderId: order.orderId,
            paymentSessionId:
              responseData?.payment_session_id ||
              null,
            paymentRequestId:
              responseData?.payment_request_id ||
              null,
            hasPaymentUrl:
              Boolean(
                responseData?.payment_link_url
              ),
            status:
              responseData?.status || null,
            httpStatus:
              xenditResponse.status
          })
        );

        if (!xenditResponse.ok) {
          // Xendit returned a definite HTTP response.
          // Release the claim because no successful
          // payment session was returned.
          await env.ppobku_db.prepare(`
            UPDATE smm_orders
            SET
              payment_session_status = 'NONE',
              payment_session_claimed_at = NULL,
              updated_at = ?
            WHERE order_id = ?
              AND payment_session_status = 'CREATING'
              AND payment_session_id IS NULL
          `)
            .bind(
              new Date().toISOString(),
              order.orderId
            )
            .run();

          console.error(
            "[XENDIT SMM ERROR]",
            JSON.stringify({
              orderId: order.orderId,
              status: xenditResponse.status,
              errorCode:
                responseData?.error_code ||
                responseData?.errorCode ||
                null
            })
          );

          return json({
            success: false,
            error:
              "Gagal membuat pembayaran Xendit."
          }, 502);
        }

        const paymentSessionId =
          responseData?.payment_session_id ||
          null;

        const paymentRequestId =
          responseData?.payment_request_id ||
          null;

        const paymentUrl =
          responseData?.payment_link_url ||
          null;

        if (
          !paymentSessionId ||
          !paymentUrl
        ) {
          // HTTP success without the identifiers we need
          // is ambiguous. Never create another session.
          await env.ppobku_db.prepare(`
            UPDATE smm_orders
            SET
              payment_session_status = 'AMBIGUOUS',
              updated_at = ?
            WHERE order_id = ?
              AND payment_session_status = 'CREATING'
          `)
            .bind(
              new Date().toISOString(),
              order.orderId
            )
            .run();

          return json({
            success: false,
            error:
              "Respons pembayaran Xendit tidak lengkap. Jangan mencoba pembayaran ulang terlebih dahulu."
          }, 502);
        }

        const completedAt =
          new Date().toISOString();

        const saveResult =
          await env.ppobku_db.prepare(`
            UPDATE smm_orders
            SET
              payment_session_id = ?,
              payment_request_id = ?,
              payment_url = ?,
              payment_session_status = 'CREATED',
              updated_at = ?
            WHERE order_id = ?
              AND legacy = 0
              AND status = 'PENDING_PAYMENT'
              AND payment_status = 'PENDING'
              AND payment_session_status = 'CREATING'
              AND payment_session_id IS NULL
          `)
            .bind(
              paymentSessionId,
              paymentRequestId,
              paymentUrl,
              completedAt,
              order.orderId
            )
            .run();

        if (
          Number(
            saveResult.meta?.changes || 0
          ) !== 1
        ) {
          // Xendit definitely returned a session, but we
          // could not safely persist it. Block retries.
          await env.ppobku_db.prepare(`
            UPDATE smm_orders
            SET
              payment_session_status = 'AMBIGUOUS',
              updated_at = ?
            WHERE order_id = ?
              AND payment_session_status = 'CREATING'
          `)
            .bind(
              new Date().toISOString(),
              order.orderId
            )
            .run();

          console.error(
            "[XENDIT SMM SAVE ERROR]",
            JSON.stringify({
              orderId: order.orderId,
              paymentSessionId
            })
          );

          return json({
            success: false,
            error:
              "Sesi pembayaran dibuat tetapi belum dapat disimpan dengan aman. Jangan mencoba pembayaran ulang terlebih dahulu."
          }, 500);
        }

        return json({
          success: true,
          reused: false,
          paymentSessionId,
          paymentRequestId,
          paymentUrl
        });

      } catch (error) {
        console.error(
          "[XENDIT SMM PAYMENT]",
          error?.message || String(error)
        );

        return json({
          success: false,
          error:
            "Gagal membuat pembayaran Xendit."
        }, 500);
      }
    }


    // ========================================
    // XENDIT SMM SYNC
    // ========================================
    // Verifies the stored Xendit session directly.
    // COMPLETED only marks the local SMM payment as PAID.
    // This route NEVER submits the order to a provider.
    if (
      request.method === "POST" &&
      url.pathname.startsWith(
        "/api/smm/transactions/"
      ) &&
      url.pathname.endsWith("/sync")
    ) {
      try {
        const prefix =
          "/api/smm/transactions/";

        const suffix = "/sync";

        const encodedOrderId =
          url.pathname.slice(
            prefix.length,
            -suffix.length
          );

        let orderId = "";

        try {
          orderId =
            decodeURIComponent(
              encodedOrderId
            ).trim();
        } catch {
          return json({
            success: false,
            error: "orderId tidak valid."
          }, 400);
        }

        if (
          !orderId ||
          orderId.includes("/")
        ) {
          return json({
            success: false,
            error: "orderId tidak valid."
          }, 400);
        }

        const user =
          await getCurrentUser(
            request,
            env.ppobku_db
          );

        if (!user) {
          return json({
            success: false,
            error:
              "Silakan login terlebih dahulu."
          }, 401);
        }

        const order =
          await env.ppobku_db.prepare(`
            SELECT
              id,
              order_id AS orderId,
              user_id AS userId,
              status,
              payment_status AS paymentStatus,
              payment_session_id AS paymentSessionId,
              payment_request_id AS paymentRequestId,
              payment_session_status AS paymentSessionStatus,
              paid_at AS paidAt,
              submission_status AS submissionStatus,
              provider_order_id AS providerOrderId,
              legacy
            FROM smm_orders
            WHERE order_id = ?
            LIMIT 1
          `)
            .bind(orderId)
            .first();

        if (!order) {
          return json({
            success: false,
            error:
              "Order SMM tidak ditemukan."
          }, 404);
        }

        if (
          String(order.userId) !==
          String(user.id)
        ) {
          return json({
            success: false,
            error:
              "Kamu tidak memiliki akses ke order ini."
          }, 403);
        }

        if (Number(order.legacy) !== 0) {
          return json({
            success: false,
            error:
              "Order lama tidak dapat menggunakan sinkronisasi pembayaran ini."
          }, 400);
        }

        if (
          order.providerOrderId
        ) {
          return json({
            success: false,
            error:
              "Order ini sudah memiliki referensi provider."
          }, 409);
        }

        if (
          String(
            order.submissionStatus || ""
          ).toUpperCase() !== "BLOCKED"
        ) {
          return json({
            success: false,
            error:
              "Status submission order tidak aman untuk sinkronisasi pembayaran."
          }, 409);
        }

        // Already paid is idempotent and does not
        // contact Xendit or any provider.
        if (
          String(
            order.paymentStatus || ""
          ).toUpperCase() === "PAID"
        ) {
          return json({
            success: true,
            changed: false,
            paymentStatus: "PAID",
            status: order.status,
            paidAt: order.paidAt || null
          });
        }

        if (
          String(order.status || "")
            .toUpperCase() !==
            "PENDING_PAYMENT" ||
          String(
            order.paymentStatus || ""
          ).toUpperCase() !== "PENDING"
        ) {
          return json({
            success: false,
            error:
              "Status order tidak dapat disinkronkan."
          }, 409);
        }

        if (
          String(
            order.paymentSessionStatus || ""
          ).toUpperCase() !== "CREATED"
        ) {
          return json({
            success: false,
            error:
              "Sesi pembayaran belum siap untuk disinkronkan."
          }, 409);
        }

        if (!order.paymentSessionId) {
          return json({
            success: false,
            error:
              "payment_session_id belum tersedia."
          }, 409);
        }

        if (!env.XENDIT_SECRET_KEY) {
          console.error(
            "[XENDIT SMM SYNC] XENDIT_SECRET_KEY belum tersedia."
          );

          return json({
            success: false,
            error:
              "XENDIT_SECRET_KEY belum tersedia."
          }, 500);
        }

        const xenditResponse =
          await fetch(
            "https://api.xendit.co/sessions/" +
            encodeURIComponent(
              order.paymentSessionId
            ),
            {
              method: "GET",
              headers: {
                "Authorization":
                  "Basic " +
                  btoa(
                    env.XENDIT_SECRET_KEY +
                    ":"
                  )
              }
            }
          );

        const session =
          await xenditResponse
            .json()
            .catch(() => ({}));

        if (!xenditResponse.ok) {
          console.error(
            "[XENDIT SMM SYNC ERROR]",
            JSON.stringify({
              orderId: order.orderId,
              httpStatus:
                xenditResponse.status
            })
          );

          return json({
            success: false,
            error:
              "Gagal memeriksa status pembayaran Xendit."
          }, 502);
        }

        const returnedSessionId =
          session?.payment_session_id ||
          session?.id ||
          null;

        if (
          returnedSessionId &&
          String(returnedSessionId) !==
          String(order.paymentSessionId)
        ) {
          console.error(
            "[XENDIT SMM SYNC] SESSION MISMATCH",
            JSON.stringify({
              orderId: order.orderId
            })
          );

          return json({
            success: false,
            error:
              "Identitas sesi pembayaran tidak cocok."
          }, 409);
        }

        const referenceId =
          session?.reference_id ||
          session?.referenceId ||
          null;

        if (
          referenceId &&
          String(referenceId) !==
          String(order.orderId)
        ) {
          console.error(
            "[XENDIT SMM SYNC] REFERENCE MISMATCH",
            JSON.stringify({
              orderId: order.orderId
            })
          );

          return json({
            success: false,
            error:
              "Referensi pembayaran tidak cocok."
          }, 409);
        }

        const sessionStatus =
          String(
            session?.status || ""
          ).toUpperCase();

        console.log(
          "[XENDIT SMM SYNC]",
          JSON.stringify({
            orderId: order.orderId,
            paymentSessionId:
              order.paymentSessionId,
            sessionStatus,
            paymentRequestId:
              session?.payment_request_id ||
              null
          })
        );

        if (
          sessionStatus !== "COMPLETED"
        ) {
          return json({
            success: true,
            changed: false,
            paymentStatus: "PENDING",
            sessionStatus
          });
        }

        const paymentRequestId =
          session?.payment_request_id ||
          order.paymentRequestId ||
          null;

        const paidAt =
          new Date().toISOString();

        /*
         * Payment completion only.
         *
         * submission_status remains BLOCKED.
         * provider_order_id remains NULL.
         * No provider API is called here.
         */
        const update =
          await env.ppobku_db.prepare(`
            UPDATE smm_orders
            SET
              status = 'PAID',
              payment_status = 'PAID',
              payment_request_id =
                COALESCE(
                  payment_request_id,
                  ?
                ),
              paid_at =
                COALESCE(
                  paid_at,
                  ?
                ),
              updated_at = ?
            WHERE order_id = ?
              AND legacy = 0
              AND status = 'PENDING_PAYMENT'
              AND payment_status = 'PENDING'
              AND payment_session_status = 'CREATED'
              AND payment_session_id = ?
              AND submission_status = 'BLOCKED'
              AND provider_order_id IS NULL
          `)
            .bind(
              paymentRequestId,
              paidAt,
              paidAt,
              order.orderId,
              order.paymentSessionId
            )
            .run();

        const changed =
          Number(
            update.meta?.changes || 0
          ) === 1;

        if (!changed) {
          const latest =
            await env.ppobku_db.prepare(`
              SELECT
                status,
                payment_status AS paymentStatus,
                paid_at AS paidAt,
                submission_status AS submissionStatus,
                provider_order_id AS providerOrderId
              FROM smm_orders
              WHERE order_id = ?
              LIMIT 1
            `)
              .bind(order.orderId)
              .first();

          if (
            String(
              latest?.paymentStatus || ""
            ).toUpperCase() === "PAID" &&
            String(
              latest?.submissionStatus || ""
            ).toUpperCase() === "BLOCKED" &&
            !latest?.providerOrderId
          ) {
            return json({
              success: true,
              changed: false,
              paymentStatus: "PAID",
              status: latest.status,
              paidAt:
                latest.paidAt || null
            });
          }

          return json({
            success: false,
            error:
              "Status order berubah saat pembayaran disinkronkan."
          }, 409);
        }

        return json({
          success: true,
          changed: true,
          paymentStatus: "PAID",
          status: "PAID",
          paidAt
        });

      } catch (error) {
        console.error(
          "[XENDIT SMM SYNC]",
          error?.message ||
          String(error)
        );

        return json({
          success: false,
          error:
            "Gagal menyinkronkan pembayaran SMM."
        }, 500);
      }
    }


    // ========================================
    // SMM SUBMISSION CLAIM
    // ========================================
    // Stage 7D-11D:
    // - Authenticated user only
    // - Ownership guard
    // - Legacy orders blocked
    // - Payment must already be PAID
    // - Xendit session must be CREATED
    // - Provider order must still be NULL
    // - Atomic BLOCKED -> SUBMITTING
    //
    // IMPORTANT:
    // This route NEVER calls Djuragan.
    // This route NEVER performs action=add.
    // ========================================

    if (
      request.method === "POST" &&
      url.pathname.startsWith(
        "/api/smm/transactions/"
      ) &&
      url.pathname.endsWith("/submit")
    ) {
      try {
        const prefix =
          "/api/smm/transactions/";

        const suffix =
          "/submit";

        const encodedOrderId =
          url.pathname.slice(
            prefix.length,
            -suffix.length
          );

        let orderId = "";

        try {
          orderId =
            decodeURIComponent(
              encodedOrderId
            ).trim();
        } catch {
          return json({
            success: false,
            error: "orderId tidak valid."
          }, 400);
        }

        if (
          !orderId ||
          orderId.includes("/")
        ) {
          return json({
            success: false,
            error: "orderId tidak valid."
          }, 400);
        }

        const user =
          await getCurrentUser(
            request,
            env.ppobku_db
          );

        if (!user) {
          return json({
            success: false,
            error:
              "Silakan login terlebih dahulu."
          }, 401);
        }

        const order =
          await env.ppobku_db.prepare(`
            SELECT
              o.id,
              o.order_id AS orderId,
              o.user_id AS userId,
              o.status,
              o.payment_status AS paymentStatus,
              o.payment_session_status AS paymentSessionStatus,
              o.submission_status AS submissionStatus,
              o.provider_order_id AS providerOrderId,
              o.legacy,
              s.provider_id AS providerId,
              s.provider_service_id AS providerServiceId,
              s.active AS serviceActive,
              p.name AS providerName,
              p.active AS providerActive
            FROM smm_orders o
            INNER JOIN smm_services s
              ON s.id = o.service_id
            INNER JOIN smm_providers p
              ON p.id = s.provider_id
            WHERE o.order_id = ?
            LIMIT 1
          `)
            .bind(orderId)
            .first();

        if (!order) {
          return json({
            success: false,
            error:
              "Order SMM tidak ditemukan."
          }, 404);
        }

        if (
          String(order.userId) !==
          String(user.id)
        ) {
          return json({
            success: false,
            error:
              "Kamu tidak memiliki akses ke order ini."
          }, 403);
        }

        if (
          Number(order.legacy) === 1
        ) {
          return json({
            success: false,
            error:
              "Order lama tidak dapat dikirim ke provider."
          }, 400);
        }

        if (
          String(
            order.paymentStatus || ""
          ).toUpperCase() !== "PAID"
        ) {
          return json({
            success: false,
            error:
              "Pembayaran order belum terverifikasi."
          }, 400);
        }

        if (
          String(
            order.paymentSessionStatus || ""
          ).toUpperCase() !== "CREATED"
        ) {
          return json({
            success: false,
            error:
              "Payment session order belum siap."
          }, 400);
        }

        if (order.providerOrderId) {
          return json({
            success: false,
            error:
              "Order sudah memiliki provider order."
          }, 409);
        }

        if (
          String(
            order.submissionStatus || ""
          ).toUpperCase() !== "BLOCKED"
        ) {
          return json({
            success: false,
            error:
              "Order tidak berada pada status submission yang dapat di-claim."
          }, 409);
        }

        /*
         * Stage 7D-12G
         *
         * Provider readiness MUST be validated before
         * BLOCKED -> SUBMITTING.
         *
         * This prevents a paid order from becoming
         * stranded in SUBMITTING merely because its
         * service/provider is disabled or misconfigured.
         */
        if (
          Number(order.serviceActive) !== 1 ||
          Number(order.providerActive) !== 1
        ) {
          return json({
            success: false,
            error:
              "Layanan atau provider SMM belum aktif.",
            submissionStatus:
              "BLOCKED"
          }, 400);
        }

        if (
          Number(order.providerId) !== 2 ||
          String(order.providerName || "")
            .trim()
            .toLowerCase() !==
              "djuragansosmed"
        ) {
          return json({
            success: false,
            error:
              "Provider order bukan DjuraganSosmed.",
            submissionStatus:
              "BLOCKED"
          }, 400);
        }

        if (!order.providerServiceId) {
          return json({
            success: false,
            error:
              "Provider service ID tidak tersedia.",
            submissionStatus:
              "BLOCKED"
          }, 400);
        }

        const now =
          new Date().toISOString();

        const claimResult =
          await env.ppobku_db.prepare(`
            UPDATE smm_orders
            SET
              submission_status = 'SUBMITTING',
              submission_claimed_at = ?,
              updated_at = ?
            WHERE order_id = ?
              AND user_id = ?
              AND legacy = 0
              AND payment_status = 'PAID'
              AND payment_session_status = 'CREATED'
              AND submission_status = 'BLOCKED'
              AND provider_order_id IS NULL
          `)
            .bind(
              now,
              now,
              orderId,
              user.id
            )
            .run();

        const changes =
          Number(
            claimResult?.meta?.changes || 0
          );

        if (changes !== 1) {
          return json({
            success: false,
            error:
              "Order sedang diproses atau status order sudah berubah."
          }, 409);
        }

        return json({
          success: true,
          claimed: true,
          submissionStatus:
            "SUBMITTING",
          orderId,
          claimedAt: now
        });

      } catch (error) {
        console.error(
          "[SMM SUBMISSION CLAIM]",
          error?.message ||
          String(error)
        );

        return json({
          success: false,
          error:
            "Gagal mengunci submission order SMM."
        }, 500);
      }
    }



    // ========================================
    // SMM SUBMISSION RECOVERY
    // ========================================
    // Stage 7D-11H
    //
    // Converts a stale SUBMITTING order into
    // AMBIGUOUS without contacting the provider.
    //
    // SAFETY:
    // - POST only
    // - Admin only
    // - legacy orders blocked
    // - payment must remain PAID
    // - Xendit session must remain CREATED
    // - provider_order_id must remain NULL
    // - only stale claims may be recovered
    // - NEVER calls Djuragan
    // - NEVER performs action=add
    // ========================================

    if (
      request.method === "POST" &&
      url.pathname === "/api/admin/smm/recover-submission"
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

        const adminSession =
          await env.ppobku_db.prepare(`
            SELECT
              id
            FROM admin_sessions
            WHERE token_hash = ?
            LIMIT 1
          `)
            .bind(tokenHash)
            .first();

        if (!adminSession) {
          return json({
            success: false,
            error: "Sesi admin tidak valid."
          }, 401);
        }

        const body =
          await request.json().catch(() => ({}));

        const orderId =
          String(
            body?.orderId || ""
          ).trim();

        if (!orderId) {
          return json({
            success: false,
            error: "orderId wajib diisi."
          }, 400);
        }

        const order =
          await env.ppobku_db.prepare(`
            SELECT
              order_id AS orderId,
              user_id AS userId,
              status,
              payment_status AS paymentStatus,
              payment_session_status AS paymentSessionStatus,
              submission_status AS submissionStatus,
              submission_claimed_at AS submissionClaimedAt,
              provider_order_id AS providerOrderId,
              legacy
            FROM smm_orders
            WHERE order_id = ?
            LIMIT 1
          `)
            .bind(orderId)
            .first();

        if (!order) {
          return json({
            success: false,
            error: "Order SMM tidak ditemukan."
          }, 404);
        }

        if (Number(order.legacy) !== 0) {
          return json({
            success: false,
            error:
              "Order lama tidak dapat direcovery."
          }, 400);
        }

        if (
          String(order.paymentStatus || "")
            .toUpperCase() !== "PAID"
        ) {
          return json({
            success: false,
            error:
              "Pembayaran order belum PAID."
          }, 400);
        }

        if (
          String(order.paymentSessionStatus || "")
            .toUpperCase() !== "CREATED"
        ) {
          return json({
            success: false,
            error:
              "Payment session order belum CREATED."
          }, 400);
        }

        const recoverableSubmissionStatus =
          String(order.submissionStatus || "")
            .toUpperCase();

        if (
          ![
            "SUBMITTING",
            "SENDING"
          ].includes(
            recoverableSubmissionStatus
          )
        ) {
          return json({
            success: false,
            error:
              "Order tidak berada pada status SUBMITTING atau SENDING."
          }, 409);
        }

        if (order.providerOrderId) {
          return json({
            success: false,
            error:
              "Order sudah memiliki provider order."
          }, 409);
        }

        if (!order.submissionClaimedAt) {
          return json({
            success: false,
            error:
              "Waktu claim submission tidak tersedia."
          }, 409);
        }

        const claimedAt =
          Date.parse(
            String(order.submissionClaimedAt)
          );

        if (!Number.isFinite(claimedAt)) {
          return json({
            success: false,
            error:
              "Waktu claim submission tidak valid."
          }, 409);
        }

        const nowMs =
          Date.now();

        const recoveryAgeMs =
          nowMs - claimedAt;

        const recoveryThresholdMs =
          10 * 60 * 1000;

        if (
          recoveryAgeMs <
          recoveryThresholdMs
        ) {
          return json({
            success: false,
            error:
              "Submission belum cukup lama untuk direcovery.",
            ageSeconds:
              Math.floor(
                recoveryAgeMs / 1000
              ),
            requiredSeconds: 600
          }, 409);
        }

        const now =
          new Date().toISOString();

        const update =
          await env.ppobku_db.prepare(`
            UPDATE smm_orders
            SET
              submission_status = 'AMBIGUOUS',
              updated_at = ?
            WHERE order_id = ?
              AND legacy = 0
              AND payment_status = 'PAID'
              AND payment_session_status = 'CREATED'
              AND submission_status = ?
              AND provider_order_id IS NULL
              AND submission_claimed_at = ?
          `)
            .bind(
              now,
              orderId,
              recoverableSubmissionStatus,
              order.submissionClaimedAt
            )
            .run();

        const changes =
          Number(
            update?.meta?.changes || 0
          );

        if (changes !== 1) {
          return json({
            success: false,
            error:
              "Status order berubah sebelum recovery."
          }, 409);
        }

        return json({
          success: true,
          recovered: true,
          orderId,
          previousSubmissionStatus:
            recoverableSubmissionStatus,
          submissionStatus:
            "AMBIGUOUS",
          providerOrderId: null,
          recoveredAt: now
        });

      } catch (error) {
        console.error(
          "[SMM SUBMISSION RECOVERY]",
          error?.message ||
          String(error)
        );

        return json({
          success: false,
          error:
            "Gagal melakukan recovery submission SMM."
        }, 500);
      }
    }



    // ========================================
    // SMM PROVIDER SUBMISSION
    // ========================================
    // Stage 7D-12A
    //
    // Actual provider submission.
    //
    // SAFETY:
    // - POST only
    // - authenticated user
    // - ownership guard
    // - legacy orders blocked
    // - payment must be PAID
    // - Xendit session must be CREATED
    // - submission must be SUBMITTING
    // - provider_order_id must be NULL
    // - service/provider must be active
    //
    // RESULT:
    // - provider success  -> provider_order_id + PROCESSING
    // - provider rejection -> FAILED
    // - network ambiguity -> AMBIGUOUS
    //
    // IMPORTANT:
    // Never automatically retry AMBIGUOUS orders.
    // ========================================

    if (
      request.method === "POST" &&
      url.pathname.startsWith(
        "/api/smm/transactions/"
      ) &&
      url.pathname.endsWith("/provider-submit")
    ) {
      try {
        const prefix =
          "/api/smm/transactions/";

        const suffix =
          "/provider-submit";

        const encodedOrderId =
          url.pathname.slice(
            prefix.length,
            -suffix.length
          );

        let orderId = "";

        try {
          orderId =
            decodeURIComponent(
              encodedOrderId
            ).trim();
        } catch {
          return json({
            success: false,
            error: "orderId tidak valid."
          }, 400);
        }

        if (
          !orderId ||
          orderId.includes("/")
        ) {
          return json({
            success: false,
            error: "orderId tidak valid."
          }, 400);
        }

        const user =
          await getCurrentUser(
            request,
            env.ppobku_db
          );

        if (!user) {
          return json({
            success: false,
            error:
              "Silakan login terlebih dahulu."
          }, 401);
        }

        const order =
          await env.ppobku_db.prepare(`
            SELECT
              o.id,
              o.order_id AS orderId,
              o.user_id AS userId,
              o.service_id AS serviceId,
              o.target,
              o.quantity,
              o.price,
              o.status,
              o.payment_status AS paymentStatus,
              o.payment_session_status AS paymentSessionStatus,
              o.submission_status AS submissionStatus,
              o.submission_claimed_at AS submissionClaimedAt,
              o.provider_order_id AS providerOrderId,
              o.provider_message AS providerMessage,
              o.legacy,
              s.provider_id AS providerId,
              s.provider_service_id AS providerServiceId,
              s.active AS serviceActive,
              s.min_quantity AS minQuantity,
              s.max_quantity AS maxQuantity,
              s.provider_type AS providerType,
              s.provider_rate AS providerRate,
              p.name AS providerName,
              p.api_url AS providerApiUrl,
              p.api_key AS providerApiKey,
              p.active AS providerActive
            FROM smm_orders o
            INNER JOIN smm_services s
              ON s.id = o.service_id
            INNER JOIN smm_providers p
              ON p.id = s.provider_id
            WHERE o.order_id = ?
            LIMIT 1
          `)
            .bind(orderId)
            .first();

        if (!order) {
          return json({
            success: false,
            error:
              "Order SMM tidak ditemukan."
          }, 404);
        }

        if (
          String(order.userId) !==
          String(user.id)
        ) {
          return json({
            success: false,
            error:
              "Kamu tidak memiliki akses ke order ini."
          }, 403);
        }

        if (
          Number(order.legacy) !== 0
        ) {
          return json({
            success: false,
            error:
              "Order lama tidak dapat dikirim ke provider."
          }, 400);
        }

        if (
          String(order.paymentStatus || "")
            .toUpperCase() !== "PAID"
        ) {
          return json({
            success: false,
            error:
              "Pembayaran order belum terverifikasi."
          }, 400);
        }

        if (
          String(order.paymentSessionStatus || "")
            .toUpperCase() !== "CREATED"
        ) {
          return json({
            success: false,
            error:
              "Payment session order belum siap."
          }, 400);
        }

        if (
          String(order.submissionStatus || "")
            .toUpperCase() !== "SUBMITTING"
        ) {
          return json({
            success: false,
            error:
              "Order belum berada pada status SUBMITTING."
          }, 409);
        }

        if (order.providerOrderId) {
          return json({
            success: true,
            alreadySubmitted: true,
            submissionStatus:
              order.submissionStatus,
            providerOrderId:
              order.providerOrderId
          });
        }

        if (
          Number(order.serviceActive) !== 1 ||
          Number(order.providerActive) !== 1
        ) {
          return json({
            success: false,
            error:
              "Layanan atau provider SMM belum aktif."
          }, 400);
        }

        if (
          Number(order.providerId) !== 2 ||
          String(order.providerName || "")
            .trim()
            .toLowerCase() !== "djuragansosmed"
        ) {
          return json({
            success: false,
            error:
              "Provider order bukan DjuraganSosmed."
          }, 400);
        }

        /*
         * Stage 7D-12H
         * Final send-time service validation.
         */
        const quantity =
          Number(order.quantity);

        const minQuantity =
          Number(order.minQuantity);

        const maxQuantity =
          Number(order.maxQuantity);

        const providerRate =
          Number(order.providerRate);

        const providerType =
          String(order.providerType || "")
            .trim()
            .toLowerCase();

        if (
          !Number.isInteger(quantity) ||
          !Number.isFinite(minQuantity) ||
          !Number.isFinite(maxQuantity) ||
          quantity < minQuantity ||
          quantity > maxQuantity
        ) {
          return json({
            success: false,
            error:
              "Quantity order tidak lagi sesuai batas layanan.",
            submissionStatus:
              "SUBMITTING"
          }, 400);
        }

        if (
          !Number.isFinite(providerRate) ||
          providerRate <= 0
        ) {
          return json({
            success: false,
            error:
              "Provider rate layanan tidak valid.",
            submissionStatus:
              "SUBMITTING"
          }, 400);
        }

        if (
          providerType &&
          providerType !== "default"
        ) {
          return json({
            success: false,
            error:
              "Tipe layanan provider belum didukung.",
            submissionStatus:
              "SUBMITTING"
          }, 400);
        }

        const providerApiUrl =
          "https://djuragansosmed.com/api/v2";

        const providerApiKey =
          String(
            env.DJURAGANSOSMED_API_KEY ||
            ""
          ).trim();

        if (!providerApiKey) {
          await env.ppobku_db.prepare(`
            UPDATE smm_orders
            SET
              submission_status = 'FAILED',
              provider_message = ?,
              updated_at = ?
            WHERE order_id = ?
              AND legacy = 0
              AND payment_status = 'PAID'
              AND payment_session_status = 'CREATED'
              AND submission_status = 'SUBMITTING'
              AND provider_order_id IS NULL
          `)
            .bind(
              "Provider API key belum dikonfigurasi.",
              new Date().toISOString(),
              order.orderId
            )
            .run();

          return json({
            success: false,
            error:
              "Provider API key belum dikonfigurasi.",
            submissionStatus:
              "FAILED"
          }, 500);
        }

        if (!order.providerServiceId) {
          await env.ppobku_db.prepare(`
            UPDATE smm_orders
            SET
              submission_status = 'FAILED',
              provider_message = ?,
              updated_at = ?
            WHERE order_id = ?
              AND submission_status = 'SUBMITTING'
              AND provider_order_id IS NULL
          `)
            .bind(
              "Provider service ID tidak tersedia.",
              new Date().toISOString(),
              order.orderId
            )
            .run();

          return json({
            success: false,
            error:
              "Provider service ID tidak tersedia.",
            submissionStatus:
              "FAILED"
          }, 400);
        }

        // Atomic execution claim:
        // only one request may transition SUBMITTING -> SENDING.
        const sendingAt =
          new Date().toISOString();

        const sendClaim =
          await env.ppobku_db.prepare(`
            UPDATE smm_orders
            SET
              submission_status = 'SENDING',
              submission_claimed_at = ?,
              provider_message = ?,
              updated_at = ?
            WHERE order_id = ?
              AND legacy = 0
              AND payment_status = 'PAID'
              AND payment_session_status = 'CREATED'
              AND submission_status = 'SUBMITTING'
              AND provider_order_id IS NULL
          `)
            .bind(
              sendingAt,
              "Mengirim order ke provider.",
              sendingAt,
              order.orderId
            )
            .run();

        if (
          Number(sendClaim?.meta?.changes || 0) !== 1
        ) {
          return json({
            success: false,
            error:
              "Submission sudah diproses oleh request lain.",
            submissionStatus:
              "SENDING"
          }, 409);
        }

        const body =
          new URLSearchParams();

        body.set(
          "key",
          providerApiKey
        );

        body.set(
          "action",
          "add"
        );

        body.set(
          "service",
          String(
            order.providerServiceId
          )
        );

        body.set(
          "link",
          String(
            order.target
          )
        );

        body.set(
          "quantity",
          String(
            order.quantity
          )
        );

        console.log(
          "[SMM PROVIDER SUBMIT]",
          JSON.stringify({
            orderId: order.orderId,
            provider:
              order.providerName || null,
            providerServiceId:
              order.providerServiceId,
            quantity:
              order.quantity
          })
        );

        let response;

        try {
          response =
            await fetch(
              providerApiUrl,
              {
                method: "POST",
                headers: {
                  "Content-Type":
                    "application/x-www-form-urlencoded"
                },
                body:
                  body.toString()
              }
            );
        } catch (providerError) {
          const message =
            String(
              providerError?.message ||
              providerError ||
              "Provider request failed."
            );

          await env.ppobku_db.prepare(`
            UPDATE smm_orders
            SET
              submission_status = 'AMBIGUOUS',
              provider_message = ?,
              updated_at = ?
            WHERE order_id = ?
              AND legacy = 0
              AND payment_status = 'PAID'
              AND payment_session_status = 'CREATED'
              AND submission_status = 'SENDING'
              AND provider_order_id IS NULL
          `)
            .bind(
              message.slice(0, 1000),
              new Date().toISOString(),
              order.orderId
            )
            .run();

          return json({
            success: false,
            error:
              "Status submission provider tidak dapat dipastikan.",
            submissionStatus:
              "AMBIGUOUS"
          }, 502);
        }

        const raw =
          await response.text();

        let data = {};

        try {
          data =
            JSON.parse(raw);
        } catch {
          data = {
            raw: raw.slice(0, 1000)
          };
        }

        /*
         * Never log the raw provider response.
         * Keep only non-sensitive operational metadata.
         */
        console.log(
          "[SMM PROVIDER RESPONSE]",
          JSON.stringify({
            orderId:
              order.orderId,
            httpStatus:
              response.status,
            hasProviderOrderId:
              Boolean(
                data?.order ||
                data?.order_id ||
                data?.id
              ),
            hasProviderError:
              Boolean(
                data?.error ||
                data?.message ||
                data?.msg
              )
          })
        );

        const providerOrderId =
          data?.order ||
          data?.order_id ||
          data?.id ||
          null;

        const providerError =
          data?.error ||
          data?.message ||
          data?.msg ||
          null;

        if (
          response.ok &&
          providerOrderId
        ) {
          const now =
            new Date().toISOString();

          const update =
            await env.ppobku_db.prepare(`
              UPDATE smm_orders
              SET
                provider_order_id = ?,
                status = 'PROCESSING',
                submission_status = 'SUBMITTED',
                provider_message = ?,
                updated_at = ?
              WHERE order_id = ?
                AND legacy = 0
                AND payment_status = 'PAID'
                AND payment_session_status = 'CREATED'
                AND submission_status = 'SENDING'
                AND provider_order_id IS NULL
            `)
              .bind(
                String(providerOrderId),
                providerError
                  ? String(providerError).slice(0, 1000)
                  : "Provider menerima order.",
                now,
                order.orderId
              )
              .run();

          const changes =
            Number(
              update?.meta?.changes || 0
            );

          if (changes !== 1) {
            return json({
              success: false,
              error:
                "Provider menerima order tetapi status lokal berubah bersamaan.",
              submissionStatus:
                "AMBIGUOUS"
            }, 409);
          }

          return json({
            success: true,
            submitted: true,
            submissionStatus:
              "SUBMITTED",
            status:
              "PROCESSING",
            providerOrderId:
              String(providerOrderId)
          });
        }

        if (
          response.ok &&
          !providerOrderId
        ) {
          const now =
            new Date().toISOString();

          await env.ppobku_db.prepare(`
            UPDATE smm_orders
            SET
              submission_status = 'AMBIGUOUS',
              provider_message = ?,
              updated_at = ?
            WHERE order_id = ?
              AND legacy = 0
              AND payment_status = 'PAID'
              AND payment_session_status = 'CREATED'
              AND submission_status = 'SENDING'
              AND provider_order_id IS NULL
          `)
            .bind(
              (
                providerError ||
                "Provider response tidak memiliki provider order ID."
              ).toString().slice(0, 1000),
              now,
              order.orderId
            )
            .run();

          return json({
            success: false,
            error:
              "Provider menerima response tetapi order ID tidak dapat dipastikan.",
            submissionStatus:
              "AMBIGUOUS"
          }, 502);
        }

        const now =
          new Date().toISOString();

        const providerFailureStatus =
          response.status >= 500
            ? "AMBIGUOUS"
            : "FAILED";

        await env.ppobku_db.prepare(`
          UPDATE smm_orders
          SET
            submission_status = ?,
            provider_message = ?,
            updated_at = ?
          WHERE order_id = ?
            AND legacy = 0
            AND payment_status = 'PAID'
            AND payment_session_status = 'CREATED'
            AND submission_status = 'SENDING'
            AND provider_order_id IS NULL
        `)
          .bind(
            providerFailureStatus,
            (
              providerError ||
              `Provider HTTP ${response.status}.`
            ).toString().slice(0, 1000),
            now,
            order.orderId
          )
          .run();

        return json({
          success: false,
          error:
            providerError ||
            `Provider menolak order (HTTP ${response.status}).`,
          submissionStatus:
            providerFailureStatus
        }, response.status >= 500 ? 502 : 400);

      } catch (error) {
        console.error(
          "[SMM PROVIDER SUBMIT]",
          error?.message ||
          String(error)
        );

        return json({
          success: false,
          error:
            "Gagal mengirim order SMM ke provider."
        }, 500);
      }
    }



    // ========================================
    // SMM PROVIDER STATUS
    // ========================================
    // Stage 7D-12E
    //
    // Read-only provider operation:
    // action=status
    //
    // SAFETY:
    // - authenticated owner only
    // - legacy blocked
    // - payment must be PAID
    // - submission must be SUBMITTED
    // - provider_order_id required
    // - hard-locked to DjuraganSosmed provider ID 2
    // - never calls action=add
    // ========================================

    if (
      request.method === "POST" &&
      url.pathname.startsWith(
        "/api/smm/transactions/"
      ) &&
      url.pathname.endsWith(
        "/provider-status"
      )
    ) {
      try {
        const prefix =
          "/api/smm/transactions/";

        const suffix =
          "/provider-status";

        const encodedOrderId =
          url.pathname.slice(
            prefix.length,
            -suffix.length
          );

        let orderId = "";

        try {
          orderId =
            decodeURIComponent(
              encodedOrderId
            ).trim();
        } catch {
          return json({
            success: false,
            error: "orderId tidak valid."
          }, 400);
        }

        if (
          !orderId ||
          orderId.includes("/")
        ) {
          return json({
            success: false,
            error: "orderId tidak valid."
          }, 400);
        }

        const user =
          await getCurrentUser(
            request,
            env.ppobku_db
          );

        if (!user) {
          return json({
            success: false,
            error:
              "Silakan login terlebih dahulu."
          }, 401);
        }

        const order =
          await env.ppobku_db.prepare(`
            SELECT
              o.order_id AS orderId,
              o.user_id AS userId,
              o.status,
              o.payment_status AS paymentStatus,
              o.submission_status AS submissionStatus,
              o.provider_order_id AS providerOrderId,
              o.legacy,
              s.provider_id AS providerId,
              p.name AS providerName
            FROM smm_orders o
            INNER JOIN smm_services s
              ON s.id = o.service_id
            INNER JOIN smm_providers p
              ON p.id = s.provider_id
            WHERE o.order_id = ?
            LIMIT 1
          `)
            .bind(orderId)
            .first();

        if (!order) {
          return json({
            success: false,
            error:
              "Order SMM tidak ditemukan."
          }, 404);
        }

        if (
          String(order.userId) !==
          String(user.id)
        ) {
          return json({
            success: false,
            error:
              "Kamu tidak memiliki akses ke order ini."
          }, 403);
        }

        if (
          Number(order.legacy) !== 0
        ) {
          return json({
            success: false,
            error:
              "Order lama tidak dapat dicek ke provider."
          }, 400);
        }

        if (
          String(order.paymentStatus || "")
            .toUpperCase() !== "PAID"
        ) {
          return json({
            success: false,
            error:
              "Pembayaran order belum terverifikasi."
          }, 400);
        }

        if (
          String(order.submissionStatus || "")
            .toUpperCase() !== "SUBMITTED"
        ) {
          return json({
            success: false,
            error:
              "Order belum berhasil dikirim ke provider."
          }, 409);
        }

        if (!order.providerOrderId) {
          return json({
            success: false,
            error:
              "Provider order ID tidak tersedia."
          }, 409);
        }

        if (
          Number(order.providerId) !== 2 ||
          String(order.providerName || "")
            .trim()
            .toLowerCase() !==
              "djuragansosmed"
        ) {
          return json({
            success: false,
            error:
              "Provider order bukan DjuraganSosmed."
          }, 400);
        }

        const providerApiKey =
          String(
            env.DJURAGANSOSMED_API_KEY ||
            ""
          ).trim();

        if (!providerApiKey) {
          return json({
            success: false,
            error:
              "Provider API key belum dikonfigurasi."
          }, 500);
        }

        const body =
          new URLSearchParams();

        body.set(
          "key",
          providerApiKey
        );

        body.set(
          "action",
          "status"
        );

        body.set(
          "order",
          String(order.providerOrderId)
        );

        let response;

        try {
          response =
            await fetch(
              "https://djuragansosmed.com/api/v2",
              {
                method: "POST",
                headers: {
                  "Content-Type":
                    "application/x-www-form-urlencoded"
                },
                body:
                  body.toString()
              }
            );
        } catch (providerError) {
          console.error(
            "[SMM PROVIDER STATUS NETWORK]",
            providerError?.message ||
            String(providerError)
          );

          return json({
            success: false,
            error:
              "Status provider sementara tidak dapat diperiksa."
          }, 502);
        }

        const raw =
          await response.text();

        let data = {};

        try {
          data =
            JSON.parse(raw);
        } catch {
          return json({
            success: false,
            error:
              "Response status provider tidak valid."
          }, 502);
        }

        if (!response.ok) {
          return json({
            success: false,
            error:
              String(
                data?.error ||
                data?.message ||
                `Provider HTTP ${response.status}.`
              ).slice(0, 1000)
          }, response.status >= 500 ? 502 : 400);
        }

        if (
          data?.error &&
          !data?.status
        ) {
          return json({
            success: false,
            error:
              String(data.error).slice(0, 1000)
          }, 400);
        }

        const providerStatus =
          String(data?.status || "")
            .trim();

        if (!providerStatus) {
          return json({
            success: false,
            error:
              "Provider tidak memberikan status order."
          }, 502);
        }

        const normalized =
          providerStatus
            .toLowerCase()
            .replace(/[_-]+/g, " ")
            .replace(/\s+/g, " ")
            .trim();

        let localStatus =
          "PROCESSING";

        if (
          normalized === "completed" ||
          normalized === "complete"
        ) {
          localStatus = "SUCCESS";
        } else if (
          normalized === "partial"
        ) {
          localStatus = "PARTIAL";
        } else if (
          normalized === "canceled" ||
          normalized === "cancelled"
        ) {
          localStatus = "CANCELED";
        } else if (
          normalized === "pending" ||
          normalized === "processing" ||
          normalized === "in progress" ||
          normalized === "inprogress"
        ) {
          localStatus = "PROCESSING";
        }

        const startCountRaw =
          data?.start_count;

        const remainsRaw =
          data?.remains;

        const startCount =
          startCountRaw === null ||
          startCountRaw === undefined ||
          startCountRaw === ""
            ? null
            : Number(startCountRaw);

        const remains =
          remainsRaw === null ||
          remainsRaw === undefined ||
          remainsRaw === ""
            ? null
            : Number(remainsRaw);

        const safeStartCount =
          Number.isFinite(startCount)
            ? Math.trunc(startCount)
            : null;

        const safeRemains =
          Number.isFinite(remains)
            ? Math.trunc(remains)
            : null;

        const now =
          new Date().toISOString();

        const update =
          await env.ppobku_db.prepare(`
            UPDATE smm_orders
            SET
              status = ?,
              start_count = ?,
              remains = ?,
              provider_message = ?,
              updated_at = ?
            WHERE order_id = ?
              AND legacy = 0
              AND payment_status = 'PAID'
              AND submission_status = 'SUBMITTED'
              AND provider_order_id = ?
          `)
            .bind(
              localStatus,
              safeStartCount,
              safeRemains,
              `Provider status: ${providerStatus}`
                .slice(0, 1000),
              now,
              orderId,
              String(order.providerOrderId)
            )
            .run();

        if (
          Number(update?.meta?.changes || 0) !== 1
        ) {
          return json({
            success: false,
            error:
              "Status lokal order berubah bersamaan."
          }, 409);
        }

        return json({
          success: true,
          orderId,
          providerOrderId:
            String(order.providerOrderId),
          providerStatus,
          status:
            localStatus,
          startCount:
            safeStartCount,
          remains:
            safeRemains,
          updatedAt:
            now
        });

      } catch (error) {
        console.error(
          "[SMM PROVIDER STATUS]",
          error?.message ||
          String(error)
        );

        return json({
          success: false,
          error:
            "Gagal memeriksa status order SMM."
        }, 500);
      }
    }


    // ========================================
    // ADMIN SMM SERVICES
    // ========================================
    if (
      request.method === "GET" &&
      url.pathname === "/api/admin/smm/services"
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
            error: "Admin belum login."
          }, 401);
        }

        let token;

        try {
          token = decodeURIComponent(match[1]);
        } catch {
          token = match[1];
        }

        const tokenHash =
          hashSessionToken(token);

        const session =
          await env.ppobku_db.prepare(`
            SELECT
              s.id AS session_id,
              s.expires_at,
              a.id,
              a.active
            FROM admin_sessions s
            INNER JOIN admins a
              ON a.id = s.admin_id
            WHERE s.token_hash = ?
            LIMIT 1
          `)
          .bind(tokenHash)
          .first();

        if (!session) {
          return json({
            success: false,
            error: "Session admin tidak valid."
          }, 401);
        }

        if (
          !session.active ||
          new Date(session.expires_at).getTime()
            <= Date.now()
        ) {
          await env.ppobku_db.prepare(`
            DELETE FROM admin_sessions
            WHERE id = ?
          `)
          .bind(session.session_id)
          .run();

          return json({
            success: false,
            error: "Session admin sudah expired."
          }, 401);
        }

        const pageRaw =
          Number(url.searchParams.get("page") || 1);

        const limitRaw =
          Number(url.searchParams.get("limit") || 50);

        const page =
          Number.isInteger(pageRaw) && pageRaw > 0
            ? pageRaw
            : 1;

        const limit =
          Number.isInteger(limitRaw)
            ? Math.min(
                100,
                Math.max(1, limitRaw)
              )
            : 50;

        const offset =
          (page - 1) * limit;

        const search =
          String(
            url.searchParams.get("search") || ""
          )
          .trim()
          .toLowerCase();

        const provider =
          String(
            url.searchParams.get("provider") || ""
          )
          .trim()
          .toLowerCase();

        const platform =
          String(
            url.searchParams.get("platform") || ""
          )
          .trim()
          .toLowerCase();

        const status =
          String(
            url.searchParams.get("status") || ""
          )
          .trim()
          .toLowerCase();

        const where = [];
        const params = [];

        if (search) {
          where.push(`
            (
              LOWER(s.name) LIKE ?
              OR LOWER(s.category) LIKE ?
              OR LOWER(s.platform) LIKE ?
              OR LOWER(
                COALESCE(
                  s.provider_service_id,
                  ''
                )
              ) LIKE ?
            )
          `);

          const like =
            "%" + search + "%";

          params.push(
            like,
            like,
            like,
            like
          );
        }

        if (provider) {
          where.push(
            "LOWER(p.name) = ?"
          );
          params.push(provider);
        }

        if (platform) {
          where.push(
            "LOWER(s.platform) = ?"
          );
          params.push(platform);
        }

        if (
          status === "active" ||
          status === "1"
        ) {
          where.push("s.active = 1");
        } else if (
          status === "inactive" ||
          status === "0"
        ) {
          where.push("s.active = 0");
        }

        const whereSql =
          where.length
            ? " WHERE " + where.join(" AND ")
            : "";

        const countRow =
          await env.ppobku_db.prepare(`
            SELECT COUNT(*) AS total
            FROM smm_services s
            LEFT JOIN smm_providers p
              ON p.id = s.provider_id
            ${whereSql}
          `)
          .bind(...params)
          .first();

        const total =
          Number(countRow?.total || 0);

        const result =
          await env.ppobku_db.prepare(`
            SELECT
              s.id,
              s.provider_id AS providerId,
              p.name AS providerName,
              p.active AS providerActive,
              s.provider_service_id
                AS providerServiceId,
              s.platform,
              s.category,
              s.name,
              s.description,
              s.icon,
              s.price,
              s.min_quantity AS minQuantity,
              s.max_quantity AS maxQuantity,
              s.refill,
              s.cancel,
              s.active,
              s.provider_type AS providerType,
              s.provider_rate AS providerRate,
              s.dripfeed,
              s.provider_category
                AS providerCategory,
              s.created_at AS createdAt,
              s.updated_at AS updatedAt
            FROM smm_services s
            LEFT JOIN smm_providers p
              ON p.id = s.provider_id
            ${whereSql}
            ORDER BY
              s.platform ASC,
              s.category ASC,
              s.name ASC,
              s.id ASC
            LIMIT ? OFFSET ?
          `)
          .bind(
            ...params,
            limit,
            offset
          )
          .all();

        return json({
          success: true,
          services: result.results || [],
          pagination: {
            page,
            limit,
            total,
            totalPages:
              Math.max(
                1,
                Math.ceil(total / limit)
              )
          }
        });

      } catch (error) {
        console.error(
          "[ADMIN SMM SERVICES GET]",
          error
        );

        return json({
          success: false,
          error:
            "Gagal mengambil layanan SMM."
        }, 500);
      }
    }

    const adminSmmServiceMatch =
      url.pathname.match(
        /^\/api\/admin\/smm\/services\/(\d+)$/
      );

    if (
      request.method === "PUT" &&
      adminSmmServiceMatch
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
            error: "Admin belum login."
          }, 401);
        }

        let token;

        try {
          token = decodeURIComponent(match[1]);
        } catch {
          token = match[1];
        }

        const tokenHash =
          hashSessionToken(token);

        const session =
          await env.ppobku_db.prepare(`
            SELECT
              s.id AS session_id,
              s.expires_at,
              a.id,
              a.active
            FROM admin_sessions s
            INNER JOIN admins a
              ON a.id = s.admin_id
            WHERE s.token_hash = ?
            LIMIT 1
          `)
          .bind(tokenHash)
          .first();

        if (!session) {
          return json({
            success: false,
            error: "Session admin tidak valid."
          }, 401);
        }

        if (
          !session.active ||
          new Date(session.expires_at).getTime()
            <= Date.now()
        ) {
          await env.ppobku_db.prepare(`
            DELETE FROM admin_sessions
            WHERE id = ?
          `)
          .bind(session.session_id)
          .run();

          return json({
            success: false,
            error: "Session admin sudah expired."
          }, 401);
        }

        const serviceId =
          Number(adminSmmServiceMatch[1]);

        const body =
          await request.json();

        if (
          body === null ||
          typeof body !== "object" ||
          !Object.prototype.hasOwnProperty.call(
            body,
            "active"
          )
        ) {
          return json({
            success: false,
            error:
              "Untuk saat ini hanya perubahan status active yang diizinkan."
          }, 400);
        }

        const active =
          Number(body.active);

        if (
          active !== 0 &&
          active !== 1
        ) {
          return json({
            success: false,
            error:
              "Status active harus 0 atau 1."
          }, 400);
        }

        const service =
          await env.ppobku_db.prepare(`
            SELECT
              s.id,
              s.active,
              s.provider_rate AS providerRate,
              s.provider_type AS providerType,
              p.id AS providerId,
              p.name AS providerName,
              p.active AS providerActive
            FROM smm_services s
            LEFT JOIN smm_providers p
              ON p.id = s.provider_id
            WHERE s.id = ?
            LIMIT 1
          `)
          .bind(serviceId)
          .first();

        if (!service) {
          return json({
            success: false,
            error:
              "Layanan SMM tidak ditemukan."
          }, 404);
        }

        const isDjuragan =
          String(
            service.providerName || ""
          ).toLowerCase() ===
            "djuragansosmed";

        if (
          active === 1 &&
          isDjuragan &&
          (
            service.providerRate === null ||
            !Number.isFinite(
              Number(service.providerRate)
            ) ||
            Number(service.providerRate) <= 0
          )
        ) {
          return json({
            success: false,
            error:
              "Layanan Djuragan dengan rate provider Rp0/tidak valid tidak dapat diaktifkan."
          }, 400);
        }

        if (
          active === 1 &&
          isDjuragan &&
          String(
            service.providerType || ""
          ).trim().toLowerCase() !==
            "default"
        ) {
          return json({
            success: false,
            error:
              "Untuk tahap ini hanya layanan Djuragan bertipe Default yang dapat diaktifkan."
          }, 400);
        }

        await env.ppobku_db.prepare(`
          UPDATE smm_services
          SET
            active = ?,
            updated_at = ?
          WHERE id = ?
        `)
        .bind(
          active,
          new Date().toISOString(),
          serviceId
        )
        .run();

        return json({
          success: true,
          id: serviceId,
          active,
          safety: {
            providerOrder: false,
            providerActiveChanged: false,
            priceChanged: false
          }
        });

      } catch (error) {
        console.error(
          "[ADMIN SMM SERVICE PUT]",
          error
        );

        return json({
          success: false,
          error:
            "Gagal mengubah status layanan SMM."
        }, 500);
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
    // BLOCK DIRECT DIGITAL PRODUCT FILE ACCESS
    // ========================================

    /*
     * File digital berbayar tidak boleh disajikan langsung
     * melalui path /uploads/digital/files/*.
     *
     * Database tetap boleh menyimpan path tersebut sebagai
     * referensi internal R2. Download pelanggan harus melalui
     * /api/digital-products/download/* atau
     * /api/digital-products/download-guide/* yang
     * memverifikasi digital download token.
     */
    if (
      request.method === "GET" &&
      url.pathname.startsWith(
        "/uploads/digital/files/"
      )
    ) {
      return json({
        success: false,
        error: "Akses file digital harus melalui link download resmi."
      }, 403);
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

        const referenceBytes =
          crypto.getRandomValues(
            new Uint8Array(4)
          );

        const reference =
          Array.from(referenceBytes)
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

        const guestAccessToken =
          randomBytes(32).toString("hex");

        const guestAccessTokenHash =
          hashDigitalGuestAccessTokenWorker(
            guestAccessToken
          );

        const guestAccessExpiresAt =
          new Date(
            Date.now() +
              1000 * 60 * 60 * 24 * 30
          ).toISOString();

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

        statements.push(
          env.ppobku_db
            .prepare(`
              INSERT INTO digital_guest_access (
                transaction_id,
                token_hash,
                created_at,
                expires_at
              )
              VALUES (?, ?, ?, ?)
            `)
            .bind(
              transactionId,
              guestAccessTokenHash,
              createdAt,
              guestAccessExpiresAt
            )
        );

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
            guestAccessToken,
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
      customerWhatsapp,
      guestAccessToken
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

    const guestAccess =
      await env.ppobku_db.prepare(`
        SELECT token_hash AS tokenHash
        FROM digital_guest_access
        WHERE transaction_id = ?
        LIMIT 1
      `).bind(transactionId).first();

    if (
      guestAccess &&
      !(await verifyDigitalGuestAccessTokenWorker(
        env,
        transactionId,
        guestAccessToken
      ))
    ) {
      return json({
        success: false,
        error: "Akses transaksi digital tidak valid."
      }, 401);
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
            ) +
            (guestAccessToken
              ? "&guestToken=" +
                encodeURIComponent(guestAccessToken)
              : ""),

          cancel_return_url:
            baseUrl +
            "/?payment=cancel&transactionId=" +
            encodeURIComponent(
              transactionId
            ) +
            (guestAccessToken
              ? "&guestToken=" +
                encodeURIComponent(guestAccessToken)
              : ""),

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

/* ==========================================================
   DIGITAL GUEST ACCESS TOKEN
========================================================== */

function hashDigitalGuestAccessTokenWorker(token) {
  return createHash("sha256")
    .update(String(token))
    .digest("hex");
}

async function verifyDigitalGuestAccessTokenWorker(
  env,
  transactionId,
  token
) {
  if (!transactionId || !token) return false;

  const row =
    await env.ppobku_db.prepare(`
      SELECT
        token_hash AS tokenHash,
        expires_at AS expiresAt
      FROM digital_guest_access
      WHERE transaction_id = ?
      LIMIT 1
    `).bind(transactionId).first();

  if (!row || !row.tokenHash) return false;

  if (
    row.expiresAt &&
    Date.now() >= new Date(row.expiresAt).getTime()
  ) {
    return false;
  }

  const suppliedHash =
    hashDigitalGuestAccessTokenWorker(token);

  return suppliedHash === String(row.tokenHash);
}


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

    const guestAuthorization =
      request.headers.get("Authorization") || "";

    const guestAccessToken =
      guestAuthorization
        .replace(/^Bearer\s+/i, "")
        .trim();

    const guestAccess =
      await env.ppobku_db.prepare(`
        SELECT token_hash AS tokenHash
        FROM digital_guest_access
        WHERE transaction_id = ?
        LIMIT 1
      `).bind(transactionId).first();

    if (
      guestAccess &&
      !(await verifyDigitalGuestAccessTokenWorker(
        env,
        transactionId,
        guestAccessToken
      ))
    ) {
      return json({
        success: false,
        error: "Akses transaksi digital tidak valid."
      }, 401);
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
    if (transaction.productType === "digital") {
      const guestAccess =
        await env.ppobku_db.prepare(`
          SELECT token_hash AS tokenHash
          FROM digital_guest_access
          WHERE transaction_id = ?
          LIMIT 1
        `).bind(transactionId).first();

      /*
       * Transaksi DIGITAL baru mempunyai guest-access row
       * dan wajib membuktikan guest token.
       *
       * Transaksi lama tanpa row tetap kompatibel.
       */
      if (guestAccess) {
        const authorization =
          request.headers.get("Authorization") || "";

        const guestAccessToken =
          authorization
            .replace(/^Bearer\s+/i, "")
            .trim();

        const validGuestAccess =
          await verifyDigitalGuestAccessTokenWorker(
            env,
            transactionId,
            guestAccessToken
          );

        if (!validGuestAccess) {
          return json({
            success: false,
            error: "Akses transaksi digital tidak valid."
          }, 401);
        }
      }
    }

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
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(
      (async () => {
        try {
          const result =
            await syncDjuraganSosmedCatalogWorker(env);

          console.log(
            "[SMM AUTO SYNC]",
            JSON.stringify(result)
          );
        } catch (error) {
          console.error(
            "[SMM AUTO SYNC ERROR]",
            error?.message || String(error)
          );
        }
      })()
    );
  }
};