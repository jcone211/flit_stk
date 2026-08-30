import { stripSign, effectiveStockUrl, isKnownMarketPrefix } from '../shared/utils.js';
import { nextCronTime, isTradingTime } from '../shared/cron.js';
import { batchQuotes } from '../js/xiaoshi_realtime_quote.js';
import { batchQuotes as adataBatchQuotes } from '../js/adata_realtime_quote.js';
import { streamAiChat } from '../ai/ai_backend.js';
import { landCapturedDocument, landApiQuotes, setLandingNotifier } from './landing.js';

// 默认组合（不可删除、不可重命名）
const DEFAULT_PORTFOLIOS = ['默认', '持仓', '观察'];
const DEFAULT_CRON_JOBS = [
    { id: 'default-morning', expr: '*/3 9-11 * * 1-5', enabled: true },
    { id: 'default-afternoon', expr: '*/3 13-14 * * 1-5', enabled: true },
    { id: 'default-close', expr: '5 15 * * 1-5', enabled: true },
];

// 诊断日志开关：排查完成后置 false 可停止周期性刷屏
const DEBUG = false;
const dbg = (...args) => { if (DEBUG) console.log('[thswc:bg]', ...args); };

// 后台服务worker，处理定时刷新逻辑
let refreshInterval = 60; // 默认60秒
let selectorName = '';
let currentView = 'list'; // 当前列表视图：'list' 股票列表 | 'trash' 垃圾池
let popupPort = null;

// 数据落地完成/失败 → popup 开着时刷新「上次更新时间」角标（列表数据由 popup 经 onChanged 自行刷新）
setLandingNotifier((error) => {
    if (!popupPort) return;
    try {
        popupPort.postMessage(error ? { type: 'DATA_LAND_ERROR' } : { type: 'DATA_LANDED' });
    } catch { /* 窗口已关闭 */ }
});

// 各股票一次性刷新 alarm 的名称前缀
const STOCK_ALARM_PREFIX = 'refreshStock:';
// cron 定时器一次性 alarm 的名称前缀
const CRON_ALARM_PREFIX = 'cronJob:';
// 全量刷新（一键/cron）后抓取放开的窗口（毫秒）：监控未运行时也允许解析，
// 覆盖所有标签页加载+抓取的时间（逐支打开，耗时与股票数量成正比，按 5 分钟放宽）；
// 超过窗口仍未关闭的旧抓取继续按丢弃处理
const ALLOW_CAPTURE_WINDOW_MS = 300000;
let allowCapturedUntil = 0;

init();

chrome.runtime.onConnect.addListener((port) => {
    if (port.name === 'popup-connection') {
        popupPort = port;
        port.onDisconnect.addListener(() => {
            popupPort = null;
        });
    } else if (port.name === 'ai-chat-connection') {
        // AI 对话窗口：断连时中止该窗口全部在途 LLM 请求，避免浪费 token
        port.onMessage.addListener((msg) => handleAiChatMessage(port, msg));
        port.onDisconnect.addListener(() => {
            for (const [requestId, entry] of aiChatRequests) {
                if (entry.port === port) {
                    entry.controller.abort();
                    aiChatRequests.delete(requestId);
                }
            }
        });
    }
});

// 监听标签页更新，动态注入脚本
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status !== 'complete' || !isMonitoredUrl(tab.url)) return;

    chrome.scripting.executeScript({
        target: { tabId },
        files: ['content/content.js']
    }).catch(err => console.error('脚本执行失败:', err));
});

function isMonitoredUrl(url) {
    if (!url) return false;

    try {
        const { hostname } = new URL(url);
        return hostname === 'iwencai.com' || hostname.endsWith('.iwencai.com')
            || hostname === 'xueqiu.com' || hostname.endsWith('.xueqiu.com');
    } catch {
        return false;
    }
}



chrome.action.onClicked.addListener(() => {
    chrome.storage.local.get('popupWindowId', ({ popupWindowId }) => {
        if (popupWindowId !== null && popupWindowId !== undefined) {
            chrome.windows.remove(popupWindowId, () => {
                chrome.storage.local.set({ popupWindowId: null });
            });
        } else {
            // 分页后窗口高度按每页条数算，避免按全量股票列表撑高
            chrome.storage.local.get(['stockList', 'currentView'], (localData) => {
                chrome.storage.sync.get(['pageSize'], (syncData) => {
                    const view = localData.currentView || 'list';
                    const stockCount = (localData.stockList || []).filter(s => view === 'trash' ? s.inTrash : !s.inTrash).length;
                    const pageSize = syncData.pageSize || 10;
                    const rows = Math.min(stockCount, pageSize);
                    chrome.windows.getCurrent((currentWindow) => {
                        chrome.windows.create({
                            url: chrome.runtime.getURL('popup.html'),
                            type: 'popup',
                            width: 580,
                            height: 520 + Math.max(rows - 2, 0) * 56,
                            left: currentWindow.width - 400,
                            top: 50
                        }, (newWindow) => {
                            chrome.storage.local.set({ popupWindowId: newWindow.id, popupWindowWidth: 580 });
                        });
                    });
                });
            });
        }
    })
});

// 监听窗口关闭：按全局设置决定是否继续监控/全量刷新
chrome.windows.onRemoved.addListener((closedWindowId) => {
    chrome.storage.local.get(['popupWindowId', 'stockWindowId', 'aiWindowId'], ({ popupWindowId, stockWindowId, aiWindowId }) => {
        if (closedWindowId === popupWindowId) {
            chrome.storage.local.set({ popupWindowId: null });
            chrome.storage.sync.get(['keepMonitoringOnClose', 'keepRefreshOnClose'], ({ keepMonitoringOnClose, keepRefreshOnClose }) => {
                if (!keepMonitoringOnClose) {
                    clearMonitorAlarms();
                }
                if (!keepRefreshOnClose) {
                    // 不继续全量刷新时，清掉 cron 定时器
                    chrome.alarms.getAll((alarms) => {
                        alarms.filter(a => a.name.startsWith(CRON_ALARM_PREFIX))
                            .forEach(a => chrome.alarms.clear(a.name));
                    });
                }
            });
        }
        if (closedWindowId === stockWindowId) {
            chrome.storage.local.set({ stockWindowId: null });
        }
        if (closedWindowId === aiWindowId) {
            chrome.storage.local.set({ aiWindowId: null });
        }
    });
});

// 初始化：先做幂等迁移，再加载设置，并补排 cron 定时器
function init() {
    ensureMigrated().then(() => {
        chrome.storage.sync.get(['refreshInterval', 'selectorName', 'keepRefreshOnClose', 'cronJobs'], (result) => {
            if (!Array.isArray(result.cronJobs)) {
                chrome.storage.sync.set({ cronJobs: DEFAULT_CRON_JOBS }, () => {
                    if (result.keepRefreshOnClose !== false) {
                        scheduleCronAlarms();
                    }
                });
            }
            if (result.refreshInterval) {
                refreshInterval = result.refreshInterval;
            }
            if (result.selectorName) {
                selectorName = result.selectorName;
            }
            if (Array.isArray(result.cronJobs) && result.keepRefreshOnClose !== false) {
                scheduleCronAlarms(); // SW 冷启动时 cron 一次性 alarm 由浏览器托管不丢，此处仅兜底补排
            }
        });
    });
}

// 幂等迁移：确保 stockList 在 storage.local 且字段已补齐。
// background 是唯一迁移执行者，popup 只经 getStatus 读迁移后的数据。
function ensureMigrated() {
    if (ensureMigrated.promise) return ensureMigrated.promise;
    ensureMigrated.promise = new Promise((resolve) => {
        chrome.storage.local.get(['stockList', 'currentView', 'portfolios', 'activePortfolio', 'keyPoints', 'events'], (localResult) => {
            if (localResult.currentView) {
                currentView = localResult.currentView;
            }
            const finish = (list) => {
                const migratedList = migrateStockFields(list);
                // 组合迁移：确保三个默认组合存在（幂等）
                chrome.storage.sync.get(['selectorName'], (syncSel) => {
                    const currentSelector = syncSel.selectorName || '';
                    const portfolios = localResult.portfolios || {};

                    // 补全缺失的默认组合
                    DEFAULT_PORTFOLIOS.forEach(name => {
                        if (!portfolios[name]) {
                            portfolios[name] = { stockList: [], selectorName: currentSelector };
                        }
                    });

                    // 首次迁移：将原有 stockList 放入「默认」
                    if (!localResult.portfolios) {
                        portfolios['默认'].stockList = migratedList;
                    }

                    const activePortfolio = localResult.activePortfolio || '持仓';

                    // 要点和事件：仅当键不存在时写入默认数据（幂等，绝不覆盖已有数据——
                    // 不使用「读回再写回」，避免极端时序下用旧值覆盖 popup 刚保存的新值）
                    const write = { stockList: migratedList, portfolios, activePortfolio };
                    if (!('keyPoints' in localResult)) {
                        write.keyPoints = [
                            { text: '跌到波段新低放量', weight: 10 },
                            { text: '波段新底暴跌但缩量', weight: 9 },
                            { text: 'MACD底背离', weight: 2 }
                        ];
                    }
                    if (!('events' in localResult)) {
                        write.events = [
                            { id: 'demo001', keyPointText: '波段新底暴跌但缩量', content: '恒瑞医药机会', time: '2025-07-17', status: 'accurate' }
                        ];
                    }
                    chrome.storage.local.set(write, resolve);
                });
            };
            if ('stockList' in localResult) {
                // 已迁移过，仅补齐老数据字段
                finish(migrateStockFields(localResult.stockList || []));
            } else {
                // 首次迁移：sync → local
                chrome.storage.sync.get(['stockList'], (syncResult) => {
                    if (syncResult.stockList) {
                        chrome.storage.sync.remove('stockList');
                    }
                    finish(migrateStockFields(syncResult.stockList || []));
                });
            }
        });
    });
    return ensureMigrated.promise;
}

// 老数据字段补齐（importPrice 不补，保持 null 由首次抓取回填）
function migrateStockFields(list) {
    for (const item of list) {
        if (!item || typeof item !== 'object') continue;
        if (!('importTargetPercentLe' in item)) item.importTargetPercentLe = '';
        if (!('importTargetPercentGe' in item)) item.importTargetPercentGe = '';
        if (!('notifiedDaily' in item)) {
            item.notifiedDaily = item.notified ?? false;
            delete item.notified;
        }
        if (!('notifiedImport' in item)) item.notifiedImport = false;
        if (!('inTrash' in item)) item.inTrash = false;
        if (!('code' in item)) item.code = '';
        if (!('prefix' in item)) {
            item.prefix = '';
        } else if (item.prefix && !isKnownMarketPrefix(item.prefix)) {
            // 旧版正则曾把股票名里的字母（如京东方A 的 A）误存为前缀：
            // 清空后生效地址回退存储 URL，下次抓取自动回填正确前缀
            item.prefix = '';
        }
        if (!('createdAt' in item)) item.createdAt = null;
        if (!('lastUpdateAt' in item)) item.lastUpdateAt = null;
        if (!('pinned' in item)) item.pinned = false;
        if (!('pinOrder' in item)) item.pinOrder = null;
    }
    return list;
}

// 监听消息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'startRefresh') {
        startRefresh(request.interval, request.selectorName);
        sendResponse({ status: 'started' });
    } else if (request.action === 'stopRefresh') {
        stopRefresh();
        sendResponse({ status: 'stopped' });
    } else if (request.action === 'getStatus') {
        // 等迁移完成后直接读 storage 响应，避免模块缓存滞后于 popup 的写入
        ensureMigrated().then(() => {
            chrome.storage.local.get(['stockList', 'portfolios', 'activePortfolio'], (localResult) => {
                chrome.storage.sync.get(['refreshInterval', 'selectorName', 'pageSize'], (syncResult) => {
                    sendResponse({
                        refreshInterval: Number.isFinite(syncResult.refreshInterval) ? syncResult.refreshInterval : 60,
                        selectorName: syncResult.selectorName,
                        pageSize: syncResult.pageSize || 10,
                        currentView,
                        stockList: localResult.stockList || [],
                        portfolios: localResult.portfolios || {},
                        activePortfolio: localResult.activePortfolio || '持仓'
                    });
                });
            });
        });
        return true; // 异步 sendResponse
    } else if (request.action === 'refresh') {
        init();
        // 选择器/列表可能已变更：运行中则立即按最新生效地址重排各股票 alarm
        chrome.alarms.get('refreshTimer', (alarm) => {
            if (!alarm) return;
            chrome.alarms.getAll((alarms) => {
                alarms.filter(a => a.name.startsWith(STOCK_ALARM_PREFIX))
                    .forEach(a => chrome.alarms.clear(a.name));
                scheduleStockAlarms();
            });
        });
    } else if (request.action === 'setView') {
        currentView = request.view === 'trash' ? 'trash' : 'list';
        chrome.storage.local.set({ currentView });
        // 只清各股票一次性 alarm（不能 clearAll，否则会误删周期性 refreshTimer）
        chrome.alarms.getAll((alarms) => {
            alarms.filter(a => a.name.startsWith(STOCK_ALARM_PREFIX))
                .forEach(a => chrome.alarms.clear(a.name));
            // 监控运行中则立即按新视图重排
            chrome.alarms.get('refreshTimer', (alarm) => {
                if (alarm) scheduleStockAlarms();
            });
        });
        sendResponse({ status: 'ok' });
    } else if (request.action === 'resizePopupWindow') {
        resizePopupWindow(request.rows || 0);
        sendResponse({ status: 'ok' });
    } else if (request.action === 'refreshAll') {
        // 一键/定时全量刷新：聚合全部组合的股票，立即触发（与监控运行状态无关）
        refreshAllStocks((count) => sendResponse({ status: 'ok', count }));
        return true; // 异步 sendResponse
    } else if (request.action === 'refreshOne') {
        // 单只股票立即刷新（新增股票保存后回填数据用）：直接打开/刷新该股票页面，
        // 不等下一轮定时调度；同时放开抓取窗口，监控未运行时也允许本次回填
        allowCapturedUntil = Date.now() + ALLOW_CAPTURE_WINDOW_MS;
        refreshStockTab(request.url);
        sendResponse({ status: 'ok' });
    } else if (request.action === 'armCapture') {
        // 快速打开/一键导入打开页面后：放开抓取窗口，监控未运行时也允许本次回填解析
        // （这些页面由 chrome.tabs.create 打开，不设窗口则「未运行即丢弃」会拦掉抓取）
        allowCapturedUntil = Date.now() + ALLOW_CAPTURE_WINDOW_MS;
        sendResponse({ status: 'ok' });
    } else if (request.action === 'syncCronJobs') {
        // cron 配置变更（增删/启停/表达式修改）后重排全部一次性 alarm
        scheduleCronAlarms();
        sendResponse({ status: 'ok' });
    } else if (request.action === 'openAiChat') {
        // 打开 AI 对话窗口（单例：已存在则聚焦）
        openAiChatWindow();
        sendResponse({ status: 'ok' });
    } else if (request.type === 'DOCUMENT_CAPTURED') {
        // 停止监控（无 refreshTimer）后，已打开标签页里的 content script 仍会因
        // 行情页 DOM 实时变动持续上报；此时直接丢弃，不落地，
        // 否则「停止」后上次更新时间仍会随页面变动往前走。
        // 例外：全量刷新（一键/cron）触发的抓取在窗口期内放行，保证未点开始时也能更新数据
        chrome.alarms.get('refreshTimer', (alarm) => {
            if (!alarm && Date.now() > allowCapturedUntil) {
                sendResponse({ status: 'ignored-not-running' });
                return;
            }
            // 全量刷新窗口内：打标记，落地时对已停止的股票也解析写入
            // （全量刷新忽略单只股票的停止刷新，故其数据须同步更新）
            if (Date.now() <= allowCapturedUntil) {
                request.documentData.fullRefresh = true;
            }
            // 落地（offscreen 解析 + 匹配 + 写库 + 阈值通知）在 SW 单点完成，
            // 不依赖 popup 存活，弹窗关闭期间监控数据照常入库、通知照常触发
            landCapturedDocument(request.documentData)
                .then(landed => sendResponse({ status: landed ? 'landed' : 'ignored' }))
                .catch(err => {
                    console.error('[thswc:bg] 抓取落地失败:', err);
                    sendResponse({ status: 'error' });
                });
        });
        return true; // 异步 sendResponse
    }
});

// 开始定时刷新
function startRefresh(interval, sn) {
    refreshInterval = interval;
    selectorName = sn;
    chrome.storage.sync.set({ refreshInterval, selectorName });
    // 创建定时器
    chrome.alarms.create('refreshTimer', {
        delayInMinutes: 0,
        periodInMinutes: refreshInterval / 60
    });
}

// 只清主定时器与各股票一次性 alarm（保留 cron 定时器）；done 可选回调
function clearMonitorAlarms(done) {
    chrome.alarms.getAll((alarms) => {
        alarms.filter(a => a.name === 'refreshTimer' || a.name.startsWith(STOCK_ALARM_PREFIX))
            .forEach(a => chrome.alarms.clear(a.name));
        done && done();
    });
}

// 停止定时刷新
function stopRefresh() {
    // 清掉主定时器和已排队的各股票一次性 alarm；不能 clearAll，否则会误删 cron 定时器
    clearMonitorAlarms();
}

// 定时器触发时刷新页面
chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'refreshTimer') {
        // 选择器为「调用 API 直取（不打开页面）」时，周期刷新走全局配置的 API 方式
        // 批量获取行情，不排页面刷新 alarm；否则按页面刷新调度
        chrome.storage.sync.get(['selectorName', 'dataSource'], ({ selectorName: sn, dataSource: ds }) => {
            if (sn === 'api') {
                const mode = ds || 'adata';
                dbg('API 直取模式周期刷新:', mode);
                if (mode === 'xiaoshi') {
                    refreshAllByApi(batchQuotes, 'apiKey', null, true);
                } else {
                    refreshAllByApi(adataBatchQuotes, null, null, true);
                }
            } else {
                scheduleStockAlarms();
            }
        });
    } else if (alarm.name.startsWith(CRON_ALARM_PREFIX)) {
        // cron 定时器到点：按最新 sync 配置处理（与股票 alarm 反查 storage 一致）
        handleCronAlarm(alarm.name.slice(CRON_ALARM_PREFIX.length));
    } else if (alarm.name.startsWith(STOCK_ALARM_PREFIX)) {
        const url = alarm.name.slice(STOCK_ALARM_PREFIX.length);
        // 直接从 storage 读最新列表/视图/选择器，避免 service worker 冷启动时状态缺失；
        // alarm 名里是生效地址（xq1 下可能是拼接的雪球链接），须按生效地址反查股票
        chrome.storage.local.get(['stockList', 'currentView'], ({ stockList, currentView: view }) => {
            chrome.storage.sync.get(['selectorName'], ({ selectorName }) => {
                const v = view || 'list';
                const stillActive = (stockList || []).some(item =>
                    effectiveStockUrl(item, selectorName) === url
                    && !item.stopRunning
                    && (v === 'trash' ? item.inTrash : !item.inTrash));
                if (!stillActive) return;
                refreshStockTab(url);
            });
        });
    }
});

// 为当前视图下的每只股票排一个一次性 alarm，随机延迟错开反风控；
// alarm 由浏览器进程托管，不随 service worker 回收而丢失，股票数量不受限
function scheduleStockAlarms() {
    chrome.storage.local.get(['stockList', 'currentView'], ({ stockList, currentView: view }) => {
        chrome.storage.sync.get(['selectorName'], ({ selectorName }) => {
            const v = view || 'list';
            // 刷新地址按选择器生效：xq1 下已知代码的股票改刷拼接的雪球链接
            const urls = (stockList || [])
                .filter(item => !item.stopRunning && (v === 'trash' ? item.inTrash : !item.inTrash))
                .map(item => effectiveStockUrl(item, selectorName));
            dbg('排程刷新:', v, '视图下共', urls.length, '只', urls);
            let delay = 0;
            urls.forEach(url => {
                delay += getRandomTime();
                chrome.alarms.create(STOCK_ALARM_PREFIX + url, { when: Date.now() + delay });
            });
        });
    });
}

// 刷新（或新打开）单只股票的标签页（使用专属窗口）
function refreshStockTab(url) {
    chrome.storage.local.get('stockWindowId', ({ stockWindowId }) => {
        // 检查专属窗口是否存在
        if (stockWindowId) {
            chrome.windows.get(stockWindowId, (window) => {
                if (chrome.runtime.lastError || !window) {
                    // 窗口已关闭，创建新的专属窗口
                    createStockWindowAndOpenTab(url);
                } else {
                    // 专属窗口存在，在其中查找/创建标签页
                    openOrRefreshTabInWindow(stockWindowId, url);
                }
            });
        } else {
            // 无专属窗口，创建新的
            createStockWindowAndOpenTab(url);
        }
    });
}

// 创建专属窗口并打开标签页（创建后立即最小化，不占屏幕空间）
// done：可选回调，窗口创建完成后调用（全量刷新串行等待用）
function createStockWindowAndOpenTab(url, done) {
    chrome.windows.create({
        url: url,
        type: 'normal',
        focused: false,
        width: 800,
        height: 600
    }, (newWindow) => {
        if (newWindow && newWindow.id) {
            chrome.storage.local.set({ stockWindowId: newWindow.id });
            chrome.windows.update(newWindow.id, { state: 'minimized' });
            dbg('创建专属窗口:', newWindow.id);
        }
        done && done();
    });
}

// 在指定窗口中查找或创建标签页
function openOrRefreshTabInWindow(windowId, url) {
    // 查询该窗口下的所有标签页
    chrome.tabs.query({ windowId }, (tabs) => {
        const target = tabs.find(t => stripSign(t.url) === stripSign(url));
        dbg('窗口内刷新匹配:', url, '| 窗口标签', tabs.length, '个 →',
            target ? ('重载已有标签 ' + target.url) : '无匹配标签，新开');
        if (target) {
            chrome.tabs.reload(target.id);
        } else {
            chrome.tabs.create({ windowId, url, active: false }); // 后台打开，不抢焦点
        }
    });
}

// 按行数调整插件弹窗高度（与 popupWindowId 创建时的计算一致）
function resizePopupWindow(rows) {
    chrome.storage.local.get(['popupWindowId', 'popupWindowWidth'], ({ popupWindowId, popupWindowWidth }) => {
        if (!popupWindowId) return;
        chrome.windows.get(popupWindowId, (window) => {
            if (chrome.runtime.lastError || !window) return;
            const newHeight = 520 + Math.max(rows - 2, 0) * 56;
            chrome.windows.update(popupWindowId, { width: popupWindowWidth ?? window.width, height: newHeight });
            dbg('弹窗调整高度:', newHeight, 'rows=', rows);
        });
    });
}

// ---------------- AI 对话窗口与流式代理 ----------------

// 打开 AI 对话窗口（单例：已存在则聚焦，否则创建；窗口关闭由 onRemoved 清理登记）
function openAiChatWindow() {
    chrome.storage.local.get('aiWindowId', ({ aiWindowId }) => {
        if (aiWindowId !== null && aiWindowId !== undefined) {
            chrome.windows.get(aiWindowId, (window) => {
                if (chrome.runtime.lastError || !window) {
                    createAiChatWindow();
                } else {
                    chrome.windows.update(aiWindowId, { focused: true });
                }
            });
        } else {
            createAiChatWindow();
        }
    });
}

function createAiChatWindow() {
    chrome.windows.getCurrent((currentWindow) => {
        // 靠在插件主窗口左侧（预留 8px 间距），顶部与主窗口对齐
        const baseLeft = currentWindow ? currentWindow.left : 0;
        const baseTop = currentWindow ? currentWindow.top : 0;
        chrome.windows.create({
            url: chrome.runtime.getURL('ai/ai.html'),
            type: 'popup',
            width: 480,
            height: 700,
            left: Math.max(baseLeft - 480 - 8, 0),
            top: Math.max(baseTop, 0)
        }, (newWindow) => {
            if (newWindow && newWindow.id) {
                chrome.storage.local.set({ aiWindowId: newWindow.id });
            }
        });
    });
}

// AI 对话流式请求表：requestId -> { controller, port, timeoutFired }
// 用户停止 / 窗口关闭 / 120s 超时均经 AbortController 中止，页面端收 ABORTED/ERROR 收尾
const aiChatRequests = new Map();
const AI_CHAT_TIMEOUT_MS = 120000;

// AI 窗口 port 消息分发：aiChatStream 发起 LLM 流式代理，aiChatStop 中止在途请求
function handleAiChatMessage(port, msg) {
    if (msg.action === 'aiChatStream') {
        const controller = new AbortController();
        const entry = { controller, port, timeoutFired: false };
        aiChatRequests.set(msg.requestId, entry);
        const timer = setTimeout(() => {
            entry.timeoutFired = true;
            controller.abort();
        }, AI_CHAT_TIMEOUT_MS);
        const post = (payload) => {
            try { port.postMessage(payload); } catch { /* 窗口已关闭 */ }
        };
        streamAiChat({
            baseUrl: msg.baseUrl,
            apiKey: msg.apiKey,
            model: msg.model,
            messages: msg.messages,
            tools: msg.tools,
            stream: msg.stream !== false, // 页面降级非流式时传 false
            signal: controller.signal,
        }, (event) => {
            if (event.type === 'chunk') {
                post({ type: 'AI_CHAT_CHUNK', requestId: msg.requestId, delta: event.delta });
            } else if (event.type === 'ready') {
                post({ type: 'AI_CHAT_READY', requestId: msg.requestId });
            } else if (event.type === 'done') {
                aiChatRequests.delete(msg.requestId);
                clearTimeout(timer);
                post({ type: 'AI_CHAT_DONE', requestId: msg.requestId, finish_reason: event.finish_reason, tool_calls: event.tool_calls });
            } else if (event.type === 'error') {
                aiChatRequests.delete(msg.requestId);
                clearTimeout(timer);
                post({ type: 'AI_CHAT_ERROR', requestId: msg.requestId, message: event.message, retriable: event.retriable });
            } else if (event.type === 'aborted') {
                aiChatRequests.delete(msg.requestId);
                clearTimeout(timer);
                // 超时中止与用户停止区分：超时给可重试错误，用户停止给 ABORTED
                if (entry.timeoutFired) {
                    post({ type: 'AI_CHAT_ERROR', requestId: msg.requestId, message: '请求超时（120s），请重试', retriable: true });
                } else {
                    post({ type: 'AI_CHAT_ABORTED', requestId: msg.requestId });
                }
            }
        });
    } else if (msg.action === 'aiChatStop') {
        const entry = aiChatRequests.get(msg.requestId);
        if (entry) entry.controller.abort();
    }
}

// ---------------- cron 定时器（全局设置，最多 3 个） ----------------

// 重排全部 cron 一次性 alarm（先清空再重建，幂等）
function scheduleCronAlarms() {
    chrome.storage.sync.get(['cronJobs'], ({ cronJobs }) => {
        chrome.alarms.getAll((alarms) => {
            alarms.filter(a => a.name.startsWith(CRON_ALARM_PREFIX))
                .forEach(a => chrome.alarms.clear(a.name));
            (cronJobs || []).forEach(job => scheduleOneCron(job));
        });
    });
}

// 为单个 cron 任务排下一次触发（按 cron 表达式计算，一次性 alarm，由浏览器托管）
function scheduleOneCron(job) {
    if (!job || !job.enabled || !job.expr) return;
    const next = nextCronTime(job.expr, Date.now());
    if (next === null) {
        console.warn('[thswc:bg] cron 表达式无法满足，已跳过排程:', job.expr);
        return;
    }
    chrome.alarms.create(CRON_ALARM_PREFIX + job.id, { when: next });
    dbg('cron 排程:', job.expr, '→', new Date(next).toLocaleString('zh-CN'));
}

// cron 定时器到点：先重排下一次（避免 SW 回收断档），再执行全量刷新
// （具体走页面刷新还是 API 由数据获取方式决定，见 refreshAllStocks）
function handleCronAlarm(id) {
    chrome.storage.sync.get(['cronJobs'], ({ cronJobs }) => {
        const job = (cronJobs || []).find(j => j.id === id);
        if (!job || !job.enabled) return;
        scheduleOneCron(job);
        if (!isTradingTime()) {
            dbg('cron 命中非交易时间，跳过全量刷新:', job.expr);
            return;
        }
        dbg('cron 触发全量刷新:', job.expr);
        refreshAllStocks();
    });
}

// ---------------- 全量刷新（一键 / cron 共用） ----------------

// 全量刷新入口：按数据获取方式分发——
//   refresh（默认）：逐支刷新股票页面
//   xiaoshi：小石大数据批量行情接口（需 apiKey）
//   adata：新浪/腾讯公开行情（无需 Key）
function refreshAllStocks(done) {
    chrome.storage.sync.get('dataSource', ({ dataSource: ds }) => {
        const mode = ds || 'adata';
        if (mode === 'xiaoshi') {
            refreshAllByApi(batchQuotes, 'apiKey', done, false);
        } else if (mode === 'adata') {
            refreshAllByApi(adataBatchQuotes, null, done, false);
        } else {
            refreshAllByTabs(done);
        }
    });
}

// 页面刷新方式：聚合全部组合的股票，忽略「停止刷新」标记，全部刷新；
// 按生效地址跨组合去重，每次只打开/刷新 1 支，间隔 1.2-2.8s 随机
// （避免一次性打开全部页面造成压力），窗口不存在则新建（含首支股票），已存在则复用；
// 完成后经回调返回实际刷新数量。刷新期间放开「未运行即丢弃」的抓取窗口
function refreshAllByTabs(done) {
    allowCapturedUntil = Date.now() + ALLOW_CAPTURE_WINDOW_MS;
    chrome.storage.local.get(['portfolios'], ({ portfolios }) => {
        const seen = new Set();
        const urls = [];
        Object.keys(portfolios || {}).forEach(name => {
            const p = portfolios[name];
            const sn = p.selectorName || 'wc1'; // 各组合独立的选择器
            (p.stockList || []).forEach(s => {
                const url = stripSign(effectiveStockUrl(s, sn));
                if (!url || seen.has(url)) return;
                seen.add(url);
                urls.push(url);
            });
        });
        dbg('全量刷新: 共', urls.length, '只股票', urls);
        if (urls.length === 0) { done && done(0); return; }
        let count = 0;
        const queue = urls.slice();
        const step = () => {
            if (queue.length === 0) { done && done(count); return; }
            const url = queue.shift();
            openOrRefreshStockTab(url).then(() => {
                count++;
                if (queue.length > 0) {
                    setTimeout(step, 1200 + Math.random() * 1600); // 1.2-2.8s 随机间隔
                } else {
                    step(); // 最后一支立即收尾
                }
            });
        };
        step();
    });
}

// API 方式：聚合股票 code（跨组合去重，排除港股——接口仅支持 A股）后调用对应批量
// 行情模块，结果经 port 转交 popup 更新数据；
// keyName 为所需存储键（adata 等公开接口传 null 跳过 Key 检查）；
// filter=true 时为定时监控语义：仅当前视图 + 非停止的股票（与页面刷新调度同款过滤）；
// 请求发起后经回调返回请求股票数（数据落地由 popup 完成，与页面刷新模式一致）
function refreshAllByApi(quoteFn, keyName, done, filter) {
    const getKey = keyName
        ? new Promise((resolve) => chrome.storage.sync.get(keyName, (res) => resolve(res[keyName] || '')))
        : Promise.resolve('');
    getKey.then((apiKey) => {
        if (keyName && !apiKey) {
            console.warn('[thswc:bg] 数据获取方式需配置', keyName, '，跳过刷新');
            done && done(0);
            return;
        }
        chrome.storage.local.get(['portfolios', 'currentView'], ({ portfolios, currentView }) => {
            const v = currentView || 'list';
            const seen = new Set();
            const codes = [];
            Object.keys(portfolios || {}).forEach(name => {
                (portfolios[name].stockList || []).forEach(s => {
                    if (s.prefix === 'HK') return; // 接口不支持港股
                    const c = String(s.code || '').trim();
                    if (!/^\d{6}$/.test(c) || seen.has(c)) return;
                    // 定时监控过滤：仅当前视图 + 非停止
                    if (filter) {
                        if (s.stopRunning) return;
                        if (v === 'trash' ? !s.inTrash : s.inTrash) return;
                    }
                    seen.add(c);
                    codes.push(c);
                });
            });
            dbg('API 刷新: 共', codes.length, '个代码', codes, filter ? '(定时监控过滤)' : '(全量)');
            if (codes.length === 0) { done && done(0); return; }
            quoteFn(codes, { apiKey })
                .then(async (r) => {
                    dbg('API 行情返回:', r.count, '只，缺失:', (r.missing_codes || []).join(',') || '无');
                    // 行情在 SW 落地（匹配 + 写库 + 阈值通知），不依赖 popup 存活
                    try {
                        const landed = await landApiQuotes(r.items);
                        if (!landed) dbg('API 行情无匹配股票（code 不一致或尚未抓取）:', r.items.length, '条');
                    } catch (err) {
                        console.error('[thswc:bg] API 行情落地失败:', err);
                    }
                    done && done(codes.length);
                })
                .catch((err) => {
                    console.error('[thswc:bg] API 行情获取失败:', err);
                    done && done(0);
                });
        });
    });
}

// 打开/刷新单支股票（Promise 化，供全量刷新串行调用）；
// 窗口不存在则新建（含该股票），已存在则复用，逻辑与监控路径 refreshStockTab 一致
function openOrRefreshStockTab(url) {
    return new Promise((resolve) => {
        chrome.storage.local.get('stockWindowId', ({ stockWindowId }) => {
            if (stockWindowId) {
                chrome.windows.get(stockWindowId, (window) => {
                    if (chrome.runtime.lastError || !window) {
                        createStockWindowAndOpenTab(url, resolve);
                    } else {
                        openOrRefreshTabInWindow(stockWindowId, url);
                        resolve();
                    }
                });
            } else {
                createStockWindowAndOpenTab(url, resolve);
            }
        });
    });
}

// 延迟刷新反风控
function getRandomTime() {
    return Math.floor(Math.random() * (3500 - 1200) + 1200);
}
