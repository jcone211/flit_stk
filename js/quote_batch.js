#!/usr/bin/env node
/**
 * quote_batch.js - 根据 codes 批量获取个股实时价格（小石 API）
 *
 * 用法（命令行）:
 *   node quote_batch.js "600519,000001,000858"
 *   node quote_batch.js "600519,000858" --market CN
 *   node quote_batch.js "00700,09988" --market HK
 *
 * 【契约变更 2026-09-16】小石公开 Agent 契约（xiaoshi-agent-contract/v1）已下线
 * GET /api/v3/data/quotes。批量行情改为 POST /api/v3/market/quotes，
 * body = { requests: [{ symbol, market, instrument }] }，单次 1-100 只
 * （超过返回 400「requests must contain 1-100 instruments」）。旧路径固定返回
 * 404 operation_not_in_public_contract，属契约退役，不要回退或轮询单只接口。
 * 新接口按标的隔离失败（脏代码进 errors[]），且批量现支持 CN/HK/US。
 *
 * Key 来源（按优先级）：process.env.XIAOSHI_API_KEY -> 下面 API_KEY 常量。
 * 建议用环境变量，避免把完整 Key 写进命令历史或版本库。
 */

const API_BASE = 'https://api.shizixi.com';
const API_KEY = ''; // 本机完整 Key 可在此填写；更推荐 XIAOSHI_API_KEY 环境变量
const MAX_CODES_PER_REQUEST = 100; // 服务端限制：单次最多 100 只

function resolveApiKey() {
  return String((process.env && process.env.XIAOSHI_API_KEY) || API_KEY || '').trim();
}

/**
 * 根据 codes 批量获取实时行情
 * @param {string[]} codes  - 股票代码数组，如 ['600519','000001'] 或 ['00700','AAPL']
 * @param {object}   [opts] - 可选项
 * @param {string}   [opts.apiKey]  - 覆盖默认 Key 解析
 * @param {string}   [opts.market='CN']  - 市场: 'CN' | 'HK' | 'US'
 * @param {string}   [opts.instrument='stock'] - 类型: 'stock' | 'index' | 'etf'
 * @param {boolean}  [opts.full=false]   - true 则返回原始完整字段
 * @returns {Promise<{requested:number, count:number, items:Array, missing_codes:string[], error_details:Array}>}
 */
async function batchQuotes(codes, opts = {}) {
  const { market = 'CN', instrument = 'stock', full = false } = opts;
  const apiKey = String(opts.apiKey || resolveApiKey()).trim();

  if (!apiKey) {
    throw new Error('缺少小石 API Key：请设置 XIAOSHI_API_KEY 环境变量，或在脚本顶部 API_KEY 中填写');
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
  const resp = await fetch(`${API_BASE}/api/v3/market/quotes`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store, no-cache',
    },
    body: JSON.stringify({ requests: symbols.map((symbol) => ({ symbol, market, instrument })) }),
  });

  if (resp.status === 429) {
    const retryAfter = resp.headers.get('Retry-After') || '5';
    await sleep(Number(retryAfter) * 1000);
    return fetchQuoteSlice(symbols, { apiKey, market, instrument }); // 仅重试一次
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

/** 归一代码：去掉交易所后缀，统一大写（'600519.SH' -> '600519'） */
function normalizeSymbol(code) {
  return String(code == null ? '' : code).trim().split('.')[0].toUpperCase();
}

/** 精简输出（保留核心行情字段，并把新契约字段名映射回既有口径） */
function compactQuote(item) {
  const previousClose = item.previous_close ?? item.last_close ?? null;
  const change = item.change ?? (item.price != null && previousClose != null
    ? Number((item.price - previousClose).toFixed(4))
    : undefined);
  const rawPct = item.change_pct ?? item.pct;
  const changePct = rawPct != null && Number.isFinite(Number(rawPct))
    ? Math.round(Number(rawPct) * 100) / 100
    : undefined;
  return {
    code: normalizeSymbol(item.symbol || item.code),
    name: item.name,
    price: item.price,           // 最新价
    change: change,               // 涨跌额（缺失时按 price - previous_close 计算）
    change_pct: changePct,        // 涨跌幅 %（四舍五入到 2 位）
    open: item.open,
    high: item.high,
    low: item.low,
    last_close: previousClose,    // 昨收（新契约为 previous_close）
    volume: item.volume,          // 成交量（股）
    amount: item.amount,          // 成交额（元）
    turnover_pct: item.turnover_pct, // 换手率 %
    time: item.observed_at || item.received_at || item.quote_time || item.time,
    source: item.source,
    quote_status: item.quote_status,
    price_basis: item.price_basis,
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
    .map((s) => s.trim())
    .filter((s) => s && !/^[A-Z]{2,3}$/.test(s)); // 去掉紧跟在 --market 后的取值

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
