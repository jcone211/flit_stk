// 小石 API 批量行情（Chrome 扩展内使用的 ES module 版）
// 与 Node 脚本 js/quote_batch.js 同源逻辑，差异：
//   - ES module（import/export），供 background 直接调用
//   - apiKey 由调用方传入（扩展内存于 chrome.storage.sync 全局设置）
//
// 【契约变更 2026-09-16】小石公开 Agent 契约（xiaoshi-agent-contract/v1）已下线
// GET /api/v3/data/quotes。批量行情改为 POST /api/v3/market/quotes，
// body = { requests: [{ symbol, market, instrument }] }，单次 1-100 只
// （超过返回 400「requests must contain 1-100 instruments」）。
// 旧路径现在固定返回 404 operation_not_in_public_contract，属于契约退役而非
// 可用性抖动：不得回退调用、不得改走镜像或单只轮询。
// 新接口按标的隔离失败：脏代码只进 errors[]，同批有效代码照常返回。
// 批量现已支持 CN/HK/US；调用方按市场分别传入 market（默认 CN）。

const API_BASE = 'https://api.shizixi.com';
const MAX_CODES_PER_REQUEST = 100; // 服务端限制：单次最多 100 只

/**
 * 根据 codes 批量获取实时行情
 * @param {string[]} codes - 股票代码数组，如 ['600519','000001']（可带 .SZ/.SH 后缀）
 * @param {object}   [opts]
 * @param {string}   opts.apiKey     - 必填：小石 API Key
 * @param {string}   [opts.market='CN']      - 市场: 'CN' | 'HK' | 'US'
 * @param {string}   [opts.instrument='stock'] - 类型: 'stock' | 'index' | 'etf'
 * @param {boolean}  [opts.full=false] - true 则返回原始完整字段
 * @returns {Promise<{requested:number, count:number, items:Array, missing_codes:string[], error_details:Array}>}
 */
export async function batchQuotes(codes, opts = {}) {
  const { apiKey, market = 'CN', instrument = 'stock', full = false } = opts;

  if (!apiKey) {
    throw new Error('apiKey 未配置');
  }
  if (!Array.isArray(codes) || codes.length === 0) {
    throw new Error('codes 必须是非空数组');
  }

  const symbols = codes.map(normalizeSymbol).filter(Boolean);
  if (symbols.length === 0) {
    throw new Error('codes 中没有有效代码');
  }

  // 服务端限制单次 100 只，超长自动切片（并行请求）
  const slices = [];
  for (let i = 0; i < symbols.length; i += MAX_CODES_PER_REQUEST) {
    slices.push(symbols.slice(i, i + MAX_CODES_PER_REQUEST));
  }

  const results = await Promise.all(
    slices.map((slice) => fetchQuoteSlice(slice, { apiKey, market, instrument }))
  );

  const rawItems = results.flatMap((r) => r.items || []);
  const errors = results.flatMap((r) => r.errors || []);
  // 新接口用 symbol 回传；按「请求了但没返回」计算缺失，等价于旧的 missing_codes
  const returned = new Set(rawItems.map((it) => normalizeSymbol(it.symbol || it.code)));
  const missing = symbols.filter((s) => !returned.has(s));

  return {
    requested: symbols.length,
    count: rawItems.length,
    missing_codes: missing,
    error_details: errors,
    items: full ? rawItems : rawItems.map(compactQuote),
  };
}

/** 单切片请求（POST /api/v3/market/quotes） */
async function fetchQuoteSlice(symbols, { apiKey, market, instrument }) {
  const body = {
    requests: symbols.map((symbol) => ({ symbol, market, instrument })),
  };

  const resp = await fetch(`${API_BASE}/api/v3/market/quotes`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store, no-cache',
    },
    body: JSON.stringify(body),
  });

  if (resp.status === 429) {
    // 保护性限流：遵守 Retry-After，只重试一次
    const retryAfter = resp.headers.get('Retry-After') || '5';
    await sleep(Number(retryAfter) * 1000);
    return fetchQuoteSlice(symbols, { apiKey, market, instrument });
  }
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
  }

  const data = await resp.json();
  return {
    items: data.items || [],
    errors: data.errors || [],
  };
}

/** 归一代码：去掉交易所后缀，统一大写（'600519.SH' → '600519'） */
function normalizeSymbol(code) {
  return String(code == null ? '' : code).trim().split('.')[0].toUpperCase();
}

/** 精简输出（保留核心行情字段，并把新契约字段名映射回既有内部口径） */
function compactQuote(item) {
  const previousClose = item.previous_close ?? item.last_close ?? null;
  // 服务端可能不返回 change：用 price - previous_close 兜底
  const change = item.change ?? (item.price != null && previousClose != null
    ? Number((item.price - previousClose).toFixed(4))
    : undefined);
  // 涨跌幅四舍五入到小数点后两位（如 -0.8307 → -0.83）
  const rawPct = item.change_pct ?? item.pct;
  const changePct = rawPct != null && Number.isFinite(Number(rawPct))
    ? Math.round(Number(rawPct) * 100) / 100
    : undefined;
  return {
    code: normalizeSymbol(item.symbol || item.code),
    name: item.name,
    price: item.price,                 // 最新价
    change: change,                    // 涨跌额（缺失时按 price - previous_close 计算）
    change_pct: changePct,             // 涨跌幅 %（四舍五入到 2 位）
    open: item.open,
    high: item.high,
    low: item.low,
    last_close: previousClose,         // 昨收（新契约为 previous_close）
    volume: item.volume,               // 成交量（股）
    amount: item.amount,               // 成交额（元）
    turnover_pct: item.turnover_pct,   // 换手率 %
    time: item.observed_at || item.received_at || item.quote_time || item.time,
    source: item.source,
    quote_status: item.quote_status,           // closed_session_reference 等：不可当盘中价使用
    price_basis: item.price_basis,
    is_stale: item.is_stale,
    age_seconds: item.age_seconds,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
