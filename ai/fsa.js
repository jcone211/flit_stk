// fsa.js —— File System Access API 封装（AI 窗口页面模块）：
// 支持多个工作目录根（主目录 + 附加目录），DirectoryHandle 列表持久化到 IndexedDB
// （chrome.storage 不能存非 JSON 对象）。浏览器重启后权限回到 'prompt'，
// 须由用户点击状态条按钮（用户手势）内 requestPermission 重新授权。
//
// 平台限制：Chrome 出于安全考虑不跟随符号链接/软链接/junction（Chromium
// kFileSystemAccessSymbolicLinkCheck 检查）——工作目录内的软链接无法直接读取。
// 解决办法：把软链接指向的真实目录用「添加目录」授权为附加根，
// 工具以 root 参数（目录名）寻址，效果等同读取软链接内容。
//
// 所有路径均为相对所选目录根，过滤 . / .. / 空段防目录穿越。

const DB_NAME = 'thswc-ai-fsa';
const DB_VERSION = 1;
const STORE_NAME = 'handles';
const HANDLE_KEY = 'workspaceDirs';
const LEGACY_HANDLE_KEY = 'workspaceDir'; // 旧版单目录记录（迁移用）

// ---------------- IndexedDB 原生封装（无依赖） ----------------
function openDb() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            if (!req.result.objectStoreNames.contains(STORE_NAME)) {
                req.result.createObjectStore(STORE_NAME, { keyPath: 'name' });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function idbGet(key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        tx.oncomplete = () => db.close();
    });
}

async function idbPut(record) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put(record);
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); reject(tx.error); };
    });
}

// ---------------- 授权与 handle 管理 ----------------

// 读取全部工作目录 [{ name, handle }]（主目录在首位）；兼容旧版单目录记录迁移
export async function getWorkspaceHandles() {
    const record = await idbGet(HANDLE_KEY);
    if (record && Array.isArray(record.items)) return record.items;
    const legacy = await idbGet(LEGACY_HANDLE_KEY);
    if (legacy && legacy.handle) {
        const items = [{ name: legacy.handle.name, handle: legacy.handle }];
        await idbPut({ name: HANDLE_KEY, items });
        return items;
    }
    return [];
}

async function saveWorkspaceHandles(items) {
    await idbPut({ name: HANDLE_KEY, items });
}

function requirePicker() {
    if (!window.showDirectoryPicker) {
        throw new Error('当前浏览器不支持 File System Access API');
    }
}

// 选择主工作目录（替换首位；与现有主目录同名则原地替换 handle）
export async function pickPrimaryWorkspace() {
    requirePicker();
    const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    const items = await getWorkspaceHandles();
    if (items.length > 0 && items[0].name === handle.name) {
        items[0].handle = handle;
    } else {
        items.unshift({ name: handle.name, handle });
    }
    await saveWorkspaceHandles(items);
    return handle;
}

// 添加附加目录（与已有同名则替换 handle）；无主目录时等价于选择主目录
export async function addWorkspaceDir() {
    requirePicker();
    const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    const items = await getWorkspaceHandles();
    const idx = items.findIndex(d => d.name === handle.name);
    if (idx >= 0) {
        items[idx].handle = handle;
    } else {
        items.push({ name: handle.name, handle });
    }
    await saveWorkspaceHandles(items);
    return handle;
}

// 移除附加目录（主目录不可移除，请「更换」）
export async function removeWorkspaceDir(name) {
    const items = await getWorkspaceHandles();
    const idx = items.findIndex(d => d.name === name);
    if (idx < 0) throw new Error('未找到该目录');
    if (idx === 0) throw new Error('主目录不可移除，请使用「更换」');
    items.splice(idx, 1);
    await saveWorkspaceHandles(items);
}

// 目录权限状态：'granted' | 'prompt' | 'denied'；无 handle 返回 null
export async function workspacePermission(handle) {
    if (!handle) return null;
    try {
        return await handle.queryPermission({ mode: 'readwrite' });
    } catch {
        return null;
    }
}

// 重新授权（queryPermission 为 'prompt' 时，须在用户手势中调用）
export async function reauthorizeWorkspace(handle) {
    return handle.requestPermission({ mode: 'readwrite' });
}

// 按目录名解析已授权目录并校验权限；rootName 空/缺省 → 主目录。
// 权限未授予时抛出可操作错误（作为 tool 结果回传，模型会转述给用户）
export async function readyRoot(handles, rootName) {
    if (!handles || handles.length === 0) {
        throw new Error('工作目录未授权，请先在窗口顶部点击「选择目录」授权');
    }
    let dir;
    if (!rootName) {
        dir = handles[0];
    } else {
        dir = handles.find(d => d.name === String(rootName));
        if (!dir) {
            const names = handles.map(d => d.name).join('、');
            throw new Error('未找到名为「' + rootName + '」的工作目录，已授权目录：' + names);
        }
    }
    const perm = await workspacePermission(dir.handle);
    if (perm !== 'granted') {
        throw new Error('工作目录「' + dir.name + '」权限已失效——再次点击「发送」会自动弹出授权框，点击允许即可（也可点击窗口顶部按钮重新授权）');
    }
    return dir;
}

// ---------------- 路径解析 ----------------

// 规范化相对路径：过滤 . / .. / 空段（防穿越），返回路径段数组
function normalizeSegments(relPath) {
    return String(relPath || '').split(/[\\/]+/).filter(s => s && s !== '.' && s !== '..');
}

// 定位目录：每段均为目录，create=true 时逐级创建
async function resolveDir(rootHandle, relPath, create = false) {
    let current = rootHandle;
    for (const seg of normalizeSegments(relPath)) {
        current = await current.getDirectoryHandle(seg, { create });
    }
    return current;
}

// 定位文件：末段为文件，create=true 时创建中间目录与文件
async function resolveFile(rootHandle, relPath, create = false) {
    const segments = normalizeSegments(relPath);
    if (segments.length === 0) throw new Error('文件路径不能为空');
    let current = rootHandle;
    for (let i = 0; i < segments.length - 1; i++) {
        current = await current.getDirectoryHandle(segments[i], { create: true });
    }
    return current.getFileHandle(segments[segments.length - 1], { create });
}

// ---------------- 文件操作（供 tool 执行器调用） ----------------

// 列出目录内容：[{ name, type: 'dir'|'file' }]，按名称排序。
// 软链接条目会被 Chrome 拒绝访问，逐条容错并标记为 link（不可读）
export async function listDir(rootHandle, relPath = '') {
    const dir = await resolveDir(rootHandle, relPath);
    const entries = [];
    for await (const [name, handle] of dir.entries()) {
        entries.push({ name, type: handle.kind === 'directory' ? 'dir' : 'file' });
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    return entries;
}

// 读取文本文件：默认截断 20000 字符并附截断标记（二进制文件读为乱码，属预期，工具说明已注明仅文本）
export async function readFile(rootHandle, relPath, maxChars = 20000) {
    const fileHandle = await resolveFile(rootHandle, relPath);
    const file = await fileHandle.getFile();
    const text = await file.text();
    const truncated = text.length > maxChars;
    return { path: relPath, content: text.slice(0, maxChars), truncated, size: file.size };
}

// 读取二进制文件（供 parquet 等二进制解析器使用）
export async function readFileBinary(rootHandle, relPath) {
    const fileHandle = await resolveFile(rootHandle, relPath);
    const file = await fileHandle.getFile();
    return { path: relPath, buffer: await file.arrayBuffer(), size: file.size };
}

// 覆盖写文本文件
export async function writeFile(rootHandle, relPath, content) {
    const fileHandle = await resolveFile(rootHandle, relPath, true);
    const writable = await fileHandle.createWritable();
    await writable.write(String(content ?? ''));
    await writable.close();
    return { path: relPath, written: String(content ?? '').length };
}

// 上传文件：把浏览器 File 对象以二进制安全方式（流式）写入工作目录
export async function writeUpload(rootHandle, relPath, file) {
    const fileHandle = await resolveFile(rootHandle, relPath, true);
    const writable = await fileHandle.createWritable();
    await writable.write(file); // File 对象流式拷贝，二进制安全
    await writable.close();
    return { path: relPath, size: file.size };
}

// 追加写：MVP 实现为「读全量 + 拼接 + 重写」（工作区文件通常较小；
// 可优化为 open writable 后 seek 到 EOF 追加）
export async function appendFile(rootHandle, relPath, content) {
    let existing = '';
    try {
        existing = (await readFile(rootHandle, relPath, Infinity)).content;
    } catch {
        // 文件不存在则从空开始
    }
    return writeFile(rootHandle, relPath, existing + String(content ?? ''));
}
