/**
 * ai.js —— AI 对话窗口主逻辑入口（ES module，无框架，直接操作 DOM）
 *
 * 职责：port 连接与重连、function-calling 循环、消息渲染、会话管理、
 *       文件上传与剪贴板图片、快捷意图解析、UI 事件绑定。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 文件索引（行号仅供参考，增删代码后会偏移；定位优先搜索段落标记 `// ======` 或函数名）
 * ────────────────────────────────────────────────────────────────────────────
 *
 * 【依赖：均在 ./core/ 下】
 *   ai_state.js    全局 state、storage 封装、常量(MAX_MESSAGES / MAX_TOOL_RESULT_CHARS / CHAT_KEY 等)、DOM 元素引用
 *   ai_tools.js    TOOL_DEFS / TOOL_GROUPS / TOOL_GROUP_DEF / TOOL_GROUP_RULES / TOOL_CATALOG
 *                  toolExecutors / getLoadedToolDefs / buildSystemPrompt / loadMemory / todayStr
 *   ai_settings.js 供应商、工作目录、Bridge 设置的加载与面板渲染，bindProviderEvents 等 bind*Events
 *   ai_debug.js    DEBUG 模式（存储键 aiDebugMode/aiDebugLogs）：会话全过程记录与「Debug信息」按钮一键复制
 *                  记录点：appendMessage(user/assistant/system/error)、commitAssistant、executeToolCalls、
 *                  sendRound/logResponse、会话生命周期；renderHistory 等回放靠 withDebugMuted 抑制
 *   fsa.js         文件系统访问：readyRoot / writeUpload / getBridgeHandle / workspacePermission
 *
 * 【与 background 的消息协议】long-lived port，name = 'ai-chat-connection'
 *   发送 {action:'aiChatStream'|'aiChatStop'|'aiChatPing', requestId, messages, tools, stream, baseUrl, apiKey, model, disableThinking}
 *   接收 AI_CHAT_READY / AI_CHAT_CHUNK / AI_CHAT_REASONING / AI_CHAT_DONE / AI_CHAT_ERROR
 *        / AI_CHAT_ABORTED / AI_CHAT_PONG
 *        按 requestId 在 pending Map 中查回调（见 handlePortMessage）
 *
 * 【单轮请求的超时与保活】（docs/plan-optimization.md T0）
 *   1. 滑动空闲：每收到 ready/chunk/reasoning 任一事件即重置 REQUEST_IDLE_TIMEOUT_MS 计时，
 *      同时受 REQUEST_MAX_TIMEOUT_MS 硬上限约束；超时后主动发 aiChatStop 让 SW 中止在途流。
 *   2. keepalive：pending 非空时每 KEEPALIVE_INTERVAL_MS 发一次 aiChatPing（SW 回 PONG），
 *      避免请求在途期间 MV3 service worker 被空闲回收。
 *   3. 断连即刻失败：port onDisconnect 时把 pending 里所有在途请求以 {retriable:true} 收尾，
 *      页面不再空等超时；重连由 ensurePortReady 在下一次发送前兜住。
 *
 * 【一次对话的数据流】
 *   handleSend(L1027) → runAgentLoop(L190)  最多 state.maxToolIterations 轮
 *     → sendRound(L130) 流式；失败且 retriable 时自动降级为非流式重试一次
 *     → 有 tool_calls：executeToolCalls(L275) → toolExecutors[name](结果超 MAX_TOOL_RESULT_CHARS 截断) → 下一轮
 *     → 无 tool_calls：commitAssistant(L264) 落库；finish_reason==='length' 挂「继续生成」按钮(L1114)
 *
 * 【段落 / 函数清单】
 *   L69    import 依赖（state+DOM、工具表、设置、FSA）
 *   L94    port 连接 —— connectPort · ensurePortReady · pending · startKeepAlive/stopKeepAlive
 *                 · failAllPending · handlePortMessage · sendRound（滑动空闲 + 硬上限超时）
 *   L163   视觉模型选择 —— messageHasVisionInput(L165) · latestUserMessageHasVisionInput(L170)
 *                 · selectRequestProvider(L179)
 *   L188   function-calling 循环 —— runAgentLoop(L190) 内含 tool_calls arguments 非标准 JSON 修复
 *                 · evictToolResults（逐轮工具结果驱逐）· msgChars · commitAssistant(L264) · executeToolCalls(L275)
 *   L301   渲染 —— 滚动：isNearBottom(L303) · scrollToBottom(L307) · maybeScroll(L311)
 *                 · updateScrollBtn(L315) · 顶层 scroll/按钮监听(L319 起)
 *                 Markdown：escapeHtml(L332) · escapeUrl(L337) · inlineMd(L344) · mdToHtml(L358)
 *                 图表：renderVolumeChart(L470)，代码围栏语言标 stockchart 时渲染成交量柱状图
 *                 气泡：appendMessage(L499) · showWaitingAssistant(L543) · removeWaitingAssistant(L550)
 *                 · beginAssistant(L556) · appendToCurrentAssistant(L562) · renderToolEntry(L570)
 *                 · 思考过程折叠块：beginThinking · appendToCurrentThinking · finishThinking
 *                 · appendActionButton(L593) · renderHistory(L607)
 *   L618   会话管理 —— loadSessions(L620) · sortedSessionIds(L625) · renderSessionSelect(L629)
 *                 · ensureChat(L640) · newChatId(L654) · trimChat(L658) · persistSessions(L667)
 *                 · autoSessionTitle(L671) · saveChat(L688) · deferAutoTitleForVisionInput(L699)
 *                 · switchSession(L706) · createSession(L718) · renameSession(L725)
 *                 · deleteSession(L735) · clearSession(L753)
 *   L765   文件上传 —— LLM_CONTEXT_FILES_DIR(L767) · uniqueUploadName(L769)
 *                 · readFileAsDataURL(L781) · handleUploadFiles(L790)
 *                 图片转 image_url 视觉输入，非图片只在消息里登记路径让模型用 read_file 读取
 *   L824   剪贴板图片 —— extForMime(L826) · renderPastePreviews(L830) · bindPastePreview(L856)
 *   L882   发送/停止/重试/意图 —— setGenerating(L884) · reauthorizePendingInGesture(L890) 手势内补 FSA 授权
 *                 · updateIntentBubbles(L908) · intentLabel(L913) · handleIntentBubble(L917)
 *                 · parseAndCreateKeyPoint(L942) · parseAndCreateEvent(L962) · parseAndRecordStockTrade(L1000)
 *                 · handleSend(L1027) · stopGeneration(L1081) · retryLast(L1088) · continueGeneration(L1114)
 *   L1131  事件绑定 —— bindEvents(L1133)
 *   L1173  初始化 —— init(L1175)，文件末尾 L1217 直接 init() 自执行
 *
 * 【易踩坑】
 *   1. state.chatMessages 与 state.sessions[id].messages 是同一数组引用；改完消息要 trimChat() + saveChat()。
 *   2. appendMessage / renderToolEntry 只动 DOM 不落库，落库统一走 saveChat，避免相互覆盖。
 *   3. mdToHtml 是自研渲染器（先 escapeHtml 再补标签）；新增语法务必经 inlineMd/escapeHtml，勿直接拼用户内容。
 *   4. 图片消息的 content 是 parts 数组（text/image_url），凡按字符串处理 content 处都要兼容数组形态。
 *   5. 含图片的请求会临时改用视觉供应商（selectRequestProvider），不改动用户设置的活动供应商。
 *   6. 快捷意图（要点/事件/股票）用正则本地解析后直接调 toolExecutors，不经模型；改提示文案要同步改正则。
 *   7. 无构建、无测试：改完在 Chrome 扩展内手动验证（AI 窗口为独立 window，需关闭后重开）。
 *   8. DEBUG 模式下新增会落日志的渲染入口时，若属于「回放」（如 renderHistory）必须包 withDebugMuted，
 *      否则历史消息会被重复记录；流式回复的空气泡由 commitAssistant 记正文，不要在 appendToCurrentAssistant 里记。
 *   9. 思考过程的 delta 只用于展示与重置空闲超时，绝不并入 state.currentAssistantRaw，否则会被落库/回放进正文。
 *      finishThinking 必须在每轮 sendRound 返回后调用（含 tool_calls / 报错 / 超时路径），否则折叠块残留。
 *  10. evictToolResults 只改 tool 消息的 content 并打 m.evicted 标记（不动 role / tool_call_id，
 *      否则 OpenAI 协议报错）；末尾连续的 tool 消息 = 最近一轮结果，绝不驱逐。
 *  11. tool 原始返回不跨轮：chatMessages 只存 user/assistant 正文 + 两条隐藏条目（kind:'tool_trace' 账本、
 *      kind:'retained_data' 数据便签，均由 pushToolTrace / pushRetainedNotes 落入，role 用 TRACE_MESSAGE_ROLE）。
 *      不要把真正的 tool 消息塞进 chatMessages——OpenAI 协议要求 tool 消息紧跟携带同名 tool_call_id 的
 *      assistant 消息，成对缺失直接 400。内部标记（kind / evicted / chars）在 sendRound 走线前由
 *      toWireMessage 剥掉，只发协议字段。
 *  12. 模型想跨轮拿住一份数据只能调 retain_tool_data（登记本轮缓存的原文）；模型只能登记工具真返回过的原文，自己写不了自定义内容进隐藏上下文，
 *      这是故意的——防止模型把编出来的数字登记成事实。guard 的跨轮证据也只看登记进便签的原文与账本里的成功记录。
 */

import {
    state, dbg, getDateTime,
    storageGet, storageSet, genUid,
    MAX_TOOL_RESULT_CHARS, MAX_MESSAGES, MAX_MESSAGE_CHARS,
    toolResultLimitChars, MAX_ROUND_TOOL_CHARS, MAX_CONTEXT_CHARS,
    TRACE_MESSAGE_ROLE, MAX_TRACE_CHARS, MAX_TRACE_CALLS, MAX_KEEP_TRACES,
    MAX_RETAINED_ENTRIES, MAX_RETAINED_TOTAL, MAX_TURN_TOOL_RESULTS,
    fmtDateTimeStr,
    REQUEST_IDLE_TIMEOUT_MS, REQUEST_MAX_TIMEOUT_MS, KEEPALIVE_INTERVAL_MS, THINKING_TAIL_CHARS,
    CHAT_KEY,
    messagesEl, scrollDownBtn, chatInput, sendBtn, stopBtn,
    uploadBtn, uploadInput, pastePreviews, intentBubblesEl, intentBubbleEls,
    sessionSelect, newSessionBtn, renameSessionBtn, deleteSessionBtn, clearChatBtn,
    openAiSettingsBtn, closeAiSettingsBtn, dirStatusBar, aiDebugModeInput,
} from './core/ai_state.js';
import {
    TOOL_DEFS, TOOL_GROUPS, TOOL_GROUP_DEF, TOOL_GROUP_RULES, TOOL_CATALOG,
    getLoadedToolDefs, toolExecutors,
    CONTEXT_TOOL_DEFS,
    loadMemory, buildSystemPrompt, todayStr,
} from './core/ai_tools.js';
import {
    loadProviders, activeProvider, bindProviderEvents,
    openSettings, closeSettings, loadBridgeSettings, refreshDirStatus,
    renderProviderSelect, fillProviderInputs, renderDefaultVisionProviderSelect,
    renderBridgeDirStatus,
    bindWorkspaceSetupEvents,
    bindBridgeSetupEvents,
} from './core/ai_settings.js';
import { readyRoot, writeUpload, getBridgeHandle, workspacePermission } from './core/fsa.js';
import {
    loadDebugFlag, applyRemoteDebugFlag, isDebugOn, beginDebugSession, dropDebugSession,
    record, recordRepeat, recordMessage, withDebugMuted, bindDebugButton, bindDebugGlobals,
    flattenContent,
} from './core/ai_debug.js';

// ============== port 连接 ==============

function connectPort() {
    try {
        state.port = chrome.runtime.connect({ name: 'ai-chat-connection' });
    } catch {
        state.portAlive = false;
        return;
    }
    state.portAlive = true;
    state.port.onMessage.addListener(handlePortMessage);
    state.port.onDisconnect.addListener(() => {
        state.portAlive = false;
        stopKeepAlive();
        // T0-3：SW 被回收/重启时在途请求已孤儿化，立刻以可重试错误收尾，不让页面空等超时
        // 断连会每 30s 左右重复一次，同类报错走折叠：长期挂机只留首条 + 一条滚动末条
        recordRepeat('error', { text: '与后台 service worker 连接断开，500ms 后重连', 在途请求数: pending.size });
        failAllPending('后台已重启，请求中断');
        setTimeout(connectPort, 500);
    });
}

const pending = new Map();

// ============== SW keepalive ==============

let keepAliveTimer = null;

// 请求在途期间每 KEEPALIVE_INTERVAL_MS 发一次 ping（SW 回 pong）：
// MV3 下 long-lived port 单独不足以吊住 SW，靠消息活动重置 30s 空闲回收计时
function startKeepAlive() {
    if (keepAliveTimer) return;
    keepAliveTimer = setInterval(() => {
        if (pending.size === 0 || !state.portAlive) { stopKeepAlive(); return; }
        for (const requestId of pending.keys()) {
            try { state.port.postMessage({ action: 'aiChatPing', requestId }); } catch { /* 断开由 onDisconnect 统一收尾 */ }
        }
    }, KEEPALIVE_INTERVAL_MS);
}

function stopKeepAlive() {
    if (!keepAliveTimer) return;
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
}

// 断连后 500ms 才重连，非流式重试常落在该窗口内，发送前先等 port 就绪
function ensurePortReady(timeoutMs = 2000) {
    if (state.portAlive) return Promise.resolve(true);
    return new Promise((resolve) => {
        const startedAt = Date.now();
        const timer = setInterval(() => {
            if (state.portAlive) { clearInterval(timer); resolve(true); }
            else if (Date.now() - startedAt > timeoutMs) { clearInterval(timer); resolve(false); }
        }, 150);
    });
}

function failAllPending(message) {
    for (const [, p] of [...pending.entries()]) p.resolve({ ok: false, error: message, retriable: true });
    pending.clear();
}

function handlePortMessage(message) {
    const p = pending.get(message.requestId);
    if (!p) return; // 已收尾（超时/断连）后迟到的分片，直接丢弃
    if (message.type === 'AI_CHAT_CHUNK') {
        p.touch();
        p.onChunk(message.delta);
    } else if (message.type === 'AI_CHAT_REASONING') {
        p.touch(); // 思考中的 delta 同样重置空闲超时，避免长思考被误判断连
        p.onReasoning(message.delta);
    } else if (message.type === 'AI_CHAT_READY') {
        p.touch();
        p.onReady();
    } else if (message.type === 'AI_CHAT_PONG') {
        // keepalive 回程，仅证明 SW 存活，无需动作
    } else if (message.type === 'AI_CHAT_DONE') {
        p.resolve({ ok: true, finish_reason: message.finish_reason, tool_calls: message.tool_calls || [] });
    } else if (message.type === 'AI_CHAT_ERROR') {
        p.resolve({ ok: false, error: message.message, retriable: !!message.retriable });
    } else if (message.type === 'AI_CHAT_ABORTED') {
        p.resolve({ ok: false, aborted: true });
    }
}

async function sendRound(apiMessages, tools, { stream = true, provider = activeProvider() } = {}) {
    if (!(await ensurePortReady())) {
        return { ok: false, error: '与后台连接已断开，请稍后重试', retriable: true, content: '' };
    }
    return new Promise((resolve) => {
        const requestId = ++state.currentRequestId;
        let content = '';
        let reasoningChars = 0;
        let idleTimer = 0;
        const finish = (r) => {
            if (!pending.has(requestId)) return;
            pending.delete(requestId);
            clearTimeout(idleTimer);
            clearTimeout(maxTimer);
            if (pending.size === 0) stopKeepAlive();
            resolve({ ...r, content, reasoningChars });
        };
        const expire = (label) => {
            // 页面侧先超时：通知 SW 中止在途流，避免继续生成浪费 token
            try { state.port.postMessage({ action: 'aiChatStop', requestId }); } catch { /* port 已断 */ }
            finish({ ok: false, error: label + '，请重试', retriable: true });
        };
        const entry = {
            // 滑动空闲：每个事件都重新排，空闲满 REQUEST_IDLE_TIMEOUT_MS 才判无响应
            touch: () => {
                clearTimeout(idleTimer);
                idleTimer = setTimeout(() => expire('模型 ' + Math.round(REQUEST_IDLE_TIMEOUT_MS / 1000) + 's 无响应'), REQUEST_IDLE_TIMEOUT_MS);
            },
            onReady: () => showWaitingAssistant(),
            onChunk: (delta) => { content += delta; appendToCurrentAssistant(delta); },
            onReasoning: (delta) => { reasoningChars += String(delta || '').length; appendToCurrentThinking(delta); },
            resolve: finish,
        };
        const maxTimer = setTimeout(() => expire('请求超时（' + Math.round(REQUEST_MAX_TIMEOUT_MS / 1000) + 's）'), REQUEST_MAX_TIMEOUT_MS);
        entry.touch();
        pending.set(requestId, entry);
        startKeepAlive();
        record('request', {
            requestId,
            stream,
            模型: provider.model || '',
            baseUrl: provider.baseUrl || '',
            关闭思考: provider.disableThinking === true,
            消息数: (apiMessages || []).length,
            工具数: (tools || []).length,
        });
        try {
            state.port.postMessage({
                action: 'aiChatStream',
                requestId,
                // 只送协议字段：kind / evicted 一类内部标记不得跟着走线（部分供应商不接受未知字段）
                messages: (apiMessages || []).map(toWireMessage),
                tools,
                stream,
                baseUrl: provider.baseUrl,
                apiKey: provider.apiKey,
                model: provider.model,
                disableThinking: provider.disableThinking === true,
            });
        } catch {
            finish({ ok: false, error: '与后台连接已断开，请稍后重试', retriable: true });
        }
    });
}

// ============== 视觉模型选择辅助 ==============

function messageHasVisionInput(message) {
    return Array.isArray(message && message.content)
        && message.content.some(part => part && part.type === 'image_url');
}

function latestUserMessageHasVisionInput(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        if (message.role !== 'user') continue;
        return messageHasVisionInput(message);
    }
    return false;
}

function selectRequestProvider(messages) {
    const current = activeProvider();
    const hasAnyVisionInput = messages.some(messageHasVisionInput);
    if (!hasAnyVisionInput || current.supportsVision) return current;
    return state.providers.find(p => p.id === state.defaultVisionProviderId && p.supportsVision)
        || state.providers.find(p => p.supportsVision)
        || current;
}

// ============== function-calling 循环 ==============

/** DEBUG：记录一次模型响应的元信息（正文另由 commitAssistant / appendMessage 记录） */
function logResponse(result) {
    record('response', {
        ok: result.ok === true,
        结束原因: result.finish_reason || '',
        工具调用数: (result.tool_calls || []).length,
        文本字符: (result.content || '').length,
        思考字符: result.reasoningChars || 0,
        错误: result.error || '',
        中断: result.aborted === true,
    });
}

/**
 * 一次用户提问 = 一整串 function-calling 轮。
 * 外层只负责兜底：不管正常收工 / 报错 / 中断 / 轮数耗尽，本轮的工具账本都要落到 chatMessages，
 * 否则下一轮模型既不知道自己查过什么，也不知道哪些查失败了（docs/debug.txt 的根因）。
 */
async function runAgentLoop(initialMessages, initialToolGroups = []) {
    const turnCalls = [];
    // 本轮的工具原始返回缓存与待落库便签逐轮重置（retain_tool_data 只能登记本轮的东西）
    state.turnToolResults = [];
    state.pendingRetains = [];
    try {
        await runAgentLoopBody(initialMessages, initialToolGroups, turnCalls);
    } finally {
        pushToolTrace(turnCalls);
        pushRetainedNotes();
    }
}

async function runAgentLoopBody(initialMessages, initialToolGroups, turnCalls) {
    const apiMessages = initialMessages || state.chatMessages.map(toApiMessage);
    state.activeToolGroups = new Set(initialToolGroups);
    // 本轮是否真拿到过行情数据（guard 的唯一硬证据）与「强制纠正只做一次」的闭锁
    let quoteEvidence = false;
    let guardRetried = false;
    const requestProvider = selectRequestProvider(apiMessages);
    if (!String(requestProvider.apiKey || '').trim()) {
        appendMessage('error', '请设置一个供应商 API Key');
        return;
    }
    const switchedForVision = requestProvider.id !== activeProvider().id;
    if (switchedForVision) appendMessage('system', `检测到图片，已临时切换到视觉模型「${requestProvider.name || requestProvider.model}」处理本次请求`);
    for (let round = 0; round < state.maxToolIterations; round++) {
        state.currentAssistantEl = null;
        removeWaitingAssistant();
        finishThinking();
        evictToolResults(apiMessages);
        const requestMessages = [buildSystemPrompt(), ...apiMessages];
        const tools = [TOOL_GROUP_DEF, ...CONTEXT_TOOL_DEFS, ...getLoadedToolDefs()];
        let result = await sendRound(requestMessages, tools, { stream: true, provider: requestProvider });
        removeWaitingAssistant();
        finishThinking();
        logResponse(result);
        if (!result.ok) {
            if (result.aborted) {
                appendMessage('system', '已停止');
                commitAssistant(result.content);
                return;
            }
            if (result.retriable) {
                appendMessage('system', '流式响应中断，改用非流式重试…');
                record('retry_stream', { 原因: result.error || '' });
                result = await sendRound(requestMessages, tools, { stream: false, provider: requestProvider });
                removeWaitingAssistant();
                finishThinking();
                logResponse(result);
            }
            if (!result.ok) {
                const errorEl = appendMessage('error', result.error || '请求失败');
                state.lastRequestSnapshot = { messages: requestMessages, toolGroups: [...state.activeToolGroups] };
                const actionWrap = appendActionButton('重试', retryLast);
                const failEntry = commitAssistant(result.content);
                state.lastFailUi = { errorEl, actionWrap, failEntry };
                return;
            }
        }
        if (result.tool_calls && result.tool_calls.length > 0) {
            // 修复 arguments 为非合法 JSON 的模型输出（如单引号、尾逗号、纯文本），
            const sanitizedCalls = result.tool_calls.map(tc => {
                let raw = String(tc.arguments || '').trim();
                if (!raw || raw === '{}' || raw === '[]') return { ...tc, arguments: '{}' };
                try { JSON.parse(raw); return { ...tc, arguments: raw }; } catch { }
                // 尝试修复常见非 JSON 格式
                try {
                    const fixed = raw
                        .replace(/'/g, '"')           // 单引号转双引号
                        .replace(/([{,])\s*(\w+)\s*:/g, '$1"$2":') // 无引号 key 加引号
                        .replace(/,\s*}/g, '}')         // 去掉尾逗号
                        .replace(/,\s*]/g, ']');        // 去掉数组尾逗号
                    JSON.parse(fixed);
                    return { ...tc, arguments: fixed };
                } catch { }
                return { ...tc, arguments: '{}' };
            });
            apiMessages.push({
                role: 'assistant',
                content: result.content || '',
                tool_calls: sanitizedCalls.map(tc => ({
                    id: tc.id, type: 'function',
                    function: { name: tc.function?.name || tc.name, arguments: tc.arguments },
                })),
            });
            apiMessages.push(...await executeToolCalls(sanitizedCalls, turnCalls));
            quoteEvidence = turnCalls.some(c => QUOTE_TOOLS.has(c.name) && c.ok);
            continue;
        }
        // 反编造 guard：本轮没拿到过行情数据，上一轮账本里也没有成功的取数，却输出了价格/表格 → 判定为编造。
        // 口径：tool 原始返回不跨轮，所以“上一轮的数据”只能以当时写进回复正文的形式存在（系统提示 [上下文口径] 已要求）。
        if (state.activeToolGroups.size > 0 && !quoteEvidence && !hasPriorQuoteEvidence()) {
            const replyText = result.content || '';
            const hasPriceData = /(现价|收盘|开盘|最高价|最低价|涨跌幅|涨跌额|成交量|成交额|换手率|跌停|涨停|股价)/.test(replyText);
            const hasTable = /^\|/.test(replyText.trim()) && /\|\s*\d/.test(replyText);
            if (hasPriceData || (hasTable && quoteTopicNearby(apiMessages))) {
                if (!guardRetried) {
                    guardRetried = true;
                    record('guard', { 处理: '注入强制纠正', 文本字符: replyText.length, 表格: hasTable, 价格字样: hasPriceData });
                    appendMessage('system', '本轮未检测到取数成功的工具调用，已要求重新取数');
                    apiMessages.push({
                        role: 'system',
                        content: '【强制纠正】本轮没有任何取数成功的工具调用（上一轮工具记录也未显示行情数据），刚才那段数字是编造的，不可使用。'
                            + '请立即调用 get_stock_quote / get_portfolio_quotes（实时）或 read_stock_kline / read_stocks_kline（日线）拿真实数据后再回答；'
                            + '取不到就只说「没有取到数据」并原样转述工具给的原因，不得输出任何价格、涨跌幅、成交量或 K 线表格。'
                            + '后面还要用的数据，取到后本轮调 retain_tool_data 登记成隐藏便签（tool 原始返回下一轮就不在你的上下文里了）。',
                    });
                    continue;
                }
                // 纠正一次仍在编：强价格信号（写了收盘/成交量等）直接丢正文；
                // 只有「表格 + 话题像行情」的弱信号则放行加免责，避免误伤「列文件/列表名」这类正常回答
                if (!hasPriceData) {
                    record('guard', { 处理: '二次命中，弱信号放行并提示', 文本字符: replyText.length });
                    appendMessage('system', '本轮没有取数成功的工具调用，下面内容里的数值没有工具来源，请自行核对');
                } else {
                    record('guard', { 处理: '二次命中，丢弃正文', 文本字符: replyText.length });
                    dropAssistantBubble();
                    appendMessage('error', '模型在未取到真实数据的情况下再次直接给出行情数值，该回复已被拦截。请先让取数链路可用（启用 Agent 桥接查本地库，或改问 7 日内走免费渠道）再问一次。');
                    return;
                }
            }
        }
        commitAssistant(result.content);
        if (result.finish_reason === 'length') {
            appendActionButton('继续生成', continueGeneration);
        }
        return;
    }
    appendMessage('system', '工具调用轮数已达上限（' + state.maxToolIterations + '），已结束本轮');
}

// ============== 跨轮工具记录（账本）==============

// guard 与账本共用的「有真实数据来源」口径：行情接口 + 会带回库存价格/SQL 行的工具
// （get_stock_list 回的是本地库已落地数据并带 数据时间，query_local_database 回原始行，都算真实来源）
const QUOTE_TOOLS = new Set([
    'get_stock_quote', 'get_portfolio_quotes', 'read_stock_kline', 'read_stocks_kline',
    'get_stock_list', 'query_local_database',
]);

// 账本开头那段话就是给模型看的核心提示：原始返回不存上下文，有价值的数据自己写进正文
const TOOL_TRACE_HEAD = '[工具调用记录·系统自动登记，非用户发言] 上一轮工具调用的原始返回已不在你的上下文里，只剩下面这份账本。'
    + '当时觉得有价值的原始数据如果没调 retain_tool_data 登记成跨轮便签，现在就是丢了：要么重新调用工具（会再花一次免费接口额度），要么只能告诉用户拿不到了。'
    + '标为「失败」的查询从来没有给过你数据，不得把它们的结论当成已知事实，更不得补写数值。';

/** chatMessages → API 消息：只回灌 role/content（外加内部 kind 标记，走线前由 toWireMessage 剥掉） */
function toApiMessage(m) {
    const role = ['user', 'assistant', 'system', 'tool'].includes(m.role) ? m.role : 'assistant';
    const msg = { role, content: m.content };
    if (m.kind) msg.kind = m.kind;
    return msg;
}

/** 发给供应商前剩掉一切内部字段（kind / evicted / 旧版误存的 tool_calls 名等），只留 OpenAI 协议字段 */
function toWireMessage(m) {
    const out = { role: m.role, content: m.content };
    if (typeof m.name === 'string' && m.name) out.name = m.name;
    if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
    if (Array.isArray(m.tool_calls)) out.tool_calls = m.tool_calls;
    return out;
}

function clipText(v, n) {
    const s = String(v == null ? '' : v);
    return s.length > n ? s.slice(0, n) + '…' : s;
}

/** 把一次工具调用压成一行账：名字(参数) 耗时 → 成功（列几个要点）/ 失败（原因+诊断） */
function summarizeToolCall(name, argsText, resultText, ms, truncated, failed) {
    let obj = null;
    try { obj = JSON.parse(resultText); } catch { /* 纯文本结果 */ }
    const payload = obj && typeof obj === 'object' ? obj : {};
    // 业务失败看返回里的 error 键；抛异常/未知工具是纯文本结果，看 failed 标记
    const errText = typeof payload.error === 'string' ? payload.error : (failed ? String(resultText || '执行失败') : '');
    const ok = !errText;   // 截断不算失败（数据仍部分有效），只在行里标一句
    const bits = [];
    if (ok) {
        for (const key of ['rows', 'stocks', 'quotes', 'list', 'items']) {
            if (Array.isArray(payload[key])) { bits.push(`${key} ${payload[key].length}`); break; }
        }
        if (payload.failed) bits.push('其中失败 ' + payload.failed);
        if (payload['数据日期']) bits.push('数据日期 ' + clipText(payload['数据日期'], 12));
        if (payload['渠道']) bits.push('渠道 ' + clipText(payload['渠道'], 24));
        if (typeof payload.size === 'number') bits.push(payload.size + ' 字节');
        if (payload.table || payload['数据表']) bits.push('数据表 ' + clipText(payload.table || payload['数据表'], 30));
        bits.push((resultText || '').length + ' 字' + (truncated ? '（已截断）' : ''));
    } else {
        const diag = payload['取数诊断'] || payload['本地库诊断'] || payload['渠道诊断'] || payload['排查'] || payload.hint || '';
        bits.push('失败：' + clipText(errText || resultText, 120) + (diag ? '（' + clipText(diag, 80) + '）' : ''));
    }
    return { name, ok, ms, text: `- ${name}(${clipText(argsText, 120)}) ${ms}ms → ${bits.join('，')}` };
}

/**
 * 一轮结束后把账本落进 chatMessages（不弹对话气泡，回灌时只带文本）。
 * 只留最近 MAX_KEEP_TRACES 轮：更早的原始数据本来也拿不回来，留着只会撑预算、让模型引用过期数值。
 */
function pushToolTrace(calls) {
    const list = (calls || []).filter(c => c && c.name && c.name !== 'load_tool_group');
    if (!list.length) return;
    const shown = list.slice(-MAX_TRACE_CALLS);
    let body = shown.map(c => c.text).join('\n');
    if (list.length > shown.length) body = `- （更早 ${list.length - shown.length} 次调用已省略）\n` + body;
    if (body.length > MAX_TRACE_CHARS) body = clipText(body, MAX_TRACE_CHARS);
    const entry = pushHiddenEntry('tool_trace', TOOL_TRACE_HEAD + '\n' + body, {
        calls: shown.map(c => ({ name: c.name, ok: c.ok === true })),
    });
    trimHiddenEntries();
    trimChat();
    saveChat();
    record('tool_trace', { name: '本轮 ' + list.length + ' 次调用', 调用次数: list.length, 行情成功: list.some(c => QUOTE_TOOLS.has(c.name) && c.ok), 内容: entry.content });
}
/** 隐藏上下文条目统一入口：不弹气泡、不渲染到对话区，只进 chatMessages 喂给后续轮的模型 */
function pushHiddenEntry(kind, content, meta) {
    const entry = {
        role: TRACE_MESSAGE_ROLE,
        kind,
        content,
        ts: Date.now(),
        uid: genUid('m'),
        ...(meta || {}),
    };
    state.chatMessages.push(entry);
    return entry;
}

/**
 * 排空 retain_tool_data 登记的便签，落成隐藏上下文条目（下一轮起回灌）。
 * 同一个工具只留一份（后登记覆盖前面的），总量超 MAX_RETAINED_TOTAL / 条数超 MAX_RETAINED_ENTRIES 时丢最旧。
 */
function pushRetainedNotes() {
    const notes = state.pendingRetains || [];
    state.pendingRetains = [];
    if (!notes.length) return;
    for (const n of notes) {
        const head = '[跨轮数据便签·系统自动登记，非用户发言] 这是你在之前轮次用 retain_tool_data 保留的工具原始数据，对话界面不展示。'
            + '它是登记当时的快照：只要话题需要现价/当日数据，仍然必须重新取数，不得拿它当最新行情引用。\n';
        const src = `来源 ${n.tool}(${n.argsText || '{}'}) 登记于 ${fmtDateTimeStr(n.ts)}${n.note ? '｜用途：' + n.note : ''}\n`;
        pushHiddenEntry('retained_data', head + src + n.text, { source: n.tool, chars: n.text.length });
        record('retained', { name: n.tool, 字符: n.text.length, 用途: n.note || '', 内容: n.text });
    }
    trimHiddenEntries();
    trimChat();
    saveChat();
}

/** 账本与便签的容量口径：条数/总量超限先丢最旧的，避免隐藏上下文反过来吃掉 MAX_CONTEXT_CHARS */
function trimHiddenEntries() {
    const kept = [];
    let totalRetained = 0;
    for (let i = state.chatMessages.length - 1; i >= 0; i--) {
        const m = state.chatMessages[i];
        if (m.kind === 'retained_data') {
            const chars = Number(m.chars) || (m.content || '').length;
            if (kept.filter(k => k.kind === 'retained_data').length >= MAX_RETAINED_ENTRIES || totalRetained + chars > MAX_RETAINED_TOTAL) continue;
            totalRetained += chars;
        } else if (m.kind === 'tool_trace' && kept.filter(k => k.kind === 'tool_trace').length >= MAX_KEEP_TRACES) {
            continue;
        }
        kept.push(m);
    }
    if (kept.length !== state.chatMessages.length) {
        const keep = new Set(kept);
        state.chatMessages = state.chatMessages.filter(m => keep.has(m));
    }
}

/** 跨轮证据：历史隐藏条目里有没有真实的行情数据（已登记的行情便签，或最近账本里成功的行情调用） */
function hasPriorQuoteEvidence() {
    // 两类条目本身已被 trimHiddenEntries 限在最近几条，直接全扫即可，不必只盯最近一条
    return state.chatMessages.some(m => (m.kind === 'retained_data' && QUOTE_TOOLS.has(m.source))
        || (m.kind === 'tool_trace' && (m.calls || []).some(c => QUOTE_TOOLS.has(c.name) && c.ok === true)));
}

/** 话题是不是接着行情问的：往回看 4 条用户消息与途中助手回复（用户只回「好的」时，关键词在上一轮） */
function quoteTopicNearby(apiMessages) {
    const re = /(现价|价格|行情|走势|K\s*线|日k|日线|涨跌|开盘|收盘|股价|涨幅|跌幅|实时|报价)/i;
    let users = 0;
    for (let i = apiMessages.length - 1; i >= 0; i--) {
        const m = apiMessages[i];
        if (m.kind === 'tool_trace' || m.kind === 'retained_data') continue;   // 隐藏条目里本身就带「K 线/行情」字样，不能当话题证据
        if (m.role !== 'user' && m.role !== 'assistant') continue;
        if (typeof m.content === 'string' && re.test(m.content)) return true;
        if (Array.isArray(m.content) && re.test(flattenContent(m.content))) return true;
        if (m.role === 'user' && ++users >= 4) break;
    }
    return false;
}

/** 丢弃当前流式中的助手气泡（guard 二次命中时用，不把假数据落库也不留页面） */
function dropAssistantBubble() {
    if (state.currentAssistantEl) state.currentAssistantEl.remove();
    state.currentAssistantEl = null;
    state.currentAssistantEntry = null;
    state.currentAssistantRaw = '';
}

function commitAssistant(content) {
    if (!content) return null;
    record('assistant', { text: content });
    const entry = state.currentAssistantEntry || { role: 'assistant', content: '', ts: Date.now(), uid: genUid('m') };
    entry.content = content;
    state.chatMessages.push(entry);
    trimChat();
    saveChat();
    state.currentAssistantEntry = null;
    return entry;
}

async function executeToolCalls(toolCalls, traceSink) {
    const toolMessages = [];
    let roundBudget = MAX_ROUND_TOOL_CHARS; // 单轮工具结果总预算（T1-3）
    for (const call of toolCalls) {
        let args = {};
        let parseError = '';
        try { args = call.arguments ? JSON.parse(call.arguments) : {}; } catch (err) { parseError = err.message; args = {}; }
        record('tool_call', { name: call.name, callId: call.id, args: call.arguments || '{}', 参数解析失败: parseError });
        let result;
        let failed = false;
        const exec = toolExecutors[call.name];
        const startedAt = Date.now();
        if (!exec) {
            failed = true;
            result = '未知工具 ' + call.name;
        } else {
            try {
                result = await exec(args);
            } catch (err) {
                failed = true;
                result = '工具执行失败：' + err.message;
            }
        }
        let resultText = typeof result === 'string' ? result : JSON.stringify(result);
        // 分级上限：按工具取值，再受本轮剩余预算约束（至少留 600 字，否则不如给存根）
        const cap = Math.max(Math.min(toolResultLimitChars(call.name), MAX_TOOL_RESULT_CHARS, roundBudget), 600);
        if (resultText.length > cap) {
            resultText = resultText.slice(0, cap) + '\n（已截断，共 ' + resultText.length + ' 字；需要更多数据可缩小查询范围或传 detail/limit 参数）';
        }
        roundBudget -= resultText.length;
        record('tool_result', {
            name: call.name,
            callId: call.id,
            耗时ms: Date.now() - startedAt,
            失败: failed,
            返回字符: resultText.length,
            上限: cap,
            result: resultText,
        });
        renderToolEntry(call.name, call.arguments || '{}', resultText);
        const trace = summarizeToolCall(call.name, call.arguments, resultText, Date.now() - startedAt,
            resultText.length > cap, failed);
        if (traceSink) traceSink.push(trace);
        // 本轮原文缓存：只存本轮（retain_tool_data 只能登记本轮拿到的东西，不允许凭记忆编一份）
        if (call.name !== 'load_tool_group' && call.name !== 'retain_tool_data') {
            state.turnToolResults.push({ name: call.name, argsText: clipText(call.arguments, 120), text: resultText, ok: trace.ok, ts: Date.now() });
            if (state.turnToolResults.length > MAX_TURN_TOOL_RESULTS) state.turnToolResults.shift();
        }
        toolMessages.push({ role: 'tool', tool_call_id: call.id, content: resultText });
    }
    return toolMessages;
}

/** 消息计入上下文的字符量（content 可能为图片 parts 数组） */
function msgChars(m) {
    if (typeof m.content === 'string') return m.content.length + (m.reasoning_content || '').length;
    if (Array.isArray(m.content)) return m.content.reduce((n, p) => n + String(p && p.text || '').length, 0);
    return 0;
}

// 逐轮工具结果驱逐（T1-2）：上下文超预算时，把最旧几轮的 tool 结果换成存根。
// 只改 content，保留 role/tool_call_id 配对合法性（assistant.tool_calls 必须能找到对应 tool 消息）；
// 末尾连续的 tool 消息 = 最近一轮结果，不得驱逐，模型丢了旧数据可按存根里的工具名重新取数。
function evictToolResults(apiMessages) {
    let total = apiMessages.reduce((n, m) => n + msgChars(m), 0);
    if (total <= MAX_CONTEXT_CHARS) return 0;
    // tool_call_id -> 工具名（存根里告诉模型是谁被归档了）
    const nameByCallId = new Map();
    for (const m of apiMessages) {
        for (const tc of m.tool_calls || []) {
            nameByCallId.set(tc.id, (tc.function && tc.function.name) || tc.name || '');
        }
    }
    // 最近一轮边界：从末尾往前数连续的 tool 消息，这些不碰
    let lastRoundFrom = apiMessages.length;
    while (lastRoundFrom > 0 && apiMessages[lastRoundFrom - 1].role === 'tool') lastRoundFrom--;
    let evicted = 0;
    for (let i = 0; i < lastRoundFrom; i++) {
        if (total <= MAX_CONTEXT_CHARS) break;
        const m = apiMessages[i];
        if (m.role !== 'tool' || m.evicted) continue;
        const raw = typeof m.content === 'string' ? m.content : '';
        const toolName = nameByCallId.get(m.tool_call_id) || '工具';
        const stub = '«' + toolName + ': 早先的 ' + raw.length + ' 字结果已驱逐归档（需重新查看请再次调用该工具）»';
        total -= raw.length - stub.length;
        m.content = stub;
        m.evicted = true;
        evicted++;
    }
    if (evicted) {
        record('evict', { 驱逐条数: evicted, 驱逐后字符: total, 预算: MAX_CONTEXT_CHARS });
        appendMessage('system', '上下文超过预算，已将最早 ' + evicted + ' 条工具结果归档（需要时可重新取数）');
    } else if (total > MAX_CONTEXT_CHARS) {
        // 只剩最近一轮仍超预算：不再驱逐（会弄坏当前分析），只记日志供调上限
        record('evict', { 未驱逐: true, 当前字符: total, 预算: MAX_CONTEXT_CHARS });
    }
    return evicted;
}

// ============== 渲染 ==============

function isNearBottom() {
    return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 60;
}

function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
}

function maybeScroll() {
    if (state.followStream) scrollToBottom();
}

function updateScrollBtn() {
    scrollDownBtn.hidden = isNearBottom();
}

messagesEl.addEventListener('scroll', () => {
    const nearBottom = isNearBottom();
    state.followStream = nearBottom;
    scrollDownBtn.hidden = nearBottom;
});

scrollDownBtn.addEventListener('click', () => {
    scrollToBottom();
    state.followStream = true;
    scrollDownBtn.hidden = true;
});

// Markdown 安全渲染
function escapeHtml(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function escapeUrl(u) {
    const s = String(u || '').trim().replace(/&amp;/g, '&');
    return /^(https?:|mailto:)/i.test(s) ? s : '#';
}

const MD_CODE_MARK = '\x01';

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

function mdToHtml(text) {
    const lines = String(text ?? '').split(/\r?\n/);
    let html = '';
    let inCode = false;
    let codeBuf = [];
    let codeLang = '';
    let listType = null;
    const para = [];
    let tableBuf = null;

    const flushPara = () => {
        if (para.length) {
            html += '<p>' + inlineMd(para.map(escapeHtml).join('<br>')) + '</p>';
            para.length = 0;
        }
    };
    const flushList = () => {
        if (listType) { html += '</' + listType + '>'; listType = null; }
    };
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
            if (row.length !== header.length) continue;
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
    if (inCode) {
        if (codeLang === 'stockchart') html += renderVolumeChart(codeBuf);
        else html += '<pre><code>' + codeBuf.join('\n') + '</code></pre>';
    }
    return html || '<p></p>';
}

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

function appendMessage(role, content, entry) {
    recordMessage(role, content);
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
                    img.src = url;
                    el.appendChild(img);
                }
            }
        }
    } else {
        el.innerHTML = mdToHtml(content ?? '');
    }
    if (entry && entry.uid && (role === 'user' || role === 'assistant')) {
        el.dataset.uid = entry.uid;
        const del = document.createElement('span');
        del.className = 'msg-del';
        del.textContent = '×';
        del.title = '删除该条消息（从对话历史移除）';
        del.addEventListener('click', () => {
            const before = state.chatMessages.length;
            state.chatMessages = state.chatMessages.filter(m => m.uid !== entry.uid);
            if (state.chatMessages.length === before) return;
            el.remove();
            saveChat();
        });
        el.appendChild(del);
    }
    messagesEl.appendChild(el);
    maybeScroll();
    return el;
}

function showWaitingAssistant() {
    removeWaitingAssistant();
    state.waitingAssistantEl = appendMessage('assistant', '');
    state.waitingAssistantEl.classList.add('msg-assistant-waiting');
    state.waitingAssistantEl.innerHTML = '<span class="typing-dots"><i></i><i></i><i></i></span>';
}

function removeWaitingAssistant() {
    if (!state.waitingAssistantEl) return;
    state.waitingAssistantEl.remove();
    state.waitingAssistantEl = null;
}

function beginAssistant() {
    state.currentAssistantEntry = { role: 'assistant', content: '', ts: Date.now(), uid: genUid('m') };
    state.currentAssistantEl = appendMessage('assistant', '', state.currentAssistantEntry);
    state.currentAssistantRaw = '';
}

function appendToCurrentAssistant(delta) {
    removeWaitingAssistant();
    finishThinking(); // 正文开始，思考过程折叠归档
    if (!state.currentAssistantEl) beginAssistant();
    state.currentAssistantRaw += delta;
    state.currentAssistantEl.innerHTML = mdToHtml(state.currentAssistantRaw);
    maybeScroll();
}

// ============== 思考过程（reasoning_content）折叠块 ==============

// 思考型模型可能先花 10~30s 只输出 reasoning_content；不解析就会出现「页面空转」的观感。
// 这里把它当进度条用：灰色小字实时展示尾部，正文一到达即折叠为「思考过程（N 字）」可点开回看。
function beginThinking() {
    const el = document.createElement('div');
    el.className = 'msg msg-thinking expanded';
    const head = document.createElement('div');
    head.className = 'tool-head';
    const caret = document.createElement('span');
    caret.className = 'tool-caret';
    caret.textContent = '▸';
    const label = document.createElement('span');
    label.textContent = '思考中';
    const dots = document.createElement('span');
    dots.className = 'typing-dots';
    dots.innerHTML = '<i></i><i></i><i></i>';
    head.append(caret, label, dots);
    const body = document.createElement('div');
    body.className = 'thinking-body';
    head.addEventListener('click', () => el.classList.toggle('expanded'));
    el.append(head, body);
    messagesEl.appendChild(el);
    state.thinkingEl = el;
    state.thinkingLabel = label;
    state.thinkingBody = body;
    state.thinkingRaw = '';
    maybeScroll();
}

function appendToCurrentThinking(delta) {
    const text = String(delta || '');
    if (!text) return;
    removeWaitingAssistant();
    if (!state.thinkingEl) beginThinking();
    state.thinkingRaw += text;
    state.thinkingBody.textContent = state.thinkingRaw.slice(-THINKING_TAIL_CHARS);
    maybeScroll();
}

// 本轮结束（正文到达 / 收工 / 报错 / 超时）时折叠并归档；空思考直接移除，不残留空气泡
function finishThinking() {
    const el = state.thinkingEl;
    if (!el) return;
    const chars = state.thinkingRaw.length;
    if (chars) {
        el.classList.remove('expanded');
        el.querySelector('.typing-dots')?.remove();
        state.thinkingLabel.textContent = '思考过程（' + chars + ' 字）';
        record('reasoning', { 字符: chars, text: state.thinkingRaw });
    } else {
        el.remove();
    }
    state.thinkingEl = null;
    state.thinkingLabel = null;
    state.thinkingBody = null;
    state.thinkingRaw = '';
}

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
    // 回放历史消息不写 DEBUG 日志（这些事件当时已记录过）
    withDebugMuted(() => {
        messagesEl.innerHTML = '';
        // 在途思考块随旧 DOM 一起丢弃（不写 state，避免往已分离节点上流式输出）
        state.thinkingEl = null;
        state.thinkingLabel = null;
        state.thinkingBody = null;
        state.thinkingRaw = '';
        state.chatMessages.forEach(m => { if (!m.uid) m.uid = genUid('m'); });
        for (const m of state.chatMessages) {
            // 工具账本不弹当对话气泡，只补一行短提示（原始结果不落库，回放时至少告诉用户当时调过什么）
            if (m.kind === 'tool_trace') {
                appendMessage('system', '工具记录（原始返回不跨轮保留）：' + (m.calls || []).map(c => c.name + (c.ok ? '' : '(失败)')).join('、'));
                continue;
            }
            if (m.kind === 'retained_data') {
                appendMessage('system', '已登记的跨轮数据便签（仅回灌给模型，界面不展开）：' + m.source + '·' + (m.chars || 0) + ' 字');
                continue;
            }
            appendMessage(m.role === 'user' ? 'user' : 'assistant', m.content || '', m);
        }
        state.followStream = true;
        scrollDownBtn.hidden = true;
        updateIntentBubbles();
    });
}

// ============== 会话管理 ==============

async function loadSessions() {
    const res = await storageGet(chrome.storage.local, CHAT_KEY);
    state.sessions = res[CHAT_KEY] || {};
}

function sortedSessionIds() {
    return Object.keys(state.sessions).sort((a, b) => (state.sessions[b].updatedAt || 0) - (state.sessions[a].updatedAt || 0));
}

function renderSessionSelect() {
    sessionSelect.innerHTML = '';
    for (const id of sortedSessionIds()) {
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = state.sessions[id].title || '未命名会话';
        sessionSelect.appendChild(opt);
    }
    sessionSelect.value = state.currentChatId;
}

async function ensureChat() {
    if (state.currentChatId) return;
    await loadSessions();
    const ids = sortedSessionIds();
    if (ids.length > 0) {
        state.currentChatId = ids[0];
    } else {
        state.currentChatId = newChatId();
        state.sessions[state.currentChatId] = { id: state.currentChatId, title: '新会话', messages: [], createdAt: Date.now(), updatedAt: Date.now() };
        await persistSessions();
    }
    state.chatMessages = state.sessions[state.currentChatId].messages || [];
}

function newChatId() {
    return 'chat_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
}

function trimChat() {
    if (state.chatMessages.length > MAX_MESSAGES) state.chatMessages = state.chatMessages.slice(-MAX_MESSAGES);
    for (const m of state.chatMessages) {
        if (typeof m.content === 'string' && m.content.length > MAX_MESSAGE_CHARS) {
            m.content = m.content.slice(0, MAX_MESSAGE_CHARS);
        }
    }
}

function persistSessions() {
    return storageSet(chrome.storage.local, { [CHAT_KEY]: state.sessions });
}

function autoSessionTitle() {
    const userMessages = state.chatMessages.filter(message => message.role === 'user');
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

function saveChat() {
    if (!state.currentChatId || !state.sessions[state.currentChatId]) return Promise.resolve();
    const session = state.sessions[state.currentChatId];
    session.messages = state.chatMessages;
    session.updatedAt = Date.now();
    if ((!session.title || session.title === '新会话') && !session.deferAutoTitle) {
        session.title = autoSessionTitle();
    }
    return persistSessions().then(renderSessionSelect);
}

function deferAutoTitleForVisionInput(content) {
    if (!state.currentChatId || !state.sessions[state.currentChatId]) return;
    const provider = selectRequestProvider([{ role: 'user', content }]);
    if (provider.id !== activeProvider().id) state.sessions[state.currentChatId].deferAutoTitle = true;
    else if (!latestUserMessageHasVisionInput([{ role: 'user', content }])) state.sessions[state.currentChatId].deferAutoTitle = false;
}

async function switchSession(id, debugReason = 'switch') {
    if (!state.sessions[id] || id === state.currentChatId) return;
    await saveChat();
    state.currentChatId = id;
    state.chatMessages = state.sessions[id].messages || [];
    state.pendingImages = [];
    renderPastePreviews();
    renderHistory();
    renderSessionSelect();
    beginDebugSession(id, debugReason);
    chatInput.focus();
}

async function createSession() {
    const id = newChatId();
    state.sessions[id] = { id, title: '新会话', messages: [], createdAt: Date.now(), updatedAt: Date.now() };
    await persistSessions();
    await switchSession(id, 'new');
}

async function renameSession() {
    const session = state.sessions[state.currentChatId];
    if (!session) return;
    const name = prompt('会话名称：', session.title || '');
    if (name === null || !name.trim()) return;
    session.title = name.trim().slice(0, 30);
    await persistSessions();
    renderSessionSelect();
}

async function deleteSession() {
    const session = state.sessions[state.currentChatId];
    if (!session) return;
    if (!confirm(`删除会话「${session.title || '未命名会话'}」？消息内容将一并删除`)) return;
    const removedChatId = state.currentChatId;
    delete state.sessions[state.currentChatId];
    dropDebugSession(removedChatId);
    state.currentChatId = null;
    const ids = sortedSessionIds();
    if (ids.length === 0) {
        const id = newChatId();
        state.sessions[id] = { id, title: '新会话', messages: [], createdAt: Date.now(), updatedAt: Date.now() };
    }
    await persistSessions();
    state.currentChatId = sortedSessionIds()[0];
    state.chatMessages = state.sessions[state.currentChatId].messages || [];
    renderHistory();
    renderSessionSelect();
    beginDebugSession(state.currentChatId, 'open');
}

async function clearSession() {
    if (!confirm('清空当前会话的全部消息？长期记忆不受影响')) return;
    state.chatMessages = [];
    messagesEl.innerHTML = '';
    state.pendingImages = [];
    renderPastePreviews();
    state.followStream = true;
    scrollDownBtn.hidden = true;
    updateIntentBubbles();
    dropDebugSession(state.currentChatId);
    beginDebugSession(state.currentChatId, 'open');
    await saveChat();
}

// ============== 文件上传 ==============

const LLM_CONTEXT_FILES_DIR = 'llm_context_files';

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

function readFileAsDataURL(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
    });
}

async function handleUploadFiles(files) {
    if (!files || files.length === 0) return;
    if (!state.workspaceHandles.length) { alert('请先设置工作目录：点击窗口顶部「选择目录」授权后即可上传文件'); return; }
    const dir = await readyRoot(state.workspaceHandles, '');
    const imageTypes = /^image\/(png|jpe?g|gif|webp)$/i;
    const parts = [];
    let imageCount = 0;
    for (const file of files) {
        const name = await uniqueUploadName(dir.handle, file.name);
        const target = LLM_CONTEXT_FILES_DIR + '/' + name;
        await writeUpload(dir.handle, target, file);
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
    const userEntry = { role: 'user', content: parts, ts: Date.now(), uid: genUid('m') };
    state.chatMessages.push(userEntry);
    trimChat();
    deferAutoTitleForVisionInput(parts);
    saveChat();
    appendMessage('user', parts, userEntry);
    appendMessage('system',
        files.length + ' 个文件已保存到工作目录/' + LLM_CONTEXT_FILES_DIR
        + (imageCount ? `，其中 ${imageCount} 张图片已作为视觉输入传给模型` : '，文件内容未打印，可让 AI 用 read_file 读取'));
}

// ============== 剪贴板图片粘贴 ==============

function extForMime(mime) {
    return { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' }[mime] || '.png';
}

function renderPastePreviews() {
    pastePreviews.innerHTML = '';
    if (state.pendingImages.length === 0) {
        pastePreviews.hidden = true;
        return;
    }
    pastePreviews.hidden = false;
    state.pendingImages.forEach((img, idx) => {
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
            state.pendingImages.splice(idx, 1);
            renderPastePreviews();
        });
        wrap.append(pic, del);
        pastePreviews.appendChild(wrap);
    });
}

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
            state.pendingImages.push({
                dataUrl,
                file,
                name: file.name || ('paste_' + Date.now().toString(36) + extForMime(file.type)),
            });
            renderPastePreviews();
            chatInput.focus();
        });
    });
}

// ============== 发送 / 停止 / 重试 ==============

function setGenerating(v) {
    state.generating = v;
    sendBtn.disabled = v;
    stopBtn.hidden = !v;
}

async function reauthorizePendingInGesture() {
    let changed = false;
    for (const d of state.workspaceHandles) {
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

// 意图气泡
function updateIntentBubbles() {
    if (!intentBubblesEl) return;
    intentBubblesEl.hidden = state.chatMessages.length > 0;
}

function intentLabel(intent) {
    return { keypoint: '增加要点', event: '增加事件', stock: '增加股票' }[intent] || intent;
}

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
    record('quick_intent', {
        意图: intentLabel(intent),
        输入: raw,
        成功: !!(result && result.ok),
        回复: (result && result.text) || '',
    });
    chatInput.value = '';
    state.pendingImages = [];
    renderPastePreviews();
    const userMsg = { role: 'user', content: `【${intentLabel(intent)}】${raw}`, ts: Date.now(), uid: genUid('m') };
    state.chatMessages.push(userMsg);
    appendMessage('user', userMsg.content, userMsg);
    const reply = { role: 'assistant', content: result.text, ts: Date.now(), uid: genUid('m') };
    state.chatMessages.push(reply);
    appendMessage('assistant', reply.content, reply);
    trimChat();
    saveChat();
    updateIntentBubbles();
}

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
    if (!text && state.pendingImages.length === 0) return;
    if (state.generating) return;
    await reauthorizePendingInGesture();
    await ensureChat();
    state.followStream = true;
    scrollDownBtn.hidden = true;
    let content = text;
    let imageCount = 0;
    if (state.pendingImages.length > 0) {
        const parts = [];
        if (text) parts.push({ type: 'text', text });
        for (const img of state.pendingImages) {
            imageCount++;
            try {
                if (state.workspaceHandles.length) {
                    const dir = await readyRoot(state.workspaceHandles, '');
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
    const userEntry = { role: 'user', content, ts: Date.now(), uid: genUid('m') };
    appendMessage('user', content, userEntry);
    state.chatMessages.push(userEntry);
    trimChat();
    deferAutoTitleForVisionInput(content);
    saveChat();
    chatInput.value = '';
    state.pendingImages = [];
    renderPastePreviews();
    updateIntentBubbles();
    state.currentAssistantEl = null;
    setGenerating(true);
    if (imageCount > 0) appendMessage('system', imageCount + ' 张图片已作为视觉输入传给模型');
    try {
        // 把当前已加载工具组传入，避免新消息丢失之前加载的 market 等组
        await runAgentLoop(undefined, [...state.activeToolGroups]);
    } catch (err) {
        console.error('[thswc:ai] 循环异常:', err);
        appendMessage('error', '发生异常：' + err.message);
    } finally {
        setGenerating(false);
        chatInput.focus();
    }
}

function stopGeneration() {
    if (!state.generating) return;
    try {
        state.port.postMessage({ action: 'aiChatStop', requestId: state.currentRequestId });
    } catch { }
}

async function retryLast() {
    if (state.generating || !state.lastRequestSnapshot) return;
    if (state.lastFailUi) {
        if (state.lastFailUi.errorEl) state.lastFailUi.errorEl.remove();
        if (state.lastFailUi.actionWrap) state.lastFailUi.actionWrap.remove();
        if (state.lastFailUi.failEntry) {
            const i = state.chatMessages.indexOf(state.lastFailUi.failEntry);
            if (i !== -1) state.chatMessages.splice(i, 1);
        }
        state.lastFailUi = null;
        saveChat();
    }
    state.currentAssistantEl = null;
    setGenerating(true);
    record('retry', {
        快照消息数: state.lastRequestSnapshot.messages.length,
        工具组: (state.lastRequestSnapshot.toolGroups || []).join(',') || '无',
    });
    try {
        await runAgentLoop(
            state.lastRequestSnapshot.messages.slice(1).map(m => ({ ...m })),
            state.lastRequestSnapshot.toolGroups || [],
        );
    } catch (err) {
        appendMessage('error', '发生异常：' + err.message);
    } finally {
        setGenerating(false);
    }
}

async function continueGeneration() {
    if (state.generating) return;
    state.chatMessages.push({ role: 'user', content: '请继续', ts: Date.now(), uid: genUid('m') });
    trimChat();
    saveChat();
    appendMessage('user', '请继续', state.chatMessages[state.chatMessages.length - 1]);
    state.currentAssistantEl = null;
    setGenerating(true);
    try {
        await runAgentLoop();
    } catch (err) {
        appendMessage('error', '发生异常：' + err.message);
    } finally {
        setGenerating(false);
    }
}

// ============== 事件绑定 ==============

function bindEvents() {
    sendBtn.addEventListener('click', handleSend);
    chatInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            handleSend();
        }
    });
    intentBubbleEls.forEach(btn => {
        btn.addEventListener('click', () => handleIntentBubble(btn.dataset.intent));
    });
    stopBtn.addEventListener('click', stopGeneration);
    sessionSelect.addEventListener('change', () => switchSession(sessionSelect.value));
    newSessionBtn.addEventListener('click', createSession);
    renameSessionBtn.addEventListener('click', renameSession);
    deleteSessionBtn.addEventListener('click', deleteSession);
    clearChatBtn.addEventListener('click', clearSession);
    uploadBtn.addEventListener('click', () => {
        uploadInput.click();
    });
    uploadInput.addEventListener('change', async (e) => {
        const files = Array.from(e.target.files || []);
        e.target.value = '';
        if (!files.length) return;
        try {
            await reauthorizePendingInGesture();
            await handleUploadFiles(files);
        } catch (err) {
            console.error('[thswc:ai] 文件上传失败:', err);
            appendMessage('error', '文件上传失败：' + (err.message || err));
        }
    });
    bindPastePreview();
    openAiSettingsBtn.addEventListener('click', openSettings);
    closeAiSettingsBtn.addEventListener('click', closeSettings);
    bindProviderEvents();
    bindWorkspaceSetupEvents();
    bindBridgeSetupEvents();
    bindDebugButton((msg, ok) => appendMessage(ok ? 'system' : 'error', msg));
}

// ============== 初始化 ==============

async function init() {
    connectPort();
    bindDebugGlobals();
    await loadProviders();
    await loadBridgeSettings();
    await loadDebugFlag();
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'sync') return;
        if (changes.aiDebugMode) {
            Promise.resolve(applyRemoteDebugFlag(changes.aiDebugMode.newValue)).then(() => {
                if (aiDebugModeInput) aiDebugModeInput.checked = isDebugOn();
            });
        }
        if (changes.aiProviders || changes.aiActiveProviderId || changes.aiDefaultVisionProviderId) {
            loadProviders().then(() => {
                renderProviderSelect();
                fillProviderInputs();
                renderDefaultVisionProviderSelect();
            });
        }
        if (changes.bridgeEnabled) {
            state.bridgeEnabled = !!changes.bridgeEnabled.newValue;
            if (state.bridgeEnabled) {
                getBridgeHandle().then(h => { state.bridgeHandle = h; state.activeToolGroups.add('bridge'); renderBridgeDirStatus(); });
            } else {
                state.bridgeHandle = null;
                state.activeToolGroups.delete('bridge');
                renderBridgeDirStatus();
            }
        }
    });
    // The onChanged handler for aiProviders needs dynamic import of settings renders
    // We replace it above with a proper implementation
    await loadMemory();
    await ensureChat();
    beginDebugSession(state.currentChatId, 'init');
    renderHistory();
    renderSessionSelect();
    await refreshDirStatus();
    bindEvents();
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
