// 一键导入竞态模拟：验证「导入 → 旧股票页面落地覆盖镜像」是否会把新导入的行删除。
// 逻辑与 popup/popup.js::executeQuickImport、background/landing.js::landCapturedDocument 一致，
// 只复刻与竞态相关的读-改-写回代码路径。
import assert from 'node:assert/strict';

// mock storage：仅实现 get/set 两个键的读改写
function makeStorage(seed) {
    let store = structuredClone(seed);
    return {
        get(keys) {
            const out = {};
            keys.forEach(k => { out[k] = store[k]; });
            return out;
        },
        set(obj) { Object.assign(store, structuredClone(obj)); },
        dump: () => store,
    };
}

// ---------- 被测端：popup 一键导入 ----------
function importStocks(storage, portfolios, activePortfolio, stockList, items, fixed) {
    const name = activePortfolio; // 模拟导入到当前活动组合（弹窗默认选中项）
    const target = portfolios[name].stockList;
    const now = Date.now();
    items.forEach(item => {
        target.push({
            url: `https://www.iwencai.com/screener/result?w=${item}&querytype=stock`,
            name: item, code: '', prefix: '',
            startPrice: null, currentPrice: null, percent: null, importPrice: null,
            targetPercentLe: '', targetPercentGe: '', importTargetPercentLe: '', importTargetPercentGe: '',
            stopRunning: false, notifiedDaily: false, notifiedImport: false,
            inTrash: false, pinned: false, pinOrder: null, createdAt: now,
        });
    });
    if (fixed) {
        // 修复后：镜像与组合列表指向同一数组，随 portfolios 一并写入
        stockList = target;
        storage.set({ portfolios, stockList });
    } else {
        // 修复前：只写 portfolios，镜像缺失新增项
        storage.set({ portfolios });
    }
}

// ---------- 被测端：background/landing.js 落地一条股票页面 ----------
function land(storage, pageUrl, fixed) {
    const { stockList: mirror, portfolios, activePortfolio } = storage.get(['stockList', 'portfolios', 'activePortfolio']);
    let portfoliosVar, activePortfolioVar, stockListVar;
    if (fixed) {
        // 修复后：以组合为唯一事实源推导活动镜像
        portfoliosVar = portfolios || {};
        activePortfolioVar = activePortfolio || '持仓';
        stockListVar = (portfoliosVar[activePortfolioVar] && Array.isArray(portfoliosVar[activePortfolioVar].stockList))
            ? portfoliosVar[activePortfolioVar].stockList
            : (mirror || []);
    } else {
        // 修复前：直接用 storage.stockList 镜像
        portfoliosVar = portfolios || {};
        activePortfolioVar = activePortfolio || '持仓';
        stockListVar = mirror || [];
    }
    const stripped = stripUrl(pageUrl);
    const matchStock = (s, sn) => stripUrl(s.url) === stripped;
    const index = stockListVar.findIndex(s => matchStock(s, 'wc1'));
    if (index === -1) return false;      // 未命中 → ignored（不写回）
    stockListVar[index].currentPrice = 100; // 模拟行情落地
    if (portfoliosVar[activePortfolioVar]) portfoliosVar[activePortfolioVar].stockList = stockListVar;
    storage.set({ stockList: stockListVar, portfolios: portfoliosVar });
    return true;
}

const stripUrl = u => String(u).replace(/[?#].*$/, '');

function runCase(fixedPopup, fixedLanding, label) {
    const storage = makeStorage({
        stockList: [ { url: 'https://www.iwencai.com/screener/result?w=旧股票&querytype=stock', name: '旧股票', currentPrice: null } ],
        portfolios: {
            持仓: { selectorName: 'wc1', stockList: [ { url: 'https://www.iwencai.com/screener/result?w=旧股票&querytype=stock', name: '旧股票', currentPrice: null } ] },
        },
        activePortfolio: '持仓',
    });
    // 1) popup 一键导入「新股票」到当前组合
    let stockList = storage.dump().stockList; // popup 从 getStatus 反序列化的独立镜像副本
    let portfolios = storage.dump().portfolios;
    const activePortfolio = '持仓';
    importStocks(storage, portfolios, activePortfolio, stockList, ['新股票'], fixedPopup);
    const afterImport = storage.dump();
    const newStockStillThere = afterImport.portfolios['持仓'].stockList.some(s => s.name === '新股票');
    assert.ok(newStockStillThere, label + ': 导入后组合里应含新股票');

    // 2) 稍后：旧股票页面落地（读 storage → 匹配 → 写回）
    land(storage, 'https://www.iwencai.com/screener/result?w=旧股票&querytype=stock', fixedLanding);

    // 3) 检查新股票是否被覆盖删除
    const finalPorts = storage.dump().portfolios['持仓'].stockList.map(s => s.name);
    const survived = finalPorts.includes('新股票');
    console.log(`${label}: 落地后组合列表 = [${finalPorts.join(', ')}] → 新股票${survived ? '保留 ✓' : '被删除 ✗'}`);
    return survived;
}

let ok = true;
// 修复前（只写 portfolios + landing 直接信storage镜像）：应复现删除
ok = runCase(false, false, '修复前') || ok;
// 修复后 popup（同时写镜像）但 landing 未改：应保留
ok = runCase(true, false, '修复后-actPopup') && ok;
// 修复后 landing（镜像以组合为准）但 popup 未改：应保留
ok = runCase(false, true, '修复后-actLanding') && ok;
// 全部修复：应保留
ok = runCase(true, true, '修复后-both') && ok;

console.log(ok ? '\n全部场景符合预期' : '\n存在不符合预期的场景');
process.exit(ok ? 0 : 1);