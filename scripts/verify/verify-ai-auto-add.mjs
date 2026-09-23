// verify-ai-auto-add.mjs —— AI「按名称添加股票」自动模式回归（本地代码表解析 + 按代码直取行情）
//
// 用途：对应「股票导入自动模式」计划步骤 7。verify-free-first.mjs 的浏览器桩里
//       chrome.runtime.getURL 打不开仓库资源（于是 H1~H4 走的是「降级回页面方式」分支），
//       本脚本专门把扩展内资源打通，验证自动模式的真实路径：
//         add_stock_to_portfolio → shared/stock_lookup.js 解析名称→代码 → background quoteCodes 直取行情
// 用法：node scripts/verify/verify-ai-auto-add.mjs
// 覆盖：A1 名称批量（带 code/prefix/雪球个股页地址，且 0 次页面打开）
//       A2 ETF 按 6 位代码；A3 名称解析不到（不建条目）；A4 多候选；A5 混合 ETF 名称剔除
//       A6 refresh_via_page=true 强制页面方式；A7 行情取不到时代码回退打开页面
//       A8 传入 import_price 时行情落地不覆盖初始价
// 说明：fetch 只放行 file://（扩展内资源映射到仓库文件），其余一律拒绝 → 0 次外呼。
//       代码表「读取失败 → 回退页面方式」的降级分支不在此脚本覆盖：
//       本脚本把扩展内资源打通，而 verify-free-first.mjs 的桩打不开该资源（H1~H4 即
//       degrade 回退路径），verify-stock-lookup.mjs 覆盖 resolveStockNames 的 degrade 返回值。

import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------- 浏览器环境桩
const el = () => ({
    style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    children: [], value: '', textContent: '', innerHTML: '', checked: false,
    addEventListener() {}, removeEventListener() {}, appendChild() {}, removeChild() {}, remove() {},
    setAttribute() {}, getAttribute: () => null, focus() {}, blur() {}, click() {}, select() {},
    querySelector: () => el(), querySelectorAll: () => [], insertAdjacentHTML() {}, closest: () => null,
    getBoundingClientRect: () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }),
});
globalThis.document = {
    getElementById: () => el(), querySelector: () => el(), querySelectorAll: () => [],
    createElement: () => el(), createTextNode: () => el(), addEventListener() {}, removeEventListener() {},
    body: el(), head: el(), documentElement: el(), hidden: false, visibilityState: 'visible',
    activeElement: el(), execCommand: () => false,
};
globalThis.window = globalThis;
globalThis.self = globalThis;
if (!globalThis.navigator) {
    globalThis.navigator = { userAgent: 'node-verify', clipboard: { writeText: async () => {} } };
}
globalThis.addEventListener = () => {};
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };

// 内存 storage（get 支持回调与 await 两种风格，与 ai_state.storageGet 一致）
const store = {
    local: { stockList: [], portfolios: {}, activePortfolio: '持仓', currentView: 'list' },
    sync: { apiKey: '', dataSource: 'adata', selectorName: 'xq1', aiDebugMode: false },
    session: {},
};
const storageArea = (name) => ({
    async get(keys, cb) {
        const list = Array.isArray(keys) ? keys : (typeof keys === 'string' ? [keys] : Object.keys(store[name]));
        const out = {};
        for (const k of list) if (k in store[name]) out[k] = structuredClone(store[name][k]);
        if (typeof cb === 'function') { cb(out); return; }
        return out;
    },
    async set(obj, cb) { Object.assign(store[name], structuredClone(obj)); if (cb) cb(); },
    async remove(keys, cb) { for (const k of (Array.isArray(keys) ? keys : [keys])) delete store[name][k]; if (cb) cb(); },
    async clear(cb) { store[name] = {}; if (cb) cb(); },
    onChanged: { addListener() {}, removeListener() {} },
});

// ---------------------------------------------------------------- quoteCodes 桩：模拟 background 直取 + 落地
const QUOTES = {
    '600519': { name: '贵州茅台', price: 1500.5, change_pct: 1.2 },
    '000831': { name: '中国稀土', price: 32.1, change_pct: -0.6 },
    '159915': { name: '易方达创业板ETF', price: 2.31, change_pct: 0.4 },
};
let quoteMode = 'ok';       // 'ok' 命中上表；'fail' 全部未取到（模拟免费接口/网络不可用）
const quotedCodes = [];     // 本次被请求取数的代码
const refreshOneUrls = [];  // 被要求打开页面抓取的地址（自动模式全成功时应为空）
let fetchCalls = 0;

function landQuotes(codes) {
    if (quoteMode === 'fail') return { ok: false, requested: codes.length, received: 0, landed: false, missing: codes };
    const landed = [];
    const missing = [];
    codes.forEach((c) => { if (QUOTES[c]) landed.push(c); else missing.push(c); });
    // 模拟 background/landing.js：按 code 匹配 → 回填名称/现价（含「初始价首次回填」语义）
    const lists = [store.local.stockList, ...Object.values(store.local.portfolios || {}).map(p => p.stockList)];
    lists.forEach(l => (l || []).forEach(s => {
        const q = QUOTES[String(s.code || '')];
        if (!q) return;
        s.name = q.name;
        s.currentPrice = q.price;
        s.percent = q.change_pct;
        if (s.importPrice == null) s.importPrice = q.price;
    }));
    return { ok: landed.length > 0, requested: codes.length, received: landed.length, landed: landed.length > 0, missing };
}

globalThis.fetch = async (input) => {
    fetchCalls++;
    const url = String(typeof input === 'string' ? input : (input && input.url) || input);
    if (!url.startsWith('file://')) throw new Error('verify 只允许读取扩展内资源，拒绝外呼：' + url);
    const file = new URL(url);
    return {
        ok: true, status: 200,
        arrayBuffer: async () => fsSync.readFileSync(file),
        json: async () => JSON.parse(fsSync.readFileSync(file, 'utf8')),
        text: async () => fsSync.readFileSync(file, 'utf8'),
    };
};

globalThis.chrome = {
    storage: {
        local: storageArea('local'), sync: storageArea('sync'), session: storageArea('session'),
        managed: storageArea('session'), onChanged: { addListener() {}, removeListener() {} },
    },
    runtime: {
        id: 'verify-script',
        // 扩展内资源 → 仓库真实文件（自动模式的代码表就是这么读的）
        getURL: (p) => pathToFileURL(path.join(REPO, p)).href,
        lastError: null,
        sendMessage: async (msg, cb) => {
            let resp = { status: 'ok' };
            if (msg && msg.action === 'quoteCodes') {
                const codes = (msg.codes || []).map(String);
                quotedCodes.push(...codes);
                resp = landQuotes(codes);
            } else if (msg && msg.action === 'refreshOne') {
                refreshOneUrls.push(msg.url);
            }
            if (typeof cb === 'function') { cb(resp); return resp; }
            return resp;
        },
        connect: () => ({ name: '', onMessage: { addListener() {}, removeListener() {} }, onDisconnect: { addListener() {}, removeListener() {} }, postMessage() {} }),
        getManifest: () => ({ version: 'verify' }),
    },
    alarms: { create() {}, clear() {}, clearAll: async () => true, onAlarm: { addListener() {} } },
    tabs: { query: async () => [], create: async () => ({}), update: async () => ({}), remove: async () => {}, onUpdated: { addListener() {} }, onRemoved: { addListener() {} } },
    windows: { create: async () => ({}), get: async () => ({}), update: async () => ({}), onRemoved: { addListener() {} } },
    notifications: { create() {}, clear() {}, onClicked: { addListener() {} } },
    action: { onClicked: { addListener() {} } }, scripting: { executeScript: async () => [] },
};

// ---------------------------------------------------------------- 用例框架
const { toolExecutors } = await import('../../ai/core/ai_tools.js');

let pass = 0;
const failures = [];
function check(caseName, label, ok, detail) {
    if (ok) pass++;
    else failures.push(label);
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  [${caseName}] ${label}${detail !== undefined && detail !== '' ? ' → ' + detail : ''}`);
}
const brief = (o) => { const s = JSON.stringify(o); return s && s.length > 500 ? s.slice(0, 500) + '…' : s; };
async function run(caseName, fn) {
    console.log(`\n=== ${caseName} ===`);
    try { await fn(); } catch (e) { check(caseName, '执行不抛异常', false, e && (e.stack || e.message) || String(e)); }
}
function reset() {
    store.local.portfolios = { 持仓: { selectorName: 'wc1', stockList: [] } };
    store.local.stockList = store.local.portfolios.持仓.stockList;
    store.local.activePortfolio = '持仓';
    quoteMode = 'ok';
    quotedCodes.length = 0;
    refreshOneUrls.length = 0;
    delete store.sync.autoResolveStock; // 设置项回到默认（默认开启自动模式）
}
const list = () => store.local.portfolios.持仓.stockList;

// ---------------------------------------------------------------- A1 名称批量（自动模式）
await run('A1 普通股票名称 → 本地解析代码 + 直取行情落地（0 次页面打开）', async () => {
    reset();
    const r = await toolExecutors.add_stock_to_portfolio({ names: ['贵州茅台', '中国稀土'] });
    check('A1', '返回 ok', r.ok === true, brief(r.error));
    check('A1', '两只都落库', list().length === 2, brief(list()));
    const [a, b] = list();
    check('A1', '贵州茅台 → 600519.SH', !!a && a.code === '600519' && a.prefix === 'SH', brief(a));
    check('A1', '中国稀土 → 000831.SZ', !!b && b.code === '000831' && b.prefix === 'SZ', brief(b));
    check('A1', '存储 URL 用雪球个股页', !!a && a.url === 'https://xueqiu.com/S/SH600519' && !!b && b.url === 'https://xueqiu.com/S/SZ000831',
        brief([a && a.url, b && b.url]));
    check('A1', '按代码向 background 取行情（quoteCodes）', quotedCodes.join(',') === '600519,000831', quotedCodes.join(','));
    check('A1', '现价/涨跌幅已落地', !!a && a.currentPrice === 1500.5 && a.percent === 1.2 && !!b && b.currentPrice === 32.1, brief([a, b]));
    check('A1', '未传初始价 → 首次行情回填 importPrice', !!a && a.importPrice === 1500.5, a && a.importPrice);
    check('A1', '未打开任何页面', refreshOneUrls.length === 0, brief(refreshOneUrls));
    check('A1', 'hint 说明行情已直接取回', /未打开页面/.test(r.hint || ''), r.hint);
});

// ---------------------------------------------------------------- A2 ETF 按 6 位代码
await run('A2 ETF 按 6 位代码（本地表无基金条目 → 规则推前缀）', async () => {
    reset();
    const r = await toolExecutors.add_stock_to_portfolio({ names: ['159915'] });
    const s = list()[0];
    check('A2', '返回 ok', r.ok === true, brief(r.error));
    check('A2', '落库 159915 且前缀 SZ', !!s && s.code === '159915' && s.prefix === 'SZ', brief(s));
    check('A2', 'URL 为雪球 ETF 个股页', !!s && s.url === 'https://xueqiu.com/S/SZ159915', s && s.url);
    check('A2', '名称由行情接口规范名覆盖', !!s && s.name === '易方达创业板ETF', s && s.name);
    check('A2', '取行情但未打开页面', quotedCodes.join(',') === '159915' && refreshOneUrls.length === 0, brief([quotedCodes, refreshOneUrls]));
});

// ---------------------------------------------------------------- A3 名称解析不到
await run('A3 名称解析不到 → 不建条目、不取行情、不开页面', async () => {
    reset();
    const r = await toolExecutors.add_stock_to_portfolio({ names: ['美国稀土'] });
    check('A3', '返回可解释错误', !!r.error && !r.ok, brief(r));
    check('A3', '错误文案含输入词', /美国稀土/.test(r.error || ''), r.error);
    check('A3', 'unresolved 列明原因', Array.isArray(r.unresolved) && r.unresolved.length === 1 && r.unresolved[0].name === '美国稀土', brief(r.unresolved));
    check('A3', '未建任何条目', list().length === 0, brief(list()));
    check('A3', '未取行情、未开页面', quotedCodes.length === 0 && refreshOneUrls.length === 0, brief([quotedCodes, refreshOneUrls]));
});

// ---------------------------------------------------------------- A4 多候选
await run('A4 多候选名称 → 提示候选、不猜代码', async () => {
    reset();
    const r = await toolExecutors.add_stock_to_portfolio({ names: ['稀土'] });
    check('A4', '返回错误', !!r.error && !r.ok, brief(r));
    check('A4', '提示匹配到多只并列出候选', /多只股票/.test(r.error || '') && /北方稀土/.test(r.error || ''), r.error);
    check('A4', '未建条目', list().length === 0, brief(list()));
    check('A4', '未取行情', quotedCodes.length === 0, brief(quotedCodes));
});

// ---------------------------------------------------------------- A5 混合批次（ETF 名称剔除）
await run('A5 混合批次：ETF 名称剔除，普通股票照常自动导入', async () => {
    reset();
    const r = await toolExecutors.add_stock_to_portfolio({ names: ['贵州茅台', '沪深300ETF'] });
    check('A5', '返回 ok（不因 ETF 整批失败）', r.ok === true, brief(r));
    check('A5', 'ETF 计入 excluded', Array.isArray(r.excluded) && r.excluded.includes('沪深300ETF'), brief(r.excluded));
    check('A5', '只落库 1 只（贵州茅台）', list().length === 1 && list()[0].code === '600519', brief(list()));
    check('A5', 'hint 说明 ETF 已排除', /ETF 已排除/.test(r.hint || ''), r.hint);
    check('A5', '未打开页面', refreshOneUrls.length === 0, brief(refreshOneUrls));
});

// ---------------------------------------------------------------- A6 强制页面方式
await run('A6 refresh_via_page=true → 沿用页面方式（不读代码表、不按代码取行情）', async () => {
    reset();
    const r = await toolExecutors.add_stock_to_portfolio({ names: ['贵州茅台'], refresh_via_page: true });
    check('A6', '返回 ok', r.ok === true, brief(r.error));
    const s = list()[0];
    check('A6', '条目为问财搜索页且未解析代码', !!s && /^https:\/\/www\.iwencai\.com\//.test(s.url || '') && !s.code, brief(s));
    check('A6', '未按代码取行情', quotedCodes.length === 0, brief(quotedCodes));
    await sleep(2600); // 页面打开带 1.5~2.2s 延迟抖动
    check('A6', '已安排打开页面抓取', refreshOneUrls.length === 1 && refreshOneUrls[0] === s.url, brief(refreshOneUrls));
});

// ---------------------------------------------------------------- A7 行情取不到 → 回退页面
await run('A7 免费行情不可用 → 条目保留 + 回退打开页面', async () => {
    reset();
    quoteMode = 'fail';
    const r = await toolExecutors.add_stock_to_portfolio({ names: ['贵州茅台'] });
    check('A7', '仍返回 ok（不丢数据）', r.ok === true, brief(r));
    const s = list()[0];
    check('A7', '已解析代码并落库', !!s && s.code === '600519', brief(s));
    check('A7', 'hint 说明将打开页面抓取', /将打开页面抓取/.test(r.hint || ''), r.hint);
    await sleep(2600);
    check('A7', '按雪球个股页地址回退抓取', refreshOneUrls.length === 1 && refreshOneUrls[0] === 'https://xueqiu.com/S/SH600519', brief(refreshOneUrls));
});

// ---------------------------------------------------------------- A8 传入初始价
await run('A8 传入 import_price 时行情落地不覆盖初始价', async () => {
    reset();
    const r = await toolExecutors.add_stock_to_portfolio({ names: ['贵州茅台'], import_price: 1400 });
    const s = list()[0];
    check('A8', '返回 ok', r.ok === true, brief(r.error));
    check('A8', '初始价保留 1400', !!s && s.importPrice === 1400, s && s.importPrice);
    check('A8', '现价仍按行情更新', !!s && s.currentPrice === 1500.5, s && s.currentPrice);
});

// ---------------------------------------------------------------- 汇总
console.log(`\n结果：通过 ${pass} 项${failures.length ? `，失败 ${failures.length} 项` : '，全部通过'}`);
console.log(`扩展内资源读取 ${fetchCalls} 次（全部为 file://，无任何外呼）`);
if (failures.length) {
    failures.forEach(f => console.log('  - ' + f));
    process.exit(1);
}
