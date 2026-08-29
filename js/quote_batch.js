#!/usr/bin/env node
/**
 * quote_batch.js — 根据 codes 批量获取个股实时价格（小石 API）
 *
 * 用法（命令行）:
 *   node quote_batch.js "600519,000001,000858"
 *   node quote_batch.js "600519,000858" "SH,000001"   # 多组
 *
 * 注意:
 *   - 批量行情接口当前仅支持 A股（market=CN，默认）。
 *     港股/美股批量返回 503 "批量实时行情暂不可用"，请用单只统一接口：
 *     GET /api/v3/market/quote/{symbol}?market=HK|US&instrument=stock
 *   - 服务端返回字段可能不稳定（change 偶尔缺失），脚本会自动用 price-last_close 兜底。
 */

const API_BASE = 'https://api.shizixi.com';
const API_KEY = ''; // 本机完整 Key，需要在全局配置进行填写
const MAX_CODES_PER_REQUEST = 100; // 服务端限制：单次最多 100 个

/**
 * 根据 codes 批量获取实时行情
 * @param {string[]} codes  - 股票代码数组，如 ['600519','000001'] 或 ['00700','AAPL']
 * @param {object}   [opts] - 可选项
 * @param {string}   [opts.market='CN']  - 市场: 'CN' | 'HK' | 'US'
 * @param {string}   [opts.instrument='stock'] - 类型: 'stock' | 'index' | 'etf'
 * @param {boolean}  [opts.full=false]   - true 则返回原始完整字段（含五档盘口）
 * @returns {Promise<{count:number, items:Array, missing_codes:string[]}>}
 */
async function batchQuotes(codes, opts = {}) {
  const {
    market = 'CN',
    instrument = 'stock',
    full = false,
  } = opts;

  if (!Array.isArray(codes) || codes.length === 0) {
    throw new Error('codes 必须是非空数组');
  }

  // 服务端限制单次 100 个，超长自动切片（并行请求）
  const slices = [];
  for (let i = 0; i < codes.length; i += MAX_CODES_PER_REQUEST) {
    slices.push(codes.slice(i, i + MAX_CODES_PER_REQUEST));
  }

  const results = await Promise.all(
    slices.map((slice) => fetchQuoteSlice(slice, { market, instrument }))
  );

  // 合并各切片结果
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
async function fetchQuoteSlice(codes, { market, instrument }) {
  const url =
    `${API_BASE}/api/v3/data/quotes?codes=${encodeURIComponent(codes.join(','))}` +
    (market && market !== 'CN' ? `&market=${market}` : '');

  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Cache-Control': 'no-store, no-cache',
    },
  });

  if (resp.status === 429) {
    const retryAfter = resp.headers.get('Retry-After') || '5';
    await sleep(Number(retryAfter) * 1000);
    return fetchQuoteSlice(codes, { market, instrument }); // 仅重试一次
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
  return {
    code: item.code,
    name: item.name,
    price: item.price,           // 最新价
    change: change,               // 涨跌额（缺失时按 price-last_close 计算）
    change_pct: item.change_pct ?? item.pct, // 涨跌幅 %
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

/* ---------------- 命令行入口 ---------------- */
if (require.main === module) {
  const args = process.argv.slice(2);
  const marketArgIdx = args.findIndex((a) => a === '--market');
  const market = marketArgIdx >= 0 ? args[marketArgIdx + 1] : 'CN';

  const codes = args
    .filter((a) => !a.startsWith('--'))
    .flatMap((s) => s.split(','))
    .filter(Boolean);

  if (codes.length === 0) {
    console.error('用法: node quote_batch.js "600519,000001,000858" [--market CN|HK|US]');
    process.exit(1);
  }

  batchQuotes(codes, { market })
    .then((r) => {
      console.log(`请求 ${r.requested} 只，返回 ${r.count} 只`);
      if (r.missing_codes.length) {
        console.log(`未找到: ${r.missing_codes.join(', ')}`);
      }
      console.table(r.items);
    })
    .catch((e) => {
      console.error(`[ERROR] ${e.message}`);
      process.exit(1);
    });
}

module.exports = { batchQuotes };
