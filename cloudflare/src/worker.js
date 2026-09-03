const TRADERS = [
  { portfolioId: "5075281354358777856", label: "熬鹰资本" },
  { portfolioId: "5108371059752839168", label: "鎏渊" },
  { portfolioId: "5175036213074191105", label: "如何设置低于10万U不能跟我的单" },
  { portfolioId: "4788776444236355328", label: "星辰社区-意钦" }
];

const CONFIG = {
  defaultPortfolioId: "5075281354358777856",
  binanceWebBaseUrl: "https://www.binance.com",
  binanceFapiBaseUrl: "https://www.binance.com",
  githubOwner: "Yanxing-chen",
  githubRepo: "AlphaFox_Binance_Leader_Tracker_2026-08-18",
  githubWorkflow: "poll-binance-leaders.yml",
  githubRef: "main",
  githubOidcIssuer: "https://token.actions.githubusercontent.com",
  githubOidcAudience: "leader-tracker-ingest",
  pageSize: 100,
  backfillPages: 6,
  maxSnapshotsPerTrader: 300
};

let schemaReady = false;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, env, ctx);
    }
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("Cloudflare Assets binding is not configured.", { status: 500 });
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(dispatchGitHubWorkflow(env, {
      source: "cloudflare-cron",
      cron: controller?.cron || null,
      scheduledTime: controller?.scheduledTime || Date.now()
    }));
  }
};

async function handleApi(request, env) {
  const url = new URL(request.url);
  await ensureSchema(env);

  try {
    if (url.pathname === "/api/health") {
      return json({
        ok: true,
        mode: "cloudflare-worker-d1",
        defaultPortfolioId: CONFIG.defaultPortfolioId,
        traders: await traderHealth(env),
        cron: env.POLL_CRON || "* * * * *",
        githubDispatch: {
          owner: env.GITHUB_OWNER || CONFIG.githubOwner,
          repo: env.GITHUB_REPO || CONFIG.githubRepo,
          workflow: env.GITHUB_WORKFLOW || CONFIG.githubWorkflow,
          ref: env.GITHUB_REF || CONFIG.githubRef,
          configured: Boolean(env.GITHUB_WORKFLOW_TOKEN)
        }
      });
    }

    if (url.pathname === "/api/dispatch-github") {
      if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
      const expected = env.INGEST_SECRET ? `Bearer ${env.INGEST_SECRET}` : "";
      if (!expected || request.headers.get("authorization") !== expected) {
        return json({ ok: false, error: "Unauthorized" }, 401);
      }
      return json(await dispatchGitHubWorkflow(env, { source: "manual-api" }));
    }

    if (url.pathname === "/api/traders") {
      return json(TRADERS.map((trader) => ({
        portfolioId: trader.portfolioId,
        label: trader.label,
        fallback: false
      })));
    }

    if (url.pathname === "/api/snapshot") {
      const trader = getTrader(url.searchParams.get("portfolioId"));
      let snapshot = await readLatestSnapshot(env, trader.portfolioId);
      return json(snapshot || emptySnapshot(trader));
    }

    if (url.pathname === "/api/poll") {
      const trader = getTrader(url.searchParams.get("portfolioId"));
      const snapshot = await readLatestSnapshot(env, trader.portfolioId);
      return json(snapshot || {
        ...emptySnapshot(trader),
        note: "Cloudflare Worker cannot fetch Binance directly. Wait for GitHub Actions ingest or run the local ingest script."
      });
    }

    if (url.pathname === "/api/ingest") {
      if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
      const result = await handleIngest(request, env);
      return json(result, result.ok === false && result.error === "Unauthorized" ? 401 : 200);
    }

    return json({ error: "Not found" }, 404);
  } catch (error) {
    return json({
      error: error.message,
      payload: error.payload || null
    }, 500);
  }
}

async function dispatchGitHubWorkflow(env, meta = {}) {
  if (!env.GITHUB_WORKFLOW_TOKEN) {
    return {
      ok: false,
      skipped: true,
      reason: "GITHUB_WORKFLOW_TOKEN is not configured",
      ...meta
    };
  }

  const owner = env.GITHUB_OWNER || CONFIG.githubOwner;
  const repo = env.GITHUB_REPO || CONFIG.githubRepo;
  const workflow = env.GITHUB_WORKFLOW || CONFIG.githubWorkflow;
  const ref = env.GITHUB_REF || CONFIG.githubRef;
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${env.GITHUB_WORKFLOW_TOKEN}`,
      "content-type": "application/json",
      "user-agent": "binance-leader-tracker-cloudflare-cron",
      "x-github-api-version": "2022-11-28"
    },
    body: JSON.stringify({ ref })
  });

  if (response.status === 204) {
    return { ok: true, owner, repo, workflow, ref, ...meta };
  }

  const text = await response.text();
  throw new Error(`GitHub workflow dispatch failed: HTTP ${response.status} ${text}`);
}

async function handleIngest(request, env) {
  const auth = await authorizeIngest(request, env);
  if (!auth.ok) return { ok: false, error: "Unauthorized", reason: auth.reason || null };

  const body = await request.json();
  const snapshots = Array.isArray(body.snapshots)
    ? body.snapshots
    : [body.snapshot || body].filter(Boolean);
  const source = body.source || auth.source || "ingest";
  const results = [];
  for (const snapshot of snapshots) {
    results.push(await storeIngestedSnapshot(env, snapshot, source));
  }
  return {
    ok: results.every((item) => item.ok),
    source,
    auth: auth.source,
    results
  };
}

async function authorizeIngest(request, env) {
  const authorization = request.headers.get("authorization") || "";
  const staticExpected = env.INGEST_SECRET ? `Bearer ${env.INGEST_SECRET}` : "";
  if (staticExpected && authorization === staticExpected) {
    return { ok: true, source: "static-secret" };
  }

  const token = authorization.replace(/^Bearer\s+/i, "").trim();
  if (!token.includes(".")) {
    return { ok: false, reason: "No valid bearer token" };
  }

  return verifyGitHubOidcToken(token, env);
}

async function verifyGitHubOidcToken(token, env) {
  try {
    const [encodedHeader, encodedPayload, encodedSignature] = token.split(".");
    if (!encodedHeader || !encodedPayload || !encodedSignature) {
      return { ok: false, reason: "Malformed OIDC token" };
    }

    const header = JSON.parse(textFromBase64Url(encodedHeader));
    const payload = JSON.parse(textFromBase64Url(encodedPayload));
    if (header.alg !== "RS256" || !header.kid) {
      return { ok: false, reason: "Unsupported OIDC token header" };
    }

    const now = Math.floor(Date.now() / 1000);
    const issuer = env.GITHUB_OIDC_ISSUER || CONFIG.githubOidcIssuer;
    const audience = env.GITHUB_OIDC_AUDIENCE || CONFIG.githubOidcAudience;
    const owner = env.GITHUB_OWNER || CONFIG.githubOwner;
    const repo = env.GITHUB_REPO || CONFIG.githubRepo;
    const workflow = env.GITHUB_WORKFLOW || CONFIG.githubWorkflow;
    const ref = env.GITHUB_REF || CONFIG.githubRef;
    const repository = `${owner}/${repo}`;
    const workflowRef = `${repository}/.github/workflows/${workflow}@refs/heads/${ref}`;

    if (payload.iss !== issuer) return { ok: false, reason: "OIDC issuer mismatch" };
    if (payload.aud !== audience) return { ok: false, reason: "OIDC audience mismatch" };
    if (payload.repository !== repository) return { ok: false, reason: "OIDC repository mismatch" };
    if (payload.workflow_ref !== workflowRef) return { ok: false, reason: "OIDC workflow mismatch" };
    if (payload.exp && now > Number(payload.exp) + 60) return { ok: false, reason: "OIDC token expired" };
    if (payload.nbf && now + 60 < Number(payload.nbf)) return { ok: false, reason: "OIDC token not active" };

    const jwks = await fetchGitHubOidcJwks(issuer);
    const jwk = (jwks.keys || []).find((key) => key.kid === header.kid);
    if (!jwk) return { ok: false, reason: "OIDC signing key not found" };

    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    );
    const verified = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      bytesFromBase64Url(encodedSignature),
      new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`)
    );
    return verified ? { ok: true, source: "github-oidc" } : { ok: false, reason: "OIDC signature mismatch" };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

async function fetchGitHubOidcJwks(issuer) {
  const response = await fetch(`${issuer}/.well-known/jwks`, {
    headers: { accept: "application/json" }
  });
  if (!response.ok) throw new Error(`Unable to fetch GitHub OIDC keys: HTTP ${response.status}`);
  return response.json();
}

function textFromBase64Url(value) {
  const bytes = bytesFromBase64Url(value);
  return new TextDecoder().decode(bytes);
}

function bytesFromBase64Url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function storeIngestedSnapshot(env, snapshot, source) {
  const trader = findTrader(snapshot.portfolioId);
  if (!trader) {
    return {
      ok: true,
      skipped: true,
      reason: "Trader is not configured",
      portfolioId: String(snapshot.portfolioId || "")
    };
  }

  const normalized = {
    ...snapshot,
    portfolioId: trader.portfolioId,
    polledAt: snapshot.polledAt || new Date().toISOString(),
    detail: snapshot.detail || { nickname: trader.label },
    marginBalance: toNumber(snapshot.marginBalance ?? snapshot.detail?.marginBalance),
    aumAmount: toNumber(snapshot.aumAmount ?? snapshot.detail?.aumAmount),
    currentCopyCount: toNumber(snapshot.currentCopyCount ?? snapshot.detail?.currentCopyCount),
    maxCopyCount: toNumber(snapshot.maxCopyCount ?? snapshot.detail?.maxCopyCount),
    ordersStored: toNumber(snapshot.ordersStored),
    ordersAdded: toNumber(snapshot.ordersAdded),
    latestOrders: Array.isArray(snapshot.latestOrders) ? snapshot.latestOrders : [],
    closedPositionHistory: Array.isArray(snapshot.closedPositionHistory) ? snapshot.closedPositionHistory : [],
    assetPreference: Array.isArray(snapshot.assetPreference) ? snapshot.assetPreference : [],
    positions: Array.isArray(snapshot.positions) ? snapshot.positions : [],
    performance: snapshot.performance || {},
    balanceCurve: Array.isArray(snapshot.balanceCurve) ? snapshot.balanceCurve : []
  };
  const dataHash = await snapshotHash(normalized);
  const latestRow = await env.DB.prepare(
    "SELECT data_hash FROM snapshots WHERE portfolio_id = ? ORDER BY id DESC LIMIT 1"
  ).bind(trader.portfolioId).first();

  const changed = !latestRow || latestRow.data_hash !== dataHash;
  if (changed) {
    await env.DB.prepare(`
      INSERT INTO snapshots (
        portfolio_id, polled_at, margin_balance, aum_amount, current_copy_count,
        max_copy_count, orders_stored, orders_added, data_hash, snapshot_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      trader.portfolioId,
      normalized.polledAt,
      normalized.marginBalance,
      normalized.aumAmount,
      normalized.currentCopyCount,
      normalized.maxCopyCount,
      normalized.ordersStored,
      normalized.ordersAdded,
      dataHash,
      JSON.stringify(normalized)
    ).run();
    await pruneSnapshots(env, trader.portfolioId);
  }

  await upsertPollRun(env, trader.portfolioId, {
    ok: true,
    error: null,
    lastSnapshotAt: changed ? normalized.polledAt : null,
    meta: { source, changed }
  });

  return {
    ok: true,
    portfolioId: trader.portfolioId,
    label: trader.label,
    changed,
    polledAt: normalized.polledAt,
    positions: normalized.positions.length,
    latestOrders: normalized.latestOrders.length
  };
}

async function pollAll(env, meta = {}) {
  await ensureSchema(env);
  const results = [];
  for (const trader of TRADERS) {
    try {
      const snapshot = await pollOnce(env, trader, meta);
      results.push({
        portfolioId: trader.portfolioId,
        label: trader.label,
        ok: true,
        polledAt: snapshot.polledAt,
        ordersAdded: snapshot.ordersAdded,
        positions: snapshot.positions.length
      });
    } catch (error) {
      await upsertPollRun(env, trader.portfolioId, {
        ok: false,
        error: error.message
      });
      results.push({
        portfolioId: trader.portfolioId,
        label: trader.label,
        ok: false,
        error: error.message
      });
    }
  }
  return { ok: results.every((item) => item.ok), source: meta.source || "unknown", results };
}

async function pollOnce(env, trader, meta = {}) {
  await ensureSchema(env);
  const [detail, officialPositionHistory] = await Promise.all([
    fetchLeaderDetail(env, trader),
    fetchPositionHistory(env, trader).catch(() => [])
  ]);
  const existing = await readOrders(env, trader.portfolioId);
  const merged = await mergeFreshOrders(env, trader, existing);
  const insertedOrders = await insertOrders(env, trader.portfolioId, merged.additions);
  const orders = insertedOrders > 0 ? await readOrders(env, trader.portfolioId) : [...existing, ...merged.additions];
  const snapshot = await buildSnapshot(env, trader, detail, orders, merged.additions, officialPositionHistory);
  const dataHash = await snapshotHash(snapshot);
  const latestRow = await env.DB.prepare(
    "SELECT data_hash FROM snapshots WHERE portfolio_id = ? ORDER BY id DESC LIMIT 1"
  ).bind(trader.portfolioId).first();

  let snapshotWritten = false;
  if (!latestRow || latestRow.data_hash !== dataHash) {
    await env.DB.prepare(`
      INSERT INTO snapshots (
        portfolio_id, polled_at, margin_balance, aum_amount, current_copy_count,
        max_copy_count, orders_stored, orders_added, data_hash, snapshot_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      trader.portfolioId,
      snapshot.polledAt,
      snapshot.marginBalance,
      snapshot.aumAmount,
      snapshot.currentCopyCount,
      snapshot.maxCopyCount,
      snapshot.ordersStored,
      snapshot.ordersAdded,
      dataHash,
      JSON.stringify(snapshot)
    ).run();
    await pruneSnapshots(env, trader.portfolioId);
    snapshotWritten = true;
  }

  await upsertPollRun(env, trader.portfolioId, {
    ok: true,
    error: null,
    lastSnapshotAt: snapshotWritten ? snapshot.polledAt : null,
    meta: {
      source: meta.source || "unknown",
      ordersAdded: snapshot.ordersAdded,
      snapshotWritten
    }
  });

  return { ...snapshot, snapshotWritten };
}

async function pruneSnapshots(env, portfolioId) {
  const keep = Math.max(20, Number(env.MAX_SNAPSHOTS_PER_TRADER || CONFIG.maxSnapshotsPerTrader));
  await env.DB.prepare(`
    DELETE FROM snapshots
    WHERE portfolio_id = ?
      AND id NOT IN (
        SELECT id FROM snapshots
        WHERE portfolio_id = ?
        ORDER BY id DESC
        LIMIT ?
      )
  `).bind(portfolioId, portfolioId, keep).run();
}

function getTrader(portfolioId) {
  return findTrader(portfolioId) || TRADERS[0];
}

function findTrader(portfolioId) {
  return TRADERS.find((trader) => trader.portfolioId === String(portfolioId || ""));
}

async function traderHealth(env) {
  const rows = await env.DB.prepare("SELECT * FROM poll_runs ORDER BY portfolio_id").all();
  const byId = new Map((rows.results || []).map((row) => [row.portfolio_id, row]));
  return TRADERS.map((trader) => {
    const row = byId.get(trader.portfolioId);
    return {
      portfolioId: trader.portfolioId,
      label: trader.label,
      lastPollAt: row?.last_poll_at || null,
      polling: false,
      lastError: row?.last_error ? { message: row.last_error, at: row.updated_at } : null
    };
  });
}

function emptySnapshot(trader) {
  return {
    portfolioId: trader.portfolioId,
    polledAt: new Date().toISOString(),
    detail: { nickname: trader.label },
    positions: [],
    latestOrders: [],
    closedPositionHistory: [],
    assetPreference: [],
    balanceCurve: [],
    performance: {},
    marginBalance: 0,
    aumAmount: 0,
    ordersStored: 0,
    ordersAdded: 0
  };
}

async function fetchJson(url, options = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...options,
        headers: defaultHeaders(options.headers)
      });
      const parsed = await parseResponse(response);
      validateBinancePayload(response.status, response.ok, parsed);
      return parsed;
    } catch (error) {
      lastError = error;
      if (!isRetryableBinanceError(error) || attempt === 3) break;
      await sleep(650 * attempt);
    }
  }
  throw lastError;
}

function defaultHeaders(headers = {}) {
  return {
    accept: "application/json",
    "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
    "cache-control": "no-cache",
    "content-type": "application/json",
    clienttype: "web",
    csrftoken: "d41d8cd98f00b204e9800998ecf8427e",
    lang: "zh-CN",
    origin: "https://www.binance.com",
    pragma: "no-cache",
    referer: "https://www.binance.com/zh-CN/copy-trading/",
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    "x-passthrough-token": "",
    ...headers
  };
}

async function parseResponse(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function validateBinancePayload(status, ok, parsed) {
  if (!ok) {
    const error = new Error(`HTTP ${status}`);
    error.payload = parsed;
    throw error;
  }
  if (parsed && parsed.success === false) {
    const error = new Error(parsed.message || parsed.code || "Binance API returned success=false");
    error.payload = parsed;
    throw error;
  }
}

function isRetryableBinanceError(error) {
  const payload = error && error.payload;
  return payload && (payload.code === "11012005" || /busy|later|timeout/i.test(String(payload.message || error.message)));
}

async function fetchLeaderDetail(env, trader) {
  const base = env.BINANCE_WEB_BASE_URL || CONFIG.binanceWebBaseUrl;
  const url = `${base}/bapi/futures/v1/friendly/future/copy-trade/lead-portfolio/detail?portfolioId=${encodeURIComponent(trader.portfolioId)}`;
  const payload = await fetchJson(url);
  return payload.data || null;
}

async function fetchOrderHistoryPage(env, trader, pageNumber) {
  const base = env.BINANCE_WEB_BASE_URL || CONFIG.binanceWebBaseUrl;
  const payload = await fetchJson(`${base}/bapi/futures/v1/friendly/future/copy-trade/lead-portfolio/order-history`, {
    method: "POST",
    body: JSON.stringify({
      portfolioId: trader.portfolioId,
      pageNumber,
      pageSize: getInt(env.PAGE_SIZE, CONFIG.pageSize)
    })
  });
  return payload.data || { total: 0, list: [] };
}

async function fetchPositionHistory(env, trader) {
  const base = env.BINANCE_WEB_BASE_URL || CONFIG.binanceWebBaseUrl;
  const payload = await fetchJson(`${base}/bapi/futures/v1/friendly/future/copy-trade/lead-portfolio/position-history`, {
    method: "POST",
    body: JSON.stringify({
      portfolioId: trader.portfolioId,
      pageNumber: 1,
      pageSize: 100,
      sort: "OPENING"
    })
  });
  return payload?.data?.list || [];
}

async function fetchMarkPrice(env, symbol) {
  const encoded = encodeURIComponent(symbol);
  const bases = unique([
    env.BINANCE_FAPI_BASE_URL || CONFIG.binanceFapiBaseUrl,
    env.BINANCE_WEB_BASE_URL || CONFIG.binanceWebBaseUrl,
    "https://www.binance.com",
    "https://fapi.binance.com"
  ]);
  const errors = [];

  for (const base of bases) {
    try {
      const payload = await fetchJson(`${base}/fapi/v1/premiumIndex?symbol=${encoded}`);
      const markPrice = toNumber(payload.markPrice);
      if (markPrice > 0) return markPrice;
      errors.push(`${base}: empty markPrice`);
    } catch (error) {
      errors.push(`${base}: ${error.message}`);
    }
  }

  for (const base of bases) {
    try {
      const payload = await fetchJson(`${base}/fapi/v1/ticker/price?symbol=${encoded}`);
      const price = toNumber(payload.price);
      if (price > 0) return price;
      errors.push(`${base}: empty ticker price`);
    } catch (error) {
      errors.push(`${base}: ${error.message}`);
    }
  }

  throw new Error(`Unable to fetch mark price for ${symbol}: ${errors.join("; ")}`);
}

async function mergeFreshOrders(env, trader, existing) {
  const known = new Set(existing.map(orderKey));
  const shouldBackfill = existing.length === 0;
  const pages = shouldBackfill ? getInt(env.BACKFILL_PAGES, CONFIG.backfillPages) : 1;
  const additions = [];
  let total = null;

  for (let pageNumber = 1; pageNumber <= pages; pageNumber += 1) {
    const data = await fetchOrderHistoryPage(env, trader, pageNumber);
    const list = Array.isArray(data.list) ? data.list : [];
    total = data.total ?? total;
    if (!list.length) break;
    for (const rawOrder of list) {
      const order = normalizeOrder(rawOrder);
      const key = orderKey(order);
      if (!known.has(key)) {
        known.add(key);
        additions.push(order);
      }
    }
    if (!shouldBackfill) break;
    if (total && pageNumber * getInt(env.PAGE_SIZE, CONFIG.pageSize) >= total) break;
    await sleep(180);
  }

  return { orders: [...existing, ...additions], additions, total };
}

function normalizeOrder(order) {
  const symbol = String(order.symbol || "").toUpperCase();
  const baseAsset = order.baseAsset || symbol.replace(/USDT$/, "");
  return {
    symbol,
    baseAsset,
    quoteAsset: order.quoteAsset || "USDT",
    side: String(order.side || "").toUpperCase(),
    type: order.type || "",
    positionSide: String(order.positionSide || "").toUpperCase(),
    executedQty: toNumber(order.executedQty ?? order.qty),
    avgPrice: toNumber(order.avgPrice ?? order.price),
    totalPnl: toNumber(order.totalPnl ?? order.realizedProfit),
    orderUpdateTime: toNumber(order.orderUpdateTime || order.time),
    orderTime: toNumber(order.orderTime || order.time || order.orderUpdateTime),
    raw: order
  };
}

function orderKey(order) {
  return [
    order.orderUpdateTime || order.time || "",
    order.symbol || "",
    order.side || "",
    order.positionSide || "",
    order.avgPrice || order.price || "",
    order.executedQty || order.qty || ""
  ].join("|");
}

async function readOrders(env, portfolioId) {
  const rows = await env.DB.prepare(`
    SELECT * FROM orders
    WHERE portfolio_id = ?
    ORDER BY order_update_time ASC
    LIMIT 2000
  `).bind(portfolioId).all();
  return (rows.results || []).map((row) => ({
    symbol: row.symbol,
    baseAsset: row.base_asset,
    quoteAsset: row.quote_asset,
    side: row.side,
    type: row.type,
    positionSide: row.position_side,
    executedQty: toNumber(row.executed_qty),
    avgPrice: toNumber(row.avg_price),
    totalPnl: toNumber(row.total_pnl),
    orderUpdateTime: toNumber(row.order_update_time),
    orderTime: toNumber(row.order_time),
    raw: safeJson(row.raw_json)
  }));
}

async function insertOrders(env, portfolioId, orders) {
  if (!orders.length) return 0;
  const statements = orders.map((order) => env.DB.prepare(`
    INSERT OR IGNORE INTO orders (
      portfolio_id, order_key, symbol, base_asset, quote_asset, side, type,
      position_side, executed_qty, avg_price, total_pnl, order_update_time,
      order_time, raw_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    portfolioId,
    orderKey(order),
    order.symbol,
    order.baseAsset,
    order.quoteAsset,
    order.side,
    order.type,
    order.positionSide,
    order.executedQty,
    order.avgPrice,
    order.totalPnl,
    order.orderUpdateTime,
    order.orderTime,
    JSON.stringify(order.raw || order)
  ));
  let inserted = 0;
  for (let index = 0; index < statements.length; index += 50) {
    const results = await env.DB.batch(statements.slice(index, index + 50));
    inserted += results.reduce((sum, result) => sum + (result.meta?.changes || 0), 0);
  }
  return inserted;
}

async function buildSnapshot(env, trader, detail, orders, additions, officialPositionHistory = []) {
  const sorted = [...orders].sort((a, b) => orderTimestamp(a) - orderTimestamp(b));
  const rawPositions = buildRecentOpenPositionSeeds(sorted);
  const positions = [];

  for (const position of rawPositions) {
    let markPrice = position.avgPrice;
    try {
      markPrice = await fetchMarkPrice(env, position.symbol);
    } catch {
      markPrice = position.avgPrice;
    }
    const absQty = Math.abs(position.qty);
    const side = position.side || (position.qty > 0 ? "LONG" : "SHORT");
    const notional = absQty * markPrice;
    const unrealizedPnl = side === "LONG"
      ? (markPrice - position.avgPrice) * absQty
      : (position.avgPrice - markPrice) * absQty;
    positions.push({
      ...position,
      side,
      absQty,
      markPrice,
      notional,
      unrealizedPnl
    });
  }

  const marginBalance = toNumber(detail?.marginBalance);
  const totalNotional = positions.reduce((sum, position) => sum + position.notional, 0);
  const totalUnrealizedPnl = positions.reduce((sum, position) => sum + position.unrealizedPnl, 0);
  const effectiveLeverage = marginBalance > 0 ? totalNotional / marginBalance : 0;
  const closedPositionHistory = enrichClosedPositionHistory(buildClosedPositionHistory(sorted), officialPositionHistory);
  const performance = buildPerformance(detail, sorted, closedPositionHistory, marginBalance);
  const balanceCurve = [
    ...(await readBalanceCurve(env, trader.portfolioId)),
    {
      time: Date.now(),
      balance: marginBalance,
      aum: toNumber(detail?.aumAmount)
    }
  ].filter((point) => point.balance > 0);

  return {
    portfolioId: trader.portfolioId,
    polledAt: new Date().toISOString(),
    detail,
    marginBalance,
    aumAmount: toNumber(detail?.aumAmount),
    currentCopyCount: toNumber(detail?.currentCopyCount),
    maxCopyCount: toNumber(detail?.maxCopyCount),
    lastTradeTime: toNumber(detail?.lastTradeTime),
    latestPublicOrderTime: sorted.length ? orderTimestamp(sorted[sorted.length - 1]) : 0,
    ordersStored: sorted.length,
    ordersAdded: additions.length,
    latestOrders: [...sorted].sort((a, b) => orderTimestamp(b) - orderTimestamp(a)).slice(0, 30),
    closedPositionHistory: closedPositionHistory.slice(0, 80),
    assetPreference: buildAssetPreference(sorted),
    performance,
    balanceCurve: sampleCurve(balanceCurve),
    positions,
    totalNotional,
    totalUnrealizedPnl,
    effectiveLeverage
  };
}

async function readBalanceCurve(env, portfolioId) {
  const rows = await env.DB.prepare(`
    SELECT polled_at, margin_balance, aum_amount
    FROM snapshots
    WHERE portfolio_id = ?
    ORDER BY id DESC
    LIMIT 120
  `).bind(portfolioId).all();
  return (rows.results || []).reverse().map((row) => ({
    time: new Date(row.polled_at).getTime(),
    balance: toNumber(row.margin_balance),
    aum: toNumber(row.aum_amount)
  })).filter((point) => point.balance > 0);
}

async function readLatestSnapshot(env, portfolioId) {
  const row = await env.DB.prepare(`
    SELECT snapshot_json FROM snapshots
    WHERE portfolio_id = ?
    ORDER BY id DESC
    LIMIT 1
  `).bind(portfolioId).first();
  const snapshot = row ? safeJson(row.snapshot_json) : null;
  if (snapshot) {
    snapshot.balanceCurve = sampleCurve(await readBalanceCurve(env, portfolioId));
  }
  return snapshot;
}

async function upsertPollRun(env, portfolioId, data) {
  const now = new Date().toISOString();
  await env.DB.prepare(`
    INSERT INTO poll_runs (portfolio_id, last_poll_at, last_snapshot_at, last_error, updated_at, meta_json)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(portfolio_id) DO UPDATE SET
      last_poll_at = excluded.last_poll_at,
      last_snapshot_at = COALESCE(excluded.last_snapshot_at, poll_runs.last_snapshot_at),
      last_error = excluded.last_error,
      updated_at = excluded.updated_at,
      meta_json = excluded.meta_json
  `).bind(
    portfolioId,
    now,
    data.lastSnapshotAt || null,
    data.error || null,
    now,
    JSON.stringify(data.meta || {})
  ).run();
}

function signedDelta(order) {
  const qty = orderQty(order);
  const side = String(order.side || "").toUpperCase();
  const positionSide = String(order.positionSide || "").toUpperCase();
  if (positionSide === "LONG") return side === "BUY" ? qty : -qty;
  if (positionSide === "SHORT") return side === "SELL" ? -qty : qty;
  return side === "BUY" ? qty : -qty;
}

function applyOrder(position, order) {
  const delta = signedDelta(order);
  const price = orderPrice(order);
  const currentQty = position.qty;
  const nextQty = currentQty + delta;

  if (currentQty === 0 || Math.sign(currentQty) === Math.sign(delta)) {
    const currentAbs = Math.abs(currentQty);
    const deltaAbs = Math.abs(delta);
    const nextAbs = currentAbs + deltaAbs;
    position.avgPrice = nextAbs > 0
      ? ((position.avgPrice * currentAbs) + (price * deltaAbs)) / nextAbs
      : 0;
  } else if (Math.sign(nextQty) !== Math.sign(currentQty) && nextQty !== 0) {
    position.avgPrice = price;
  }

  position.qty = Math.abs(nextQty) < 1e-10 ? 0 : nextQty;
  if (position.qty === 0) position.avgPrice = 0;
  position.realizedPnl += toNumber(order.totalPnl ?? order.realizedProfit);
  position.orderCount += 1;
  position.lastOrderTime = Math.max(position.lastOrderTime || 0, orderTimestamp(order));
}

function buildRecentOpenPositionSeeds(sorted) {
  const positionsByKey = new Map();
  for (const order of sorted) {
    const symbol = String(order.symbol || "").toUpperCase();
    const positionSide = String(order.positionSide || "").toUpperCase();
    if (!symbol || !positionSide) continue;
    const key = `${symbol}|${positionSide}`;
    const qty = orderQty(order);
    const price = orderPrice(order);
    const timestamp = orderTimestamp(order);

    if (isOpenOrder(order)) {
      if (!positionsByKey.has(key)) {
        positionsByKey.set(key, {
          symbol,
          baseAsset: order.baseAsset || symbol.replace(/USDT$/, ""),
          side: positionSide,
          qty: 0,
          avgPrice: 0,
          realizedPnl: 0,
          orderCount: 0,
          lastOrderTime: 0
        });
      }
      const position = positionsByKey.get(key);
      const nextQty = position.qty + qty;
      position.avgPrice = nextQty > 0 ? ((position.avgPrice * position.qty) + (price * qty)) / nextQty : price;
      position.qty = nextQty;
      position.orderCount += 1;
      position.lastOrderTime = Math.max(position.lastOrderTime || 0, timestamp);
      continue;
    }

    const position = positionsByKey.get(key);
    if (!position) continue;
    position.qty = Math.max(0, position.qty - qty);
    position.realizedPnl += toNumber(order.totalPnl ?? order.realizedProfit);
    position.orderCount += 1;
    position.lastOrderTime = Math.max(position.lastOrderTime || 0, timestamp);
    if (position.qty <= 1e-8) {
      positionsByKey.delete(key);
    }
  }
  return Array.from(positionsByKey.values()).filter((position) => Math.abs(position.qty) > 1e-8);
}

function buildClosedPositionHistory(sorted) {
  const active = new Map();
  const history = [];
  let groupCounter = 0;

  for (const order of sorted) {
    const symbol = String(order.symbol || "").toUpperCase();
    const positionSide = String(order.positionSide || "").toUpperCase();
    if (!symbol || !positionSide) continue;
    const key = `${symbol}|${positionSide}`;
    if (!active.has(key)) active.set(key, newLeg(symbol, order.baseAsset, positionSide));
    const leg = active.get(key);
    const qty = orderQty(order);
    const price = orderPrice(order);
    const timestamp = orderTimestamp(order);
    leg.orderCount += 1;

    if (isOpenOrder(order)) {
      if (!leg.positionGroupId) ensureLegGroup(leg, symbol, positionSide, timestamp, ++groupCounter);
      const nextQty = leg.qty + qty;
      leg.avgPrice = nextQty > 0 ? ((leg.avgPrice * leg.qty) + (price * qty)) / nextQty : price;
      leg.qty = nextQty;
      leg.maxQty = Math.max(leg.maxQty, leg.qty);
      if (!leg.openTime) leg.openTime = timestamp;
      continue;
    }

    const beforeQty = leg.qty;
    const hasOpenBasis = beforeQty > 1e-8;
    const closedQty = hasOpenBasis ? Math.min(qty, beforeQty) : qty;
    const remainingQty = hasOpenBasis ? Math.max(0, beforeQty - qty) : 0;
    const realizedPnl = toNumber(order.totalPnl ?? order.realizedProfit);
    const status = !hasOpenBasis
      ? "平仓记录"
      : remainingQty > 1e-8
        ? "部分平仓"
        : "最终平仓";
    const positionGroupId = hasOpenBasis
      ? leg.positionGroupId
      : `${symbol}|${positionSide}|unknown|${timestamp}`;
    const closeSequence = hasOpenBasis ? leg.closeEvents + 1 : 1;

    history.push({
      symbol: leg.symbol,
      baseAsset: leg.baseAsset,
      side: leg.positionSide,
      positionGroupId,
      positionGroupLabel: hasOpenBasis ? `第 ${leg.groupIndex} 轮` : "无法归组",
      closeSequence,
      status,
      groupStatus: hasOpenBasis ? "仍有剩余" : "资料不足",
      realizedPnl,
      openPrice: leg.avgPrice || price,
      closeAvgPrice: price,
      closedQty,
      remainingQty,
      finalRemainingQty: remainingQty,
      totalClosedQty: closedQty,
      totalRealizedPnl: realizedPnl,
      groupCloseCount: closeSequence,
      maxQty: leg.maxQty || beforeQty || closedQty,
      openTime: leg.openTime || timestamp,
      closeTime: timestamp,
      orderCount: leg.orderCount,
      hasOpenBasis
    });

    leg.realizedPnl += realizedPnl;
    leg.closeQty += closedQty;
    leg.closeValue += closedQty * price;
    leg.qty = remainingQty;
    leg.closeTime = timestamp;
    leg.closeEvents = closeSequence;
    updateGroupRows(history, leg, remainingQty > 1e-8 ? "仍有剩余" : "已全部平仓");

    if (leg.qty <= 1e-8) {
      active.set(key, newLeg(symbol, order.baseAsset, positionSide));
    }
  }
  for (const leg of active.values()) {
    if (leg.positionGroupId && leg.closeEvents > 0 && leg.qty > 1e-8) {
      updateGroupRows(history, leg, "仍有剩余");
    }
  }
  return history.sort((a, b) => b.closeTime - a.closeTime);
}

function normalizeOfficialPosition(item) {
  const side = String(item.side || "").toUpperCase();
  return {
    positionId: String(item.positionId || item.id || ""),
    symbol: String(item.symbol || "").toUpperCase(),
    side: side === "LONG" ? "LONG" : side === "SHORT" ? "SHORT" : side,
    opened: toNumber(item.opened),
    closed: toNumber(item.closed),
    updateTime: toNumber(item.updateTime),
    avgCost: toNumber(item.avgCost),
    avgClosePrice: toNumber(item.avgClosePrice),
    closingPnl: toNumber(item.closingPnl),
    maxOpenInterest: toNumber(item.maxOpenInterest),
    closedVolume: toNumber(item.closedVolume),
    status: String(item.status || ""),
    leverage: toNumber(item.leverage),
    roi: toNumber(item.roi) * 100,
    marginMode: String(item.isolated || "")
  };
}

function enrichClosedPositionHistory(history, officialRows) {
  const official = (officialRows || []).map(normalizeOfficialPosition);
  if (!official.length) return history.map((item) => ({ ...item, dataSource: "order_history" }));
  return official
    .filter((position) => position.closedVolume > 0)
    .map((position) => {
      const fullyClosed = /all\s*closed/i.test(position.status);
      return {
        symbol: position.symbol,
        baseAsset: position.symbol.replace(/USDT$/, ""),
        side: position.side,
        positionGroupId: position.positionId,
        positionGroupLabel: "Binance 仓位历史",
        closeSequence: 1,
        status: fullyClosed ? "最终平仓" : "部分平仓",
        groupStatus: fullyClosed ? "已全部平仓" : "仍有剩余",
        realizedPnl: position.closingPnl,
        openPrice: position.avgCost,
        closeAvgPrice: position.avgClosePrice,
        closedQty: position.closedVolume,
        remainingQty: Math.max(0, position.maxOpenInterest - position.closedVolume),
        finalRemainingQty: Math.max(0, position.maxOpenInterest - position.closedVolume),
        totalClosedQty: position.closedVolume,
        totalRealizedPnl: position.closingPnl,
        groupCloseCount: 1,
        maxQty: position.maxOpenInterest,
        openTime: position.opened,
        closeTime: position.closed || position.updateTime,
        orderCount: 0,
        hasOpenBasis: true,
        officialRoi: position.roi,
        officialLeverage: position.leverage,
        marginMode: position.marginMode,
        dataSource: "binance_position_history"
      };
    })
    .sort((a, b) => b.closeTime - a.closeTime);
}

function newLeg(symbol, baseAsset, positionSide) {
  return {
    symbol,
    baseAsset: baseAsset || symbol.replace(/USDT$/, ""),
    positionSide,
    qty: 0,
    avgPrice: 0,
    maxQty: 0,
    openTime: 0,
    closeQty: 0,
    closeValue: 0,
    realizedPnl: 0,
    orderCount: 0,
    positionGroupId: "",
    groupIndex: 0,
    closeEvents: 0
  };
}

function ensureLegGroup(leg, symbol, positionSide, timestamp, groupIndex) {
  if (leg.positionGroupId) return;
  leg.positionGroupId = `${symbol}|${positionSide}|${timestamp}|${groupIndex}`;
  leg.groupIndex = groupIndex;
}

function updateGroupRows(history, leg, groupStatus) {
  for (const item of history) {
    if (item.positionGroupId !== leg.positionGroupId) continue;
    item.groupStatus = groupStatus;
    item.finalRemainingQty = leg.qty;
    item.totalClosedQty = leg.closeQty;
    item.totalRealizedPnl = leg.realizedPnl;
    item.groupCloseCount = leg.closeEvents;
  }
}

function buildAssetPreference(orders) {
  const byAsset = new Map();
  for (const order of orders) {
    const asset = String(order.baseAsset || order.symbol || "").replace(/USDT$/, "");
    if (!asset) continue;
    byAsset.set(asset, (byAsset.get(asset) || 0) + orderQty(order) * orderPrice(order));
  }
  const total = Array.from(byAsset.values()).reduce((sum, value) => sum + value, 0);
  return Array.from(byAsset.entries())
    .map(([asset, value]) => ({ asset, value, pct: total > 0 ? value / total * 100 : 0 }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 7);
}

function buildPerformance(detail, sorted, closedHistory, marginBalance) {
  let cumulative = 0;
  let peak = 0;
  let maxDrawdown = 0;
  const curve = [];
  const symbols = new Set();

  for (const order of sorted) {
    if (order.symbol) symbols.add(order.symbol);
    const pnl = toNumber(order.totalPnl ?? order.realizedProfit);
    if (pnl === 0) continue;
    cumulative += pnl;
    peak = Math.max(peak, cumulative);
    if (peak > 0) maxDrawdown = Math.max(maxDrawdown, (peak - cumulative) / peak * 100);
    curve.push({
      time: orderTimestamp(order),
      pnl: cumulative,
      roi: marginBalance > 0 ? cumulative / marginBalance * 100 : 0
    });
  }

  const totalClosed = closedHistory.length;
  const profitableClosed = closedHistory.filter((item) => item.realizedPnl > 0).length;
  return {
    roi: marginBalance > 0 ? cumulative / marginBalance * 100 : 0,
    pnl: cumulative,
    copierPnl: toNumber(detail?.copierPnl),
    sharpRatio: toNumber(detail?.sharpRatio),
    maxDrawdown,
    winRate: totalClosed > 0 ? profitableClosed / totalClosed * 100 : 0,
    profitableClosed,
    totalClosed,
    symbolCount: symbols.size,
    curve: sampleCurve(curve)
  };
}

function sampleCurve(points, limit = 48) {
  if (!points || points.length <= limit) return points || [];
  const sampled = [];
  const step = (points.length - 1) / (limit - 1);
  for (let index = 0; index < limit; index += 1) {
    sampled.push(points[Math.round(index * step)]);
  }
  return sampled;
}

async function snapshotHash(snapshot) {
  const stable = {
    portfolioId: snapshot.portfolioId,
    detail: {
      nickname: snapshot.detail?.nickname,
      avatarUrl: snapshot.detail?.avatarUrl,
      marginBalance: snapshot.marginBalance,
      aumAmount: snapshot.aumAmount,
      currentCopyCount: snapshot.currentCopyCount,
      maxCopyCount: snapshot.maxCopyCount,
      copierPnl: snapshot.detail?.copierPnl,
      sharpRatio: snapshot.detail?.sharpRatio
    },
    latestOrders: snapshot.latestOrders.map(orderKey),
    closedPositionHistory: (snapshot.closedPositionHistory || []).map((item) => ({
      symbol: item.symbol,
      side: item.side,
      positionGroupId: item.positionGroupId,
      closeSequence: item.closeSequence,
      status: item.status,
      groupStatus: item.groupStatus,
      closeTime: item.closeTime,
      closedQty: round(item.closedQty, 8),
      remainingQty: round(item.remainingQty, 8),
      finalRemainingQty: round(item.finalRemainingQty, 8),
      realizedPnl: round(item.realizedPnl, 8),
      openPrice: round(item.openPrice, 8),
      openTime: item.openTime,
      dataSource: item.dataSource,
      officialRoi: round(item.officialRoi, 8),
      officialLeverage: round(item.officialLeverage, 8)
    })),
    positions: snapshot.positions.map((position) => ({
      symbol: position.symbol,
      side: position.side,
      absQty: round(position.absQty, 8),
      avgPrice: round(position.avgPrice, 8),
      markPrice: round(position.markPrice, 8),
      unrealizedPnl: round(position.unrealizedPnl, 8)
    })),
    totalUnrealizedPnl: round(snapshot.totalUnrealizedPnl, 8)
  };
  const bytes = new TextEncoder().encode(JSON.stringify(stable));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isOpenOrder(order) {
  const side = String(order.side || "").toUpperCase();
  const positionSide = String(order.positionSide || "").toUpperCase();
  return (positionSide === "LONG" && side === "BUY") || (positionSide === "SHORT" && side === "SELL");
}

function orderQty(order) {
  return toNumber(order.executedQty ?? order.qty);
}

function orderPrice(order) {
  return toNumber(order.avgPrice ?? order.price);
}

function orderTimestamp(order) {
  return toNumber(order.orderUpdateTime || order.orderTime || order.time);
}

function toNumber(value) {
  if (value === null || value === undefined || value === "") return 0;
  const parsed = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function getInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(toNumber(value) * factor) / factor;
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean).map((value) => String(value).replace(/\/$/, ""))));
}

function safeJson(value) {
  if (!value) return null;
  try {
    return typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*"
    }
  });
}

async function ensureSchema(env) {
  if (schemaReady) return;
  if (!env.DB) throw new Error("D1 binding DB is missing. Create D1 and bind it as DB.");
  const statements = [
    `CREATE TABLE IF NOT EXISTS orders (
      portfolio_id TEXT NOT NULL,
      order_key TEXT NOT NULL,
      symbol TEXT NOT NULL,
      base_asset TEXT,
      quote_asset TEXT,
      side TEXT,
      type TEXT,
      position_side TEXT,
      executed_qty REAL,
      avg_price REAL,
      total_pnl REAL,
      order_update_time INTEGER,
      order_time INTEGER,
      raw_json TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (portfolio_id, order_key)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_orders_portfolio_time ON orders (portfolio_id, order_update_time)`,
    `CREATE TABLE IF NOT EXISTS snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      portfolio_id TEXT NOT NULL,
      polled_at TEXT NOT NULL,
      margin_balance REAL,
      aum_amount REAL,
      current_copy_count INTEGER,
      max_copy_count INTEGER,
      orders_stored INTEGER,
      orders_added INTEGER,
      data_hash TEXT,
      snapshot_json TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS idx_snapshots_portfolio_id ON snapshots (portfolio_id, id DESC)`,
    `CREATE TABLE IF NOT EXISTS poll_runs (
      portfolio_id TEXT PRIMARY KEY,
      last_poll_at TEXT,
      last_snapshot_at TEXT,
      last_error TEXT,
      updated_at TEXT,
      meta_json TEXT
    )`
  ];
  for (const sql of statements) {
    await env.DB.prepare(sql).run();
  }
  schemaReady = true;
}
