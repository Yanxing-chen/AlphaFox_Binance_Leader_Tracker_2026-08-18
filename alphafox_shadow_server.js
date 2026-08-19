const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const rootDir = __dirname;
const envPath = path.join(rootDir, ".env");

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

loadDotEnv(envPath);

const config = {
  apiKey: process.env.BINANCE_API_KEY || "",
  secret: process.env.BINANCE_API_SECRET || "",
  baseUrl: (process.env.BINANCE_FAPI_BASE_URL || "https://fapi.binance.com").replace(/\/$/, ""),
  recvWindow: process.env.BINANCE_RECV_WINDOW || "5000",
  port: Number(process.env.PORT || 8787)
};

let timeOffset = 0;
let lastTimeSync = 0;

function json(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(payload, null, 2));
}

function text(res, status, payload, contentType) {
  res.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store"
  });
  res.end(payload);
}

function sanitizeError(payload) {
  if (!payload) return payload;
  if (typeof payload === "string") return payload.replace(/[a-f0-9]{64}/gi, "[signature]");
  if (typeof payload !== "object") return payload;
  const clone = { ...payload };
  delete clone.signature;
  delete clone.apiKey;
  return clone;
}

async function syncTime() {
  const now = Date.now();
  if (now - lastTimeSync < 60_000) return;
  const response = await fetch(`${config.baseUrl}/fapi/v1/time`);
  if (!response.ok) return;
  const data = await response.json();
  if (Number.isFinite(Number(data.serverTime))) {
    timeOffset = Number(data.serverTime) - now;
    lastTimeSync = now;
  }
}

async function binancePublic(pathname, params = {}) {
  const url = new URL(`${config.baseUrl}${pathname}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  const response = await fetch(url);
  const body = await response.text();
  let parsed = body;
  try {
    parsed = JSON.parse(body);
  } catch {
    // Keep raw text for upstream diagnostics.
  }
  if (!response.ok) {
    const error = new Error(`Binance HTTP ${response.status}`);
    error.status = response.status;
    error.payload = parsed;
    throw error;
  }
  return parsed;
}

async function binanceSigned(pathname, params = {}) {
  if (!config.apiKey || !config.secret) {
    const error = new Error("BINANCE_API_KEY 或 BINANCE_API_SECRET 未配置");
    error.status = 401;
    throw error;
  }

  await syncTime();
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") query.set(key, String(value));
  }
  query.set("recvWindow", config.recvWindow);
  query.set("timestamp", String(Date.now() + timeOffset));

  const signature = crypto
    .createHmac("sha256", config.secret)
    .update(query.toString())
    .digest("hex");
  query.set("signature", signature);

  const response = await fetch(`${config.baseUrl}${pathname}?${query.toString()}`, {
    headers: {
      "X-MBX-APIKEY": config.apiKey
    }
  });
  const body = await response.text();
  let parsed = body;
  try {
    parsed = JSON.parse(body);
  } catch {
    // Keep raw text for upstream diagnostics.
  }
  if (!response.ok) {
    const error = new Error(`Binance HTTP ${response.status}`);
    error.status = response.status;
    error.payload = sanitizeError(parsed);
    throw error;
  }
  return parsed;
}

function serveStatic(req, res) {
  const url = new URL(req.url, "http://localhost");
  const pathname = url.pathname === "/" ? "/alphafox_shadow_console.html" : url.pathname;
  const safePath = path.normalize(path.join(rootDir, pathname));
  if (!safePath.startsWith(rootDir)) {
    text(res, 403, "Forbidden", "text/plain; charset=utf-8");
    return;
  }
  if (!fs.existsSync(safePath) || !fs.statSync(safePath).isFile()) {
    text(res, 404, "Not found", "text/plain; charset=utf-8");
    return;
  }

  const ext = path.extname(safePath).toLowerCase();
  const type = ext === ".html"
    ? "text/html; charset=utf-8"
    : ext === ".js"
      ? "application/javascript; charset=utf-8"
      : "application/octet-stream";
  text(res, 200, fs.readFileSync(safePath), type);
}

async function handleApi(req, res) {
  const url = new URL(req.url, "http://localhost");
  try {
    if (url.pathname === "/api/health") {
      json(res, 200, {
        ok: true,
        baseUrl: config.baseUrl,
        hasKey: Boolean(config.apiKey),
        hasSecret: Boolean(config.secret)
      });
      return;
    }

    if (url.pathname === "/api/binance/mark") {
      const symbol = String(url.searchParams.get("symbol") || "").toUpperCase();
      if (!symbol) {
        json(res, 400, { error: "symbol 必填，例如 SNDKUSDT" });
        return;
      }
      const data = await binancePublic("/fapi/v1/premiumIndex", { symbol });
      json(res, 200, data);
      return;
    }

    if (url.pathname === "/api/binance/account") {
      const data = await binanceSigned("/fapi/v3/account");
      data._meta = {
        baseUrl: config.baseUrl,
        hasKey: true,
        readOnlyProxy: true
      };
      json(res, 200, data);
      return;
    }

    if (url.pathname === "/api/binance/position-risk") {
      const symbol = String(url.searchParams.get("symbol") || "").toUpperCase();
      const data = await binanceSigned("/fapi/v3/positionRisk", { symbol });
      json(res, 200, data);
      return;
    }

    if (url.pathname === "/api/binance/user-trades") {
      const symbol = String(url.searchParams.get("symbol") || "").toUpperCase();
      if (!symbol) {
        json(res, 400, { error: "symbol 必填，例如 SNDKUSDT" });
        return;
      }
      const limit = Math.min(Number(url.searchParams.get("limit") || 100), 1000);
      const data = await binanceSigned("/fapi/v1/userTrades", { symbol, limit });
      json(res, 200, data);
      return;
    }

    if (url.pathname === "/api/binance/income") {
      const symbol = String(url.searchParams.get("symbol") || "").toUpperCase();
      const incomeType = String(url.searchParams.get("incomeType") || "REALIZED_PNL").toUpperCase();
      const limit = Math.min(Number(url.searchParams.get("limit") || 100), 1000);
      const data = await binanceSigned("/fapi/v1/income", { symbol, incomeType, limit });
      json(res, 200, data);
      return;
    }

    json(res, 404, { error: "Unknown API route" });
  } catch (error) {
    json(res, error.status || 500, {
      error: error.message,
      details: sanitizeError(error.payload)
    });
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method !== "GET") {
    json(res, 405, { error: "Only GET is enabled; this proxy is read-only." });
    return;
  }
  if (req.url.startsWith("/api/")) {
    await handleApi(req, res);
    return;
  }
  serveStatic(req, res);
});

server.listen(config.port, "127.0.0.1", () => {
  console.log(`AlphaFox shadow console: http://127.0.0.1:${config.port}/`);
  console.log(`Binance base URL: ${config.baseUrl}`);
  console.log(`API key loaded: ${config.apiKey ? "yes" : "no"}`);
});
