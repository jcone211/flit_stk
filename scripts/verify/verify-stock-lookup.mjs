// verify-stock-lookup.mjs —— 股票名称/代码 → 标的解析回归（纯逻辑，不打网络）
//
// 用途：对应「股票导入自动模式」计划步骤 1。直接读仓库里真实的
//       assets/stock_basic_cache.json（5567 条全量 A 股代码表），验证 shared/stock_lookup.js
//       的解析口径：精确命中 / 唯一模糊命中 / 多候选 / 查不到 / ETF(基金) 名称 / 基金代码、
//       名称归一化、批量「整批中止」语义、异步加载路径与代码表不可用的降级。
// 用法：node scripts/verify/verify-stock-lookup.mjs
// 说明：用桩替换 chrome.runtime.getURL 与 fetch（扩展运行时在 Node 里不存在），
//       再用「带 query 的二次 import」拿到一份干净模块实例来验证降级分支。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CACHE_FILE = path.join(REPO, 'assets', 'stock_basic_cache.json');
const MODULE_URL = pathToFileURL(path.join(REPO, 'shared', 'stock_lookup.js')).href;

// ---- 扩展运行时桩：getURL → file://，fetch → 直接读该文件（等价于扩展内读同包资源）
globalThis.chrome = { runtime: { getURL: (p) => pathToFileURL(path.join(REPO, p)).href } };
let fetchImpl = async (url) => ({
    ok: true,
    status: 200,
    json: async () => JSON.parse(fs.readFileSync(new URL(String(url)), 'utf8')),
});
globalThis.fetch = (url, ...rest) => fetchImpl(url, ...rest);

const {
    buildStockIndex, resolveFromIndex, resolveAllFromIndex, normalizeKey,
    resolveStockName, resolveStockNames, resolveErrorText, stockPageUrl, codesOf,
} = await import(MODULE_URL);

const rows = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
const index = buildStockIndex(rows);

let pass = 0;
const failures = [];
function check(title, fn) {
    try {
        fn();
        pass++;
        console.log('  \u2714 ' + title);
    } catch (err) {
        failures.push(title + ' \u2192 ' + err.message);
        console.log('  \u2718 ' + title + ' \u2192 ' + err.message);
    }
}

// ---------------- 1. 单条解析口径 ----------------
console.log('\n[1] 单条解析（真实代码表 ' + index.count + ' 条）');
const CASES = [
    // [输入, 期望 ok, 期望 name, 期望 code.prefix, 期望 source, 期望 reason]
    ['贵州茅台', true, '贵州茅台', '600519.SH', 'exact'],
    ['茅台', true, '贵州茅台', '600519.SH', 'fuzzy'],
    ['宁德', true, '宁德时代', '300750.SZ', 'fuzzy'],
    ['贵 州 茅 台', true, '贵州茅台', '600519.SH', 'exact'],      // 名称归一化：中间空格
    ['贵州茅台1', false, null, null, null, 'not_found'],           // 不做反向包含
    ['贵州茅台 中国稀土', false, null, null, null, 'not_found'],    // 整串不拆分
    ['贵州矛台', false, null, null, null, 'not_found'],            // 错别字
    ['美国稀土', false, null, null, null, 'not_found'],
    ['稀土', false, null, null, null, 'ambiguous'],
    ['平安', false, null, null, null, 'ambiguous'],
    ['600519', true, '贵州茅台', '600519.SH', 'code'],
    ['920229', true, 'N世纪', '920229.BJ', 'code'],                // 北交所
    ['300750', true, '宁德时代', '300750.SZ', 'code'],
    ['999999', false, null, null, null, 'not_found'],
    ['159915', true, '', '159915.SZ', 'code_fund'],                // ETF 按代码可用
    ['510300', true, '', '510300.SH', 'code_fund'],
    ['161725', true, '', '161725.SZ', 'code_fund'],                // 深市 LOF
    ['沪深300ETF', false, null, null, null, 'unsupported_etf'],
    ['ETF', false, null, null, null, 'unsupported_etf'],
    ['', false, null, null, null, 'empty'],
];
for (const [input, ok, name, codePrefix, source, reason] of CASES) {
    check(`${JSON.stringify(input)} → ${ok ? 'ok' : 'fail(' + reason + ')'}`, () => {
        const r = resolveFromIndex(index, input);
        if (r.ok !== ok) throw new Error('ok 期望 ' + ok + '，实际 ' + r.ok + '（' + r.reason + '）');
        if (!ok) {
            if (r.reason !== reason) throw new Error('reason 期望 ' + reason + '，实际 ' + r.reason);
            return;
        }
        if (r.name !== name) throw new Error('name 期望 ' + JSON.stringify(name) + '，实际 ' + JSON.stringify(r.name));
        if (r.code + '.' + r.prefix !== codePrefix) throw new Error('code 期望 ' + codePrefix + '，实际 ' + r.code + '.' + r.prefix);
        if (r.source !== source) throw new Error('source 期望 ' + source + '，实际 ' + r.source);
    });
}
check('多候选返回全部候选名（稀土 → 北方稀土/中国稀土）', () => {
    const r = resolveFromIndex(index, '稀土');
    const names = [...(r.candidates || [])].sort();
    if (names.join('/') !== ['中国稀土', '北方稀土'].sort().join('/')) throw new Error('候选=' + names.join('/'));
});
check('多候选返回全部候选名（平安 → 3 只）', () => {
    const r = resolveFromIndex(index, '平安');
    if (!r.candidates || r.candidates.length !== 3) throw new Error('候选=' + JSON.stringify(r.candidates));
});
check('ST 前缀股按名称可解析（ST康乐 → *ST康乐）', () => {
    const r = resolveFromIndex(index, 'ST康乐');
    if (!r.ok || r.name !== '*ST康乐') throw new Error(JSON.stringify(r));
});

// ---------------- 2. 归一化与索引 ----------------
console.log('\n[2] 归一化与索引');
check('normalizeKey 半角/全角/空白/大小写等价', () => {
    if (normalizeKey(' 贵 州 茅 台 ') !== '贵州茅台') throw new Error(normalizeKey(' 贵 州 茅 台 '));
    if (normalizeKey('贵州　茅台') !== '贵州茅台') throw new Error('全角空格未去除');   // U+3000
    if (normalizeKey('ＴＣＬ中环') !== normalizeKey('TCL中环')) throw new Error('全角英文未归一');
});
check('索引条数与代码表一致且代码唯一', () => {
    if (index.count !== rows.length) throw new Error('count=' + index.count + ' rows=' + rows.length);
    if (index.byCode.size !== rows.length) throw new Error('byCode=' + index.byCode.size);
});
check('空行/坏行被跳过（不影响索引）', () => {
    const idx = buildStockIndex([{ ts_code: '', name: '空' }, { ts_code: '600000.SH', name: '' }, null, { ts_code: '600000.SH', name: '浦发银行' }]);
    if (idx.count !== 1) throw new Error('count=' + idx.count);
    if (!idx.byName.has(normalizeKey('浦发银行'))) throw new Error('正常条目未入库');
});

// ---------------- 3. 批量「整批中止」语义 ----------------
console.log('\n[3] 批量解析（任一失败即整批中止）');
check('全部可解析 → ok:true，items 与输入等长', () => {
    const r = resolveAllFromIndex(index, ['贵州茅台', '中国稀土', '510300']);
    if (!r.ok || r.items.length !== 3) throw new Error(JSON.stringify(r));
    if (r.items[2].code !== '510300') throw new Error('第三项=' + JSON.stringify(r.items[2]));
});
check('含一个错项 → ok:false，errors 只列错项，items 为空', () => {
    const r = resolveAllFromIndex(index, ['贵州茅台', '中国稀土', '美国稀土']);
    if (r.ok) throw new Error('不应为 ok');
    if (r.errors.length !== 1) throw new Error('errors=' + JSON.stringify(r.errors));
    if (r.errors[0].input !== '美国稀土') throw new Error('错项=' + r.errors[0].input);
    if (r.items.length !== 0) throw new Error('整批中止时不应给出 items');
});
check('多候选同样导致整批失败', () => {
    const r = resolveAllFromIndex(index, ['贵州茅台', '稀土']);
    if (r.ok || r.errors[0].reason !== 'ambiguous') throw new Error(JSON.stringify(r));
});

// ---------------- 4. 辅助输出 ----------------
console.log('\n[4] 页面地址 / 代码提取 / 错误文案');
check('stockPageUrl → 雪球个股页', () => {
    if (stockPageUrl({ code: '600519', prefix: 'SH' }) !== 'https://xueqiu.com/S/SH600519') throw new Error(stockPageUrl({ code: '600519', prefix: 'SH' }));
    if (stockPageUrl({ code: '510300', prefix: '' }) !== 'https://xueqiu.com/S/SH510300') throw new Error('未按基金段补前缀');
    if (stockPageUrl({ code: '' }) !== '') throw new Error('无代码应返回空串');
});
check('codesOf 去重并只留 6 位数字', () => {
    const out = codesOf([{ code: '600519' }, '000001', { code: '600519' }, 'abc', '510300']);
    if (out.join(',') !== '600519,000001,510300') throw new Error(out.join(','));
});
check('错误文案包含输入词与可操作建议', () => {
    if (!resolveErrorText({ reason: 'not_found', input: '美国稀土' }).includes('美国稀土')) throw new Error('not_found 文案');
    const amb = resolveErrorText({ reason: 'ambiguous', input: '稀土', candidates: ['北方稀土', '中国稀土'] });
    if (!amb.includes('北方稀土') || !amb.includes('中国稀土')) throw new Error('ambiguous 文案缺候选：' + amb);
    const etf = resolveErrorText({ reason: 'unsupported_etf', input: '沪深300ETF' });
    if (!etf.includes('510300')) throw new Error('ETF 文案缺替代方案：' + etf);
});

// ---------------- 5. 异步路径与降级 ----------------
console.log('\n[5] 异步加载路径与代码表不可用降级');
const rAsync = await resolveStockName('茅台');
check('resolveStockName（异步，走桩 fetch）命中', () => {
    if (!rAsync.ok || rAsync.code !== '600519') throw new Error(JSON.stringify(rAsync));
});
const rBatch = await resolveStockNames(['贵州茅台', '中国稀土']);
check('resolveStockNames 正常批量 → ok', () => {
    if (!rBatch.ok || rBatch.items.length !== 2) throw new Error(JSON.stringify(rBatch));
});
const rBad = await resolveStockNames(['贵州茅台', '美国稀土']);
check('resolveStockNames 含错项 → ok:false + errors', () => {
    if (rBad.ok || rBad.errors.length !== 1) throw new Error(JSON.stringify(rBad));
});

// 降级：带 query 再 import 一次 → 得到独立模块实例，让它的 fetch 直接失败
fetchImpl = async () => { throw new Error('boom'); };
const degraded = await import(MODULE_URL + '?degrade=1');
const rDegrade = await degraded.resolveStockNames(['贵州茅台']);
check('代码表读取失败 → degrade:true（调用方据此回退页面方式）', () => {
    if (rDegrade.degrade !== true || rDegrade.ok) throw new Error(JSON.stringify(rDegrade));
    if (rDegrade.reason !== 'cache_unavailable') throw new Error('reason=' + rDegrade.reason);
});
const rDegradeOne = await degraded.resolveStockName('贵州茅台');
check('单只解析同样降级（不抛错）', () => {
    if (rDegradeOne.degrade !== true) throw new Error(JSON.stringify(rDegradeOne));
});
fetchImpl = async () => ({ ok: false, status: 404, json: async () => [] });
const notFoundModule = await import(MODULE_URL + '?degrade=2');
const r404 = await notFoundModule.resolveStockNames(['贵州茅台']);
check('HTTP 404 → 降级（不视作解析失败）', () => {
    if (r404.degrade !== true) throw new Error(JSON.stringify(r404));
});

// ---------------- 汇总 ----------------
console.log(`\n结果：通过 ${pass} 项${failures.length ? `，失败 ${failures.length} 项` : '，全部通过'}`);
if (failures.length) {
    failures.forEach(f => console.log('  - ' + f));
    process.exit(1);
}
