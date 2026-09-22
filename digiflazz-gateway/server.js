const http = require("http");
const https = require("https");
const crypto = require("crypto");

require("../node_modules/dotenv").config({ path: "../.env" });

const PORT = Number(process.env.PORT || 10000);

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(data));
}

function getPublicIp() {
  return new Promise((resolve, reject) => {
    const req = https.get(
      "https://api.ipify.org?format=json",
      {
        headers: {
          "User-Agent": "BAYORA-Digiflazz-Gateway/1.0"
        },
        timeout: 10000
      },
      response => {
        let body = "";

        response.on("data", chunk => body += chunk);

        response.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            reject(new Error("Respons IP tidak valid."));
          }
        });
      }
    );

    req.on("timeout", () => {
      req.destroy(new Error("Timeout."));
    });

    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(
    req.url,
    "http://" + (req.headers.host || "localhost")
  );

  if (req.method === "GET" && url.pathname === "/health") {
    return sendJson(res, 200, {
      success: true,
      service: "BAYORA Digiflazz Gateway"
    });
  }

  if (req.method === "POST" && url.pathname === "/digiflazz/transaction") {
    const expectedToken = process.env.DIGIFLAZZ_GATEWAY_TOKEN;
    const authorization = req.headers.authorization || "";

    if (
      !expectedToken ||
      authorization !== "Bearer " + expectedToken
    ) {
      return sendJson(res, 401, {
        success: false,
        error: "Unauthorized"
      });
    }

    const contentType = req.headers["content-type"] || "";

    if (!contentType.toLowerCase().includes("application/json")) {
      return sendJson(res, 415, {
        success: false,
        error: "Content-Type harus application/json"
      });
    }

    let body = "";
    let tooLarge = false;

    req.on("data", chunk => {
      body += chunk;

      if (body.length > 8192) {
        tooLarge = true;
        req.destroy();
      }
    });

    req.on("end", async () => {
      if (tooLarge) return;

      let input;

      try {
        input = JSON.parse(body || "{}");
      } catch {
        return sendJson(res, 400, {
          success: false,
          error: "JSON tidak valid"
        });
      }

      const buyerSkuCode =
        typeof input.buyer_sku_code === "string"
          ? input.buyer_sku_code.trim()
          : "";

      const customerNo =
        typeof input.customer_no === "string"
          ? input.customer_no.trim()
          : "";

      const refId =
        typeof input.ref_id === "string"
          ? input.ref_id.trim()
          : "";

      if (!buyerSkuCode || !customerNo || !refId) {
        return sendJson(res, 400, {
          success: false,
          error: "buyer_sku_code, customer_no, dan ref_id wajib diisi"
        });
      }

      if (
        buyerSkuCode.length > 100 ||
        customerNo.length > 100 ||
        refId.length > 100
      ) {
        return sendJson(res, 400, {
          success: false,
          error: "Input terlalu panjang"
        });
      }

      if (!/^[A-Za-z0-9._:-]+$/.test(buyerSkuCode)) {
        return sendJson(res, 400, {
          success: false,
          error: "buyer_sku_code tidak valid"
        });
      }

      if (!/^[A-Za-z0-9._:+-]+$/.test(customerNo)) {
        return sendJson(res, 400, {
          success: false,
          error: "customer_no tidak valid"
        });
      }

      if (!/^[A-Za-z0-9._:-]+$/.test(refId)) {
        return sendJson(res, 400, {
          success: false,
          error: "ref_id tidak valid"
        });
      }

      const liveMode =
        process.env.DIGIFLAZZ_GATEWAY_LIVE === "true";

      if (!liveMode) {
        return sendJson(res, 200, {
          success: true,
          dry_run: true,
          message: "Payload valid. Transaksi TIDAK dikirim ke Digiflazz.",
          request: {
            buyer_sku_code: buyerSkuCode,
            customer_no: customerNo,
            ref_id: refId
          }
        });
      }

      const username = process.env.DIGIFLAZZ_USERNAME;
      const apiKey = process.env.DIGIFLAZZ_API_KEY;

      if (!username || !apiKey) {
        return sendJson(res, 500, {
          success: false,
          error: "Credential Digiflazz belum tersedia"
        });
      }

      const sign = crypto
        .createHash("md5")
        .update(username + apiKey + refId)
        .digest("hex");

      try {
        const response = await fetch(
          "https://api.digiflazz.com/v1/transaction",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              username,
              buyer_sku_code: buyerSkuCode,
              customer_no: customerNo,
              ref_id: refId,
              sign
            })
          }
        );

        const result = await response.json();

        const providerData =
          result && typeof result === "object"
            ? result.data
            : null;

        const rc =
          providerData && typeof providerData === "object"
            ? providerData.rc || null
            : null;

        const message =
          providerData && typeof providerData === "object"
            ? providerData.message || null
            : null;

        if (!response.ok) {
          console.error("[DIGIFLAZZ TRANSACTION ERROR]", {
            httpStatus: response.status,
            ref_id: refId,
            rc,
            message
          });
        }

        return sendJson(res, response.ok ? 200 : 502, {
          success: response.ok,
          rc,
          message,
          data: providerData || null
        });
      } catch (error) {
        return sendJson(res, 502, {
          success: false,
          error: "Gagal menghubungi Digiflazz"
        });
      }
    });

    return;
  }

  if (req.method === "GET" && url.pathname === "/digiflazz/test") {
    const expectedToken = process.env.DIGIFLAZZ_GATEWAY_TOKEN;
    const authorization = req.headers.authorization || "";

    if (
      !expectedToken ||
      authorization !== "Bearer " + expectedToken
    ) {
      return sendJson(res, 401, {
        success: false,
        error: "Unauthorized"
      });
    }

    try {
      const username = process.env.DIGIFLAZZ_USERNAME;
      const apiKey = process.env.DIGIFLAZZ_API_KEY;

      if (!username || !apiKey) {
        return sendJson(res, 500, {
          success: false,
          error: "Credential Digiflazz belum tersedia"
        });
      }

      const sign = crypto
        .createHash("md5")
        .update(username + apiKey + "pricelist")
        .digest("hex");

      const response = await fetch("https://api.digiflazz.com/v1/price-list", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          cmd: "prepaid",
          username,
          sign
        })
      });

      const result = await response.json();

      if (response.ok && Array.isArray(result.data)) {
        return sendJson(res, 200, {
          success: true,
          digiflazz: "connected",
          products: result.data.length
        });
      }

      return sendJson(res, 502, {
        success: false,
        rc: result?.data?.rc || null,
        message: result?.data?.message || "Digiflazz menolak request"
      });
    } catch (error) {
      return sendJson(res, 502, {
        success: false,
        error: error.message
      });
    }
  }

  return sendJson(res, 404, {
    success: false,
    error: "Not Found"
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("BAYORA Digiflazz Gateway listening on " + PORT);
});
