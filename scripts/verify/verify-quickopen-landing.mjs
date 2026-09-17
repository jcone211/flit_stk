// verify-quickopen-landing.mjs —— 模拟 landCapturedDocument 新控制流：
// 1) 快速打开/浏览的非命中页面在解析前直接忽略（不解析、不落地、不报错）；
// 2) 命中监控股票的页面才解析落地；
// 3) 命中但解析失败才上报「数据更新失败」。
// 复刻 background/landing.js 的顺序与匹配逻辑（URL/搜索词匹配，不依赖解析结果）。
import assert from 'node:assert/strict';

const stripSign = (u) => String(u || '').replace(/^https?:/, '').replace(/\/$/, '');
const searchWordOf = (url) => {
    try { return new URL(url).searchParams.get('w') || new URL(url).searchParams.get('q') || ''; }
    catch { return ''; }
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

async function land(documentData, { emitLanded, parseViaOffscreen }) {
    if (!documentData || !documentData.html) return false;
    const messageUrl = documentData.url;
    const key = messageUrl.includes('xueqiu.com') ? 'xq1' : 'wc1'; // selectorKeyForUrl 简化
    if (!key) return false;

    const storage = { portfolios };
    const activePortfolio = '持仓';
    const stockList = storage.portfolios[activePortfolio].stockList;

    const strippedMsg = stripSign(messageUrl);
    const msgWord = searchWordOf(messageUrl);
    const redirectSync = [];
    const matchStock = (s, sn) => {
        if (stripSign(s.url) === strippedMsg || stripSign(effectiveStockUrl(s, sn)) === strippedMsg) return true;
        if (msgWord && s.name === msgWord) { redirectSync.push([s, strippedMsg]); return true; }
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

if (errors.length) { console.error(errors); process.exit(1); }
console.log('\n全部用例通过');
