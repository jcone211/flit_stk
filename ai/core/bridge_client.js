import { state } from './ai_state.js';

const DEFAULT_URL = 'http://127.0.0.1:17321';

export async function bridgeRequest(path, body, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs || 15000);
    try {
        const response = await fetch((state.bridgeUrl || DEFAULT_URL).replace(/\/+$/, '') + path, {
            method: options.method || 'POST', headers: { 'Content-Type': 'application/json' },
            body: options.method === 'GET' ? undefined : JSON.stringify(body || {}), signal: controller.signal,
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error?.message || `桥接服务 HTTP ${response.status}`);
        return data;
    } catch (err) {
        return { ok: false, error: { code: err.name === 'AbortError' ? 'timeout' : 'bridge_unreachable', message: err.message || '桥接服务不可用' } };
    } finally { clearTimeout(timer); }
}

export const bridgeHealth = () => bridgeRequest('/health', null, { method: 'GET', timeoutMs: 3000 });
