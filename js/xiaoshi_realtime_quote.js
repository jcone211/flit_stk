// 小石 API 批量行情（Chrome 扩展内使用的 ES module 版）
// 与 Node 脚本 js/quote_batch.js 同源逻辑，差异：
//   - ES module（import/export），供 background 直接调用
//   - apiKey 由调用方传入（扩展内存于 chrome.storage.sync 全局设置）
// 批量接口当前仅支持 A股（market=CN 默认）；港股/美股需单只接口，本模块暂不处理

const API_BASE = 'https://api.shizixi.com';
const MAX_CODES_PER_REQUEST = 100; // 服务端限制：单次最多 100 个

/**
 * 根据 codes 批量获取实时行情
 * @param {string[]} codes - 股票代码数组，如 ['600519','000001']
 * @param {object}   [opts]
 * @param {string}   opts.apiKey     - 必填：小石 API Key
 * @param {string}   [opts.market='CN']      - 市场: 'CN' | 'HK' | 'US'
 * @param {string}   [opts.instrument='stock'] - 类型: 'stock' | 'index' | 'etf'
 * @param {boolean}  [opts.full=false] - true 则返回原始完整字段
 * @returns {Promise<{requested:number, count:number, items:Array, missing_codes:string[]}>}
 */
export async function batchQuotes(codes, opts = {}) {
  const { apiKey, market = 'CN', instrument = 'stock', full = false } = opts;

  if (!apiKey) {
    throw new Error('apiKey 未配置');
  }
  if (!Array.isArray(codes) || codes.length === 0) {
    throw new Error('codes 必须是非空数组');
  }

  // 服务端限制单次 100 个，超长自动切片（并行请求）
  const slices = [];
  for (let i = 0; i < codes.length; i += MAX_CODES_PER_REQUEST) {
    slices.push(codes.slice(i, i + MAX_CODES_PER_REQUEST));
  }

  const results = await Promise.all(
    slices.map((slice) => fetchQuoteSlice(slice, { apiKey, market, instrument }))
  );

  const items = results.flatMap((r) => r.items || []);
  const missing = results.flatMap((r) => r.missing_codes || []);

  return {
    requested: codes.length,
    count: items.length,
    missing_codes: missing,
    items: full ? items : items.map(compactQuote),
  };
}

/** 单切片请求（GET /api/v3/data/quotes） */
async function fetchQuoteSlice(codes, { apiKey, market, instrument }) {
  const url =
    `${API_BASE}/api/v3/data/quotes?codes=${encodeURIComponent(codes.join(','))}` +
    (market && market !== 'CN' ? `&market=${market}` : '') +
    (instrument && instrument !== 'stock' ? `&instrument=${instrument}` : '');

  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Cache-Control': 'no-store, no-cache',
    },
  });

  if (resp.status === 429) {
    const retryAfter = resp.headers.get('Retry-After') || '5';
    await sleep(Number(retryAfter) * 1000);
    return fetchQuoteSlice(codes, { apiKey, market, instrument }); // 仅重试一次
  }
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
  }

  const data = await resp.json();
  return {
    items: data.items || [],
    missing_codes: data.missing_codes || [],
  };
}

/** 精简输出（去重名称、保留核心行情字段） */
function compactQuote(item) {
  // 服务端字段可能不稳定：change 有时缺失，用 price - last_close 兜底计算
  const change = item.change ?? (item.price != null && item.last_close != null
    ? Number((item.price - item.last_close).toFixed(4))
    : undefined);
  // 涨跌幅四舍五入到小数点后两位（如 -0.8307 → -0.83）
  const rawPct = item.change_pct ?? item.pct;
  const changePct = rawPct != null && Number.isFinite(Number(rawPct))
    ? Math.round(Number(rawPct) * 100) / 100
    : undefined;
  return {
    code: item.code,
    name: item.name,
    price: item.price,           // 最新价
    change: change,               // 涨跌额（缺失时按 price-last_close 计算）
    change_pct: changePct,        // 涨跌幅 %（四舍五入到 2 位）
    open: item.open,
    high: item.high,
    low: item.low,
    last_close: item.last_close,  // 昨收
    volume: item.volume,          // 成交量（股）
    amount: item.amount,          // 成交额（元）
    turnover_pct: item.turnover_pct, // 换手率 %
    time: item.quote_time || item.time,
    source: item.source,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
