const http = require("http");
const https = require("https");

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

  if (req.method === "GET" && url.pathname === "/outbound-ip") {
    try {
      const result = await getPublicIp();

      return sendJson(res, 200, {
        success: true,
        ip: result.ip || null
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

server.listen(PORT, "0.0.0.0", () => {
  console.log("BAYORA Digiflazz Gateway listening on " + PORT);
});
