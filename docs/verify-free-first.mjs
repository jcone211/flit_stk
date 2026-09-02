// verify-free-first.mjs —— 「本地数据库 → 免费公开渠道 → 小石」取数链路回归（一次性跑完全部用例）
//
// 用途：对应 docs/plan-K线取数改本地数据库.md 的 P0-1。在 Node 里用假 chrome/document +
//       假 File System Access handle 直接驱动 ai/core/ai_tools.js 的工具执行器；K 线的「库」
//       由 docs/mock-bridge.mjs 造假（照 flit_bridge 的真实响应形状），从而能确定性地构造
//       「库里缺 3 根 / 缺 30 根 / config 为空 / 桥接未启用 / 表名没登记」这些分支——
//       这些靠用户真库是测不出来的，也不该拿真库当测试床反复打。
// 用法：
//   node docs/verify-free-first.mjs                       # 全量：时段口径 + 假桥接库用例 + 真实实时/免费用例
//   node docs/verify-free-first.mjs --offline-cases       # 只跑不打网络、不起桥接的时钟/缺口口径用例
//   node docs/verify-free-first.mjs --only=D4             # 单跑某条（C*/D*/E* 前缀均可）
//   node docs/verify-free-first.mjs --bridge=real         # 追加真实桥接用例（先 node flit_bridge/server.js）
//   node docs/verify-free-first.mjs --root "D:/path/ws"   # 真实桥接模式的工作目录（含 flit/config.json）
// 说明：
//   - D*（假桥接）用例不打任何外部接口，除标注「免费补齐/小石兜底」的四条（合计约 4 次外呼）；
//   - C*（真实行情）用例覆盖新浪+腾讯→小石批量→小石单只，靠拦截 fetch 模拟渠道失效，不额外耗额度；
//   - 小石相关调用请合并进一次运行，别为了看日志反复跑（额度低、东财/腾讯会限流）；
//   - 脚本只在 REPO/.verify-workspaces/ 下写临时工作目录（含假 flit/config.json），跑完删除。

import fsSync from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { startMockBridge, SCHEMA_FULL, dailySource, minusWeekdays } from './mock-bridge.mjs';

const REPO = path.resolve(import.meta.dirname, '..');
const ARGS = process.argv.slice(2);
const argOf = (name, dflt) => {
    const i = ARGS.indexOf('--' + name);
    return i >= 0 && ARGS[i + 1] && !ARGS[i + 1].startsWith('--') ? ARGS[i + 1] : dflt;
};
const hasFlag = (name) => ARGS.includes('--' + name);
const OFFLINE_ONLY = hasFlag('offline-cases');
const REAL_BRIDGE = hasFlag('bridge=real') || hasFlag('real');
const ONLY = (ARGS.find(a => a.startsWith('--only=')) || '').split('=')[1] || '';
// 真实桥接模式下的工作目录（里面有用户自己的 flit/config.json）
const WORKSPACE_ROOT = path.resolve(argOf('root', 'D:/sundry/7-ai/agents/stock-assistant'));
const BRIDGE_REAL_URL = argOf('bridge-url', 'http://127.0.0.1:17321');

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
// Node 24 自带 navigator（只读 getter），只在缺失时补一个
if (!globalThis.navigator) {
    globalThis.navigator = { userAgent: 'node-verify', clipboard: { writeText: async () => {} } };
}
globalThis.addEventListener = () => {};
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };

// chrome.storage：内存版（get(keys, cb) 回调风格，与 ai_state.storageGet 一致）
const store = {
    local: {
        // 验证用的最小列表：个股 + ETF 各一只，另留一只无代码项（走「尚未获取到代码」分支）
        // 注意：故意不放「贵州茅台」，D11 要用它验证名称→代码走本地库而非小石搜索
        stockList: [
            { name: '德明利', code: '001309', prefix: 'SZ', url: 'https://example.invalid/001309' },
            { name: '有研新材', code: '600206', prefix: 'SH', url: 'https://example.invalid/600206' },
            { name: '证券ETF', code: '512880', prefix: 'SH', url: 'https://example.invalid/512880' },
            { name: '待抓取股票', code: '', prefix: '', url: 'https://example.invalid/none' },
        ],
        portfolios: {}, currentView: 'list',
    },
    sync: {
        // 留空 => 小石模块回退到代码内置兜底 Key（验证兜底链是否真的可用）
        apiKey: '', dataSource: 'adata', selectorName: 'xq1', refreshInterval: 60,
        aiDebugMode: false, aiProviders: [], aiProvider: '', aiBaseUrl: '', aiModel: '',
    },
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
    getBytesInUse(cb) { if (cb) cb(0); },
});
globalThis.chrome = {
    storage: {
        local: storageArea('local'), sync: storageArea('sync'), session: storageArea('session'),
        managed: storageArea('session'), onChanged: { addListener() {}, removeListener() {} },
    },
    runtime: {
        id: 'verify-script', getURL: (p) => 'chrome-extension://verify/' + p, lastError: null,
        sendMessage: async () => {}, connect: () => ({ name: '', onMessage: { addListener() {}, removeListener() {} }, onDisconnect: { addListener() {}, removeListener() {} }, postMessage() {} }),
        getManifest: () => ({ version: 'verify' }),
    },
    alarms: { create() {}, clear() {}, clearAll: async () => true, onAlarm: { addListener() {} } },
    tabs: { query: async () => [], create: async () => ({}), update: async () => ({}), remove: async () => {}, onUpdated: { addListener() {} }, onRemoved: { addListener() {} } },
    windows: { create: async () => ({}), get: async () => ({}), update: async () => ({}), onRemoved: { addListener() {} } },
    notifications: { create() {}, clear() {}, onClicked: { addListener() {} } },
    action: { onClicked: { addListener() {} } }, scripting: { executeScript: async () => [] },
};

// ---------------------------------------------------------------- 假 DirectoryHandle
const FREE_DAILY_HOSTS = /push2his\.eastmoney\.com|finance\.pae\.baidu\.com|d\.10jqka\.com\.cn|api\.adata\./i;
const FREE_LIVE_HOSTS = /hq\.sinajs\.cn|qt\.gtimg\.cn/i;
const XIAOSHI_HOSTS = /api\.shizixi\.com/i;
let blockFreeDaily = false;
let blockFreeLive = false;
// 外呼计数：错误分支不返回 接口调用 字段，所以「有没有抽小石」直接数 HTTP 请求，比读文案可靠
const netCount = { 免费日线: 0, 免费实时: 0, 小石: 0, 其他: 0 };
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || String(input);
    if (FREE_DAILY_HOSTS.test(url)) netCount.免费日线++;
    else if (FREE_LIVE_HOSTS.test(url)) netCount.免费实时++;
    else if (XIAOSHI_HOSTS.test(url)) netCount.小石++;
    else if (!/127\.0\.0\.1|localhost/i.test(url)) netCount.其他++;
    if (blockFreeDaily && FREE_DAILY_HOSTS.test(url)) throw new Error('verify 模拟：免费日线渠道不可用');
    if (blockFreeLive && FREE_LIVE_HOSTS.test(url)) throw new Error('verify 模拟：免费实时渠道不可用');
    return realFetch(url, init);
};
globalThis.fetch.original = realFetch;
/** 取一次外呼快照 */
const markNet = () => ({ ...netCount });
/** 与快照的差值（只留非零项） */
function netDelta(m) {
    const d = {};
    for (const k of Object.keys(netCount)) { const v = netCount[k] - (m[k] || 0); if (v) d[k] = v; }
    return d;
}
const fmtNet = (d) => Object.entries(d).map(([k, v]) => `${k}×${v}`).join('、') || '0 次外呼';

function dirHandle(abs, name, opts = {}) {
    return {
        kind: 'directory', name,
        async getDirectoryHandle(seg, { create = false } = {}) {
            const p = path.join(abs, seg);
            if (create) await fsp.mkdir(p, { recursive: true });
            else if (!fsSync.existsSync(p)) throw domErr('NotFoundError', 'no dir ' + p);
            return dirHandle(p, seg, opts);
        },
        async getFileHandle(seg, { create = false } = {}) {
            const p = path.join(abs, seg);
            if (!create && !fsSync.existsSync(p)) throw domErr('NotFoundError', 'no file ' + p);
            return fileHandle(p, seg);
        },
        async removeEntry() {},
        async queryPermission() { return 'granted'; },
        async requestPermission() { return 'granted'; },
        async *entries() {
            let list;
            try { list = await fsp.readdir(abs, { withFileTypes: true }); } catch { return; }
            for (const e of list.sort((a, b) => a.name.localeCompare(b.name))) {
                const p = path.join(abs, e.name);
                yield e.isDirectory() ? [e.name, dirHandle(p, e.name, opts)] : [e.name, fileHandle(p, e.name)];
            }
        },
    };
}
function fileHandle(p, name) {
    return {
        kind: 'file', name,
        async getFile() {
            const buf = await fsp.readFile(p);
            return {
                name, size: buf.byteLength, type: '',
                async arrayBuffer() { return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength); },
                async text() { return buf.toString('utf8'); },
                async stream() { return new ReadableStream({ start(c) { c.enqueue(buf); c.close(); } }); },
                async slice() { return new Blob([buf]); },
            };
        },
        async createWritable() { throw new Error('verify 不写文件'); },
    };
}
function domErr(name, message) { const e = new Error(message); e.name = name; return e; }

// ---------------------------------------------------------------- 用例框架
const results = [];
let failures = 0;
function check(caseName, label, ok, detail) {
    results.push({ caseName, label, ok: !!ok, detail });
    if (!ok) failures++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' → ' + detail : ''}`);
}
const seen = new Set();
function once(key) { if (seen.has(key)) return false; seen.add(key); return true; }
/** 摘要打印（避免整包 rows 刷屏） */
function brief(obj, depth = 0) {
    const s = JSON.stringify(obj, (k, v) => {
        if (k === 'rows' && Array.isArray(v)) return `[${v.length} 行, 末行=${JSON.stringify(v[v.length - 1])}]`;
        if (k === 'quotes' && Array.isArray(v)) return v.map(q => q.error ? (q.name + ':err') : `${q.code}=${q.price}@${q.time || '-'}(${q.source || '-'})`);
        if (k === 'stocks' && Array.isArray(v)) return v.map(x => `${x.code || x.name}:${x.error ? 'err' : (x.date || '?') + (x.intraday ? '*intraday' : '')} src=${x.source}`);
        return v;
    });
    return s && s.length > 900 && depth === 0 ? s.slice(0, 900) + '…' : s;
}
async function run(caseName, fn) {
    if (ONLY && !caseName.includes(ONLY)) { console.log(`\n=== ${caseName} ===\n  --only=${ONLY} 跳过`); return; }
    console.log(`\n=== ${caseName} ===`);
    const t0 = Date.now();
    try { await fn(); } catch (e) { check(caseName, '执行不抛异常', false, e && (e.stack || e.message) || String(e)); }
    console.log(`  耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

// ---------------------------------------------------------------- 1. 时钟与口径（纯本地，不打接口）
const src = fsSync.readFileSync(path.join(REPO, 'ai/core/ai_tools.js'), 'utf8');
const from = src.indexOf('// ============ A股交易时段与数据时效口径');
const to = src.indexOf('\nfunction klineStartDate(');
if (from < 0 || to < 0) throw new Error('未能从 ai_tools.js 抽取时段口径代码块，脚本需更新');
const block = src.slice(from, to);
const { fmtDateTimeStr } = await import('../ai/core/ai_state.js');
const helpers = new Function('fmtDateTimeStr', block + '\nreturn { marketPhase, hasLiveSession, expectedDailyLastDate, lastClosedSessionStr, sessionVolumeNote, localDateStr, nowContext, weekdaysBetween, liveSpliceInfo };')(fmtDateTimeStr);

const CLOCK_CASES = [
    ['工作日 09:00 盘前', '2026-09-02T09:00:00', { live: false, expected: '2026-09-01' }],
    ['工作日 09:30 开盘瞬间', '2026-09-02T09:30:00', { live: true, expected: '2026-09-01' }],
    ['工作日 10:30 盘中', '2026-09-02T10:30:00', { live: true, expected: '2026-09-01', volPartial: true }],
    ['工作日 11:35 午休', '2026-09-02T11:35:00', { live: true, expected: '2026-09-01' }],
    ['工作日 14:40 尾盘', '2026-09-02T14:40:00', { live: true, expected: '2026-09-01', volNearFull: true }],
    // 15:00 整点仍归入「盘中」（marketPhase 用 <= SESSION_CLOSE）：当日 bar 仍标 intraday，15:01 起才算收盘
    ['工作日 15:00 整点（边界）', '2026-09-02T15:00:00', { live: true, expected: '2026-09-01', boundary: true }],
    ['工作日 15:01 盘后', '2026-09-02T15:01:00', { live: false, expected: '2026-09-02' }],
    ['工作日 16:30 盘后', '2026-09-02T16:30:00', { live: false, expected: '2026-09-02' }],
    ['周六 10:00 休市', '2026-09-05T10:00:00', { live: false, expected: '2026-09-04' }],
    ['周一 08:00 盘前', '2026-09-07T08:00:00', { live: false, expected: '2026-09-04' }],
];
await run('C1 时段/时效口径（假时钟，0 次接口）', () => {
    for (const [label, iso, want] of CLOCK_CASES) {
        const now = new Date(iso);
        const phase = helpers.marketPhase(now);
        const live = helpers.hasLiveSession(now);
        const expected = helpers.expectedDailyLastDate(now);
        const closed = helpers.lastClosedSessionStr(now);
        const ctx = helpers.nowContext(now);
        const splice = helpers.liveSpliceInfo(now, live ? 1 : 0, 1, '10:30:00', '免费(新浪/腾讯)', ['免费实时 命中 1/1']);
        const ok = live === want.live && expected === want.expected && /\d{4}-\d{2}-\d{2}/.test(ctx) && ctx.includes('最新已收盘交易日')
            && (live ? (splice && splice.覆盖只数 === '1/1') : splice === undefined)
            && (!want.volPartial || (splice.量能说明 || '').includes('远小于全天量'))
            && (!want.volNearFull || (splice.量能说明 || '').includes('接近全天量'));
        check('C1', label, ok, `${phase.label}｜已成交${phase.tradedMinutes}min｜拼实时=${live}｜日线应有末根=${expected}｜最新已收盘=${closed}`);
        if (once('ctx')) console.log('  nowContext 样例: ' + ctx);
        if (once('splice')) console.log('  实时拼接样例: ' + JSON.stringify(splice));
    }
    const wd = helpers.weekdaysBetween('2026-08-14', '2026-09-01');
    check('C1', 'weekdaysBetween 08-14→09-01 计缺口', wd === 11, wd + ' 个交易日');
    // 缺口语义实测：不含两端，所以「少 1 根」算 0、「少 2 根」算 1——阈值 <=1 实际等于「最多缺 2 根才升级小石」
    const one = helpers.weekdaysBetween('2026-09-01', '2026-09-02');
    const two = helpers.weekdaysBetween('2026-08-31', '2026-09-02');
    const three = helpers.weekdaysBetween('2026-08-28', '2026-09-02');
    check('C1', '缺口计数为“不含两端”（少 1 根=0、少 2 根=1、少 3 根=2）',
        one === 0 && two === 1 && three === 2, `少 1 根=${one}、少 2 根=${two}、少 3 根=${three}`);
    console.log('  [口径备注] fillKlineFromApi 阀值 gapDays <= 1 实际含义是「最多缺 2 根」，与注释/系统提示里写的“缺口 ≤1 交易日”差一根');
});

if (OFFLINE_ONLY) { report(); process.exit(failures ? 1 : 0); }

// ---------------------------------------------------------------- 2. 装配假桥接 + 假工作目录
const { state } = await import('../ai/core/ai_state.js');
const { toolExecutors } = await import('../ai/core/ai_tools.js');
const now = new Date();
const TODAY = helpers.localDateStr(now);
const LIVE = helpers.hasLiveSession(now);
const PHASE = helpers.marketPhase(now).label;
const EXPECTED = helpers.expectedDailyLastDate(now);
console.log(`\n[环境] 本地时间 ${fmtDateTimeStr(now.getTime())}（${PHASE}）｜日线应有末根（最新已收盘交易日）=${EXPECTED}｜盘中拼实时=${LIVE}`);

const bridge = await startMockBridge({});
state.bridgeEnabled = true;
state.bridgeUrl = bridge.url;
console.log(`[假桥接] ${bridge.url}（mock flit_bridge：/v1/workspace/context + /v1/database/schema + /v1/database/query，只读闸门照抄）`);

const TMP_ROOT = path.join(REPO, '.verify-workspaces');
await fsp.rm(TMP_ROOT, { recursive: true, force: true });
let wsSeq = 0;
/** 造一个工作目录：写 flit/config.json（config=undefined 表示不写这个文件），并把句柄挂上 */
async function useWorkspace(label, { config, memory } = {}) {
    const dir = path.join(TMP_ROOT, `${++wsSeq}-${label}`);
    await fsp.mkdir(path.join(dir, 'flit'), { recursive: true });
    if (config !== undefined) {
        const doc = typeof config === 'string' ? config
            : JSON.stringify(Array.isArray(config) ? { data_sources: config } : config, null, 2);
        await fsp.writeFile(path.join(dir, 'flit', 'config.json'), doc, 'utf8');
    }
    if (memory) await fsp.writeFile(path.join(dir, 'flit', 'memory.md'), memory, 'utf8');
    state.workspaceHandles = [{ name: label, handle: dirHandle(dir, label, {}) }];
    state.workspaceRootPath = dir;
    bridge.resetCounts();
    return dir;
}
/** 让假库「有数据」：末行落在 dbLast，每只最多 bars 根（ETF 代码不返回行，照真实库那样） */
const dbHas = (patch) => bridge.fixture(Object.assign({ dbLast: EXPECTED, bars: 60, queryError: null, schema: SCHEMA_FULL, schemaError: null }, patch));
const dbEmpty = () => bridge.fixture({ dbLast: null, queryError: null });

// 小石 Key：优先取环境变量，否则用代码内置的兜底 Key（只注入、不打印），
// 目的是让「小石兜底」与「脏代码整批 5xx → 单只兜底」两条真能跑到。
const xiaoshiSrc = fsSync.readFileSync(path.join(REPO, 'ai/stock/xiaoshi_stock_kline.js'), 'utf8');
const FALLBACK_KEY = (xiaoshiSrc.match(/DEFAULT_XIAOSHI_API_KEY\s*=\s*'([^']+)'/) || [])[1] || '';
const XIAOSHI_KEY = String(process.env.XIAOSHI_API_KEY || '').trim() || FALLBACK_KEY;
store.sync.apiKey = XIAOSHI_KEY;
console.log(`[小石 Key] ${XIAOSHI_KEY ? '已注入（' + XIAOSHI_KEY.length + ' 位，值不外泄）' : '未找到兜底 Key，小石用例会被跳过'}`);

// 接口调用计数是全局近 10 分钟窗口，逐用例得用「增量」判定是否抽了小石额度
function parseCounts(note) {
    const m = {};
    for (const part of String(note || '').replace(/^近 10 分钟接口调用：/, '').split('｜')) {
        const mm = part.match(/^(.+?) (\d+) 次$/);
        if (mm) m[mm[1]] = Number(mm[2]);
    }
    return m;
}
let lastCounts = {};
function countDelta(note) {
    const cur = parseCounts(note);
    const delta = {};
    for (const k of new Set([...Object.keys(cur), ...Object.keys(lastCounts)])) {
        const v = (cur[k] || 0) - (lastCounts[k] || 0);
        if (v > 0) delta[k] = v;
    }
    lastCounts = cur;
    return delta;
}
/** 错误分支不返回 接口调用 字段，用外呼快照（markNet/netDelta）判「有没有抽小石」 */
const xiaoshiIn = (text) => /小石/.test(String(text || ''));
const fmtDelta = (delta) => Object.entries(delta).map(([k, v]) => `${k}×${v}`).join('、') || '0 次接口';

// ---------------------------------------------------------------- 3. D 系列：本地数据库取数（假桥接，可复现）
await run('D1 未启用 Agent 桥接 → 启用指引（0 次接口）', async () => {
    await useWorkspace('d1', { config: [dailySource()] });
    dbHas({});
    state.bridgeEnabled = false;
    let r;
    try { r = await toolExecutors.read_stock_kline({ code: '600206', days: 7 }); }
    finally { state.bridgeEnabled = true; }
    console.log('  ' + brief(r));
    check('D1', '返回 error 而非抛异常/空 rows', !!r.error && r.rows === undefined, r.error);
    check('D1', '话术为「未启用 Agent 桥接」而非「请联系项目作者」', /未启用「Agent 桥接」/.test(String(r.error || '')) && !/请联系项目作者/.test(String(r.error || '')));
    check('D1', '话术带启用步骤（node flit_bridge/server.js）', /flit_bridge\/server\.js/.test(String(r.error || '')));
    check('D1', '提示实时行情仍可用（不需要数据库）', /get_stock_quote/.test(String(r.hint || '')));
    check('D1', '全程 0 次桥接请求（context/schema/query 都没打）',
        bridge.contextCalls === 0 && bridge.schemaCalls === 0 && bridge.log.length === 0,
        `context=${bridge.contextCalls} schema=${bridge.schemaCalls} query=${bridge.log.length}`);
    check('D1', 'K 线取数不再读 parquet（结果里无 parquet 字样）', !/parquet/.test(JSON.stringify(r)), JSON.stringify(r).slice(0, 120));
});

await run('D2 未设置主工作目录 → 让用户选目录（0 次接口）', async () => {
    await useWorkspace('d2', { config: [dailySource()] });
    dbHas({});
    const dir = state.workspaceRootPath;
    state.workspaceRootPath = '';
    let r;
    try { r = await toolExecutors.read_stock_kline({ code: '600206', days: 7 }); }
    finally { state.workspaceRootPath = dir; }
    console.log('  ' + brief(r));
    check('D2', '话术为「尚未设置主工作目录」', /尚未设置主工作目录/.test(String(r.error || '')), r.error);
    check('D2', '0 次桥接请求', bridge.log.length === 0 && bridge.schemaCalls === 0);
});

await run(`D3 库里有数据（末行=${EXPECTED}）→ source=db${LIVE ? '+live' : ''}，不打外部接口`, async () => {
    await useWorkspace('d3', { config: [dailySource()] });
    dbHas({});
    const m = markNet();
    const r = await toolExecutors.read_stock_kline({ code: '600206', days: 7 });
    const d = netDelta(m);
    console.log('  ' + brief(r));
    const rows = r.rows || [];
    const last = rows[rows.length - 1] || {};
    check('D3', '总行数仍为 7（盘中 = 6 收盘 + 1 实时）', rows.length === 7, rows.length + ' 行');
    check('D3', 'source 以 db 打头（不再出现 parquet）', /^db/.test(String(r.source || '')) && !/parquet/.test(String(r.source || '')), r.source);
    check('D3', '数据表 = a_share_daily', r.数据表 === 'a_share_daily', String(r.数据表));
    check('D3', '本地库诊断写明命中只数与末行日期', /命中 1\/1/.test(String(r.本地库诊断 || '')) && /末行/.test(String(r.本地库诊断 || '')), r.本地库诊断);
    check('D3', 'SQL 带 adjust 过滤与 rn 上限', bridge.klineSql.length === 1
        && /adjust = 'qfq'/.test(bridge.klineSql[0].sql) && /rn <= 7/.test(bridge.klineSql[0].sql),
        bridge.klineSql[0] && bridge.klineSql[0].sql.slice(0, 150) + '…');
    check('D3', '本地库查询恰好 1 次，免费/小石 0 次（真能只靠库回答）', bridge.klineSql.length === 1 && !d.免费日线 && !d.小石, fmtNet(d));
    check('D3', '结果自证字段齐备（接口调用 / 本地库诊断）', /本地数据库 \d+ 次/.test(String(r.接口调用 || '')) && !!r.本地库诊断, r.接口调用);
    check('D3', '数据日期 / 最新已收盘交易日 均有值', !!r.数据日期 && r.最新已收盘交易日 === EXPECTED, `${r.数据日期} / ${r.最新已收盘交易日}`);
    if (LIVE) {
        check('D3', '末行为当日实时 bar（intraday + as_of）', last.intraday === true && !!last.as_of && last.date === TODAY,
            `${last.date} intraday=${last.intraday} as_of=${last.as_of}`);
        check('D3', '实时拼接.覆盖只数 = 1/1', r.实时拼接 && r.实时拼接.覆盖只数 === '1/1', JSON.stringify(r.实时拼接));
        check('D3', 'source 带 +live', /\+live$/.test(String(r.source)), r.source);
    } else {
        // 口径：盘后不拼实时 bar 的判据是「末行没有 intraday 标记 / 无 实时拼接 字段」。
        // 不能用 last.date !== TODAY：本用例 fixture 就是 dbLast=EXPECTED，收盘后 EXPECTED 即当日，
        // 库里合法地已经有当日已收盘行（15:01 后跑会误挂）。
        check('D3', '非交易时段不拼当日 bar（末行无 intraday、无 实时拼接 字段、source 不带 +live）',
            last.intraday === undefined && r.实时拼接 === undefined && !/live/.test(String(r.source || '')),
            `${last.date} intraday=${last.intraday} / 实时拼接=${r.实时拼接} / source=${r.source}`);
    }
    console.log('  接口调用（累计窗口原文）: ' + r.接口调用);
});

await run('D4 库缺 3 根 → 免费日线补齐（db+adata，小石 0 次）', async () => {
    await useWorkspace('d4', { config: [dailySource()] });
    dbHas({ dbLast: minusWeekdays(EXPECTED, 3) });
    const m = markNet();
    const r = await toolExecutors.read_stock_kline({ code: '600206', days: 7 });
    console.log('  ' + brief(r));
    const d = netDelta(m);
    check('D4', 'source = db+adata' + (LIVE ? '+live' : ''), /^db\+adata/.test(String(r.source || '')), r.source);
    check('D4', '库仍被使用（数据表/本地库诊断在）', r.数据表 === 'a_share_daily' && /命中 1\/1/.test(String(r.本地库诊断 || '')), r.本地库诊断);
    check('D4', '免费日线恰好 1 次（整段一次请求，不按天循环）', d.免费日线 === 1, fmtNet(d));
    check('D4', '0 次小石', !d.小石, fmtNet(d));
    check('D4', '库内末行早于应有末根（cacheLastDate 如实回显）', r.cacheLastDate === minusWeekdays(EXPECTED, 3), String(r.cacheLastDate));
    const last = (r.rows || []).slice(-1)[0] || {};
    check('D4', '补齐后末行达到应有口径', LIVE ? last.date === TODAY : last.date >= EXPECTED, `${last.date}（应有 ${LIVE ? TODAY : EXPECTED}）`);
});

await run('D5 库缺 2 根 + 屏蔽免费 → 升级小石（本次唯一一次小石日线）', async () => {
    await useWorkspace('d5', { config: [dailySource()] });
    dbHas({ dbLast: minusWeekdays(EXPECTED, 2) });
    blockFreeDaily = true;
    const m = markNet();
    let r;
    try { r = await toolExecutors.read_stock_kline({ code: '600206', days: 7 }); } finally { blockFreeDaily = false; }
    console.log('  ' + brief(r));
    const d = netDelta(m);
    check('D5', 'source = db+xiaoshi' + (LIVE ? '+live' : ''), /^db\+xiaoshi/.test(String(r.source || '')), r.source);
    check('D5', '小石日线恰好 1 次（缺口只有一两根才抽额度）', d.小石 === 1, fmtNet(d));
    check('D5', '有数据返回（不是空响应）', (r.rows || []).length > 0, `${(r.rows || []).length} 行，末行 ${(r.rows || []).slice(-1)[0]?.date}`);
});

await run('D6 库缺 30 根 + 屏蔽免费 → 缺口过大不抽小石额度', async () => {
    await useWorkspace('d6', { config: [dailySource()] });
    // days 取 60：否则免费补口的 date >= 起点 会把 30 个交易日前的行全滤掉，变成「库里根本没数据」（那是 D8 的口径）
    dbHas({ dbLast: minusWeekdays(EXPECTED, 30) });
    blockFreeDaily = true;
    const m = markNet();
    let r;
    try { r = await toolExecutors.read_stock_kline({ code: '600206', days: 60 }); } finally { blockFreeDaily = false; }
    console.log('  ' + brief(r));
    const d = netDelta(m);
    check('D6', 'source 仍为 db' + (LIVE ? '+live' : '') + '（未升级小石）', /^db(\+live)?$/.test(String(r.source || '')), r.source);
    check('D6', '0 次小石', !d.小石, fmtNet(d));
    check('D6', 'warning 写明缺 N 个交易日且不代为同步', /缺 \d+ 个交易日/.test(String(r.warning || '')) && /不代为同步/.test(String(r.warning || '')), r.warning);
    check('D6', 'warning 不出现 sync_daily.py / parquet 脚本字样（需求 6）',
        !/sync_daily|parquet|\.py\b/.test(String(r.warning || '')), String(r.warning || '').slice(0, 120));
    check('D6', '库内行仍可用（cacheLastDate = 30 个交易日前）', (r.rows || []).length > 10 && r.cacheLastDate === minusWeekdays(EXPECTED, 30),
        `行数 ${(r.rows || []).length}｜库内末行 ${r.cacheLastDate}｜数据日期 ${r.数据日期}`);
    if (!LIVE) check('D6', '盘后口径：末行就是库内末行（未拼实时）', (r.rows || []).slice(-1)[0].date === r.cacheLastDate, (r.rows || []).slice(-1)[0].date);
    const lastDate = (r.rows || []).slice(-1)[0]?.date;
    if (LIVE && lastDate === TODAY) console.log('  [观察] 缺口很大时末行仍被拼上当日实时 bar：中间缺口靠 warning 说明，不在 rows 里体现');
});

await run('D7 flit/config.json 为空 → 按工作目录搜索（桥接推断数据源）', async () => {
    // 需求 3：config 空 → 走「当前从工作目录搜索」那条路（flit/memory.md 一类）
    await useWorkspace('d7', {
        config: { data_sources: [] },
        memory: '# 工作区记忆\n\n## 数据库连接状态\n- status: verified\n- 容器: my-postgres，数据库：stock，日线表 a_share_daily（qfq）\n',
    });
    dbHas({ contextDatabase: [dailySource({ name: 'local-postgres-from-memory' })] });
    const r = await toolExecutors.read_stock_kline({ code: '600206', days: 7 });
    console.log('  ' + brief(r));
    check('D7', '仍取到数据且 source=db', /^db/.test(String(r.source || '')), r.source);
    check('D7', '本地库诊断说明「按工作目录搜索到候选数据源」', /按工作目录搜索到候选数据源/.test(String(r.本地库诊断 || '')), r.本地库诊断);
    check('D7', '桥接 context 接口确实被调用过（走的是搜索分支）', bridge.contextCalls >= 1, 'context×' + bridge.contextCalls);
    check('D7', '数据表仍按登记的表探测得到 a_share_daily', r.数据表 === 'a_share_daily', String(r.数据表));
});

await run('D8 无 config、无工作目录记忆 → 「请联系项目作者」那句（0 次接口）', async () => {
    await useWorkspace('d8', {});   // 不写 flit/config.json
    dbHas({ contextDatabase: null });
    const m = markNet();
    const r = await toolExecutors.read_stock_kline({ code: '600206', days: 7 });
    console.log('  ' + brief(r));
    check('D8', '话术为需求 3 的原文', /由于工作目录不存在可用数据库，当前无法查询 K 线，若有需求请联系项目作者/.test(String(r.error || '')), r.error);
    check('D8', '带 排查 三条（config / 桥接 / 仅支持 docker pg）', Array.isArray(r.排查) && r.排查.length === 3, JSON.stringify(r.排查));
    check('D8', '带 hint 说明实时行情仍可用', /get_stock_quote/.test(String(r.hint || '')));
    check('D8', '未打任何 database/query（没库就不查）', bridge.log.length === 0, 'query×' + bridge.log.length);
    const d = netDelta(m);
    check('D8', '0 次小石、0 次免费（不会因为没库去抽额度/重试）', !d.小石 && !d.免费日线, fmtNet(d));
});

await run('D9 登记了库但查询报错 → 「日线表读取失败或桥接不可用」', async () => {
    await useWorkspace('d9', { config: [dailySource()] });
    dbHas({ queryError: { code: 'sql_error', message: 'relation "a_share_daily" does not exist' } });
    const m = markNet();
    const r = await toolExecutors.read_stock_kline({ code: '600206', days: 7 });
    console.log('  ' + brief(r));
    check('D9', '话术为库登记了但读表失败', /日线表读取失败或桥接不可用/.test(String(r.error || '')), r.error);
    check('D9', '取数诊断带上真实报错原文', /does not exist/.test(String(r.取数诊断 || '')), r.取数诊断);
    const d = netDelta(m);
    check('D9', '0 次小石、0 次免费日线（失败即止，不去抽额度）', !d.小石 && !d.免费日线, fmtNet(d));
});

await run('D10 config 未登记表名 → 按列签名探测（并排除 *_today 干扰表）', async () => {
    const noTables = dailySource();
    delete noTables.tables;
    await useWorkspace('d10', { config: [noTables] });
    dbHas({ schema: SCHEMA_FULL });
    const r = await toolExecutors.read_stock_kline({ code: '600206', days: 7 });
    console.log('  ' + brief(r));
    check('D10', '探测到 a_share_daily（不是 a_share_daily_today）', r.数据表 === 'a_share_daily', String(r.数据表));
    check('D10', 'SQL 里 FROM 后正是该表', bridge.klineSql.length === 1 && /FROM a_share_daily\b/.test(bridge.klineSql[0].sql), bridge.klineSql[0] && bridge.klineSql[0].sql.slice(0, 120));
    check('D10', 'source=db' + (LIVE ? '+live' : ''), /^db/.test(String(r.source || '')), r.source);
});

await run('D11 名称→代码走本地库（不再优先抽小石搜索）', async () => {
    await useWorkspace('d11', { config: [dailySource()] });
    dbHas({});
    const m = markNet();
    const r = await toolExecutors.read_stock_kline({ name: '贵州茅台', days: 5 });
    console.log('  ' + brief(r));
    check('D11', '解析为库里的 600519.SH', String(r.code || '').toUpperCase() === '600519.SH', r.code);
    check('D11', '确实向 basic 表发了一条名称查询 SQL', bridge.nameSql.length === 1 && /stock_basic_cache/.test(bridge.nameSql[0]), bridge.nameSql[0]);
    const d = netDelta(m);
    check('D11', '0 次小石搜索（需求 7）', !d.小石, fmtNet(d));
    check('D11', '本用例只发 2 条 SQL（名称 1 + 日线 1）', bridge.klineSql.length === 1 && bridge.nameSql.length === 1,
        `kline×${bridge.klineSql.length} name×${bridge.nameSql.length}`);
});

await run('D12 批量 3 只 = 一次 SQL（T1 口径）', async () => {
    await useWorkspace('d12', { config: [dailySource()] });
    dbHas({});
    const t12 = Date.now();
    const m = markNet();
    const r = await toolExecutors.read_stocks_kline({ codes: ['600206', '001309', '600519'], days: 10 });
    console.log('  ' + brief(r));
    check('D12', '日线 SQL 只发 1 条（整批一次取回）', bridge.klineSql.length === 1, 'klineSql×' + bridge.klineSql.length);
    check('D12', '该 SQL 用窗口函数按 code 分组截断', /ROW_NUMBER\(\) OVER \(PARTITION BY substr\(code, 1, 6\)/.test(bridge.klineSql[0].sql), bridge.klineSql[0].sql.slice(0, 160));
    check('D12', '三只 code 都在同一条 SQL 的 IN 列表里', ['600206', '001309', '600519'].every(c => bridge.klineSql[0].codes.includes(c)),
        bridge.klineSql[0].codes.join('、'));
    check('D12', '三只都命中且 source=db', (r.stocks || []).length === 3 && r.stocks.every(s => !s.error && /^db/.test(String(s.source))), (r.stocks || []).map(s => `${s.code}:${s.source || s.error}`).join('｜'));
    check('D12', '本地库诊断报 命中 3/3', /命中 3\/3/.test(String(r.本地库诊断 || '')), r.本地库诊断);
    check('D12', '每只 bars 数为 days（盘中含 1 根实时）', r.stocks.every(s => s.bars === 10), r.stocks.map(s => `${s.code}=${s.bars}`).join('｜'));
    const d = netDelta(m);
    check('D12', '免费日线 0 次、小石 0 次（一次 SQL 就够）', !d.免费日线 && !d.小石, fmtNet(d));
    check('D12', 'detail 缺省时不返回原始 rows', r.stocks.every(s => !s.rows));
    const ms12 = Date.now() - t12;
    check('D12', '整批（3 只×10 根）耗时 < 3s——库路径本身很快（只剩一次 SQL）', ms12 < 3000, (ms12 / 1000).toFixed(1) + 's');
});

await run('D13 股票 + ETF 混批：ETF 不在库内，走免费（不打小石）', async () => {
    await useWorkspace('d13', { config: [dailySource()] });
    dbHas({});
    const t0 = Date.now();
    const m = markNet();
    const r = await toolExecutors.read_stocks_kline({ codes: ['600206', '512880'], days: 7 });
    const ms = Date.now() - t0;
    console.log('  ' + brief(r));
    const s6 = (r.stocks || []).find(s => String(s.code || '').startsWith('600206'));
    const sE = (r.stocks || []).find(s => String(s.code || '').startsWith('512880'));
    check('D13', '两只均成功', !!(s6 && !s6.error && sE && !sE.error), `${s6 && (s6.error || s6.date)}｜${sE && (sE.error || sE.date)}`);
    check('D13', '股票 source=db 打头', /^db/.test(String((s6 || {}).source || '')), s6 && s6.source);
    check('D13', 'ETF source 不含 db（库里没有 ETF）', !/^db/.test(String((sE || {}).source || '')) && /adata|xiaoshi/.test(String((sE || {}).source || '')), sE && sE.source);
    check('D13', 'ETF 后缀推对（51 开头应为 .SH）', String((sE || {}).code || '').endsWith('.SH'), sE && sE.code);
    check('D13', 'ETF 名称未串成股票名', !!sE && !String(sE.name || '').includes('有研'), sE && sE.name);
    check('D13', '本地库诊断说明 ETF 未命中（命中 1/2）', /命中 1\/2/.test(String(r.本地库诊断 || '')), r.本地库诊断);
    const d = netDelta(m);
    check('D13', 'ETF 补齐只走免费（1~2 次 HTTP，含库内重试）、0 次小石', d.免费日线 >= 1 && d.免费日线 <= 2 && !d.小石, fmtNet(d));
    check('D13', '混批未超出二十秒量级（本用例含一次真实免费 ETF 请求，耗时主要在那上面）', ms < 20000, (ms / 1000).toFixed(1) + 's');
    // 单只 ETF（用户在 Chrome 里会这么问）：数据表 得说清楚 ETF 不在库里，而不是摆一个股票表名
    const m13b = markNet();
    const one = await toolExecutors.read_stock_kline({ code: '512880', days: 7 });
    console.log('  单只 ETF → ' + brief(one));
    check('D13', '单只 ETF：数据表 为「本库不含 ETF」说明（不摆股票表名）', /本库不含 ETF/.test(String(one.数据表 || '')), String(one.数据表));
    check('D13', '单只 ETF：source 不含 db', !/^db/.test(String(one.source || '')) && /adata|xiaoshi/.test(String(one.source || '')), one.source);
    check('D13', '单只 ETF：本地库诊断仍写出命中 0/1', /命中 0\/1/.test(String(one.本地库诊断 || '')), one.本地库诊断);
    console.log('  （单只 ETF 那次调用的外呼：' + fmtNet(netDelta(m13b)) + '）');
});

await run('D14 库不可用 + 混 ETF：股票逐项报错、ETF 照取', async () => {
    await useWorkspace('d14', {});
    dbHas({ contextDatabase: null });
    const m = markNet();
    const r = await toolExecutors.read_stocks_kline({ codes: ['600206', '512880'], days: 7 });
    console.log('  ' + brief(r));
    const s6 = (r.stocks || []).find(s => String(s.code || '').startsWith('600206'));
    const sE = (r.stocks || []).find(s => String(s.code || '').startsWith('512880'));
    check('D14', '整批不因“没库”直接失败（返回 stocks）', Array.isArray(r.stocks) && !r.error, JSON.stringify(r).slice(0, 160));
    check('D14', '股票项为「工作目录不存在可用数据库」话术', /工作目录不存在可用数据库/.test(String((s6 || {}).error || '')), s6 && s6.error);
    check('D14', 'ETF 项仍有数据（不被库问题牵连）', !!sE && !sE.error && !!sE.date, sE && (sE.date || sE.error));
    const d = netDelta(m);
    check('D14', '0 次小石日线（没库不抽额度）', !d.小石, fmtNet(d));
    check('D14', '没库时一条日线 SQL 也不发', bridge.klineSql.length === 0, 'klineSql×' + bridge.klineSql.length);
});

await run('D16 改了 flit/config.json 的表名 → 不必重开 AI 窗口（计划缓存带指纹，P1-4）', async () => {
    const dir = await useWorkspace('d16', { config: [dailySource({ tables: { daily: 'daily_v2', stock_basic: 'stock_basic_cache' } })] });
    dbHas({ schema: SCHEMA_FULL });
    const r1 = await toolExecutors.read_stock_kline({ code: '600206', days: 7 });
    check('D16', '第一次查用登记的 daily_v2', r1.数据表 === 'daily_v2', String(r1.数据表));
    // 就地把 config 改回 a_share_daily（同一工作目录、同一源名：没指纹时会命中过期的计划缓存）
    await fsp.writeFile(path.join(dir, 'flit', 'config.json'), JSON.stringify({ data_sources: [dailySource()] }, null, 2), 'utf8');
    const sqlBefore = bridge.klineSql.length;
    const r2 = await toolExecutors.read_stock_kline({ code: '600206', days: 7 });
    console.log('  ' + brief(r2));
    check('D16', '改表名后第二次查就用新表（不靠重开窗口）', r2.数据表 === 'a_share_daily', String(r2.数据表));
    check('D16', '第二次只发一条 SQL，且落在新表上', bridge.klineSql.length === sqlBefore + 1
        && /FROM a_share_daily\b/.test(bridge.klineSql[bridge.klineSql.length - 1].sql),
        bridge.klineSql.map(q => q.table).join('→'));
});

await run('D17 读不到表结构且 config 未登记表名 → 不把猜的表名当成「数据表」（P1-5）', async () => {
    const noTables = dailySource({ name: 'local-postgres-guess' });
    delete noTables.tables;
    await useWorkspace('d17', { config: [noTables] });
    dbHas({ schemaError: 'schema_error' });   // 探测不可用 → 只能猜表名
    const r = await toolExecutors.read_stock_kline({ code: '600206', days: 7 });
    console.log('  ' + brief(r));
    check('D17', '数据表 不给出未验证的表名', !r.数据表, JSON.stringify(r.数据表));
    check('D17', '本地库诊断说明表名未经验证', /未经验证/.test(String(r.本地库诊断 || '')), r.本地库诊断);
    check('D17', '仍然先试查一把（不把“猜”当成“没库”）', /^db/.test(String(r.source || '')), r.source);
});

await run('D18 安全自证：扩展拼出的 SQL 全部只读、表名合法、不会全表拉取', async () => {
    check('D18', '全部用例累计 0 条 SQL 被只读闸门拒绝', bridge.total.forbidden === 0,
        bridge.total.forbidden ? bridge.forbidden[0].slice(0, 200) : `共发 ${bridge.total.klineSql + bridge.total.nameSql} 条 SQL，均为只读`);
    check('D18', 'SQL 只碰到登记/探测出的表', [...bridge.total.klineTables].every(t => /^[a-z_][a-z0-9_]*$/i.test(String(t))),
        [...bridge.total.klineTables].join('、'));
    check('D18', '每条日线 SQL 都带 code 限定与 rn 上限（不会全表拉取）', bridge.total.looseSql === 0,
        `日线 SQL ${bridge.total.klineSql} 条，宽松查询 ${bridge.total.looseSql} 条`);
});

// ---------------------------------------------------------------- 4. C 系列：实时/免费真实链路（库置空）
dbEmpty();
await useWorkspace('net', { config: [dailySource()] });

await run('C2 get_portfolio_quotes（3 只含 ETF，期望 0 次小石）', async () => {
    const r = await toolExecutors.get_portfolio_quotes({});
    console.log('  ' + brief(r));
    const ok = r.fetched === 3 && (r.渠道 || '').startsWith('免费')
        && r.quotes.filter(q => q.code).every(q => q.error || (q.time && q.price > 0 && (q.source || '').startsWith('免费')))
        && !xiaoshiIn(r.渠道诊断);
    check('C2', '命中 3 只（ETF 在内）且渠道为免费', ok, `fetched=${r.fetched} 渠道=${r.渠道}`);
    check('C2', '每只都带行情时间 time', r.quotes.filter(q => !q.error).every(q => !!q.time));
    check('C2', '无代码项走「尚未获取到代码」分支', r.quotes.some(q => q.error === '尚未获取到代码'));
    console.log('  渠道诊断: ' + (r.渠道诊断 || '（无）'));
    console.log('  [差异记录] get_portfolio_quotes 未返回 接口调用 字段（计划 P2-8 同类缺口）');
});

await run('C3 get_stock_quote 600206（期望免费渠道、0 次小石）', async () => {
    const r = await toolExecutors.get_stock_quote({ code: '600206' });
    console.log('  ' + brief(r));
    check('C3', '渠道为免费(新浪/腾讯)', (r.渠道 || '').startsWith('免费'), r.渠道);
    check('C3', 'quote 带 time/price/source', !!(r.quote && r.quote.time && r.quote.price > 0 && r.quote.source));
    check('C3', '未出现 接口调用 字段（P2-8 待办，现状如实记录）', r.接口调用 === undefined);
});

await run('C4 get_stock_quote 999999（负例：脏代码不得带崩同批正常股票）', async () => {
    const bad = await toolExecutors.get_stock_quote({ code: '999999' });
    console.log('  999999 → ' + brief(bad));
    check('C4', '无效代码返回可解释的失败而非抛异常', !!bad.error, bad.error);
    check('C4', '失败时带 渠道诊断（逐渠道说明）', !!bad.渠道诊断, bad.渠道诊断);
    check('C4', '小石批量与单只两级兜底都被试过', /小石批量/.test(String(bad.渠道诊断)) && /小石单只/.test(String(bad.渠道诊断)), bad.渠道诊断);
    const mixed = await toolExecutors.read_stocks_kline({ codes: ['999999', '600206'], days: 7 });
    const delta = countDelta(mixed.接口调用);
    const stocks = mixed.stocks || [];
    const okMix = stocks.some(s => String(s.code || '').startsWith('600206') && !s.error);
    check('C4', '同批混入脏代码时正常股票仍有数据', okMix,
        stocks.map(s => `${s.code}:${s.error ? 'err' : s.date}`).join(' '));
    console.log(`  本用例接口增量: ${fmtDelta(delta)}（库置空→升级到免费/小石属预期）`);
    console.log('  渠道诊断: ' + JSON.stringify(mixed.实时拼接 && mixed.实时拼接.渠道诊断));
});

await run('C4b 免费实时全挂 + 同批混脏代码（验证小石单只兜底能救回正常代码）', async () => {
    // 临时把测试列表换成「1 只无效 + 1 只有效」：小石批量会整批 5xx，只有逐只兜底才能拿回 600206
    const saved = store.local.stockList;
    store.local.stockList = [
        { name: '无效代码', code: '999999', prefix: 'SZ' },
        { name: '有研新材', code: '600206', prefix: 'SH' },
    ];
    blockFreeLive = true;
    let r;
    try { r = await toolExecutors.get_portfolio_quotes({}); } finally { blockFreeLive = false; store.local.stockList = saved; }
    console.log('  ' + brief(r));
    const hit = (r.quotes || []).find(q => q.code === '600206');
    check('C4b', '免费实时挂掉后确实升级到小石', /xiaoshi/.test(String(r.渠道 || '')), r.渠道);
    check('C4b', '脏代码整批 503 时，正常代码被单只兜底救回', !!(hit && hit.price > 0 && /单只/.test(String(hit.source || ''))), hit && (hit.source || hit.error));
    check('C4b', '渠道诊断把降级链路说清楚', /免费实时/.test(String(r.渠道诊断)) && /小石/.test(String(r.渠道诊断)), r.渠道诊断);
});

await run('C9 系统提示注入（buildSystemPrompt）', async () => {
    const { buildSystemPrompt } = await import('../ai/core/ai_tools.js');
    const p = buildSystemPrompt();
    const content = String((p && p.content) || p);
    const line = content.split('\n').find(l => l.includes('[当前时间]')) || '';
    console.log('  ' + line.slice(0, 240));
    check('C9', '提示含日期+星期+时段+最新已收盘交易日', /\d{4}-\d{2}-\d{2}/.test(line) && /周[一二三四五六日]/.test(line) && /最新已收盘交易日/.test(line));
    check('C9', '提示为数据库优先口径（本地数据库 → 免费 → 小石）', content.includes('本地数据库') && content.includes('免费渠道') && content.includes('flit/config.json'));
    check('C9', '提示明确「不替用户执行同步脚本」与「照原样转述不可用结论」', /不要替用户执行任何同步脚本/.test(content) && /照原样转述/.test(content));
    check('C9', '提示不再教模型读 parquet 取 K 线', !/读取.*parquet.*年文件|read_stock_kline.*parquet/i.test(content));
    check('C9', '提示角色字段完整', p && p.role === 'system');
    check('C9', '跨轮口径：教模型用 retain_tool_data 保存关键原始数据', /retain_tool_data/.test(content), content.match(/.{0,30}retain_tool_data.{0,20}/)?.[0]);
    check('C9', '不再要求把工具数据拄进回复正文（避免复述式烧 token）', !/必须在本次回复正文里以表格或列表完整写出/.test(content));
    check('C9', '仍保留「禁止编造 + 失败的查询不得补写数值」口径', /禁止编造/.test(content) && /不得把它的结果编成数值/.test(content));
});

// ---------------------------------------------------------------- 4.9 R 系列：跨轮上下文（账本 / 数据便签）
await run('R1 retain_tool_data 登记与拒收口径（0 次接口）', async () => {
    const savedResults = state.turnToolResults;
    const savedPending = state.pendingRetains;
    const now = Date.now();
    state.pendingRetains = [];
    state.turnToolResults = [
        { name: 'load_tool_group', argsText: '{"group":"market"}', text: '{"ok":true}', ok: true, ts: now },
        { name: 'read_stock_kline', argsText: '{"code":"600206","days":7}', text: JSON.stringify({ code: '600206.SH', 数据日期: EXPECTED, rows: [{ date: EXPECTED }] }), ok: true, ts: now },
        { name: 'get_stock_quote', argsText: '{"code":"600206"}', text: JSON.stringify({ error: '实时行情拉取失败：免费渠道与小石均不可用', 渠道诊断: '新浪 0、腾讯 0' }), ok: false, ts: now },
    ];
    try {
        let r = await toolExecutors.retain_tool_data({ tool: 'read_stock_kline', note: '后续算 MA' });
        console.log('  ' + brief(r));
        check('R1', '本轮成功的原始返回可登记，且告知不走用户界面', r.ok === true && r.已登记 === 'read_stock_kline' && /界面/.test(String(r.生效)), brief(r));
        check('R1', '登记结果先进 pendingRetains，等 ai.js 本轮结束排空落库',
            state.pendingRetains.length === 1 && state.pendingRetains[0].tool === 'read_stock_kline',
            state.pendingRetains.map(n => n.tool).join(','));

        r = await toolExecutors.retain_tool_data({ tool: 'get_stock_quote' });
        check('R1', '取数失败的调用不得登记（不能把报错当数据留一份）', !!r.error && /没有取到数据/.test(r.error), r.error);

        r = await toolExecutors.retain_tool_data({ tool: 'read_stocks_kline' });
        check('R1', '本轮没调过的工具不得登记，并回可登记清单（只能凭真拿到的原文登记）',
            !!r.error && /本轮没有/.test(r.error) && Array.isArray(r.本轮可登记) && r.本轮可登记.includes('read_stock_kline'), brief(r));

        r = await toolExecutors.retain_tool_data({ tool: 'load_tool_group' });
        check('R1', 'load_tool_group 等常驻工具不入可登记清单', !!r.error && !r.本轮可登记.includes('load_tool_group'), `${r.error}|${r.本轮可登记}`);

        await toolExecutors.retain_tool_data({ tool: 'read_stock_kline', note: '换成这一份' });
        check('R1', '同一工具重复登记只留最新一份', state.pendingRetains.filter(n => n.tool === 'read_stock_kline').length === 1,
            state.pendingRetains.map(n => n.tool).join(','));

        state.turnToolResults.push({ name: 'query_local_database', argsText: '{"sql":"SELECT 1"}', text: 'x'.repeat(9000), ok: true, ts: now });
        await toolExecutors.retain_tool_data({ tool: 'query_local_database' });
        const total = state.pendingRetains.reduce((n, x) => n + x.text.length, 0);
        check('R1', '单条超 MAX_RETAIN_CHARS 会截断', state.pendingRetains.every(n => n.text.length <= 3100),
            state.pendingRetains.map(n => n.text.length).join(','));
        check('R1', '总量超 MAX_RETAINED_TOTAL 丢最旧、最新一份必在',
            total <= 6000 && state.pendingRetains.some(n => n.tool === 'query_local_database'), `total=${total}`);
    } finally {
        state.turnToolResults = savedResults;
        state.pendingRetains = savedPending;
    }
});

// ---------------------------------------------------------------- 5. E 系列：真实桥接 + 真实库（--bridge=real 才跑）
if (REAL_BRIDGE) {
    // 先把指针拨到真桥接再探 health——否则探的是假桥接自己，永远“可达”，
    // 真桥接没起时 E 用例会变成一堆让人误会的 FAIL。
    state.bridgeUrl = BRIDGE_REAL_URL;
    state.bridgeEnabled = true;
    state.workspaceHandles = [{ name: 'real', handle: dirHandle(WORKSPACE_ROOT, 'real', {}) }];
    state.workspaceRootPath = WORKSPACE_ROOT;
    const health = await toolExecutors.bridge_health();
    const alive = health && health.ok !== false && !health.error;
    if (!alive) {
        console.log('\n=== E1/E2/E3 真实桥接用例 ===\n  跳过：桥接不可达（' + JSON.stringify(health && health.error || health).slice(0, 160) + '）');
        console.log('  先跑：node flit_bridge/server.js（默认 ' + BRIDGE_REAL_URL + '），并确认 docker 里的 my-postgres 在跑');
        check('E0', '真实桥接可达（--bridge=real）', false, '未起：' + BRIDGE_REAL_URL);
    } else {
        console.log(`\n[真桥接] ${BRIDGE_REAL_URL} 可达，工作目录 ${WORKSPACE_ROOT}`);
        bridge.resetCounts();
        await run('E1 真库单只 600206 近 30 日（真实 SQL）', async () => {
            const t0 = Date.now();
            const m = markNet();
            const r = await toolExecutors.read_stock_kline({ code: '600206', days: 30 });
            const ms = Date.now() - t0;
            console.log('  ' + brief(r));
            check('E1', '数据表来自真实 config（a_share_daily 一类）', !!r.数据表 && !/本库不含 ETF/.test(String(r.数据表)), String(r.数据表));
            check('E1', 'source 以 db 打头', /^db/.test(String(r.source || '')), r.source);
            check('E1', '返回 30 行', (r.rows || []).length === 30, (r.rows || []).length + ' 行，末行 ' + (r.rows || []).slice(-1)[0]?.date);
            check('E1', '本地库诊断可见', /命中 1\/1/.test(String(r.本地库诊断 || '')), r.本地库诊断);
            // 用外呼计数而不是 接口调用 增量：后者是 10 分钟累计窗口，会被前面用例的尾巴污染
            const d = netDelta(m);
            check('E1', '本用例 0 次小石外呼（K 线真靠本地库）', !d.小石, fmtNet(d));
            console.log(`  真库耗时 ${(ms / 1000).toFixed(2)}s（历史参照：parquet 路径约 8.4s，一条 SQL 实测 0.585s）`);
        });
        await run('E2 真库批量 12 只（一次 SQL）', async () => {
            const codes = ['600206', '001309', '600519', '000001', '300750', '601318', '002415', '688981', '600036', '000858', '300059', '601899'];
            const t0 = Date.now();
            const m = markNet();
            const r = await toolExecutors.read_stocks_kline({ codes, days: 20 });
            const ms = Date.now() - t0;
            console.log('  ' + brief(r));
            const ok = (r.stocks || []).filter(s => !s.error).length;
            check('E2', '12 只中至少 10 只取到数据', ok >= 10, `${ok}/12 有数据，失败 ${r.failed || 0}`);
            check('E2', 'source 含 db 的比例 ≥ 有数据只数的一半', (r.stocks || []).filter(s => !s.error && /db/.test(String(s.source))).length >= Math.ceil(ok / 2),
                (r.stocks || []).map(s => `${s.code}:${s.source || 'err'}`).join('｜'));
            const dE2 = netDelta(m);
            check('E2', '本用例 0 次小石外呼', !dE2.小石, fmtNet(dE2));
            check('E2', '十二只一批只花一次库查询 → 耗时个百毫秒量级', ms < 3000, (ms / 1000).toFixed(2) + 's（旧 parquet 路径实测 8.4s）');
            console.log(`  真库批量耗时 ${(ms / 1000).toFixed(2)}s`);
        });
        await run('E3 真库名称解析（贵州茅台 不抽小石搜索）', async () => {
            const saved = store.local.stockList;
            store.local.stockList = [];   // 清空本地列表，逼名称解析走「库搜索」
            const m = markNet();
            let r;
            try { r = await toolExecutors.get_stock_quote({ name: '贵州茅台' }); } finally { store.local.stockList = saved; }
            console.log('  ' + brief(r));
            check('E3', '解析到 600519 且拿到现价', String(r.code || '').startsWith('600519') && !!(r.quote && r.quote.price), `${r.code}｜${r.error || r.quote && r.quote.price}`);
            const d = netDelta(m);
            check('E3', '未调用小石搜索（0 次小石外呼）', !d.小石, fmtNet(d));
        });
    }
}

// ---------------------------------------------------------------- 6. 收尾
await bridge.close();
await fsp.rm(TMP_ROOT, { recursive: true, force: true });

report();
function report() {
    const total = results.length;
    console.log('\n========== 汇总 ==========');
    for (const r of results) if (!r.ok) console.log(`FAIL  ${r.caseName}  ${r.label}${r.detail ? ' → ' + r.detail : ''}`);
    console.log(`共 ${total} 项断言，失败 ${failures} 项`);
    console.log(failures ? '结论：存在未通过项，需修复后重跑' : '结论：全部通过');
}
process.exit(failures ? 1 : 0);
