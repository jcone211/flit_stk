// verify-quickopen-landing.mjs —— 模拟 landCapturedDocument 新控制流：
// 1) 快速打开/浏览的非命中页面在解析前直接忽略（不解析、不落地、不报错）；
// 2) 命中监控股票的页面才解析落地；
// 3) 命中但解析失败才上报「数据更新失败」。
// 复刻 background/landing.js 的顺序与匹配逻辑（URL/搜索词匹配，不依赖解析结果）。
import assert from 'node:assert/strict';

// 等价性规范化比较（shared/utils.js normalizeCompareUrl 的复刻）：
// 忽略 www. 前缀差与 sign 参数；雪球 /S/ 页 query 均为站内跟踪参数，一并忽略
const normalizeCompareUrl = (u) => {
    if (!u) return u;
    try {
        const url = new URL(String(u));
        url.hostname = url.hostname.replace(/^www\./i, '');
        if (url.hostname === 'xueqiu.com' && /^\/S\//.test(url.pathname)) {
            url.search = '';
        } else {
            url.searchParams.delete('sign');
        }
        return url.href;
    } catch { return u; }
};
const searchWordOf = (url) => {
    try { return new URL(url).searchParams.get('w') || new URL(url).searchParams.get('q') || ''; }
    catch { return ''; }
};
// 基础名归一 / 搜索词名字匹配（shared/utils.js baseStockName + nameMatchesSearchWord 的复刻）：
// 去交易所除权除息临时前缀 XD/XR/DR；不等时按包含关系兜底（数据源名称列会截短，较短一方至少 3 字）
const baseStockName = (name) => String(name == null ? '' : name).replace(/\s+/g, '').replace(/^(?:XD|XR|DR)+/i, '');
const nameMatchesSearchWord = (name, word) => {
    const a = baseStockName(name);
    const b = baseStockName(word);
    if (!a || !b) return false;
    if (a === b) return true;
    const short = a.length <= b.length ? a : b;
    if (short.length < 3) return false;
    return a.includes(b) || b.includes(a);
};
const effectiveStockUrl = (s) => s.url;

// —— 简化环境：一份组合（贵州茅台 url=A），一次 offscreen 解析计数 ——
let parseCount = 0;
const portfolios = {
    持仓: {
        selectorName: 'wc1',
        stockList: [
            { url: 'https://www.iwencai.com/screener/result?w=%E8%B4%B5%E5%B7%9E%E8%8C%85%E5%8F%B0&querytype=stock', name: '贵州茅台', stopRunning: false },
        ],
    },
};

async function land(documentData, { emitLanded, parseViaOffscreen }, effOverride) {
    if (!documentData || !documentData.html) return false;
    const messageUrl = documentData.url;
    const key = messageUrl.includes('xueqiu.com') ? 'xq1' : 'wc1'; // selectorKeyForUrl 简化
    if (!key) return false;

    const storage = { portfolios };
    const activePortfolio = '持仓';
    const stockList = storage.portfolios[activePortfolio].stockList;

    const eff = effOverride || effectiveStockUrl; // 用例可用雪球拼接地址覆盖
    const strippedMsg = normalizeCompareUrl(messageUrl);
    const msgWord = searchWordOf(messageUrl);
    const redirectSync = [];
    const matchStock = (s, sn) => {
        if (normalizeCompareUrl(s.url) === strippedMsg || normalizeCompareUrl(eff(s, sn)) === strippedMsg) return true;
        if (msgWord && nameMatchesSearchWord(s.name, msgWord)) { redirectSync.push([s, strippedMsg]); return true; }
        return false;
    };
    const activeSn = storage.portfolios[activePortfolio].selectorName || 'wc1';
    const index = stockList.findIndex(s => matchStock(s, activeSn));
    const others = [];
    if (index === -1) {
        for (const name of Object.keys(storage.portfolios)) {
            if (name === activePortfolio) continue;
            const sn = storage.portfolios[name].selectorName || 'wc1';
            for (const s of storage.portfolios[name].stockList || []) {
                if (matchStock(s, sn)) others.push(s);
            }
        }
    }
    if (index === -1 && others.length === 0) return false; // 未命中：解析前直接忽略

    const targets = [];
    if (index !== -1) targets.push(stockList[index]);
    targets.push(...others);
    const activeTargets = documentData.fullRefresh ? targets : targets.filter(s => !s.stopRunning);
    if (activeTargets.length === 0) return false;

    const parsed = await parseViaOffscreen(key, documentData.html); // 命中后才解析
    if (!parsed) { emitLanded(true); return false; }

    redirectSync.forEach(([s, url]) => { s.url = url; });
    for (const s of activeTargets) s.currentPrice = parsed.currentPrice;
    emitLanded(false);
    return true;
}

const errors = [];

// 用例 1：快速打开非组合股票（如「中国平安」问财搜索页）→ 忽略，不解析、不报错
{
    parseCount = 0;
    let landedFlag = null;
    const result = await land({
        url: 'https://www.iwencai.com/screener/result?w=%E4%B8%AD%E5%9B%BD%E5%B9%B3%E5%AE%89&querytype=stock',
        html: '<html>...</html>',
    }, {
        emitLanded: (e) => { landedFlag = e; },
        parseViaOffscreen: async () => { parseCount++; return { currentPrice: 10 }; },
    });
    assert.equal(result, false, '非命中页面应返回 false');
    assert.equal(parseCount, 0, '非命中页面不应触发解析');
    assert.equal(landedFlag, null, '非命中页面不应上报任何落地通知（含失败）');
    console.log('✓ 用例1：非组合股票的快速打开页 → 不解析、不落地、不报错');
}

// 用例 2：快速打开恰好在组合里的股票（贵州茅台搜索页）→ 仍会解析落地（组合内命中，等价于监控/刷新语义）
{
    parseCount = 0;
    let landedFlag = null;
    const result = await land({
        url: 'https://www.iwencai.com/screener/result?w=%E8%B4%B5%E5%B7%9E%E8%8C%85%E5%8F%B0&querytype=stock',
        html: '<html>...</html>',
    }, {
        emitLanded: (e) => { landedFlag = e; },
        parseViaOffscreen: async () => { parseCount++; return { currentPrice: 999 }; },
    });
    assert.equal(result, true, '命中页面应落地成功');
    assert.equal(parseCount, 1, '命中页面应触发解析');
    assert.equal(landedFlag, false, '解析成功应上报 DATA_LANDED');
    assert.equal(portfolios.持仓.stockList[0].currentPrice, 999, '命中股票价格应被更新');
    console.log('✓ 用例2：组合内股票的页面 → 命中后解析落地、上报 DATA_LANDED');
}

// 用例 3：组合内股票页面解析失败 → 只在此上报「数据更新失败」
{
    parseCount = 0;
    let landedFlag = null;
    const result = await land({
        url: 'https://www.iwencai.com/screener/result?w=%E8%B4%B5%E5%B7%9E%E8%8C%85%E5%8F%B0&querytype=stock',
        html: '<html>...</html>',
    }, {
        emitLanded: (e) => { landedFlag = e; },
        parseViaOffscreen: async () => { parseCount++; return null; },
    });
    assert.equal(result, false, '解析失败应返回 false');
    assert.equal(parseCount, 1, '命中页面解析失败也走了一次解析');
    assert.equal(landedFlag, true, '命中页面解析失败才上报 DATA_LAND_ERROR');
    console.log('✓ 用例3：命中股票解析失败 → 才上报「数据更新失败」');
}

// 用例 4：快速打开命中组合外页面 + 解析失败 → 不报错（此前会误报）
{
    parseCount = 0;
    let landedFlag = null;
    const result = await land({
        url: 'https://xueqiu.com/k?q=%E4%B8%AD%E5%9B%BD%E5%B9%B3%E5%AE%89',
        html: '<html>...</html>',
    }, {
        emitLanded: (e) => { landedFlag = e; },
        parseViaOffscreen: async () => { parseCount++; return null; },
    });
    assert.equal(result, false, '非命中页面应返回 false');
    assert.equal(parseCount, 0, '非命中页面即使「解析会失败」也不触发解析');
    assert.equal(landedFlag, null, '非命中页面解析失败不应误报 DATA_LAND_ERROR');
    console.log('✓ 用例4：非组合股票页即使解析会失败 → 也不误报「数据更新失败」');
}

// 用例 5：雪球个股页 www/非 www 等价——调度地址存为 https://xueqiu.com/S/SZ002155 不带 www，
// 页面实际加载后 URL 变成 https://www.xueqiu.com/S/SZ002155（或带 from 跟踪参数），
// 纯字符串比较会失配导致数据静默不落地；规范化比较应命中并落地
{
    parseCount = 0;
    let landedFlag = null;
    const eff = (s, sn) => `https://xueqiu.com/S/SZ002155`; // effectiveStockUrl 的雪球拼接结果（不带 www）
    const stock = { url: 'https://xueqiu.com/S/SZ002155', name: '湖南黄金', currentPrice: null, stopRunning: false };
    portfolios.持仓.stockList[0] = stock;
    const result = await land({
        url: 'https://www.xueqiu.com/S/SZ002155?from=status_stock_match', // 实际页面地址带 www + 跟踪参数
        html: '<html>...</html>',
    }, {
        emitLanded: (e) => { landedFlag = e; },
        parseViaOffscreen: async () => { parseCount++; return { currentPrice: 12.34 }; },
    }, eff);
    assert.equal(result, true, 'www/非 www 等价地址应命中落地');
    assert.equal(parseCount, 1, '命中页面应触发解析');
    assert.equal(landedFlag, false, '解析成功应上报 DATA_LANDED');
    assert.equal(stock.currentPrice, 12.34, '命中股票价格应被更新');
    console.log('✓ 用例5：雪球 www/非 www + from 跟踪参数 → 规范化比较命中并落地');
}

// 用例 6：除权除息日条目名带 XD 前缀（行情接口把 601678 存成「XD滨化股」，且名称被源端截短，
// 剥前缀只能得到「滨化股」而非「滨化股份」）而页面搜索词是用户当初输入的「滨化股份」——
// 严格相等的名称比较会整天匹配不上、数据静默不落地；基础名归一 + 截短包含兜底后应命中，
// 并把条目地址同步为实际详情页地址
{
    parseCount = 0;
    let landedFlag = null;
    const stock = {
        url: 'https://www.iwencai.com/screener/result?w=%E6%BB%A8%E5%8C%96%E8%82%A1%E4%BB%BD&querytype=stock',
        name: 'XD滨化股', code: '601678', prefix: 'SH', currentPrice: null, stopRunning: false,
    };
    portfolios.持仓.stockList[0] = stock;
    const landedUrl = 'https://www.iwencai.com/unifiedwap/result?w=%E6%BB%A8%E5%8C%96%E8%82%A1%E4%BB%BD&querytype=stock';
    const result = await land({ url: landedUrl, html: '<html>...</html>' }, {
        emitLanded: (e) => { landedFlag = e; },
        parseViaOffscreen: async () => { parseCount++; return { currentPrice: 5.95 }; },
    });
    assert.equal(result, true, 'XD 前缀条目应靠基础名归一命中并落地');
    assert.equal(parseCount, 1, '命中页面应触发解析');
    assert.equal(landedFlag, false, '解析成功应上报 DATA_LANDED');
    assert.equal(stock.currentPrice, 5.95, '命中股票价格应被更新');
    // 同步写入的是规范化后的地址（normalizeCompareUrl 会去掉 www.），比较时同口径
    assert.equal(stock.url, normalizeCompareUrl(landedUrl), '命中后条目地址同步为实际详情页地址');
    console.log('✓ 用例6：除权日「XD滨化股」条目 + 基础名搜索词「滨化股份」→ 归一后命中并落地');
}

if (errors.length) { console.error(errors); process.exit(1); }
console.log('\n全部用例通过');
