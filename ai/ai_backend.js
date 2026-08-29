// ai_backend.js —— SW 内模块（被 background.js import）：OpenAI 兼容接口的请求构造与响应解析。
// 只做无状态「单轮流式代理」：调用方传 signal 控制中止，事件经 emit 回调逐条送出，
// 由 background 转 port 转发给 AI 窗口页面；页面端不接触 SSE。
// 流式：SSE 在 SW 内解析（行缓冲 + TextDecoder stream 模式，兼容跨 chunk 断行与中文半字）；
// 非流式：页面降级时 stream=false，一次性取全量 content。

/**
 * 发起一次 chat/completions 请求并流式产出事件
 * @param {object}   opts
 * @param {string}   opts.baseUrl  - 如 https://api.deepseek.com（自动拼 /v1/chat/completions）
 * @param {string}   opts.apiKey   - 可为空（部分本地端点不需要）
 * @param {string}   opts.model
 * @param {Array}    opts.messages
 * @param {Array}    [opts.tools] - OpenAI function schema 数组
 * @param {boolean}  [opts.stream=true] - false 走非流式（页面降级用）
 * @param {AbortSignal} opts.signal
 * @param {(e:{type:'chunk'|'done'|'error'|'aborted', ...}) => void} emit
 */
export async function streamAiChat(opts, emit) {
    const { baseUrl, apiKey, model, messages, tools, signal, stream = true } = opts;

    let url;
    let resolvedEndpoint = '';
    try {
        // baseUrl 支持三种填法，智能拼接 /v1/chat/completions：
        //   ① 已含完整 endpoint（.../v1/chat/completions）→ 直接用
        //   ② 以 /v1 结尾（如 api.deepseek.com/v1 或 dashscope .../compatible-mode/v1）→ 拼 /chat/completions
        //   ③ 其它（如 api.deepseek.com、dashscope .../compatible-mode）→ 拼 /v1/chat/completions
        let base = String(baseUrl || '').replace(/\/+$/, '');
        if (/\/chat\/completions$/i.test(base)) {
            resolvedEndpoint = base;
        } else if (/\/v\d+$/i.test(base)) {
            resolvedEndpoint = base + '/chat/completions';
        } else {
            resolvedEndpoint = base + '/v1/chat/completions';
        }
        url = new URL(resolvedEndpoint);
    } catch {
        emit({ type: 'error', message: 'baseUrl 格式无效，请在设置中检查', retriable: false });
        return;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        emit({ type: 'error', message: 'baseUrl 协议仅支持 http/https', retriable: false });
        return;
    }

    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = 'Bearer ' + apiKey; // 日志不打请求头，Key 不出 SW

    // 仅在提供 tools 时携带 tool_choice：部分兼容端点在无 tools 时传 tool_choice 会报错
    const body = { model, messages, stream };
    if (tools && tools.length > 0) {
        body.tools = tools;
        body.tool_choice = 'auto';
    }

    let resp;
    try {
        resp = await fetch(url.href, {
            method: 'POST',
            headers,
            // 不传 max_tokens：各兼容端点默认不同，传错直接 400；
            // 长回答截断由 finish_reason:'length' 通知页面渲染「继续生成」入口
            body: JSON.stringify(body),
            signal,
        });
    } catch (err) {
        if (err.name === 'AbortError') {
            emit({ type: 'aborted' });
            return;
        }
        emit({ type: 'error', message: '网络请求失败：' + err.message, retriable: true });
        return;
    }

    if (!resp.ok) {
        let detail = '';
        try { detail = (await resp.text()).slice(0, 300); } catch { /* 忽略 */ }
        emit({
            type: 'error',
            message: 'HTTP ' + resp.status + (detail ? ' ' + detail : '') + '｜端点: ' + resolvedEndpoint,
            retriable: resp.status >= 500 || resp.status === 429
        });
        return;
    }

    if (!stream) {
        try {
            await handleNonStream(resp, emit);
        } catch (err) {
            if (err.name === 'AbortError') {
                emit({ type: 'aborted' });
                return;
            }
            emit({ type: 'error', message: '读取响应失败：' + err.message, retriable: true });
        }
        return;
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder('utf-8', { stream: true }); // stream 模式防多字节中文半字
    let lineBuffer = '';
    let finishReason = null;
    const toolCalls = new Map(); // index -> { id, name, arguments }（流式分段累积）

    // 处理一行完整 SSE 文本（空行/注释行跳过；data: 前缀剥离；[DONE] 结束；JSON 解析失败容错跳过）
    const handleLine = (line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':') || !trimmed.startsWith('data:')) return;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') return;
        let obj;
        try { obj = JSON.parse(data); } catch { return; }
        const choice = (obj.choices || [])[0];
        if (!choice) return;
        if (choice.delta) {
            if (choice.delta.content) emit({ type: 'chunk', delta: choice.delta.content });
            if (Array.isArray(choice.delta.tool_calls)) {
                for (const tc of choice.delta.tool_calls) {
                    const idx = tc.index ?? 0;
                    const cur = toolCalls.get(idx) || { id: '', name: '', arguments: '' };
                    if (tc.id) cur.id = tc.id;
                    if (tc.function && tc.function.name) cur.name = tc.function.name;
                    if (tc.function && tc.function.arguments) cur.arguments += tc.function.arguments;
                    toolCalls.set(idx, cur);
                }
            }
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
    };

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            lineBuffer += decoder.decode(value);
            // 行缓冲：残行（未以 \n 结尾）留待下个 chunk，兼容 SSE 分片跨 chunk 断行
            const lines = lineBuffer.split('\n');
            lineBuffer = lines.pop();
            for (const line of lines) handleLine(line);
        }
        if (lineBuffer) handleLine(lineBuffer); // 流结束的残余行
    } catch (err) {
        if (err.name === 'AbortError') {
            emit({ type: 'aborted' });
            return;
        }
        emit({ type: 'error', message: '读取响应流失败：' + err.message, retriable: true });
        return;
    }

    // 按 index 顺序组装完整 tool_calls（arguments 已是拼接好的 JSON 字符串）
    const assembled = [...toolCalls.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, v]) => v);
    emit({ type: 'done', finish_reason: finishReason, tool_calls: assembled });
}

// 非流式降级：一次性解析全量响应（含 tool_calls），事件形状与流式一致
async function handleNonStream(resp, emit) {
    let data;
    try {
        data = await resp.json();
    } catch {
        emit({ type: 'error', message: '响应 JSON 解析失败', retriable: true });
        return;
    }
    const choice = (data.choices || [])[0];
    if (!choice) {
        emit({ type: 'error', message: '响应缺少 choices 字段', retriable: false });
        return;
    }
    const content = choice.message && choice.message.content;
    if (content) emit({ type: 'chunk', delta: content });
    const tool_calls = Array.isArray(choice.message && choice.message.tool_calls)
        ? choice.message.tool_calls.map(tc => ({
            id: tc.id || '',
            name: (tc.function && tc.function.name) || '',
            arguments: (tc.function && tc.function.arguments) || ''
        }))
        : [];
    emit({ type: 'done', finish_reason: choice.finish_reason || null, tool_calls });
}
