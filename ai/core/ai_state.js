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
export const MAX_TOOL_RESULT_CHARS = 20000;
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
    };
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
