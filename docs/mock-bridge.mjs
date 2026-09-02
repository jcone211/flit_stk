// mock-bridge.mjs —— 假 Agent 桥接（docs/verify-free-first.mjs 专用，不参与扩展打包）
//
// 为什么要它：K 线取数已改成「读工作目录 flit/config.json → 经 flit_bridge 只读查库」，
//   真实链路依赖用户机器上的 docker + my-postgres，回归脚本不能拿用户库当测试床反复打，
//   也没法确定性地构造「库里缺 3 根 / 缺 30 根 / config 为空 / 桥接不可达」这些分支。
// 本文件按 flit_bridge/server.js 的**真实响应形状**造假：
//   POST /v1/workspace/context → { ok, status, context:{ database:[...] } }
//   POST /v1/database/schema   → { ok, tables:[{table,column,data_type,nullable}] }
//   POST /v1/database/query    → { ok, columns, rows:[{列名:值}], row_count }
//   失败 → { ok:false, error:{ code, message } }
// 并且照抄桥接的只读 SQL 闸门（只放 SELECT/WITH/EXPLAIN，禁 insert/update/... ），
// 这样扩展拼出来的 SQL 一旦不合规，脚本会立刻 FAIL 而不是静默放过。
//
// 行值是按 fixture **造**的（可复现），但 SQL 解析是真解析：
//   表名 / code IN (...) / adjust = 'x' / date >= 'x' / rn <= N 都会读并照做。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const KLINE_COL_ORDER = ['code', 'date', 'open', 'high', 'low', 'close', 'volume', 'amount', 'change_pct', 'turnover_pct'];

/** 真实库里 a_share_daily + stock_basic_cache 的列签名（照用户环境实测形状） */
const dailyCols = ['adjust', 'market', 'code', 'date', 'open', 'high', 'low', 'close', 'volume', 'amount', 'change_pct', 'turnover_pct'];
const asTable = (t) => dailyCols.map(c => ({ table: t, column: c, data_type: c === 'date' ? 'date' : 'numeric', nullable: 'NO' }));
export const SCHEMA_FULL = [
    ...asTable('a_share_daily'),
    // 干扰项一：另一张合法日线表（D16 拿它验「改了 config 表名要不要重开窗口」）
    ...asTable('daily_v2'),
    ...['ts_code', 'name', 'industry', 'list_date', 'dead_tag']
        .map(c => ({ table: 'stock_basic_cache', column: c, data_type: 'text', nullable: 'NO' })),
    // 干扰项二：列签名不完整的同名表，用来验证探测不会挑错表
    { table: 'a_share_daily_today', column: 'code', data_type: 'text', nullable: 'NO' },
    { table: 'a_share_daily_today', column: 'date', data_type: 'date', nullable: 'NO' },
];

/** 一个数据源登记形状（与用户 flit/config.json 的 data_sources[0] 一致） */
export function dailySource(over = {}) {
    return {
        name: 'local-postgres', type: 'postgresql', access: 'docker',
        container: 'my-postgres', database: 'stock', user: 'postgres',
        tables: { daily: 'a_share_daily', daily_view: 'v_share_daily', stock_basic: 'stock_basic_cache' },
        conventions: { adjust: 'qfq', code_format: 'XXXXXX.SZ/.SH/.BJ' },
        ...over,
    };
}

/** 工作日回溯生成日期（不含节假日建模，够用） */
function prevWeekdays(last, count) {
    const out = [];
    const d = new Date(last + 'T12:00:00');
    while (out.length < count) {
        const day = d.getDay();
        if (day !== 0 && day !== 6) out.push(d.toISOString().slice(0, 10));
        d.setDate(d.getDate() - 1);
    }
    return out.reverse();
}

/** 往前推 n 个工作日（last 本身算第 0 天；last 为周末时从周五起算） */
export function minusWeekdays(last, n) {
    return prevWeekdays(last, n + 1)[0];
}

function parseInList(sql) {
    const m = sql.match(/code\s+IN\s*\(([^)]*)\)/i);
    if (!m) return [];
    return [...m[1].matchAll(/'([^']*)'/g)].map(x => x[1]);
}

/**
 * 起一个假桥接。fixture 可在用例之间整体替换（bridge.fixture = {...}）。
 * @returns { url, port, log, klineSqlCount, nameSqlCount, forbidden, close() }
 */
export async function startMockBridge(initialFixture = {}) {
    const b = {
        log: [],                 // { endpoint, sql?, source? }
        klineSql: [],            // 收到的日线 SQL 原文（用来断言「一次 SQL 取整批」）
        nameSql: [],             // 收到的名称搜索 SQL
        schemaCalls: 0,
        contextCalls: 0,
        forbidden: [],           // 被只读闸门拦下的 SQL（正常应恒为 0）
        // 不被 resetCounts() 清零的全局累计（D15 安全自证用）
        total: { klineSql: 0, nameSql: 0, query: 0, forbidden: 0, looseSql: 0, klineTables: new Set() },
    };
    const fx = () => Object.assign({
        schema: SCHEMA_FULL,           // [] 表示读不到表结构；null 表示 schema 接口报错
        schemaError: null,             // 'schema_error'
        dbLast: null,                  // 库内末行日期（null = 该代码在库里没有数据）
        bars: 60,                      // 每个代码最多造多少根
        noDbPrefixes: ['51', '15', '58'], // ETF：库里不收录
        basic: [{ ts_code: '600519.SH', name: '贵州茅台' }, { ts_code: '001309.SZ', name: '德明利' }, { ts_code: '600206.SH', name: '有研新材' }],
        queryError: null,              // { code, message } —— 模拟 psql 报错 / 表不存在
        contextDatabase: null,         // /v1/workspace/context 在 config 缺失时的推断结果
    }, b._fixture || initialFixture);
    b._fixture = fx();

    const readConfig = (root) => {
        try {
            const p = path.join(root, 'flit', 'config.json');
            if (!fs.existsSync(p)) return { missing: true };
            const text = fs.readFileSync(p, 'utf8');
            if (!text.trim()) return { missing: true, empty: true };
            return { cfg: JSON.parse(text) };
        } catch (e) {
            return { bad: String(e.message || e) };
        }
    };

    const respond = (res, obj) => {
        const body = JSON.stringify(obj);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
        res.end(body);
    };

    const handleContext = (body) => {
        b.contextCalls++;
        const root = String(body.workspace_root || '');
        if (!root || !fs.existsSync(root)) return { error: 'workspace_not_found', message: 'workspace_root 必须是存在的绝对路径' };
        const { cfg, missing, bad } = readConfig(root);        if (bad) return { error: 'config_invalid', message: 'flit/config.json 不是有效 JSON' };
        const fromCfg = cfg && (cfg.data_sources || cfg.database);
        const list = Array.isArray(fromCfg) ? fromCfg : (fromCfg && typeof fromCfg === 'object' ? Object.values(fromCfg) : []);
        const sources = list.filter(s => s && typeof s === 'object');
        if (sources.length) return { ok: true, status: 'confirmed', sources: ['flit/config.json'], context: { database: sources } };
        // config 为空 → 真实桥接会去读 flit/memory.md、AGENTS.md、README.md 推断；这里要求「确实有记忆文件」才给推断结果，
        // 否则就是凭空捏造数据源（D8 靠这条验「什公都没有」的分支）。
        const hasMemory = ['flit/memory.md', 'memory/FACT.md', 'AGENTS.md', 'README.md']
            .some(rel => fs.existsSync(path.join(root, rel)));
        const db = hasMemory ? fx().contextDatabase : null;
        return {
            ok: true, status: db ? 'candidate' : 'unknown', sources: [],
            context: { database: db || null },
            next_action: db ? 'flit/config.json 未登记，使用工作目录记忆推断出的数据源' : '未找到 flit/config.json 或工作目录记忆',
        };
    };

    const handleSchema = (body) => {
        b.schemaCalls++;
        const f = fx();
        if (f.schemaError) return { ok: false, error: { code: f.schemaError, message: '数据库结构查询失败（mock）' } };
        if (!Array.isArray(f.schema)) return { ok: false, error: { code: 'schema_error', message: 'mock：schema 未配置' } };
        return { ok: true, tables: f.schema, table_count: new Set(f.schema.map(r => r.table)).size };
    };

    const handleQuery = (body) => {
        const sql = String(body.sql || '').trim();
        const f = fx();
        b.log.push({ endpoint: '/v1/database/query', sql, source: body.source });
        b.total.query++;
        // —— 照抄真实桥接的只读闸门 ——
        if (!/^(select|with|explain)\b/i.test(sql) || /\b(insert|update|delete|drop|alter|truncate|create|grant|revoke)\b/i.test(sql)) {
            b.forbidden.push(sql);
            b.total.forbidden++;
            return { ok: false, error: { code: 'sql_forbidden', message: '仅允许只读 SQL（SELECT/WITH/EXPLAIN）' } };
        }
        if (f.queryError) return { ok: false, error: { code: f.queryError.code || 'sql_error', message: f.queryError.message || '查询失败（mock）' } };

        const columns = Array.isArray(body.columns) && body.columns.length ? body.columns : KLINE_COL_ORDER;
        const wrap = (vals) => Object.fromEntries(columns.map(c => [c, vals[c] ?? null]));

        // —— 名称 → 代码（searchCodeInDatabase）——
        if (/FROM\s+\S+\s+WHERE\s+name\s*=/i.test(sql)) {
            b.nameSql.push(sql);
            b.total.nameSql++;
            const kw = (sql.match(/name\s*=\s*'([^']*)'/i) || [])[1] || '';
            const like = (sql.match(/name\s+LIKE\s*'([^']*)'/i) || [])[1] || '';
            const rows = f.basic.filter(r => r.name === kw || (like && r.name.startsWith(like.replace(/%$/, ''))));
            return { ok: true, columns, rows: rows.map(wrap), row_count: rows.length };
        }

        // —— 日线主查询 ——
        const table = (sql.match(/FROM\s+([A-Za-z0-9_.]+)/i) || [])[1] || null;
        const codes = parseInList(sql).map(c => String(c).slice(0, 6));
        const uniq = [...new Set(codes)];
        const rn = Number((sql.match(/rn\s*<=\s*(\d+)/i) || [])[1] || 60);
        const since = (sql.match(/date\s*>=\s*'([^']+)'/i) || [])[1] || null;
        const adjust = (sql.match(/adjust\s*=\s*'([^']+)'/i) || [])[1] || null;
        b.klineSql.push({ table, codes: uniq, rn, since, adjust, sql });
        b.total.klineSql++;
        b.total.klineTables.add(String(table));
        // 日线查询必须带 code 限定与 rn 上限，否则就是全表拉取
        if (!uniq.length || !rn) b.total.looseSql++;
        const rows = [];
        if (f.dbLast) {
            for (const code6 of uniq) {
                if (f.noDbPrefixes.some(p => code6.startsWith(p))) continue;   // 库里不收录 ETF
                const dates = prevWeekdays(f.dbLast, Math.max(f.bars, rn)).slice(-rn).filter(d => !since || d >= since);
                dates.forEach((date, i) => {
                    const base = 8 + (Number(code6) % 40);
                    const close = Math.round((base + i * 0.11) * 100) / 100;
                    rows.push(wrap({
                        code: code6,   // 先给 6 位，下面再按请求里的写法补回 .SH/.SZ 后缀
                        date,
                        open: Math.round((close - 0.05) * 100) / 100,
                        high: Math.round((close + 0.2) * 100) / 100,
                        low: Math.round((close - 0.3) * 100) / 100,
                        close,
                        volume: 1_000_000 + i * 1000,
                        amount: Math.round((1_000_000 + i * 1000) * close * 100) / 100,
                        change_pct: Math.round((i === 0 ? 0 : 0.37) * 100) / 100,
                        turnover_pct: 1.5,
                    }));
                });
            }
        }
        // 真实库里 code 带后缀（001309.SZ）：按请求里的写法回填，保证扩展能按 substr(code,1,6) 对上
        const inList = parseInList(sql);
        for (const r of rows) {
            const six = String(r.code).slice(0, 6);
            const wanted = inList.find(c => String(c).slice(0, 6) === six && String(c).length > 6);
            if (wanted) r.code = wanted;
        }
        return { ok: true, columns, rows, row_count: rows.length };
    };

    const server = http.createServer((req, res) => {
        let data = '';
        req.on('data', c => { data += c; });
        req.on('end', () => {
            let body = {};
            try { body = data ? JSON.parse(data) : {}; } catch { /* 忽略 */ }
            const url = new URL(req.url, 'http://127.0.0.1');
            let out;
            if (req.method === 'GET' && url.pathname === '/health') out = { ok: true, protocol_version: 1, service: 'flit_bridge_mock' };
            else if (url.pathname === '/v1/workspace/context') out = handleContext(body);
            else if (url.pathname === '/v1/database/schema') out = handleSchema(body);
            else if (url.pathname === '/v1/database/query') out = handleQuery(body);
            else out = { ok: false, error: { code: 'not_found', message: '接口不存在（mock）' } };
            respond(res, out);
        });
    });
    server.listen(0, '127.0.0.1');
    await new Promise(r => server.once('listening', r));
    const addr = server.address();
    b.port = addr.port;
    b.url = 'http://127.0.0.1:' + addr.port;
    b.fixture = (patch) => { b._fixture = Object.assign({}, b._fixture, patch); return b._fixture; };
    b.resetCounts = () => { b.klineSql = []; b.nameSql = []; b.schemaCalls = 0; b.contextCalls = 0; b.forbidden = []; b.log = []; };
    b.close = () => new Promise(r => server.close(r));
    return b;
}
