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
        const compact = String(raw).replace(/%20/gi, '').replace(/\s+/g, '');
        return new URL(compact).href;
    } catch {
        return null;
    }
}

// 股票名称清洗：移除名称中所有空白（普通/全角空格、Tab、换行等）。
// 股票名称不应含任何空白；trim 只能去首尾，页面文本里的中间空格（如「柳  工」）需整体去除
export function cleanStockName(name) {
    return String(name == null ? '' : name).replace(/\s+/g, '');
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

// 问财搜索页地址（wc1 选择器）：关键词为空返回 ''，由调用方回退存储 URL
export function iwencaiSearchUrl(keyword) {
    const k = String(keyword == null ? '' : keyword).trim();
    if (!k) return '';
    return `https://www.iwencai.com/screener/result?w=${encodeURIComponent(k)}&querytype=stock`;
}

// 基础股票名称：去掉交易所除权除息临时前缀 XD/XR/DR。
// 行情接口在除权除息当日会把名称存成「XD滨化股」这类形态（且可能已截短，无法靠还原得到
// 「滨化股份」），与用户输入/历史地址里的基础名不一致。问财搜索关键词与落库的搜索词
// 兜底匹配都按基础名归一，避免除权日当天搜不准、匹配不上
export function baseStockName(name) {
    return cleanStockName(name).replace(/^(?:XD|XR|DR)+/i, '');
}

// 搜索词兜底匹配的名字比较（background/landing.js 用）：
// 基础名相等即命中；不等时按包含关系兜底——数据源的名称列会截短，debug.txt 实案里
// 601678 被存成「XD滨化股」（本地代码表是「滨化股份」），严格比较整天失配；
// 但「滨化股」是「滨化股份」的子串。限制较短一方至少 3 个字，避免「平安」这类短词
// 把无关股票也匹进来（该路径仅在地址精确匹配失败后才走）
export function nameMatchesSearchWord(name, word) {
    const a = baseStockName(name);
    const b = baseStockName(word);
    if (!a || !b) return false;
    if (a === b) return true;
    const short = a.length <= b.length ? a : b;
    if (short.length < 3) return false;
    return a.includes(b) || b.includes(a);
}

// 问财搜索关键词：名称优先——问财页面跳转/规整后，落库靠「消息 URL 的搜索词 = 条目名称」
// 兜底匹配（background/landing.js searchWordOf），关键词须与条目名称同口径；
// 名称缺失时用 6 位代码（问财也认代码）
function iwencaiKeywordOf(stock) {
    const name = baseStockName(stock.name);
    if (name) return name;
    const code = String(stock.code || '').trim();
    return /^\d{6}$/.test(code) ? code : '';
}

// 是否「问财可查」的 A 股条目：港股（HK）不改写（问财结果页解析不支持港股），
// 无名称无代码的裸网址条目也无从改写，二者一律回退存储 URL
function isIwencaiQueryable(stock) {
    const prefix = String(stock.prefix || '').toUpperCase();
    if (prefix && prefix !== 'SH' && prefix !== 'SZ' && prefix !== 'BJ') return false;
    return !!iwencaiKeywordOf(stock);
}

// 按选择器决定生效刷新地址（「选择器说了算」）：
// ETF（159/51/58）不论选择器恒刷雪球个股页（问财不支持 ETF 查询）；
// 其余股票 xq1 且已知 prefix+code 时拼接雪球个股页（问财链接添加的也改刷雪球）；
// wc1（问财）且为 A 股条目时拼问财搜索页——存储 URL 可能是雪球个股页（自动模式按
// stockPageUrl 建条目），不换算就会出现「选择器=问财却打开雪球」；
// 均不满足（api 选择器、港股、无名称无代码的裸网址条目）则回退存储 URL
export function effectiveStockUrl(stock, selectorName) {
    if (!stock) return '';
    const etfPrefix = etfPrefixForCode(stock.code);
    if (etfPrefix) {
        return `https://xueqiu.com/S/${etfPrefix}${stock.code}`;
    }
    if (selectorName === 'xq1') {
        return (stock.prefix && stock.code) ? `https://xueqiu.com/S/${stock.prefix}${stock.code}` : stock.url;
    }
    if (selectorName === 'wc1' && isIwencaiQueryable(stock)) {
        const u = iwencaiSearchUrl(iwencaiKeywordOf(stock));
        if (u) return u;
    }
    return stock.url;
}

// 新增/导入条目时应写入 storage 的地址：与 effectiveStockUrl 同口径，保证
// 「存储 URL = 该组合未来的刷新目标」——两层对齐后刷新站点不会随选择器漂移；
// 换算不出（港股/无代码网址条目）时回退 fallbackUrl（雪球个股页）。
// item 传解析结果形状 { name, code, prefix }，selectorName 传目标组合自己的选择器
export function entryStockUrlFor(item, selectorName, fallbackUrl) {
    const stock = {
        name: item && item.name, code: item && item.code, prefix: item && item.prefix,
        url: fallbackUrl || '',
    };
    return effectiveStockUrl(stock, selectorName) || fallbackUrl || '';
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

// 规范化用于「等价性比较」的 URL（不改变存储/刷新用的原始地址）：
// 忽略 hostname 的 www. 前缀差异与问财签名参数 sign；雪球个股页 /S/ 的站内跟踪参数
// （如 from=status_stock_match）与行情内容无关，一并忽略。
// 用于插件调度生效地址 ↔ 页面实际加载后地址之间的匹配——雪球等站点可能把
// https://xueqiu.com/S/... 重定向/规整为 https://www.xueqiu.com/S/...，
// 纯字符串比较会失配导致标签页找不到（反复新开）与抓取落地匹配失败（数据不更新）。
// 解析失败回退原值。
export function normalizeCompareUrl(url) {
    if (!url) return url;
    try {
        const u = new URL(String(url));
        u.hostname = u.hostname.replace(/^www\./i, '');
        if (u.hostname === 'xueqiu.com' && /^\/S\//.test(u.pathname)) {
            u.search = ''; // 雪球 /S/ 页行情标识在 path 内，query 均为跟踪参数
        } else {
            u.searchParams.delete('sign');
        }
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