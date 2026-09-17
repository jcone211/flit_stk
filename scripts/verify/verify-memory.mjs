// verify-memory.mjs —— 记忆分区机制专项验证（临时用例，跑完即删）
// 覆盖：未指定工作目录读/写 aiMemory；已指定工作目录读/写 flit/memory.md；
//       一次性迁移 aiMemory 旧记忆；多行记忆解析；Agent 直接改 memory.md 后自动注入。
import path from 'node:path';
import fsSync from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
const REPO = process.cwd();
const AI_TOOLS = pathToFileURL(path.join(REPO, 'ai/core/ai_tools.js')).href;
const AI_STATE = pathToFileURL(path.join(REPO, 'ai/core/ai_state.js')).href;

const el = () => ({ style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, value: '', textContent: '', innerHTML: '', addEventListener() {}, removeEventListener() {}, appendChild() {}, remove() {}, setAttribute() {}, getAttribute: () => null, querySelector: () => el(), querySelectorAll: () => [], closest: () => null, getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0 }) });
globalThis.document = { getElementById: () => el(), querySelector: () => el(), querySelectorAll: () => [], createElement: () => el(), createTextNode: () => el(), addEventListener() {}, removeEventListener() {}, body: el(), head: el(), documentElement: el(), hidden: false, visibilityState: 'visible', activeElement: el() };
globalThis.window = globalThis;
globalThis.self = globalThis;
if (!globalThis.navigator) globalThis.navigator = { userAgent: 'node-verify', clipboard: { writeText: async () => {} } };
globalThis.addEventListener = () => {};
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };

const store = { local: {}, sync: {}, session: {} };
const storageArea = (name) => ({
    async get(keys, cb) { const list = Array.isArray(keys) ? keys : (typeof keys === 'string' ? [keys] : Object.keys(store[name])); const out = {}; for (const k of list) if (k in store[name]) out[k] = structuredClone(store[name][k]); if (typeof cb === 'function') { cb(out); return; } return out; },
    async set(obj, cb) { Object.assign(store[name], structuredClone(obj)); if (cb) cb(); },
    async remove(keys, cb) { for (const k of (Array.isArray(keys) ? keys : [keys])) delete store[name][k]; if (cb) cb(); },
    async clear(cb) { store[name] = {}; if (cb) cb(); },
    getBytesInUse(cb) { if (cb) cb(0); },
});
globalThis.chrome = {
    storage: { local: storageArea('local'), sync: storageArea('sync'), session: storageArea('session'), managed: storageArea('session'), onChanged: { addListener() {}, removeListener() {} } },
    runtime: { id: 'verify-script', getURL: (p) => 'chrome-extension://verify/' + p, lastError: null, sendMessage: async () => {}, connect: () => ({ name: '', onMessage: { addListener() {} }, onDisconnect: { addListener() {} }, postMessage() {} }), getManifest: () => ({ version: 'verify' }) },
    alarms: { create() {}, clear() {}, clearAll: async () => true, onAlarm: { addListener() {} } },
    tabs: { query: async () => [], create: async () => ({}), update: async () => ({}), remove: async () => {}, onUpdated: { addListener() {} }, onRemoved: { addListener() {} } },
    windows: { create: async () => ({}), get: async () => ({}), update: async () => ({}), onRemoved: { addListener() {} } },
    notifications: { create() {}, clear() {}, onClicked: { addListener() {} } },
    action: { onClicked: { addListener() {} } }, scripting: { executeScript: async () => [] },
};
globalThis.fetch = async () => { throw new Error('记忆验证不应联网'); };

// ---- 假 DirectoryHandle（支持真实文件读写）----
function domErr(name, message) { const e = new Error(message); e.name = name; return e; }
function fileHandle(p, name) {
    return { kind: 'file', name,
        async getFile() { const buf = await fsp.readFile(p); return { name, size: buf.byteLength, type: '', async arrayBuffer() { return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength); }, async text() { return buf.toString('utf8'); } }; },
        async createWritable() { let data = ''; return { async write(content) { data = String(content ?? ''); }, async close() { await fsp.writeFile(p, data); } }; },
    };
}
function dirHandle(abs, name) {
    return { kind: 'directory', name,
        async getDirectoryHandle(seg, { create = false } = {}) { const p = path.join(abs, seg); if (create) await fsp.mkdir(p, { recursive: true }); else if (!fsSync.existsSync(p)) throw domErr('NotFoundError', 'no dir ' + p); return dirHandle(p, seg); },
        async getFileHandle(seg, { create = false } = {}) { const p = path.join(abs, seg); if (!create && !fsSync.existsSync(p)) throw domErr('NotFoundError', 'no file ' + p); return fileHandle(p, seg); },
        async removeEntry() {}, async queryPermission() { return 'granted'; }, async requestPermission() { return 'granted'; },
        async *entries() {},
    };
}

let failures = 0;
const results = [];
function check(label, ok, detail) { results.push({ label, ok: !!ok, detail }); if (!ok) failures++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' → ' + detail : ''}`); }

const { state, MEMORY_KEY } = await import(AI_STATE);
const ai = await import(AI_TOOLS);
async function reset(opts = {}) {
    await chrome.storage.local.clear();
    await chrome.storage.sync.clear();
    state.memoryItems = [];
    state.bridgeEnabled = !!opts.bridge;
    state.workspaceHandles = opts.workspace ? [{ name: 'memtest', handle: dirHandle(opts.workspace, 'memtest') }] : [];
}
const memFile = (ws) => path.join(ws, 'flit', 'memory.md');

// ============ A. 未指定工作目录：读/写 aiMemory ============
{
    const ws = await fsp.mkdtemp(path.join(os.tmpdir(), 'flit-mem-'));
    await reset();
    await ai.addMemory('alpha-偏好');
    check('A1 无工作目录 addMemory 落扩展 aiMemory', store.local['aiMemory'] && store.local['aiMemory'].items.length === 1, JSON.stringify(store.local['aiMemory']));
    check('A2 无工作目录不触碰 memory.md', !fsSync.existsSync(memFile(ws)));
    await ai.loadMemory();
    check('A3 无工作目录 loadMemory 读回 aiMemory', state.memoryItems.length === 1 && state.memoryItems[0].content === 'alpha-偏好', JSON.stringify(state.memoryItems));
    await fsp.rm(ws, { recursive: true, force: true });
}

// ============ B. 已指定工作目录 + aiMemory 有旧记忆：一次性迁移到 memory.md ============
{
    const ws = await fsp.mkdtemp(path.join(os.tmpdir(), 'flit-mem-'));
    await fsp.mkdir(path.join(ws, 'flit'), { recursive: true });
    await fsp.writeFile(memFile(ws), '# 工作区记忆\n\n## 数据库连接状态\n\n- status: verified\n\n', 'utf8');
    await reset({ workspace: ws, bridge: true });
    await chrome.storage.local.set({ aiMemory: { items: [{ id: 'x', content: 'Linux 排查命令', ts: 1 }], updatedAt: 1 } });
    await ai.loadMemory();
    const md = await fsp.readFile(memFile(ws), 'utf8');
    check('B1 迁移：memory.md 出现「AI 长期记忆」段', /## AI 长期记忆/.test(md) && /- Linux 排查命令/.test(md), md.split('\n').slice(0, 12).join(' | '));
    check('B2 迁移后 state.memoryItems 有旧记忆', state.memoryItems.length === 1 && state.memoryItems[0].content === 'Linux 排查命令', JSON.stringify(state.memoryItems));
    check('B3 迁移保留 aiMemory（不删）', store.local['aiMemory'] && store.local['aiMemory'].items.length === 1);
    await ai.loadMemory();
    const md2 = await fsp.readFile(memFile(ws), 'utf8');
    check('B4 重复 loadMemory 不重复迁移', (md2.match(/- Linux 排查命令/g) || []).length === 1, md2);
    await fsp.rm(ws, { recursive: true, force: true });
}

// ============ C. 已指定工作目录：addMemory 写 memory.md、不写 aiMemory ============
{
    const ws = await fsp.mkdtemp(path.join(os.tmpdir(), 'flit-mem-'));
    await fsp.mkdir(path.join(ws, 'flit'), { recursive: true });
    await fsp.writeFile(memFile(ws), '# 工作区记忆\n\n## 数据库连接状态\n\n- status: verified\n\n## AI 长期记忆\n\n- 已有条目\n', 'utf8');
    await reset({ workspace: ws, bridge: false });
    await ai.loadMemory();
    const r = await ai.addMemory('beta-新记');
    check('C1 addMemory 返回 store=memory.md', r.ok === true && r.store === 'memory.md' && r.mirrored === true, JSON.stringify(r));
    const md = await fsp.readFile(memFile(ws), 'utf8');
    check('C2 memory.md 含新旧两条', /已有条目/.test(md) && /beta-新记/.test(md), md);
    check('C3 aiMemory 未被写入（仍为空）', !store.local['aiMemory'], JSON.stringify(store.local['aiMemory']));
    await ai.loadMemory();
    check('C4 loadMemory 读回 2 条', state.memoryItems.length === 2 && state.memoryItems[1].content === 'beta-新记', JSON.stringify(state.memoryItems));
    await fsp.rm(ws, { recursive: true, force: true });
}

// ============ D. 多行记忆解析（续行合并进同一条） ============
{
    const ws = await fsp.mkdtemp(path.join(os.tmpdir(), 'flit-mem-'));
    await fsp.mkdir(path.join(ws, 'flit'), { recursive: true });
    await fsp.writeFile(memFile(ws), '## AI 长期记忆\n\n- 第一条\n续行内容\n- 第二条\n', 'utf8');
    await reset({ workspace: ws, bridge: false });
    await ai.loadMemory();
    check('D1 续行合并进同一条', state.memoryItems.length === 2 && state.memoryItems[0].content === '第一条\n续行内容', JSON.stringify(state.memoryItems));
    await fsp.rm(ws, { recursive: true, force: true });
}

// ============ E. Agent 直接用 write_file/append_file 改 memory.md 后自动注入 ============
{
    const ws = await fsp.mkdtemp(path.join(os.tmpdir(), 'flit-mem-'));
    await fsp.mkdir(path.join(ws, 'flit'), { recursive: true });
    await fsp.writeFile(memFile(ws), '## AI 长期记忆\n\n- 原始\n', 'utf8');
    await reset({ workspace: ws, bridge: true });
    await ai.loadMemory();
    await fsp.appendFile(memFile(ws), '- Agent 直接补的新记忆\n', 'utf8');
    await ai.loadMemory();
    const p = ai.buildSystemPrompt();
    const content = String((p && p.content) || p);
    check('E1 Agent 直接改文件后 loadMemory 读到新条目', state.memoryItems.some(m => m.content === 'Agent 直接补的新记忆'), JSON.stringify(state.memoryItems));
    check('E2 系统提示 [长期记忆] 注入该记忆', /Agent 直接补的新记忆/.test(content));
    await fsp.rm(ws, { recursive: true, force: true });
}

// ============ F. buildSystemPrompt 记忆维护引导文案（三态） ============
{
    await reset();
    const p0 = ai.buildSystemPrompt();
    check('F1 无工作目录：提示保存到扩展本地', /尚未设置工作目录/.test(String(p0.content)) && /save_memory/.test(String(p0.content)));
    await reset({ workspace: await fsp.mkdtemp(path.join(os.tmpdir(), 'flit-mem-')), bridge: false });
    const p1 = ai.buildSystemPrompt();
    check('F2 有工作目录（未开桥接）：自动读写 memory.md 的 AI 长期记忆段', /工作目录已设置：长期记忆自动读写工作区 flit\/memory\.md/.test(String(p1.content)));
    state.bridgeEnabled = true;
    const p2 = ai.buildSystemPrompt();
    check('F3 有工作目录+桥接：直接 write_file/append_file 改段，不用记忆工具追加', /不要调用 save_memory 或 record_workspace_memory 追加/.test(String(p2.content)), String(p2.content).match(/\[长期记忆存储\][^\n]*/)?.[0]);
}

console.log(`\n记忆机制验证结果：${results.length} 项，失败 ${failures}`);
process.exitCode = failures ? 1 : 0;
