// ai_settings.js —— AI 设置（供应商配置 / Agent 桥接 / 工作目录状态条）

import {
    state, storageGet, storageSet,
    dbg, DEFAULT_AI_BASE_URL, DEFAULT_AI_MODEL, DEFAULT_MAX_TOOL_ITERATIONS,
    aiProviderSelect, aiProviderAddBtn, aiProviderDelBtn,
    aiProviderNameInput, aiBaseUrlInput, aiApiKeyInput, aiModelInput,
    aiModelContext1MInput,
    aiSupportsVisionInput, aiMaxToolIterationsInput,
    aiDisableThinkingInput,
    aiDefaultVisionProviderSelect, aiSettingsOverlay, closeAiSettingsBtn,
    dirStatusBar, openAiSettingsBtn, uploadBtn, aiDebugModeInput,
} from './ai_state.js';
import {
    isDebugOn, setDebugFlag,
} from './ai_debug.js';
import {
    getWorkspaceHandles, pickPrimaryWorkspace, addWorkspaceDir, removeWorkspaceDir,
    workspacePermission, reauthorizeWorkspace,
    getBridgeHandle, pickBridgeDirectory, writeFile,
} from './fsa.js';

// ============== 供应商配置 ==============

function defaultProvider(name) {
    return {
        id: 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
        name: name || '默认', baseUrl: DEFAULT_AI_BASE_URL, apiKey: '', model: DEFAULT_AI_MODEL,
        supportsVision: false,
        disableThinking: false,
        context1M: true,
    };
}

function normalizeProvider(provider) {
    return {
        ...provider,
        supportsVision: provider.supportsVision === true,
        disableThinking: provider.disableThinking === true,
        // 旧数据没有该字段视为支持 1M 上下文（默认）
        context1M: provider.context1M !== false,
    };
}

function clampToolIterations(v) {
    const n = parseInt(v, 10);
    // 无上限：默认 50，只保底正整数（非法或 <1 回退默认）
    if (!Number.isFinite(n) || n < 1) return DEFAULT_MAX_TOOL_ITERATIONS;
    return n;
}

export async function loadProviders() {
    const res = await storageGet(chrome.storage.sync, ['aiProviders', 'aiActiveProviderId', 'aiDefaultVisionProviderId', 'aiBaseUrl', 'aiApiKey', 'aiModel', 'aiMaxToolIterations']);
    state.maxToolIterations = clampToolIterations(res.aiMaxToolIterations);
    state.defaultVisionProviderId = typeof res.aiDefaultVisionProviderId === 'string' ? res.aiDefaultVisionProviderId : '';
    if (Array.isArray(res.aiProviders) && res.aiProviders.length > 0) {
        state.providers = res.aiProviders.map(normalizeProvider);
        state.activeProviderId = state.providers.some(p => p.id === res.aiActiveProviderId) ? res.aiActiveProviderId : state.providers[0].id;
    } else if (res.aiBaseUrl || res.aiApiKey || res.aiModel) {
        state.providers = [normalizeProvider({ id: 'p_default', name: '默认', baseUrl: res.aiBaseUrl || DEFAULT_AI_BASE_URL, apiKey: res.aiApiKey || '', model: res.aiModel || DEFAULT_AI_MODEL })];
        state.activeProviderId = 'p_default';
        await storageSet(chrome.storage.sync, { aiProviders: state.providers, aiActiveProviderId: state.activeProviderId });
    } else {
        state.providers = [defaultProvider('默认')];
        state.activeProviderId = state.providers[0].id;
        await storageSet(chrome.storage.sync, { aiProviders: state.providers, aiActiveProviderId: state.activeProviderId });
    }
}

export function activeProvider() {
    return state.providers.find(p => p.id === state.activeProviderId) || state.providers[0] || defaultProvider();
}

async function persistProviders() {
    await storageSet(chrome.storage.sync, {
        aiProviders: state.providers,
        aiActiveProviderId: state.activeProviderId,
        aiDefaultVisionProviderId: state.defaultVisionProviderId,
    });
}

export function renderProviderSelect() {
    aiProviderSelect.innerHTML = '';
    for (const p of state.providers) {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.name || '未命名';
        aiProviderSelect.appendChild(opt);
    }
    aiProviderSelect.value = state.activeProviderId;
}

export function renderDefaultVisionProviderSelect() {
    aiDefaultVisionProviderSelect.innerHTML = '';
    const none = document.createElement('option');
    none.value = '';
    none.textContent = '自动选择第一份支持视觉的配置';
    aiDefaultVisionProviderSelect.appendChild(none);
    for (const provider of state.providers) {
        if (!provider.supportsVision) continue;
        const opt = document.createElement('option');
        opt.value = provider.id;
        opt.textContent = `${provider.name || '未命名'}（${provider.model || '未配置模型'}）`;
        aiDefaultVisionProviderSelect.appendChild(opt);
    }
    if (!state.providers.some(provider => provider.id === state.defaultVisionProviderId && provider.supportsVision)) {
        if (state.defaultVisionProviderId !== '') {
            state.defaultVisionProviderId = '';
            persistProviders().catch(() => { });
        }
    }
    aiDefaultVisionProviderSelect.value = state.defaultVisionProviderId;
}

export function fillProviderInputs() {
    const p = activeProvider();
    if (!p) return;
    aiProviderNameInput.value = p.name || '';
    aiBaseUrlInput.value = p.baseUrl || '';
    aiApiKeyInput.value = p.apiKey || '';
    aiModelInput.value = p.model || '';
    aiSupportsVisionInput.checked = p.supportsVision === true;
    if (aiModelContext1MInput) aiModelContext1MInput.checked = p.context1M !== false;
    if (aiDisableThinkingInput) aiDisableThinkingInput.checked = p.disableThinking === true;
}

export function openSettings() {
    renderProviderSelect();
    fillProviderInputs();
    renderDefaultVisionProviderSelect();
    aiMaxToolIterationsInput.value = state.maxToolIterations;
    if (aiDebugModeInput) aiDebugModeInput.checked = isDebugOn();
    aiSettingsOverlay.style.display = 'flex';
}

export function closeSettings() {
    aiSettingsOverlay.style.display = 'none';
}

export function bindProviderEvents() {
    aiProviderSelect.addEventListener('change', async () => {
        state.activeProviderId = aiProviderSelect.value;
        fillProviderInputs();
        await persistProviders();
    });
    aiProviderAddBtn.addEventListener('click', async () => {
        const name = prompt('新配置名称（如 DeepSeek / OpenAI / 本地）：', '配置' + (state.providers.length + 1));
        if (name === null) return;
        const p = defaultProvider(name.trim() || '配置' + (state.providers.length + 1));
        state.providers.push(p);
        state.activeProviderId = p.id;
        await persistProviders();
        renderProviderSelect();
        fillProviderInputs();
    });
    aiProviderDelBtn.addEventListener('click', async () => {
        if (state.providers.length <= 1) { alert('至少保留一份接口配置'); return; }
        const p = activeProvider();
        if (!confirm(`删除配置「${p.name}」？`)) return;
        state.providers = state.providers.filter(x => x.id !== p.id);
        if (state.activeProviderId === p.id) state.activeProviderId = state.providers[0].id;
        await persistProviders();
        renderProviderSelect();
        fillProviderInputs();
    });
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
    aiModelContext1MInput?.addEventListener('change', async () => {
        const p = activeProvider();
        if (!p) return;
        p.context1M = aiModelContext1MInput.checked;
        await persistProviders();
    });
    aiSupportsVisionInput.addEventListener('change', async () => {
        const p = activeProvider();
        if (!p) return;
        p.supportsVision = aiSupportsVisionInput.checked;
        await persistProviders();
        renderDefaultVisionProviderSelect();
    });
    // 关闭思考（仅对思考型模型有意义，勾选后 SW 请求体才带 enable_thinking:false）
    aiDisableThinkingInput?.addEventListener('change', async () => {
        const p = activeProvider();
        if (!p) return;
        p.disableThinking = aiDisableThinkingInput.checked;
        await persistProviders();
    });
    aiMaxToolIterationsInput.addEventListener('change', () => {
        const v = clampToolIterations(aiMaxToolIterationsInput.value);
        aiMaxToolIterationsInput.value = v;
        state.maxToolIterations = v;
        chrome.storage.sync.set({ aiMaxToolIterations: v });
    });
    aiDefaultVisionProviderSelect.addEventListener('change', async () => {
        state.defaultVisionProviderId = aiDefaultVisionProviderSelect.value;
        await persistProviders();
    });
    // DEBUG 模式开关（存 storage.sync，头部「Debug信息」按钮随之显隐）
    aiDebugModeInput?.addEventListener('change', async () => {
        try {
            await setDebugFlag(aiDebugModeInput.checked);
        } catch (err) {
            console.warn('[thswc:ai] DEBUG 模式切换失败:', err);
            aiDebugModeInput.checked = isDebugOn();
        }
    });
    document.getElementById('aiAgentBridge').addEventListener('change', async (event) => {
        const checkbox = event.currentTarget;
        if (checkbox.checked) {
            checkbox.checked = false;
            openBridgeSetup('enable');
        } else {
            state.bridgeEnabled = false;
            state.activeToolGroups.delete('bridge');
            await chrome.storage.sync.set({ bridgeEnabled: false });
            renderBridgeDirStatus();
        }
    });
}

// ============== Agent 桥接设置 ==============

/** 将桥接目录完整路径和项目根目录写入桥接目录下的 .ai-workspace-path，并同步 config.json */
async function syncBridgeConfig() {
    if (!state.bridgeHandle || !state.bridgeDirFullPath) return;
    try {
        // 写入 .ai-workspace-path（供 ai_workspace 工作目录使用）
        if (state.workspaceRootPath) {
            await writeFile(state.bridgeHandle, '.ai-workspace-path', state.workspaceRootPath);
        }
        // 写入 config.json（动态替换 __BRIDGE_DIR__）
        // HTTP 模式由服务端读取工作区 flit/config.json，不再覆盖桥接配置。
    } catch (err) {
        console.warn('[thswc:ai] 同步桥接配置失败:', err);
    }
}

export async function loadBridgeSettings() {
    const res = await storageGet(chrome.storage.sync, 'bridgeEnabled');
    state.bridgeEnabled = !!res.bridgeEnabled;
    state.bridgeHandle = await getBridgeHandle();
    state.workspaceHandles = await getWorkspaceHandles();
    const checkbox = document.getElementById('aiAgentBridge');
    if (checkbox) checkbox.checked = state.bridgeEnabled;
    const syncRes = await storageGet(chrome.storage.sync, ['bridgeDirFullPath', 'workspaceRootPath', 'bridgeUrl']);
    state.bridgeDirFullPath = syncRes.bridgeDirFullPath || '';
    state.workspaceRootPath = syncRes.workspaceRootPath || '';
    state.bridgeUrl = syncRes.bridgeUrl || 'http://127.0.0.1:17321';
    renderBridgeDirStatus();
    if (state.bridgeEnabled) {
        state.activeToolGroups.add('bridge');
        // HTTP 模式不再依赖桥接目录文件。
    } else {
        state.activeToolGroups.delete('bridge');
    }
}

function closeWorkspaceSetup() {
    const overlay = document.getElementById('workspaceSetupOverlay');
    if (overlay) overlay.style.display = 'none';
}

function closeBridgeSetup() {
    const overlay = document.getElementById('bridgeSetupOverlay');
    if (overlay) overlay.style.display = 'none';
}

function openBridgeSetup(mode) {
    const overlay = document.getElementById('bridgeSetupOverlay');
    const title = document.getElementById('bridgeSetupTitle');
    const input = document.getElementById('bridgeDirFullPath');
    const error = document.getElementById('bridgeSetupError');
    const pickBtn = document.getElementById('pickBridgeSetupBtn');
    if (!overlay || !input || !pickBtn) return;
    if (title) title.textContent = mode === 'replace' ? '更换桥接目录' : '设置桥接目录';
    input.value = state.bridgeDirFullPath || '';
    if (error) error.textContent = '';
    overlay.style.display = '';
    input.focus();
    pickBtn.onclick = async () => {
        const path = input.value.trim().replace(/[\\/]+$/, '');
        if (!/^(?:[A-Za-z]:[\\/]|\\\\)/.test(path)) {
            if (error) error.textContent = '请输入有效的绝对路径，例如 D:\\ai\\flit_bridge';
            return;
        }
        const expectedName = path.split(/[\\/]/).filter(Boolean).pop();
        if (expectedName !== 'flit_bridge') {
            if (error) error.textContent = '路径末级目录必须是 flit_bridge，请重新填写';
            return;
        }
        pickBtn.disabled = true;
        try {
            const handle = await pickBridgeDirectory();
            state.bridgeHandle = handle;
            state.bridgeDirFullPath = path;
            state.bridgeEnabled = true;
            await chrome.storage.sync.set({ bridgeEnabled: true, bridgeDirFullPath: path });
            state.activeToolGroups.add('bridge');
            document.getElementById('aiAgentBridge').checked = true;
            closeBridgeSetup();
            renderBridgeDirStatus();
        } catch (err) {
            if (!(err && err.name === 'AbortError') && error) {
                error.textContent = '桥接目录授权失败：' + (err && err.message || err);
            }
        } finally {
            pickBtn.disabled = false;
        }
    };
}

function openWorkspaceSetup(mode) {
    const overlay = document.getElementById('workspaceSetupOverlay');
    const title = document.getElementById('workspaceSetupTitle');
    const input = document.getElementById('workspaceRootPath');
    const error = document.getElementById('workspaceSetupError');
    const pickBtn = document.getElementById('pickWorkspaceSetupBtn');
    if (!overlay || !input || !pickBtn) return;
    if (title) title.textContent = mode === 'replace' ? '更换主目录' : '设置主目录';
    input.value = state.workspaceRootPath || '';
    if (error) error.textContent = '';
    overlay.style.display = '';
    input.focus();
    pickBtn.onclick = async () => {
        const path = input.value.trim().replace(/[\\/]+$/, '');
        if (!/^(?:[A-Za-z]:[\\/]|\\\\)/.test(path)) {
            if (error) error.textContent = '请输入有效的绝对路径，例如 D:\\ai\\agents\\stock-assistant';
            return;
        }
        pickBtn.disabled = true;
        try {
            const expectedName = path.split(/[\\/]/).filter(Boolean).pop();
            await pickPrimaryWorkspace(expectedName);
            state.workspaceRootPath = path;
            await chrome.storage.sync.set({ workspaceRootPath: path });
            closeWorkspaceSetup();
            await refreshDirStatus();
        } catch (err) {
            if (!(err && err.name === 'AbortError') && error) error.textContent = '目录授权失败：' + (err.message || err);
        } finally {
            pickBtn.disabled = false;
        }
    };
}

export function bindWorkspaceSetupEvents() {
    document.getElementById('closeWorkspaceSetupBtn')?.addEventListener('click', closeWorkspaceSetup);
    document.getElementById('cancelWorkspaceSetupBtn')?.addEventListener('click', closeWorkspaceSetup);
}

export function bindBridgeSetupEvents() {
    document.getElementById('closeBridgeSetupBtn')?.addEventListener('click', closeBridgeSetup);
    document.getElementById('cancelBridgeSetupBtn')?.addEventListener('click', closeBridgeSetup);
}

export function renderBridgeDirStatus() {
    const el = document.getElementById('bridgeDirStatus');
    if (!el) return;
    el.innerHTML = '';
    if (!state.bridgeEnabled) return;
    if (!state.bridgeHandle) {
        const text = document.createElement('span');
        text.className = 'bridge-missing';
        text.textContent = '未授权桥接目录';
        const btn = document.createElement('button');
        btn.textContent = '选择 flit_bridge 目录';
        btn.addEventListener('click', () => openBridgeSetup('replace'));
        el.append(text, btn);
        return;
    }
    (async () => {
        try {
            const perm = await workspacePermission(state.bridgeHandle);
            if (perm === 'granted') {
                const ok = document.createElement('span');
                ok.className = 'bridge-ok';
                ok.textContent = '✓ 已授权';
                const name = document.createElement('span');
                name.className = 'bridge-name';
                try { name.textContent = state.bridgeHandle.name; } catch { name.textContent = '桥接目录'; }
                el.append(ok, name);
                const changeBtn = document.createElement('button');
                changeBtn.textContent = '更换桥接目录';
                changeBtn.addEventListener('click', () => openBridgeSetup('replace'));
                el.append(changeBtn);
            } else {
                const text = document.createElement('span');
                text.className = 'bridge-missing';
                text.textContent = '权限待重新授权';
                const btn = document.createElement('button');
                btn.textContent = '重新授权';
                btn.addEventListener('click', async () => {
                    try {
                        await state.bridgeHandle.requestPermission({ mode: 'readwrite' });
                        renderBridgeDirStatus();
                    } catch (err) {
                        console.warn('[thswc:ai] 桥接目录重授权失败:', err);
                    }
                });
                el.append(text, btn);
            }
        } catch { }
    })();
}

// ============== 工作目录状态条 ==============

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

export async function refreshDirStatus() {
    state.workspaceHandles = await getWorkspaceHandles();
    renderUploadState();
    dirStatusBar.innerHTML = '';
    if (state.workspaceHandles.length === 0) {
        dirStatusBar.append(textSpan('工作目录未授权 — 授权后可读写本地文件；软链接不可访问，可把真实目录添加为附加根'));
        dirStatusBar.append(dirActionBtn('设置主目录', () => openWorkspaceSetup('set')));
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
    for (let i = 0; i < state.workspaceHandles.length; i++) {
        const d = state.workspaceHandles[i];
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
    dirStatusBar.append(dirActionBtn('更换主目录', () => openWorkspaceSetup('replace')));
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

// ============== 上传按钮状态 ==============

const LLM_CONTEXT_FILES_DIR = 'llm_context_files';

function renderUploadState() {
    const ok = state.workspaceHandles.length > 0;
    uploadBtn.disabled = false;
    uploadBtn.title = ok ? '上传文件到 llm_context_files 并加载到上下文' : '选择文件后需先设置工作目录';
}
