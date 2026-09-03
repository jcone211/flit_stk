import {
    getDateTime, normalizeUrl, stripSign, numOrNull,
    calcImportPercent, effectiveStockUrl, etfPrefixForCode
} from '../shared/utils.js';
import { validateCronExpr } from '../shared/cron.js';
import { renderStock, renderPagination, renderSortToggles, renderComboSwitches } from './render.js';
import { createEditForm } from './editform.js';

// service worker 回收/重启会断开长连接：自动重连，避免弹窗静默停更；
// 扩展上下文失效（重载扩展）时 connect 抛错即停止重连，重开弹窗恢复
let port = null;
function connectPort() {
    try {
        port = chrome.runtime.connect({ name: 'popup-connection' });
    } catch {
        return;
    }
    port.onMessage.addListener(handleLandedNotice);
    port.onDisconnect.addListener(() => setTimeout(connectPort, 500));
}
connectPort();

// 数据解析与落地已下沉 background/landing.js（offscreen 隐藏页解析）：
// popup 只收「落地完成/失败」轻量通知刷新「上次更新时间」角标，
// 列表数据经 storage.onChanged → reloadPortfoliosFromStorage 自行刷新
function handleLandedNotice(message) {
    if (message.type === 'DATA_LANDED') {
        lastUpdateTimeEl.textContent = getDateTime();
    } else if (message.type === 'DATA_LAND_ERROR') {
        lastUpdateTimeEl.textContent = '数据更新失败 ' + getDateTime();
    }
}

// ---------------- 模块状态 ----------------
let selectorName = '';
let currentView = 'list';   // 'list' 股票列表 | 'trash' 垃圾池
let currentPage = 1;
let pageSize = 10;
let currentSort = 'default'; // 'default' | 'percent-asc/desc' | 'importPercent-asc/desc'
let portfolios = {};
let activePortfolio = '持仓';
// 默认组合（不可删除、不可重命名）
const DEFAULT_PORTFOLIOS = ['默认', '持仓', '观察'];
let stockList = [];
let editUrl = undefined;
let keyPoints = []; // 要点列表：[{ text, weight }]
let editingKeyPointIndex = -1; // 编辑中的要点索引，-1 表示新增模式
let events = []; // 事件列表：[{ id, keyPointText, content, time, status }]
let editingEventId = null; // 编辑中的事件 ID，null 表示新增模式
let eventFilterKeyPoint = ''; // 事件按要点筛选值，'' 表示全部
let autoResizeWindow = true; // 切换组合时专属窗口自动伸缩
let defaultPortfolio = '持仓'; // 打开插件时默认显示的组合，默认「持仓」
let hideKeyPoints = false; // 隐藏首页「要点管理」图标
let enableTrash = false; // 启用垃圾池功能（默认关闭）
let refreshOnOpen = true; // 打开插件时全部更新（默认开启，不弹窗）
let enableQuickImport = true; // 启用快速打开一键导入（默认开启）
let quickImportInStockWindow = true; // 一键导入在最小化专属窗口打开（默认开启）；关闭则统一普通页面打开
let dataSource = 'refresh'; // 数据获取方式：'refresh' 刷新页面获取 | 'api' 调用 API 直取（未实现）
let cronJobs = []; // 定时全量刷新：[{ id, expr, enabled }]，最多 3 个
let enableAi = true; // 启用 AI 分析功能（默认开启，控制首页 AI 入口显隐）
let keepMonitoringOnClose = false; // 关闭插件后继续监控（默认关闭）
let keepRefreshOnClose = false; // 关闭插件后继续全量刷新（默认关闭）
let isMonitoring = false; // 监控运行状态（驱动启停单按钮文案）

// ---------------- DOM 引用 ----------------
const quickOpenEl = document.getElementById('quickOpen');
const quickImportBtnEl = document.getElementById('quickImportBtn');
// 一键导入组合选择弹窗
const quickImportComboOverlayEl = document.getElementById('quickImportComboOverlay');
const closeQuickImportComboBtnEl = document.getElementById('closeQuickImportComboBtn');
const quickImportComboSelectEl = document.getElementById('quickImportComboSelect');
const quickImportComboInputEl = document.getElementById('quickImportComboInput');
const confirmQuickImportComboBtnEl = document.getElementById('confirmQuickImportComboBtn');
const lastUpdateTimeEl = document.getElementById('lastUpdateTime');
const intervalInput = document.getElementById('interval');
const startStopBtn = document.getElementById('startStopBtn');
const selectorEl = document.getElementById('selectorName');
const addStockEl = document.getElementById('addStock');
const refreshAllBtnEl = document.getElementById('refreshAllBtn');
const openAiChatBtnEl = document.getElementById('openAiChatBtn');
const overlayEl = document.getElementById('stockEditOverlay');
const closeBtnEl = overlayEl.querySelector('.close-btn');
const lastMonitorEl = document.getElementById('lastMonitor');
const saveStockBtnEl = document.getElementById('saveStock');
const delStockBtnEl = document.getElementById('delStock');
const stockTableEl = document.getElementById('stockTable');
const stockUrlEl = document.getElementById('stockUrl');
const stockUrlGroupEl = document.getElementById('stockUrlGroup');
const alertDimDailyBtnEl = document.getElementById('alertDimDailyBtn');
const alertDimImportBtnEl = document.getElementById('alertDimImportBtn');
const dailyTargetGroupEl = document.getElementById('dailyTargetGroup');
const importTargetGroupEl = document.getElementById('importTargetGroup');
const stockNameEl = document.getElementById('stockName');
const stockCodeEl = document.getElementById('stockCode');
const lastUpdateAtEl = document.getElementById('lastUpdateAt');
const headerCurrentPriceEl = document.getElementById('headerCurrentPrice');
const startPriceEl = document.getElementById('startPrice');
const percentEl = document.getElementById('percent');
const targetPriceEl = document.getElementById('targetPrice');
const targetPercentLeEl = document.getElementById('targetPercentLe');
const targetPercentGeEl = document.getElementById('targetPercentGe');
const dailyLePriceInputEl = document.getElementById('dailyLePriceInput');
const dailyGePriceInputEl = document.getElementById('dailyGePriceInput');
const importPriceInputEl = document.getElementById('importPriceInput');
const importPercentEl = document.getElementById('importPercent');
const importTargetPriceEl = document.getElementById('importTargetPrice');
const importTargetPercentLeEl = document.getElementById('importTargetPercentLe');
const importTargetPercentGeEl = document.getElementById('importTargetPercentGe');
const importLePriceInputEl = document.getElementById('importLePriceInput');
const importGePriceInputEl = document.getElementById('importGePriceInput');
const trashToggleBtnEl = document.getElementById('trashToggleBtn');
const editActionsTopEl = document.getElementById('editActionsTop');
const viewTitleEl = document.getElementById('viewTitle');
const viewListBtnEl = document.getElementById('viewListBtn');
const viewTrashBtnEl = document.getElementById('viewTrashBtn');
const viewSwitchGroupEl = document.getElementById('viewSwitchGroup');
const paginationBarEl = document.getElementById('paginationBar');
const exportBtnEl = document.getElementById('exportBtn');
const importBtnEl = document.getElementById('importBtn');
const importFileInputEl = document.getElementById('importFileInput');
const exportChoiceOverlayEl = document.getElementById('exportChoiceOverlay');
const closeExportChoiceBtnEl = document.getElementById('closeExportChoiceBtn');
const exportCopyBtnEl = document.getElementById('exportCopyBtn');
const exportDefaultBtnEl = document.getElementById('exportDefaultBtn');
const exportSensitiveBtnEl = document.getElementById('exportSensitiveBtn');
const copyComboOverlayEl = document.getElementById('copyComboOverlay');
const closeCopyComboBtnEl = document.getElementById('closeCopyComboBtn');
const copyComboListEl = document.getElementById('copyComboList');
const confirmCopyComboBtnEl = document.getElementById('confirmCopyComboBtn');
const comboSwitchesEl = document.getElementById('comboSwitches');
const comboLabelEl = document.getElementById('comboLabel');
const sortToggleEls = document.querySelectorAll('.sort-toggle');
// 要点管理
const openKeyPointsBtnEl = document.getElementById('openKeyPointsBtn');
const keyPointsOverlayEl = document.getElementById('keyPointsOverlay');
const closeKeyPointsBtnEl = document.getElementById('closeKeyPointsBtn');
const keyPointTextInputEl = document.getElementById('keyPointText');
const keyPointWeightInputEl = document.getElementById('keyPointWeight');
const addKeyPointBtnEl = document.getElementById('addKeyPointBtn');
const keyPointsListEl = document.getElementById('keyPointsList');
// 事件管理
const tabKeyPointsBtnEl = document.getElementById('tabKeyPointsBtn');
const tabEventsBtnEl = document.getElementById('tabEventsBtn');
const tabKeyPointsContentEl = document.getElementById('tabKeyPointsContent');
const tabEventsContentEl = document.getElementById('tabEventsContent');
const eventKeyPointSelectEl = document.getElementById('eventKeyPointSelect');
const eventContentInputEl = document.getElementById('eventContent');
const eventDateInputEl = document.getElementById('eventDate');
const addEventBtnEl = document.getElementById('addEventBtn');
const eventsListEl = document.getElementById('eventsList');
const eventFilterSelectEl = document.getElementById('eventFilterSelect');
const clearEventFilterBtnEl = document.getElementById('clearEventFilterBtn');
const eventAccuracyEl = document.getElementById('eventAccuracy');
// 全局设置
const openSettingsBtnEl = document.getElementById('openSettingsBtn');
const settingsOverlayEl = document.getElementById('settingsOverlay');
const closeSettingsBtnEl = document.getElementById('closeSettingsBtn');
const autoResizeToggleEl = document.getElementById('autoResizeWindowToggle');
const defaultPortfolioSelectEl = document.getElementById('defaultPortfolioSelect');
const showKeyPointsToggleEl = document.getElementById('showKeyPointsToggle');
const enableTrashToggleEl = document.getElementById('enableTrashToggle');
const refreshOnOpenToggleEl = document.getElementById('refreshOnOpenToggle');
const enableQuickImportToggleEl = document.getElementById('enableQuickImportToggle');
const quickImportInStockWindowToggleEl = document.getElementById('quickImportInStockWindowToggle');
const dataSourceSelectEl = document.getElementById('dataSourceSelect');
const apiKeyInputEl = document.getElementById('apiKeyInput');
const apiKeyGroupEl = document.getElementById('apiKeyGroup');
const enableAiToggleEl = document.getElementById('enableAiToggle');
const cronJobListEl = document.getElementById('cronJobList');
const addCronJobBtnEl = document.getElementById('addCronJobBtn');
const keepMonitoringOnCloseToggleEl = document.getElementById('keepMonitoringOnCloseToggle');
const keepRefreshOnCloseToggleEl = document.getElementById('keepRefreshOnCloseToggle');

// 编辑表单（封装渲染/清空/联动）
const editForm = createEditForm({
    stockNameEl, stockCodeEl, stockUrlEl, headerCurrentPriceEl, lastUpdateAtEl,
    startPriceEl, percentEl, targetPriceEl,
    importPriceInputEl, importPercentEl, importTargetPriceEl,
    targetPercentLeEl, targetPercentGeEl, dailyLePriceInputEl, dailyGePriceInputEl,
    importTargetPercentLeEl, importTargetPercentGeEl, importLePriceInputEl, importGePriceInputEl,
    editActionsTopEl, trashToggleBtnEl,
}, { getStock: editingStock });
editForm.bindLinkage();

// ---------------- 工具 ----------------
function storageGet(area, keys) {
    return new Promise(resolve => area.get(keys, resolve));
}

function editingStock() {
    return stockList.find(s => s.url === editUrl);
}

// 保存并重渲染（启停/置顶/垃圾池/删除/保存/抓取共用）
function saveAndRender() {
    if (portfolios[activePortfolio]) portfolios[activePortfolio].stockList = stockList;
    chrome.storage.local.set({ stockList, portfolios }, () => {
        renderStockList();
        chrome.runtime.sendMessage({ action: 'refresh' });
        requestResizePopup();
    });
}

function refreshCombos() {
    // 无组合时仅隐藏标签（分页仍在同行），chips 容器由渲染函数清空
    comboLabelEl.style.display = Object.keys(portfolios).length ? '' : 'none';
    renderComboSwitches(portfolios, activePortfolio, comboSwitchesEl, { onSwitch: switchPortfolio, onDelete: deletePortfolio, onAdd: addPortfolio });
}

// ---------------- 数据落地（下沉至 background/landing.js + offscreen 隐藏页解析） ----------------
// popup 不再处理 DOCUMENT_CAPTURED / API_QUOTES_CAPTURED：解析、匹配、写库与阈值通知
// 全部在 background 单点完成（弹窗关闭期间照常工作）。列表数据经 storage.onChanged 刷新，
// 本处仅保留 DATA_LANDED / DATA_LAND_ERROR 轻量通知用于「上次更新时间」角标。

// ---------------- 列表渲染 ----------------
function getViewList() {
    const filtered = stockList.filter(s => currentView === 'trash' ? s.inTrash : !s.inTrash);
    const pinned = filtered.filter(s => s.pinned)
        .sort((a, b) => (a.pinOrder ?? 0) - (b.pinOrder ?? 0));
    const rest = filtered.filter(s => !s.pinned);
    if (currentSort !== 'default') {
        const idx = currentSort.lastIndexOf('-');
        const field = currentSort.slice(0, idx);
        const dir = currentSort.slice(idx + 1) === 'asc' ? 1 : -1;
        rest.sort((a, b) => {
            const va = field === 'percent' ? numOrNull(a.percent) : calcImportPercent(a.currentPrice, a.importPrice);
            const vb = field === 'percent' ? numOrNull(b.percent) : calcImportPercent(b.currentPrice, b.importPrice);
            if (va == null && vb == null) return 0;
            if (va == null) return 1;
            if (vb == null) return -1;
            return (va - vb) * dir;
        });
    }
    return [...pinned, ...rest];
}

function renderStockList() {
    const list = getViewList();
    const totalPages = Math.max(1, Math.ceil(list.length / pageSize));
    if (currentPage > totalPages) currentPage = totalPages;
    if (currentPage < 1) currentPage = 1;
    const pageItems = list.slice((currentPage - 1) * pageSize, currentPage * pageSize);
    stockTableEl.innerHTML = '';
    for (const stock of pageItems) {
        stockTableEl.appendChild(renderStock(stock, selectorName, {
            onEdit: () => openEdit(stock),
            onStop: () => { stock.stopRunning = !stock.stopRunning; saveAndRender(); },
            onTogglePin: (s) => {
                if (s.pinned) {
                    // 取消置顶：移到数组首位 → 落在未置顶分组的第一位（紧随置顶分组之后）
                    s.pinned = false;
                    s.pinOrder = null;
                    stockList.splice(stockList.indexOf(s), 1);
                    stockList.unshift(s);
                } else {
                    // 置顶：新置顶项排第 1，其余置顶项顺序依次 +1。
                    // 旧置顶按现有 pinOrder 相对序重编为 2..n+1（兼容旧版负数编号），新项固定为 1
                    stockList.filter(x => x.pinned && x !== s)
                        .sort((a, b) => (a.pinOrder ?? 0) - (b.pinOrder ?? 0))
                        .forEach((x, i) => { x.pinOrder = i + 2; });
                    s.pinned = true;
                    s.pinOrder = 1;
                }
                saveAndRender();
            },
            // 仅列表视图显示切换组合按钮
            onMoveToCombo: currentView === 'list' ? (stock, btn) => showMoveComboDropdown(stock, btn) : undefined,
        }));
    }
    renderPagination(paginationBarEl, { currentPage, totalPages, total: list.length, pageSize }, {
        onPrev: () => { currentPage--; renderStockList(); },
        onNext: () => { currentPage++; renderStockList(); },
        onPageSize: (v) => {
            pageSize = v;
            chrome.storage.sync.set({ pageSize: v });
            currentPage = 1;
            renderStockList();
        },
    });
    renderSortToggles(currentSort, sortToggleEls);
}

// ---------------- 视图 / 组合 ----------------
function updateViewToggleUI() {
    viewTitleEl.textContent = currentView === 'trash' ? '垃圾池' : '股票列表';
    viewListBtnEl.classList.toggle('active', currentView === 'list');
    viewTrashBtnEl.classList.toggle('active', currentView === 'trash');
}

function switchView(view) {
    if (currentView === view) return;
    currentView = view;
    chrome.storage.local.set({ currentView: view });
    chrome.runtime.sendMessage({ action: 'setView', view }); // background 按新视图重排刷新任务
    currentPage = 1;
    updateViewToggleUI();
    renderStockList();
    requestResizePopup();
}

function switchPortfolio(name) {
    if (!portfolios[name] || name === activePortfolio) return;
    activePortfolio = name;
    stockList = portfolios[name].stockList || [];
    selectorName = portfolios[name].selectorName || 'wc1';
    selectorEl.value = selectorName;
    chrome.storage.local.set({ activePortfolio, stockList });
    chrome.storage.sync.set({ selectorName });
    currentPage = 1;
    currentSort = 'default';
    refreshCombos();
    renderStockList();
    chrome.runtime.sendMessage({ action: 'refresh' });
    requestResizePopup();
}

// 命名保留字检查
function isReservedPortfolioName(name) {
    return DEFAULT_PORTFOLIOS.includes(name);
}

// 重名检查
function isDuplicatePortfolioName(name) {
    return portfolios[name] !== undefined;
}

// 删除组合：默认组合不可删；活动组合须先切走（避免活动指针悬空）；删除前 confirm 防误触
function deletePortfolio(name) {
    if (!portfolios[name]) return;
    if (DEFAULT_PORTFOLIOS.includes(name)) { alert(`默认组合「${name}」不可删除`); return; }
    if (name === activePortfolio) { alert('当前组合使用中，请先切换到其他组合再删除'); return; }
    if (!confirm(`删除组合「${name}」？组合内的股票将一并删除`)) return;
    delete portfolios[name];
    chrome.storage.local.set({ portfolios }, refreshCombos);
}

// 新建组合：弹窗命名，创建空组合并切换到该组合
function addPortfolio() {
    const name = promptComboName('新建组合（不超过4字）：');
    if (name === null) return;
    if (isReservedPortfolioName(name)) { alert(`「${name}」为默认组合名称，请更换其他名称`); return; }
    if (isDuplicatePortfolioName(name)) { alert(`组合「${name}」已存在，请更换其他名称`); return; }
    portfolios[name] = { stockList: [], selectorName };
    chrome.storage.local.set({ portfolios }, () => {
        switchPortfolio(name);
        refreshCombos();
    });
}

// 切换组合下拉框：显示在按钮旁，选择后将股票移动到目标组合
function showMoveComboDropdown(stock, anchorEl) {
    // 关闭已有下拉框
    closeMoveComboDropdown();
    const dropdown = document.createElement('div');
    dropdown.className = 'move-combo-dropdown';
    dropdown.id = 'moveComboDropdown';
    // 获取所有组合名称（排除当前活动组合）
    const comboNames = Object.keys(portfolios).filter(name => name !== activePortfolio);
    if (comboNames.length === 0) {
        dropdown.textContent = '无其他组合';
        dropdown.className += ' empty';
    } else {
        comboNames.forEach(name => {
            const item = document.createElement('div');
            item.className = 'move-combo-item';
            item.textContent = name;
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                moveStockToCombo(stock, name);
                closeMoveComboDropdown();
            });
            dropdown.appendChild(item);
        });
    }
    // 定位下拉框（相对按钮）
    const rect = anchorEl.getBoundingClientRect();
    dropdown.style.position = 'fixed';
    dropdown.style.top = `${rect.bottom + 2}px`;
    dropdown.style.left = `${rect.left - 60}px`;
    document.body.appendChild(dropdown);
    // 点击外部关闭
    setTimeout(() => {
        document.addEventListener('click', closeMoveComboDropdownOnClick);
    }, 0);
}

function closeMoveComboDropdownOnClick(e) {
    const dropdown = document.getElementById('moveComboDropdown');
    if (dropdown && !dropdown.contains(e.target)) {
        closeMoveComboDropdown();
    }
}

function closeMoveComboDropdown() {
    const dropdown = document.getElementById('moveComboDropdown');
    if (dropdown) {
        dropdown.remove();
    }
    document.removeEventListener('click', closeMoveComboDropdownOnClick);
}

// 将股票从当前组合移动到目标组合
function moveStockToCombo(stock, targetComboName) {
    if (!portfolios[targetComboName]) return;
    // 从当前组合的 stockList 中移除
    const idx = stockList.indexOf(stock);
    if (idx !== -1) {
        stockList.splice(idx, 1);
    }
    // 添加到目标组合的 stockList
    if (!portfolios[targetComboName].stockList) {
        portfolios[targetComboName].stockList = [];
    }
    portfolios[targetComboName].stockList.push(stock);
    // 同步更新当前组合的存储
    portfolios[activePortfolio].stockList = stockList;
    chrome.storage.local.set({ portfolios }, () => {
        renderStockList();
        refreshCombos();
    });
}

// ---------------- 导入 / 导出 ----------------
function comboTimestamp() {
    const ts = new Date();
    const pad = n => String(n).padStart(2, '0');
    return `${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}-${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}`;
}

function validComboName(n) {
    return typeof n === 'string' && n.trim().length > 0 && n.trim().length <= 4;
}

function nameFromFile(fileName) {
    let base = (fileName || '').replace(/\.json$/i, '');
    return base.replace(/_\d{8}-\d{6}$/, ''); // 去掉尾部时间戳
}

// 组合命名弹窗：返回有效名或 null（取消/非法）
function promptComboName(message, prefilled) {
    const input = prompt(message, prefilled || '');
    if (input === null) return null;
    const name = input.trim();
    if (!validComboName(name)) { alert('组合命名必须为1-4个字'); return null; }
    return name;
}

// 格式化时间戳（毫秒）为 YYYYMMDD 紧凑格式
function formatDateCompact(ts) {
    if (!ts) return '未知';
    try {
        const d = new Date(ts);
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}${m}${day}`;
    } catch {
        return '未知';
    }
}

// 格式化股票代码：有 prefix 则 "prefix:code"，否则原 code 或空
function formatStockCode(stock) {
    if (stock.prefix && stock.code) return `${stock.prefix}:${stock.code}`;
    if (stock.code) return stock.code;
    return '';
}

// 展示组合多选弹窗
function showCopyComboOverlay() {
    copyComboListEl.innerHTML = '';
    const names = Object.keys(portfolios);
    // 排序：默认组合在前，其余保持登记顺序
    names.sort((a, b) => {
        const ai = DEFAULT_PORTFOLIOS.indexOf(a);
        const bi = DEFAULT_PORTFOLIOS.indexOf(b);
        if (ai !== -1 && bi !== -1) return ai - bi;
        if (ai !== -1) return -1;
        if (bi !== -1) return 1;
        return 0;
    });
    let hasAny = false;
    names.forEach(name => {
        const list = portfolios[name].stockList || [];
        if (list.length === 0) return;
        hasAny = true;
        const label = document.createElement('label');
        label.className = 'copy-combo-item';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.value = name;
        cb.checked = false; // 默认不勾选
        const txt = document.createElement('span');
        txt.textContent = name;
        const count = document.createElement('span');
        count.className = 'combo-stock-count';
        count.textContent = `(${list.length} 支)`;
        label.append(cb, txt, count);
        copyComboListEl.appendChild(label);
    });
    if (!hasAny) {
        copyComboListEl.textContent = '暂无有股票的组合';
        confirmCopyComboBtnEl.disabled = true;
    } else {
        confirmCopyComboBtnEl.disabled = false;
    }
    copyComboOverlayEl.style.display = 'flex';
}

// 确认复制：收集选中的组合，生成文本并复制到剪贴板
function handleCopyComboConfirm() {
    const checked = copyComboListEl.querySelectorAll('input[type="checkbox"]:checked');
    if (checked.length === 0) {
        alert('请至少选择一个组合');
        return;
    }
    const lines = [];
    lines.push('我的当前组合信息（股票名称-代码-加入价格-加入时间）：');
    for (const cb of checked) {
        const name = cb.value;
        const stocks = portfolios[name].stockList || [];
        if (stocks.length === 0) continue;
        const parts = stocks.map(s => {
            const codeStr = formatStockCode(s);
            const dateStr = formatDateCompact(s.createdAt);
            const priceStr = s.importPrice != null ? String(s.importPrice) : '';
            const nameStr = s.name || '(待抓取)';
            // 格式：股票名称-代码-初始价-创建时间
            return `${nameStr}-${codeStr}-${priceStr}-${dateStr}`;
        });
        lines.push(`'${name}'组合：${parts.join('；')}`);
    }
    if (lines.length <= 1) {
        alert('选中的组合中无股票数据可复制');
        return;
    }
    const text = lines.join('\n');
    copyTextToClipboard(text);
    copyComboOverlayEl.style.display = 'none';
    alert('已复制到剪贴板');
}

// 复制文本到剪贴板
async function copyTextToClipboard(text) {
    try {
        await navigator.clipboard.writeText(text);
    } catch {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
    }
}

// 全量导出：导出插件全部数据和配置
// 两种导出都不携带对话中的 base64 原始图片/文件数据，均以占位文本代替：
//   上传的图片/文件保留原「[用户上传图片/文件：<文件名>...]」占位，粘贴图片替换为「[用户上传图片：粘贴图片]」；
// sensitive=false（默认）：不含任何 API Key（aiProviders/aiActiveProviderId/apiKey）；
// sensitive=true（敏感）：多导出小石 / AI 接口的 API Key
async function handleExport(sensitive) {
    if (!confirm(sensitive
        ? '将导出全部数据（含小石 / AI 接口的 API Key；对话图片/文件不携带原始数据，以占位文本代替），请妥善保管，确定继续？'
        : '将导出默认数据（组合、要点、事件、设置、AI 对话与记忆；不含 API Key，对话图片/文件以 [用户上传图片：xx.png] 等占位文本代替），确定继续？')) return;
    const localKeys = ['stockList', 'portfolios', 'activePortfolio', 'currentView', 'keyPoints', 'events', 'aiChats', 'aiMemory'];
    const syncKeys = ['refreshInterval', 'selectorName', 'pageSize', 'autoResizeWindow', 'defaultPortfolio', 'hideKeyPoints', 'enableTrash', 'refreshOnOpen', 'enableQuickImport', 'quickImportInStockWindow', 'enableAi', 'dataSource', 'cronJobs', 'aiMaxToolIterations', 'keepMonitoringOnClose', 'keepRefreshOnClose'];
    if (sensitive) syncKeys.push('apiKey', 'aiProviders', 'aiActiveProviderId');
    const localData = await storageGet(chrome.storage.local, localKeys);
    const syncData = await storageGet(chrome.storage.sync, syncKeys);
    const payload = {
        version: 3,
        type: 'full-backup',
        sensitive: !!sensitive,
        exportedAt: new Date().toISOString(),
        local: {
            stockList: localData.stockList || [],
            portfolios: localData.portfolios || {},
            activePortfolio: localData.activePortfolio || '持仓',
            currentView: localData.currentView || 'list',
            keyPoints: localData.keyPoints || [],
            events: localData.events || [],
            aiChats: sanitizeAiChats(localData.aiChats) || {},
            aiMemory: localData.aiMemory || null,
        },
        sync: {
            refreshInterval: syncData.refreshInterval,
            selectorName: syncData.selectorName,
            pageSize: syncData.pageSize,
            autoResizeWindow: syncData.autoResizeWindow,
            defaultPortfolio: syncData.defaultPortfolio,
            hideKeyPoints: syncData.hideKeyPoints,
            enableTrash: syncData.enableTrash,
            refreshOnOpen: syncData.refreshOnOpen,
            enableQuickImport: syncData.enableQuickImport,
            quickImportInStockWindow: syncData.quickImportInStockWindow,
            enableAi: syncData.enableAi,
            keepMonitoringOnClose: syncData.keepMonitoringOnClose,
            keepRefreshOnClose: syncData.keepRefreshOnClose,
            dataSource: syncData.dataSource,
            cronJobs: syncData.cronJobs || [],
            aiMaxToolIterations: syncData.aiMaxToolIterations,
            ...(sensitive ? {
                apiKey: syncData.apiKey,
                aiProviders: syncData.aiProviders || [],
                aiActiveProviderId: syncData.aiActiveProviderId || '',
            } : {}),
        },
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.download = `thswc_full_backup_${sensitive ? 'sensitive_' : ''}${comboTimestamp()}.json`;
    a.href = URL.createObjectURL(blob);
    a.click();
    URL.revokeObjectURL(a.href);
}

// AI 对话脱敏：任何导出（含敏感导出）都不携带 base64 原始图片数据。
// - 上传的图片/文件在消息中已含「[用户上传图片/文件：<文件名>，...]」文本占位，保留之；
// - 剪贴板粘贴图片只存 dataURL、无文件名，统一替换为「[用户上传图片：粘贴图片]」；
// - 仅处理副本，不改动存储中的会话。
function sanitizeAiChats(sessions) {
    if (!sessions || typeof sessions !== 'object') return sessions;
    const clone = {};
    for (const [id, s] of Object.entries(sessions)) {
        const messages = Array.isArray(s.messages)
            ? s.messages.map(m => {
                if (!Array.isArray(m.content) || !m.content.some(p => p && p.type === 'image_url')) return { ...m };
                return { ...m, content: sanitizeMessageContent(m.content) };
            })
            : s.messages;
        clone[id] = { ...s, messages };
    }
    return clone;
}

// 单条消息内容脱敏：去掉全部 image_url（base64）部分，只保留文本部分；
// 上传图片已有「用户上传图片：<名>」占位文本则直接保留；粘贴图片补充统一占位符
function sanitizeMessageContent(content) {
    const textParts = content.filter(p => p && p.type === 'text');
    const hasImgPlaceholder = textParts.some(p => /用户上传图片/.test(p.text));
    if (hasImgPlaceholder) return textParts;
    const placeholder = { type: 'text', text: '[用户上传图片：粘贴图片]' };
    return textParts.length ? [...textParts, placeholder] : [placeholder];
}

// 全量导入：导入插件全部数据和配置（覆盖当前数据）
async function handleImport(file) {
    let text;
    try { text = await file.text(); } catch { alert('文件读取失败'); return; }
    let data;
    try { data = JSON.parse(text); } catch { alert('JSON 解析失败'); return; }
    // 验证格式
    if (!data || typeof data !== 'object') {
        alert('无效文件：不是有效的 JSON 对象'); return;
    }
    if (data.type !== 'full-backup') {
        if (!confirm('该文件不是全量备份格式，可能无法完整恢复。确定继续导入？')) return;
    }
    let importPrompt = '导入将覆盖当前全部数据（所有组合、要点、事件、设置、AI 对话与记忆）';
    if (data.sensitive === false) importPrompt += '。该备份不含 API Key，导入后小石 / AI 接口的 Key 将保持现状';
    if (!confirm(importPrompt + '，确定继续？')) return;

    // 恢复 local 数据
    if (data.local && typeof data.local === 'object') {
        const localSet = {};
        if (Array.isArray(data.local.stockList)) localSet.stockList = data.local.stockList;
        if (data.local.portfolios && typeof data.local.portfolios === 'object') localSet.portfolios = data.local.portfolios;
        if (typeof data.local.activePortfolio === 'string') localSet.activePortfolio = data.local.activePortfolio;
        if (typeof data.local.currentView === 'string') localSet.currentView = data.local.currentView;
        if (Array.isArray(data.local.keyPoints)) localSet.keyPoints = data.local.keyPoints;
        if (Array.isArray(data.local.events)) localSet.events = data.local.events;
        if (data.local.aiChats && typeof data.local.aiChats === 'object') localSet.aiChats = data.local.aiChats;
        if (data.local.aiMemory && typeof data.local.aiMemory === 'object') localSet.aiMemory = data.local.aiMemory;
        if (Object.keys(localSet).length) {
            await new Promise(r => chrome.storage.local.set(localSet, r));
        }
    }

    // 恢复 sync 数据
    if (data.sync && typeof data.sync === 'object') {
        const syncSet = {};
        if (typeof data.sync.refreshInterval === 'number') syncSet.refreshInterval = data.sync.refreshInterval;
        if (typeof data.sync.selectorName === 'string') syncSet.selectorName = data.sync.selectorName;
        if (typeof data.sync.pageSize === 'number') syncSet.pageSize = data.sync.pageSize;
        if (typeof data.sync.autoResizeWindow === 'boolean') syncSet.autoResizeWindow = data.sync.autoResizeWindow;
        if (typeof data.sync.defaultPortfolio === 'string') syncSet.defaultPortfolio = data.sync.defaultPortfolio;
        if (typeof data.sync.hideKeyPoints === 'boolean') syncSet.hideKeyPoints = data.sync.hideKeyPoints;
        if (typeof data.sync.enableTrash === 'boolean') syncSet.enableTrash = data.sync.enableTrash;
        if (typeof data.sync.refreshOnOpen === 'boolean') syncSet.refreshOnOpen = data.sync.refreshOnOpen;
        if (typeof data.sync.enableQuickImport === 'boolean') syncSet.enableQuickImport = data.sync.enableQuickImport;
        if (typeof data.sync.quickImportInStockWindow === 'boolean') syncSet.quickImportInStockWindow = data.sync.quickImportInStockWindow;
        if (typeof data.sync.enableAi === 'boolean') syncSet.enableAi = data.sync.enableAi;
        if (typeof data.sync.keepMonitoringOnClose === 'boolean') syncSet.keepMonitoringOnClose = data.sync.keepMonitoringOnClose;
        if (typeof data.sync.keepRefreshOnClose === 'boolean') syncSet.keepRefreshOnClose = data.sync.keepRefreshOnClose;
        if (['refresh', 'xiaoshi', 'adata'].includes(data.sync.dataSource)) syncSet.dataSource = data.sync.dataSource;
        if (Array.isArray(data.sync.cronJobs)) syncSet.cronJobs = data.sync.cronJobs;
        if (typeof data.sync.aiMaxToolIterations === 'number') syncSet.aiMaxToolIterations = Math.max(1, data.sync.aiMaxToolIterations);
        // 敏感数据（仅敏感备份含）：小石 Key / AI 接口配置
        if (typeof data.sync.apiKey === 'string') syncSet.apiKey = data.sync.apiKey;
        if (Array.isArray(data.sync.aiProviders)) syncSet.aiProviders = data.sync.aiProviders;
        if (typeof data.sync.aiActiveProviderId === 'string') syncSet.aiActiveProviderId = data.sync.aiActiveProviderId;
        if (Object.keys(syncSet).length) {
            await new Promise(r => chrome.storage.sync.set(syncSet, r));
        }
    }

    // 刷新当前页面状态
    await initState();
    // 重新读取 sync 设置到本地变量（导入写的 autoResizeWindow 等不会自动同步）
    await new Promise(r => chrome.storage.sync.get(['autoResizeWindow', 'hideKeyPoints', 'enableTrash', 'refreshOnOpen', 'enableQuickImport', 'quickImportInStockWindow', 'enableAi', 'keepMonitoringOnClose', 'keepRefreshOnClose', 'defaultPortfolio', 'pageSize', 'selectorName', 'dataSource'], (result) => {
        autoResizeWindow = result.autoResizeWindow !== false;
        hideKeyPoints = !!result.hideKeyPoints;
        enableTrash = result.enableTrash === true;
        refreshOnOpen = result.refreshOnOpen !== false;
        enableQuickImport = result.enableQuickImport !== false;
        quickImportInStockWindow = result.quickImportInStockWindow !== false;
        enableAi = result.enableAi !== false;
        keepMonitoringOnClose = !!result.keepMonitoringOnClose;
        keepRefreshOnClose = !!result.keepRefreshOnClose;
        if (result.pageSize) pageSize = result.pageSize;
        if (result.selectorName) { selectorName = result.selectorName; selectorEl.value = selectorName; }
        if (result.dataSource) dataSourceSelectEl.value = result.dataSource;
        applyKeyPointsVisibility();
        applyTrashVisibility();
        applyAiVisibility();
        updateQuickImportVisibility();
        r();
    }));
    renderStockList();
    refreshCombos();
    loadKeyPoints();
    loadEvents();
    chrome.runtime.sendMessage({ action: 'syncCronJobs' }); // 恢复的 cron 配置立即生效
    alert('导入完成，全部数据已恢复');
}

// ---------------- 编辑弹窗 ----------------
function openEdit(stock) {
    overlayEl.style.display = 'flex';
    lastMonitorEl.style.display = '';
    editUrl = stock.url;
    stockUrlGroupEl.style.display = 'none'; // 编辑页网址不可改，隐藏整组
    editForm.render(stock);
}

function closeModal() {
    lastMonitorEl.style.display = 'block';
    overlayEl.style.display = 'none';
    stockUrlEl.disabled = false;
}

// 启停单按钮视觉态：未运行 [▶ 开始监控]，运行中 [■ 停止监控]
function updateStatus(isActive) {
    isMonitoring = isActive;
    startStopBtn.classList.toggle('running', isActive);
    // 图标由 CSS 按 .running 显隐切换，此处仅更新文案（textContent 会覆盖内联 svg，不可用）
    startStopBtn.querySelector('.btn-label').textContent = isActive ? '停止监控' : '开始监控';
    startStopBtn.title = isActive ? '停止' : '开始当前组合监控';
}

// ---------------- 事件接线 ----------------
closeBtnEl.addEventListener('click', closeModal);
window.addEventListener('click', (event) => { if (event.target === overlayEl) closeModal(); });

// 初始化状态（从 background 获取最新数据）
async function initState() {
    return new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: 'getStatus' }, (response) => {
            if (!response) { resolve(); return; }
            intervalInput.value = Number.isFinite(response.refreshInterval)
                ? response.refreshInterval
                : 60;
            selectorName = response.selectorName || 'wc1';
            selectorEl.value = selectorName;
            stockList = response.stockList || [];
            pageSize = response.pageSize || 10;
            currentView = 'list'; // 每次打开弹窗固定股票列表视图，不记忆上次的垃圾池
            chrome.runtime.sendMessage({ action: 'setView', view: 'list' }); // 同步后台视图与存储，调度仍按股票列表
            portfolios = response.portfolios || {};
            activePortfolio = response.activePortfolio || '持仓';
            updateStatus(false);
            // 监控可能在弹窗重开前已在运行（refreshTimer 由浏览器托管）：
            // 按实际 alarm 存在与否恢复按钮状态，避免显示「开始监控」而实际在跑
            chrome.alarms.get('refreshTimer', (alarm) => {
                if (alarm) updateStatus(true);
            });
            updateViewToggleUI();
            resolve();
        });
    });
}

// 首次初始化
initState().then(() => {
    // 加载全局设置（默认组合、自动伸缩、垃圾池开关、打开刷新、一键导入），应用默认组合后再做首次渲染
    chrome.storage.sync.get(['defaultPortfolio', 'autoResizeWindow', 'hideKeyPoints', 'enableTrash', 'refreshOnOpen', 'enableQuickImport', 'quickImportInStockWindow', 'enableAi', 'keepMonitoringOnClose', 'keepRefreshOnClose'], (result) => {
        autoResizeWindow = result.autoResizeWindow !== false;
        hideKeyPoints = !!result.hideKeyPoints;
        enableTrash = result.enableTrash === true; // 默认关闭
        refreshOnOpen = result.refreshOnOpen !== false; // 默认开启
        enableQuickImport = result.enableQuickImport !== false; // 默认开启
        quickImportInStockWindow = result.quickImportInStockWindow !== false; // 默认开启
        enableAi = result.enableAi !== false; // 默认开启
        keepMonitoringOnClose = !!result.keepMonitoringOnClose;
        keepRefreshOnClose = !!result.keepRefreshOnClose;
        applyKeyPointsVisibility();
        applyTrashVisibility();
        applyAiVisibility();
        updateQuickImportVisibility();
        const dp = result.defaultPortfolio || '持仓';
        // 存储的默认组合若已被删除，回退到固定默认「持仓」
        defaultPortfolio = portfolios[dp] ? dp : '持仓';
        // 默认组合有效且与当前不同时，打开弹窗直接切到该组合（覆盖上次关闭时的组合）
        if (portfolios[dp] && dp !== activePortfolio) {
            activePortfolio = dp;
            stockList = portfolios[dp].stockList || [];
            selectorName = portfolios[dp].selectorName || 'wc1';
            selectorEl.value = selectorName;
            chrome.storage.local.set({ activePortfolio, stockList });
            chrome.storage.sync.set({ selectorName });
            currentPage = 1;
            currentSort = 'default';
            chrome.runtime.sendMessage({ action: 'refresh' }); // 监控运行中则立即按新组合重排刷新任务
        }
        refreshCombos();
        renderStockList();
        // 组合标签行渲染后补一次 resize，修正初始高度差值（不受设置开关限制）
        const count = stockList.filter(s => currentView === 'trash' ? s.inTrash : !s.inTrash).length;
        chrome.runtime.sendMessage({ action: 'resizePopupWindow', rows: Math.min(count, pageSize) });
        // 「打开插件时全部更新」：打开即全量刷新股票数据（不弹窗提示，数据落地后仅更新首页「上次更新时间」）
        if (refreshOnOpen) {
            chrome.runtime.sendMessage({ action: 'refreshAll' });
        }
    });
});

// 按快速打开逻辑拆分输入内容（空格、中英文逗号、顿号、分号、竖线、斜杠、星号，
// 忽略纯 - 分隔线；星号通常跟在名称后，一并剔除）
function splitQuickOpenInput() {
    return quickOpenEl.value.split(/[\s,，、；;|\/*]+/).filter(item => item && !/^-+$/.test(item));
}

// 按快速打开逻辑构造单个搜索项的跳转地址：
// ETF（159/51/58）问财不支持，直接开雪球个股页；其余跟随选择器（xq1 雪球搜索，否则问财搜索）
function buildQuickOpenUrl(item) {
    const etfPrefix = etfPrefixForCode(item);
    if (etfPrefix) {
        return `https://xueqiu.com/S/${etfPrefix}${item}`;
    }
    return selectorName === 'xq1'
        ? `https://xueqiu.com/k?q=${encodeURIComponent(item)}`
        : `https://www.iwencai.com/screener/result?w=${encodeURIComponent(item)}&querytype=stock`;
}

quickOpenEl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && quickOpenEl.value) {
        event.preventDefault();
        const items = splitQuickOpenInput();
        if (items.length === 0) return;
        // 放开抓取窗口：监控未运行时，打开的页面抓取也能回填解析
        chrome.runtime.sendMessage({ action: 'armCapture' });
        // 逐个延迟打开，避免一次性打开过多页面（1.5-2.2s 随机间隔）
        let delay = 0;
        items.forEach((item) => {
            delay += 1500 + Math.random() * 700;
            setTimeout(() => {
                chrome.tabs.create({ url: buildQuickOpenUrl(item) });
            }, delay);
        });
    }
});

// 一键导入：按快速打开逻辑把输入内容建组导入——
// 弹窗选择已有组合（含默认组合）或输入新组合名；按名称去重，组合内同名跳过
function handleQuickImport() {
    const items = splitQuickOpenInput();
    if (items.length === 0) return;
    openQuickImportComboModal(items);
}

let pendingImportItems = []; // 组合选择弹窗确认时待导入的输入项

// 打开一键导入的组合选择弹窗（下拉已有组合 + 输入新建）
function openQuickImportComboModal(items) {
    pendingImportItems = items;
    quickImportComboSelectEl.innerHTML = '';
    Object.keys(portfolios).forEach(name => {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        quickImportComboSelectEl.appendChild(opt);
    });
    // 默认选中当前活动组合（或第一个）
    quickImportComboSelectEl.value = Object.keys(portfolios).includes(activePortfolio)
        ? activePortfolio
        : (Object.keys(portfolios)[0] || '');
    quickImportComboInputEl.value = '';
    quickImportComboOverlayEl.style.display = 'flex';
}

function closeQuickImportComboModal() {
    quickImportComboOverlayEl.style.display = 'none';
    pendingImportItems = [];
}

// 执行导入：写入目标组合（不存在则新建），按名称去重，随后逐个打开页面
function executeQuickImport(items, name) {
    if (!portfolios[name]) {
        portfolios[name] = { stockList: [], selectorName };
    }
    const target = portfolios[name].stockList;
    const now = Date.now();
    let added = 0;
    let skipped = 0;
    items.forEach(item => {
        const url = normalizeUrl(buildQuickOpenUrl(item)); // 问财/雪球搜索页地址作为股票标识
        if (!url) return;
        if (target.some(s => s.name === item)) { skipped++; return; } // 组合内同名跳过
        target.push({
            url, name: item, code: '', prefix: '', // 名称先取输入词，抓取后回填
            startPrice: null, currentPrice: null, percent: null,
            importPrice: null,
            targetPercentLe: '', targetPercentGe: '',
            importTargetPercentLe: '', importTargetPercentGe: '',
            stopRunning: false, notifiedDaily: false, notifiedImport: false,
            inTrash: false, pinned: false, pinOrder: null, createdAt: now,
        });
        added++;
    });
    if (added === 0) { alert(`组合「${name}」中已存在全部输入项（按名称匹配），已跳过`); return; }
    chrome.storage.local.set({ portfolios }, () => {
        switchPortfolio(name); // 切到导入的组合，便于查看
        // 页面打开方式：默认在最小化专属窗口（refreshOne 自带抓取放开窗口）；
        // 关闭「页面打开逻辑不同」后统一在普通 Chrome 页面打开（需放开抓取窗口）
        const openUrl = (item) => {
            const url = buildQuickOpenUrl(item);
            if (quickImportInStockWindow) {
                chrome.runtime.sendMessage({ action: 'refreshOne', url });
            } else {
                chrome.runtime.sendMessage({ action: 'armCapture' });
                chrome.tabs.create({ url });
            }
        };
        // 逐个延迟打开，避免一次性打开过多页面（1.5-2.2s 随机间隔）
        let delay = 0;
        items.forEach(item => {
            delay += 1500 + Math.random() * 700;
            setTimeout(() => openUrl(item), delay);
        });
        quickOpenEl.value = '';
        updateQuickImportVisibility();
        alert(`已导入 ${added} 支股票到组合「${name}」${skipped > 0 ? `，跳过 ${skipped} 支重复` : ''}，页面将逐个打开`);
    });
}

// 组合选择弹窗事件：确认时输入优先（新建或匹配现有），否则用下拉选中
confirmQuickImportComboBtnEl.addEventListener('click', () => {
    const items = pendingImportItems;
    if (!items || items.length === 0) return;
    const inputName = quickImportComboInputEl.value.trim();
    let name;
    if (inputName) {
        if (!validComboName(inputName)) { alert('组合命名必须为1-4个字'); return; }
        name = inputName; // 与现有组合重名时自然导入到现有组合
    } else {
        name = quickImportComboSelectEl.value;
    }
    if (!name) { alert('请选择或输入组合名称'); return; }
    executeQuickImport(items, name);
    closeQuickImportComboModal();
});
quickImportComboOverlayEl.addEventListener('click', (e) => {
    if (e.target === quickImportComboOverlayEl) closeQuickImportComboModal();
});
closeQuickImportComboBtnEl.addEventListener('click', closeQuickImportComboModal);

// 「一键导入」按钮显隐：开关启用且输入框有内容时显示
function updateQuickImportVisibility() {
    quickImportBtnEl.style.display = (enableQuickImport && quickOpenEl.value.trim()) ? '' : 'none';
}
quickOpenEl.addEventListener('input', updateQuickImportVisibility);
quickImportBtnEl.addEventListener('click', handleQuickImport);

// 选择器变更：持久化并镜像到活动组合，立即按新生效地址重排刷新（名称跳转也随之更新）
selectorEl.addEventListener('change', () => {
    selectorName = selectorEl.value;
    if (portfolios[activePortfolio]) portfolios[activePortfolio].selectorName = selectorName;
    chrome.storage.sync.set({ selectorName });
    chrome.storage.local.set({ portfolios });
    renderStockList();
    chrome.runtime.sendMessage({ action: 'refresh' });
});

// 刷新间隔输入即改即存：原先只在点「开始」时写入 storage，改值后直接关闭弹窗
// 会丢改动、重开时回到旧值；改为 change 时立即持久化（监控周期仍以点「开始」生效）
intervalInput.addEventListener('change', () => {
    const v = parseInt(intervalInput.value, 10);
    if (Number.isFinite(v)) {
        chrome.storage.sync.set({ refreshInterval: v });
    }
});

// 启停单按钮：按当前运行状态在开始/停止间切换
startStopBtn.addEventListener('click', () => {
    if (isMonitoring) {
        chrome.runtime.sendMessage({ action: 'stopRefresh' }, (response) => {
            if (response && response.status === 'stopped') updateStatus(false);
        });
        return;
    }
    let interval = parseInt(intervalInput.value);
    selectorName = selectorEl.value;
    // 空输入/非法值会得到 NaN：NaN < 30 为 false 兜不住，NaN 周期使 alarms.create 静默失败、
    // UI 却显示运行中。另注：正式打包环境 chrome.alarms 周期下限 1 分钟（解载开发模式 30 秒）
    if (!Number.isFinite(interval) || interval < 30) { interval = 30; intervalInput.value = 30; }
    if (!selectorName) { alert('请选择选择器名称'); return; }
    chrome.runtime.sendMessage({ action: 'startRefresh', interval, selectorName }, (response) => {
        if (response && response.status === 'started') updateStatus(true);
    });
});

addStockEl.addEventListener('click', () => {
    overlayEl.style.display = 'flex';
    lastMonitorEl.style.display = '';
    editUrl = undefined; // 须先清空：clear() 内 getStock() 依赖 editUrl，否则读到上一只股票
    editForm.clear();
    editActionsTopEl.style.display = 'none';
    stockUrlGroupEl.style.display = ''; // 新增需填网址
    stockUrlEl.disabled = false;
});

saveStockBtnEl.addEventListener('click', () => {
    const rawUrl = stockUrlEl.value;
    if (!rawUrl) { alert('请输入网址'); return; }
    const tLe = targetPercentLeEl.value;
    const tGe = targetPercentGeEl.value;
    const iLe = importTargetPercentLeEl.value;
    const iGe = importTargetPercentGeEl.value;
    let addedUrl = null;
    if (editUrl) {
        const item = stockList.find(s => s.url === editUrl);
        if (!item) { alert('保存失败，请关闭重试'); return; }
        // 名称只读（抓取自动更新），保存不回写
        item.targetPercentLe = tLe;
        item.targetPercentGe = tGe;
        item.importTargetPercentLe = iLe;
        item.importTargetPercentGe = iGe;
        const newImportPrice = numOrNull(importPriceInputEl.value);
        if (newImportPrice !== null) item.importPrice = newImportPrice; // 留空保持原值
        item.notifiedDaily = false; // 阈值变更重置通知标记
        item.notifiedImport = false;
    } else {
        const url = normalizeUrl(stripSign(rawUrl)); // 新建：先截掉 &sign= 再规范化
        if (!url) { alert('网址格式不正确'); return; }
        if (stockList.some(s => s.url === url)) { alert('网址已存在'); return; }
        stockList.push({
            url, name: '', code: '', prefix: '', // 名称留空，首次抓取自动回填
            startPrice: null, currentPrice: null, percent: null,
            importPrice: numOrNull(importPriceInputEl.value),
            targetPercentLe: tLe, targetPercentGe: tGe,
            importTargetPercentLe: iLe, importTargetPercentGe: iGe,
            stopRunning: false, notifiedDaily: false, notifiedImport: false,
            inTrash: false, pinned: false, pinOrder: null, createdAt: Date.now(),
        });
        addedUrl = url;
    }
    saveAndRender();
    closeModal();
    // 新增股票：保存后立即访问一次网址回填数据（名称/代码/现价等），不等下一轮定时
    if (addedUrl) {
        chrome.runtime.sendMessage({ action: 'refreshOne', url: addedUrl });
    }
});

delStockBtnEl.addEventListener('click', () => {
    if (!editUrl) return;
    const index = stockList.findIndex(item => item.url === editUrl);
    if (index === -1) return;
    stockList.splice(index, 1);
    saveAndRender();
    closeModal();
});

trashToggleBtnEl.addEventListener('click', () => {
    const item = stockList.find(s => s.url === editUrl);
    if (!item) return;
    item.inTrash = !item.inTrash;
    saveAndRender();
    closeModal();
});

// 股价提醒维度切换：当日/导入以来两组阈值折叠为一组，切换填写（两组值各自保留）
function switchAlertDim(daily) {
    dailyTargetGroupEl.style.display = daily ? '' : 'none';
    importTargetGroupEl.style.display = daily ? 'none' : '';
    alertDimDailyBtnEl.classList.toggle('active', daily);
    alertDimImportBtnEl.classList.toggle('active', !daily);
}
alertDimDailyBtnEl.addEventListener('click', () => switchAlertDim(true));
alertDimImportBtnEl.addEventListener('click', () => switchAlertDim(false));

viewListBtnEl.addEventListener('click', () => switchView('list'));
viewTrashBtnEl.addEventListener('click', () => switchView('trash'));

exportBtnEl.addEventListener('click', () => exportChoiceOverlayEl.style.display = 'flex');
closeExportChoiceBtnEl.addEventListener('click', () => exportChoiceOverlayEl.style.display = 'none');
exportDefaultBtnEl.addEventListener('click', () => {
    exportChoiceOverlayEl.style.display = 'none';
    handleExport(false);
});
exportSensitiveBtnEl.addEventListener('click', () => {
    exportChoiceOverlayEl.style.display = 'none';
    handleExport(true);
});

// 复制仅分组和股票数据
exportCopyBtnEl.addEventListener('click', () => {
    exportChoiceOverlayEl.style.display = 'none';
    showCopyComboOverlay();
});
closeCopyComboBtnEl.addEventListener('click', () => copyComboOverlayEl.style.display = 'none');
copyComboOverlayEl.addEventListener('click', (e) => {
    if (e.target === copyComboOverlayEl) copyComboOverlayEl.style.display = 'none';
});
confirmCopyComboBtnEl.addEventListener('click', handleCopyComboConfirm);
importBtnEl.addEventListener('click', () => importFileInputEl.click());
importFileInputEl.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) handleImport(file);
    e.target.value = ''; // 允许重复导入同一文件
});

sortToggleEls.forEach(el => {
    el.addEventListener('click', () => {
        const field = el.getAttribute('data-field');
        if (currentSort === field + '-desc') currentSort = field + '-asc';
        else if (currentSort === field + '-asc') currentSort = 'default';
        else currentSort = field + '-desc';
        currentPage = 1;
        renderStockList();
    });
});

// ---------------- 要点管理 ----------------
// 加载要点数据
function loadKeyPoints() {
    chrome.storage.local.get(['keyPoints'], (result) => {
        keyPoints = result.keyPoints || [];
        renderKeyPointsList();
    });
}

// 保存要点数据
function saveKeyPoints() {
    chrome.storage.local.set({ keyPoints });
}

// 渲染要点列表（按权重从大到小排序）
function renderKeyPointsList() {
    keyPointsListEl.innerHTML = '';
    // 按权重降序排序
    const sorted = [...keyPoints].sort((a, b) => b.weight - a.weight);
    if (sorted.length === 0) {
        keyPointsListEl.innerHTML = '<div style="text-align:center;color:#999;padding:20px;">暂无要点，请添加</div>';
        return;
    }
    sorted.forEach((kp, idx) => {
        const realIdx = keyPoints.indexOf(kp);
        const item = document.createElement('div');
        item.className = 'keypoint-item';
        item.innerHTML = `
            <span class="keypoint-seq">${idx + 1}、</span>
            <span class="keypoint-text" title="点击查看该要点的所有事件记录">${escapeHtml(kp.text)}</span>
            <span class="keypoint-weight">(${kp.weight})</span>
            <div class="keypoint-actions">
                <button class="keypoint-action-btn keypoint-edit-btn" data-idx="${realIdx}">编辑</button>
                <button class="keypoint-action-btn keypoint-delete-btn" data-idx="${realIdx}">删除</button>
            </div>
        `;
        keyPointsListEl.appendChild(item);
    });
    // 点击要点文本：跳转到对应事件记录列表
    keyPointsListEl.querySelectorAll('.keypoint-text').forEach(el => {
        el.addEventListener('click', () => filterEventsByKeyPoint(el.textContent));
    });
    // 要点增删改后刷新事件筛选下拉（保留当前选中值）
    updateEventFilterSelect();
    // 绑定编辑和删除事件
    keyPointsListEl.querySelectorAll('.keypoint-edit-btn').forEach(btn => {
        btn.addEventListener('click', () => editKeyPoint(parseInt(btn.dataset.idx)));
    });
    keyPointsListEl.querySelectorAll('.keypoint-delete-btn').forEach(btn => {
        btn.addEventListener('click', () => deleteKeyPoint(parseInt(btn.dataset.idx)));
    });
}

// HTML 转义
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// 打开要点管理弹窗
function openKeyPoints() {
    keyPointsOverlayEl.style.display = 'flex';
    resetKeyPointForm();
    resetEventForm();
    renderKeyPointsList();
    updateEventKeyPointSelect();
    switchTab('keypoints');
}

// 关闭要点管理弹窗
function closeKeyPoints() {
    keyPointsOverlayEl.style.display = 'none';
    resetKeyPointForm();
}

// ---------------- 全局设置 ----------------
function openSettings() {
    autoResizeToggleEl.checked = autoResizeWindow;
    showKeyPointsToggleEl.checked = !hideKeyPoints;
    enableTrashToggleEl.checked = enableTrash;
    refreshOnOpenToggleEl.checked = refreshOnOpen;
    enableQuickImportToggleEl.checked = enableQuickImport;
    quickImportInStockWindowToggleEl.checked = quickImportInStockWindow;
    // 填充默认组合下拉框（始终有活动组合可选）
    defaultPortfolioSelectEl.innerHTML = '';
    Object.keys(portfolios).forEach(name => {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        defaultPortfolioSelectEl.appendChild(opt);
    });
    defaultPortfolioSelectEl.value = defaultPortfolio;
    // 数据获取方式 / API Key / cron 定时任务（每次打开读取最新，跨弹窗会话同步）
    chrome.storage.sync.get(['dataSource', 'apiKey', 'cronJobs'], (result) => {
        dataSource = result.dataSource || 'adata';
        cronJobs = Array.isArray(result.cronJobs) ? result.cronJobs : [];
        dataSourceSelectEl.value = dataSource;
        apiKeyInputEl.value = result.apiKey || '';
        updateApiKeyGroupVisibility();
        renderCronJobList();
    });
    // 启用 AI 分析开关回填（API 配置在 AI 窗口内编辑，此处不涉及）
    enableAiToggleEl.checked = enableAi;
    keepMonitoringOnCloseToggleEl.checked = keepMonitoringOnClose;
    keepRefreshOnCloseToggleEl.checked = keepRefreshOnClose;
    settingsOverlayEl.style.display = 'flex';
}

// API Key 组仅数据获取方式为「小石大数据」时显示（新浪/腾讯公开接口无需 Key）
function updateApiKeyGroupVisibility() {
    apiKeyGroupEl.style.display = dataSource === 'xiaoshi' ? '' : 'none';
}

// ---------------- cron 定时任务（最多 3 个） ----------------
function renderCronJobList() {
    cronJobListEl.innerHTML = '';
    cronJobs.forEach((job, idx) => {
        const row = document.createElement('div');
        row.className = 'cron-job-row';
        // 表达式输入：失焦校验，无效还原不保存
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'cron-expr-input';
        input.placeholder = '分 时 日 月 周，如 0 9 * * 1-5';
        input.value = job.expr || '';
        input.title = 'cron 表达式：分 时 日 月 周（日/周任一满足即触发）';
        input.addEventListener('change', () => {
            const v = input.value.trim();
            if (!validateCronExpr(v)) {
                alert('cron 表达式无效。格式：分 时 日 月 周，如 0 9 * * 1-5');
                input.value = cronJobs[idx].expr || '';
                return;
            }
            cronJobs[idx].expr = v;
            saveCronJobs();
        });
        // 启用开关
        const enableLabel = document.createElement('label');
        enableLabel.className = 'cron-enable';
        const enableCb = document.createElement('input');
        enableCb.type = 'checkbox';
        enableCb.checked = !!job.enabled;
        enableCb.addEventListener('change', () => {
            cronJobs[idx].enabled = enableCb.checked;
            saveCronJobs();
        });
        enableLabel.appendChild(enableCb);
        enableLabel.appendChild(document.createTextNode('启用'));
        // 删除按钮
        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'cron-del-btn';
        delBtn.textContent = '×';
        delBtn.title = '删除该定时任务';
        delBtn.addEventListener('click', () => {
            if (!confirm('删除该定时任务？')) return;
            cronJobs.splice(idx, 1);
            renderCronJobList();
            saveCronJobs();
        });
        row.appendChild(input);
        row.appendChild(enableLabel);
        row.appendChild(delBtn);
        cronJobListEl.appendChild(row);
    });
    addCronJobBtnEl.disabled = cronJobs.length >= 3;
}

// 保存 cron 配置并让 background 按最新配置重排
function saveCronJobs() {
    chrome.storage.sync.set({ cronJobs });
    chrome.runtime.sendMessage({ action: 'syncCronJobs' });
}

// 按「隐藏要点管理」开关控制首页要点管理图标的显隐
function applyKeyPointsVisibility() {
    openKeyPointsBtnEl.style.display = hideKeyPoints ? 'none' : '';
}

// 按「启用垃圾池」开关控制垃圾池入口：隐藏整个「股票/垃圾池」切换组与
// 编辑弹窗「加入垃圾池」按钮；关闭时若当前处于垃圾池视图则切回股票列表
function applyTrashVisibility() {
    viewSwitchGroupEl.style.display = enableTrash ? '' : 'none';
    trashToggleBtnEl.style.display = enableTrash ? '' : 'none';
    if (!enableTrash && currentView === 'trash') {
        switchView('list');
    }
}

function closeSettings() {
    settingsOverlayEl.style.display = 'none';
}

// 请求插件弹窗按当前活动股票数量调整高度
function requestResizePopup() {
    if (!autoResizeWindow) return;
    const count = stockList.filter(s => currentView === 'trash' ? s.inTrash : !s.inTrash).length;
    const rows = Math.min(count, pageSize);
    chrome.runtime.sendMessage({ action: 'resizePopupWindow', rows });
}

// 重置表单
function resetKeyPointForm() {
    keyPointTextInputEl.value = '';
    keyPointWeightInputEl.value = '';
    editingKeyPointIndex = -1;
    addKeyPointBtnEl.textContent = '添加';
}

// 添加或更新要点
function addOrUpdateKeyPoint() {
    const text = keyPointTextInputEl.value.trim();
    const weight = parseInt(keyPointWeightInputEl.value);
    if (!text) { alert('请输入要点内容'); return; }
    if (!weight || weight < 1 || weight > 99) { alert('权重必须为 1-99 的数字'); return; }

    if (editingKeyPointIndex === -1) {
        // 新增模式
        keyPoints.push({ text, weight });
    } else {
        // 编辑模式
        keyPoints[editingKeyPointIndex] = { text, weight };
    }
    saveKeyPoints();
    renderKeyPointsList();
    resetKeyPointForm();
}

// 编辑要点
function editKeyPoint(idx) {
    const kp = keyPoints[idx];
    if (!kp) return;
    keyPointTextInputEl.value = kp.text;
    keyPointWeightInputEl.value = kp.weight;
    editingKeyPointIndex = idx;
    addKeyPointBtnEl.textContent = '更新';
    keyPointTextInputEl.focus();
}

// 删除要点
function deleteKeyPoint(idx) {
    if (!confirm('确定删除该要点？')) return;
    keyPoints.splice(idx, 1);
    saveKeyPoints();
    renderKeyPointsList();
    if (editingKeyPointIndex === idx) {
        resetKeyPointForm();
    } else if (editingKeyPointIndex > idx) {
        editingKeyPointIndex--;
    }
}

// 事件绑定
openKeyPointsBtnEl.addEventListener('click', openKeyPoints);
closeKeyPointsBtnEl.addEventListener('click', closeKeyPoints);
addKeyPointBtnEl.addEventListener('click', addOrUpdateKeyPoint);
keyPointsOverlayEl.addEventListener('click', (e) => {
    if (e.target === keyPointsOverlayEl) closeKeyPoints();
});

// 全局设置事件绑定
openSettingsBtnEl.addEventListener('click', openSettings);
closeSettingsBtnEl.addEventListener('click', closeSettings);
settingsOverlayEl.addEventListener('click', (e) => {
    if (e.target === settingsOverlayEl) closeSettings();
});
autoResizeToggleEl.addEventListener('change', () => {
    autoResizeWindow = autoResizeToggleEl.checked;
    chrome.storage.sync.set({ autoResizeWindow });
});

defaultPortfolioSelectEl.addEventListener('change', () => {
    defaultPortfolio = defaultPortfolioSelectEl.value;
    chrome.storage.sync.set({ defaultPortfolio });
});

// 「显示要点图标」默认勾选；取消勾选 = 隐藏（存储键仍为 hideKeyPoints，兼容旧数据）
showKeyPointsToggleEl.addEventListener('change', () => {
    hideKeyPoints = !showKeyPointsToggleEl.checked;
    chrome.storage.sync.set({ hideKeyPoints });
    applyKeyPointsVisibility();
});

// 「启用垃圾池」默认勾选；取消后隐藏垃圾池入口
enableTrashToggleEl.addEventListener('change', () => {
    enableTrash = enableTrashToggleEl.checked;
    chrome.storage.sync.set({ enableTrash });
    applyTrashVisibility();
});

// 「打开插件时全部更新」默认勾选；取消后打开插件不再自动全量刷新
refreshOnOpenToggleEl.addEventListener('change', () => {
    refreshOnOpen = refreshOnOpenToggleEl.checked;
    chrome.storage.sync.set({ refreshOnOpen });
});

// 「启用快速打开一键导入」默认勾选；取消后不再显示一键导入按钮
enableQuickImportToggleEl.addEventListener('change', () => {
    enableQuickImport = enableQuickImportToggleEl.checked;
    chrome.storage.sync.set({ enableQuickImport });
    updateQuickImportVisibility();
});

// 「页面打开逻辑不同」默认勾选：一键导入走最小化专属窗口；关闭后统一普通页面打开
quickImportInStockWindowToggleEl.addEventListener('change', () => {
    quickImportInStockWindow = quickImportInStockWindowToggleEl.checked;
    chrome.storage.sync.set({ quickImportInStockWindow });
});

// 数据获取方式：refresh 页面刷新 / api 批量行情接口
dataSourceSelectEl.addEventListener('change', () => {
    dataSource = dataSourceSelectEl.value;
    chrome.storage.sync.set({ dataSource });
    updateApiKeyGroupVisibility();
});

// API Key：即改即存（Key 仅存本地，仅在「导出包含 API Key 的敏感数据」时随备份导出）
apiKeyInputEl.addEventListener('change', () => {
    chrome.storage.sync.set({ apiKey: apiKeyInputEl.value.trim() });
});

// 「启用 AI 分析」开关：控制首页 AI 入口显隐（API 配置在 AI 窗口内编辑）
function applyAiVisibility() {
    openAiChatBtnEl.style.display = enableAi ? '' : 'none';
}
enableAiToggleEl.addEventListener('change', () => {
    enableAi = enableAiToggleEl.checked;
    chrome.storage.sync.set({ enableAi });
    applyAiVisibility();
});

keepMonitoringOnCloseToggleEl.addEventListener('change', () => {
    keepMonitoringOnClose = keepMonitoringOnCloseToggleEl.checked;
    chrome.storage.sync.set({ keepMonitoringOnClose });
});

keepRefreshOnCloseToggleEl.addEventListener('change', () => {
    keepRefreshOnClose = keepRefreshOnCloseToggleEl.checked;
    chrome.storage.sync.set({ keepRefreshOnClose });
});

// AI 窗口切换组合时，弹窗实时跟随（不写回 storage 避免循环）
// 从 storage 重新加载组合数据（AI 工具等外部写入后同步内存，避免旧快照被后续写操作覆盖）
function reloadPortfoliosFromStorage() {
    chrome.storage.local.get(['portfolios', 'stockList', 'activePortfolio'], (r) => {
        if (!r.portfolios || typeof r.portfolios !== 'object') return;
        portfolios = r.portfolios;
        if (r.activePortfolio) activePortfolio = r.activePortfolio;
        if (portfolios[activePortfolio]) {
            stockList = portfolios[activePortfolio].stockList || [];
            selectorName = portfolios[activePortfolio].selectorName || selectorName;
        } else {
            stockList = r.stockList || [];
        }
        // 保留当前分页/排序/编辑状态，仅重渲染列表与组合
        renderStockList();
        refreshCombos();
        requestResizePopup();
    });
}

chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') {
        if (changes.activePortfolio) {
            syncPortfolioFromStorage(changes.activePortfolio.newValue);
        }
        // AI 工具写入要点/事件后同步弹窗（自身写入的 keyPoints/events 也会触发，重渲染幂等无害）
        if (changes.keyPoints) loadKeyPoints();
        if (changes.events) loadEvents();
        // AI 工具增删/移动股票后同步组合数据，避免旧内存快照在后续写操作时覆盖 storage
        if (changes.portfolios || changes.stockList) reloadPortfoliosFromStorage();
    }
});

// AI 窗口 switch_portfolio 后同步弹窗状态（storage 已由 AI 侧写入，此处只更新内存与 UI；
// 监控重排的 refresh 消息也已由 AI 侧发出，不重复发送）
function syncPortfolioFromStorage(name) {
    if (!name || name === activePortfolio || !portfolios[name]) return;
    activePortfolio = name;
    stockList = portfolios[name].stockList || [];
    selectorName = portfolios[name].selectorName || 'wc1';
    selectorEl.value = selectorName;
    currentPage = 1;
    currentSort = 'default';
    refreshCombos();
    renderStockList();
    requestResizePopup();
}

// 打开 AI 对话窗口（独立窗口单例，由 background 创建/聚焦）
openAiChatBtnEl.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'openAiChat' });
});

// 一键刷新：全部组合的全部股票（含已停止的），与监控运行状态无关；
// 数据获取方式为 xiaoshi（需 API Key）或 adata（新浪/腾讯公开接口）时走 API 批量行情
refreshAllBtnEl.addEventListener('click', () => {
    chrome.storage.sync.get(['dataSource', 'apiKey'], ({ dataSource: ds, apiKey }) => {
        const mode = ds || 'adata';
        const isApi = mode === 'xiaoshi' || mode === 'adata';
        // 点击立即反馈：本地聚合可刷新股票数，不等到 background 全部执行完
        const n = isApi ? countAllCodes() : countAllStocks();
        if (n === 0) {
            alert(isApi ? '当前没有可通过 API 刷新的股票（需 6 位数字代码）' : '当前没有可刷新的股票');
            return;
        }
        if (mode === 'xiaoshi' && !apiKey) {
            alert('请先在全局设置中填写小石大数据 API Key');
            return;
        }
        alert(`将刷新 ${n} 支股票，请稍等片刻，时间根据股票数量决定`);
        chrome.runtime.sendMessage({ action: 'refreshAll' }, (resp) => {
            if (resp && resp.status === 'ok') {
                alert('刷新结束，将在 1 分钟内全部完成');
            }
        });
    });
});

// 本地聚合全部组合的股票数（与 background refreshAllStocks 聚合逻辑一致：
// 含已停止的股票，按生效地址跨组合去重）
function countAllStocks() {
    const seen = new Set();
    Object.keys(portfolios).forEach(name => {
        const p = portfolios[name];
        const sn = p.selectorName || 'wc1';
        (p.stockList || []).forEach(s => {
            const url = stripSign(effectiveStockUrl(s, sn));
            if (url && !seen.has(url)) seen.add(url);
        });
    });
    return seen.size;
}

// API 模式下可刷新的股票数：有 6 位数字 code 的股票（跨组合去重，排除港股）
function countAllCodes() {
    const seen = new Set();
    Object.keys(portfolios).forEach(name => {
        (portfolios[name].stockList || []).forEach(s => {
            if (s.prefix === 'HK') return;
            const c = String(s.code || '').trim();
            if (/^\d{6}$/.test(c) && !seen.has(c)) seen.add(c);
        });
    });
    return seen.size;
}

// 添加 cron 定时任务（最多 3 个）
addCronJobBtnEl.addEventListener('click', () => {
    if (cronJobs.length >= 3) return;
    cronJobs.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), expr: '', enabled: true });
    renderCronJobList();
});

// 初始化加载要点数据
loadKeyPoints();

// ---------------- 事件管理 ----------------
// 加载事件数据
function loadEvents() {
    chrome.storage.local.get(['events'], (result) => {
        events = (result.events || []).map(event => {
            // 兼容旧版：旧版将归档写入 status，无法恢复归档前状态时默认按「准确」处理
            if (event.status === 'archived') {
                return { ...event, status: 'accurate', archived: true };
            }
            return { ...event, archived: !!event.archived };
        });
        renderEventsList();
        updateEventKeyPointSelect();
    });
}

// 保存事件数据
function saveEvents() {
    chrome.storage.local.set({ events });
}

// 生成唯一 ID
function generateEventId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
}

// 更新事件关联要点下拉框
function updateEventKeyPointSelect() {
    const currentValue = eventKeyPointSelectEl.value;
    eventKeyPointSelectEl.innerHTML = '<option value="">选择关联要点</option>';
    keyPoints.forEach(kp => {
        const option = document.createElement('option');
        option.value = kp.text;
        option.textContent = kp.text;
        eventKeyPointSelectEl.appendChild(option);
    });
    if (currentValue) {
        eventKeyPointSelectEl.value = currentValue;
    }
}

// 渲染事件列表（按时间倒序，支持按要点筛选）
function renderEventsList() {
    eventsListEl.innerHTML = '';
    // 按要点筛选
    const filtered = eventFilterKeyPoint
        ? events.filter(e => e.keyPointText === eventFilterKeyPoint)
        : events;
    if (filtered.length === 0) {
        eventsListEl.innerHTML = `<div style="text-align:center;color:#999;padding:20px;">${eventFilterKeyPoint ? '该要点暂无事件记录' : '暂无事件，请添加'}</div>`;
        return;
    }
    // 按日期、要点和状态合并为同一张卡片；只有已归档的事件才合并，
    // 未归档的事件每条独立成组（保持可独立编辑/改状态）
    const sorted = [...filtered].sort((a, b) => new Date(b.time) - new Date(a.time));
    const groups = [];
    const groupMap = new Map();
    sorted.forEach(event => {
        if (!event.archived) {
            groups.push({ events: [event], keyPointText: event.keyPointText || '', time: event.time, status: event.status, archived: false });
            return;
        }
        const key = [event.time, event.keyPointText || '', event.status, true].join(' ');
        let group = groupMap.get(key);
        if (!group) {
            group = { events: [], keyPointText: event.keyPointText || '', time: event.time, status: event.status, archived: true };
            groupMap.set(key, group);
            groups.push(group);
        }
        group.events.push(event);
    });
    groups.forEach((group, groupIndex) => {
        const item = document.createElement('div');
        item.className = 'event-item';
        if (group.archived) item.classList.add('archived');
        const statusText = group.status === 'accurate' ? '准确' : group.status === 'wrong' ? '误判' : '待预测';
        const statusControl = group.archived
            ? `<span class="event-status ${group.status} archived">${statusText}</span>`
            : `<select class="event-status-select" data-group-index="${groupIndex}">
                <option value="pending" ${group.status === 'pending' ? 'selected' : ''}>待预测</option>
                <option value="accurate" ${group.status === 'accurate' ? 'selected' : ''}>准确</option>
                <option value="wrong" ${group.status === 'wrong' ? 'selected' : ''}>误判</option>
               </select>`;
        const canArchive = !group.archived && (group.status === 'accurate' || group.status === 'wrong');
        const archiveBtn = canArchive ? `<button class="event-icon-btn event-archive-btn" data-group-index="${groupIndex}" title="归档"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h16v11H4zM3 5h18v3H3zM8 13h8M12 10v7m0 0-3-3m3 3 3-3"/></svg></button>` : '';
        const contentRows = group.events.map(event => `
            <div class="event-content-row">
                <div class="event-content">${escapeHtml(event.content)}</div>
            </div>
        `).join('');
        const rowActions = group.events.map(event => `
            ${group.archived ? '' : `<button class="event-icon-btn event-edit-btn" data-id="${event.id}" title="编辑"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 16-.7 4.7L8 20l11-11a2.1 2.1 0 0 0-3-3zM14 7l3 3"/></svg></button>`}
            <button class="event-icon-btn event-delete-btn" data-id="${event.id}" title="删除"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M9 7V5h6v2m-8 0 1 13h8l1-13M10 11v5m4-5v5"/></svg></button>
        `).join('');
        item.innerHTML = `
            <div class="event-meta">
                <span class="event-time">${group.time}</span>
                ${group.keyPointText ? `<span class="event-keypoint-tag" title="${escapeHtml(group.keyPointText)}">${escapeHtml(group.keyPointText)}</span>` : ''}
            </div>
            <div class="event-content-list">${contentRows}</div>
            <div class="event-footer">
                ${statusControl}
                <div class="event-actions">${archiveBtn}${rowActions}</div>
            </div>
        `;
        eventsListEl.appendChild(item);
    });
    // 同一张卡片内的状态和归档操作作用于该卡片的全部事件
    eventsListEl.querySelectorAll('.event-status-select').forEach(el => {
        el.addEventListener('change', () => setEventGroupStatus(groups[el.dataset.groupIndex], el.value));
    });
    eventsListEl.querySelectorAll('.event-archive-btn').forEach(el => {
        el.addEventListener('click', () => archiveEventGroup(groups[el.dataset.groupIndex]));
    });
    // 绑定编辑和删除事件
    eventsListEl.querySelectorAll('.event-edit-btn').forEach(btn => {
        btn.addEventListener('click', () => editEvent(btn.dataset.id));
    });
    eventsListEl.querySelectorAll('.event-delete-btn').forEach(btn => {
        btn.addEventListener('click', () => deleteEvent(btn.dataset.id));
    });
    // 准确率：当前筛选下已归档事件的准确占比（准确且已归档 / 已归档）
    const archivedPool = filtered.filter(e => e.archived);
    if (archivedPool.length === 0) {
        eventAccuracyEl.textContent = '准确率 -';
    } else {
        const accurateCount = archivedPool.filter(e => e.status === 'accurate').length;
        eventAccuracyEl.textContent = `准确率 ${Math.round(accurateCount / archivedPool.length * 100)}%`;
    }
}

// 刷新「按要点筛选」下拉框（保留当前选中值；被删要点则重置为全部）
function updateEventFilterSelect() {
    const stillExists = keyPoints.some(kp => kp.text === eventFilterKeyPoint);
    if (eventFilterKeyPoint && !stillExists) eventFilterKeyPoint = '';
    eventFilterSelectEl.innerHTML = '<option value="">全部要点</option>';
    keyPoints.forEach(kp => {
        const option = document.createElement('option');
        option.value = kp.text;
        option.textContent = kp.text;
        eventFilterSelectEl.appendChild(option);
    });
    eventFilterSelectEl.value = eventFilterKeyPoint || '';
}

// 直接设置事件状态（替代原点击轮换）
function setEventStatus(id, status) {
    const event = events.find(e => e.id === id);
    if (!event || event.archived) return;
    if (!['pending', 'accurate', 'wrong'].includes(status)) return;
    event.status = status;
    saveEvents();
    renderEventsList();
}

// 批量设置同一卡片内事件的状态
function setEventGroupStatus(group, status) {
    if (!group || group.archived || !['pending', 'accurate', 'wrong'].includes(status)) return;
    group.events.forEach(event => { event.status = status; });
    saveEvents();
    renderEventsList();
}

// 批量归档同一卡片内事件
function archiveEventGroup(group) {
    if (!group || group.archived || !['accurate', 'wrong'].includes(group.status)) return;
    if (!confirm('归档后该卡片内事件将无法编辑和修改状态，只能删除。确定归档？')) return;
    group.events.forEach(event => { event.archived = true; });
    saveEvents();
    renderEventsList();
}

// 归档事件：仅「准确」和「误判」状态可归档，归档后保留原状态且仅可删除
function archiveEvent(id) {
    const event = events.find(e => e.id === id);
    if (!event || event.archived || !['accurate', 'wrong'].includes(event.status)) return;
    if (!confirm('归档后该事件将无法编辑和修改状态，只能删除。确定归档？')) return;
    event.archived = true;
    saveEvents();
    renderEventsList();
}

// 添加或更新事件
function addOrUpdateEvent() {
    const keyPointText = eventKeyPointSelectEl.value;
    const content = eventContentInputEl.value.trim();
    const time = eventDateInputEl.value;
    if (!content) { alert('请输入事件内容'); return; }
    if (!time) { alert('请选择日期'); return; }

    if (editingEventId === null) {
        // 新增模式
        events.push({
            id: generateEventId(),
            keyPointText,
            content,
            time,
            status: 'pending',
            archived: false
        });
    } else {
        // 编辑模式
        const event = events.find(e => e.id === editingEventId);
        if (event) {
            event.keyPointText = keyPointText;
            event.content = content;
            event.time = time;
        }
    }
    saveEvents();
    renderEventsList();
    resetEventForm();
}

// 编辑事件
function editEvent(id) {
    const event = events.find(e => e.id === id);
    if (!event || event.archived) return;
    eventKeyPointSelectEl.value = event.keyPointText || '';
    eventContentInputEl.value = event.content;
    eventDateInputEl.value = event.time;
    editingEventId = id;
    addEventBtnEl.textContent = '更新';
    eventContentInputEl.focus();
}

// 删除事件
function deleteEvent(id) {
    if (!confirm('确定删除该事件？')) return;
    events = events.filter(e => e.id !== id);
    saveEvents();
    renderEventsList();
    if (editingEventId === id) {
        resetEventForm();
    }
}

// 重置事件表单
function resetEventForm() {
    eventKeyPointSelectEl.value = '';
    eventContentInputEl.value = '';
    eventDateInputEl.value = new Date().toISOString().split('T')[0];
    editingEventId = null;
    addEventBtnEl.textContent = '添加';
}

// 标签页切换
function switchTab(tab, keepEventContext = false) {
    if (tab === 'keypoints') {
        tabKeyPointsBtnEl.classList.add('active');
        tabEventsBtnEl.classList.remove('active');
        tabKeyPointsContentEl.style.display = 'block';
        tabEventsContentEl.style.display = 'none';
    } else {
        tabEventsBtnEl.classList.add('active');
        tabKeyPointsBtnEl.classList.remove('active');
        tabEventsContentEl.style.display = 'block';
        tabKeyPointsContentEl.style.display = 'none';
        // 直接点击事件记录 tab 时清空关联要点和筛选条件；跳转时保留对应要点
        if (!keepEventContext) {
            eventKeyPointSelectEl.value = '';
            eventFilterKeyPoint = '';
        }
        updateEventKeyPointSelect();
        updateEventFilterSelect();
        renderEventsList();
    }
}

// 从要点列表点击要点项，跳转到事件记录列表并按该要点筛选
function filterEventsByKeyPoint(text) {
    eventFilterKeyPoint = text;
    eventKeyPointSelectEl.value = text;
    switchTab('events', true);
}

// 事件管理事件绑定
tabKeyPointsBtnEl.addEventListener('click', () => switchTab('keypoints'));
tabEventsBtnEl.addEventListener('click', () => switchTab('events'));
addEventBtnEl.addEventListener('click', addOrUpdateEvent);
eventFilterSelectEl.addEventListener('change', () => {
    eventFilterKeyPoint = eventFilterSelectEl.value;
    renderEventsList();
});
clearEventFilterBtnEl.addEventListener('click', () => {
    eventFilterKeyPoint = '';
    eventFilterSelectEl.value = '';
    renderEventsList();
});

// 初始化加载事件数据
loadEvents();
