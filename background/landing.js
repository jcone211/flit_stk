// landing.js —— 数据落地单点（SW 内模块）：页面抓取（经 offscreen 隐藏页解析）与
// API 批量行情的匹配、写入、阈值通知全部在 Service Worker 完成，popup 只负责展示，
// 弹窗关闭期间监控数据照常入库、通知照常触发。
// 写入一律「读 storage 最新 → 合并 → 写回」，不依赖内存快照，避免覆盖外部（AI 窗口/popup）写入。

import {
    stripSign, effectiveStockUrl, selectorKeyForUrl,
} from '../shared/utils.js';
import { applyThresholds } from '../popup/notifications.js';

const OFFSCREEN_URL = 'offscreen/offscreen.html';

// ---------------- offscreen 解析页管理 ----------------

let offscreenCreating = null;

async function hasOffscreen() {
    if (chrome.runtime.getContexts) { // Chrome 116+
        const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
        return contexts.length > 0;
    }
    const clients = await self.clients.matchAll({ includeUncontrolled: true });
    return clients.some(c => c.url === chrome.runtime.getURL(OFFSCREEN_URL));
}

// 按需创建解析页（串行化创建，避免并发 createDocument 报「已存在」）
async function ensureOffscreen() {
    if (await hasOffscreen()) return;
    if (!offscreenCreating) {
        offscreenCreating = chrome.offscreen.createDocument({
            url: OFFSCREEN_URL,
            reasons: ['DOM_PARSER'],
            justification: '解析股票页面 HTML 提取行情（Service Worker 无 DOMParser）',
        }).finally(() => { offscreenCreating = null; });
    }
    await offscreenCreating;
}

function rawSend(msg, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('offscreen 解析超时')), timeoutMs);
        chrome.runtime.sendMessage(msg, (resp) => {
            clearTimeout(timer);
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else resolve(resp);
        });
    });
}

// 经 offscreen 解析 HTML：{ key, html } → parseWc1/parseXq1 的结果（失败返回 null）
async function parseViaOffscreen(key, html) {
    await ensureOffscreen();
    for (let attempt = 0; ; attempt++) {
        try {
            const resp = await rawSend({ action: 'parseDocument', key, html });
            return (resp && !resp.error) ? resp.parsed : null;
        } catch (err) {
            // 页面刚创建尚未监听 / 意外丢失：重建后短重试
            if (attempt >= 2) {
                console.warn('[thswc:bg] offscreen 解析失败:', err.message);
                return null;
            }
            await ensureOffscreen().catch(() => {});
            await new Promise(r => setTimeout(r, 150));
        }
    }
}

// ---------------- storage 工具与 popup 通知 ----------------

const getLocal = (keys) => new Promise(resolve => chrome.storage.local.get(keys, resolve));
const setLocal = (obj) => new Promise(resolve => chrome.storage.local.set(obj, resolve));

// 落地完成/失败回调（background 注入：popup 开着时刷新「上次更新时间」角标）
let notifyPopup = null;
export function setLandingNotifier(fn) { notifyPopup = fn; }
function emitLanded(error = false) {
    if (!notifyPopup) return;
    try { notifyPopup(error); } catch { /* 通知失败不影响落地 */ }
}

// ---------------- 页面抓取落地 ----------------

// 提取消息 URL 中的搜索词（问财 w= / 雪球 q=），搜索页跳转详情页后兜底匹配用
function searchWordOf(url) {
    try {
        const u = new URL(url);
        return u.searchParams.get('w') || u.searchParams.get('q') || '';
    } catch { return ''; }
}

// 落地一条页面抓取：匹配股票（当前组合优先，未命中查其他组合）→ 更新字段 →
// 阈值通知 → 读-改-写回 storage。返回是否落地成功
export async function landCapturedDocument(documentData) {
    if (!documentData || !documentData.html) return false;
    const messageUrl = documentData.url;
    const key = selectorKeyForUrl(messageUrl);
    if (!key) return false;
    const parsed = await parseViaOffscreen(key, documentData.html);
    if (!parsed) {
        console.warn('[thswc:bg] 解析失败/名称为空（选择器可能已失效）:', messageUrl);
        emitLanded(true);
        return false;
    }

    const storage = await getLocal(['stockList', 'portfolios', 'activePortfolio']);
    const stockList = storage.stockList || [];
    const portfolios = storage.portfolios || {};
    const activePortfolio = storage.activePortfolio || '持仓';

    const strippedMsg = stripSign(messageUrl);
    const msgWord = searchWordOf(messageUrl);
    // 搜索词兜底：精确匹配失效时按「消息 URL 的搜索参数与股票名称一致」匹配；
    // 地址同步（搜索页跳转后的实际详情页 URL）在解析成功后才生效，避免解析失败污染数据
    const redirectSync = [];
    const matchStock = (s, sn) => {
        if (stripSign(s.url) === strippedMsg
            || stripSign(effectiveStockUrl(s, sn)) === strippedMsg) return true;
        if (msgWord && s.name === msgWord) {
            redirectSync.push([s, strippedMsg]);
            return true;
        }
        return false;
    };
    // 当前组合优先（findIndex 语义：只取第一只命中）
    const activeSn = (portfolios[activePortfolio] && portfolios[activePortfolio].selectorName) || 'wc1';
    const index = stockList.findIndex(s => matchStock(s, activeSn));
    // 当前组合未命中时，继续到其他组合查找（一键/cron 全量刷新会刷新全部组合，
    // 非活动组合的数据也要落库）
    const others = [];
    if (index === -1) {
        for (const name of Object.keys(portfolios)) {
            if (name === activePortfolio) continue;
            const sn = (portfolios[name].selectorName) || 'wc1'; // 各组合独立的选择器
            for (const s of portfolios[name].stockList || []) {
                if (matchStock(s, sn)) others.push(s);
            }
        }
    }
    if (index === -1 && others.length === 0) {
        return false; // 未加入监控列表的页面（快速打开等）直接忽略，避免普通浏览误报
    }

    // 应用到命中的全部股票（当前组合 + 其他组合同 URL 的）；
    // 全量刷新（带 fullRefresh 标记）忽略单只股票的停止刷新，全部写入；
    // 监控周期的抓取仍跳过已停止的股票（其不被调度刷新）
    const targets = [];
    if (index !== -1) targets.push(stockList[index]);
    targets.push(...others);
    const activeTargets = documentData.fullRefresh ? targets : targets.filter(s => !s.stopRunning);
    if (activeTargets.length === 0) return false;

    redirectSync.forEach(([s, url]) => { s.url = url; });
    for (const stock of activeTargets) {
        stock.name = parsed.name;
        if (parsed.code) stock.code = parsed.code;
        if (parsed.prefix) stock.prefix = parsed.prefix;
        if (parsed.lastClose != null) stock.startPrice = parsed.lastClose;
        if (parsed.currentPrice != null) {
            stock.currentPrice = parsed.currentPrice;
            if (stock.importPrice == null) stock.importPrice = parsed.currentPrice; // 初始价首次回填
        }
        if (parsed.percent != null) stock.percent = parsed.percent;
        stock.lastUpdateAt = documentData.timestamp || Date.now(); // 股票级最新刷新时间
        applyThresholds(stock);
    }
    // 同步写回活动组合镜像，避免切换组合时读到旧价格
    if (portfolios[activePortfolio]) portfolios[activePortfolio].stockList = stockList;
    await setLocal({ stockList, portfolios });
    emitLanded(false);
    return true;
}

// ---------------- API 批量行情落地 ----------------

// 落地一批 API 行情：按 code 跨组合匹配（当前组合 + 其他组合），更新并阈值通知
export async function landApiQuotes(quotes) {
    if (!Array.isArray(quotes) || quotes.length === 0) return false;
    const storage = await getLocal(['stockList', 'portfolios', 'activePortfolio']);
    const stockList = storage.stockList || [];
    const portfolios = storage.portfolios || {};
    const activePortfolio = storage.activePortfolio || '持仓';

    const codeMap = new Map(); // code -> [stock...]
    const collect = (list) => {
        (list || []).forEach(s => {
            const c = String(s.code || '').trim();
            if (!c) return;
            if (!codeMap.has(c)) codeMap.set(c, []);
            codeMap.get(c).push(s);
        });
    };
    collect(stockList);
    Object.keys(portfolios).forEach(name => {
        if (name === activePortfolio) return; // 当前组合已收集
        collect(portfolios[name].stockList);
    });

    const updated = [];
    quotes.forEach(q => {
        const c = String(q.code || '').trim();
        (codeMap.get(c) || []).forEach(s => { applyQuoteToStock(s, q); updated.push(s); });
    });
    if (updated.length === 0) return false;

    updated.forEach(s => applyThresholds(s));
    if (portfolios[activePortfolio]) portfolios[activePortfolio].stockList = stockList;
    await setLocal({ stockList, portfolios });
    emitLanded(false);
    return true;
}

// API 行情字段映射到股票条目（昨收取 last_close，涨跌幅取 change_pct）
function applyQuoteToStock(stock, q) {
    if (q.name) stock.name = q.name;
    if (q.price != null) {
        stock.currentPrice = q.price;
        if (stock.importPrice == null) stock.importPrice = q.price; // 初始价首次回填
    }
    if (q.change_pct != null) stock.percent = q.change_pct;
    if (q.last_close != null) stock.startPrice = q.last_close;
    stock.lastUpdateAt = Date.now(); // 股票级最新刷新时间
}
