// xiaoshi_stock_kline.js —— 小石量化 API 封装（AI 窗口页面模块，纯 fetch，无依赖）。
// 把「从小石拉取股票数据」的能力直接封装成 JS 供模型工具调用，
// 不依赖任何外部 skill/CLI（浏览器扩展无法执行命令行工作流）。
//
// 稳定性处理（小石服务器可能不稳定）：
//   - 每次请求带超时（AbortController），默认 20s
//   - 网络错误 / 5xx / 超时：指数退避重试（默认最多 2 次）
//   - 429：按 Retry-After 退避后重试一次（RateLimitExceeded 语义，服务端主动保护）
//   - 请求头带 Cache-Control: no-store, no-cache（避免取到缓存快照）
//   - 接口变动/Key 失效时抛出可操作错误，由工具执行器转述给模型

const XIAOSHI_BASE = 'https://api.shizixi.com/api/v3';
const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_MAX_RETRIES = 2;
// 兜底 Key：优先读 chrome.storage.sync 的 apiKey（全局设置「数据获取方式-小石大数据」），
// 未配置时回退到此默认值，保证「缓存缺最新数据自动补齐」直接可用。
const DEFAULT_XIAOSHI_API_KEY = 'xs_live_sEdZZR_9fYq4dWJB5LQgZGG6G3BtF6awLyJhPL1zCow';

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// 统一请求入口：path 以 /api/v3 之后的部分（如 '/data/search'），params 拼为查询串。
// 返回解析后的 JSON；失败抛出带中文说明的 Error。
export async function xiaoshiFetch(path, { apiKey, params = {}, timeoutMs = DEFAULT_TIMEOUT_MS, maxRetries = DEFAULT_MAX_RETRIES } = {}) {
    const key = apiKey || DEFAULT_XIAOSHI_API_KEY;
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null && v !== '') qs.set(k, v);
    }
    const q = qs.toString();
    const url = XIAOSHI_BASE + path + (q ? '?' + q : '');
    const headers = {
        Authorization: 'Bearer ' + key,
        'Cache-Control': 'no-store, no-cache',
    };

    let attempt = 0;
    for (;;) {
        attempt++;
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        let resp;
        try {
            resp = await fetch(url, { headers, signal: ctrl.signal });
        } catch (err) {
            clearTimeout(timer);
            const msg = err && err.name === 'AbortError' ? '请求超时（' + timeoutMs + 'ms）' : '网络错误：' + (err && err.message || err);
            if (attempt <= maxRetries) {
                await sleep(400 * attempt); // 指数退避
                continue;
            }
            throw new Error('小石 API ' + msg + '，服务器可能不稳定，可稍后重试');
        }
        clearTimeout(timer);

        if (resp.status === 429) {
            const retryAfter = Number((resp.headers.get('Retry-After') || '3')) * 1000 || 3000;
            if (attempt <= maxRetries) {
                await sleep(retryAfter);
                continue;
            }
            throw new Error('小石 API 触发限流（429），请稍后再试');
        }
        if (!resp.ok) {
            let detail = '';
            try { detail = (await resp.text()).slice(0, 200); } catch { /* ignore */ }
            throw new Error('小石 API HTTP ' + resp.status + (detail ? '：' + detail : '') + '（检查 API Key 是否有效）');
        }
        return resp.json();
    }
}

// 按名称/代码搜索股票，返回 [{ code, symbol, name, market, exchange, ... }]
export async function xiaoshiSearchStock(q, opts = {}) {
    const data = await xiaoshiFetch('/data/search', { ...opts, params: { q, limit: 10 } });
    return data.items || [];
}

// 日线 K 线（period=daily, adjust=qfq），返回近 limit 天 [{ date, open, high, low, close, volume, amount, ... }]
// code 传 6 位数字（如 001309）或带后缀（001309.SZ）；接口内部只用数字部分
export async function xiaoshiDailyKline(code, { limit = 250, since, to, apiKey, timeoutMs, maxRetries } = {}) {
    const symbol = String(code).split('.')[0];
    const params = { period: 'daily', adjust: 'qfq', limit };
    if (since) params.since = since;
    if (to) params.to = to;
    const data = await xiaoshiFetch('/data/kline/' + symbol, { apiKey, params, timeoutMs, maxRetries });
    const bars = data.bars || data.data || [];
    return bars.map(b => ({
        date: String(b.date || '').slice(0, 10),
        open: b.open ?? null,
        high: b.high ?? null,
        low: b.low ?? null,
        close: b.close ?? null,
        volume: b.volume ?? null,
        amount: b.amount ?? null,
        change_pct: b.change_pct ?? null,
        turnover_pct: b.turnover_pct ?? null,
    }));
}

// 实时行情（market-quote-v1）：返回 { symbol, name, price, change, change_pct, open, high, low,
// volume, amount, turnover_pct, time(observed_at), source, cache_status, is_stale, age_seconds }
export async function xiaoshiQuote(code, { market = 'CN', instrument = 'stock', apiKey, timeoutMs, maxRetries } = {}) {
    const symbol = String(code).split('.')[0];
    const data = await xiaoshiFetch('/market/quote/' + symbol, { apiKey, params: { market, instrument }, timeoutMs, maxRetries });
    return {
        code: symbol,
        name: data.name || null,
        price: data.price ?? null,
        change: data.change ?? null,
        change_pct: data.change_pct ?? null,
        open: data.open ?? null,
        high: data.high ?? null,
        low: data.low ?? null,
        previous_close: data.previous_close ?? null,
        volume: data.volume ?? null,
        amount: data.amount ?? null,
        turnover_pct: data.turnover_pct ?? null,
        amplitude_pct: data.amplitude_pct ?? null,
        time: data.observed_at || data.received_at || null,
        source: data.source || null,
        cache_status: data.cache_status || null,
        is_stale: data.is_stale ?? null,
        age_seconds: data.age_seconds ?? null,
    };
}
