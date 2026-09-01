// ai_tools.js —— 工具定义、工具组（一行摘要目录）、执行器、K 线取数与批量摘要、要点/事件、长期记忆
// 取数约定：多只股票一律走批量工具（read_stocks_kline / get_portfolio_quotes）；
// K 线默认只回「派生指标摘要」（klineSummary），detail=true 才带原始 OHLCV 行。

import {
    state, dbg, getDateTime,
    storageGet, storageSet, genUid,
    DEFAULT_AI_BASE_URL, DEFAULT_AI_MODEL,
    MAX_TOOL_RESULT_CHARS, MAX_MESSAGES, MAX_MESSAGE_CHARS,
    MAX_MEMORY_ITEMS, MEMORY_KEY,
    summarizeList, pickStockView, findStockByName, stockSearchUrl,
} from './ai_state.js';
import {
    readyRoot, listDir, readFile, readFileBinary, writeFile, appendFile, workspacePermission,
} from './fsa.js';
import { parquetMetadataAsync, parquetSchema, parquetReadObjects, toJson } from '../vendor/hyparquet/index.js';
import { compressors } from '../vendor/hyparquet/compressors.js';
import { xiaoshiSearchStock, xiaoshiDailyKline, xiaoshiQuote, getSettingApiKey as getXiaoshiApiKey } from '../stock/xiaoshi_stock_kline.js';
import { getMarketDaily as adataGetMarketDaily, getMarketEtfDaily as adataGetMarketEtfDaily } from '../stock/adata_stock_kline.js';
import { batchQuotes } from '../../js/xiaoshi_realtime_quote.js';
import { parseCronExpr, nextTradingCronTimes } from '../../shared/cron.js';
import { bridgeRequest, bridgeHealth } from './bridge_client.js';

export const TOOL_DEFS = [
    { type: 'function', function: { name: 'get_stock_list', description: '读取股票列表：不传 portfolio 读当前活动组合；传组合名读指定组合（组合名可用 get_portfolios 查询）', parameters: { type: 'object', properties: { portfolio: { type: 'string', description: '组合名，如「持仓」「观察」；缺省为当前活动组合' } }, required: [] } } },
    { type: 'function', function: { name: 'get_portfolios', description: '读取全部持仓组合结构（各组合名称与股票数量）及当前活动组合', parameters: { type: 'object', properties: {}, required: [] } } },
    { type: 'function', function: { name: 'switch_portfolio', description: '切换当前活动组合（影响插件弹窗显示与定时监控范围），先校验组合是否存在', parameters: { type: 'object', properties: { name: { type: 'string', description: '目标组合名' } }, required: ['name'] } } },
    { type: 'function', function: { name: 'get_key_points', description: '读取交易要点列表（要点内容与权重）', parameters: { type: 'object', properties: {}, required: [] } } },
    { type: 'function', function: { name: 'get_events', description: '读取事件记录列表（关联要点/内容/日期/状态）。默认只返回未归档事件；仅当用户明确要求查看全部（含已归档）时才传 include_archived=true。返回项中 duplicateDates 列出与该项内容相同但日期不同的其他事件日期，供识别重复事件。若存在超 7 天且状态为准确/误判的未归档事件，会一并自动归档并在 remind 中说明；超 7 天仍为待预测的事件会嘱你在回复中提醒用户修改状态', parameters: { type: 'object', properties: { include_archived: { type: 'boolean', description: '是否返回全部事件（含已归档），缺省 false 仅未归档' } }, required: [] } } },
    { type: 'function', function: { name: 'create_key_point', description: '创建一条交易要点（内容 + 权重 1-99）', parameters: { type: 'object', properties: { text: { type: 'string', description: '要点内容' }, weight: { type: 'number', description: '权重 1-99' } }, required: ['text', 'weight'] } } },
    { type: 'function', function: { name: 'update_key_point', description: '修改要点（按原文定位；改动内容不影响已关联该要点的历史事件）', parameters: { type: 'object', properties: { old_text: { type: 'string', description: '要修改的要点原文' }, text: { type: 'string', description: '新的要点内容' }, weight: { type: 'number', description: '新的权重 1-99' } }, required: ['old_text', 'text', 'weight'] } } },
    { type: 'function', function: { name: 'delete_key_point', description: '删除一条要点（不删除其关联事件）', parameters: { type: 'object', properties: { text: { type: 'string', description: '要删除的要点内容' } }, required: ['text'] } } },
    { type: 'function', function: { name: 'create_event', description: '创建一条预测事件。事件内容(content)只填股票名称（如「百通能源」），禁止把分析/预测/操作文字写入 content；判断逻辑、时间与操作应体现为关联要点。关联要点(key_point_text)须优先从 get_key_points 已有的要点中选择（拿不准先用 get_key_points 查看现有要点再对应关联，不要臆造不存在的要点内容），现有要点与意图不完全匹配时才新建要点或留空。time 为 YYYY-MM-DD，缺省今天。若存在超过一周仍未归档的事件会一并提醒用户补充', parameters: { type: 'object', properties: { key_point_text: { type: 'string', description: '关联现有业已存在或本次新建的要点内容，可为空' }, content: { type: 'string', description: '事件内容，仅填股票名称' }, time: { type: 'string', description: '事件日期 YYYY-MM-DD' } }, required: ['content'] } } },
    { type: 'function', function: { name: 'update_event', description: '修改事件（按 id；已归档事件不可修改），可改关联要点/内容/日期/status（pending 待预测 / accurate 准确 / wrong 误判）。不能设置归档——归档只发生在手动点击或事件超 7 天且状态为准确/误判时自动进行，若刚改状态的事件因此被自动归档，结果会说明。当存在多条内容相同的事件时，默认修改其中 time 最早（最久远）的那条 id，并在回复中简略提醒用户还有其它日期存在相同内容事件', parameters: { type: 'object', properties: { id: { type: 'string', description: '事件 id（用 get_events 查询）' }, key_point_text: { type: 'string', description: '新的关联要点' }, content: { type: 'string', description: '新的事件内容' }, time: { type: 'string', description: '新的事件日期 YYYY-MM-DD' }, status: { type: 'string', description: '新状态：pending 待预测 / accurate 准确 / wrong 误判' } }, required: ['id'] } } },
    { type: 'function', function: { name: 'delete_event', description: '删除一条事件（按 id）', parameters: { type: 'object', properties: { id: { type: 'string', description: '事件 id（用 get_events 查询）' } }, required: ['id'] } } },
    { type: 'function', function: { name: 'add_stock_to_portfolio', description: '按名称向指定组合添加一只股票（组合缺省「持仓」）。自动生成问财搜索页作为监控地址，ETF（159/51/58 开头）走雪球个股页', parameters: { type: 'object', properties: { name: { type: 'string', description: '股票名称' }, portfolio: { type: 'string', description: '目标组合名，缺省「持仓」' } }, required: ['name'] } } },
    { type: 'function', function: { name: 'move_stock_to_combo', description: '把股票从来源组合移动到目标组合（按名称匹配、忽略首尾空格；来源缺省当前活动组合，目标缺省「观察」）。用于记录「卖出」等调仓：卖出时应传 source_portfolio 为实际持有该股的组合（通常「持仓」）；若目标组合已存在同名股票，则仅从来源组合删除、不重复添加', parameters: { type: 'object', properties: { name: { type: 'string', description: '股票名称' }, target_portfolio: { type: 'string', description: '目标组合名，缺省「观察」' }, source_portfolio: { type: 'string', description: '来源组合名（卖出的实际持仓组合），缺省当前活动组合' } }, required: ['name'] } } },
    { type: 'function', function: { name: 'get_current_view', description: '读取当前列表视图（股票列表或垃圾池）', parameters: { type: 'object', properties: {}, required: [] } } },
    { type: 'function', function: { name: 'get_settings', description: '读取扩展全局设置（刷新间隔/选择器/分页/cron 定时任务，不含任何密钥）', parameters: { type: 'object', properties: {}, required: [] } } },
    { type: 'function', function: { name: 'update_cron', description: '直接修改 Cron 并返回新配置和后续执行时间', parameters: { type: 'object', properties: { operation: { type: 'string', enum: ['add', 'update', 'delete', 'enable', 'disable'] }, target: { type: 'string', description: '任务序号、任务 ID 或当前表达式；新增时可省略' }, expr: { type: 'string', description: '目标 Cron 表达式；删除时省略' } }, required: ['operation'] } } },
    { type: 'function', function: { name: 'save_memory', description: '保存一条长期记忆（用户偏好/习惯等），之后每轮对话都会注入；同时更新当前工作目录 flit/memory.md', parameters: { type: 'object', properties: { content: { type: 'string', description: '要记住的内容' } }, required: ['content'] } } },
    { type: 'function', function: { name: 'refresh_all', description: '触发扩展全量刷新全部组合股票（按全局设置的数据获取方式执行）', parameters: { type: 'object', properties: {}, required: [] } } },
    { type: 'function', function: { name: 'list_workspaces', description: '列出已授权的全部工作目录（主目录与附加目录）及其权限状态', parameters: { type: 'object', properties: {}, required: [] } } },
    { type: 'function', function: { name: 'list_dir', description: '列出工作目录（或子目录）内容。root 缺省为主目录，可传附加目录名；软链接条目无法访问（浏览器安全限制）', parameters: { type: 'object', properties: { path: { type: 'string', description: '相对所选目录的路径，空为根目录' }, root: { type: 'string', description: '工作目录名，可用 list_workspaces 查询；缺省为主目录' } }, required: [] } } },
    { type: 'function', function: { name: 'read_file', description: '读取工作目录中的文本文件内容，支持 Markdown、JSON、JavaScript、CSS、TXT、CSV 等文本文件；路径相对当前工作区；内容过长时会截断', parameters: { type: 'object', properties: { path: { type: 'string' }, root: { type: 'string' } }, required: ['path'] } } },
    { type: 'function', function: { name: 'read_parquet', description: '读取工作目录中的 Parquet 数据文件，返回列名、总行数和限定数量的行。适合查询股票日线等 parquet 数据；path 必须是相对授权工作目录的路径，root 缺省为主目录。默认最多返回 100 行，可用 columns 选择列。', parameters: { type: 'object', properties: { path: { type: 'string', description: '相对工作目录的 .parquet 文件路径' }, root: { type: 'string', description: '工作目录名，缺省为主目录' }, columns: { type: 'array', items: { type: 'string' }, description: '要读取的列名；缺省读取全部列' }, row_start: { type: 'integer', minimum: 0, description: '起始行，缺省 0' }, limit: { type: 'integer', minimum: 1, maximum: 500, description: '最多返回行数，缺省 100，最大 500' } }, required: ['path'] } } },
    { type: 'function', function: { name: 'read_stock_kline', description: '获取股票近 N 天日线 K 线（开/高/低/收/成交量/成交额/涨跌幅）。优先读取工作目录 parquet 缓存（data/a_share_daily/qfq/data_*.parquet，小石量化数据）；当缓存缺少最近交易日数据时自动调用小石量化 API 补齐。支持按股票名称或代码。', parameters: { type: 'object', properties: { name: { type: 'string', description: '股票名称，如「德明利」；与 code 二选一' }, code: { type: 'string', description: '股票代码：6 位数字（如 001309）或带市场后缀（如 001309.SZ），不要使用 SH:600519 等冒号前缀形式；与 name 二选一' }, days: { type: 'integer', minimum: 1, maximum: 60, description: '近 N 个交易日，缺省 30' }, root: { type: 'string', description: '工作目录名，缺省为主目录（parquet 数据目录的根，如含 data/a_share_daily 的目录）' } }, required: [] } } },
    { type: 'function', function: { name: 'read_stocks_kline', description: '批量获取多只股票近 N 个交易日的日线「派生指标摘要」（收盘/涨跌幅/MA5・10・20/距 20 日高点回撤/量比/连续下跌天数/缩量天数/振幅/换手/近 5 日收盘），一次调用代替逐只 read_stock_kline；多只股票必须优先用本工具。detail=true 才附带原始 OHLCV 行。', parameters: { type: 'object', properties: { names: { type: 'array', items: { type: 'string' }, description: '股票名称数组，最多 12 只' }, codes: { type: 'array', items: { type: 'string' }, description: '股票代码数组（6 位或带 .SZ/.SH 后缀），可与 names 混用' }, days: { type: 'integer', minimum: 1, maximum: 60, description: '近 N 个交易日，缺省 18' }, detail: { type: 'boolean', description: 'true 时返回原始 K 线行，缺省 false 只返回摘要' }, max_rows: { type: 'integer', minimum: 1, maximum: 18, description: 'detail=true 时每只最多返回行数，缺省 5' }, root: { type: 'string', description: '工作目录名，缺省为主目录' } }, required: [] } } },
    { type: 'function', function: { name: 'get_stock_quote', description: '获取股票实时行情（最新价/涨跌幅/昨收/最高/最低/成交量/成交额/换手率），不经页面直接调用小石实时行情接口。支持按股票名称或代码。', parameters: { type: 'object', properties: { name: { type: 'string', description: '股票名称，如「德明利」；与 code 二选一' }, code: { type: 'string', description: '股票代码：6 位数字（如 001309）或带市场后缀（如 001309.SZ），不要使用 SH:600519 等冒号前缀形式；与 name 二选一' } }, required: [] } } },
    { type: 'function', function: { name: 'get_portfolio_quotes', description: '批量获取指定组合全部股票的实时行情（最新价/涨跌幅/昨收/最高/最低/成交量/成交额/换手率）。一次调用返回所有股票，无需逐只查询', parameters: { type: 'object', properties: { portfolio: { type: 'string', description: '组合名，如「持仓」「观察」；缺省为当前活动组合' } }, required: [] } } },

    { type: 'function', function: { name: 'write_file', description: '自动创建或覆盖当前工作目录下 flit/ 子目录中的文件，用于维护 memory.md、config.json、脚本和用户适配文件；无需额外确认', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, root: { type: 'string' } }, required: ['path', 'content'] } } },
    { type: 'function', function: { name: 'append_file', description: '自动向当前工作目录下 flit/ 子目录中的文件追加内容，不存在则创建；用于积累长期记忆和适配记录，无需额外确认', parameters: { type: 'object', properties: { path: { type: 'string', description: '相对工作目录的文件路径，必须以 flit/ 开头' }, content: { type: 'string' }, root: { type: 'string' } }, required: ['path', 'content'] } } },
    { type: 'function', function: { name: 'get_workspace_context', description: '读取当前工作区的结构化配置摘要，优先读取 flit/config.json 和 flit/memory.md，并直接返回 flit/memory.md 内容及 flit/workflow/ 文件清单；返回 candidate 或 unknown 不代表数据库连接已验证，需由 Agent 继续检查工作区配置文件/脚本并实际验证连接', parameters: { type: 'object', properties: { include: { type: 'array', items: { type: 'string' } }, refresh: { type: 'boolean' } }, required: [] } } },
    { type: 'function', function: { name: 'discover_database_schema', description: '读取当前本地数据库真实表和字段结构，避免猜测字段名；结果仅返回结构化 schema 摘要', parameters: { type: 'object', properties: { source: { type: 'string' }, timeout_ms: { type: 'integer' } }, required: [] } } },
    { type: 'function', function: { name: 'query_local_database', description: '使用当前工作区配置查询本地数据库，返回结构化 JSON 行，无需读取记忆文件或拼接 Docker/PowerShell 命令', parameters: { type: 'object', properties: { sql: { type: 'string' }, source: { type: 'string' }, columns: { type: 'array', items: { type: 'string' } }, timeout_ms: { type: 'integer' }, debug: { type: 'boolean' } }, required: ['sql'] } } },
    { type: 'function', function: { name: 'save_workspace_database_config', description: '保存已验证可用的完整数据库连接配置到 flit/config.json，并自动创建 flit/.gitignore 忽略 config.json；仅在数据库连接实际验证成功后调用，凭据不会写入记忆文件', parameters: { type: 'object', properties: { config: { type: 'object', description: '完整工作区配置对象，必须包含 data_sources；可包含 version、market 等字段' }, source: { type: 'object', description: '已验证的数据源对象，包含 name、type、access、host、port、database、user、password 或 url 等实际连接字段' } }, required: ['source'] } } },
    { type: 'function', function: { name: 'record_workspace_memory', description: '按固定格式将不含凭据的已确认经验追加到 flit/memory.md；文件最上方必须保留“## 数据库连接状态”并优先记录连接是否已验证，后续记录 workflow 入口和查询约定；若经验对应可复用流程，先创建 flit/workflow/ 下描述清晰的通用流程，再登记入口；不能修改 flit/ 之外的文件', parameters: { type: 'object', properties: { content: { type: 'string' }, database_status: { type: 'string', enum: ['verified', 'unverified', 'unknown'], description: '当前数据库连接状态；已实际连接成功时传 verified' } }, required: ['content'] } } },
    { type: 'function', function: { name: 'run_workspace_process', description: '在当前工作目录内执行程序或脚本；cwd 使用相对路径，可执行 flit/ 外已有脚本和 flit/ 内新建脚本，支持 Python、Node、Git、Docker 等。禁止用此工具启动 flit_bridge；桥接未启动时必须把 bridge_health 返回的 pwsh 启动命令原样输出给用户，让用户自行执行后再继续', parameters: { type: 'object', properties: { program: { type: 'string' }, argv: { type: 'array', items: { type: 'string' } }, cwd: { type: 'string' }, stdin: { type: 'string' }, timeout_ms: { type: 'integer' } }, required: ['program'] } } },
    { type: 'function', function: { name: 'bridge_health', description: '检查本地 flit_bridge HTTP 服务是否在线。若未启动，只返回供用户手动执行的 pwsh 启动命令；Agent 不得调用任何工具自行启动桥接服务', parameters: { type: 'object', properties: {}, required: [] } } },
];

export const TOOL_GROUPS = {
    portfolio: ['get_stock_list', 'get_portfolios', 'switch_portfolio', 'add_stock_to_portfolio', 'move_stock_to_combo', 'get_current_view'],
    market: ['get_stock_quote', 'get_portfolio_quotes', 'refresh_all', 'read_stock_kline', 'read_stocks_kline'],
    events: ['get_key_points', 'create_key_point', 'update_key_point', 'delete_key_point', 'get_events', 'create_event', 'update_event', 'delete_event'],
    settings: ['get_settings', 'update_cron'],
    workspace: ['list_workspaces', 'list_dir', 'read_file', 'write_file', 'append_file', 'read_parquet'],
    memory: ['save_memory'],
    bridge: ['get_workspace_context', 'discover_database_schema', 'query_local_database', 'save_workspace_database_config', 'record_workspace_memory', 'run_workspace_process', 'bridge_health'],
};
export const TOOL_GROUP_RULES = {
    portfolio: '组合和股票工具：需要组合名时先读取组合结构，按用户指定组合操作。',
    market: '行情工具：实时行情批量用 get_portfolio_quotes（一次返回组合全部股票）；多只股票日线用 read_stocks_kline（一次返回多只派生指标摘要），仅单只需要看原始 OHLCV 时才用 read_stock_kline。',
    events: '要点/事件工具：先读取已有要点；事件 content 只写股票名称。',
    settings: '设置工具：仅 Cron 可修改；修改前校验表达式，成功后立即生效。',
    workspace: '工作区工具：root 用目录名定位，只访问用户已授权目录；Agent 可直接维护当前工作目录下的 flit/ 文件。',
    memory: '记忆工具：仅保存用户明确要求长期记住的偏好。',
    bridge: '桥接工具：优先使用结构化工作区上下文和数据库 schema 查询；Agent 只能写 flit/，但可读取和执行工作目录其他目录中的已有脚本。低 Token 固定链路：先调用 get_workspace_context；若返回 config 或 memory，先使用其中的 verified_connection、database 和 workflows，不要重复读取旧文档；有匹配 workflow 时先 read_file 该流程，按其表结构和基础 SQL 执行，除非查询失败或流程明确要求，否则跳过 discover_database_schema。只有 config/memory/workflow 都不足时，才用 list_dir/read_file 搜索其他配置和脚本。发现错误时将修正经验记录到 flit/memory.md。数据库查询任务只有在“数据查询成功、连接配置已验证并保存（若原先不存在）、可复用流程已封装（若值得复用）、memory.md 已登记入口”后才算完成；不得只返回数据就结束。连接验证成功后必须调用 save_workspace_database_config 保存完整配置，该工具会同时创建 flit/.gitignore 并忽略 config.json。workflow 必须使用通用、可复用标题和文件名，不得绑定具体股票名称或本次日期，例如“查询股票近 N 个交易日行情”；内容必须包含适用条件、已验证连接/数据源名称（不得包含密码）、相关表及关键字段、历史表与当日快照的优先级和去重规则、可替换参数、可直接执行的基础 SQL，以及何时需要重新 discover_database_schema。若本次已验证出值得复用的正确执行流程，先创建 flit/workflow/ 下该流程，再调用 record_workspace_memory；memory.md 必须遵循固定格式，最上方先写“## 数据库连接状态”，明确 verified/unverified/unknown，随后只记录不含凭据的 workflow 入口、用途和触发条件；不要把完整过程、失败尝试或 SQL 结果重复写入记忆。桥接服务未启动时，bridge_health 会返回 pwsh 启动命令；此时必须停止工具调用，只把命令和“请用户执行后重试”告知用户，绝对禁止通过 run_workspace_process 或其他工具启动 flit_bridge。',
};
export const TOOL_BY_NAME = new Map(TOOL_DEFS.map(def => [def.function.name, def]));
// 工具组一行摘要（进系统提示）；详细规则不重复列，由 load_tool_group 返回的 rule 字段给出（T1-4 去重）
export const TOOL_GROUP_SUMMARY = {
    portfolio: '组合/股票列表增删改查、切换活动组合与视图',
    market: '实时行情与日线取数（一律优先批量）',
    events: '交易要点与预测事件维护',
    settings: '全局设置（仅 Cron 可改）',
    workspace: '工作目录文件读写与 parquet 查询',
    memory: '长期记忆保存',
    bridge: '本地脚本执行与本地数据库查询',
};
export const TOOL_GROUP_DEF = {
    type: 'function',
    function: {
        name: 'load_tool_group',
        description: '按需加载一组工具定义',
        parameters: {
            type: 'object',
            properties: { group: { type: 'string', enum: Object.keys(TOOL_GROUPS) } },
            required: ['group'],
        },
    },
};
export const TOOL_CATALOG = Object.keys(TOOL_GROUPS).map(group => `${group}: ${TOOL_GROUP_SUMMARY[group] || TOOL_GROUP_RULES[group]}`).join('\n');

export function getLoadedToolDefs() {
    const names = new Set();
    for (const group of state.activeToolGroups) {
        for (const name of TOOL_GROUPS[group] || []) names.add(name);
    }
    return [...names].map(name => {
        const def = TOOL_BY_NAME.get(name);
        if (!def) return null;
        const compact = structuredClone(def);
        compact.function.description = name.replaceAll('_', ' ');
        for (const property of Object.values(compact.function.parameters?.properties || {})) {
            delete property.description;
        }
        return compact;
    }).filter(Boolean);
}

// 工具执行器
export const toolExecutors = {
    async get_stock_list(args) {
        const portfolio = args && args.portfolio ? String(args.portfolio).trim() : '';
        if (!portfolio) {
            const { stockList } = await storageGet(chrome.storage.local, 'stockList');
            return summarizeList(stockList || [], pickStockView);
        }
        const { portfolios } = await storageGet(chrome.storage.local, 'portfolios');
        const p = (portfolios || {})[portfolio];
        if (!p) {
            return { error: `组合「${portfolio}」不存在`, available: Object.keys(portfolios || {}) };
        }
        return summarizeList(p.stockList || [], pickStockView);
    },
    async get_portfolios() {
        const { portfolios, activePortfolio } = await storageGet(chrome.storage.local, ['portfolios', 'activePortfolio']);
        const names = Object.keys(portfolios || {});
        const structure = names.map(name => ({
            name,
            stockCount: (portfolios[name].stockList || []).length,
            selectorName: portfolios[name].selectorName || 'wc1',
        }));
        return { activePortfolio: activePortfolio || '', structure };
    },
    async switch_portfolio(args) {
        const name = String(args.name || '').trim();
        if (!name) return { error: '缺少组合名' };
        const { portfolios } = await storageGet(chrome.storage.local, ['portfolios']);
        const p = (portfolios || {})[name];
        if (!p) {
            return { error: `组合「${name}」不存在`, available: Object.keys(portfolios || {}) };
        }
        const stockList = p.stockList || [];
        const selectorName = p.selectorName || 'wc1';
        await storageSet(chrome.storage.local, { activePortfolio: name, stockList });
        await storageSet(chrome.storage.sync, { selectorName });
        chrome.runtime.sendMessage({ action: 'refresh' });
        return { ok: true, activePortfolio: name, stockCount: stockList.length };
    },
    async get_key_points() {
        const denied = await requireKeyPoints();
        if (denied) return denied;
        const { keyPoints } = await storageGet(chrome.storage.local, 'keyPoints');
        return summarizeList(keyPoints || [], kp => ({ text: kp.text, weight: kp.weight }));
    },
    async get_events(args) {
        const denied = await requireKeyPoints();
        if (denied) return denied;
        const { events } = await storageGet(chrome.storage.local, 'events');
        const list = events || [];
        const { remind, archivedCount } = autoArchiveEvents(list);
        if (archivedCount > 0) await storageSet(chrome.storage.local, { events: list });
        const includeAll = !!(args && args.include_archived);
        const target = includeAll ? list : list.filter(e => !e.archived);
        const contentDates = new Map();
        for (const e of target) {
            if (!contentDates.has(e.content)) contentDates.set(e.content, []);
            contentDates.get(e.content).push(e.time);
        }
        const result = summarizeList(target, e => ({
            id: e.id,
            keyPointText: e.keyPointText || '',
            content: e.content,
            time: e.time,
            status: e.status,
            archived: !!e.archived,
            duplicateDates: (contentDates.get(e.content) || []).filter(t => t !== e.time),
        }));
        if (remind) result.remind = remind;
        return result;
    },
    async create_key_point(args) {
        const denied = await requireKeyPoints();
        if (denied) return denied;
        const text = String(args.text || '').trim();
        const weight = parseInt(args.weight, 10);
        if (!text) return { error: '要点内容不能为空' };
        if (!Number.isFinite(weight) || weight < 1 || weight > 99) return { error: '权重必须为 1-99 的数字' };
        const { keyPoints } = await storageGet(chrome.storage.local, 'keyPoints');
        const list = keyPoints || [];
        if (list.some(k => k.text === text)) return { error: `要点「${text}」已存在` };
        list.push({ text, weight });
        await storageSet(chrome.storage.local, { keyPoints: list });
        return { ok: true, text, weight, total: list.length };
    },
    async update_key_point(args) {
        const denied = await requireKeyPoints();
        if (denied) return denied;
        const oldText = String(args.old_text || '').trim();
        const text = String(args.text || '').trim();
        const weight = parseInt(args.weight, 10);
        if (!oldText || !text) return { error: 'old_text 与 text 不能为空' };
        if (!Number.isFinite(weight) || weight < 1 || weight > 99) return { error: '权重必须为 1-99 的数字' };
        const { keyPoints } = await storageGet(chrome.storage.local, 'keyPoints');
        const list = keyPoints || [];
        const idx = list.findIndex(k => k.text === oldText);
        if (idx === -1) return { error: `要点「${oldText}」不存在` };
        list[idx] = { text, weight };
        await storageSet(chrome.storage.local, { keyPoints: list });
        return { ok: true, text, weight };
    },
    async delete_key_point(args) {
        const denied = await requireKeyPoints();
        if (denied) return denied;
        const text = String(args.text || '').trim();
        if (!text) return { error: '要点内容不能为空' };
        const { keyPoints } = await storageGet(chrome.storage.local, 'keyPoints');
        const list = keyPoints || [];
        if (!list.some(k => k.text === text)) return { error: `要点「${text}」不存在` };
        await storageSet(chrome.storage.local, { keyPoints: list.filter(k => k.text !== text) });
        return { ok: true, text };
    },
    async create_event(args) {
        const denied = await requireKeyPoints();
        if (denied) return denied;
        const content = String(args.content || '').trim();
        if (!content) return { error: '事件内容不能为空' };
        const keyPointText = String(args.key_point_text || '').trim();
        if (keyPointText) {
            const { keyPoints } = await storageGet(chrome.storage.local, 'keyPoints');
            if (!(keyPoints || []).some(k => k.text === keyPointText)) {
                return { error: `关联要点「${keyPointText}」不存在，可先用 get_key_points 查看现有要点` };
            }
        }
        let time = String(args.time || '').trim();
        if (!time) time = todayStr();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(time)) return { error: 'time 需为 YYYY-MM-DD 格式' };
        const { events } = await storageGet(chrome.storage.local, 'events');
        const list = events || [];
        const { remind } = autoArchiveEvents(list);
        const event = { id: genUid('ev'), keyPointText, content, time, status: 'pending', archived: false };
        list.push(event);
        await storageSet(chrome.storage.local, { events: list });
        const result = { ok: true, event, total: list.length };
        if (remind) result.remind = remind;
        return result;
    },
    async update_event(args) {
        const denied = await requireKeyPoints();
        if (denied) return denied;
        const id = String(args.id || '').trim();
        if (!id) return { error: '缺少事件 id' };
        const { events, keyPoints } = await storageGet(chrome.storage.local, ['events', 'keyPoints']);
        const list = events || [];
        const ev = list.find(e => e.id === id);
        if (!ev) return { error: `事件 ${id} 不存在` };
        if (ev.archived) return { error: '该事件已归档，不可修改' };
        if (args.key_point_text !== undefined) {
            const kp = String(args.key_point_text).trim();
            if (kp && !(keyPoints || []).some(k => k.text === kp)) {
                return { error: `关联要点「${kp}」不存在` };
            }
            ev.keyPointText = kp;
        }
        if (args.content !== undefined) {
            const c = String(args.content).trim();
            if (!c) return { error: '事件内容不能为空' };
            ev.content = c;
        }
        if (args.time !== undefined) {
            const t = String(args.time).trim();
            if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return { error: 'time 需为 YYYY-MM-DD 格式' };
            ev.time = t;
        }
        if (args.status !== undefined) {
            if (!['pending', 'accurate', 'wrong'].includes(args.status)) return { error: 'status 需为 pending / accurate / wrong' };
            ev.status = args.status;
        }
        const { remind, archivedCount } = autoArchiveEvents(list);
        await storageSet(chrome.storage.local, { events: list });
        const result = { ok: true, event: ev };
        if (archivedCount > 0) result.archivedNow = archivedCount;
        if (remind) result.remind = remind;
        return result;
    },
    async delete_event(args) {
        const denied = await requireKeyPoints();
        if (denied) return denied;
        const id = String(args.id || '').trim();
        if (!id) return { error: '缺少事件 id' };
        const { events } = await storageGet(chrome.storage.local, 'events');
        const list = events || [];
        if (!list.some(e => e.id === id)) return { error: `事件 ${id} 不存在` };
        await storageSet(chrome.storage.local, { events: list.filter(e => e.id !== id) });
        return { ok: true, id };
    },
    async add_stock_to_portfolio(args) {
        const name = String(args.name || '').trim();
        if (!name) return { error: '股票名称不能为空' };
        const portfolio = String(args.portfolio || '持仓').trim();
        const { portfolios, activePortfolio, stockList } = await storageGet(chrome.storage.local, ['portfolios', 'activePortfolio', 'stockList']);
        const combos = portfolios || {};
        const target = combos[portfolio];
        if (!target) return { error: `组合「${portfolio}」不存在`, available: Object.keys(combos) };
        const list = target.stockList || (target.stockList = []);
        const url = stockSearchUrl(name);
        if (list.some(s => String(s.url || '') === url)) return { error: `「${name}」已在组合「${portfolio}」中` };
        list.push({
            url, name: '', code: '', prefix: '',
            startPrice: null, currentPrice: null, percent: null,
            importPrice: null,
            targetPercentLe: null, targetPercentGe: null,
            importTargetPercentLe: null, importTargetPercentGe: null,
            stopRunning: false, notifiedDaily: false, notifiedImport: false,
            inTrash: false, pinned: false, pinOrder: null, createdAt: Date.now(),
        });
        const mirror = (combos[activePortfolio] && combos[activePortfolio].stockList) || stockList || [];
        await storageSet(chrome.storage.local, { portfolios: combos, stockList: mirror });
        chrome.runtime.sendMessage({ action: 'refreshOne', url });
        return { ok: true, name, portfolio, url, hint: '已按手动添加流程保存并立即抓取回填' };
    },
    async move_stock_to_combo(args) {
        const name = String(args.name || '').trim();
        if (!name) return { error: '股票名称不能为空' };
        const target = String(args.target_portfolio || '观察').trim();
        const { portfolios, activePortfolio } = await storageGet(chrome.storage.local, ['portfolios', 'activePortfolio']);
        const combos = portfolios || {};
        if (!combos[target]) return { error: `目标组合「${target}」不存在`, available: Object.keys(combos) };
        let from = args.source_portfolio ? String(args.source_portfolio).trim() : (combos[activePortfolio] ? activePortfolio : null);
        if (from && !combos[from]) return { error: `来源组合「${from}」不存在` };
        let stock = null;
        if (from) stock = findStockByName(combos[from].stockList, name);
        if (!stock) {
            for (const [cn, c] of Object.entries(combos)) {
                const hit = findStockByName(c.stockList, name);
                if (hit) { stock = hit; from = cn; break; }
            }
        }
        if (!stock) return { error: `未找到股票「${name}」，可先用「增加股票」加入持仓组合` };
        if (from === target) return { ok: true, name, from, to: target, already: true };
        if (findStockByName(combos[target].stockList, name)) {
            combos[from].stockList = (combos[from].stockList || []).filter(s => s !== stock);
            const mirror = (combos[activePortfolio] && combos[activePortfolio].stockList) || [];
            await storageSet(chrome.storage.local, { portfolios: combos, stockList: mirror });
            chrome.runtime.sendMessage({ action: 'refresh' });
            return { ok: true, name, from, to: target, removed: true, hint: `目标组合「${target}」已有同名股票，已仅从「${from}」删除，未重复添加` };
        }
        combos[from].stockList = (combos[from].stockList || []).filter(s => s !== stock);
        (combos[target].stockList || (combos[target].stockList = [])).push(stock);
        const mirror = (combos[activePortfolio] && combos[activePortfolio].stockList) || [];
        await storageSet(chrome.storage.local, { portfolios: combos, stockList: mirror });
        chrome.runtime.sendMessage({ action: 'refresh' });
        return { ok: true, name, from, to: target };
    },
    async get_current_view() {
        const { currentView } = await storageGet(chrome.storage.local, 'currentView');
        return { currentView: currentView || 'list' };
    },
    async get_settings() {
        const res = await storageGet(chrome.storage.sync, ['refreshInterval', 'selectorName', 'pageSize', 'cronJobs']);
        return {
            refreshInterval: res.refreshInterval ?? null,
            selectorName: res.selectorName ?? null,
            pageSize: res.pageSize ?? null,
            cronJobs: res.cronJobs || [],
        };
    },
    async load_tool_group(args) {
        const group = String(args && args.group || '').trim();
        if (!TOOL_GROUPS[group]) return { ok: false, error: '未知工具组', groups: Object.keys(TOOL_GROUPS) };
        state.activeToolGroups.add(group);
        return { ok: true, group, rule: TOOL_GROUP_RULES[group], tools: TOOL_GROUPS[group] };
    },
    async update_cron(args) {
        const operation = String(args && args.operation || '').trim();
        const target = String(args && args.target || '').trim();
        const expr = String(args && args.expr || '').trim();
        if (!['add', 'update', 'delete', 'enable', 'disable'].includes(operation)) {
            return { ok: false, error: 'operation 必须是 add/update/delete/enable/disable' };
        }
        if (['add', 'update'].includes(operation) && !expr) return { ok: false, error: '新增或修改必须提供 expr' };
        if (expr && !parseCronExpr(expr)) return { ok: false, error: 'Cron 表达式无效' };
        const res = await storageGet(chrome.storage.sync, 'cronJobs');
        const jobs = Array.isArray(res.cronJobs) ? res.cronJobs : [];
        const index = target && /^\d+$/.test(target)
            ? Number(target) - 1
            : jobs.findIndex(job => job.id === target || job.expr === target);
        if (operation !== 'add' && (index < 0 || index >= jobs.length)) return { ok: false, error: '目标 Cron 任务不存在' };
        if (operation === 'add' && jobs.length >= 3) return { ok: false, error: '最多只能有 3 个 Cron 任务' };
        const nextJobs = jobs.map(job => ({ ...job }));
        if (operation === 'add') nextJobs.push({ id: genUid('cron'), expr, enabled: true });
        if (operation === 'update') nextJobs[index].expr = expr;
        if (operation === 'enable') nextJobs[index].enabled = true;
        if (operation === 'disable') nextJobs[index].enabled = false;
        if (operation === 'delete') nextJobs.splice(index, 1);
        const previewId = genUid('preview');
        const previewExpr = operation === 'delete' ? null : (operation === 'add' ? expr : nextJobs[index]?.expr);
        const nextRuns = previewExpr ? nextTradingCronTimes(previewExpr, Date.now(), 5) : [];
        await storageSet(chrome.storage.sync, { cronJobs: nextJobs });
        chrome.runtime.sendMessage({ action: 'syncCronJobs' });
        return {
            ok: true, previewId, operation,
            oldJobs: jobs, newJobs: nextJobs,
            expression: previewExpr,
            description: previewExpr ? `Cron ${previewExpr}，实际刷新限制为 09:15-11:30、13:00-15:00` : '删除该 Cron 任务',
            nextRuns: nextRuns.map(ms => new Date(ms).toLocaleString('zh-CN')),
            applied: true,
            message: 'Cron 配置已更新，后台已重新排程',
        };
    },
    async save_memory(args) {
        return addMemory(String(args.content || '').trim());
    },
    async refresh_all() {
        return new Promise((resolve) => {
            chrome.runtime.sendMessage({ action: 'refreshAll' }, (resp) => {
                if (chrome.runtime.lastError || !resp) {
                    resolve({ ok: false, error: '后台无响应' });
                } else {
                    resolve({ ok: true, refreshedCount: resp.count });
                }
            });
        });
    },
    async bridge_health() {
        const result = await bridgeHealth();
        if (result?.error?.code !== 'bridge_unreachable') return result;
        const bridgeDir = state.bridgeDirFullPath || '';
        const startScript = bridgeDir
            ? `${bridgeDir}\\start-server.ps1`
            : '.\\flit_bridge\\start-server.ps1';
        return {
            ...result,
            error: {
                ...result.error,
                message: `${result.error.message}。请在 PowerShell 7 中执行以下命令启动桥接服务：`,
                start_command: `pwsh -NoProfile -File "${startScript}"`,
            },
        };
    },
    async get_workspace_context(args) {
        if (!state.workspaceRootPath) return { ok: false, error: { code: 'workspace_not_found', message: '尚未设置主工作目录' } };
        return bridgeRequest('/v1/workspace/context', {
            workspace_root: state.workspaceRootPath,
            include: args?.include,
            refresh: !!args?.refresh,
        });
    },
    async discover_database_schema(args) {
        if (!state.workspaceRootPath) return { ok: false, error: { code: 'workspace_not_found', message: '尚未设置主工作目录' } };
        return bridgeRequest('/v1/database/schema', {
            workspace_root: state.workspaceRootPath,
            source: args?.source,
            timeout_ms: args?.timeout_ms || 10000,
        }, { timeoutMs: (args?.timeout_ms || 10000) + 3000 });
    },
    async query_local_database(args) {
        if (!state.workspaceRootPath) return { ok: false, error: { code: 'workspace_not_found', message: '尚未设置主工作目录' } };
        const result = await bridgeRequest('/v1/database/query', {
            workspace_root: state.workspaceRootPath,
            source: args?.source,
            sql: String(args?.sql || ''),
            columns: args?.columns,
            timeout_ms: args?.timeout_ms || 10000,
            debug: !!args?.debug,
        }, { timeoutMs: (args?.timeout_ms || 10000) + 3000 });
        if (!result?.ok && result?.error?.code === 'sql_error') {
            result.error.next_action = '先调用 discover_database_schema 查询真实表和字段，再修正 SQL；确认修正后调用 record_workspace_memory 记录经验。';
        }
        return result;
    },
    async save_workspace_database_config(args) {
        if (!state.workspaceRootPath) return { ok: false, error: { code: 'workspace_not_found', message: '尚未设置主工作目录' } };
        const source = args?.source && typeof args.source === 'object' ? { ...args.source } : null;
        if (!source || !source.name || !source.type || !source.access) {
            return { ok: false, error: { code: 'argument_invalid', message: 'source 必须包含已验证的 name、type 和 access' } };
        }
        const dir = await readyRoot(state.workspaceHandles, '');
        let config = args?.config && typeof args.config === 'object' ? { ...args.config } : {};
        if (!args?.config) {
            try {
                const existing = await readFile(dir.handle, 'flit/config.json', Infinity);
                const parsed = JSON.parse(existing.content);
                if (parsed && typeof parsed === 'object') config = parsed;
            } catch { }
        }
        if (!Array.isArray(config.data_sources)) config.data_sources = [];
        const index = config.data_sources.findIndex(item => item && item.name === source.name);
        if (index >= 0) config.data_sources[index] = source;
        else config.data_sources.push(source);
        if (!config.version) config.version = 1;
        config.verified_connection = {
            status: 'verified',
            source: source.name,
            verified_at: new Date().toISOString(),
        };
        await writeFile(dir.handle, 'flit/config.json', JSON.stringify(config, null, 2) + '\n');

        let gitignore = '';
        try { gitignore = (await readFile(dir.handle, 'flit/.gitignore', Infinity)).content; } catch { }
        const entries = gitignore.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
        if (!entries.includes('config.json')) entries.push('config.json');
        await writeFile(dir.handle, 'flit/.gitignore', entries.join('\n') + '\n');
        return { ok: true, config_path: 'flit/config.json', gitignore_path: 'flit/.gitignore', source: { name: source.name, type: source.type, access: source.access } };
    },
    async record_workspace_memory(args) {
        if (!state.workspaceRootPath) return { ok: false, error: { code: 'workspace_not_found', message: '尚未设置主工作目录' } };
        return bridgeRequest('/v1/workspace/memory', {
            workspace_root: state.workspaceRootPath,
            content: String(args?.content || ''),
            database_status: args?.database_status,
        });
    },
    async run_workspace_process(args) {
        if (!state.workspaceRootPath) return { ok: false, error: { code: 'workspace_not_found', message: '尚未设置主工作目录' } };
        return bridgeRequest('/v1/process', {
            workspace_root: state.workspaceRootPath,
            program: String(args?.program || ''),
            argv: Array.isArray(args?.argv) ? args.argv : [],
            cwd: String(args?.cwd || '.'),
            stdin: String(args?.stdin || ''),
            timeoutMs: args?.timeout_ms || 300000,
        }, { timeoutMs: (args?.timeout_ms || 300000) + 3000 });
    },
    async list_workspaces() {
        const dirs = [];
        for (let i = 0; i < state.workspaceHandles.length; i++) {
            const d = state.workspaceHandles[i];
            dirs.push({ name: d.name, isPrimary: i === 0, permission: await workspacePermission(d.handle) });
        }
        return { workspaces: dirs, hint: 'root 参数用目录名寻址；软链接不可访问，可把软链接指向的真实目录「添加目录」为附加根' };
    },
    async list_dir(args) {
        const dir = await readyRoot(state.workspaceHandles, args && args.root);
        return listDir(dir.handle, args && args.path || '');
    },
    async read_file(args) {
        const path = String(args && args.path || '').replace(/^[\\/]+/, '');
        const isBridgeFile = false;
        const dir = isBridgeFile
            ? { name: state.bridgeHandle?.name || 'flit_bridge', handle: state.bridgeHandle }
            : await readyRoot(state.workspaceHandles, args && args.root);
        if (isBridgeFile && !dir.handle) {
            throw new Error('桥接目录未授权，请先在设置中启用 Agent 桥接并授权 flit_bridge 目录');
        }
        const r = await readFile(dir.handle, path);
        return {
            root: dir.name,
            path: r.path,
            size: r.size,
            truncated: r.truncated,
            content: r.truncated ? r.content + '\n（已截断，可让 AI 分段读取）' : r.content,
        };
    },
    async read_parquet(args) {
        const dir = await readyRoot(state.workspaceHandles, args && args.root);
        const relPath = String(args && args.path || '').trim();
        if (!relPath.toLowerCase().endsWith('.parquet')) return { error: 'path 必须指向 .parquet 文件' };
        const limit = Math.min(Math.max(parseInt(args && args.limit, 10) || 100, 1), 500);
        const rowStart = Math.max(parseInt(args && args.row_start, 10) || 0, 0);
        const columns = Array.isArray(args && args.columns) && args.columns.length
            ? args.columns.map(c => String(c)).filter(Boolean) : undefined;
        const binary = await readFileBinary(dir.handle, relPath);
        const metadata = await parquetMetadataAsync(binary.buffer);
        const schema = parquetSchema(metadata);
        const columnNames = (schema.children || []).map(c => c.element.name);
        const selected = columns ? columns.filter(c => columnNames.includes(c)) : undefined;
        if (columns && selected.length !== columns.length) {
            return { error: '指定列不存在', columns: columnNames, missing: columns.filter(c => !columnNames.includes(c)) };
        }
        const rows = await parquetReadObjects({
            file: binary.buffer,
            columns: selected,
            rowStart,
            rowEnd: rowStart + limit,
            compressors,
        });
        return { root: dir.name, path: relPath, size: binary.size, columns: columnNames, totalRows: Number(metadata.num_rows), rowStart, shown: rows.length, rows: toJson(rows) };
    },
    async read_stock_kline(args) {
        const dir = await readyRoot(state.workspaceHandles, args && args.root);
        const days = Math.min(Math.max(parseInt(args && args.days, 10) || 30, 1), 60);
        const resolved = await resolveStockCode(args);
        if (resolved.error) return resolved;
        const { code, name } = resolved;
        const { rows, source, cacheLast, apiRows, apiWarning } = await loadKlineRows(dir.handle, code, days);
        if (!rows.length) {
            return {
                root: dir.name, code, name,
                error: '未读取到该股票数据：parquet 缓存无记录，且小石 / 东方财富接口均拉取失败' + (apiWarning ? '（' + apiWarning + '）' : ''),
            };
        }
        return { root: dir.name, code, name, days, source, cacheLastDate: cacheLast || null, apiLastDate: apiRows.length ? apiRows[apiRows.length - 1].date : null, warning: apiWarning, rows };
    },
    // 批量日线摘要（T1-1）：一年 parquet 文件只读一次（$in 多代码），API 补齐限并发，输出派生指标而不是 OHLCV
    async read_stocks_kline(args) {
        const names = Array.isArray(args && args.names) ? args.names : [];
        const codes = Array.isArray(args && args.codes) ? args.codes : [];
        const want = [];
        for (const n of names) { const v = String(n || '').trim(); if (v) want.push({ name: v }); }
        for (const c of codes) { const v = String(c || '').trim(); if (v) want.push({ code: v, name: '' }); }
        if (!want.length) return { error: 'names 或 codes 至少传一个（字符串数组）' };
        // 超出上限不报错，取前 12 只并把未处理的名单回给模型，省一次往返
        const overflow = want.length > MAX_BATCH_KLINE;
        const targets = overflow ? want.slice(0, MAX_BATCH_KLINE) : want;
        const days = Math.min(Math.max(parseInt(args && args.days, 10) || 18, 1), 60);
        const detail = args && args.detail === true;
        const maxRows = detail ? Math.min(Math.max(parseInt(args && args.max_rows, 10) || 5, 1), 18) : 0;
        let dir;
        try {
            dir = await readyRoot(state.workspaceHandles, args && args.root);
        } catch (err) {
            return { error: '工作目录不可用，无法读取 parquet 缓存：' + (err && err.message || err), hint: '也可用 get_portfolio_quotes 取实时行情' };
        }
        const expected = lastTradingDayStr(new Date());
        // 代码解析并发（名称先本地列表命中，未命中才走小石搜索）
        const resolved = await Promise.all(targets.map(w => resolveStockCode(w)));
        // 一次读年文件：把 N×年数的磁盘 IO 压成 年数
        const codesForCache = resolved.filter(r => r && r.code).map(r => r.code);
        const cacheMap = await readStocksFromParquet(dir.handle, codesForCache, days);
        const stocks = await mapWithLimit(resolved, API_CONCURRENCY, async (r) => {
            if (!r || r.error) return { name: (r && r.name) || null, code: (r && r.code) || null, error: r && r.error || '代码解析失败' };
            const { rows, source, apiWarning } = await fillKlineFromApi(r.code, days, cacheMap.get(r.code) || [], expected);
            if (!rows.length) {
                return { name: r.name || null, code: r.code, error: '无数据（parquet 缓存无记录且接口未补齐）' + (apiWarning ? '：' + apiWarning : '') };
            }
            // 批量路径不带 per-stock warning（文本重复占字），数据源由 source 字段体现
            const item = klineSummary(r.code, r.name, rows, { source });
            if (detail) item.rows = rows.slice(-maxRows);
            return item;
        });
        const failed = stocks.filter(s => s.error).length;
        return {
            days,
            detail: detail ? maxRows : false,
            total: stocks.length,
            failed: failed || undefined,
            truncated: overflow ? {
                上限: MAX_BATCH_KLINE,
                未处理: want.slice(MAX_BATCH_KLINE).map(w => w.name || w.code),
                说明: '只处理了前 ' + MAX_BATCH_KLINE + ' 只，剩下的请再调一次',
            } : undefined,
            warning: stocks.some(s => s.source && s.source !== 'parquet' && s.source !== 'none')
                ? '部分数据不全部来自 parquet 缓存（见各项 source，如 parquet+xiaoshi / adata）' : undefined,
            hint: '指标均为本地从日线行算出；需原始 OHLCV 才传 detail=true 或单只改用 read_stock_kline',
            stocks,
        };
    },
    async get_stock_quote(args) {
        const resolved = await resolveStockCode(args);
        if (resolved.error) return resolved;
        const { code, name } = resolved;
        try {
            const q = await xiaoshiQuote(code, { timeoutMs: 15000 });
            return { code, name, quote: q, warning: q.is_stale ? '行情可能已过期（is_stale=' + q.is_stale + '）' : null };
        } catch (e) {
            return { code, name, error: '小石实时行情拉取失败：' + (e && e.message || e) };
        }
    },
    async get_portfolio_quotes(args) {
        const portfolio = args && args.portfolio ? String(args.portfolio).trim() : '';
        let list;
        if (!portfolio) {
            const { stockList } = await storageGet(chrome.storage.local, 'stockList');
            list = stockList || [];
        } else {
            const { portfolios } = await storageGet(chrome.storage.local, 'portfolios');
            const p = (portfolios || {})[portfolio];
            if (!p) return { error: `组合「${portfolio}」不存在`, available: Object.keys(portfolios || {}) };
            list = p.stockList || [];
        }
        if (!list.length) return { total: 0, quotes: [], hint: '该组合为空' };

        // 改用批量接口（单请求代替 N 次单只调用），按 stock/etf 分桶
        const apiKey = await getXiaoshiApiKey();
        if (!apiKey) {
            return { error: '小石 API Key 未配置，请在扩展「全局设置 → 数据获取方式（小石大数据）」中填写', hint: '也可用 get_stock_quote 单只查询' };
        }

        const codes = []; // { code, name }
        const noCode = [];
        for (const s of list) {
            if (!s.code) { noCode.push(s.name || '(待抓取)'); continue; }
            codes.push({ code: s.code, name: s.name });
        }

        const stocks = codes.filter(c => !/^(159|51|58)\d{3}$/.test(c.code)).map(c => c.code);
        const etfs = codes.filter(c => /^(159|51|58)\d{3}$/.test(c.code)).map(c => c.code);

        const allItems = [];
        const missing = [];
        if (stocks.length) {
            try {
                const r = await batchQuotes(stocks, { apiKey, instrument: 'stock' });
                allItems.push(...r.items);
                if (r.missing_codes) missing.push(...r.missing_codes);
            } catch (e) { dbg('batch stock quotes failed', e); }
        }
        if (etfs.length) {
            try {
                const r = await batchQuotes(etfs, { apiKey, instrument: 'etf' });
                allItems.push(...r.items);
                if (r.missing_codes) missing.push(...r.missing_codes);
            } catch (e) { dbg('batch etf quotes failed', e); }
        }

        const codeMap = new Map(allItems.map(item => [item.code, item]));
        const quotes = codes.map(c => {
            const hit = codeMap.get(c.code);
            if (hit) return {
                name: c.name || hit.name,
                code: hit.code,
                price: hit.price,
                change: hit.change,
                change_pct: hit.change_pct,
                open: hit.open,
                high: hit.high,
                low: hit.low,
                previous_close: hit.last_close,
                volume: hit.volume,
                amount: hit.amount,
                turnover_pct: hit.turnover_pct,
                is_stale: false,
            };
            return { name: c.name, code: c.code, error: '未获取到行情' };
        });
        for (const n of noCode) {
            quotes.push({ name: n, error: '尚未获取到代码' });
        }
        return {
            total: list.length,
            fetched: quotes.filter(q => !q.error).length,
            quotes,
            missing_codes: missing.length ? missing : undefined,
        };
    },
    async write_file(args) {
        if (!args || !args.path) return { ok: false, error: 'path 必填' };
        const cleanPath = args.path.replace(/\\/g, '/').replace(/^\/+/, '');
        if (!cleanPath.startsWith('flit/')) {
            return { ok: false, error: '脚本/文件需放入工作目录下的 flit/ 子目录（如 flit/' + cleanPath + '）' };
        }
        const dir = await readyRoot(state.workspaceHandles, args && args.root);
        return writeFile(dir.handle, args.path, args.content);
    },
    async append_file(args) {
        if (!args || !args.path) return { ok: false, error: 'path 必填' };
        const cleanPath = args.path.replace(/\\/g, '/').replace(/^\/+/, '');
        if (!cleanPath.startsWith('flit/')) {
            return { ok: false, error: '脚本/文件需放入工作目录下的 flit/ 子目录（如 flit/' + cleanPath + '）' };
        }
        const dir = await readyRoot(state.workspaceHandles, args && args.root);
        return appendFile(dir.handle, args.path, args.content);
    },
};

// ============== K 线辅助 ==============

async function resolveStockCode(args) {
    let code = String(args && args.code || '').trim();
    let name = String(args && args.name || '').trim();
    if (!code && !name) return { error: '请提供股票名称或代码（name / code）' };
    if (code) {
        const colonMatch = code.match(/^(SH|SZ|BJ|HK|US):(\d{4,6})$/i);
        if (colonMatch) {
            const suffix = colonMatch[1].toUpperCase();
            return { code: colonMatch[2] + '.' + suffix, name };
        }
        const m = code.match(/^(\d{6})([.](SZ|SH|BJ|HK|US))?$/i);
        if (!m) return { error: '代码格式无效，应为 6 位数字或带后缀如 001309.SZ，不要使用 SH:600519 形式' };
        const digits = m[1];
        const suffix = (m[2] || '').toUpperCase();
        if (suffix) return { code: digits + suffix, name };
        const inferred = digits.startsWith('6') ? digits + '.SH' : digits + '.SZ';
        return { code: inferred, name };
    }
    const { stockList, portfolios } = await storageGet(chrome.storage.local, ['stockList', 'portfolios']);
    const candidates = [...(stockList || [])];
    for (const p of Object.values(portfolios || {})) candidates.push(...(p.stockList || []));
    const hit = findStockByName(candidates, name);
    if (hit && hit.code) {
        const suffix = hit.prefix || (hit.code.startsWith('6') ? 'SH' : 'SZ');
        return { code: hit.code + '.' + suffix, name };
    }
    try {
        const items = await xiaoshiSearchStock(name, { timeoutMs: 15000 });
        const best = items.find(i => i.name === name) || items[0];
        if (best && best.symbol) return { code: best.symbol, name };
        return { error: `未能在小石搜索到「${name}」的股票代码，请核对名称后重试` };
    } catch (e) {
        return { error: `小石搜索接口不可用，无法解析「${name}」的代码：${e && e.message || e}。可改传 6 位代码（如 001309）` };
    }
}

async function readStockFromParquet(rootHandle, code, days) {
    const map = await readStocksFromParquet(rootHandle, [code], days);
    return map.get(code) || [];
}

// 日线列集（与 parquet 缓存列名一致）
const KLINE_COLUMNS = ['code', 'date', 'open', 'high', 'low', 'close', 'volume', 'amount', 'change_pct', 'turnover_pct'];
// 批量取数一次最多几只 / 接口补齐并发度（并发太高会把一年的年文件同时加载多份）
const MAX_BATCH_KLINE = 12;
const API_CONCURRENCY = 4;

// 按年文件批量读多只股票日线：一次 parquet 解析服务多只代码（filter $in），
// 把 N 只 × 年数的磁盘 IO 压成 年数，这是 read_stocks_kline 并发不爆内存的关键
async function readStocksFromParquet(rootHandle, codes, days) {
    const qfqPath = 'data/a_share_daily/qfq';
    const uniq = [...new Set((codes || []).filter(Boolean))];
    const out = new Map(uniq.map(c => [c, []]));
    if (!uniq.length) return out;
    const entries = await listDir(rootHandle, qfqPath).catch(() => []);
    const years = entries
        .filter(e => e.type === 'file' && /^data_(\d{4})\.parquet$/.test(e.name))
        .map(e => e.name.match(/^data_(\d{4})\.parquet$/)[1])
        .sort();
    if (!years.length) return out;
    const thisYear = new Date().getFullYear();
    const needRows = days + 5;
    const byUpper = new Map(uniq.map(c => [String(c).toUpperCase(), c]));
    for (const y of years.slice().reverse()) {
        if (Number(y) > thisYear) continue;
        // 只补缺口：已读到足够行数的代码不再参不下一年查询
        const pending = uniq.filter(c => (out.get(c) || []).length < needRows);
        if (!pending.length) break;
        let rows = [];
        try {
            const binary = await readFileBinary(rootHandle, qfqPath + '/data_' + y + '.parquet');
            rows = await parquetReadObjects({
                file: binary.buffer,
                columns: KLINE_COLUMNS,
                filter: { code: { $in: pending } },
                compressors,
            });
        } catch (err) {
            dbg('parquet year failed', y, err);
            continue;
        }
        for (const r of rows) {
            const key = byUpper.get(String(r.code || '').toUpperCase());
            if (key) out.get(key).push(klineRow(r));
        }
    }
    for (const [c, list] of out) out.set(c, list.sort((a, b) => (a.date < b.date ? -1 : 1)).slice(-days));
    return out;
}

function klineRow(r) {
    return {
        date: fmtKlineDate(r.date),
        open: r.open ?? null,
        high: r.high ?? null,
        low: r.low ?? null,
        close: r.close ?? null,
        volume: r.volume ?? null,
        amount: r.amount ?? null,
        change_pct: r.change_pct ?? null,
        turnover_pct: r.turnover_pct ?? null,
    };
}

// 单只：缓存 → 接口补齐（read_stock_kline 用）
async function loadKlineRows(rootHandle, code, days) {
    const cache = await readStockFromParquet(rootHandle, code, days);
    return fillKlineFromApi(code, days, cache, lastTradingDayStr(new Date()));
}

// 「缓存不够最新交易日 → 小石 → adata」回退链（ETF 与普通股票同一条链，isEtfCode 只影响 adata 接口选择）
async function fillKlineFromApi(code, days, cache, expected) {
    let source = cache.length ? 'parquet' : 'none';
    let apiRows = [];
    let apiWarning = null;
    const cacheLast = cache.length ? cache[cache.length - 1].date : '';
    if (!cache.length || cacheLast < expected) {
        try {
            apiRows = await xiaoshiDailyKline(code, { limit: days, timeoutMs: 15000 });
            source = cache.length ? 'parquet+xiaoshi' : 'xiaoshi';
        } catch (e) {
            dbg('xiaoshi kline fetch failed', e);
            apiWarning = '小石 API 未补齐（' + (e && e.message || e) + '）';
            try {
                const isEtf = isEtfCode(code);
                const adataRows = isEtf
                    ? await adataGetMarketEtfDaily(code.split('.')[0], { startDate: klineStartDate(days) })
                    : await adataGetMarketDaily(code.split('.')[0], { startDate: klineStartDate(days), adjustType: 1 });
                apiRows = adataToKlineRows(adataRows);
                source = cache.length ? 'parquet+adata' : 'adata';
                apiWarning = '小石 API 不可用，已改用东方财富/同花顺数据';
            } catch (e2) {
                dbg('adata kline fetch failed', e2);
                apiWarning += '；东方财富 adata 也未补齐（' + (e2 && e2.message || e2) + '）';
            }
        }
    }
    const rows = mergeKlineRows(cache, apiRows, days);
    return { rows, source, cacheLast, apiRows, apiWarning };
}

// 并发受限的 map（接口补齐用：12 只串行要 30s+，无限并发又会压城 API 限流）
async function mapWithLimit(items, limit, fn) {
    const out = new Array(items.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
        while (cursor < items.length) {
            const i = cursor++;
            out[i] = await fn(items[i], i);
        }
    });
    await Promise.all(workers);
    return out;
}

function round2(v) {
    // Number(null) === 0，必须先排空值，否则 null 会被当 0 输出
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function firstFinite(...vals) {
    for (const v of vals) {
        const n = Number(v);
        if (v !== null && v !== undefined && v !== '' && Number.isFinite(n)) return n;
    }
    return null;
}

// 去掉空字段，保证单只输出控制在 150~250 字
function compactObj(obj) {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
        if (v === null || v === undefined || v === '') continue;
        out[k] = v;
    }
    return out;
}

// 「急跌缩量 / 回踩低位 / 冲高回落」这类判据本来就能用代码算，不要让模型看 180 行 OHLCV 心算
function klineSummary(code, name, rows, { source, warning } = {}) {
    const closes = rows.map(r => Number(r.close)).filter(Number.isFinite);
    const vols = rows.map(r => Number(r.volume));
    const last = rows[rows.length - 1];
    const prev = rows.length > 1 ? rows[rows.length - 2] : null;
    const lastClose = Number(last.close);
    const prevClose = prev ? Number(prev.close) : null;
    const ma = n => (closes.length >= n ? round2(closes.slice(-n).reduce((a, b) => a + b, 0) / n) : null);
    const win = closes.slice(-20);
    const hi20 = win.length ? Math.max(...win) : null;
    const prior5 = vols.slice(-6, -1).filter(v => Number.isFinite(v) && v > 0);
    // 连续下跌天数（自末尾）
    let downStreak = 0;
    for (let i = rows.length - 1; i >= 1; i--) {
        const a = Number(rows[i].close), b = Number(rows[i - 1].close);
        if (Number.isFinite(a) && Number.isFinite(b) && a < b) downStreak++;
        else break;
    }
    // 连续缩量天数（量 < 0.8 × 前 5 日均量）
    let shrinkDays = 0;
    for (let i = rows.length - 1; i >= 5; i--) {
        const base = vols.slice(i - 5, i).filter(v => Number.isFinite(v) && v > 0);
        if (base.length < 5 || !Number.isFinite(vols[i])) break;
        if (vols[i] < (base.reduce((a, b) => a + b, 0) / base.length) * 0.8) shrinkDays++;
        else break;
    }
    return compactObj({
        name: name || null,
        code,
        date: last.date,
        bars: rows.length,
        close: round2(lastClose),
        change_pct: round2(firstFinite(last.change_pct, prevClose && Number.isFinite(lastClose) ? (lastClose - prevClose) / prevClose * 100 : null)),
        ma5: ma(5),
        ma10: ma(10),
        ma20: ma(20),
        dd_20d: hi20 && Number.isFinite(lastClose) ? round2((lastClose - hi20) / hi20 * 100) : null, // 距 20 日高点回撤%
        vol_ratio_5d: prior5.length && Number.isFinite(Number(last.volume))
            ? round2(Number(last.volume) / (prior5.reduce((a, b) => a + b, 0) / prior5.length)) : null,
        down_streak: downStreak || null,
        shrink_days: shrinkDays || null,
        amplitude_pct: prevClose && Number.isFinite(Number(last.high)) && Number.isFinite(Number(last.low))
            ? round2((Number(last.high) - Number(last.low)) / prevClose * 100) : null,
        fade_pct: prevClose && Number.isFinite(Number(last.high)) && Number.isFinite(lastClose)
            ? round2((Number(last.high) - lastClose) / prevClose * 100) : null,               // 冲高回落（上影）幅度%
        turnover_pct: round2(firstFinite(last.turnover_pct)),
        closes: closes.slice(-5).map(v => round2(v)).join(','),
        source: source || null,
        warning: warning || null,
    });
}

function fmtKlineDate(d) {
    if (!d) return '';
    if (d instanceof Date) return d.toISOString().slice(0, 10);
    return String(d).slice(0, 10);
}

function mergeKlineRows(cache, api, days) {
    const map = new Map();
    for (const r of api) map.set(r.date, r);
    for (const r of cache) if (!map.has(r.date)) map.set(r.date, r);
    return [...map.values()].sort((a, b) => a.date < b.date ? -1 : 1).slice(-days);
}

function isEtfCode(code) {
    const m = String(code || '').match(/^\d{6}/);
    if (!m) return false;
    const c = m[0];
    return c.startsWith('159') || c.startsWith('51') || c.startsWith('58');
}

function lastTradingDayStr(date) {
    const d = new Date(date);
    d.setHours(12, 0, 0, 0);
    const dow = d.getDay();
    if (dow === 0) d.setDate(d.getDate() - 2);
    else if (dow === 6) d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
}

function klineStartDate(days) {
    const d = new Date();
    d.setDate(d.getDate() - days * 2 - 5);
    return d.toISOString().slice(0, 10);
}

function adataToKlineRows(rows) {
    return (rows || []).map(r => ({
        date: String(r.trade_date || r.date || '').slice(0, 10),
        open: r.open ?? null,
        high: r.high ?? null,
        low: r.low ?? null,
        close: r.close ?? null,
        volume: r.volume ?? null,
        amount: r.amount ?? null,
        change_pct: r.change_pct ?? null,
        turnover_pct: r.turnover_ratio ?? r.turnover_pct ?? null,
    }));
}

// ============== 要点/事件辅助 ==============

export async function requireKeyPoints() {
    const { hideKeyPoints } = await storageGet(chrome.storage.sync, 'hideKeyPoints');
    if (hideKeyPoints) {
        return { error: '要点管理功能未开启。请先在插件全局设置中开启「启用要点管理功能」，再执行本操作', disabled: true };
    }
    return null;
}

export function todayStr() {
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

export function autoArchiveEvents(events) {
    const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
    const archivedNow = [];
    const pendingStale = [];
    for (const e of events || []) {
        if (e.archived) continue;
        if (!e.time || new Date(e.time).getTime() >= weekAgo) continue;
        if (e.status === 'accurate' || e.status === 'wrong') {
            e.archived = true;
            archivedNow.push(e);
        } else if (e.status === 'pending') {
            pendingStale.push(e);
        }
    }
    const parts = [];
    if (archivedNow.length) {
        parts.push('以下事件已超 7 天且状态为准确/误判，已自动归档：' +
            archivedNow.map(e => `「${e.content}」（${e.time}，${eventStatusLabel(e.status)}）`).join('；'));
    }
    if (pendingStale.length) {
        parts.push('以下事件已超过一周仍未归档且状态为待预测，请提醒用户确认验证结果并修改状态：' +
            pendingStale.map(e => `「${e.content}」（${e.time}）`).join('；'));
    }
    return { remind: parts.length ? parts.join('。') : null, archivedCount: archivedNow.length };
}

function eventStatusLabel(s) {
    return { pending: '待预测', accurate: '准确', wrong: '误判' }[s] || s;
}

// ============== 长期记忆 ==============

export async function loadMemory() {
    const res = await storageGet(chrome.storage.local, MEMORY_KEY);
    state.memoryItems = (res[MEMORY_KEY] && Array.isArray(res[MEMORY_KEY].items)) ? res[MEMORY_KEY].items : [];
}

async function saveMemoryItems() {
    await storageSet(chrome.storage.local, { [MEMORY_KEY]: { items: state.memoryItems, updatedAt: Date.now() } });
}

export async function addMemory(content) {
    if (!content) return { ok: false, error: '记忆内容不能为空' };
    state.memoryItems.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), content: content.slice(0, 1000), ts: Date.now() });
    if (state.memoryItems.length > MAX_MEMORY_ITEMS) state.memoryItems = state.memoryItems.slice(-MAX_MEMORY_ITEMS);
    await saveMemoryItems();
    let mirrored = false;
    try {
        const dir = await readyRoot(state.workspaceHandles, '');
        const memoryPath = 'flit/memory.md';
        let existing = '';
        try { existing = (await readFile(dir.handle, memoryPath, Infinity)).content; } catch { }
        const section = '## AI 长期记忆\n\n' + state.memoryItems.map(m => '- ' + m.content).join('\n');
        const marker = /(^|\n)## AI 长期记忆\n[\s\S]*?(?=\n## |$)/;
        const md = marker.test(existing)
            ? existing.replace(marker, '\n' + section)
            : (existing.trimEnd() ? existing.trimEnd() + '\n\n' + section : section) + '\n';
        await writeFile(dir.handle, memoryPath, md);
        mirrored = true;
    } catch { }
    return { ok: true, mirrored };
}

export function buildSystemPrompt() {
    const wsGuide = state.workspaceHandles.length > 0
        ? ` 工作目录已设置。你可以直接使用 write_file / append_file 自动创建和修改工作目录下 flit/ 子目录中的文件，修改会持久保存到磁盘，无需额外请求确认；path 必须以 flit/ 开头，有多个工作目录时自行选择 root。`
        : ` 工作目录未设置时 write_file / append_file 不可用（会报错）。若需要创建文件，请先告知用户设置工作目录。`;
    const bridgeEnabled = state.bridgeEnabled;
    // T1-4：系统提示只留「一行目录 + 硬约束」，bridge 详细规则由 load_tool_group('bridge') 返回的 rule 字段给（本来就会返回），
    // 同一套规则不再在目录/guide/rules 里出现三份。硬约束只保留不能交给按需加载的安全红线。
    const bridgeCatalog = bridgeEnabled
        ? TOOL_CATALOG
        : TOOL_CATALOG.split('\n').filter(l => !l.startsWith('bridge:')).join('\n') + '\nbridge: 本地脚本/数据库查询（当前未启用）';
    const bridgeHardRules = bridgeEnabled
        ? '[桥接硬约束] 各组详细规则以 load_tool_group 返回的 rule 为准，不得推测表名/字段，先读 get_workspace_context 与 workflow 再查询。若 bridge_health 返回 bridge_unreachable，立即停止工具调用，只把 start_command 里的 pwsh 命令输出给用户手动执行；绝对禁止用 run_workspace_process 等工具自行启动 flit_bridge。凭据只能写入被 .gitignore 忽略的 flit/config.json，不得写入 memory.md。'
        : '[桥接] 当前未启用。若用户需要本地脚本或数据库查询，告知在 AI 设置中启用桥接、授权目录并启动 flit_bridge 后，重开 AI 窗口并新建会话。';
    const dataRules = '[取数纪律] 多只股票必须一次批量取数（日线用 read_stocks_kline，最多 12 只；实时行情用 get_portfolio_quotes），禁止逐只重复 query；最多 2 轮数据收集就要给出结论，超过 3 轮会触发旧工具结果驱逐（早期原始数据被丢弃）；结果被截断或已驱逐时不要反复重试同一查询，必要时缩小范围重取。';
    const lines = [
        '你是「flit stk - 量化盯盘」Chrome 扩展 AI 助手，使用中文。工具按组冷加载：需要能力时先调用 load_tool_group。全局设置只能修改 Cron，直接执行并说明修改结果。flit_stk 是 Chrome 扩展安装目录，不是 Agent 项目目录；不要把文件写入 flit_stk。写入/读取 flit/... 时使用 Agent 工作目录，多个工作目录时自行选择 root。' + wsGuide,
        '[工具组]\n' + bridgeCatalog,
        bridgeHardRules,
        dataRules,
    ];
    if (state.memoryItems.length > 0) {
        lines.push('', '[长期记忆]：');
        for (const m of state.memoryItems) lines.push('- ' + m.content);
    }
    lines.push('', '[当前时间]：' + getDateTime());
    return { role: 'system', content: lines.join('\n') };
}
