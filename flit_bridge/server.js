const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const PORT = Number(process.env.FLIT_BRIDGE_PORT || 17321);
const HOST = '127.0.0.1';
const PROTOCOL_VERSION = 1;
const MAX_BODY = 1024 * 1024;
const MAX_OUTPUT = 50000;
const contextCache = new Map();
const running = new Map();

const json = (res, status, value) => {
    const body = JSON.stringify(value);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    });
    res.end(body);
};

function error(code, message, requestId, extra = {}) {
    return { ok: false, request_id: requestId, error: { code, message, ...extra } };
}

function readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function readText(file) {
    const buffer = fs.readFileSync(file);
    const utf8 = buffer.toString('utf8');
    if (!utf8.includes('\ufffd')) return utf8;
    try { return new TextDecoder('gb18030').decode(buffer); } catch { return utf8; }
}

function fileStamp(file) {
    try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}

function extractMemory(memory) {
    if (!memory) return [];
    return memory.split(/\r?\n/)
        .map(line => line.match(/^\s*[-*]\s+(.+)$/)?.[1]?.trim())
        .filter(Boolean)
        .slice(0, 30);
}

function extractMemoryStatus(memory) {
    const match = String(memory || '').match(/##\s*(?:数据库连接状态|Database Connection Status)\s*\r?\n([\s\S]*?)(?=\r?\n##\s|$)/i);
    if (!match) return null;
    return match[1].split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(0, 12);
}

function listWorkflows(root) {
    const dir = path.join(root, 'flit', 'workflow');
    try {
        return fs.readdirSync(dir, { withFileTypes: true })
            .filter(entry => entry.isFile() && /\.(md|json|ya?ml|mjs|cjs|js|py)$/i.test(entry.name))
            .map(entry => path.posix.join('flit/workflow', entry.name));
    } catch { return []; }
}

function firstMatch(text, patterns) {
    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match?.[1]) return match[1].trim().replace(/^['"`]|['"`]$/g, '');
    }
    return '';
}

function inferLegacyConfig(text) {
    if (!text) return { database: null, market: null };
    const hasPostgres = /postgres(?:ql)?|pgsql/i.test(text);
    if (!hasPostgres) return { database: null, market: null };
    const container = /\bmy-postgres\b/i.test(text) ? 'my-postgres' : firstMatch(text, [/container[^:=\n]*[=:]\s*`?([^\s`,;]+)/i]) || 'my-postgres';
    const database = {
        name: 'local-postgres',
        type: 'postgresql',
        access: 'docker',
        container,
        database: firstMatch(text, [/数据库[^：:\n]*[：:]\s*`?([^\s`，,；;]+)`?/i, /database[^:=\n]*[=:]\s*`?([^\s`,;]+)/i]) || 'stock',
        user: firstMatch(text, [/用户[^：:\n]*[：:]\s*`?([^\s`，,；;]+)/i, /user[^:=\n]*[=:]\s*`?([^\s`,;]+)/i]) || 'postgres',
    };
    const market = {
        quote_table: /\ba_share_daily\b/i.test(text) ? 'a_share_daily' : 'a_share_daily',
        stock_table: firstMatch(text, [/股票名称映射表[^：:\n]*[：:]\s*([^\s，,；;]+)/i, /映射表[^：:\n]*[：:]\s*([^\s，,；;]+)/i]) || 'stock_basic_cache',
        adjustment: /\bqfq\b/i.test(text) ? 'qfq' : 'qfq',
        trading_day_only: true,
    };
    return { database: [database], market };
}

function workspaceContext(root, refresh = false) {
    if (!root || !path.isAbsolute(root) || !fs.existsSync(root)) {
        return { error: 'workspace_not_found', message: 'workspace_root 必须是存在的绝对路径' };
    }
    const files = [
        path.join(root, 'flit', 'config.json'),
        path.join(root, 'flit', 'memory.md'),
    ];
    const fallbackFiles = [
        path.join(root, 'memory', 'FACT.md'),
        path.join(root, 'AGENTS.md'),
        path.join(root, 'README.md'),
    ];
    const stamps = [...files, ...fallbackFiles, path.join(root, 'flit', 'workflow')].map(file => fileStamp(file)).join(':');
    const cached = contextCache.get(root);
    if (!refresh && cached && cached.stamps === stamps) return { ...cached.value, cached: true, changed: false };

    const configFile = files[0];
    const memoryFiles = files.slice(1).filter(file => fileStamp(file) > 0);
    const config = readJson(configFile);
    if (fileStamp(configFile) && !config) return { error: 'config_invalid', message: 'flit/config.json 不是有效 JSON' };
    const memoryText = memoryFiles.map(readText).join('\n');
    const hasPrimarySource = !!config || memoryFiles.length > 0;
    const legacyFiles = hasPrimarySource ? [] : fallbackFiles.filter(file => fileStamp(file) > 0);
    const text = [...memoryFiles, ...legacyFiles].map(readText).join('\n');
    const inferred = inferLegacyConfig(text);
    const workflows = listWorkflows(root);
    const value = {
        workspace_root: root,
        protocol_version: PROTOCOL_VERSION,
        sources: [config && 'flit/config.json', ...memoryFiles.map(file => path.relative(root, file)), ...legacyFiles.map(file => path.relative(root, file))].filter(Boolean),
        status: config ? 'confirmed' : memoryFiles.length ? 'candidate' : legacyFiles.length ? 'candidate' : 'unknown',
        context: {
            database: config?.data_sources || config?.database || inferred.database,
            market: config?.market || inferred.market,
            verified_connection: config?.verified_connection || extractMemoryStatus(memoryText),
            memory: memoryText || null,
            conventions: extractMemory(memoryFiles.length ? memoryText : text),
            workflows,
        },
        next_action: config
            ? '优先使用 flit/config.json 中的已确认数据源；如 context.workflows 有匹配流程，先读取该流程，再查询数据库。'
            : memoryFiles.length
                ? '优先读取 flit/memory.md 的数据库连接状态和 workflow 入口；若连接未验证或信息不足，再检查其他工作区文件。'
                : '未找到 flit/config.json 或 flit/memory.md，仅在确有必要时检查旧记忆和项目文档。',
    };
    contextCache.set(root, { stamps, value });
    return { ...value, cached: false, changed: !!cached };
}

function truncate(value) {
    const text = String(value || '');
    return text.length > MAX_OUTPUT ? text.slice(0, MAX_OUTPUT) : text;
}

function allowedProgram(program) {
    const name = path.basename(program).toLowerCase();
    return ['docker', 'docker.exe', 'git', 'git.exe', 'node', 'node.exe', 'npm', 'npm.cmd', 'psql', 'psql.exe', 'python', 'python.exe', 'python3', 'python3.exe'].includes(name);
}

function writeWorkspaceMemory(root, content, databaseStatus = '') {
    if (!root || !path.isAbsolute(root) || !fs.existsSync(root)) return error('workspace_not_found', 'workspace_root 必须是存在的绝对路径');
    const entry = String(content || '').trim();
    if (!entry) return error('argument_invalid', 'memory 内容不能为空');
    const memoryFile = path.join(root, 'flit', 'memory.md');
    fs.mkdirSync(path.dirname(memoryFile), { recursive: true });
    const existing = fs.existsSync(memoryFile) ? readText(memoryFile).trimEnd() : '';
    const statusHeader = '## 数据库连接状态';
    const workflowHeader = '## 可复用流程与查询约定';
    let normalized = existing;
    if (!new RegExp(`^# 工作区记忆`, 'm').test(normalized)) normalized = '# 工作区记忆\n\n' + normalized;
    if (!new RegExp(`(^|\\n)${statusHeader}\\s*\\n`, 'm').test(normalized)) {
        normalized = normalized.replace(/^# 工作区记忆\s*/, '# 工作区记忆\n\n' + statusHeader + '\n- status: unknown\n');
    }
    if (/^(verified|unverified|unknown)$/i.test(databaseStatus)) {
        normalized = normalized.replace(/(## 数据库连接状态\s*\r?\n)([\s\S]*?)(?=\r?\n##\s|$)/i, `$1- status: ${databaseStatus.toLowerCase()}\n`);
    }
    if (!new RegExp(`(^|\\n)${workflowHeader}\\s*\\n`, 'm').test(normalized)) normalized += `\n\n${workflowHeader}\n`;
    fs.writeFileSync(memoryFile, `${normalized.trimEnd()}\n\n- ${entry}\n`, 'utf8');
    contextCache.delete(root);
    return { ok: true, path: path.relative(root, memoryFile), written: entry.length };
}

function resolveWorkspacePath(root, relativePath = '') {
    if (!root || !path.isAbsolute(root) || !fs.existsSync(root)) return null;
    const resolved = path.resolve(root, relativePath || '.');
    const relative = path.relative(root, resolved);
    return relative && (relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) ? null : resolved;
}

function runProcess({ requestId, program, argv = [], cwd, stdin = '', timeoutMs = 10000 }) {
    return new Promise(resolve => {
        if (!program || !allowedProgram(program)) {
            resolve(error('program_not_allowed', `不允许执行程序: ${program}`, requestId));
            return;
        }
        if (!cwd || !path.isAbsolute(cwd) || !fs.existsSync(cwd)) {
            resolve(error('workspace_not_found', 'cwd 必须是存在的绝对路径', requestId));
            return;
        }
        const started = Date.now();
        let child;
        try {
            child = spawn(program, argv.map(String), { cwd, shell: false, windowsHide: true });
        } catch (e) {
            resolve(error('process_start_failed', e.message, requestId));
            return;
        }
        running.set(requestId, child);
        let stdout = '', stderr = '', timedOut = false;
        child.stdout.on('data', data => { stdout += data; });
        child.stderr.on('data', data => { stderr += data; });
        if (stdin) { child.stdin.end(String(stdin)); } else child.stdin.end();
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill();
        }, Math.max(100, Math.min(300000, Number(timeoutMs) || 10000)));
        child.on('close', code => {
            clearTimeout(timer);
            running.delete(requestId);
            resolve({
                ok: !timedOut && code === 0,
                request_id: requestId,
                status: timedOut ? 'timeout' : code === 0 ? 'completed' : 'failed',
                exit_code: timedOut ? null : code,
                stdout: truncate(stdout),
                stderr: truncate(stderr),
                diagnostics: { stage: 'process', executor: 'direct-process', duration_ms: Date.now() - started, timed_out: timedOut, truncated: stdout.length > MAX_OUTPUT || stderr.length > MAX_OUTPUT },
            });
        });
        child.on('error', e => {
            clearTimeout(timer);
            running.delete(requestId);
            resolve(error('process_start_failed', e.message, requestId));
        });
    });
}

async function databaseQuery(body, requestId) {
    const root = body.workspace_root;
    const ctx = workspaceContext(root, false);
    if (ctx.error) return error(ctx.error, ctx.message, requestId);
    const sources = Array.isArray(ctx.context.database) ? ctx.context.database : [ctx.context.database];
    const source = sources.find(item => item && item.name === body.source) || sources.find(Boolean);
    if (!source || source.access !== 'docker' || !source.container || !source.database) {
        return error('config_invalid', '未找到可用的 Docker PostgreSQL 数据源', requestId);
    }
    const sql = String(body.sql || '').trim();
    if (!/^(select|with|explain)\b/i.test(sql) || /\b(insert|update|delete|drop|alter|truncate|create|grant|revoke)\b/i.test(sql)) {
        return error('sql_forbidden', '仅允许只读 SQL（SELECT/WITH/EXPLAIN）', requestId);
    }
    const result = await runProcess({
        requestId, program: 'docker',
        argv: ['exec', '-i', source.container, 'psql', '-X', '-At', '-F', '\t', '-v', 'ON_ERROR_STOP=1', '-U', source.user || 'postgres', '-d', source.database],
        stdin: sql,
        cwd: root,
        timeoutMs: body.timeout_ms,
    });
    if (!result.ok) return { ...result, error: { code: 'sql_error', message: result.stderr || '数据库查询失败' } };
    const lines = result.stdout.trim() ? result.stdout.trim().split(/\r?\n/) : [];
    const columns = Array.isArray(body.columns) ? body.columns : null;
    const rows = lines.map(line => {
        const values = line.split('\t');
        return columns ? Object.fromEntries(columns.map((key, i) => [key, values[i] ?? null])) : values;
    });
    return { ok: true, request_id: requestId, columns, rows, row_count: rows.length, diagnostics: body.debug ? result.diagnostics : undefined };
}

async function databaseSchema(body, requestId) {
    const ctx = workspaceContext(body.workspace_root, false);
    if (ctx.error) return error(ctx.error, ctx.message, requestId);
    const sources = Array.isArray(ctx.context.database) ? ctx.context.database : [ctx.context.database];
    const source = sources.find(item => item && item.name === body.source) || sources.find(Boolean);
    if (!source || source.access !== 'docker' || !source.container || !source.database) return error('config_invalid', '未找到可用的 Docker PostgreSQL 数据源', requestId);
    const result = await runProcess({
        requestId, program: 'docker',
        argv: ['exec', '-i', source.container, 'psql', '-X', '-At', '-F', '\t', '-v', 'ON_ERROR_STOP=1', '-U', source.user || 'postgres', '-d', source.database],
        stdin: "SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, ordinal_position;",
        cwd: body.workspace_root, timeoutMs: body.timeout_ms,
    });
    if (!result.ok) return { ...result, error: { code: 'schema_error', message: result.stderr || '数据库结构查询失败' } };
    const rows = result.stdout.trim() ? result.stdout.trim().split(/\r?\n/).map(line => {
        const [table, column, dataType, nullable] = line.split('\t');
        return { table, column, data_type: dataType, nullable: nullable === 'YES' };
    }) : [];
    return { ok: true, request_id: requestId, tables: rows, table_count: new Set(rows.map(row => row.table)).size };
}

async function handle(req, res, body) {
    const requestId = body?.request_id || `req_${crypto.randomBytes(6).toString('hex')}`;
    const url = new URL(req.url, `http://${HOST}:${PORT}`);
    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true, protocol_version: PROTOCOL_VERSION, service: 'flit_bridge' });
    if (req.method === 'POST' && url.pathname === '/v1/workspace/context') return json(res, 200, workspaceContext(body.workspace_root, !!body.refresh));
    if (req.method === 'POST' && url.pathname === '/v1/workspace/memory') return json(res, 200, writeWorkspaceMemory(body.workspace_root, body.content, body.database_status));
    if (req.method === 'POST' && url.pathname === '/v1/database/query') return json(res, 200, await databaseQuery(body, requestId));
    if (req.method === 'POST' && url.pathname === '/v1/database/schema') return json(res, 200, await databaseSchema(body, requestId));
    if (req.method === 'POST' && url.pathname === '/v1/process') {
        const cwd = resolveWorkspacePath(body.workspace_root, body.cwd);
        if (!cwd) return json(res, 200, error('workspace_path_invalid', 'cwd 必须是当前工作目录中的相对路径', requestId));
        return json(res, 200, await runProcess({ requestId, ...body, cwd }));
    }
    if (req.method === 'POST' && url.pathname === `/v1/process/${requestId}/cancel`) {
        const child = running.get(requestId);
        if (child) child.kill();
        return json(res, 200, { ok: true, request_id: requestId, cancelled: !!child });
    }
    return json(res, 404, error('not_found', '接口不存在', requestId));
}

const server = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') return json(res, 204, {});
    let data = '';
    req.on('data', chunk => { data += chunk; if (data.length > MAX_BODY) req.destroy(); });
    req.on('end', async () => {
        try { await handle(req, res, data ? JSON.parse(data) : {}); }
        catch (e) { json(res, 500, error('internal_error', e.message, 'unknown')); }
    });
});

server.listen(PORT, HOST, () => {
    console.log(`flit_bridge listening on http://${HOST}:${PORT}`);
    console.log('服务已启动，可最小化窗口但不要关闭');
});
