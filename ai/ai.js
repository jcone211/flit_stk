// ai.js —— AI 对话窗口主逻辑（ES module）：
// 页面驱动 function-calling 循环；background 只做无状态流式代理（见 ai_backend.js）。
// 职责：port 连接与重连、消息渲染、会话管理（多会话切换）、多份接口配置切换、
// 工具定义与执行（storage 读取与组合切换 / FSA 多目录文件 / 全量刷新）、
// 会话历史与长期记忆持久化（chrome.storage.local 的 aiChats / aiMemory）。

import { getDateTime } from '../shared/utils.js';
import {
    getWorkspaceHandles, pickPrimaryWorkspace, addWorkspaceDir, removeWorkspaceDir,
    workspacePermission, reauthorizeWorkspace, readyRoot,
    listDir, readFile, readFileBinary, writeFile, appendFile, writeUpload
} from './fsa.js';
import { parquetMetadataAsync, parquetSchema, parquetReadObjects, toJson } from './vendor/hyparquet/index.js';
import { compressors } from './vendor/hyparquet/compressors.js';
import { xiaoshiSearchStock, xiaoshiDailyKline, xiaoshiQuote } from './xiaoshi_stock_kline.js';
import { getMarketDaily as adataGetMarketDaily, getMarketEtfDaily as adataGetMarketEtfDaily } from './adata_stock_kline.js';
import { parseCronExpr, nextTradingCronTimes } from '../shared/cron.js';

// 诊断日志开关：置 false 可停止逐次请求刷屏（warn/error 始终保留）
const DEBUG = true;
const dbg = (...args) => { if (DEBUG) console.log('[thswc:ai]', ...args); };

// ---------------- 常量 ----------------
const DEFAULT_MAX_TOOL_ITERATIONS = 18; // 工具调用轮数上限默认值（设置中可配 1-50）
const MAX_MESSAGES = 100;           // 单会话历史上限
const MAX_MESSAGE_CHARS = 10000;    // 单条消息存储截断
const MAX_MEMORY_ITEMS = 50;        // 长期记忆条目上限
const MAX_TOOL_RESULT_CHARS = 20000; // 单条工具结果截断
const REQUEST_TIMEOUT_MS = 120000;   // 页面侧兜底超时（SW 无声死亡时恢复 UI）
const CHAT_KEY = 'aiChats';
const MEMORY_KEY = 'aiMemory';
const DEFAULT_AI_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_AI_MODEL = 'deepseek-chat';

// ---------------- 模块状态 ----------------
let port = null;
let sessions = {};             // 全部会话 { [chatId]: { id, title, messages, createdAt, updatedAt } }
let currentChatId = null;      // 当前会话 id
let chatMessages = [];         // 当前会话消息（仅 user/assistant，不含 tool 过程）
let memoryItems = [];          // 长期记忆 [{ id, content, ts }]
let workspaceHandles = [];     // 已授权工作目录 [{ name, handle }]，主目录在首位
let providers = [];            // 接口配置 [{ id, name, baseUrl, apiKey, model, supportsVision }]
let activeProviderId = '';     // 当前生效的接口配置 id
let defaultVisionProviderId = ''; // 全局默认视觉模型配置 id
let maxToolIterations = DEFAULT_MAX_TOOL_ITERATIONS; // 单次提问最多工具往返轮数（设置可配）
let generating = false;
let currentRequestId = 0;
let lastRequestSnapshot = null; // 最近一次失败请求快照 { messages }（重试按钮用）
let pendingImages = []; // 粘贴待发送图片：[{ dataUrl, file, name }]
let lastFailUi = null; // 失败渲染清理快照：{ errorEl, actionWrap, failEntry }（重试时移除）

// ---------------- DOM 引用 ----------------
const messagesEl = document.getElementById('messagesEl');
const scrollDownBtn = document.getElementById('scrollDownBtn');
const chatInput = document.getElementById('chatInput');
const sendBtn = document.getElementById('sendBtn');
const stopBtn = document.getElementById('stopBtn');
const uploadBtn = document.getElementById('uploadBtn');
const uploadInput = document.getElementById('uploadInput');
const pastePreviews = document.getElementById('pastePreviews');
const intentBubblesEl = document.getElementById('intentBubbles');
const intentBubbleEls = document.querySelectorAll('.intent-bubble');
const sessionSelect = document.getElementById('sessionSelect');
const newSessionBtn = document.getElementById('newSessionBtn');
const renameSessionBtn = document.getElementById('renameSessionBtn');
const deleteSessionBtn = document.getElementById('deleteSessionBtn');
const clearChatBtn = document.getElementById('clearChatBtn');
const openAiSettingsBtn = document.getElementById('openAiSettingsBtn');
const dirStatusBar = document.getElementById('dirStatusBar');
const aiSettingsOverlay = document.getElementById('aiSettingsOverlay');
const closeAiSettingsBtn = document.getElementById('closeAiSettingsBtn');
const aiProviderSelect = document.getElementById('aiProviderSelect');
const aiProviderAddBtn = document.getElementById('aiProviderAddBtn');
const aiProviderDelBtn = document.getElementById('aiProviderDelBtn');
const aiProviderNameInput = document.getElementById('aiProviderName');
const aiBaseUrlInput = document.getElementById('aiBaseUrl');
const aiApiKeyInput = document.getElementById('aiApiKey');
const aiModelInput = document.getElementById('aiModel');
const aiSupportsVisionInput = document.getElementById('aiSupportsVision');
const aiMaxToolIterationsInput = document.getElementById('aiMaxToolIterations');
const aiDefaultVisionProviderSelect = document.getElementById('aiDefaultVisionProvider');

// ---------------- 工具 ----------------
const storageGet = (area, keys) => new Promise(resolve => area.get(keys, resolve));
const storageSet = (area, obj) => new Promise(resolve => area.set(obj, () => {
    resolve();
}));

// 生成唯一 id（会话消息/图片删除定位用）
function genUid(prefix) {
    return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// 工具定义（OpenAI function schema，全部在页面本地执行）
const TOOL_DEFS = [
    { type: 'function', function: { name: 'get_stock_list', description: '读取股票列表：不传 portfolio 读当前活动组合；传组合名读指定组合（组合名可用 get_portfolios 查询）', parameters: { type: 'object', properties: { portfolio: { type: 'string', description: '组合名，如「持仓」「观察」；缺省为当前活动组合' } }, required: [] } } },
    { type: 'function', function: { name: 'get_portfolios', description: '读取全部持仓组合结构（各组合名称与股票数量）及当前活动组合', parameters: { type: 'object', properties: {}, required: [] } } },
    { type: 'function', function: { name: 'switch_portfolio', description: '切换当前活动组合（影响插件弹窗显示与定时监控范围），先校验组合是否存在', parameters: { type: 'object', properties: { name: { type: 'string', description: '目标组合名' } }, required: ['name'] } } },
    { type: 'function', function: { name: 'get_key_points', description: '读取交易要点列表（要点内容与权重）', parameters: { type: 'object', properties: {}, required: [] } } },
    { type: 'function', function: { name: 'get_events', description: '读取事件记录列表（关联要点/内容/日期/状态）。默认只返回未归档事件；仅当用户明确要求查看全部（含已归档）时才传 include_archived=true。返回项中 duplicateDates 列出与该项内容相同但日期不同的其他事件日期，供识别重复事件。若存在超 7 天且状态为准确/误判的未归档事件，会一并自动归档并在 remind 中说明；超 7 天仍为待预测的事件会嘱你在回复中提醒用户修改状态', parameters: { type: 'object', properties: { include_archived: { type: 'boolean', description: '是否返回全部事件（含已归档），缺省 false 仅未归档' } }, required: [] } } },
    { type: 'function', function: { name: 'create_key_point', description: '创建一条交易要点（内容 + 权重 1-99）', parameters: { type: 'object', properties: { text: { type: 'string', description: '要点内容' }, weight: { type: 'number', description: '权重 1-99' } }, required: ['text', 'weight'] } } },
    { type: 'function', function: { name: 'update_key_point', description: '修改要点（按原文定位；改动内容不影响已关联该要点的历史事件）', parameters: { type: 'object', properties: { old_text: { type: 'string', description: '要修改的要点原文' }, text: { type: 'string', description: '新的要点内容' }, weight: { type: 'number', description: '新的权重 1-99' } }, required: ['old_text', 'text', 'weight'] } } },
    { type: 'function', function: { name: 'delete_key_point', description: '删除一条要点（不删除其关联事件）', parameters: { type: 'object', properties: { text: { type: 'string', description: '要删除的要点内容' } }, required: ['text'] } } },
    { type: 'function', function: { name: 'create_event', description: '创建一条预测事件。事件内容(content)只填股票名称（如「百通能源」），禁止把分析/预测/操作文字写入 content；判断逻辑、时间与操作应体现为关联要点。关联要点(key_point_text)须优先从 get_key_points 已有的要点中选择（拿不准先用 get_key_points 查看现有要点再对应关联，不要臆造不存在的要点内容），现有要点与意图不完全匹配时才新建要点或留空。time 为 YYYY-MM-DD，缺省今天。若存在超过一周仍未归档的事件会一并提醒用户补充', parameters: { type: 'object', properties: { key_point_text: { type: 'string', description: '关联现有业已存在或本次新建的要点内容，可为空' }, content: { type: 'string', description: '事件内容，仅填股票名称' }, time: { type: 'string', description: '事件日期 YYYY-MM-DD' } }, required: ['content'] } } },
    { type: 'function', function: { name: 'update_event', description: '修改事件（按 id；已归档事件不可修改），可改关联要点/内容/日期/status（pending 待预测 / accurate 准确 / wrong 误判）。不能设置归档——归档只发生在手动点击或事件超 7 天且状态为准确/误判时自动进行，若刚改状态的事件因此被自动归档，结果会说明。当存在多条内容相同的事件时，默认修改其中 time 最早（最久远）的那条 id，并在回复中简略提醒用户还有其它日期存在相同内容事件', parameters: { type: 'object', properties: { id: { type: 'string', description: '事件 id（用 get_events 查询）' }, key_point_text: { type: 'string', description: '新的关联要点' }, content: { type: 'string', description: '新的事件内容' }, time: { type: 'string', description: '新的事件日期 YYYY-MM-DD' }, status: { type: 'string', description: '新状态：pending 待预测 / accurate 准确 / wrong 误判' } }, required: ['id'] } } },
    { type: 'function', function: { name: 'delete_event', description: '删除一条事件（按 id）', parameters: { type: 'object', properties: { id: { type: 'string', description: '事件 id（用 get_events 查询）' } }, required: ['id'] } } },
    { type: 'function', function: { name: 'add_stock_to_portfolio', description: '按名称向指定组合添加一只股票（组合缺省「持仓」）。自动生成问财搜索页作为监控地址，ETF（159/51/58 开头）走雪球个股页', parameters: { type: 'object', properties: { name: { type: 'string', description: '股票名称' }, portfolio: { type: 'string', description: '目标组合名，缺省「持仓」' } }, required: ['name'] } } },
    { type: 'function', function: { name: 'move_stock_to_combo', description: '把股票从来源组合移动到目标组合（按名称匹配、忽略首尾空格；来源缺省当前活动组合，目标缺省「观察」）。用于记录「卖出」等调仓：卖出时应传 source_portfolio 为实际持有该股的组合（通常「持仓」）；若目标组合已存在同名股票，则仅从来源组合删除、不重复添加', parameters: { type: 'object', properties: { name: { type: 'string', description: '股票名称' }, target_portfolio: { type: 'string', description: '目标组合名，缺省「观察」' }, source_portfolio: { type: 'string', description: '来源组合名（卖出的实际持仓组合），缺省当前活动组合' } }, required: ['name'] } } },
    { type: 'function', function: { name: 'get_current_view', description: '读取当前列表视图（股票列表或垃圾池）', parameters: { type: 'object', properties: {}, required: [] } } },
    { type: 'function', function: { name: 'get_settings', description: '读取扩展全局设置（刷新间隔/选择器/分页/cron 定时任务，不含任何密钥）', parameters: { type: 'object', properties: {}, required: [] } } },
    { type: 'function', function: { name: 'update_cron', description: '直接修改 Cron 并返回新配置和后续执行时间', parameters: { type: 'object', properties: { operation: { type: 'string', enum: ['add', 'update', 'delete', 'enable', 'disable'] }, target: { type: 'string', description: '任务序号、任务 ID 或当前表达式；新增时可省略' }, expr: { type: 'string', description: '目标 Cron 表达式；删除时省略' } }, required: ['operation'] } } },
    { type: 'function', function: { name: 'save_memory', description: '保存一条长期记忆（用户偏好/习惯等），之后每轮对话都会注入；同时镜像到主工作目录 memory.md', parameters: { type: 'object', properties: { content: { type: 'string', description: '要记住的内容' } }, required: ['content'] } } },
    { type: 'function', function: { name: 'refresh_all', description: '触发扩展全量刷新全部组合股票（按全局设置的数据获取方式执行）', parameters: { type: 'object', properties: {}, required: [] } } },
    { type: 'function', function: { name: 'list_workspaces', description: '列出已授权的全部工作目录（主目录与附加目录）及其权限状态', parameters: { type: 'object', properties: {}, required: [] } } },
    { type: 'function', function: { name: 'list_dir', description: '列出工作目录（或子目录）内容。root 缺省为主目录，可传附加目录名；软链接条目无法访问（浏览器安全限制）', parameters: { type: 'object', properties: { path: { type: 'string', description: '相对所选目录的路径，空为根目录' }, root: { type: 'string', description: '工作目录名，可用 list_workspaces 查询；缺省为主目录' } }, required: [] } } },
    { type: 'function', function: { name: 'read_parquet', description: '读取工作目录中的 Parquet 数据文件，返回列名、总行数和限定数量的行。适合查询股票日线等 parquet 数据；path 必须是相对授权工作目录的路径，root 缺省为主目录。默认最多返回 100 行，可用 columns 选择列。', parameters: { type: 'object', properties: { path: { type: 'string', description: '相对工作目录的 .parquet 文件路径' }, root: { type: 'string', description: '工作目录名，缺省为主目录' }, columns: { type: 'array', items: { type: 'string' }, description: '要读取的列名；缺省读取全部列' }, row_start: { type: 'integer', minimum: 0, description: '起始行，缺省 0' }, limit: { type: 'integer', minimum: 1, maximum: 500, description: '最多返回行数，缺省 100，最大 500' } }, required: ['path'] } } },
    { type: 'function', function: { name: 'read_stock_kline', description: '获取股票近 N 天日线 K 线（开/高/低/收/成交量/成交额/涨跌幅）。优先读取工作目录 parquet 缓存（data/a_share_daily/qfq/data_*.parquet，小石量化数据）；当缓存缺少最近交易日数据时自动调用小石量化 API 补齐。支持按股票名称或代码。', parameters: { type: 'object', properties: { name: { type: 'string', description: '股票名称，如「德明利」；与 code 二选一' }, code: { type: 'string', description: '股票代码：6 位数字（如 001309）或带市场后缀（如 001309.SZ），不要使用 SH:600519 等冒号前缀形式；与 name 二选一' }, days: { type: 'integer', minimum: 1, maximum: 60, description: '近 N 个交易日，缺省 30' }, root: { type: 'string', description: '工作目录名，缺省为主目录（parquet 数据目录的根，如含 data/a_share_daily 的目录）' } }, required: [] } } },
    { type: 'function', function: { name: 'get_stock_quote', description: '获取股票实时行情（最新价/涨跌幅/昨收/最高/最低/成交量/成交额/换手率），不经页面直接调用小石实时行情接口。支持按股票名称或代码。', parameters: { type: 'object', properties: { name: { type: 'string', description: '股票名称，如「德明利」；与 code 二选一' }, code: { type: 'string', description: '股票代码：6 位数字（如 001309）或带市场后缀（如 001309.SZ），不要使用 SH:600519 等冒号前缀形式；与 name 二选一' } }, required: [] } } },
    { type: 'function', function: { name: 'get_portfolio_quotes', description: '批量获取指定组合全部股票的实时行情（最新价/涨跌幅/昨收/最高/最低/成交量/成交额/换手率）。一次调用返回所有股票，无需逐只查询', parameters: { type: 'object', properties: { portfolio: { type: 'string', description: '组合名，如「持仓」「观察」；缺省为当前活动组合' } }, required: [] } } },

    { type: 'function', function: { name: 'append_file', description: '向工作目录中的文本文件追加内容（不存在则创建）', parameters: { type: 'object', properties: { path: { type: 'string', description: '相对所选目录的文件路径' }, content: { type: 'string', description: '要追加的内容' }, root: { type: 'string', description: '工作目录名，缺省为主目录' } }, required: ['path', 'content'] } } },
];

const TOOL_GROUPS = {
    portfolio: ['get_stock_list', 'get_portfolios', 'switch_portfolio', 'add_stock_to_portfolio', 'move_stock_to_combo', 'get_current_view'],
    market: ['get_stock_quote', 'get_portfolio_quotes', 'refresh_all', 'read_stock_kline'],
    events: ['get_key_points', 'create_key_point', 'update_key_point', 'delete_key_point', 'get_events', 'create_event', 'update_event', 'delete_event'],
    settings: ['get_settings', 'update_cron'],
    workspace: ['list_workspaces', 'list_dir', 'read_file', 'write_file', 'append_file', 'read_parquet'],
    memory: ['save_memory'],
};
const TOOL_GROUP_RULES = {
    portfolio: '组合和股票工具：需要组合名时先读取组合结构，按用户指定组合操作。',
    market: '行情工具：批量查询用 get_portfolio_quotes（一次返回组合全部股票实时行情）；个股日线分析用 read_stock_kline。',
    events: '要点/事件工具：先读取已有要点；事件 content 只写股票名称。',
    settings: '设置工具：仅 Cron 可修改；修改前校验表达式，成功后立即生效。',
    workspace: '工作区工具：root 用目录名定位，只访问用户已授权目录。',
    memory: '记忆工具：仅保存用户明确要求长期记住的偏好。',
};
const TOOL_BY_NAME = new Map(TOOL_DEFS.map(def => [def.function.name, def]));
const TOOL_GROUP_DEF = {
    type: 'function',
    function: {
        name: 'load_tool_group',
        description: '按需加载一组工具定义',
        parameters: {
            type: 'object',
            properties: { group: { type: 'string', enum: Object.keys(TOOL_GROUPS) } },
            required: ['group'],
        },
    },
};
const TOOL_CATALOG = Object.keys(TOOL_GROUPS).map(group => `${group}: ${TOOL_GROUP_RULES[group]}`).join('\n');
let activeToolGroups = new Set();

function getLoadedToolDefs() {
    const names = new Set();
    for (const group of activeToolGroups) {
        for (const name of TOOL_GROUPS[group] || []) names.add(name);
    }
    return [...names].map(name => {
        const def = TOOL_BY_NAME.get(name);
        if (!def) return null;
        const compact = structuredClone(def);
        compact.function.description = name.replaceAll('_', ' ');
        for (const property of Object.values(compact.function.parameters?.properties || {})) {
            delete property.description;
        }
        return compact;
    }).filter(Boolean);
}

// 股票条目精简视图（列表与组合通用）
function pickStockView(s) {
    return {
        name: s.name || '(待抓取)',
        code: s.prefix ? s.prefix + ':' + s.code : (s.code || ''),
        importPrice: s.importPrice ?? null,
        startPrice: s.startPrice ?? null,
        currentPrice: s.currentPrice ?? null,
        percent: s.percent ?? null,
        inTrash: !!s.inTrash,
        stopRunning: !!s.stopRunning,
        lastUpdateAt: s.lastUpdateAt ?? null,
    };
}

// 工具执行器：name -> async (args) => 结果（字符串或对象，统一 JSON.stringify 回传模型）
const toolExecutors = {
    async get_stock_list(args) {
        const portfolio = args && args.portfolio ? String(args.portfolio).trim() : '';
        if (!portfolio) {
            const { stockList } = await storageGet(chrome.storage.local, 'stockList');
            return summarizeList(stockList || [], pickStockView);
        }
        const { portfolios } = await storageGet(chrome.storage.local, 'portfolios');
        const p = (portfolios || {})[portfolio];
        if (!p) {
            return { error: `组合「${portfolio}」不存在`, available: Object.keys(portfolios || {}) };
        }
        return summarizeList(p.stockList || [], pickStockView);
    },
    async get_portfolios() {
        const { portfolios, activePortfolio } = await storageGet(chrome.storage.local, ['portfolios', 'activePortfolio']);
        const names = Object.keys(portfolios || {});
        const structure = names.map(name => ({
            name,
            stockCount: (portfolios[name].stockList || []).length,
            selectorName: portfolios[name].selectorName || 'wc1',
        }));
        return { activePortfolio: activePortfolio || '', structure };
    },
    async switch_portfolio(args) {
        const name = String(args.name || '').trim();
        if (!name) return { error: '缺少组合名' };
        const { portfolios } = await storageGet(chrome.storage.local, ['portfolios']);
        const p = (portfolios || {})[name];
        if (!p) {
            return { error: `组合「${name}」不存在`, available: Object.keys(portfolios || {}) };
        }
        // 与 popup switchPortfolio 同款状态写入：活动组合 + 列表镜像 + 选择器
        const stockList = p.stockList || [];
        const selectorName = p.selectorName || 'wc1';
        await storageSet(chrome.storage.local, { activePortfolio: name, stockList });
        await storageSet(chrome.storage.sync, { selectorName });
        // 监控运行中则立即按新组合重排刷新任务（popup 开着时经 onChanged 同步 UI）
        chrome.runtime.sendMessage({ action: 'refresh' });
        return { ok: true, activePortfolio: name, stockCount: stockList.length };
    },
    async get_key_points() {
        const denied = await requireKeyPoints();
        if (denied) return denied;
        const { keyPoints } = await storageGet(chrome.storage.local, 'keyPoints');
        return summarizeList(keyPoints || [], kp => ({ text: kp.text, weight: kp.weight }));
    },
    async get_events(args) {
        const denied = await requireKeyPoints();
        if (denied) return denied;
        const { events } = await storageGet(chrome.storage.local, 'events');
        const list = events || [];
        const { remind, archivedCount } = autoArchiveEvents(list);
        if (archivedCount > 0) await storageSet(chrome.storage.local, { events: list });
        // 默认只返回未归档事件；用户明确要求查看全部时才返回已归档
        const includeAll = !!(args && args.include_archived);
        const target = includeAll ? list : list.filter(e => !e.archived);
        // 标注内容相同但日期不同的其他事件日期，供识别重复事件
        const contentDates = new Map();
        for (const e of target) {
            if (!contentDates.has(e.content)) contentDates.set(e.content, []);
            contentDates.get(e.content).push(e.time);
        }
        const result = summarizeList(target, e => ({
            id: e.id,
            keyPointText: e.keyPointText || '',
            content: e.content,
            time: e.time,
            status: e.status,
            archived: !!e.archived,
            duplicateDates: (contentDates.get(e.content) || []).filter(t => t !== e.time),
        }));
        if (remind) result.remind = remind;
        return result;
    },
    async create_key_point(args) {
        const denied = await requireKeyPoints();
        if (denied) return denied;
        const text = String(args.text || '').trim();
        const weight = parseInt(args.weight, 10);
        if (!text) return { error: '要点内容不能为空' };
        if (!Number.isFinite(weight) || weight < 1 || weight > 99) return { error: '权重必须为 1-99 的数字' };
        const { keyPoints } = await storageGet(chrome.storage.local, 'keyPoints');
        const list = keyPoints || [];
        if (list.some(k => k.text === text)) return { error: `要点「${text}」已存在` };
        list.push({ text, weight });
        await storageSet(chrome.storage.local, { keyPoints: list });
        return { ok: true, text, weight, total: list.length };
    },
    async update_key_point(args) {
        const denied = await requireKeyPoints();
        if (denied) return denied;
        const oldText = String(args.old_text || '').trim();
        const text = String(args.text || '').trim();
        const weight = parseInt(args.weight, 10);
        if (!oldText || !text) return { error: 'old_text 与 text 不能为空' };
        if (!Number.isFinite(weight) || weight < 1 || weight > 99) return { error: '权重必须为 1-99 的数字' };
        const { keyPoints } = await storageGet(chrome.storage.local, 'keyPoints');
        const list = keyPoints || [];
        const idx = list.findIndex(k => k.text === oldText);
        if (idx === -1) return { error: `要点「${oldText}」不存在` };
        list[idx] = { text, weight };
        await storageSet(chrome.storage.local, { keyPoints: list });
        return { ok: true, text, weight };
    },
    async delete_key_point(args) {
        const denied = await requireKeyPoints();
        if (denied) return denied;
        const text = String(args.text || '').trim();
        if (!text) return { error: '要点内容不能为空' };
        const { keyPoints } = await storageGet(chrome.storage.local, 'keyPoints');
        const list = keyPoints || [];
        if (!list.some(k => k.text === text)) return { error: `要点「${text}」不存在` };
        await storageSet(chrome.storage.local, { keyPoints: list.filter(k => k.text !== text) });
        return { ok: true, text };
    },
    async create_event(args) {
        const denied = await requireKeyPoints();
        if (denied) return denied;
        const content = String(args.content || '').trim();
        if (!content) return { error: '事件内容不能为空' };
        const keyPointText = String(args.key_point_text || '').trim();
        if (keyPointText) {
            const { keyPoints } = await storageGet(chrome.storage.local, 'keyPoints');
            if (!(keyPoints || []).some(k => k.text === keyPointText)) {
                return { error: `关联要点「${keyPointText}」不存在，可先用 get_key_points 查看现有要点` };
            }
        }
        let time = String(args.time || '').trim();
        if (!time) time = todayStr();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(time)) return { error: 'time 需为 YYYY-MM-DD 格式' };
        const { events } = await storageGet(chrome.storage.local, 'events');
        const list = events || [];
        const { remind } = autoArchiveEvents(list);
        const event = { id: genUid('ev'), keyPointText, content, time, status: 'pending', archived: false };
        list.push(event);
        await storageSet(chrome.storage.local, { events: list });
        const result = { ok: true, event, total: list.length };
        if (remind) result.remind = remind;
        return result;
    },
    async update_event(args) {
        const denied = await requireKeyPoints();
        if (denied) return denied;
        const id = String(args.id || '').trim();
        if (!id) return { error: '缺少事件 id' };
        const { events, keyPoints } = await storageGet(chrome.storage.local, ['events', 'keyPoints']);
        const list = events || [];
        const ev = list.find(e => e.id === id);
        if (!ev) return { error: `事件 ${id} 不存在` };
        if (ev.archived) return { error: '该事件已归档，不可修改' };
        if (args.key_point_text !== undefined) {
            const kp = String(args.key_point_text).trim();
            if (kp && !(keyPoints || []).some(k => k.text === kp)) {
                return { error: `关联要点「${kp}」不存在` };
            }
            ev.keyPointText = kp;
        }
        if (args.content !== undefined) {
            const c = String(args.content).trim();
            if (!c) return { error: '事件内容不能为空' };
            ev.content = c;
        }
        if (args.time !== undefined) {
            const t = String(args.time).trim();
            if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return { error: 'time 需为 YYYY-MM-DD 格式' };
            ev.time = t;
        }
        if (args.status !== undefined) {
            if (!['pending', 'accurate', 'wrong'].includes(args.status)) return { error: 'status 需为 pending / accurate / wrong' };
            ev.status = args.status;
        }
        // 更新后执行自动归档（改完状态若已超 7 天且为准确/误判，立即归档）
        const { remind, archivedCount } = autoArchiveEvents(list);
        await storageSet(chrome.storage.local, { events: list });
        const result = { ok: true, event: ev };
        if (archivedCount > 0) result.archivedNow = archivedCount;
        if (remind) result.remind = remind;
        return result;
    },
    async delete_event(args) {
        const denied = await requireKeyPoints();
        if (denied) return denied;
        const id = String(args.id || '').trim();
        if (!id) return { error: '缺少事件 id' };
        const { events } = await storageGet(chrome.storage.local, 'events');
        const list = events || [];
        if (!list.some(e => e.id === id)) return { error: `事件 ${id} 不存在` };
        await storageSet(chrome.storage.local, { events: list.filter(e => e.id !== id) });
        return { ok: true, id };
    },
    async add_stock_to_portfolio(args) {
        const name = String(args.name || '').trim();
        if (!name) return { error: '股票名称不能为空' };
        const portfolio = String(args.portfolio || '持仓').trim();
        const { portfolios, activePortfolio, stockList } = await storageGet(chrome.storage.local, ['portfolios', 'activePortfolio', 'stockList']);
        const combos = portfolios || {};
        const target = combos[portfolio];
        if (!target) return { error: `组合「${portfolio}」不存在`, available: Object.keys(combos) };
        const list = target.stockList || (target.stockList = []);
        // 与手动添加一致：由名称拼接问财搜索地址，按 URL 判重
        const url = stockSearchUrl(name);
        if (list.some(s => String(s.url || '') === url)) return { error: `「${name}」已在组合「${portfolio}」中` };
        // 与 popup 手动添加（saveStock 新建分支）同款条目结构：名称留空等首次抓取回填
        list.push({
            url, name: '', code: '', prefix: '',
            startPrice: null, currentPrice: null, percent: null,
            importPrice: null,
            targetPercentLe: null, targetPercentGe: null,
            importTargetPercentLe: null, importTargetPercentGe: null,
            stopRunning: false, notifiedDaily: false, notifiedImport: false,
            inTrash: false, pinned: false, pinOrder: null, createdAt: Date.now(),
        });
        // 与手动 saveAndRender 一致：同步活动组合镜像后写回 storage
        const mirror = (combos[activePortfolio] && combos[activePortfolio].stockList) || stockList || [];
        await storageSet(chrome.storage.local, { portfolios: combos, stockList: mirror });
        // 与手动保存后一致：立即访问一次网址回填数据（名称/代码/现价），不等定时
        chrome.runtime.sendMessage({ action: 'refreshOne', url });
        return { ok: true, name, portfolio, url, hint: '已按手动添加流程保存并立即抓取回填' };
    },
    async move_stock_to_combo(args) {
        const name = String(args.name || '').trim();
        if (!name) return { error: '股票名称不能为空' };
        const target = String(args.target_portfolio || '观察').trim();
        const { portfolios, activePortfolio } = await storageGet(chrome.storage.local, ['portfolios', 'activePortfolio']);
        const combos = portfolios || {};
        if (!combos[target]) return { error: `目标组合「${target}」不存在`, available: Object.keys(combos) };
        let from = args.source_portfolio ? String(args.source_portfolio).trim() : (combos[activePortfolio] ? activePortfolio : null);
        if (from && !combos[from]) return { error: `来源组合「${from}」不存在` };
        let stock = null;
        if (from) stock = findStockByName(combos[from].stockList, name);
        if (!stock) {
            // 来源未命中则全局查找（忽略首尾空格）
            for (const [cn, c] of Object.entries(combos)) {
                const hit = findStockByName(c.stockList, name);
                if (hit) { stock = hit; from = cn; break; }
            }
        }
        if (!stock) return { error: `未找到股票「${name}」，可先用「增加股票」加入持仓组合` };
        if (from === target) return { ok: true, name, from, to: target, already: true };
        // 目标组合已存在同名股票：仅从来源删除，避免重复（如观察已持有该股时的卖出清仓）
        if (findStockByName(combos[target].stockList, name)) {
            combos[from].stockList = (combos[from].stockList || []).filter(s => s !== stock);
            const mirror = (combos[activePortfolio] && combos[activePortfolio].stockList) || [];
            await storageSet(chrome.storage.local, { portfolios: combos, stockList: mirror });
            chrome.runtime.sendMessage({ action: 'refresh' });
            return { ok: true, name, from, to: target, removed: true, hint: `目标组合「${target}」已有同名股票，已仅从「${from}」删除，未重复添加` };
        }
        combos[from].stockList = (combos[from].stockList || []).filter(s => s !== stock);
        (combos[target].stockList || (combos[target].stockList = [])).push(stock);
        const mirror = (combos[activePortfolio] && combos[activePortfolio].stockList) || [];
        await storageSet(chrome.storage.local, { portfolios: combos, stockList: mirror });
        chrome.runtime.sendMessage({ action: 'refresh' });
        return { ok: true, name, from, to: target };
    },
    async get_current_view() {
        const { currentView } = await storageGet(chrome.storage.local, 'currentView');
        return { currentView: currentView || 'list' };
    },
    async get_settings() {
        // 白名单键读取：天然排除 apiKey 等敏感键，双保险
        const res = await storageGet(chrome.storage.sync, ['refreshInterval', 'selectorName', 'pageSize', 'cronJobs']);
        return {
            refreshInterval: res.refreshInterval ?? null,
            selectorName: res.selectorName ?? null,
            pageSize: res.pageSize ?? null,
            cronJobs: res.cronJobs || [],
        };
    },
    async load_tool_group(args) {
        const group = String(args && args.group || '').trim();
        if (!TOOL_GROUPS[group]) return { ok: false, error: '未知工具组', groups: Object.keys(TOOL_GROUPS) };
        activeToolGroups.add(group);
        return { ok: true, group, rule: TOOL_GROUP_RULES[group], tools: TOOL_GROUPS[group] };
    },
    async update_cron(args) {
        const operation = String(args && args.operation || '').trim();
        const target = String(args && args.target || '').trim();
        const expr = String(args && args.expr || '').trim();
        if (!['add', 'update', 'delete', 'enable', 'disable'].includes(operation)) {
            return { ok: false, error: 'operation 必须是 add/update/delete/enable/disable' };
        }
        if (['add', 'update'].includes(operation) && !expr) return { ok: false, error: '新增或修改必须提供 expr' };
        if (expr && !parseCronExpr(expr)) return { ok: false, error: 'Cron 表达式无效' };
        const res = await storageGet(chrome.storage.sync, 'cronJobs');
        const jobs = Array.isArray(res.cronJobs) ? res.cronJobs : [];
        const index = target && /^\d+$/.test(target)
            ? Number(target) - 1
            : jobs.findIndex(job => job.id === target || job.expr === target);
        if (operation !== 'add' && (index < 0 || index >= jobs.length)) return { ok: false, error: '目标 Cron 任务不存在' };
        if (operation === 'add' && jobs.length >= 3) return { ok: false, error: '最多只能有 3 个 Cron 任务' };
        const nextJobs = jobs.map(job => ({ ...job }));
        if (operation === 'add') nextJobs.push({ id: genUid('cron'), expr, enabled: true });
        if (operation === 'update') nextJobs[index].expr = expr;
        if (operation === 'enable') nextJobs[index].enabled = true;
        if (operation === 'disable') nextJobs[index].enabled = false;
        if (operation === 'delete') nextJobs.splice(index, 1);
        const previewId = genUid('preview');
        const previewExpr = operation === 'delete' ? null : (operation === 'add' ? expr : nextJobs[index]?.expr);
        const nextRuns = previewExpr ? nextTradingCronTimes(previewExpr, Date.now(), 5) : [];
        await storageSet(chrome.storage.sync, { cronJobs: nextJobs });
        chrome.runtime.sendMessage({ action: 'syncCronJobs' });
        return {
            ok: true, previewId, operation,
            oldJobs: jobs, newJobs: nextJobs,
            expression: previewExpr,
            description: previewExpr ? `Cron ${previewExpr}，实际刷新限制为 09:15-11:30、13:00-15:00` : '删除该 Cron 任务',
            nextRuns: nextRuns.map(ms => new Date(ms).toLocaleString('zh-CN')),
            applied: true,
            message: 'Cron 配置已更新，后台已重新排程',
        };
    },
    async save_memory(args) {
        return addMemory(String(args.content || '').trim());
    },
    async refresh_all() {
        return new Promise((resolve) => {
            chrome.runtime.sendMessage({ action: 'refreshAll' }, (resp) => {
                if (chrome.runtime.lastError || !resp) {
                    resolve({ ok: false, error: '后台无响应' });
                } else {
                    resolve({ ok: true, refreshedCount: resp.count });
                }
            });
        });
    },
    async list_workspaces() {
        const dirs = [];
        for (let i = 0; i < workspaceHandles.length; i++) {
            const d = workspaceHandles[i];
            dirs.push({ name: d.name, isPrimary: i === 0, permission: await workspacePermission(d.handle) });
        }
        return { workspaces: dirs, hint: 'root 参数用目录名寻址；软链接不可访问，可把软链接指向的真实目录「添加目录」为附加根' };
    },
    async list_dir(args) {
        const dir = await readyRoot(workspaceHandles, args && args.root);
        return listDir(dir.handle, args && args.path || '');
    },
    async read_file(args) {
        const dir = await readyRoot(workspaceHandles, args && args.root);
        const r = await readFile(dir.handle, args.path);
        return {
            root: dir.name,
            path: r.path,
            size: r.size,
            truncated: r.truncated,
            content: r.truncated ? r.content + '\n（已截断，可让 AI 分段读取）' : r.content,
        };
    },
    async read_parquet(args) {
        const dir = await readyRoot(workspaceHandles, args && args.root);
        const relPath = String(args && args.path || '').trim();
        if (!relPath.toLowerCase().endsWith('.parquet')) return { error: 'path 必须指向 .parquet 文件' };
        const limit = Math.min(Math.max(parseInt(args && args.limit, 10) || 100, 1), 500);
        const rowStart = Math.max(parseInt(args && args.row_start, 10) || 0, 0);
        const columns = Array.isArray(args && args.columns) && args.columns.length
            ? args.columns.map(c => String(c)).filter(Boolean) : undefined;
        const binary = await readFileBinary(dir.handle, relPath);
        const metadata = await parquetMetadataAsync(binary.buffer);
        const schema = parquetSchema(metadata);
        const columnNames = (schema.children || []).map(c => c.element.name);
        const selected = columns ? columns.filter(c => columnNames.includes(c)) : undefined;
        if (columns && selected.length !== columns.length) {
            return { error: '指定列不存在', columns: columnNames, missing: columns.filter(c => !columnNames.includes(c)) };
        }
        const rows = await parquetReadObjects({
            file: binary.buffer,
            columns: selected,
            rowStart,
            rowEnd: rowStart + limit,
            compressors,
        });
        return { root: dir.name, path: relPath, size: binary.size, columns: columnNames, totalRows: Number(metadata.num_rows), rowStart, shown: rows.length, rows: toJson(rows) };
    },
    async read_stock_kline(args) {
        const dir = await readyRoot(workspaceHandles, args && args.root);
        const days = Math.min(Math.max(parseInt(args && args.days, 10) || 30, 1), 60);
        // 1) 解析股票代码（支持代码或名称）
        const resolved = await resolveStockCode(args);
        if (resolved.error) return resolved;
        const { code, name } = resolved;
        // 2) 读 parquet 缓存
        const cache = await readStockFromParquet(dir.handle, code, days);
        // 3) 缓存缺最近交易日数据 → 依次用小石 API、东方财富 adata 兜底补齐
        const expected = lastTradingDayStr(new Date());
        const isEtf = isEtfCode(code);
        let source = cache.length ? 'parquet' : 'none';
        let apiRows = [];
        let apiWarning = null;
        const cacheLast = cache.length ? cache[cache.length - 1].date : '';
        if (!cache.length || cacheLast < expected) {
            try {
                apiRows = await xiaoshiDailyKline(code, { limit: days, timeoutMs: 15000 });
                source = cache.length ? 'parquet+xiaoshi' : 'xiaoshi';
            } catch (e) {
                dbg('xiaoshi kline fetch failed', e);
                apiWarning = '小石 API 未补齐（' + (e && e.message || e) + '）';
                // 小石不可用 → 东方财富 adata 兜底（个股/ETF 分别走对应接口）
                try {
                    const adataRows = isEtf
                        ? await adataGetMarketEtfDaily(code.split('.')[0], { startDate: klineStartDate(days) })
                        : await adataGetMarketDaily(code.split('.')[0], { startDate: klineStartDate(days), adjustType: 1 });
                    apiRows = adataToKlineRows(adataRows);
                    source = cache.length ? 'parquet+adata' : 'adata';
                    apiWarning = '小石 API 不可用，已改用东方财富/同花顺数据';
                } catch (e2) {
                    dbg('adata kline fetch failed', e2);
                    apiWarning += '；东方财富 adata 也未补齐（' + (e2 && e2.message || e2) + '）';
                }
            }
        }
        // 4) 合并去重（API 优先），取近 days 天
        const rows = mergeKlineRows(cache, apiRows, days);
        if (!rows.length) {
            return {
                root: dir.name, code, name,
                error: '未读取到该股票数据：parquet 缓存无记录，且小石 / 东方财富接口均拉取失败' + (apiWarning ? '（' + apiWarning + '）' : ''),
            };
        }
        return { root: dir.name, code, name, days, source, cacheLastDate: cacheLast || null, apiLastDate: apiRows.length ? apiRows[apiRows.length - 1].date : null, warning: apiWarning, rows };
    },
    async get_stock_quote(args) {
        // 实时行情（不经页面）：优先实时接口；调用方需传股票名称或代码
        const resolved = await resolveStockCode(args);
        if (resolved.error) return resolved;
        const { code, name } = resolved;
        try {
            const q = await xiaoshiQuote(code, { timeoutMs: 15000 });
            return { code, name, quote: q, warning: q.is_stale ? '行情可能已过期（is_stale=' + q.is_stale + '）' : null };
        } catch (e) {
            return { code, name, error: '小石实时行情拉取失败：' + (e && e.message || e) };
        }
    },
    async get_portfolio_quotes(args) {
        const portfolio = args && args.portfolio ? String(args.portfolio).trim() : '';
        let list;
        if (!portfolio) {
            const { stockList } = await storageGet(chrome.storage.local, 'stockList');
            list = stockList || [];
        } else {
            const { portfolios } = await storageGet(chrome.storage.local, 'portfolios');
            const p = (portfolios || {})[portfolio];
            if (!p) return { error: `组合「${portfolio}」不存在`, available: Object.keys(portfolios || {}) };
            list = p.stockList || [];
        }
        if (!list.length) return { total: 0, quotes: [], hint: '该组合为空' };
        const results = await Promise.allSettled(list.map(s => {
            if (!s.code) return Promise.resolve({ name: s.name || '(待抓取)', error: '尚未获取到代码' });
            const suffix = s.prefix || (s.code.startsWith('6') ? 'SH' : 'SZ');
            const code = s.code + '.' + suffix;
            return xiaoshiQuote(code, { timeoutMs: 10000 }).then(q => ({
                name: s.name || q.name,
                code: s.code, price: q.price, change: q.change, change_pct: q.change_pct,
                open: q.open, high: q.high, low: q.low, previous_close: q.previous_close,
                volume: q.volume, amount: q.amount, turnover_pct: q.turnover_pct,
                is_stale: q.is_stale,
            })).catch(e => ({ name: s.name || s.code, code: s.code, error: e && e.message || '请求失败' }));
        }));
        return { total: list.length, fetched: results.length, quotes: results.map(r => r.status === 'fulfilled' ? r.value : { error: r.reason }) };
    },
    async write_file(args) {
        const dir = await readyRoot(workspaceHandles, args && args.root);
        return writeFile(dir.handle, args.path, args.content);
    },
    async append_file(args) {
        const dir = await readyRoot(workspaceHandles, args && args.root);
        return appendFile(dir.handle, args.path, args.content);
    },
};

// 列表结果精简 + 截断（附 total，模型可知还有更多）
function summarizeList(list, pick, limit = 50) {
    const items = (list || []).slice(0, limit).map(pick);
    return { total: (list || []).length, shown: items.length, items };
}

// ---------------- 股票 K 线（parquet 缓存 + 小石 API）辅助 ----------------

// 解析股票代码：优先用 args.code（支持 001309 / 001309.SZ / 001309.SH）；
// 仅给名称时从扩展持仓列表按名称匹配，匹配不到返回可操作错误
async function resolveStockCode(args) {
    let code = String(args && args.code || '').trim();
    let name = String(args && args.name || '').trim();
    if (!code && !name) return { error: '请提供股票名称或代码（name / code）' };

    if (code) {
        // 兼容 SH:600519 / SZ:000001 冒号前缀（AI 由列表 prefix+code 派生的常见写法，转为带后缀格式）
        const colonMatch = code.match(/^(SH|SZ|BJ|HK|US):(\d{4,6})$/i);
        if (colonMatch) {
            const suffix = colonMatch[1].toUpperCase();
            return { code: colonMatch[2] + '.' + suffix, name };
        }
        const m = code.match(/^(\d{6})([.](SZ|SH|BJ|HK|US))?$/i);
        if (!m) return { error: '代码格式无效，应为 6 位数字或带后缀如 001309.SZ，不要使用 SH:600519 形式' };
        const digits = m[1];
        const suffix = (m[2] || '').toUpperCase();
        if (suffix) return { code: digits + suffix, name };
        // 无后缀时按 6 位 A 股习惯推断：6 开头沪市，其余深市（ETF 同规则）
        const inferred = digits.startsWith('6') ? digits + '.SH' : digits + '.SZ';
        return { code: inferred, name };
    }

    // 按名称从扩展持仓查找（含 trash 的股票也带上）
    const { stockList, portfolios } = await storageGet(chrome.storage.local, ['stockList', 'portfolios']);
    const candidates = [...(stockList || [])];
    for (const p of Object.values(portfolios || {})) candidates.push(...(p.stockList || []));
    const hit = findStockByName(candidates, name);
    if (hit && hit.code) {
        const suffix = hit.prefix || (hit.code.startsWith('6') ? 'SH' : 'SZ');
        return { code: hit.code + '.' + suffix, name };
    }
    // 持仓中未找到 → 用小石搜索接口解析名称→代码（服务器不稳定时返回可重试错误）
    try {
        const items = await xiaoshiSearchStock(name, { timeoutMs: 15000 });
        const best = items.find(i => i.name === name) || items[0];
        if (best && best.symbol) return { code: best.symbol, name };
        return { error: `未能在小石搜索到「${name}」的股票代码，请核对名称后重试` };
    } catch (e) {
        return { error: `小石搜索接口不可用，无法解析「${name}」的代码：${e && e.message || e}。可改传 6 位代码（如 001309）` };
    }
}

// 读取 parquet 缓存中某只股票近 days 天数据；缓存路径 data/a_share_daily/qfq/data_{year}.parquet。
// 数据按年度拆分，跨年需读多个文件：从当年往前逐次尝试 data_{year}.parquet，
// 直到累计行数超过需要的天数或读完可用的年份为止
async function readStockFromParquet(rootHandle, code, days) {
    const qfqPath = 'data/a_share_daily/qfq';
    const entries = await listDir(rootHandle, qfqPath).catch(() => []);
    const years = entries
        .filter(e => e.type === 'file' && /^data_(\d{4})\.parquet$/.test(e.name))
        .map(e => e.name.match(/^data_(\d{4})\.parquet$/)[1])
        .sort();
    if (!years.length) return [];
    const thisYear = new Date().getFullYear();
    const needRows = days + 5; // 余量：抓取周期比 1 天短、节假日等场景
    const rows = [];
    // 从最近年份向前读（当年优先，最多回溯到缓存最早年份）
    for (const y of years.slice().reverse()) {
        if (Number(y) > thisYear) continue;
        const r = await readParquetStockYear(rootHandle, qfqPath, code, y).catch(err => { dbg('parquet year failed', y, err); return []; });
        rows.push(...r);
        if (rows.length >= needRows) break;
    }
    return rows.sort((a, b) => a.date < b.date ? -1 : 1).slice(-days);
}

// 读取单个年度 parquet 中某股票的全部行（按 code 精确过滤）
async function readParquetStockYear(rootHandle, qfqPath, code, year) {
    const relPath = qfqPath + '/data_' + year + '.parquet';
    const binary = await readFileBinary(rootHandle, relPath);
    const found = await parquetReadObjects({
        file: binary.buffer,
        columns: ['code', 'date', 'open', 'high', 'low', 'close', 'volume', 'amount', 'change_pct', 'turnover_pct'],
        filter: { code },
        compressors,
    });
    return found.map(r => ({
        date: fmtKlineDate(r.date),
        open: r.open ?? null,
        high: r.high ?? null,
        low: r.low ?? null,
        close: r.close ?? null,
        volume: r.volume ?? null,
        amount: r.amount ?? null,
        change_pct: r.change_pct ?? null,
        turnover_pct: r.turnover_pct ?? null,
    }));
}

// parquet 里 date 是 Date/ISO 字符串，统一为 YYYY-MM-DD
function fmtKlineDate(d) {
    if (!d) return '';
    if (d instanceof Date) {
        return d.toISOString().slice(0, 10);
    }
    const s = String(d);
    return s.slice(0, 10);
}

// 合并缓存与 API 行：按日期去重（API 优先），升序取最后 days 条
function mergeKlineRows(cache, api, days) {
    const map = new Map();
    for (const r of api) map.set(r.date, r); // API 后写入覆盖同日期缓存
    for (const r of cache) if (!map.has(r.date)) map.set(r.date, r);
    return [...map.values()].sort((a, b) => a.date < b.date ? -1 : 1).slice(-days);
}

// 判断是否为 ETF：6 位数字且以 159/51/58 开头（与扩展监控逻辑同规则，见 shared/utils.js etfPrefixForCode）
function isEtfCode(code) {
    const m = String(code || '').match(/^\d{6}/);
    if (!m) return false;
    const c = m[0];
    return c.startsWith('159') || c.startsWith('51') || c.startsWith('58');
}

// 最近一个交易日（简化：跳过周末；节假日以缓存/API 实际日期为准，多余补齐无副作用）
function lastTradingDayStr(date) {
    const d = new Date(date);
    d.setHours(12, 0, 0, 0);
    const dow = d.getDay();
    if (dow === 0) d.setDate(d.getDate() - 2);
    else if (dow === 6) d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
}

// adata（东方财富）日线接口需要的开始日期：预留余量（含周末/节假日）
function klineStartDate(days) {
    const d = new Date();
    d.setDate(d.getDate() - days * 2 - 5);
    return d.toISOString().slice(0, 10);
}

// 把 adata 返回的 K 线行统一为内部格式（date/open/high/low/close/volume/amount/change_pct/turnover_pct）
function adataToKlineRows(rows) {
    return (rows || []).map(r => ({
        date: String(r.trade_date || r.date || '').slice(0, 10),
        open: r.open ?? null,
        high: r.high ?? null,
        low: r.low ?? null,
        close: r.close ?? null,
        volume: r.volume ?? null,
        amount: r.amount ?? null,
        change_pct: r.change_pct ?? null,
        turnover_pct: r.turnover_ratio ?? r.turnover_pct ?? null,
    }));
}

// ---------------- 要点 / 事件工具辅助 ----------------
// 要点功能开关：全局设置「启用要点管理功能」关闭（hideKeyPoints=true）时，
// 要点/事件工具全部拒绝执行，提示用户先开启
async function requireKeyPoints() {
    const { hideKeyPoints } = await storageGet(chrome.storage.sync, 'hideKeyPoints');
    if (hideKeyPoints) {
        return { error: '要点管理功能未开启。请先在插件全局设置中开启「启用要点管理功能」，再执行本操作', disabled: true };
    }
    return null;
}

// 今天日期 YYYY-MM-DD
function todayStr() {
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

// 对超期未归档事件执行自动归档并生成提醒文案。会就地修改传入的 events：
// - 超 7 天且状态为准确/误判 → 自动置为 archived
// - 超 7 天仍为待预测 → 提醒用户确认验证结果并修改状态
// 返回 { remind（提醒文案，无则 null）, archivedCount（本次自动归档条数） }
function autoArchiveEvents(events) {
    const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
    const archivedNow = [];
    const pendingStale = [];
    for (const e of events || []) {
        if (e.archived) continue;
        if (!e.time || new Date(e.time).getTime() >= weekAgo) continue;
        if (e.status === 'accurate' || e.status === 'wrong') {
            e.archived = true;
            archivedNow.push(e);
        } else if (e.status === 'pending') {
            pendingStale.push(e);
        }
    }
    const parts = [];
    if (archivedNow.length) {
        parts.push('以下事件已超 7 天且状态为准确/误判，已自动归档：' +
            archivedNow.map(e => `「${e.content}」（${e.time}，${eventStatusLabel(e.status)}）`).join('；'));
    }
    if (pendingStale.length) {
        parts.push('以下事件已超过一周仍未归档且状态为待预测，请提醒用户确认验证结果并修改状态：' +
            pendingStale.map(e => `「${e.content}」（${e.time}）`).join('；'));
    }
    return { remind: parts.length ? parts.join('。') : null, archivedCount: archivedNow.length };
}

function eventStatusLabel(s) {
    return { pending: '待预测', accurate: '准确', wrong: '误判' }[s] || s;
}

// 按名称/代码构造可监控的搜索地址：ETF（159/51/58）问财不支持走雪球个股页，其余问财搜索
function stockSearchUrl(item) {
    if (/^(159|51|58)\d{3}$/.test(item)) {
        const p = item.startsWith('159') ? 'SZ' : 'SH';
        return `https://xueqiu.com/S/${p}${item}`;
    }
    return `https://www.iwencai.com/screener/result?w=${encodeURIComponent(item)}&querytype=stock`;
}

// 按名称匹配股票（忽略首尾空格，兼容抓取回填名称带尾随空格）
function findStockByName(list, name) {
    const n = String(name || '').trim();
    return (list || []).find(s => String(s.name || '').trim() === n) || null;
}

// ---------------- 长期记忆 ----------------
async function loadMemory() {
    const res = await storageGet(chrome.storage.local, MEMORY_KEY);
    memoryItems = (res[MEMORY_KEY] && Array.isArray(res[MEMORY_KEY].items)) ? res[MEMORY_KEY].items : [];
}

async function saveMemoryItems() {
    await storageSet(chrome.storage.local, { [MEMORY_KEY]: { items: memoryItems, updatedAt: Date.now() } });
}

// 追加记忆：裁剪到上限；主目录已授权时镜像 workspace/memory.md（镜像失败静默，不中断对话）
async function addMemory(content) {
    if (!content) return { ok: false, error: '记忆内容不能为空' };
    memoryItems.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), content: content.slice(0, 1000), ts: Date.now() });
    if (memoryItems.length > MAX_MEMORY_ITEMS) memoryItems = memoryItems.slice(-MAX_MEMORY_ITEMS);
    await saveMemoryItems();
    let mirrored = false;
    try {
        const dir = await readyRoot(workspaceHandles, ''); // 仅主目录
        const md = memoryItems.map(m => '- ' + m.content).join('\n');
        await writeFile(dir.handle, 'memory.md', md);
        mirrored = true;
    } catch { /* 未授权或写失败：静默 */ }
    return { ok: true, mirrored };
}

// 系统提示词：每轮组装，记忆新写入后下一轮立即生效
function buildSystemPrompt() {
    const lines = [
        '你是「同花顺问财」Chrome 扩展 AI 助手，使用中文。工具按组冷加载：需要能力时先调用 load_tool_group。全局设置只能修改 Cron，直接执行并说明修改结果；手动刷新不受 Cron 交易时间限制。',
        '[工具组]\n' + TOOL_CATALOG,
    ];
    if (memoryItems.length > 0) {
        lines.push('', '[长期记忆]：');
        for (const m of memoryItems) lines.push('- ' + m.content);
    }
    lines.push('', '[当前时间]：' + getDateTime());
    return { role: 'system', content: lines.join('\n') };
}

// ---------------- 会话管理（多会话） ----------------
async function loadSessions() {
    const res = await storageGet(chrome.storage.local, CHAT_KEY);
    sessions = res[CHAT_KEY] || {};
}

// 排序后的会话 id 列表（最近更新在前）
function sortedSessionIds() {
    return Object.keys(sessions).sort((a, b) => (sessions[b].updatedAt || 0) - (sessions[a].updatedAt || 0));
}

function renderSessionSelect() {
    sessionSelect.innerHTML = '';
    for (const id of sortedSessionIds()) {
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = sessions[id].title || '未命名会话';
        sessionSelect.appendChild(opt);
    }
    sessionSelect.value = currentChatId;
}

// 初始化会话：有历史则恢复最近会话，否则新建一个空会话
async function ensureChat() {
    if (currentChatId) return;
    await loadSessions();
    const ids = sortedSessionIds();
    if (ids.length > 0) {
        currentChatId = ids[0];
    } else {
        currentChatId = newChatId();
        sessions[currentChatId] = { id: currentChatId, title: '新会话', messages: [], createdAt: Date.now(), updatedAt: Date.now() };
        await persistSessions();
    }
    chatMessages = sessions[currentChatId].messages || [];
}

function newChatId() {
    return 'chat_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
}

function trimChat() {
    if (chatMessages.length > MAX_MESSAGES) chatMessages = chatMessages.slice(-MAX_MESSAGES);
    for (const m of chatMessages) {
        if (typeof m.content === 'string' && m.content.length > MAX_MESSAGE_CHARS) {
            m.content = m.content.slice(0, MAX_MESSAGE_CHARS);
        }
    }
}

function persistSessions() {
    return storageSet(chrome.storage.local, { [CHAT_KEY]: sessions });
}

// 自动会话标题只取可读文本，不能直接将多模态 content 数组转字符串，避免显示 [object Object]。
function autoSessionTitle() {
    const userMessages = chatMessages.filter(message => message.role === 'user');
    // 图片首轮延后命名后，优先采用之后发送的普通文本消息。
    const plainTextMessage = userMessages.find(message => typeof message.content === 'string' && message.content.trim());
    const source = plainTextMessage || userMessages[0];
    if (!source) return '新会话';
    if (typeof source.content === 'string') return source.content.trim().slice(0, 20) || '新会话';
    if (Array.isArray(source.content)) {
        const text = source.content
            .filter(part => part && part.type === 'text' && typeof part.text === 'string')
            .map(part => part.text.trim())
            .filter(Boolean)
            .join(' ');
        return text.slice(0, 20) || '新会话';
    }
    return '新会话';
}

// 保存当前会话：标题自动填充（首条用户消息前 20 字；手动改名后不再覆盖）。
// 首条图片需临时切换视觉模型时延后命名，避免以图片占位文本作为会话名称。
function saveChat() {
    if (!currentChatId || !sessions[currentChatId]) return Promise.resolve();
    const session = sessions[currentChatId];
    session.messages = chatMessages;
    session.updatedAt = Date.now();
    if ((!session.title || session.title === '新会话') && !session.deferAutoTitle) {
        session.title = autoSessionTitle();
    }
    return persistSessions().then(renderSessionSelect);
}

function deferAutoTitleForVisionInput(content) {
    if (!currentChatId || !sessions[currentChatId]) return;
    const provider = selectRequestProvider([{ role: 'user', content }]);
    if (provider.id !== activeProvider().id) sessions[currentChatId].deferAutoTitle = true;
    else if (!latestUserMessageHasVisionInput([{ role: 'user', content }])) sessions[currentChatId].deferAutoTitle = false;
}

// 切换到指定会话
async function switchSession(id) {
    if (!sessions[id] || id === currentChatId) return;
    await saveChat(); // 落当前会话（含 renderSessionSelect）
    currentChatId = id;
    chatMessages = sessions[id].messages || [];
    pendingImages = [];
    renderPastePreviews();
    renderHistory();
    renderSessionSelect();
    chatInput.focus();
}

// 新建会话：直接命名「新会话」，不弹窗（有首条消息后 saveChat 会自动以前 20 字作标题）
async function createSession() {
    const id = newChatId();
    sessions[id] = { id, title: '新会话', messages: [], createdAt: Date.now(), updatedAt: Date.now() };
    await persistSessions();
    await switchSession(id);
}

// 重命名当前会话
async function renameSession() {
    const session = sessions[currentChatId];
    if (!session) return;
    const name = prompt('会话名称：', session.title || '');
    if (name === null || !name.trim()) return;
    session.title = name.trim().slice(0, 30);
    await persistSessions();
    renderSessionSelect();
}

// 删除当前会话（至少保留一个：删空后新建）
async function deleteSession() {
    const session = sessions[currentChatId];
    if (!session) return;
    if (!confirm(`删除会话「${session.title || '未命名会话'}」？消息内容将一并删除`)) return;
    delete sessions[currentChatId];
    currentChatId = null;
    const ids = sortedSessionIds();
    if (ids.length === 0) {
        const id = newChatId();
        sessions[id] = { id, title: '新会话', messages: [], createdAt: Date.now(), updatedAt: Date.now() };
    }
    await persistSessions();
    currentChatId = sortedSessionIds()[0];
    chatMessages = sessions[currentChatId].messages || [];
    renderHistory();
    renderSessionSelect();
}

// 清空当前会话消息（长期记忆不受影响）
async function clearSession() {
    if (!confirm('清空当前会话的全部消息？长期记忆不受影响')) return;
    chatMessages = [];
    messagesEl.innerHTML = '';
    pendingImages = [];
    renderPastePreviews();
    followStream = true;
    scrollDownBtn.hidden = true;
    updateIntentBubbles(); // 会话已清空，重新显示快捷意图气泡
    await saveChat();
}

// ---------------- 接口配置（多份，手动切换） ----------------
function defaultProvider(name) {
    return {
        id: 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
        name: name || '默认', baseUrl: DEFAULT_AI_BASE_URL, apiKey: '', model: DEFAULT_AI_MODEL,
        supportsVision: false,
    };
}

// 兼容旧配置，并为视觉能力字段补齐安全默认值。
function normalizeProvider(provider) {
    return { ...provider, supportsVision: provider.supportsVision === true };
}

// 工具调用轮数上限：clamp 到 1-50，非法回退默认值
function clampToolIterations(v) {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n) || n < 1 || n > 50) return DEFAULT_MAX_TOOL_ITERATIONS;
    return n;
}

// 读取配置：兼容旧版单配置键（aiBaseUrl/aiApiKey/aiModel）迁移
async function loadProviders() {
    const res = await storageGet(chrome.storage.sync, ['aiProviders', 'aiActiveProviderId', 'aiDefaultVisionProviderId', 'aiBaseUrl', 'aiApiKey', 'aiModel', 'aiMaxToolIterations']);
    maxToolIterations = clampToolIterations(res.aiMaxToolIterations);
    defaultVisionProviderId = typeof res.aiDefaultVisionProviderId === 'string' ? res.aiDefaultVisionProviderId : '';
    if (Array.isArray(res.aiProviders) && res.aiProviders.length > 0) {
        providers = res.aiProviders.map(normalizeProvider);
        activeProviderId = providers.some(p => p.id === res.aiActiveProviderId) ? res.aiActiveProviderId : providers[0].id;
    } else if (res.aiBaseUrl || res.aiApiKey || res.aiModel) {
        // 旧版单配置迁移为第一份配置
        providers = [normalizeProvider({ id: 'p_default', name: '默认', baseUrl: res.aiBaseUrl || DEFAULT_AI_BASE_URL, apiKey: res.aiApiKey || '', model: res.aiModel || DEFAULT_AI_MODEL })];
        activeProviderId = 'p_default';
        await storageSet(chrome.storage.sync, { aiProviders: providers, aiActiveProviderId: activeProviderId });
    } else {
        providers = [defaultProvider('默认')];
        activeProviderId = providers[0].id;
        await storageSet(chrome.storage.sync, { aiProviders: providers, aiActiveProviderId: activeProviderId });
    }
}

// 当前生效配置（请求随带）
function activeProvider() {
    return providers.find(p => p.id === activeProviderId) || providers[0] || defaultProvider();
}

async function persistProviders() {
    await storageSet(chrome.storage.sync, {
        aiProviders: providers,
        aiActiveProviderId: activeProviderId,
        aiDefaultVisionProviderId: defaultVisionProviderId,
    });
}

function renderProviderSelect() {
    aiProviderSelect.innerHTML = '';
    for (const p of providers) {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.name || '未命名';
        aiProviderSelect.appendChild(opt);
    }
    aiProviderSelect.value = activeProviderId;
}

function renderDefaultVisionProviderSelect() {
    aiDefaultVisionProviderSelect.innerHTML = '';
    const none = document.createElement('option');
    none.value = '';
    none.textContent = '自动选择第一份支持视觉的配置';
    aiDefaultVisionProviderSelect.appendChild(none);
    for (const provider of providers) {
        if (!provider.supportsVision) continue;
        const opt = document.createElement('option');
        opt.value = provider.id;
        opt.textContent = `${provider.name || '未命名'}（${provider.model || '未配置模型'}）`;
        aiDefaultVisionProviderSelect.appendChild(opt);
    }
    if (!providers.some(provider => provider.id === defaultVisionProviderId && provider.supportsVision)) {
        if (defaultVisionProviderId !== '') {
            // 校验失败：缓存值失效，同步清空并写回，避免内存与 storage 错位后被后续 persist 以空值覆盖
            defaultVisionProviderId = '';
            persistProviders().catch(() => { /* 同步失败静默 */ });
        }
    }
    aiDefaultVisionProviderSelect.value = defaultVisionProviderId;
}

function fillProviderInputs() {
    const p = activeProvider();
    if (!p) return;
    aiProviderNameInput.value = p.name || '';
    aiBaseUrlInput.value = p.baseUrl || '';
    aiApiKeyInput.value = p.apiKey || '';
    aiModelInput.value = p.model || '';
    aiSupportsVisionInput.checked = p.supportsVision === true;
}

// 设置弹窗：切换配置（下拉）= 切换激活；字段修改 = 更新当前配置
function openSettings() {
    renderProviderSelect();
    fillProviderInputs();
    renderDefaultVisionProviderSelect();
    aiMaxToolIterationsInput.value = maxToolIterations;
    aiSettingsOverlay.style.display = 'flex';
}

function closeSettings() {
    aiSettingsOverlay.style.display = 'none';
}

function bindProviderEvents() {
    // 下拉切换：切换激活配置并回填
    aiProviderSelect.addEventListener('change', async () => {
        // 先同步回填界面。若等待 storage 写入，onChanged 的异步回调可能抢先按旧配置重绘。
        activeProviderId = aiProviderSelect.value;
        fillProviderInputs();
        await persistProviders();
    });
    // 新增配置
    aiProviderAddBtn.addEventListener('click', async () => {
        const name = prompt('新配置名称（如 DeepSeek / OpenAI / 本地）：', '配置' + (providers.length + 1));
        if (name === null) return;
        const p = defaultProvider(name.trim() || '配置' + (providers.length + 1));
        providers.push(p);
        activeProviderId = p.id;
        await persistProviders();
        renderProviderSelect();
        fillProviderInputs();
    });
    // 删除当前配置（至少保留一份）
    aiProviderDelBtn.addEventListener('click', async () => {
        if (providers.length <= 1) { alert('至少保留一份接口配置'); return; }
        const p = activeProvider();
        if (!confirm(`删除配置「${p.name}」？`)) return;
        providers = providers.filter(x => x.id !== p.id);
        if (activeProviderId === p.id) activeProviderId = providers[0].id;
        await persistProviders();
        renderProviderSelect();
        fillProviderInputs();
    });
    // 字段修改：更新当前配置
    const bindInput = (input, key) => input.addEventListener('change', async () => {
        const p = activeProvider();
        if (!p) return;
        p[key] = input.value.trim();
        await persistProviders();
        if (key === 'name') renderProviderSelect();
    });
    bindInput(aiProviderNameInput, 'name');
    bindInput(aiBaseUrlInput, 'baseUrl');
    bindInput(aiApiKeyInput, 'apiKey');
    bindInput(aiModelInput, 'model');
    aiSupportsVisionInput.addEventListener('change', async () => {
        const p = activeProvider();
        if (!p) return;
        p.supportsVision = aiSupportsVisionInput.checked;
        await persistProviders();
        renderDefaultVisionProviderSelect();
    });
    // 工具调用轮数上限：即改即存
    aiMaxToolIterationsInput.addEventListener('change', () => {
        const v = clampToolIterations(aiMaxToolIterationsInput.value);
        aiMaxToolIterationsInput.value = v;
        maxToolIterations = v;
        chrome.storage.sync.set({ aiMaxToolIterations: v });
    });
    aiDefaultVisionProviderSelect.addEventListener('change', async () => {
        defaultVisionProviderId = aiDefaultVisionProviderSelect.value;
        await persistProviders();
    });
}

// ---------------- port 连接 ----------------
// 与 popup 同款重连模式：SW 回收/重启断开后自动重连
function connectPort() {
    try {
        port = chrome.runtime.connect({ name: 'ai-chat-connection' });
    } catch {
        return; // 扩展上下文失效（重载扩展）时停止重连
    }
    port.onMessage.addListener(handlePortMessage);
    port.onDisconnect.addListener(() => setTimeout(connectPort, 500));
}

const pending = new Map(); // requestId -> { timeoutId, onChunk, resolve }

function handlePortMessage(message) {
    const p = pending.get(message.requestId);
    if (!p) return;
    if (message.type === 'AI_CHAT_CHUNK') {
        p.onChunk(message.delta);
    } else if (message.type === 'AI_CHAT_DONE') {
        pending.delete(message.requestId);
        clearTimeout(p.timeoutId);
        p.resolve({ ok: true, finish_reason: message.finish_reason, tool_calls: message.tool_calls || [] });
    } else if (message.type === 'AI_CHAT_ERROR') {
        pending.delete(message.requestId);
        clearTimeout(p.timeoutId);
        p.resolve({ ok: false, error: message.message, retriable: !!message.retriable });
    } else if (message.type === 'AI_CHAT_ABORTED') {
        pending.delete(message.requestId);
        clearTimeout(p.timeoutId);
        p.resolve({ ok: false, aborted: true });
    }
}

// 单轮流式往返：调用方指定的配置随请求携带（SW 无状态）。
function sendRound(apiMessages, tools, { stream = true, provider = activeProvider() } = {}) {
    return new Promise((resolve) => {
        const requestId = ++currentRequestId;
        let content = '';
        const timeoutId = setTimeout(() => {
            // 页面侧兜底超时：SW 无声死亡时也能恢复 UI
            pending.delete(requestId);
            resolve({ ok: false, error: '请求超时（120s），请重试', retriable: true, content });
        }, REQUEST_TIMEOUT_MS);
        pending.set(requestId, {
            timeoutId,
            onChunk: (delta) => { content += delta; appendToCurrentAssistant(delta); },
            resolve: (r) => resolve({ ...r, content }),
        });
        try {
            port.postMessage({
                action: 'aiChatStream',
                requestId,
                messages: apiMessages,
                tools,
                stream,
                baseUrl: provider.baseUrl,
                apiKey: provider.apiKey,
                model: provider.model,
            });
        } catch {
            pending.delete(requestId);
            clearTimeout(timeoutId);
            resolve({ ok: false, error: '与后台连接已断开，请稍后重试', retriable: true, content: '' });
        }
    });
}

// 检查指定消息是否含 OpenAI 兼容格式的图片块。
function messageHasVisionInput(message) {
    return Array.isArray(message && message.content)
        && message.content.some(part => part && part.type === 'image_url');
}

// 仅检查本次新发送的最后一条用户消息是否含 OpenAI 兼容格式的图片块。
function latestUserMessageHasVisionInput(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        if (message.role !== 'user') continue;
        return messageHasVisionInput(message);
    }
    return false;
}

// 会话历史含图片时必须持续使用视觉模型，否则 OpenAI 兼容接口会拒绝 image_url。
// 全局默认视觉模型优先，未指定时取第一份支持视觉的配置。
function selectRequestProvider(messages) {
    const current = activeProvider();
    const hasAnyVisionInput = messages.some(messageHasVisionInput);
    if (!hasAnyVisionInput || current.supportsVision) return current;
    return providers.find(p => p.id === defaultVisionProviderId && p.supportsVision)
        || providers.find(p => p.supportsVision)
        || current;
}

// ---------------- function-calling 循环 ----------------
// initialMessages：可选，指定起始 apiMessages（重试用快照）；默认从会话历史构建
async function runAgentLoop(initialMessages, initialToolGroups = []) {
    const apiMessages = initialMessages || chatMessages.map(m => ({ role: m.role, content: m.content }));
    activeToolGroups = new Set(initialToolGroups);
    const requestProvider = selectRequestProvider(apiMessages);
    const switchedForVision = requestProvider.id !== activeProvider().id;
    if (switchedForVision) appendMessage('system', `检测到图片，已临时切换到视觉模型「${requestProvider.name || requestProvider.model}」处理本次请求`);
    for (let round = 0; round < maxToolIterations; round++) {
        currentAssistantEl = null; // 每轮新建气泡（工具往返后流式内容不能追加到上一轮气泡）
        const requestMessages = [buildSystemPrompt(), ...apiMessages];
        const tools = [TOOL_GROUP_DEF, ...getLoadedToolDefs()];
        let result = await sendRound(requestMessages, tools, { stream: true, provider: requestProvider });
        if (!result.ok) {
            if (result.aborted) {
                // 用户主动停止：保留已生成的部分文本
                appendMessage('system', '已停止');
                commitAssistant(result.content);
                return;
            }
            if (result.retriable) {
                // 流式失败自动降级一次非流式
                appendMessage('system', '流式响应中断，改用非流式重试…');
                result = await sendRound(requestMessages, tools, { stream: false, provider: requestProvider });
            }
            if (!result.ok) {
                const errorEl = appendMessage('error', result.error || '请求失败');
                lastRequestSnapshot = { messages: requestMessages, toolGroups: [...activeToolGroups] };
                const actionWrap = appendActionButton('重试', retryLast);
                const failEntry = commitAssistant(result.content);
                // 记录失败渲染元素与已提交的半截回复，重试时自动清理
                lastFailUi = { errorEl, actionWrap, failEntry };
                return;
            }
        }
        if (result.tool_calls && result.tool_calls.length > 0) {
            // 工具往返：assistant(tool_calls) + tool 结果按序追加，进入下一轮
            apiMessages.push({
                role: 'assistant',
                content: result.content || '',
                tool_calls: result.tool_calls.map(tc => ({
                    id: tc.id, type: 'function',
                    function: { name: tc.name, arguments: tc.arguments || '{}' },
                })),
            });
            apiMessages.push(...await executeToolCalls(result.tool_calls));
            continue;
        }
        // 无工具调用：最终回复落库（commitAssistant 仅供停止/失败路径使用，此处直接入列）
        chatMessages.push({ role: 'assistant', content: result.content, ts: Date.now(), uid: genUid('m') });
        trimChat();
        saveChat();
        if (result.finish_reason === 'length') {
            appendActionButton('继续生成', continueGeneration);
        }
        return;
    }
    // 超过最大工具轮数：当前内容作为最终回复（避免无限循环）
    appendMessage('system', '工具调用轮数已达上限（' + maxToolIterations + '），已结束本轮');
}

// 把已渲染的部分内容写入会话历史（停止/失败路径）；返回条目供重试清理定位
function commitAssistant(content) {
    if (!content) return null;
    const entry = { role: 'assistant', content, ts: Date.now(), uid: genUid('m') };
    chatMessages.push(entry);
    trimChat();
    saveChat();
    return entry;
}

// 执行一批工具调用（页面本地），返回 OpenAI 规范的 tool 消息数组；渲染折叠条目
async function executeToolCalls(toolCalls) {
    const toolMessages = [];
    for (const call of toolCalls) {
        let args = {};
        try { args = call.arguments ? JSON.parse(call.arguments) : {}; } catch { args = {}; }
        let result;
        const exec = toolExecutors[call.name];
        if (!exec) {
            result = '未知工具 ' + call.name;
        } else {
            try {
                result = await exec(args);
            } catch (err) {
                result = '工具执行失败：' + err.message;
            }
        }
        let resultText = typeof result === 'string' ? result : JSON.stringify(result);
        if (resultText.length > MAX_TOOL_RESULT_CHARS) {
            resultText = resultText.slice(0, MAX_TOOL_RESULT_CHARS) + '\n（已截断）';
        }
        renderToolEntry(call.name, call.arguments || '{}', resultText);
        toolMessages.push({ role: 'tool', tool_call_id: call.id, content: resultText });
    }
    return toolMessages;
}

// ---------------- 渲染 ----------------
// 滚动跟随策略：默认在底部时随生成自动跳底（followStream=true）；用户上滚阅读即停止
// 跟随，不再强制跳底打扰阅读；点「滚动到底部」按钮或滚回底部后恢复跟随。
let followStream = true;

function isNearBottom() {
    return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 60;
}

function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
}

// 按当前跟随状态决定是否滚动（append 类统一走这里，避免生成中强跳）
function maybeScroll() {
    if (followStream) scrollToBottom();
}

function updateScrollBtn() {
    scrollDownBtn.hidden = isNearBottom();
}

messagesEl.addEventListener('scroll', () => {
    const nearBottom = isNearBottom();
    followStream = nearBottom;
    scrollDownBtn.hidden = nearBottom;
});

scrollDownBtn.addEventListener('click', () => {
    scrollToBottom();
    followStream = true;
    scrollDownBtn.hidden = true;
});

// ---------------- Markdown 安全渲染（防 XSS：先 HTML 转义，再解析白名单语法） ----------------
function escapeHtml(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// 链接只允许 http/https/mailto，其余降级为纯文本（防止 javascript: 等伪协议）
function escapeUrl(u) {
    const s = String(u || '').trim().replace(/&amp;/g, '&');
    return /^(https?:|mailto:)/i.test(s) ? s : '#';
}

// 行内语法：行内代码（先占位隔离，避免后续 ** 等被误解析）→ 链接 → 加粗/斜体/删除线
const MD_CODE_MARK = ''; // 行内代码占位符（用控制字符隔离，避免被 * ` 等二次解析）
function inlineMd(escaped) {
    let s = escaped;
    const codes = [];
    s = s.replace(/`([^`\n]+)`/g, (m, c) => { codes.push(c); return MD_CODE_MARK + (codes.length - 1) + MD_CODE_MARK; });
    s = s.replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (m, txt, url) => {
        return '<a href="' + escapeHtml(escapeUrl(url)) + '" target="_blank" rel="noopener">' + txt + '</a>';
    });
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
    s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    s = s.replace(new RegExp(MD_CODE_MARK + '(\\d+)' + MD_CODE_MARK, 'g'), (m, n) => '<code>' + codes[n] + '</code>');
    return s;
}

// 块级 Markdown → HTML（只输出白名单标签：p/h1-h4/ul/ol/li/pre/code/blockquote/table/th/td/hr/a/strong/em/del）
function mdToHtml(text) {
    const lines = String(text ?? '').split(/\r?\n/);
    let html = '';
    let inCode = false;
    let codeBuf = [];
    let codeLang = ''; // 当前代码围栏语言（小写）
    let listType = null; // 'ul' | 'ol'
    const para = [];
    let tableBuf = null; // 连续表格行缓冲（含表头/分隔行/数据行）

    const flushPara = () => {
        if (para.length) {
            html += '<p>' + inlineMd(para.map(escapeHtml).join('<br>')) + '</p>';
            para.length = 0;
        }
    };
    const flushList = () => {
        if (listType) { html += '</' + listType + '>'; listType = null; }
    };
    // 缓冲的行里第二行必须是分隔行（仅含 | - : 空格）才按表格渲染，否则回退为段落
    const flushTable = () => {
        if (!tableBuf || !tableBuf.length) return;
        if (tableBuf.length < 2 || !/^[\s|:-]+$/.test(tableBuf[1].replace(/\s*\|/g, '|')) || !/-/.test(tableBuf[1])) {
            para.push(...tableBuf);
            tableBuf = null;
            flushPara();
            return;
        }
        const cells = row => row.trim().replace(/^\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim());
        const header = cells(tableBuf[0]);
        const body = tableBuf.slice(2).map(cells);
        let t = '<table><thead><tr>';
        t += header.map(h => '<th>' + inlineMd(escapeHtml(h)) + '</th>').join('');
        t += '</tr></thead><tbody>';
        for (const row of body) {
            if (row.length !== header.length) continue; // 列数不齐的行跳过
            t += '<tr>' + row.map(c => '<td>' + inlineMd(escapeHtml(c)) + '</td>').join('') + '</tr>';
        }
        t += '</tbody></table>';
        html += t;
        tableBuf = null;
    };

    for (const line of lines) {
        const fence = line.match(/^```([A-Za-z0-9_-]*)\s*$/);
        if (fence) {
            if (inCode) {
                // 关闭围栏：stockchart 渲染为成交量柱状图，其余按代码块
                if (codeLang === 'stockchart') {
                    html += renderVolumeChart(codeBuf);
                } else {
                    html += '<pre><code>' + codeBuf.join('\n') + '</code></pre>';
                }
                codeBuf = []; inCode = false; codeLang = '';
            } else {
                flushPara(); flushList(); flushTable();
                inCode = true; codeLang = (fence[1] || '').toLowerCase();
            }
            continue;
        }
        if (inCode) { codeBuf.push(escapeHtml(line)); continue; }

        // 表格行：以 | 开头且以 | 结尾 → 进入表格缓冲
        if (/^\s*\|.*\|\s*$/.test(line)) {
            flushPara(); flushList();
            if (!tableBuf) tableBuf = [];
            tableBuf.push(line);
            continue;
        }
        if (tableBuf) { flushTable(); }

        const heading = line.match(/^(#{1,4})\s+(.*)$/);
        if (heading) {
            flushPara(); flushList();
            const lv = heading[1].length;
            html += '<h' + lv + '>' + inlineMd(escapeHtml(heading[2])) + '</h' + lv + '>';
            continue;
        }
        if (/^\s*([-*_])\s*\1\s*\1\s*$/.test(line)) {
            flushPara(); flushList(); html += '<hr>'; continue;
        }
        const quote = line.match(/^>\s?(.*)$/);
        if (quote) {
            flushPara(); flushList();
            html += '<blockquote>' + inlineMd(escapeHtml(quote[1])) + '</blockquote>';
            continue;
        }
        const ul = line.match(/^\s*[-*+]\s+(.*)$/);
        if (ul) {
            flushPara();
            if (listType !== 'ul') { flushList(); html += '<ul>'; listType = 'ul'; }
            html += '<li>' + inlineMd(escapeHtml(ul[1])) + '</li>';
            continue;
        }
        const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
        if (ol) {
            flushPara();
            if (listType !== 'ol') { flushList(); html += '<ol>'; listType = 'ol'; }
            html += '<li>' + inlineMd(escapeHtml(ol[1])) + '</li>';
            continue;
        }
        if (line.trim() === '') {
            flushPara(); flushList();
        } else {
            para.push(line);
        }
    }
    flushPara(); flushList(); flushTable();
    // 未闭合围栏兜底
    if (inCode) {
        if (codeLang === 'stockchart') html += renderVolumeChart(codeBuf);
        else html += '<pre><code>' + codeBuf.join('\n') + '</code></pre>';
    }
    return html || '<p></p>';
}

// 成交量红绿柱状图（A股习惯：红涨绿跌）。输入为 stockchart 围栏内的行，
// 每行 CSV：日期,收盘价,涨跌幅%,成交量(股)。示例：
//   2026-08-06,40.25,-0.05,36750000
// 返回 <div class="stock-chart"> 结构（列数不足或数据为空时返回空字符串）。
function renderVolumeChart(lines) {
    const rows = [];
    for (const raw of lines) {
        const cells = String(raw).split(',').map(s => s.trim()).filter((s, i) => i === 0 || s !== '');
        if (cells.length < 4) continue;
        const date = cells[0];
        const close = parseFloat(cells[1]);
        const pct = parseFloat(cells[2]);
        const vol = parseFloat(cells[3]);
        if (!date || !Number.isFinite(close) || !Number.isFinite(pct) || !Number.isFinite(vol)) continue;
        rows.push({ date, close, pct, vol });
    }
    if (!rows.length) return '';
    const maxVol = Math.max(...rows.map(r => r.vol)) || 1;
    // 高度按成交量比例（最小可见高度，成交量 0 时显示 2px 底线）
    const bars = rows.map(r => {
        const h = Math.max(Math.round(r.vol / maxVol * 100), r.vol > 0 ? 6 : 2);
        const cls = r.pct >= 0 ? 'up' : 'down';
        const volFmt = r.vol >= 1e8 ? (r.vol / 1e8).toFixed(2) + '亿' : (r.vol >= 1e4 ? (r.vol / 1e4).toFixed(0) + '万' : String(r.vol));
        return '<div class="vbar ' + cls + '" style="height:' + h + '%" title="' +
            escapeHtml(r.date + '  收 ' + r.close + '  ' + (r.pct > 0 ? '+' : '') + r.pct + '%  量 ' + volFmt) + '"></div>';
    }).join('');
    const dates = rows.map(r => '<span>' + escapeHtml(r.date.slice(5)) + '</span>').join('');
    return '<div class="stock-chart">' +
        '<div class="vchart-bars">' + bars + '</div>' +
        '<div class="vchart-dates">' + dates + '</div>' +
        '<div class="vchart-legend"><span class="up">■ 上涨</span><span class="down">■ 下跌</span></div>' +
        '</div>';
}

// 消息渲染：Markdown 安全渲染（防 XSS）；content 可为多模态数组
// [{type:'text',text} , {type:'image_url',image_url:{url}}]，图片渲染为缩略图。
// entry 传入会话历史条目时（user/assistant）附带悬停删除按钮，点击从历史与 DOM 移除该条
function appendMessage(role, content, entry) {
    const el = document.createElement('div');
    el.className = 'msg msg-' + role;
    if (Array.isArray(content)) {
        for (const part of content) {
            if (!part) continue;
            if (typeof part === 'string' || part.type === 'text') {
                const span = document.createElement('span');
                span.className = 'msg-md';
                span.innerHTML = mdToHtml((typeof part === 'string' ? part : part.text) || '');
                el.appendChild(span);
            } else if (part.type === 'image_url') {
                const url = part.image_url && part.image_url.url;
                if (url) {
                    const img = document.createElement('img');
                    img.className = 'msg-img';
                    img.src = url; // 仅本地上传生成的 data URL，无外部注入
                    el.appendChild(img);
                }
            }
        }
    } else {
        el.innerHTML = mdToHtml(content ?? '');
    }
    // 可删除消息：user / assistant 且持历史条目
    if (entry && entry.uid && (role === 'user' || role === 'assistant')) {
        el.dataset.uid = entry.uid;
        const del = document.createElement('span');
        del.className = 'msg-del';
        del.textContent = '×';
        del.title = '删除该条消息（从对话历史移除）';
        del.addEventListener('click', () => {
            const before = chatMessages.length;
            chatMessages = chatMessages.filter(m => m.uid !== entry.uid);
            if (chatMessages.length === before) return;
            el.remove();
            saveChat();
        });
        el.appendChild(del);
    }
    messagesEl.appendChild(el);
    maybeScroll();
    return el;
}

let currentAssistantEl = null;
let currentAssistantRaw = ''; // 流式累积的原始文本（每次 delta 到达后整体重渲染 Markdown）

function beginAssistant() {
    currentAssistantEl = appendMessage('assistant', '');
    currentAssistantRaw = '';
}

function appendToCurrentAssistant(delta) {
    if (!currentAssistantEl) beginAssistant();
    currentAssistantRaw += delta;
    currentAssistantEl.innerHTML = mdToHtml(currentAssistantRaw);
    maybeScroll();
}

// 工具调用折叠条目：头部（名称 + 参数摘要）可点击展开 JSON 结果
function renderToolEntry(name, argsJson, resultText) {
    const el = document.createElement('div');
    el.className = 'msg msg-tool';
    const head = document.createElement('div');
    head.className = 'tool-head';
    const caret = document.createElement('span');
    caret.className = 'tool-caret';
    caret.textContent = '▸';
    const label = document.createElement('span');
    label.textContent = '工具调用 ' + name + (argsJson && argsJson !== '{}' ? ' ' + argsJson.slice(0, 80) : '');
    head.append(caret, label);
    const result = document.createElement('div');
    result.className = 'tool-result';
    result.textContent = resultText;
    head.addEventListener('click', () => {
        el.classList.toggle('expanded');
    });
    el.append(head, result);
    messagesEl.appendChild(el);
    maybeScroll();
    return el;
}

// 消息流末尾的操作按钮（重试 / 继续生成）；返回容器（重试清理时需移除整组）
function appendActionButton(label, onClick) {
    const wrap = document.createElement('div');
    wrap.className = 'msg-actions';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ai-btn';
    btn.textContent = label;
    btn.addEventListener('click', onClick);
    wrap.appendChild(btn);
    messagesEl.appendChild(wrap);
    maybeScroll();
    return wrap;
}

function renderHistory() {
    messagesEl.innerHTML = '';
    // 历史消息补 uid（旧数据/加载的会话无 uid，删除定位依赖它）
    chatMessages.forEach(m => { if (!m.uid) m.uid = genUid('m'); });
    for (const m of chatMessages) {
        appendMessage(m.role === 'user' ? 'user' : 'assistant', m.content || '', m);
    }
    // 切换会话后重置跟随状态与悬浮按钮
    followStream = true;
    scrollDownBtn.hidden = true;
    // 新对话（空会话）时显示快捷意图气泡
    updateIntentBubbles();
}

// ---------------- 工作目录状态条（多根目录） ----------------
function textSpan(text) {
    const span = document.createElement('span');
    span.textContent = text;
    return span;
}

function dirActionBtn(label, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    btn.addEventListener('click', async () => {
        btn.disabled = true;
        try { await onClick(); } finally { btn.disabled = false; }
    });
    return btn;
}

// 重新加载目录列表并按权限状态渲染（每个目录独立展示授权按钮）
async function refreshDirStatus() {
    workspaceHandles = await getWorkspaceHandles();
    renderUploadState(); // 目录授权状态变化同步上传按钮可用性
    dirStatusBar.innerHTML = ''; // 元素全部自建，无注入风险
    if (workspaceHandles.length === 0) {
        dirStatusBar.append(textSpan('工作目录未授权 — 授权后可读写本地文件；软链接不可访问，可把真实目录添加为附加根'));
        dirStatusBar.append(dirActionBtn('选择目录', async () => {
            try {
                await pickPrimaryWorkspace();
            } catch (err) {
                if (err && err.name === 'AbortError') return; // 用户取消选择
                dirStatusBar.append(textSpan('选择失败：' + (err.message || err)));
                return;
            }
            await refreshDirStatus();
        }));
        dirStatusBar.append(dirActionBtn('＋添加', async () => {
            try {
                await addWorkspaceDir();
            } catch (err) {
                if (err && err.name === 'AbortError') return;
                dirStatusBar.append(textSpan('添加失败：' + (err.message || err)));
                return;
            }
            await refreshDirStatus();
        }));
        return;
    }
    dirStatusBar.append(textSpan('目录：'));
    // 主目录 + 附加目录逐个渲染
    for (let i = 0; i < workspaceHandles.length; i++) {
        const d = workspaceHandles[i];
        const perm = await workspacePermission(d.handle);
        const chip = document.createElement('span');
        chip.className = 'dir-chip';
        const name = document.createElement('span');
        name.className = 'dir-name';
        name.textContent = (i === 0 ? '主·' : '') + d.name;
        name.title = d.name;
        chip.appendChild(name);
        if (perm === 'prompt') {
            chip.appendChild(dirActionBtn('重新授权', async () => {
                try {
                    await reauthorizeWorkspace(d.handle);
                } catch (err) {
                    console.warn('[thswc:ai] 重新授权失败:', err);
                }
                await refreshDirStatus();
            }));
        }
        if (i > 0) {
            const remove = document.createElement('span');
            remove.className = 'chip-remove';
            remove.textContent = '×';
            remove.title = '移除该附加目录';
            remove.addEventListener('click', async () => {
                try {
                    await removeWorkspaceDir(d.name);
                } catch (err) {
                    alert(err.message);
                }
                await refreshDirStatus();
            });
            chip.appendChild(remove);
        }
        dirStatusBar.append(chip);
    }
    // 全局操作
    dirStatusBar.append(dirActionBtn('更换主目录', async () => {
        try {
            await pickPrimaryWorkspace();
        } catch (err) {
            if (err && err.name === 'AbortError') return;
            console.warn('[thswc:ai] 更换主目录失败:', err);
        }
        await refreshDirStatus();
    }));
    dirStatusBar.append(dirActionBtn('＋添加', async () => {
        try {
            await addWorkspaceDir();
        } catch (err) {
            if (err && err.name === 'AbortError') return;
            console.warn('[thswc:ai] 添加目录失败:', err);
        }
        await refreshDirStatus();
    }));
}

// ---------------- 文件上传（复制到主工作目录/llm_context_files + 加载到上下文） ----------------
const LLM_CONTEXT_FILES_DIR = 'llm_context_files';

// 上传按钮状态：未设置工作目录时置灰并提示
function renderUploadState() {
    const ok = workspaceHandles.length > 0;
    uploadBtn.disabled = !ok;
    uploadBtn.title = ok ? '上传文件到 llm_context_files 并加载到上下文' : '请先设置工作目录后再上传文件';
}

// 目标文件名防重名：已存在则追加 _1/_2…（保留扩展名）。目录不存在时自动创建。
async function uniqueUploadName(rootHandle, name) {
    const uploadDir = await rootHandle.getDirectoryHandle(LLM_CONTEXT_FILES_DIR, { create: true });
    let candidate = name;
    let i = 1;
    for (; ;) {
        try { await uploadDir.getFileHandle(candidate); } catch { return candidate; }
        const dot = name.lastIndexOf('.');
        candidate = (dot > 0 ? name.slice(0, dot) + '_' + i + name.slice(dot) : name + '_' + i);
        i++;
    }
}

// 上传处理：
//   图片（png/jpeg/gif/webp）→ 以多模态 image_url 消息传给模型；
//   其它文件 → 告知模型其位于 llm_context_files，内容由模型经 read_file 工具自行读取。
// 所有上传内容均保存到主工作目录的 llm_context_files 子目录。
async function handleUploadFiles(files) {
    if (!files || files.length === 0) return;
    if (!workspaceHandles.length) { alert('请先设置工作目录：点击窗口顶部「选择目录」授权后即可上传文件'); return; }
    const dir = await readyRoot(workspaceHandles, ''); // 校验主目录权限 granted
    const imageTypes = /^image\/(png|jpe?g|gif|webp)$/i;
    const parts = []; // content 块（多模态数组）
    let imageCount = 0;
    for (const file of files) {
        const name = await uniqueUploadName(dir.handle, file.name);
        const target = LLM_CONTEXT_FILES_DIR + '/' + name;
        await writeUpload(dir.handle, target, file); // 复制到工作目录的上下文文件目录
        if (imageTypes.test(file.type || '')) {
            imageCount++;
            const dataUrl = await readFileAsDataURL(file);
            parts.push({ type: 'text', text: `[用户上传图片：${target}，已保存到工作目录]` });
            parts.push({ type: 'image_url', image_url: { url: dataUrl } });
        } else {
            parts.push({ type: 'text', text: `[用户上传文件：${target}，已保存到工作目录，可用 read_file 工具读取]` });
        }
        dbg('上传文件已写入工作目录:', target, file.size, '字节');
    }
    if (parts.length === 0) return;
    await ensureChat();
    chatMessages.push({ role: 'user', content: parts, ts: Date.now(), uid: genUid('m') });
    trimChat();
    deferAutoTitleForVisionInput(parts);
    saveChat();
    appendMessage('user', parts);
    appendMessage('system',
        files.length + ' 个文件已保存到工作目录/' + LLM_CONTEXT_FILES_DIR
        + (imageCount ? `，其中 ${imageCount} 张图片已作为视觉输入传给模型` : '，文件内容未打印，可让 AI 用 read_file 读取'));
}

// File → base64 data URL（图片多模态消息用）
function readFileAsDataURL(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
    });
}

// ---------------- 剪贴板图片粘贴（预览 → 可删 → 带文本发送） ----------------
// 粘贴图片类型 → 默认文件名扩展名
function extForMime(mime) {
    return { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' }[mime] || '.png';
}

// 渲染待发送图片预览区（每张图带删除按钮）
function renderPastePreviews() {
    pastePreviews.innerHTML = '';
    if (pendingImages.length === 0) {
        pastePreviews.hidden = true;
        return;
    }
    pastePreviews.hidden = false;
    pendingImages.forEach((img, idx) => {
        const wrap = document.createElement('div');
        wrap.className = 'paste-preview';
        const pic = document.createElement('img');
        pic.src = img.dataUrl;
        pic.title = img.name;
        const del = document.createElement('span');
        del.className = 'paste-del';
        del.textContent = '×';
        del.title = '移除该图片';
        del.addEventListener('click', () => {
            pendingImages.splice(idx, 1);
            renderPastePreviews();
        });
        wrap.append(pic, del);
        pastePreviews.appendChild(wrap);
    });
}

// 粘贴事件：剪贴板含图片时读取为预览（阻止默认粘贴，与 GPT 官网行为一致）
function bindPastePreview() {
    chatInput.addEventListener('paste', (event) => {
        const items = event.clipboardData && event.clipboardData.items;
        if (!items) return;
        const images = [];
        for (const item of items) {
            if (item.type && item.type.startsWith('image/')) {
                const file = item.getAsFile();
                if (file) images.push(file);
            }
        }
        if (images.length === 0) return;
        event.preventDefault();
        images.forEach(async (file) => {
            const dataUrl = await readFileAsDataURL(file);
            pendingImages.push({
                dataUrl,
                file,
                name: file.name || ('paste_' + Date.now().toString(36) + extForMime(file.type)),
            });
            renderPastePreviews();
            chatInput.focus();
        });
    });
}

// ---------------- 发送 / 停止 / 重试 ----------------
function setGenerating(v) {
    generating = v;
    sendBtn.disabled = v;
    stopBtn.hidden = !v;
}

// 在用户手势内自动重授权：requestPermission 必须在用户手势（transient activation）中调用，
// 而工具执行发生在 LLM 往返之后、手势早已过期——因此在发送等手势时机前置触发弹框。
// 返回 true 表示本次有目录完成授权
async function reauthorizePendingInGesture() {
    let changed = false;
    for (const d of workspaceHandles) {
        let perm;
        try { perm = await workspacePermission(d.handle); } catch { continue; }
        if (perm !== 'prompt') continue;
        try {
            const result = await d.handle.requestPermission({ mode: 'readwrite' });
            if (result === 'granted') changed = true;
        } catch (err) {
            console.warn('[thswc:ai] 自动重授权失败:', d.name, err);
        }
    }
    if (changed) await refreshDirStatus();
    return changed;
}

// ---------------- 新对话快捷意图气泡 ----------------
// 仅当前会话为空（新对话/已清空）时在输入框上方显示，点击后用输入框文本直接执行对应操作
function updateIntentBubbles() {
    if (!intentBubblesEl) return;
    intentBubblesEl.hidden = chatMessages.length > 0;
}

function intentLabel(intent) {
    return { keypoint: '增加要点', event: '增加事件', stock: '增加股票' }[intent] || intent;
}

// 点击气泡：读取输入框文本 → 解析 → 直接调用工具执行（不经模型，即时反馈）
async function handleIntentBubble(intent) {
    const raw = chatInput.value.trim();
    if (!raw) {
        appendMessage('system', '请先在输入框填写内容，再选择快捷意图（如「我买入了贵州茅台」）');
        chatInput.focus();
        return;
    }
    let result;
    if (intent === 'keypoint') result = await parseAndCreateKeyPoint(raw);
    else if (intent === 'event') result = await parseAndCreateEvent(raw);
    else if (intent === 'stock') result = await parseAndRecordStockTrade(raw);
    // 回填会话：用户消息 + 执行结果
    chatInput.value = '';
    pendingImages = [];
    renderPastePreviews();
    const userMsg = { role: 'user', content: `【${intentLabel(intent)}】${raw}`, ts: Date.now(), uid: genUid('m') };
    chatMessages.push(userMsg);
    appendMessage('user', userMsg.content, userMsg);
    const reply = { role: 'assistant', content: result.text, ts: Date.now(), uid: genUid('m') };
    chatMessages.push(reply);
    appendMessage('assistant', reply.content, reply);
    trimChat();
    saveChat();
    updateIntentBubbles();
}

// 【增加要点】：解析「文本 权重N」/结尾数字作为权重（缺省 5）
async function parseAndCreateKeyPoint(raw) {
    let text = raw.replace(/^增加要点[:：]?\s*/, '').trim();
    let weight = null;
    let m = text.match(/权重\s*[:：]?\s*(\d{1,2})/);
    if (m) {
        weight = parseInt(m[1], 10);
        text = text.replace(/权重\s*[:：]?\s*\d{1,2}/, '').trim();
    } else {
        m = text.match(/(?:^|\s)(\d{1,2})\s*$/);
        if (m) {
            weight = parseInt(m[1], 10);
            text = text.replace(/(?:^|\s)\d{1,2}\s*$/, '').trim();
        }
    }
    if (!text) return { ok: false, text: '未识别到要点内容，请填写如「回调不破位 权重 8」' };
    const res = await toolExecutors.create_key_point({ text, weight: weight ?? 5 });
    if (res && res.error) return { ok: false, text: res.error };
    return { ok: true, text: `已增加要点「${text}」（权重 ${weight ?? 5}）` };
}

// 【增加事件】：解析日期（今天/今日、MM.DD/MM-DD/MM/DD），缺省今天；
// 创建后询问是否关联要点（列出全部要点，输入数字选择）
async function parseAndCreateEvent(raw) {
    let text = raw.replace(/^增加事件[:：]?\s*/, '').trim();
    if (!text) return { ok: false, text: '未识别到事件内容，请填写如「恒瑞医药机会 7.17 待评测」' };
    let time = null;
    if (/今天|今日/.test(text)) {
        time = todayStr();
        text = text.replace(/今天|今日/g, '').trim();
    } else {
        const m = text.match(/(\d{1,2})\s*[./-]\s*(\d{1,2})(?![\d])/);
        if (m) {
            const now = new Date();
            time = `${now.getFullYear()}-${String(parseInt(m[1], 10)).padStart(2, '0')}-${String(parseInt(m[2], 10)).padStart(2, '0')}`;
            text = text.replace(m[0], '').trim();
        }
    }
    if (!time) time = todayStr();
    const res = await toolExecutors.create_event({ content: text, time });
    if (res && res.error) return { ok: false, text: res.error };
    // 创建后询问是否关联要点：列出全部要点，输入数字选择（留空/非法则跳过）
    let linkText = '';
    const { keyPoints } = await storageGet(chrome.storage.local, 'keyPoints');
    if (Array.isArray(keyPoints) && keyPoints.length > 0) {
        const options = keyPoints.map((kp, i) => `${i + 1}. ${kp.text}（权重 ${kp.weight}）`).join('\n');
        const answer = prompt(`已创建事件「${text}」（${time}）\n\n是否关联要点？\n${options}\n\n输入数字选择，或留空跳过：`);
        const n = parseInt(answer, 10);
        if (Number.isFinite(n) && n >= 1 && n <= keyPoints.length) {
            await toolExecutors.update_event({ id: res.event.id, key_point_text: keyPoints[n - 1].text });
            linkText = `，已关联要点「${keyPoints[n - 1].text}」`;
        } else {
            linkText = '，未关联要点';
        }
    } else {
        linkText = '（当前暂无要点，可先创建要点后再编辑关联）';
    }
    let reply = `已增加事件「${text}」（${time}）${linkText}`;
    if (res && res.remind) reply += `；\n${res.remind}`;
    return { ok: true, text: reply };
}

// 【增加股票】：识别「买入/卖出」，买入→加入【持仓】，卖出→从【持仓】移到【观察】
async function parseAndRecordStockTrade(raw) {
    let text = raw.replace(/^增加股票[:：]?\s*/, '').trim();
    if (!text) return { ok: false, text: '未识别到股票操作，请填写如「我买入了贵州茅台」或「我卖出了贵州茅台」' };
    const buyM = text.match(/^(我)?(买入|买进|加仓|建仓|买了|购买)\s*了?\s*/);
    const sellM = text.match(/^(我)?(卖出|卖了|清仓|减仓)\s*了?\s*/);
    let action = 'buy';
    let name = text;
    if (sellM && (!buyM || sellM[0].length >= (buyM[0] || '').length)) {
        action = 'sell';
        name = text.slice(sellM[0].length);
    } else if (buyM) {
        name = text.slice(buyM[0].length);
    }
    name = name.replace(/[。！!？?.,，、；;]+$/g, '').trim();
    if (!name) return { ok: false, text: '未识别到股票名称，请填写如「我买入了贵州茅台」' };
    if (action === 'buy') {
        const res = await toolExecutors.add_stock_to_portfolio({ name, portfolio: '持仓' });
        if (res && res.error) return { ok: false, text: res.error };
        return { ok: true, text: `已将「${name}」加入【持仓】组合${res && res.hint ? '（' + res.hint + '）' : ''}` };
    }
    const res = await toolExecutors.move_stock_to_combo({ name, target_portfolio: '观察', source_portfolio: '持仓' });
    if (res && res.error) return { ok: false, text: res.error };
    if (res && res.removed) return { ok: true, text: `观察组合已有「${name}」，已从【持仓】删除，不再重复添加` };
    if (res && res.already) return { ok: true, text: `「${name}」已在【观察】组合中` };
    return { ok: true, text: `已将「${name}」从【持仓】移动到【观察】组合` };
}

async function handleSend() {
    const text = chatInput.value.trim();
    if (!text && pendingImages.length === 0) return;
    if (generating) return;
    // 用户手势内前置检查：有待授权目录（浏览器重启后常见）则直接弹授权框
    await reauthorizePendingInGesture();
    await ensureChat();
    followStream = true; // 发送后应能看到自己最新的消息
    scrollDownBtn.hidden = true;
    // 组装内容：文本 + 粘贴图片（多模态；图片已授权时保存至 llm_context_files）
    let content = text;
    let imageCount = 0;
    if (pendingImages.length > 0) {
        const parts = [];
        if (text) parts.push({ type: 'text', text });
        for (const img of pendingImages) {
            imageCount++;
            // 已授权工作目录时把粘贴图片也落盘（失败静默，仅视觉发送）
            try {
                if (workspaceHandles.length) {
                    const dir = await readyRoot(workspaceHandles, '');
                    const name = await uniqueUploadName(dir.handle, img.name || 'paste.png');
                    const target = LLM_CONTEXT_FILES_DIR + '/' + name;
                    await writeUpload(dir.handle, target, img.file);
                    parts.push({ type: 'text', text: `[用户粘贴图片：${target}，已保存到工作目录]` });
                }
            } catch (err) {
                console.warn('[thswc:ai] 粘贴图片写入工作目录失败:', err);
            }
            parts.push({ type: 'image_url', image_url: { url: img.dataUrl } });
        }
        content = parts;
    }
    appendMessage('user', content);
    chatMessages.push({ role: 'user', content, ts: Date.now(), uid: genUid('m') });
    trimChat();
    deferAutoTitleForVisionInput(content);
    saveChat();
    chatInput.value = '';
    pendingImages = [];
    renderPastePreviews();
    updateIntentBubbles(); // 会话已非空，隐藏快捷意图气泡
    currentAssistantEl = null;
    setGenerating(true);
    if (imageCount > 0) appendMessage('system', imageCount + ' 张图片已作为视觉输入传给模型');
    try {
        await runAgentLoop();
    } catch (err) {
        console.error('[thswc:ai] 循环异常:', err);
        appendMessage('error', '发生异常：' + err.message);
    } finally {
        setGenerating(false);
        chatInput.focus();
    }
}

function stopGeneration() {
    if (!generating) return;
    // 告知 background 中止在途请求；AI_CHAT_ABORTED 回来后保留已渲染内容
    try {
        port.postMessage({ action: 'aiChatStop', requestId: currentRequestId });
    } catch { /* 连接已断，background 会在断开时自行 abort */ }
}

async function retryLast() {
    if (generating || !lastRequestSnapshot) return;
    // 自动清理上次失败渲染：报错气泡 + 重试按钮 + 已提交的半截回复（避免残留叠加）
    if (lastFailUi) {
        if (lastFailUi.errorEl) lastFailUi.errorEl.remove();
        if (lastFailUi.actionWrap) lastFailUi.actionWrap.remove();
        if (lastFailUi.failEntry) {
            const i = chatMessages.indexOf(lastFailUi.failEntry);
            if (i !== -1) chatMessages.splice(i, 1);
        }
        lastFailUi = null;
        saveChat();
    }
    currentAssistantEl = null;
    setGenerating(true);
    try {
        // 快照含 system 第 0 条，去掉后作为起始 apiMessages 重发；
        // 须原样保留 tool_calls / tool_call_id 等字段，否则工具轮中失败后重试的消息序列非法（会被端点 400 拒绝）
        await runAgentLoop(
            lastRequestSnapshot.messages.slice(1).map(m => ({ ...m })),
            lastRequestSnapshot.toolGroups || [],
        );
    } catch (err) {
        appendMessage('error', '发生异常：' + err.message);
    } finally {
        setGenerating(false);
    }
}

async function continueGeneration() {
    if (generating) return;
    chatMessages.push({ role: 'user', content: '请继续', ts: Date.now(), uid: genUid('m') });
    trimChat();
    saveChat();
    appendMessage('user', '请继续');
    currentAssistantEl = null;
    setGenerating(true);
    try {
        await runAgentLoop();
    } catch (err) {
        appendMessage('error', '发生异常：' + err.message);
    } finally {
        setGenerating(false);
    }
}

// ---------------- 事件绑定 ----------------
function bindEvents() {
    sendBtn.addEventListener('click', handleSend);
    chatInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            handleSend();
        }
    });
    // 快捷意图气泡
    intentBubbleEls.forEach(btn => {
        btn.addEventListener('click', () => handleIntentBubble(btn.dataset.intent));
    });
    stopBtn.addEventListener('click', stopGeneration);
    // 会话管理
    sessionSelect.addEventListener('change', () => switchSession(sessionSelect.value));
    newSessionBtn.addEventListener('click', createSession);
    renameSessionBtn.addEventListener('click', renameSession);
    deleteSessionBtn.addEventListener('click', deleteSession);
    clearChatBtn.addEventListener('click', clearSession);
    // 文件上传
    uploadBtn.addEventListener('click', async () => {
        if (!workspaceHandles.length) {
            alert('请先设置工作目录：点击窗口顶部「选择目录」授权后即可上传文件');
            return;
        }
        await reauthorizePendingInGesture(); // 权限失效时手势内弹授权框
        const perm = await workspacePermission(workspaceHandles[0].handle);
        if (perm !== 'granted') { alert('工作目录权限未授予，无法上传'); return; }
        uploadInput.click();
    });
    uploadInput.addEventListener('change', async (e) => {
        const files = Array.from(e.target.files || []);
        e.target.value = ''; // 允许重复上传同一文件
        if (files.length) await handleUploadFiles(files);
    });
    // 剪贴板图片粘贴预览
    bindPastePreview();
    // 设置
    openAiSettingsBtn.addEventListener('click', openSettings);
    closeAiSettingsBtn.addEventListener('click', closeSettings);
    // 仅点击右上角 × 关闭：点遮罩不关闭（避免误触丢失正在编辑的配置）
    bindProviderEvents();
}

// ---------------- 初始化 ----------------
async function init() {
    connectPort();
    await loadProviders();
    // popup 全局设置改动时实时同步（两窗口同源）
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'sync') return;
        if (changes.aiProviders || changes.aiActiveProviderId || changes.aiDefaultVisionProviderId) {
            loadProviders().then(() => {
                renderProviderSelect();
                fillProviderInputs();
                renderDefaultVisionProviderSelect();
            });
        }
    });
    await loadMemory();
    await ensureChat();
    renderHistory();
    renderSessionSelect();
    await refreshDirStatus();
    bindEvents();
    // 窗口加载后首个用户手势（任意点击，状态条按钮除外）即触发待授权目录的授权弹框；
    // 后续手势由 handleSend 前置检查兜底
    window.addEventListener('click', function autoReauthOnce(e) {
        if (!dirStatusBar.contains(e.target)) reauthorizePendingInGesture();
        window.removeEventListener('click', autoReauthOnce);
    });
    if (!activeProvider().apiKey) {
        appendMessage('system', '尚未配置 API Key：点击右上角「设置」填写后即可对话');
    }
    chatInput.focus();
}

init();
