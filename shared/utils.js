// 安全解码 URL（含非 ASCII 的百分号编码），失败回退原值
export function safeDecodeUrl(url) {
    if (!url) return '';
    try {
        return decodeURIComponent(url);
    } catch {
        return url;
    }
}

// 规范化 URL：new URL().href 自动百分号编码并统一格式，失败返回 null
export function normalizeUrl(raw) {
    if (!raw) return null;
    try {
        return new URL(raw).href;
    } catch {
        return null;
    }
}

// 计算导入以来涨跌幅(%)，任一价格缺失或基准价为 0 返回 null
export function calcImportPercent(currentPrice, importPrice) {
    const cur = numOrNull(currentPrice);
    const base = numOrNull(importPrice);
    if (cur === null || base === null || base === 0) return null;
    return Number(((cur - base) / base * 100).toFixed(2));
}

// 涨跌幅(%) → 目标价，基准价或涨跌幅无效返回 null
export function percentToTargetPrice(basePrice, percent) {
    const base = numOrNull(basePrice);
    const p = numOrNull(percent);
    if (base === null || p === null) return null;
    return Number((base * (1 + p / 100)).toFixed(2));
}

// 目标价 → 涨跌幅(%)，基准价缺失或为 0 返回 null
export function targetPriceToPercent(basePrice, targetPrice) {
    const base = numOrNull(basePrice);
    const price = numOrNull(targetPrice);
    if (base === null || base === 0 || price === null) return null;
    return Number(((price / base - 1) * 100).toFixed(2));
}

// 转数字，空值/NaN 返回 null
export function numOrNull(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

export function getDateTime() {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
}

export class Mutex {
    constructor() {
        this.locked = false;
        this.waiting = [];
    }
    async lock() {
        if (!this.locked) {
            this.locked = true;
            return;
        }
        return new Promise(resolve => this.waiting.push(resolve));
    }
    unlock() {
        if (this.waiting.length > 0) {
            const resolve = this.waiting.shift();
            resolve();
        } else {
            this.locked = false;
        }
    }
}

// ETF 代码 → 交易所前缀：159→深交所，51/58→上交所；非 ETF 返回 ''。
// 问财不支持 ETF 查询，故 ETF 不论选择器一律走雪球，前缀直接由代码推导
export function etfPrefixForCode(code) {
    const c = String(code || '');
    if (!/^\d{6}$/.test(c)) return '';
    if (c.startsWith('159')) return 'SZ';
    if (c.startsWith('51') || c.startsWith('58')) return 'SH';
    return '';
}

// 按选择器决定生效刷新地址：
// ETF（159/51/58）不论选择器恒刷雪球个股页；
// 其余股票 xq1 且已知 prefix+code 时拼接雪球个股页（问财链接添加的也改刷雪球）；
// 均不满足则回退存储 URL
export function effectiveStockUrl(stock, selectorName) {
    if (!stock) return '';
    const etfPrefix = etfPrefixForCode(stock.code);
    if (etfPrefix) {
        return `https://xueqiu.com/S/${etfPrefix}${stock.code}`;
    }
    if (selectorName === 'xq1' && stock.prefix && stock.code) {
        return `https://xueqiu.com/S/${stock.prefix}${stock.code}`;
    }
    return stock.url;
}

// 由 url 域名映射选择器键：问财→wc1，雪球→xq1，否则 null
export function selectorKeyForUrl(url) {
    if (!url) return null;
    try {
        const { hostname } = new URL(url);
        if (hostname === 'iwencai.com' || hostname.endsWith('.iwencai.com')) return 'wc1';
        if (hostname === 'xueqiu.com' || hostname.endsWith('.xueqiu.com')) return 'xq1';
    } catch {
        return null;
    }
}

// 去掉 url 中的 sign 参数（问财页面加载后会自动追加 &sign=时间戳）
export function stripSign(url) {
    if (!url) return url;
    try {
        const u = new URL(url);
        u.searchParams.delete('sign');
        return u.href;
    } catch {
        return url;
    }
}

// 最新刷新时间戳(ms) → MM.dd HH:mm（不带年，如 08.04 09:30 表示 8月4日），无效返回 ''
export function formatLastUpdate(ts) {
    const n = Number(ts);
    if (!Number.isFinite(n) || n <= 0) return '';
    const d = new Date(n);
    const p = x => String(x).padStart(2, '0');
    return `${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 时间戳(ms) → YYYY-MM-DD HH:mm，无效返回 '-'
export function formatDateTime(ts) {
    const n = Number(ts);
    if (!Number.isFinite(n) || n <= 0) return '-';
    const d = new Date(n);
    const p = x => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// wc1：从形如 001309.SZ / SZ001309 / 京东方A(000725.SZ) 的文本提取 code 与 prefix。
// 按「数字.前缀」或「前缀数字」邻接结构提取，避免把名称里的字母（京东方A 的 A）误当前缀；
// 无邻接结构时兜底只取代码，前缀须为已知交易所代号，否则留空待下次抓取回填
export function extractCodePrefixFromDot(text) {
    if (!text) return { code: '', prefix: '' };
    const m = text.match(/(\d{4,6})\s*[.．]\s*([A-Za-z]{2,4})|([A-Za-z]{2,4})\s*(\d{4,6})/);
    if (m) {
        return m[1]
            ? { code: m[1], prefix: m[2].toUpperCase() }
            : { code: m[4], prefix: m[3].toUpperCase() };
    }
    const code = (text.match(/\d+/) || [''])[0];
    const letter = (text.match(/[A-Za-z]+/) || [''])[0].toUpperCase();
    const prefix = isKnownMarketPrefix(letter) ? letter : '';
    return { code, prefix };
}

// 已知市场前缀白名单（深交所/上交所/北交所/港交所）
export function isKnownMarketPrefix(prefix) {
    return /^(SZ|SH|BJ|HK)$/.test(prefix || '');
}

// xq1：从形如 德明利(SZ:001309) 的文本提取 name/code/prefix，失败返回 null
export function parseXqStockName(text) {
    if (!text) return null;
    const m = text.match(/^\s*([^(（]+?)[(（]\s*([A-Za-z]+)\s*[:：]\s*(\d+)\s*[)）]/);
    if (!m) return null;
    return { name: m[1].trim(), prefix: m[2].toUpperCase(), code: m[3] };
}

// 清洗价格/涨跌幅文本中的货币符号、千分位逗号等，仅保留数字与正负号小数点
export function cleanNumberText(text) {
    if (text === null || text === undefined) return '';
    return String(text).replace(/[^\d.\-+]/g, '');
}