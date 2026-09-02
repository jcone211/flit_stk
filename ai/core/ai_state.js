// ai_state.js —— 共享状态与基础工具（由其他 ai_*.js 模块引用）

import { getDateTime } from '../../shared/utils.js';
export { getDateTime };

// 诊断日志
export const DEBUG = true;
export const dbg = (...args) => { if (DEBUG) console.log('[thswc:ai]', ...args); };

// 常量
export const DEFAULT_MAX_TOOL_ITERATIONS = 18;
export const MAX_MESSAGES = 100;
export const MAX_MESSAGE_CHARS = 10000;
export const MAX_MEMORY_ITEMS = 50;
// 工具结果上限：全局硬顶 + 按工具分级（摘要类工具不需要 20k）
export const MAX_TOOL_RESULT_CHARS = 20000;
// 单工具返回字符上限（未列入的工具用 DEFAULT_TOOL_RESULT_CHARS）；K 线类只回摘要，不需要给模型看 180 行 OHLCV
export const DEFAULT_TOOL_RESULT_CHARS = 12000;
export const TOOL_RESULT_CHARS = {
    read_stock_kline: 6000,
    read_stocks_kline: 5000,
    read_file: 8000,
    read_parquet: 8000,
    query_local_database: 10000,
    run_workspace_process: 10000,
    get_workspace_context: 8000,
};
// 单轮全部工具结果总预算（超限后后续工具只留存根）
export const MAX_ROUND_TOOL_CHARS = 16000;
// 送入模型的上下文字符预算（超限逐轮驱逐旧 tool 结果，见 ai.js evictToolResults：
// 仅驱逐「最近一轮以外」的旧结果，驱逐到预算内即停）
export const MAX_CONTEXT_CHARS = 24000;
// 跨轮「工具调用记录」：tool 的原始返回只在当轮 function-calling 循环内有效，用户发下一条消息时
// 会被 chatMessages 的 {role,content} 重建抹掉（docs/debug.txt 里模型就是靠这个空档凭空补了 7 根 K 线）。
// 每轮结束只留一行账本（调了哪些工具、成功还是失败、失败原因）；原始数据想跨轮存活只能靠 retain_tool_data 登记便签。
export const TRACE_MESSAGE_ROLE = 'user';    // 隐藏上下文回灌时用的 role：统一用 user（会话中途的 system 个别供应商不接受）
export const MAX_TRACE_CHARS = 900;           // 单轮账本字符上限
export const MAX_TRACE_CALLS = 12;            // 单轮账本最多列出的调用条数
export const MAX_KEEP_TRACES = 2;             // 上下文里保留最近几轮的账本（更早的没有参考价值，还压预算）
// 「跨轮数据便签」：模型自己判断某份工具原始数据关键时调 retain_tool_data 登记，
// 不占用可见正文、不进 UI 气泡，只在下一轮起作为隐藏上下文回灌（不再要求「把数据抄进回复正文」）
export const MAX_RETAIN_CHARS = 3000;         // 单条便签正文上限（超出截断）
export const MAX_RETAINED_ENTRIES = 3;        // 同时保留几条便签（满了丢最旧）
export const MAX_RETAINED_TOTAL = 6000;       // 便签总字数量上限（相对 MAX_CONTEXT_CHARS=24000，给对话本身留位）
export const MAX_TURN_TOOL_RESULTS = 8;       // 本轮可被登记的工具原始返回缓存条数
// 单轮 LLM 请求超时：滑动空闲 + 硬上限双档。
// 思考型模型可能长时间只输出 reasoning_content（无正文 delta），固定总超时会误杀，
// 故每收到一个 delta（正文或思考）就重置空闲计时；空闲满 45s 判无响应，300s 为硬上限兜底。
export const REQUEST_IDLE_TIMEOUT_MS = 45000;
export const REQUEST_MAX_TIMEOUT_MS = 300000;
// SW keepalive：请求在途时定时 ping 后台，port 消息本身即重置 MV3 service worker 的 30s 空闲回收计时
export const KEEPALIVE_INTERVAL_MS = 20000;
// 思考过程面板只渲染尾部字符，长思考不拖慢 DOM（完整文本进 DEBUG 日志）
export const THINKING_TAIL_CHARS = 1200;
export const CHAT_KEY = 'aiChats';
export const MEMORY_KEY = 'aiMemory';
export const DEFAULT_AI_BASE_URL = 'https://api.deepseek.com';
export const DEFAULT_AI_MODEL = 'deepseek-chat';

// 共享可变状态（各模块通过 state.xxx 读写，初始默认值已设）
export const state = {
    port: null,
    sessions: {},
    currentChatId: null,
    chatMessages: [],
    memoryItems: [],
    workspaceHandles: [],
    providers: [],
    activeProviderId: '',
    defaultVisionProviderId: '',
    maxToolIterations: DEFAULT_MAX_TOOL_ITERATIONS,
    bridgeEnabled: false,
    bridgeHandle: null,
    bridgeDirFullPath: '',
    bridgeUrl: 'http://127.0.0.1:17321',
    workspaceRootPath: '',
    generating: false,
    currentRequestId: 0,
    lastRequestSnapshot: null,
    pendingImages: [],
    lastFailUi: null,
    activeToolGroups: new Set(),
    // 本轮（一次用户提问内含若干 function-calling 轮）的工具原始返回缓存，以及待落库的「跨轮数据便签」；
    // 两者都由 ai.js 逐轮重置/排空，retain_tool_data 只读写这两个字段
    turnToolResults: [],
    pendingRetains: [],
    followStream: true,
    currentAssistantEl: null,
    currentAssistantRaw: '',
    currentAssistantEntry: null,
    waitingAssistantEl: null,
    thinkingEl: null,
    thinkingRaw: '',
    thinkingBody: null,
    thinkingLabel: null,
    // port 是否可用（chrome.runtime.connect 成功即 true，onDisconnect 置 false）
    portAlive: false,
};

// DOM 引用（赋值即生效）
export const messagesEl = document.getElementById('messagesEl');
export const scrollDownBtn = document.getElementById('scrollDownBtn');
export const chatInput = document.getElementById('chatInput');
export const sendBtn = document.getElementById('sendBtn');
export const stopBtn = document.getElementById('stopBtn');
export const uploadBtn = document.getElementById('uploadBtn');
export const uploadInput = document.getElementById('uploadInput');
export const pastePreviews = document.getElementById('pastePreviews');
export const intentBubblesEl = document.getElementById('intentBubbles');
export const intentBubbleEls = document.querySelectorAll('.intent-bubble');
export const sessionSelect = document.getElementById('sessionSelect');
export const newSessionBtn = document.getElementById('newSessionBtn');
export const renameSessionBtn = document.getElementById('renameSessionBtn');
export const deleteSessionBtn = document.getElementById('deleteSessionBtn');
export const clearChatBtn = document.getElementById('clearChatBtn');
export const openAiSettingsBtn = document.getElementById('openAiSettingsBtn');
export const dirStatusBar = document.getElementById('dirStatusBar');
export const aiSettingsOverlay = document.getElementById('aiSettingsOverlay');
export const closeAiSettingsBtn = document.getElementById('closeAiSettingsBtn');
export const aiProviderSelect = document.getElementById('aiProviderSelect');
export const aiProviderAddBtn = document.getElementById('aiProviderAddBtn');
export const aiProviderDelBtn = document.getElementById('aiProviderDelBtn');
export const aiProviderNameInput = document.getElementById('aiProviderName');
export const aiBaseUrlInput = document.getElementById('aiBaseUrl');
export const aiApiKeyInput = document.getElementById('aiApiKey');
export const aiModelInput = document.getElementById('aiModel');
export const aiSupportsVisionInput = document.getElementById('aiSupportsVision');
export const aiMaxToolIterationsInput = document.getElementById('aiMaxToolIterations');
export const aiDefaultVisionProviderSelect = document.getElementById('aiDefaultVisionProvider');
export const aiDebugModeInput = document.getElementById('aiDebugMode');
export const aiDisableThinkingInput = document.getElementById('aiDisableThinking');
export const debugInfoBtn = document.getElementById('debugInfoBtn');

// Storage 封装
export const storageGet = (area, keys) => new Promise(resolve => area.get(keys, resolve));
export const storageSet = (area, obj) => new Promise(resolve => area.set(obj, () => { resolve(); }));

// 生成唯一 id
export function genUid(prefix) {
    return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// 单工具结果字符上限（T1-3 分级）
export function toolResultLimitChars(name) {
    return TOOL_RESULT_CHARS[name] || DEFAULT_TOOL_RESULT_CHARS;
}

// 列表结果精简 + 截断
export function summarizeList(list, pick, limit = 50) {
    const items = (list || []).slice(0, limit).map(pick);
    return { total: (list || []).length, shown: items.length, items };
}

// 股票条目精简视图
export function pickStockView(s) {
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
        // currentPrice 是哪一刻的价：epoch 毫秒模型读不出，给一份人可读时间，避免把旧价当现价
        数据时间: fmtDateTimeStr(s.lastUpdateAt),
    };
}

/** 时间戳 → 「YYYY-MM-DD HH:MM:SS」（空/非法返回 null） */
export function fmtDateTimeStr(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n) || n <= 0) return null;
    const d = new Date(n);
    if (Number.isNaN(d.getTime())) return null;
    const p = v => String(v).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
        + ` ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// 按名称匹配股票
export function findStockByName(list, name) {
    const n = String(name || '').trim();
    return (list || []).find(s => String(s.name || '').trim() === n) || null;
}

// 构造搜索地址
export function stockSearchUrl(item) {
    if (/^(159|51|58)\d{3}$/.test(item)) {
        const p = item.startsWith('159') ? 'SZ' : 'SH';
        return `https://xueqiu.com/S/${p}${item}`;
    }
    return `https://www.iwencai.com/screener/result?w=${encodeURIComponent(item)}&querytype=stock`;
}
