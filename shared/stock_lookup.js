// stock_lookup.js —— 股票名称 / 代码 → 标的解析（纯逻辑：无 DOM、无写入、只读本地代码表）
//
// 场景：用户在「一键导入」「添加股票」里输入的是名称，而免费行情接口（新浪/腾讯，
// 见 js/adata_realtime_quote.js）只认 6 位代码。本模块用随扩展打包的
// assets/stock_basic_cache.json（{ ts_code, name } 全量 A 股代码表，不含 ETF/基金）
// 把输入解析成「规范名称 + 6 位代码 + 交易所前缀」，从而能直接取行情，不必再打开
// 问财/雪球搜索页抓取（后者响应慢且偶发失败）。
//
// 解析口径（三档，刻意不做「反向包含」——否则「贵州茅台1」会被误判通过）：
//   1) 6 位代码：表内命中用表的 ts_code 前缀（含北交所 4/8/92 开头）；
//      未命中但属基金/ETF 代码段（15/16 深市、50/51/52/56/58 沪市）按规则推前缀——
//      本地表无基金条目，故 ETF/LOF 只能按代码导入，名称一律提示改用代码或雪球网址。
//   2) 名称精确命中（归一化后）→ 通过。
//   3) 表内名称「包含」输入词且唯一 → 通过（如「茅台」→ 贵州茅台）；多个 → ambiguous；
//      零个 → not_found。
//   输入整串含空格时不做拆分（「贵州茅台 中国稀土」即 not_found），避免误把多项当一只。
//
// 失败一律返回 { ok:false, reason }，文案由 resolveErrorText() 统一生成，调用方决定
// 弹窗提示还是回退原有页面方式；缓存不可用时返回 degrade=true，调用方必须回退页面
// 方式（不报错、不阻塞导入）。

import { cleanStockName, etfPrefixForCode } from './utils.js';

// 本地代码表路径（随扩展打包）
const CACHE_PATH = 'assets/stock_basic_cache.json';

// 基金/ETF 代码段 → 交易所前缀：15（含 159 ETF）/16（深市 LOF）→ 深交所，
// 50/51/52/56/58 → 上交所。与 js/adata_realtime_quote.js 的 EXCHANGE_SUFFIX 同口径，
// 保证「按代码解析」出的标的能被免费行情接口正确寻址。
const FUND_PREFIX_RULES = [
    [/^1[56]/, 'SZ'],
    [/^5[01268]/, 'SH'],
];

// 名称含这些字样即判定为 ETF/基金：本地代码表无基金条目，明确提示改用代码或雪球网址
const FUND_NAME_RE = /ETF|LOF|交易型开放式|指数基金/i;

const CODE_RE = /^\d{6}$/;

// 名称归一化：去全部空白 + 全角 ASCII 段转半角 + 英文小写（「贵 州 茅 台」=「贵州茅台」）
export function normalizeKey(value) {
    return cleanStockName(value)
        .replace(/[\uFF01-\uFF5E]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
        .toLowerCase();
}

// 基金/ETF 代码 → 交易所前缀（非基金返回 ''）：159/51/58 沿用 shared/utils.js 既有口径
function fundPrefixForCode(code) {
    const etf = etfPrefixForCode(code);
    if (etf) return etf;
    for (const [re, prefix] of FUND_PREFIX_RULES) if (re.test(code)) return prefix;
    return '';
}

// 代码表（{ts_code, name} 数组）→ 查询索引：名称精确表 + 代码表 + 名称前缀候选列表
export function buildStockIndex(rows) {
    const byName = new Map();
    const byCode = new Map();
    const names = [];
    for (const row of rows || []) {
        const tsCode = String((row && row.ts_code) || '').trim();
        const name = cleanStockName(row && row.name);
        if (!tsCode || !name) continue;
        const [code, suffix] = tsCode.split('.');
        if (!CODE_RE.test(code || '')) continue;
        const item = { name, code, prefix: String(suffix || '').toUpperCase(), tsCode };
        byName.set(normalizeKey(name), item);
        if (!byCode.has(code)) byCode.set(code, item);
        names.push({ key: normalizeKey(name), item });
    }
    return { byName, byCode, names, count: names.length };
}

// ---------------- 代码表加载（模块级只加载一次，失败即降级） ----------------

let indexPromise = null;

// 加载并索引本地代码表；失败返回 { ok:false, degrade:true }，调用方须回退页面方式
function ensureIndex() {
    if (!indexPromise) {
        indexPromise = (async () => {
            if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.getURL) {
                return { ok: false, error: '无扩展运行时，无法读取本地代码表', degrade: true };
            }
            try {
                const res = await fetch(chrome.runtime.getURL(CACHE_PATH));
                if (!res.ok) throw new Error('HTTP ' + res.status);
                const idx = buildStockIndex(await res.json());
                if (idx.count === 0) throw new Error('本地代码表为空');
                return { ok: true, index: idx, count: idx.count };
            } catch (err) {
                return { ok: false, error: (err && err.message) || String(err), degrade: true };
            }
        })();
    }
    return indexPromise;
}

// ---------------- 解析 ----------------

// 解析单个输入（同步核心；索引由调用方提供）：
//   { ok:true, name, code, prefix, tsCode, source:'code'|'code_fund'|'exact'|'fuzzy' }
//   { ok:false, reason:'empty'|'not_found'|'ambiguous'|'unsupported_etf', input, candidates?, hint? }
export function resolveFromIndex(index, input) {
    const clean = cleanStockName(input);
    if (!clean) return { ok: false, reason: 'empty', input: '' };
    // 1) 6 位代码直通：表内命中用表的 ts_code 前缀，未命中但属基金段按规则推前缀
    if (CODE_RE.test(clean)) {
        const hit = index.byCode.get(clean);
        if (hit) return { ok: true, name: hit.name, code: hit.code, prefix: hit.prefix, tsCode: hit.tsCode, source: 'code' };
        const prefix = fundPrefixForCode(clean);
        // 基金条目不在本地表：名称留空，交由首次行情落地回填（与首抓回填口径一致）
        if (prefix) return { ok: true, name: '', code: clean, prefix, tsCode: `${clean}.${prefix}`, source: 'code_fund' };
        return { ok: false, reason: 'not_found', input: clean, hint: '本地代码表中没有该代码' };
    }
    // 2) ETF/基金名称：本地代码表无基金条目，只能按代码或雪球网址导入
    if (FUND_NAME_RE.test(clean)) return { ok: false, reason: 'unsupported_etf', input: clean };
    // 3) 名称三档：精确 → 表内名称「包含」输入词且唯一 → 失败
    //    （刻意不做反向包含：否则「贵州茅台1」会因包含「贵州茅台」被误判通过）
    const key = normalizeKey(clean);
    const exact = index.byName.get(key);
    if (exact) return { ok: true, name: exact.name, code: exact.code, prefix: exact.prefix, tsCode: exact.tsCode, source: 'exact' };
    const hits = index.names.filter(n => n.key.includes(key));
    if (hits.length === 1) {
        const it = hits[0].item;
        return { ok: true, name: it.name, code: it.code, prefix: it.prefix, tsCode: it.tsCode, source: 'fuzzy' };
    }
    if (hits.length > 1) {
        return { ok: false, reason: 'ambiguous', input: clean, candidates: hits.map(h => h.item.name) };
    }
    return { ok: false, reason: 'not_found', input: clean };
}

// 批量解析（同步核心）：任一失败即整批失败（一键导入「整批中止、不处理其余项」语义）
export function resolveAllFromIndex(index, inputs) {
    const items = [];
    const errors = [];
    for (const raw of inputs || []) {
        const r = resolveFromIndex(index, raw);
        if (r.ok) items.push(r);
        else errors.push(r);
    }
    if (errors.length > 0) return { ok: false, errors, items: [] };
    return { ok: true, items };
}

// 单只解析（异步：必要时加载代码表）；代码表不可用 → reason='cache_unavailable' + degrade
export async function resolveStockName(input) {
    const loaded = await ensureIndex();
    if (!loaded.ok) return { ok: false, reason: 'cache_unavailable', input: cleanStockName(input), error: loaded.error, degrade: true };
    return resolveFromIndex(loaded.index, input);
}

// 批量解析（异步）。任一失败 → { ok:false, errors }；代码表不可用 → { ok:false, degrade:true }
// （调用方见到 degrade 必须回退原有页面方式，不报错、不阻塞）
export async function resolveStockNames(inputs) {
    const loaded = await ensureIndex();
    if (!loaded.ok) return { ok: false, reason: 'cache_unavailable', errors: [], error: loaded.error, degrade: true };
    return resolveAllFromIndex(loaded.index, inputs);
}

// 解析失败 → 统一用户可见文案（弹窗提示与 AI 工具返回共用一套口径）
export function resolveErrorText(r) {
    const input = (r && r.input) || '';
    const candidates = (r && r.candidates) || [];
    switch (r && r.reason) {
        case 'empty':
            return '请输入股票名称或 6 位代码';
        case 'ambiguous':
            return `「${input}」匹配到多只股票（${candidates.slice(0, 8).join('、')}${candidates.length > 8 ? ' 等' : ''}），请输入完整名称`;
        case 'unsupported_etf':
            return `「${input}」是 ETF/基金，本地代码表不含基金条目，请改用 6 位 ETF 代码（如 510300、159915）或雪球个股网址`;
        case 'cache_unavailable':
            return '本地股票代码表不可用，已回退为打开网页抓取';
        default:
            return `「${input}」有误，请重新输入`;
    }
}

// 解析结果 → 页面地址（雪球个股页）：自动模式建条目的存储 URL / 快速打开的跳转地址
export function stockPageUrl(item) {
    if (!item || !item.code) return '';
    const prefix = item.prefix || fundPrefixForCode(item.code);
    return prefix ? `https://xueqiu.com/S/${prefix}${item.code}` : '';
}

// 条目或解析结果数组 → 去重后的 6 位代码数组（批量行情接口入参）
export function codesOf(items) {
    const out = [];
    const seen = new Set();
    for (const it of items || []) {
        const c = String((it && (it.code || it)) || '').trim();
        if (!CODE_RE.test(c) || seen.has(c)) continue;
        seen.add(c);
        out.push(c);
    }
    return out;
}
