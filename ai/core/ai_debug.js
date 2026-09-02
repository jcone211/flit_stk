/**
 * ai_debug.js —— DEBUG 模式：会话全过程记录与一键复制
 *
 * 用途：优化与排错时，完整记录一个会话中发生的
 *      用户问题 / AI 回复 / 工具调用方法与传参 / 工具返回 / 报错信息 / 请求元信息，
 *      并允许点击头部「Debug信息」按钮把当前会话的全部记录复制到剪切板。
 *
 * 设计要点：
 *   1. 开关存 chrome.storage.sync（键 aiDebugMode），与 AI 设置面板「全局设置」中的复选框双向同步；
 *      记录内容存 chrome.storage.local（键 aiDebugLogs），按会话 id 分组，带容量上限，避免撑爆存储。
 *   2. 记录入口统一为 record(kind, data)；会连续重复的报错用 recordRepeat(kind, data)（同组合并，
 *      只留首条 + 一条滚动末条）；DOM 渲染回放（renderHistory）等场景用 withDebugMuted 抑制，
 *      防止把历史消息重新记一遍。
 *   3. 本模块只负责「记录 + 组织文本 + 写剪切板」，不直接渲染消息气泡；页面提示由调用方通过
 *      bindDebugButton(notify) 注入，保持与 ai.js 的单向依赖。
 */

import {
    state, storageGet, storageSet, dbg, debugInfoBtn,
} from './ai_state.js';

const DEBUG_FLAG_KEY = 'aiDebugMode';   // storage.sync：DEBUG 模式开关
const DEBUG_LOGS_KEY = 'aiDebugLogs';   // storage.local：各会话的记录

const MAX_EVENTS_PER_SESSION = 300;     // 单会话事件条数上限
const MAX_FIELD_CHARS = 4000;           // 单字段字符上限（超长截断）
const MAX_KEEP_SESSIONS = 8;            // 最多保留最近几个会话的记录
const MAX_PERSIST_CHARS = 6000000;      // 落库总量上限（字符数近似字节数）
const PERSIST_DEBOUNCE_MS = 800;        // 合并写入间隔
// 同类连续报错（如 SW 每 30s 断连重连）的折叠窗口：超过该间隔再出现视为新一轮，重新记首条
const REPEAT_COLLAPSE_WINDOW_MS = 120 * 1000;

const EVENT_LABELS = {
    session: '会话事件',
    user: '用户问题',
    assistant: 'AI 回复',
    request: '发起请求',
    response: '模型响应',
    request_error: '请求失败',
    tool_call: '工具调用',
    tool_result: '工具返回',
    reasoning: '思考过程',
    retry_stream: '非流式重试',
    evict: '上下文驱逐',
    quick_intent: '快捷意图',
    retry: '重试请求',
    error: '报错信息',
    window_error: '页面异常',
    clipboard: '复制DEBUG',
    system: '系统提示',
};

let flag = false;               // DEBUG 开关
let muted = false;              // 临时抑制记录（历史回放等）
let loaded = false;             // 是否已从 storage 载入
let logs = {};                  // chatId -> { id, startedAt, updatedAt, events: [] }
let seq = 0;                    // 全局自增序号
let persistTimer = null;
const deletedIds = new Set();   // 已删除会话，落库时需从存量中移除

// ============== 基础工具 ==============

function pad3(n) {
    return String(n).padStart(3, '0');
}

function fmtTs(ts) {
    const d = new Date(ts || Date.now());
    const p = (v, w = 2) => String(v).padStart(w, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
        + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/** 长文本截断，保留可读的头尾标记 */
function clip(text) {
    const s = String(text ?? '');
    if (s.length <= MAX_FIELD_CHARS) return s;
    return s.slice(0, MAX_FIELD_CHARS) + `\n…（已截断，原长 ${s.length} 字符）`;
}

/** 把 user/assistant 的 content（字符串或多模态 parts 数组）压成纯文本 */
export function flattenContent(content) {
    if (content == null) return '';
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) {
        try { return JSON.stringify(content); } catch { return String(content); }
    }
    return content.map(part => {
        if (part == null) return '';
        if (typeof part === 'string') return part;
        if (part.type === 'text') return part.text || '';
        if (part.type === 'image_url') {
            const url = String((part.image_url && part.image_url.url) || '');
            return url.startsWith('data:')
                ? `[图片：base64 内联，${url.length} 字符，已省略]`
                : `[图片：${url}]`;
        }
        try { return `[${part.type || 'part'}:${JSON.stringify(part)}]`; } catch { return ''; }
    }).filter(Boolean).join('\n');
}

/** 当前环境快照，用于排查「同样代码不同表现」类问题 */
function envSnapshot(chatId) {
    let version = '';
    try { version = chrome.runtime.getManifest().version; } catch { /* 非扩展环境忽略 */ }
    const provider = (state.providers || []).find(p => p.id === state.activeProviderId) || {};
    return {
        ext: version,
        会话: chatId || state.currentChatId || '',
        供应商: provider.name || '',
        模型: provider.model || '',
        baseUrl: provider.baseUrl || '',
        apiKey: provider.apiKey ? `已配置(${String(provider.apiKey).length} 位)` : '未配置',
        工具轮数上限: state.maxToolIterations,
        Agent桥接: state.bridgeEnabled ? '启用' : '关闭',
        工作目录: (state.workspaceHandles || []).map(h => h.name).join(',') || '未授权',
        主目录: state.workspaceRootPath || '未设置',
        桥接目录: state.bridgeDirFullPath || '未设置',
        已加载工具组: [...(state.activeToolGroups || [])].join(',') || '无',
        ua: navigator.userAgent,
    };
}

function ensureLog(chatId) {
    if (!logs[chatId]) {
        logs[chatId] = { id: chatId, startedAt: Date.now(), updatedAt: Date.now(), events: [] };
    }
    return logs[chatId];
}

function pruneOldest(obj) {
    const ids = Object.keys(obj).sort((a, b) => (obj[b].updatedAt || 0) - (obj[a].updatedAt || 0));
    for (const id of ids.slice(MAX_KEEP_SESSIONS)) delete obj[id];
}

/** 近似体积控制：超限时先丢最老的会话，仍超限则丢该会话最老的事件 */
function fitWithinBudget(obj) {
    pruneOldest(obj);
    const fits = () => {
        try { return JSON.stringify(obj).length <= MAX_PERSIST_CHARS; } catch { return false; }
    };
    const byOldest = () => Object.keys(obj).sort((a, b) => (obj[a].updatedAt || 0) - (obj[b].updatedAt || 0));
    while (!fits() && byOldest().length > 1) delete obj[byOldest()[0]];
    const only = obj[byOldest()[0]];
    while (only && Array.isArray(only.events) && !fits() && only.events.length > 1) {
        only.events = only.events.slice(Math.ceil(only.events.length / 2));
    }
    return obj;
}

/** 落库前先读最新存量再合并（本窗口拥有的会话以内存为准，其余保留），避免多窗口互相覆盖 */
async function persist() {
    if (!loaded) return;
    const mine = fitWithinBudget(logs);
    const res = await storageGet(chrome.storage.local, DEBUG_LOGS_KEY);
    const stored = res[DEBUG_LOGS_KEY];
    const merged = (stored && typeof stored === 'object') ? { ...stored } : {};
    for (const id of deletedIds) delete merged[id];
    for (const [id, log] of Object.entries(mine)) {
        if (!log || !Array.isArray(log.events) || log.events.length === 0) continue;
        const prev = merged[id];
        // 其他上下文写了更多更新的记录时不覆盖
        if (prev && Array.isArray(prev.events) && prev.updatedAt > log.updatedAt && prev.events.length > log.events.length) continue;
        merged[id] = log;
    }
    deletedIds.clear();
    await storageSet(chrome.storage.local, { [DEBUG_LOGS_KEY]: fitWithinBudget(merged) });
}

function schedulePersist() {
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
        persistTimer = null;
        persist().catch(err => console.warn('[thswc:ai] DEBUG 记录落库失败:', err));
    }, PERSIST_DEBOUNCE_MS);
}

/** 立即把待写入的 DEBUG 记录落库（关闭页面/复制前调用） */
export function flushDebugLogs() {
    if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
    return persist().catch(err => console.warn('[thswc:ai] DEBUG 记录落库失败:', err));
}

// ============== 开关 ==============

export function isDebugOn() {
    return flag === true;
}

/** 读取开关与历史记录（init 时调用一次） */
export async function loadDebugFlag() {
    const resSync = await storageGet(chrome.storage.sync, DEBUG_FLAG_KEY);
    flag = resSync[DEBUG_FLAG_KEY] === true;
    const resLocal = await storageGet(chrome.storage.local, DEBUG_LOGS_KEY);
    const stored = resLocal[DEBUG_LOGS_KEY];
    logs = (stored && typeof stored === 'object') ? stored : {};
    for (const log of Object.values(logs)) {
        if (!Array.isArray(log.events)) log.events = [];
    }
    loaded = true;
    syncDebugBtn();
    return flag;
}

/** 写入开关（设置面板复选框触发）；开启时立刻为当前会话建档 */
export async function setDebugFlag(on) {
    flag = !!on;
    await storageSet(chrome.storage.sync, { [DEBUG_FLAG_KEY]: flag });
    if (flag) record('session', { 说明: 'DEBUG 模式开启，从此处开始记录', ...flattenEnv(state.currentChatId) });
    else schedulePersist();
    syncDebugBtn();
    dbg('DEBUG 模式已' + (flag ? '开启' : '关闭'));
}

/** 其他窗口改了开关时同步本地状态（不回写 storage，避免互推） */
export async function applyRemoteDebugFlag(on) {
    const next = !!on;
    if (next === flag) { syncDebugBtn(); return; }
    flag = next;
    if (flag) record('session', { 说明: 'DEBUG 模式开启（设置变更同步）', ...flattenEnv(state.currentChatId) });
    else await flushDebugLogs();
    syncDebugBtn();
}

function flattenEnv(chatId) {
    const env = envSnapshot(chatId);
    const out = {};
    for (const [k, v] of Object.entries(env)) out[k] = String(v);
    return out;
}

// ============== 记录 ==============

/** 抑制记录执行一段同步代码（如渲染历史消息，避免重复入日志） */
export function withDebugMuted(fn) {
    const prev = muted;
    muted = true;
    try { return fn(); } finally { muted = prev; }
}

/** 由事件数据构造一条记录（含序号、时间与字段截断） */
function buildEvent(kind, data) {
    const evt = { seq: ++seq, ts: Date.now(), kind };
    for (const [k, v] of Object.entries(data || {})) {
        if (v === undefined || v === null) continue;
        evt[k] = typeof v === 'string' ? clip(v) : (typeof v === 'object' ? clip(safeStringify(v)) : v);
    }
    return evt;
}

/** 超出条数上限时丢弃最早的事件，并安排落库 */
function trimAndTouch(log) {
    if (log.events.length > MAX_EVENTS_PER_SESSION) {
        log.events.splice(0, log.events.length - MAX_EVENTS_PER_SESSION);
    }
    log.updatedAt = Date.now();
    schedulePersist();
}

/** 记录一条事件（DEBUG 未开启或处于抑制态时静默丢弃） */
export function record(kind, data, chatId) {
    if (!flag || muted) return;
    const id = chatId || state.currentChatId;
    if (!id) return;
    const log = ensureLog(id);
    log.events.push(buildEvent(kind, data));
    trimAndTouch(log);
}

/**
 * 记录「同类会重复」的日志（如 SW 断连重连报错）：连续重复只保留首条与末条。
 *
 * 规则（key = kind + text，同一 key 视为同一组）：
 *   1. 组内第 1 次 → 正常入队，作为「首条」不再改动；
 *   2. 组内第 2 次 → 追加一条「滚动末条」（带 连续重复=2、首次发生=首条时间）；
 *   3. 组内第 N 次 → 就地把滚动末条刷新并移到末尾（时间/字段取最新，连续重复+1），
 *      因此长期挂机反复断连也只占两条记录，末条始终是最后一次；
 *   4. 距上一次同类超过 REPEAT_COLLAPSE_WINDOW_MS → 视为新的一组，重新记首条。
 * 内部标识 __rk（同类 key）、__roll（是否滚动末条）、__n / __firstTs 不参与报告输出。
 */
export function recordRepeat(kind, data, chatId) {
    if (!flag || muted) return;
    const id = chatId || state.currentChatId;
    if (!id) return;
    const log = ensureLog(id);
    const key = kind + '|' + String((data && data.text) ?? '');
    const now = Date.now();
    const events = log.events;
    // 从末尾回溯，找窗口内最近一条同类事件（滚动末条总在末尾附近，命中即停）
    let prev = null;
    for (let i = events.length - 1; i >= 0; i--) {
        const e = events[i];
        if (now - Number(e.ts || 0) > REPEAT_COLLAPSE_WINDOW_MS) break;
        if (e.__rk === key) { prev = e; break; }
    }
    if (prev && prev.__roll) {
        const idx = events.indexOf(prev);
        if (idx >= 0) events.splice(idx, 1);          // 末条滚动：撤下旧的，重新追加到末尾
        const evt = buildEvent(kind, data);
        evt.__rk = key;
        evt.__roll = true;
        evt.__n = Number(prev.__n || 2) + 1;
        evt.__firstTs = prev.__firstTs || prev.ts;
        evt.连续重复 = evt.__n;
        evt.首次发生 = fmtTs(evt.__firstTs);
        events.push(evt);
    } else if (prev) {
        const evt = buildEvent(kind, data);
        evt.__rk = key;
        evt.__roll = true;
        evt.__n = 2;
        evt.__firstTs = prev.ts;
        evt.连续重复 = 2;
        evt.首次发生 = fmtTs(prev.ts);
        events.push(evt);
    } else {
        const evt = buildEvent(kind, data);
        evt.__rk = key;
        events.push(evt);
    }
    trimAndTouch(log);
}

function safeStringify(v) {
    try { return JSON.stringify(v); } catch { return String(v); }
}

/**
 * 消息气泡记录入口（ai.js 的 appendMessage 调用）
 * 流式回复的空气泡会被跳过，最终文本由 commitAssistant 记录，避免重复。
 */
export function recordMessage(role, content) {
    if (!flag || muted) return;
    const kind = { user: 'user', assistant: 'assistant', error: 'error', system: 'system' }[role];
    if (!kind) return;
    const text = flattenContent(content);
    if (!text) return;
    record(kind, { text });
}

/** 新会话/切换会话/初始化时的建档事件（reason 说明触发来源） */
export function beginDebugSession(chatId, reason = 'open') {
    syncDebugBtn();
    if (!flag || !chatId) return;
    const notes = {
        new: '新建会话',
        switch: '切换到已有会话',
        init: '打开 AI 助手窗口，继续该会话',
        open: '进入会话',
    };
    record('session', { 说明: notes[reason] || reason, ...flattenEnv(chatId) }, chatId);
    schedulePersist();
}

/** 删除/清空会话时同步清理其 DEBUG 记录 */
export function dropDebugSession(chatId) {
    const id = chatId || state.currentChatId;
    if (!id) return;
    if (logs[id]) delete logs[id];
    deletedIds.add(id);
    schedulePersist();
}

/** 按钮显隐：DEBUG 开启时可见 */
export function syncDebugBtn() {
    if (debugInfoBtn) debugInfoBtn.hidden = !flag;
}

// ============== 报告文本 ==============

function formatEvent(e) {
    const label = EVENT_LABELS[e.kind] || e.kind;
    const lines = [`[${pad3(e.seq)}] ${fmtTs(e.ts)}  ${label}${e.name ? ' · ' + e.name : ''}`];
    const skip = new Set(['seq', 'ts', 'kind', 'name', 'text']);
    for (const [k, v] of Object.entries(e)) {
        if (skip.has(k) || k.startsWith('__') || v === '') continue;
        lines.push(`  ${k}: ${v}`);
    }
    if (typeof e.text === 'string' && e.text) {
        lines.push('  |');
        for (const line of e.text.split('\n')) lines.push('  | ' + line);
    }
    return lines.join('\n');
}

/** 生成当前会话的 DEBUG 报告（纯文本，可直接粘进 issue / 聊天窗口） */
export function buildDebugReport(chatId) {
    const id = chatId || state.currentChatId || '';
    const log = logs[id];
    const events = (log && log.events) || [];
    const session = state.sessions[id];
    const env = envSnapshot(id);
    const lines = [];
    lines.push('========== flit_stk AI 助手 · DEBUG 日志 ==========');
    lines.push(`会话ID: ${id || '(未知)'}`);
    lines.push(`会话名称: ${session && session.title || '(未命名)'}`);
    lines.push(`导出时间: ${fmtTs(Date.now())}`);
    lines.push(`记录开始: ${log ? fmtTs(log.startedAt) : '(无记录)'}`);
    lines.push(`事件条数: ${events.length}${events.length >= MAX_EVENTS_PER_SESSION ? `（已达上限 ${MAX_EVENTS_PER_SESSION}，更早的事件已被丢弃）` : ''}`);
    lines.push(`环境: 扩展 v${env.ext} | 模型 ${env.模型 || '-'} @ ${env.baseUrl || '-'} | 工具轮数上限 ${env.工具轮数上限}`);
    lines.push(`      供应商「${env.供应商 || '-'}」 APIKey ${env.apiKey} | Agent桥接 ${env.Agent桥接} | 工具组 ${env.已加载工具组}`);
    lines.push(`      工作目录 ${env.工作目录} | 主目录 ${env.主目录} | 桥接目录 ${env.桥接目录}`);
    lines.push('---------------------------------------------------');
    if (!events.length) {
        lines.push('（本会话暂无 DEBUG 记录：可能 DEBUG 模式刚开启、会话已被清理，或超出容量上限被裁剪）');
    }
    for (const e of events) lines.push(formatEvent(e));
    lines.push('========== DEBUG 日志结束 ==========');
    return lines.join('\n');
}

/** 复制文本到剪切板（clipboard API 失败时降级 execCommand） */
export async function copyTextToClipboard(text) {
    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch (err) {
        dbg('clipboard.writeText 失败，降级 execCommand:', err);
    }
    try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        ta.setSelectionRange(0, ta.value.length);
        const ok = document.execCommand('copy');
        ta.remove();
        return !!ok;
    } catch (err) {
        console.warn('[thswc:ai] 降级复制失败:', err);
        return false;
    }
}

/** 生成并复制当前会话 DEBUG 报告，返回结果供 UI 提示 */
export async function copyDebugReport(chatId) {
    await flushDebugLogs();
    const id = chatId || state.currentChatId || '';
    const text = buildDebugReport(id);
    const ok = await copyTextToClipboard(text);
    const count = ((logs[id] && logs[id].events) || []).length;
    record('clipboard', { 结果: ok ? '成功' : '失败（浏览器拒绝剪切板访问）', 事件条数: String(count), 字符数: String(text.length) });
    return { ok, count, chars: text.length };
}

/** 绑定头部「Debug信息」按钮；notify 由 ai.js 注入，用于把结果提示到消息流 */
export function bindDebugButton(notify) {
    if (!debugInfoBtn || debugInfoBtn.dataset.bound === '1') return;
    debugInfoBtn.dataset.bound = '1';
    const original = debugInfoBtn.textContent;
    debugInfoBtn.addEventListener('click', async () => {
        debugInfoBtn.disabled = true;
        try {
            const res = await copyDebugReport();
            debugInfoBtn.textContent = res.ok ? '已复制 ✓' : '复制失败';
            withDebugMuted(() => notify(
                res.ok
                    ? `本会话 DEBUG 信息已复制到剪切板（${res.count} 条事件，约 ${res.chars} 字符）`
                    : 'DEBUG 信息复制失败：浏览器拒绝了剪切板写入，可重试或在设置中关闭后重开 DEBUG 模式',
                res.ok,
            ));
        } catch (err) {
            debugInfoBtn.textContent = '复制失败';
            withDebugMuted(() => notify('DEBUG 信息复制异常：' + (err && err.message || err), false));
        } finally {
            debugInfoBtn.disabled = false;
            setTimeout(() => { debugInfoBtn.textContent = original; }, 2000);
        }
    });
    syncDebugBtn();
}

/** 全局异常兜底记录 + 关闭页面前落库 */
export function bindDebugGlobals() {
    window.addEventListener('error', (event) => {
        record('window_error', {
            text: String(event.message || ''),
            文件: String(event.filename || ''),
            位置: `${event.lineno || 0}:${event.colno || 0}`,
            堆栈: event.error && event.error.stack ? String(event.error.stack) : '',
        });
    });
    window.addEventListener('unhandledrejection', (event) => {
        const reason = event.reason;
        record('window_error', {
            text: 'Promise 未捕获异常：' + (reason && reason.message || reason || ''),
            堆栈: reason && reason.stack ? String(reason.stack) : '',
        });
    });
    window.addEventListener('pagehide', () => { flushDebugLogs(); });
}
