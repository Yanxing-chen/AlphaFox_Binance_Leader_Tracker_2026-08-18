import { execFile } from "node:child_process";

const TRADERS = [
  { portfolioId: "5075281354358777856", label: "熬鹰资本" },
  { portfolioId: "5108371059752839168", label: "鎏渊" },
  { portfolioId: "5121666018948220416", label: "趋势交易王" },
  { portfolioId: "5142214769055593984", label: "Rainbow88" },
  { portfolioId: "5098677138323805440", label: "geddong" }
];

const CONFIG = {
  binanceWebBaseUrl: process.env.BINANCE_WEB_BASE_URL || "https://www.binance.com",
  binanceFapiBaseUrl: process.env.BINANCE_FAPI_BASE_URL || "https://www.binance.com",
  pageSize: Number(process.env.PAGE_SIZE || 100),
  backfillPages: Number(process.env.BACKFILL_PAGES || 6),
  ingestUrl: process.env.LEADER_TRACKER_INGEST_URL || "",
  ingestSecret: process.env.LEADER_TRACKER_INGEST_SECRET || "",
  traderIds: (process.env.TRADER_IDS || "").split(",").map((item) => item.trim()).filter(Boolean),
  dryRun: process.argv.includes("--dry-run")
};

main().catch((error) => {
  console.error(error.stack || error.message);
  if (error.payload) console.error(JSON.stringify(error.payload, null, 2));
  process.exitCode = 1;
});

async function main() {
  if (!CONFIG.dryRun && (!CONFIG.ingestUrl || !CONFIG.ingestSecret)) {
    throw new Error("Missing LEADER_TRACKER_INGEST_URL or LEADER_TRACKER_INGEST_SECRET");
  }

  const selectedTraders = CONFIG.traderIds.length
    ? TRADERS.filter((trader) => CONFIG.traderIds.includes(trader.portfolioId))
    : TRADERS;
  if (!selectedTraders.length) {
    throw new Error(`No traders matched TRADER_IDS=${CONFIG.traderIds.join(",")}`);
  }

  const snapshots = [];
  const uploadResults = [];
  for (const trader of selectedTraders) {
    console.log(`Fetching ${trader.label} (${trader.portfolioId})`);
    const detail = await fetchLeaderDetail(trader);
    const orders = await fetchOrders(trader);
    const snapshot = await buildSnapshot(trader, detail, orders);
    snapshots.push(snapshot);
    console.log(`  positions=${snapshot.positions.length} latest=${snapshot.latestOrders.length} orders=${snapshot.ordersStored}`);

    if (!CONFIG.dryRun) {
      const text = await postIngest({
        source: "github-actions",
        snapshots: [snapshot]
      });
      uploadResults.push(parseMaybeJson(text));
      console.log(`  uploaded=${trader.label}`);
    }
  }

  if (CONFIG.dryRun) {
    console.log(JSON.stringify({
      ok: true,
      dryRun: true,
      snapshots: snapshots.map((snapshot) => ({
        portfolioId: snapshot.portfolioId,
        name: snapshot.detail?.nickname,
        positions: snapshot.positions.length,
        latestOrders: snapshot.latestOrders.length,
        marginBalance: snapshot.marginBalance
      }))
    }, null, 2));
    return;
  }

  console.log(JSON.stringify({
    ok: true,
    source: "github-actions",
    uploads: uploadResults
  }, null, 2));
}

function parseMaybeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function postIngest(payload) {
  const body = JSON.stringify(payload);
  try {
    const response = await fetch(CONFIG.ingestUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${CONFIG.ingestSecret}`
      },
      body
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Ingest failed: HTTP ${response.status} ${text}`);
    return text;
  } catch (error) {
    if (process.platform !== "win32") throw error;
    return postIngestViaPowerShell(body);
  }
}

function postIngestViaPowerShell(body) {
  const script = `
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$OutputEncoding = [System.Text.UTF8Encoding]::new()
function Read-ResponseText($response) {
  if ($null -ne $response.RawContentStream) {
    $stream = $response.RawContentStream
    if ($stream.CanSeek) {
      $stream.Position = 0
    }
    $memory = [System.IO.MemoryStream]::new()
    try {
      $stream.CopyTo($memory)
      return [System.Text.Encoding]::UTF8.GetString($memory.ToArray())
    } finally {
      $memory.Dispose()
    }
  }
  return [string]$response.Content
}
try {
  $headers = @{ authorization = "Bearer $env:INGEST_SECRET" }
  $bodyBytes = [System.Text.Encoding]::UTF8.GetBytes($env:INGEST_BODY)
  $response = Invoke-WebRequest -Uri $env:INGEST_URL -Method Post -ContentType 'application/json; charset=utf-8' -Headers $headers -Body $bodyBytes -UseBasicParsing -TimeoutSec 60
  Read-ResponseText $response
} catch {
  if ($_.ErrorDetails.Message) {
    $_.ErrorDetails.Message
  } else {
    @{ error = $_.Exception.Message } | ConvertTo-Json -Compress
  }
  exit 1
}
`;

  return new Promise((resolve, reject) => {
    execFile("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
      timeout: 75_000,
      windowsHide: true,
      env: {
        ...process.env,
        INGEST_URL: CONFIG.ingestUrl,
        INGEST_SECRET: CONFIG.ingestSecret,
        INGEST_BODY: body
      }
    }, (error, stdout, stderr) => {
      const output = String(stdout || "").trim();
      if (error) {
        reject(new Error(stderr || output || error.message));
        return;
      }
      resolve(output);
    });
  });
}

async function fetchOrders(trader) {
  const known = new Set();
  const orders = [];
  for (let pageNumber = 1; pageNumber <= CONFIG.backfillPages; pageNumber += 1) {
    const data = await fetchOrderHistoryPage(trader, pageNumber);
    const list = Array.isArray(data.list) ? data.list : [];
    if (!list.length) break;
    for (const rawOrder of list) {
      const order = normalizeOrder(rawOrder);
      const key = orderKey(order);
      if (!known.has(key)) {
        known.add(key);
        orders.push(order);
      }
    }
    if (data.total && pageNumber * CONFIG.pageSize >= data.total) break;
    await sleep(180);
  }
  return orders.sort((a, b) => orderTimestamp(a) - orderTimestamp(b));
}

async function fetchLeaderDetail(trader) {
  const url = `${CONFIG.binanceWebBaseUrl}/bapi/futures/v1/friendly/future/copy-trade/lead-portfolio/detail?portfolioId=${encodeURIComponent(trader.portfolioId)}`;
  const payload = await fetchJson(url);
  return payload.data || null;
}

async function fetchOrderHistoryPage(trader, pageNumber) {
  const payload = await fetchJson(`${CONFIG.binanceWebBaseUrl}/bapi/futures/v1/friendly/future/copy-trade/lead-portfolio/order-history`, {
    method: "POST",
    body: JSON.stringify({
      portfolioId: trader.portfolioId,
      pageNumber,
      pageSize: CONFIG.pageSize
    })
  });
  return payload.data || { total: 0, list: [] };
}

async function fetchMarkPrice(symbol) {
  const encoded = encodeURIComponent(symbol);
  const bases = unique([
    CONFIG.binanceFapiBaseUrl,
    CONFIG.binanceWebBaseUrl,
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
      try {
        if (process.platform !== "win32") throw error;
        return await fetchJsonViaPowerShell(url, options);
      } catch (fallbackError) {
        lastError = fallbackError;
      }
      if (!isRetryableBinanceError(lastError) || attempt === 3) break;
      await sleep(650 * attempt);
    }
  }
  throw lastError;
}

function fetchJsonViaPowerShell(url, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  const body = typeof options.body === "string" ? options.body : "";
  const script = `
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$OutputEncoding = [System.Text.UTF8Encoding]::new()
function Emit-JsonBase64($jsonText) {
  [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($jsonText))
}
function Read-ResponseText($response) {
  if ($null -ne $response.RawContentStream) {
    $stream = $response.RawContentStream
    if ($stream.CanSeek) {
      $stream.Position = 0
    }
    $memory = [System.IO.MemoryStream]::new()
    try {
      $stream.CopyTo($memory)
      return [System.Text.Encoding]::UTF8.GetString($memory.ToArray())
    } finally {
      $memory.Dispose()
    }
  }
  return [string]$response.Content
}
$headers = @{
  accept = 'application/json'
  'accept-language' = 'zh-CN,zh;q=0.9,en;q=0.8'
  clienttype = 'web'
  lang = 'zh-CN'
  origin = 'https://www.binance.com'
  referer = 'https://www.binance.com/zh-CN/copy-trading/'
  'user-agent' = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
}
try {
  if ($env:REQ_METHOD -eq 'POST') {
    $response = Invoke-WebRequest -Uri $env:REQ_URL -Method Post -ContentType 'application/json' -Headers $headers -Body $env:REQ_BODY -UseBasicParsing -TimeoutSec 30
  } else {
    $response = Invoke-WebRequest -Uri $env:REQ_URL -Method Get -Headers $headers -UseBasicParsing -TimeoutSec 30
  }
  Emit-JsonBase64 (Read-ResponseText $response)
} catch {
  if ($_.ErrorDetails.Message) {
    Emit-JsonBase64 $_.ErrorDetails.Message
  } else {
    Emit-JsonBase64 (@{ error = $_.Exception.Message } | ConvertTo-Json -Compress)
  }
  exit 1
}
`;

  return new Promise((resolve, reject) => {
    execFile("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
      timeout: 45_000,
      windowsHide: true,
      env: {
        ...process.env,
        REQ_URL: url,
        REQ_METHOD: method,
        REQ_BODY: body
      }
    }, (error, stdout, stderr) => {
      const encoded = String(stdout || "").trim();
      const output = Buffer.from(encoded, "base64").toString("utf8");
      let parsed = output;
      try {
        parsed = JSON.parse(output);
      } catch {
        // Preserve text output for diagnostics.
      }
      if (error) {
        const wrapped = new Error(stderr || (parsed && parsed.error) || error.message);
        wrapped.payload = parsed;
        reject(wrapped);
        return;
      }
      try {
        validateBinancePayload(200, true, parsed);
        resolve(parsed);
      } catch (validationError) {
        reject(validationError);
      }
    });
  });
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

async function buildSnapshot(trader, detail, orders) {
  const rawPositions = buildRecentOpenPositionSeeds(orders);
  const positions = [];
  for (const position of rawPositions) {
    let markPrice = position.avgPrice;
    try {
      markPrice = await fetchMarkPrice(position.symbol);
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
  const closedPositionHistory = buildClosedPositionHistory(orders);
  return {
    portfolioId: trader.portfolioId,
    polledAt: new Date().toISOString(),
    detail,
    marginBalance,
    aumAmount: toNumber(detail?.aumAmount),
    currentCopyCount: toNumber(detail?.currentCopyCount),
    maxCopyCount: toNumber(detail?.maxCopyCount),
    lastTradeTime: toNumber(detail?.lastTradeTime),
    ordersStored: orders.length,
    ordersAdded: 0,
    latestOrders: [...orders].sort((a, b) => orderTimestamp(b) - orderTimestamp(a)).slice(0, 30),
    closedPositionHistory: closedPositionHistory.slice(0, 80),
    assetPreference: buildAssetPreference(orders),
    performance: buildPerformance(detail, orders, closedPositionHistory, marginBalance),
    balanceCurve: [{ time: Date.now(), balance: marginBalance, aum: toNumber(detail?.aumAmount) }],
    positions,
    totalNotional: positions.reduce((sum, position) => sum + position.notional, 0),
    totalUnrealizedPnl: positions.reduce((sum, position) => sum + position.unrealizedPnl, 0),
    effectiveLeverage: marginBalance > 0 ? positions.reduce((sum, position) => sum + position.notional, 0) / marginBalance : 0
  };
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
    orderTime: toNumber(order.orderTime || order.time || order.orderUpdateTime)
  };
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
  position.realizedPnl += toNumber(order.totalPnl);
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
    position.realizedPnl += toNumber(order.totalPnl);
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
    const realizedPnl = toNumber(order.totalPnl);
    const status = !hasOpenBasis
      ? "平仓记录"
      : remainingQty > 1e-8
        ? "部分平仓"
        : "完全平仓";

    history.push({
      symbol: leg.symbol,
      baseAsset: leg.baseAsset,
      side: leg.positionSide,
      status,
      realizedPnl,
      openPrice: leg.avgPrice || price,
      closeAvgPrice: price,
      closedQty,
      remainingQty,
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
    if (leg.qty <= 1e-8) {
      active.set(key, newLeg(symbol, order.baseAsset, positionSide));
    }
  }
  return history.sort((a, b) => b.closeTime - a.closeTime);
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
    orderCount: 0
  };
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
    const pnl = toNumber(order.totalPnl);
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

function isOpenOrder(order) {
  const side = String(order.side || "").toUpperCase();
  const positionSide = String(order.positionSide || "").toUpperCase();
  return (positionSide === "LONG" && side === "BUY") || (positionSide === "SHORT" && side === "SELL");
}

function orderKey(order) {
  return [
    order.orderUpdateTime || "",
    order.symbol || "",
    order.side || "",
    order.positionSide || "",
    order.avgPrice || "",
    order.executedQty || ""
  ].join("|");
}

function orderQty(order) {
  return toNumber(order.executedQty);
}

function orderPrice(order) {
  return toNumber(order.avgPrice);
}

function orderTimestamp(order) {
  return toNumber(order.orderUpdateTime || order.orderTime);
}

function toNumber(value) {
  if (value === null || value === undefined || value === "") return 0;
  const parsed = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean).map((value) => String(value).replace(/\/$/, ""))));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
