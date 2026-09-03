const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { execFile } = require("node:child_process");

const rootDir = __dirname;
const envPath = path.join(rootDir, ".env");

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
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
  port: Number(process.env.LEADER_POLLER_PORT || process.env.PORT || 8790),
  portfolioId: process.env.LEADER_PORTFOLIO_ID || "5075281354358777856",
  pollIntervalMs: Number(process.env.LEADER_POLL_INTERVAL_MS || 300_000),
  pageSize: Math.min(Number(process.env.LEADER_PAGE_SIZE || 100), 100),
  backfillPages: Number(process.env.LEADER_BACKFILL_PAGES || 30),
  fetchMarkPrices: process.env.LEADER_FETCH_MARK_PRICES !== "0",
  officialRoiTimeRange: process.env.LEADER_ROI_TIME_RANGE || "90D",
  binanceWebBaseUrl: (process.env.BINANCE_WEB_BASE_URL || "https://www.binance.com").replace(/\/$/, ""),
  binanceFapiBaseUrl: (process.env.BINANCE_FAPI_BASE_URL || "https://fapi.binance.com").replace(/\/$/, "")
};

const traders = [
  {
    portfolioId: "5075281354358777856",
    label: "熬鹰资本"
  },
  {
    portfolioId: "5108371059752839168",
    label: "鎏渊"
  },
  {
    portfolioId: "5175036213074191105",
    label: "如何设置低于10万U不能跟我的单"
  },
  {
    portfolioId: "4788776444236355328",
    label: "星辰社区-意钦"
  }
];

const dataDir = path.join(rootDir, "data");
fs.mkdirSync(dataDir, { recursive: true });

const state = {
  pollingByTrader: new Map(),
  lastErrorByTrader: new Map(),
  lastSnapshotByTrader: new Map(),
  lastPollAtByTrader: new Map(),
  timer: null
};

function getTrader(portfolioId = config.portfolioId) {
  return traders.find((trader) => trader.portfolioId === String(portfolioId)) || traders[0];
}

function ordersPathFor(trader) {
  return path.join(dataDir, `leader_orders_${trader.portfolioId}.json`);
}

function snapshotsPathFor(trader) {
  return path.join(dataDir, `leader_snapshots_${trader.portfolioId}.jsonl`);
}

function toNumber(value) {
  if (value === null || value === undefined || value === "") return 0;
  const parsed = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
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

function readOrders(trader = getTrader()) {
  const ordersPath = ordersPathFor(trader);
  if (!fs.existsSync(ordersPath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(ordersPath, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeOrders(trader, orders) {
  const ordersPath = ordersPathFor(trader);
  const sorted = [...orders].sort((a, b) => toNumber(a.orderUpdateTime || a.time) - toNumber(b.orderUpdateTime || b.time));
  fs.writeFileSync(ordersPath, JSON.stringify(sorted, null, 2));
}

async function fetchJson(url, options = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      return await fetchJsonNative(url, options);
    } catch (nativeError) {
      try {
        if (process.env.LEADER_DISABLE_POWERSHELL_FALLBACK === "1") throw nativeError;
        return await fetchJsonViaPowerShell(url, options);
      } catch (fallbackError) {
        lastError = fallbackError;
        if (!isRetryableBinanceError(fallbackError) || attempt === 4) break;
        await sleep(900 * attempt);
      }
    }
  }
  throw lastError;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableBinanceError(error) {
  const payload = error && error.payload;
  return payload && (payload.code === "11012005" || /busy|later/i.test(String(payload.message || error.message)));
}

async function fetchJsonNative(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: defaultHeaders(options.headers)
  });
  const parsed = await parseResponse(response);
  validateBinancePayload(response.status, response.ok, parsed);
  return parsed;
}

function defaultHeaders(headers = {}) {
  return {
    "accept": "application/json",
    "content-type": "application/json",
    "clienttype": "web",
    "user-agent": "Mozilla/5.0 AlphaFoxShadowPoller/1.0",
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
$headers = @{
  accept = 'application/json'
  clienttype = 'web'
  'user-agent' = 'Mozilla/5.0 AlphaFoxShadowPoller/1.0'
}
try {
  if ($env:REQ_METHOD -eq 'POST') {
    $response = Invoke-WebRequest -Uri $env:REQ_URL -Method Post -ContentType 'application/json' -Headers $headers -Body $env:REQ_BODY -TimeoutSec 30
  } else {
    $response = Invoke-WebRequest -Uri $env:REQ_URL -Method Get -Headers $headers -TimeoutSec 30
  }
  $stream = $response.RawContentStream
  $memory = [System.IO.MemoryStream]::new()
  $stream.CopyTo($memory)
  $result = [System.Text.Encoding]::UTF8.GetString($memory.ToArray())
  Emit-JsonBase64 $result
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
    execFile("pwsh", ["-NoProfile", "-Command", script], {
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

async function fetchLeaderDetail(trader = getTrader()) {
  const url = `${config.binanceWebBaseUrl}/bapi/futures/v1/friendly/future/copy-trade/lead-portfolio/detail?portfolioId=${encodeURIComponent(trader.portfolioId)}`;
  try {
    const payload = await fetchJson(url);
    return payload.data || trader.fallbackDetail || null;
  } catch (error) {
    if (trader.fallbackDetail) return trader.fallbackDetail;
    throw error;
  }
}

async function fetchOfficialRoi(trader = getTrader()) {
  const url = `${config.binanceWebBaseUrl}/bapi/futures/v1/friendly/future/copy-trade/home-page/query-list`;
  const payload = await fetchJson(url, {
    method: "POST",
    body: JSON.stringify({
      pageNumber: 1,
      pageSize: 20,
      timeRange: config.officialRoiTimeRange,
      dataType: "ROI",
      favoriteOnly: false,
      hideFull: false,
      nickname: trader.label,
      order: "DESC",
      userAsset: 0,
      portfolioType: "ALL"
    })
  });
  const list = payload?.data?.list || [];
  const match = list.find((item) => String(item.leadPortfolioId) === trader.portfolioId);
  if (!match) throw new Error(`Official ROI data unavailable for ${trader.portfolioId}`);
  const curve = (match.chartItems || [])
    .filter((item) => String(item.dataType || "ROI").toUpperCase() === "ROI")
    .map((item) => ({ time: toNumber(item.dateTime), roi: toNumber(item.value) }))
    .filter((item) => item.time > 0)
    .sort((a, b) => a.time - b.time);
  if (curve.length < 2) throw new Error(`Official ROI curve unavailable for ${trader.portfolioId}`);
  return {
    roi: toNumber(match.roi),
    timeRange: config.officialRoiTimeRange,
    curve
  };
}

async function fetchOrderHistoryPage(trader = getTrader(), pageNumber) {
  const url = `${config.binanceWebBaseUrl}/bapi/futures/v1/friendly/future/copy-trade/lead-portfolio/order-history`;
  const payload = await fetchJson(url, {
    method: "POST",
    body: JSON.stringify({
      portfolioId: trader.portfolioId,
      pageNumber,
      pageSize: config.pageSize
    })
  });
  return payload.data || { total: 0, list: [] };
}

async function fetchPositionHistory(trader = getTrader()) {
  const url = `${config.binanceWebBaseUrl}/bapi/futures/v1/friendly/future/copy-trade/lead-portfolio/position-history`;
  const payload = await fetchJson(url, {
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

async function fetchMarkPrice(symbol) {
  const url = `${config.binanceFapiBaseUrl}/fapi/v1/premiumIndex?symbol=${encodeURIComponent(symbol)}`;
  const payload = await fetchJson(url, { headers: { "content-type": "application/json" } });
  return toNumber(payload.markPrice);
}

async function mergeFreshOrders(trader, existing) {
  const known = new Set(existing.map(orderKey));
  const shouldBackfill = existing.length === 0;
  const pages = shouldBackfill ? config.backfillPages : 1;
  const additions = [];
  let total = null;

  for (let pageNumber = 1; pageNumber <= pages; pageNumber += 1) {
    let data;
    try {
      data = await fetchOrderHistoryPage(trader, pageNumber);
    } catch (error) {
      if (pageNumber === 1) throw error;
      break;
    }
    const list = Array.isArray(data.list) ? data.list : [];
    total = data.total ?? total;
    if (!list.length) break;
    for (const order of list) {
      const key = orderKey(order);
      if (!known.has(key)) {
        known.add(key);
        additions.push(order);
      }
    }
    if (!shouldBackfill) break;
    if (total && pageNumber * config.pageSize >= total) break;
    await sleep(300);
  }

  return {
    orders: [...existing, ...additions],
    additions,
    total
  };
}

function signedDelta(order) {
  const qty = toNumber(order.executedQty ?? order.qty);
  const side = String(order.side || "").toUpperCase();
  const positionSide = String(order.positionSide || "").toUpperCase();
  if (positionSide === "LONG") return side === "BUY" ? qty : -qty;
  if (positionSide === "SHORT") return side === "SELL" ? -qty : qty;
  return side === "BUY" ? qty : -qty;
}

function applyOrder(position, order) {
  const delta = signedDelta(order);
  const price = toNumber(order.avgPrice ?? order.price);
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
  position.lastOrderTime = Math.max(position.lastOrderTime || 0, toNumber(order.orderUpdateTime || order.time));
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

function isOpenOrder(order) {
  const side = String(order.side || "").toUpperCase();
  const positionSide = String(order.positionSide || "").toUpperCase();
  return (positionSide === "LONG" && side === "BUY") || (positionSide === "SHORT" && side === "SELL");
}

function buildClosedPositionHistory(sorted) {
  const active = new Map();
  const history = [];

  for (const order of sorted) {
    const symbol = String(order.symbol || "").toUpperCase();
    const positionSide = String(order.positionSide || "").toUpperCase();
    if (!symbol || !positionSide) continue;

    const key = `${symbol}|${positionSide}`;
    if (!active.has(key)) {
      active.set(key, {
        symbol,
        baseAsset: order.baseAsset || symbol.replace(/USDT$/, ""),
        positionSide,
        qty: 0,
        avgPrice: 0,
        maxQty: 0,
        openTime: 0,
        closeQty: 0,
        closeValue: 0,
        realizedPnl: 0,
        orderCount: 0
      });
    }

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

    leg.realizedPnl += toNumber(order.totalPnl ?? order.realizedProfit);
    leg.closeQty += qty;
    leg.closeValue += qty * price;
    leg.qty = Math.max(0, leg.qty - qty);
    leg.closeTime = timestamp;

    if (leg.qty <= 1e-8) {
      const closeAvgPrice = leg.closeQty > 0 ? leg.closeValue / leg.closeQty : price;
      history.push({
        symbol: leg.symbol,
        baseAsset: leg.baseAsset,
        side: leg.positionSide,
        status: "完全平仓",
        realizedPnl: leg.realizedPnl,
        openPrice: leg.avgPrice || price,
        closeAvgPrice,
        closedQty: leg.closeQty,
        maxQty: leg.maxQty || leg.closeQty,
        openTime: leg.openTime || timestamp,
        closeTime: leg.closeTime,
        orderCount: leg.orderCount
      });
      active.set(key, {
        symbol,
        baseAsset: order.baseAsset || symbol.replace(/USDT$/, ""),
        positionSide,
        qty: 0,
        avgPrice: 0,
        maxQty: 0,
        openTime: 0,
        closeQty: 0,
        closeValue: 0,
        realizedPnl: 0,
        orderCount: 0
      });
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

function buildAssetPreference(orders) {
  const byAsset = new Map();
  for (const order of orders) {
    const asset = String(order.baseAsset || order.symbol || "").replace(/USDT$/, "");
    if (!asset) continue;
    byAsset.set(asset, (byAsset.get(asset) || 0) + orderQty(order) * orderPrice(order));
  }
  const total = Array.from(byAsset.values()).reduce((sum, value) => sum + value, 0);
  return Array.from(byAsset.entries())
    .map(([asset, value]) => ({
      asset,
      value,
      pct: total > 0 ? value / total * 100 : 0
    }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 7);
}

function sampleCurve(points, limit = 48) {
  if (points.length <= limit) return points;
  const sampled = [];
  const step = (points.length - 1) / (limit - 1);
  for (let index = 0; index < limit; index += 1) {
    sampled.push(points[Math.round(index * step)]);
  }
  return sampled;
}

function buildPerformance(detail, sorted, closedHistory, marginBalance) {
  let cumulative = 0;
  let peak = 0;
  let maxDrawdown = 0;
  const curve = [];
  const symbols = new Set();

  for (const order of sorted) {
    const symbol = String(order.symbol || "");
    if (symbol) symbols.add(symbol);
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

function buildRecentOpenPositionSeeds(sorted) {
  const latestCloseByKey = new Map();

  for (const order of sorted) {
    const symbol = String(order.symbol || "").toUpperCase();
    const positionSide = String(order.positionSide || "").toUpperCase();
    if (!symbol || !positionSide) continue;
    const key = `${symbol}|${positionSide}`;
    if (!isOpenOrder(order)) latestCloseByKey.set(key, orderTimestamp(order));
  }

  const positionsByKey = new Map();

  for (const order of sorted) {
    const symbol = String(order.symbol || "").toUpperCase();
    const positionSide = String(order.positionSide || "").toUpperCase();
    if (!symbol || !positionSide || !isOpenOrder(order)) continue;
    const key = `${symbol}|${positionSide}`;
    const cutoff = latestCloseByKey.get(key) || 0;
    if (orderTimestamp(order) <= cutoff) continue;

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
    applyOrder(positionsByKey.get(key), order);
  }

  return Array.from(positionsByKey.values()).filter((position) => Math.abs(position.qty) > 1e-8);
}

function readBalanceCurve(trader = getTrader()) {
  const snapshotsPath = snapshotsPathFor(trader);
  if (!fs.existsSync(snapshotsPath)) return [];
  const lines = fs.readFileSync(snapshotsPath, "utf8").split(/\r?\n/).filter(Boolean).slice(-120);
  const points = [];
  for (const line of lines) {
    try {
      const item = JSON.parse(line);
      if (item.polledAt && toNumber(item.marginBalance) > 0) {
        points.push({
          time: new Date(item.polledAt).getTime(),
          balance: toNumber(item.marginBalance),
          aum: toNumber(item.aumAmount)
        });
      }
    } catch {
      // Ignore corrupted local snapshot lines.
    }
  }
  return points;
}

async function buildSnapshot(trader, detail, orders, additions, officialRoi = null, officialPositionHistory = []) {
  const sorted = [...orders].sort((a, b) => toNumber(a.orderUpdateTime || a.time) - toNumber(b.orderUpdateTime || b.time));
  const rawPositions = buildRecentOpenPositionSeeds(sorted);
  const positions = [];
  for (const position of rawPositions) {
    let markPrice = position.avgPrice;
    if (config.fetchMarkPrices) {
      try {
        markPrice = await fetchMarkPrice(position.symbol);
      } catch {
        markPrice = position.avgPrice;
      }
    }
    const absQty = Math.abs(position.qty);
    const side = position.qty > 0 ? "LONG" : "SHORT";
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
  const reconstructedPerformance = sorted.length ? buildPerformance(detail, sorted, closedPositionHistory, marginBalance) : (trader.fallbackPerformance || buildPerformance(detail, sorted, closedPositionHistory, marginBalance));
  const performance = officialRoi?.curve?.length ? {
    ...reconstructedPerformance,
    roi: officialRoi.roi,
    curve: officialRoi.curve,
    curveSource: "binance_official",
    curveTimeRange: officialRoi.timeRange
  } : {
    ...reconstructedPerformance,
    curveSource: "reconstructed",
    curveTimeRange: null
  };
  const assetPreference = buildAssetPreference(sorted);
  const balanceCurve = [
    ...readBalanceCurve(trader),
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
    ordersStored: orders.length,
    ordersAdded: additions.length,
    latestOrders: [...orders]
      .sort((a, b) => toNumber(b.orderUpdateTime || b.time) - toNumber(a.orderUpdateTime || a.time))
      .slice(0, 30),
    closedPositionHistory: closedPositionHistory.slice(0, 80),
    assetPreference,
    performance,
    balanceCurve: sampleCurve(balanceCurve),
    positions,
    totalNotional,
    totalUnrealizedPnl,
    effectiveLeverage
  };
}

async function pollOnce(portfolioId = config.portfolioId) {
  const trader = getTrader(portfolioId);
  if (state.pollingByTrader.get(trader.portfolioId)) return state.lastSnapshotByTrader.get(trader.portfolioId);
  state.pollingByTrader.set(trader.portfolioId, true);
  state.lastErrorByTrader.set(trader.portfolioId, null);
  try {
    const [detail, officialRoi, officialPositionHistory] = await Promise.all([
      fetchLeaderDetail(trader),
      fetchOfficialRoi(trader).catch(() => null),
      fetchPositionHistory(trader).catch(() => [])
    ]);
    const existing = readOrders(trader);
    const merged = await mergeFreshOrders(trader, existing);
    writeOrders(trader, merged.orders);
    const snapshot = await buildSnapshot(trader, detail, merged.orders, merged.additions, officialRoi, officialPositionHistory);
    const snapshotsPath = snapshotsPathFor(trader);
    fs.appendFileSync(snapshotsPath, `${JSON.stringify(snapshot)}\n`);
    state.lastSnapshotByTrader.set(trader.portfolioId, snapshot);
    state.lastPollAtByTrader.set(trader.portfolioId, snapshot.polledAt);
    return snapshot;
  } catch (error) {
    state.lastErrorByTrader.set(trader.portfolioId, {
      message: error.message,
      payload: error.payload || null,
      at: new Date().toISOString()
    });
    throw error;
  } finally {
    state.pollingByTrader.set(trader.portfolioId, false);
  }
}

function json(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(payload, null, 2));
}

function serveStatic(req, res) {
  const url = new URL(req.url, "http://localhost");
  const pathname = url.pathname === "/" ? "/binance_leader_console.html" : url.pathname;
  const safePath = path.normalize(path.join(rootDir, pathname));
  if (!safePath.startsWith(rootDir) || !fs.existsSync(safePath) || !fs.statSync(safePath).isFile()) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }
  const type = pathname.endsWith(".html") ? "text/html; charset=utf-8" : "application/octet-stream";
  res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
  res.end(fs.readFileSync(safePath));
}

async function handleApi(req, res) {
  const url = new URL(req.url, "http://localhost");
  const trader = getTrader(url.searchParams.get("portfolioId") || config.portfolioId);
  try {
    if (url.pathname === "/api/health") {
      json(res, 200, {
        ok: true,
        defaultPortfolioId: config.portfolioId,
        traders: traders.map((item) => ({
          portfolioId: item.portfolioId,
          label: item.label,
          lastPollAt: state.lastPollAtByTrader.get(item.portfolioId) || null,
          polling: Boolean(state.pollingByTrader.get(item.portfolioId)),
          lastError: state.lastErrorByTrader.get(item.portfolioId) || null
        })),
        pollIntervalMs: config.pollIntervalMs,
      });
      return;
    }
    if (url.pathname === "/api/traders") {
      json(res, 200, traders.map((item) => ({
        portfolioId: item.portfolioId,
        label: item.label,
        fallback: Boolean(item.fallbackDetail)
      })));
      return;
    }
    if (url.pathname === "/api/poll") {
      json(res, 200, await pollOnce(trader.portfolioId));
      return;
    }
    if (url.pathname === "/api/snapshot") {
      let snapshot = state.lastSnapshotByTrader.get(trader.portfolioId);
      if (!snapshot || !snapshot.detail) {
        const orders = readOrders(trader);
        if (orders.length || trader.fallbackDetail) {
          let detail = snapshot?.detail || null;
          try {
            detail = detail || await fetchLeaderDetail(trader);
          } catch {
            // A detail miss should not block viewing the local order ledger.
          }
          detail = detail || trader.fallbackDetail || null;
          const [officialRoi, officialPositionHistory] = await Promise.all([
            fetchOfficialRoi(trader).catch(() => null),
            fetchPositionHistory(trader).catch(() => [])
          ]);
          const rebuilt = await buildSnapshot(trader, detail, orders, [], officialRoi, officialPositionHistory);
          if (!snapshot || detail) {
            state.lastSnapshotByTrader.set(trader.portfolioId, rebuilt);
            snapshot = rebuilt;
          }
        }
      }
      json(res, 200, snapshot || { portfolioId: trader.portfolioId, detail: trader.fallbackDetail || null, positions: [], latestOrders: [] });
      return;
    }
    if (url.pathname === "/api/raw/detail") {
      json(res, 200, await fetchLeaderDetail(trader));
      return;
    }
    if (url.pathname === "/api/raw/official-roi") {
      json(res, 200, await fetchOfficialRoi(trader));
      return;
    }
    if (url.pathname === "/api/raw/order-history") {
      const pageNumber = Number(url.searchParams.get("pageNumber") || 1);
      json(res, 200, await fetchOrderHistoryPage(trader, pageNumber));
      return;
    }
    if (url.pathname === "/api/raw/position-history") {
      json(res, 200, await fetchPositionHistory(trader));
      return;
    }
    json(res, 404, { error: "Unknown API route" });
  } catch (error) {
    json(res, 500, {
      error: error.message,
      payload: error.payload || null
    });
  }
}

const server = http.createServer(async (req, res) => {
  if (req.url.startsWith("/api/")) {
    await handleApi(req, res);
    return;
  }
  serveStatic(req, res);
});

server.listen(config.port, "127.0.0.1", () => {
  console.log(`Binance leader poller: http://127.0.0.1:${config.port}/`);
  console.log(`Portfolio IDs: ${traders.map((trader) => trader.portfolioId).join(", ")}`);
  console.log(`Poll interval: ${Math.round(config.pollIntervalMs / 1000)}s`);
  for (const trader of traders) {
    pollOnce(trader.portfolioId).catch((error) => {
      console.error(`Initial poll failed for ${trader.label}:`, error.message);
    });
  }
  state.timer = setInterval(() => {
    for (const trader of traders) {
      pollOnce(trader.portfolioId).catch((error) => {
        console.error(`Scheduled poll failed for ${trader.label}:`, error.message);
      });
    }
  }, config.pollIntervalMs);
});
