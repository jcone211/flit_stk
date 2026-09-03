// ai_tools.js —— 工具定义、工具组（一行摘要目录）、执行器、K 线取数与批量摘要、要点/事件、长期记忆
// 取数约定：多只股票一律走批量工具（read_stocks_kline / get_portfolio_quotes）；
// K 线默认只回「派生指标摘要」（klineSummary），detail=true 才带原始 OHLCV 行。

import {
    state, dbg, fmtDateTimeStr,
    storageGet, storageSet, genUid,
    DEFAULT_AI_BASE_URL, DEFAULT_AI_MODEL,
    MAX_TOOL_RESULT_CHARS, MAX_MESSAGES, MAX_MESSAGE_CHARS,
    MAX_MEMORY_ITEMS, MEMORY_KEY,
    MAX_RETAIN_CHARS, MAX_RETAINED_ENTRIES, MAX_RETAINED_TOTAL,
    summarizeList, pickStockView, findStockByName, stockSearchUrl,
} from './ai_state.js';
import {
    readyRoot, listDir, readFile, readFileBinary, writeFile, appendFile, workspacePermission,
} from './fsa.js';
import { parquetMetadataAsync, parquetSchema, parquetReadObjects, toJson } from '../vendor/hyparquet/index.js';
import { compressors } from '../vendor/hyparquet/compressors.js';
import { xiaoshiSearchStock, xiaoshiDailyKline, xiaoshiQuote, getSettingApiKey as getXiaoshiApiKey } from '../stock/xiaoshi_stock_kline.js';
import { getMarketDaily as adataGetMarketDaily, getMarketEtfDaily as adataGetMarketEtfDaily } from '../stock/adata_stock_kline.js';
// 取数优先级：本地数据库（工作目录 flit/config.json 登记，经 flit_bridge 只读查询）→ 免费公开渠道（东财/同花顺 K 线、新浪/腾讯实时）
// → 小石 API（有额度，仅当免费渠道不可用时才调）。parquet 年文件只是某时刻全市场快照，不参与 K 线取数。
import { batchQuotes as xiaoshiBatchQuotes } from '../../js/xiaoshi_realtime_quote.js';
import { batchQuotes as adataBatchQuotes, listMarketFull as adataListMarketFull } from '../../js/adata_realtime_quote.js';
import { parseCronExpr, nextTradingCronTimes } from '../../shared/cron.js';
import { etfPrefixForCode } from '../../shared/utils.js';
import { bridgeRequest, bridgeHealth } from './bridge_client.js';

// add_stock_to_portfolio 跨调用共享的页面打开时序计数器
let nextRefreshOneAt = 0;

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
    { type: 'function', function: { name: 'add_stock_to_portfolio', description: '按名称向指定组合批量添加一只或多只股票（组合缺省「持仓」）。自动生成问财搜索页作为监控地址，ETF（159/51/58 开头）走雪球个股页。一次调用可添加多只，调本工具即可，不需要再反复调多次', parameters: { type: 'object', properties: { names: { type: 'array', items: { type: 'string' }, description: '股票名称数组，如 ["贵州茅台", "五粮液"]；至少一项' }, portfolio: { type: 'string', description: '目标组合名，缺省「持仓」' } }, required: ['names'] } } },
    { type: 'function', function: { name: 'move_stock_to_combo', description: '把股票从来源组合移动到目标组合（按名称匹配、忽略首尾空格；来源缺省当前活动组合，目标缺省「观察」）。用于记录「卖出」等调仓：卖出时应传 source_portfolio 为实际持有该股的组合（通常「持仓」）；若目标组合已存在同名股票，则仅从来源组合删除、不重复添加', parameters: { type: 'object', properties: { name: { type: 'string', description: '股票名称' }, target_portfolio: { type: 'string', description: '目标组合名，缺省「观察」' }, source_portfolio: { type: 'string', description: '来源组合名（卖出的实际持仓组合），缺省当前活动组合' } }, required: ['name'] } } },
    { type: 'function', function: { name: 'get_current_view', description: '读取当前列表视图（股票列表或垃圾池）', parameters: { type: 'object', properties: {}, required: [] } } },
    { type: 'function', function: { name: 'get_settings', description: '读取扩展全局设置（刷新间隔/选择器/分页/cron 定时任务，不含任何密钥）', parameters: { type: 'object', properties: {}, required: [] } } },
    { type: 'function', function: { name: 'update_cron', description: '直接修改 Cron 并返回新配置和后续执行时间', parameters: { type: 'object', properties: { operation: { type: 'string', enum: ['add', 'update', 'delete', 'enable', 'disable'] }, target: { type: 'string', description: '任务序号、任务 ID 或当前表达式；新增时可省略' }, expr: { type: 'string', description: '目标 Cron 表达式；删除时省略' } }, required: ['operation'] } } },
    { type: 'function', function: { name: 'save_memory', description: '保存一条长期记忆（用户偏好/习惯等），之后每轮对话都会注入；同时更新当前工作目录 flit/memory.md', parameters: { type: 'object', properties: { content: { type: 'string', description: '要记住的内容' } }, required: ['content'] } } },
    { type: 'function', function: { name: 'refresh_all', description: '触发扩展全量刷新全部组合股票（按全局设置的数据获取方式执行）', parameters: { type: 'object', properties: {}, required: [] } } },
    { type: 'function', function: { name: 'list_workspaces', description: '列出已授权的全部工作目录（主目录与附加目录）及其权限状态', parameters: { type: 'object', properties: {}, required: [] } } },
    { type: 'function', function: { name: 'list_dir', description: '列出工作目录（或子目录）内容。root 缺省为主目录，可传附加目录名；软链接条目无法访问（浏览器安全限制）', parameters: { type: 'object', properties: { path: { type: 'string', description: '相对所选目录的路径，空为根目录' }, root: { type: 'string', description: '工作目录名，可用 list_workspaces 查询；缺省为主目录' } }, required: [] } } },
    { type: 'function', function: { name: 'read_file', description: '读取工作目录中的文本文件内容，支持 Markdown、JSON、JavaScript、CSS、TXT、CSV 等文本文件；路径相对当前工作区；内容过长时会截断', parameters: { type: 'object', properties: { path: { type: 'string' }, root: { type: 'string' } }, required: ['path'] } } },
    { type: 'function', function: { name: 'read_parquet', description: '读取工作目录中的 Parquet 数据文件，返回列名、总行数和限定数量的行。适合查看回测/备份用的 parquet 文件；path 必须是相对授权工作目录的路径，root 缺省为主目录。默认最多返回 100 行，可用 columns 选择列。本工具不参与股票 K 线取数；查询股票 K 线请走 read_stock_kline / read_stocks_kline（它们只读本地数据库）。', parameters: { type: 'object', properties: { path: { type: 'string', description: '相对工作目录的 .parquet 文件路径' }, root: { type: 'string', description: '工作目录名，缺省为主目录' }, columns: { type: 'array', items: { type: 'string' }, description: '要读取的列名；缺省读取全部列' }, row_start: { type: 'integer', minimum: 0, description: '起始行，缺省 0' }, limit: { type: 'integer', minimum: 1, maximum: 500, description: '最多返回行数，缺省 100，最大 500' } }, required: ['path'] } } },
    { type: 'function', function: { name: 'read_stock_kline', description: '获取单只股票近 N 个交易日日线（开/高/低/收/量/额/涨跌幅）。取数顺序：本地日线库 → 免费东财/同花顺 → 小石（仅缺 1~2 根时兜底）。≤7 个交易日不依赖 Agent 桥接，没库也能取；>7 个交易日只读本地库（保护免费渠道），库不可用时工具会返回「缺前置条件」的原因，照原样转述给用户即可，不要重试或换工具硬凑。ETF/指数不在本地库，自动走免费同花顺 ETF 日线（只有未复权价）。盘中（含午休）自动把当日未收盘 bar 拼到末行（标 intraday/as_of/quote_source）。name 与 code 二选一：按名称查询就传 name，代码解析由工具负责，不要自己猜代码。返回含 数据表 / 本地库诊断 / 数据日期 / 最新已收盘交易日 / 实时拼接 / 接口调用。', parameters: { type: 'object', properties: { name: { type: 'string', description: '股票名称，如「德明利」；与 code 二选一（代码由工具解析，不要自己猜）' }, code: { type: 'string', description: '股票代码：6 位数字（如 001309）或带市场后缀（如 001309.SZ），不要使用 SH:600519 等冒号前缀形式；与 name 二选一' }, days: { type: 'integer', minimum: 1, maximum: 60, description: '近 N 个交易日（盘中含拼接的当日实时 bar，共 N 根），缺省 30。≤7 天不依赖本地库；>7 天只读本地库，不启用免费/小石补齐' }, root: { type: 'string', description: '工作目录名，缺省为主目录（parquet 数据目录的根，如含 data/a_share_daily 的目录）' } }, required: [] } } },
    { type: 'function', function: { name: 'read_stocks_kline', description: '批量获取多只股票近 N 个交易日日线的派生指标摘要（收盘/涨跌幅/MA5・10・20/距 20 日高点回撤/量比/连续下跌/缩量/振幅/换手/近 5 日收盘），多只股票必须优先用本工具（一次取回整批）。detail=true 才附带原始 OHLCV 行。取数顺序与 7 天闸门同 read_stock_kline：≤7 天没库也能走免费，>7 天只读本地库、库不可用就照原样转述工具给的「缺前置条件」原因。ETF/指数不在本地库，自动走免费同花顺 ETF 日线。names 与 codes 可混用：按名称查询就传 names，代码解析由工具负责，不要自己猜代码。返回含 数据表 / 本地库诊断 / 数据日期 / 最新已收盘交易日 / 实时拼接 / 接口调用；末行 intraday=true 才可当现价，否则现价另调 get_stock_quote / get_portfolio_quotes。', parameters: { type: 'object', properties: { names: { type: 'array', items: { type: 'string' }, description: '股票名称数组，最多 12 只' }, codes: { type: 'array', items: { type: 'string' }, description: '股票代码数组（6 位或带 .SZ/.SH 后缀），可与 names 混用' }, days: { type: 'integer', minimum: 1, maximum: 60, description: '近 N 个交易日，缺省 18。≤7 天不依赖本地库；>7 天只读本地库，不启用免费/小石补齐' }, detail: { type: 'boolean', description: 'true 时返回原始 K 线行，缺省 false 只返回摘要' }, max_rows: { type: 'integer', minimum: 1, maximum: 18, description: 'detail=true 时每只最多返回行数，缺省 5' }, root: { type: 'string', description: '工作目录名，缺省为主目录' } }, required: [] } } },
    { type: 'function', function: { name: 'get_stock_quote', description: '【必调】获取一只或多只股票实时行情（最新价/涨跌幅/昨收/最高/最低/成交量/成交额/换手率），不经页面直接调用免费+付费混合接口。回答任何股票价格问题前必须先调用本工具或 get_portfolio_quotes。支持按股票名称或代码。names 与 codes 可混用，一次调可查询多只，不需要反复调多次', parameters: { type: 'object', properties: { names: { type: 'array', items: { type: 'string' }, description: '股票名称数组，如 ["德明利"]；与 codes 可混用' }, codes: { type: 'array', items: { type: 'string' }, description: '股票代码数组（6 位数字如 001309 或带 .SZ/.SH 后缀），可与 names 混用' } }, required: [] } } },
    { type: 'function', function: { name: 'get_portfolio_quotes', description: '批量获取指定组合全部股票的实时行情（最新价/涨跌幅/昨收/最高/最低/成交量/成交额/换手率）。一次调用返回所有股票，无需逐只查询', parameters: { type: 'object', properties: { portfolio: { type: 'string', description: '组合名，如「持仓」「观察」；缺省为当前活动组合' } }, required: [] } } },

    { type: 'function', function: { name: 'write_file', description: '自动创建或覆盖当前工作目录下 flit/ 子目录中的文件，用于维护 memory.md、config.json、脚本和用户适配文件；无需额外确认', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, root: { type: 'string' } }, required: ['path', 'content'] } } },
    { type: 'function', function: { name: 'append_file', description: '自动向当前工作目录下 flit/ 子目录中的文件追加内容，不存在则创建；用于积累长期记忆和适配记录，无需额外确认', parameters: { type: 'object', properties: { path: { type: 'string', description: '相对工作目录的文件路径，必须以 flit/ 开头' }, content: { type: 'string' }, root: { type: 'string' } }, required: ['path', 'content'] } } },
    { type: 'function', function: { name: 'get_workspace_context', description: '读取当前工作区的结构化配置摘要，优先读取 flit/config.json 和 flit/memory.md，并直接返回 flit/memory.md 内容及 flit/workflow/ 文件清单；返回 candidate 或 unknown 不代表数据库连接已验证，需由 Agent 继续检查工作区配置文件/脚本并实际验证连接', parameters: { type: 'object', properties: { include: { type: 'array', items: { type: 'string' } }, refresh: { type: 'boolean' } }, required: [] } } },
    { type: 'function', function: { name: 'discover_database_schema', description: '读取当前本地数据库真实表和字段结构，避免猜测字段名；结果仅返回结构化 schema 摘要', parameters: { type: 'object', properties: { source: { type: 'string' }, timeout_ms: { type: 'integer' } }, required: [] } } },
    { type: 'function', function: { name: 'query_local_database', description: '使用当前工作区配置查询本地数据库，返回结构化 JSON 行，无需读取记忆文件或拼接 Docker/PowerShell 命令', parameters: { type: 'object', properties: { sql: { type: 'string' }, source: { type: 'string' }, columns: { type: 'array', items: { type: 'string' } }, timeout_ms: { type: 'integer' }, debug: { type: 'boolean' } }, required: ['sql'] } } },
    { type: 'function', function: { name: 'save_workspace_database_config', description: '保存已验证可用的完整数据库连接配置到 flit/config.json，并自动创建 flit/.gitignore 忽略 config.json；仅在数据库连接实际验证成功后调用，凭据不会写入记忆文件', parameters: { type: 'object', properties: { config: { type: 'object', description: '完整工作区配置对象，必须包含 data_sources；可包含 version、market 等字段' }, source: { type: 'object', description: '已验证的数据源对象，包含 name、type、access、host、port、database、user、password 或 url 等实际连接字段' } }, required: ['source'] } } },
    { type: 'function', function: { name: 'record_workspace_memory', description: '按固定格式将不含凭据的已确认经验追加到 flit/memory.md；文件最上方必须保留“## 数据库连接状态”并优先记录连接是否已验证，后续记录 workflow 入口和查询约定；若经验对应可复用流程，先创建 flit/workflow/ 下描述清晰的通用流程，再登记入口；不能修改 flit/ 之外的文件', parameters: { type: 'object', properties: { content: { type: 'string' }, database_status: { type: 'string', enum: ['verified', 'unverified', 'unknown'], description: '当前数据库连接状态；已实际连接成功时传 verified' } }, required: ['content'] } } },
    { type: 'function', function: { name: 'run_workspace_process', description: '在当前工作目录内执行程序或脚本；cwd 使用相对路径，可执行 flit/ 外已有脚本和 flit/ 内新建脚本，支持 Python、Node、Git、Docker 等。禁止用此工具启动 flit_bridge；桥接未启动时必须把 bridge_health 返回的 pwsh 启动命令（含 start_note 安装说明）原样输出给用户，让用户自行执行后再继续', parameters: { type: 'object', properties: { program: { type: 'string' }, argv: { type: 'array', items: { type: 'string' } }, cwd: { type: 'string' }, stdin: { type: 'string' }, timeout_ms: { type: 'integer' } }, required: ['program'] } } },
    { type: 'function', function: { name: 'bridge_health', description: '检查本地 flit_bridge HTTP 服务是否在线。若未启动，只返回供用户手动执行的 pwsh 启动命令（含 start_note 说明是否首次启用需跑 install）；Agent 不得调用任何工具自行启动桥接服务', parameters: { type: 'object', properties: {}, required: [] } } },
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
    market: '行情工具：实时行情批量用 get_portfolio_quotes（一次返回组合全部股票）；多只股票日线用 read_stocks_kline（一次返回多只派生指标摘要），仅单只需要看原始 OHLCV 时才用 read_stock_kline。取数侧已做免费优先（本地数据库→新浪/腾讯实时、东财/同花顺日线→小石兜底）；日 K 按跨度分两档：≤7 个交易日不依赖桥接（没库就直接走免费，照样出数据），>7 个交易日为保护免费渠道只读本地库。工具返回 error 时照原样转述原因并给可行替代（改查 7 天内 / 改查实时现价 / 启用 Agent 桥接），不要重复调用同一工具。按名称查询就传 name/names，代码由工具解析，禁止自己猜代码。你不需要特意指定渠道；ETF 不在本地库内，由免费接口负责。若工具报「工作目录不存在可用数据库」，照原样转述给用户，不要改用其他工具硬凑 K 线（实时现价仍可查）。结论里要标数据日期：末行带 intraday 的是当日实时未收盘价（可称现价），不带的是已收盘日线（只能称"某日收盘"）；量能能不能当整日用看 实时拼接.量能说明。\n[上下文口径] tool 原始返回不跨轮保留（下一轮只剩一行「哪个工具成功/失败」的记录）；后面还要用这份数据就在本轮调 retain_tool_data 登记成隐藏便签，不必抄进正文。没登记又没写进正文的数据就是没了，只能重新调用（再花一次免费额度）。\n[强制取数] 输出任何行情数值（价格、涨跌幅、成交量、成交额、OHLCV、K 线表格、现价、收盘）前，本轮必须已经成功调用过行情工具（get_stock_quote / get_portfolio_quotes / read_stock_kline / read_stocks_kline）拿到真实数据；数据只能来自本轮工具返回或已登记且仍有效的跨轮便签。「≤7 个交易日不依赖本地库/桥接」只是说免费渠道能出数，绝不等于可以不调工具直接回答。用户改天数或换股票（例如 30 日改 7 日），必须重新调用取数工具，凭上一轮失败信息或记忆补写即视为编造。\n[禁止编造] 绝对禁止凭空编造行情数据。没有通过工具实际获取到真实数据前，不得输出价格数字、涨跌幅、跌停/涨停判定。宁可说「我没有查到」也不准编造。',
    events: '要点/事件工具：先读取已有要点；事件 content 只写股票名称。',
    settings: '设置工具：仅 Cron 可修改；修改前校验表达式，成功后立即生效。',
    workspace: '工作区工具：root 用目录名定位，只访问用户已授权目录；Agent 可直接维护当前工作目录下的 flit/ 文件。',
    memory: '记忆工具：仅保存用户明确要求长期记住的偏好。',
    bridge: `桥接工具：优先使用结构化工作区上下文和数据库 schema 查询；Agent 只能写 flit/，但可读取和执行工作目录其他目录中的已有脚本。低 Token 固定链路：先调用 get_workspace_context；若返回 config 或 memory，先使用其中的 verified_connection、database 和 workflows，不要重复读取旧文档；有匹配 workflow 时先 read_file 该流程，按其表结构和基础 SQL 执行，除非查询失败或流程明确要求，否则跳过 discover_database_schema。只有 config/memory/workflow 都不足时，才用 list_dir/read_file 搜索其他配置和脚本。发现错误时将修正经验记录到 flit/memory.md。数据库查询任务只有在“数据查询成功、连接配置已验证并保存（若原先不存在）、可复用流程已封装（若值得复用）、memory.md 已登记入口”后才算完成；不得只返回数据就结束。连接验证成功后必须调用 save_workspace_database_config 保存完整配置，该工具会同时创建 flit/.gitignore 并忽略 config.json。workflow 必须使用通用、可复用标题和文件名，不得绑定具体股票名称或本次日期，例如“查询股票近 N 个交易日行情”；内容必须包含适用条件、已验证连接/数据源名称（不得包含密码）、相关表及关键字段、历史表与当日快照的优先级和去重规则、可替换参数、可直接执行的基础 SQL，以及何时需要重新 discover_database_schema。若本次已验证出值得复用的正确执行流程，先创建 flit/workflow/ 下该流程，再调用 record_workspace_memory；memory.md 必须遵循固定格式，最上方先写“## 数据库连接状态”，明确 verified/unverified/unknown，随后只记录不含凭据的 workflow 入口、用途和触发条件；不要把完整过程、失败尝试或 SQL 结果重复写入记忆。桥接服务未启动时，bridge_health 会返回 pwsh 启动命令（含 start_note 说明首次启用需跑 install）；此时必须停止工具调用，只把命令和“请用户执行后重试”告知用户，绝对禁止通过 run_workspace_process 或其他工具启动 flit_bridge。
[桥接不通时无级可降] bridge 报 config_invalid / bridge_unreachable / query_failed 时，表示数据源配置未落到 bridge 能读取的位置或桥接不在运行。**不要** docker inspect 查容器标签、不要搜 bridge 源码找 label key、不要推测 bridge 内部发现逻辑——这些是你没有源码权或权威文档的信息。正确做法：
- 如果用户要的是 ≤7 天 K 线或实时行情 → 告知用户桥接配置问题后，直接降级走免费渠道出数据（不卡住）。
- 如果用户要的是 >7 天 K 线 → 桥接不通就是彻底无路可走。直接告诉用户「flit/config.json 已写入工作目录，但桥接不认该配置；请确保 flit_bridge 已启动。当前无法查 30 日 K 线，可选方案：让用户只查 7 天内；或自行启动桥接后重试；或自备数据源联系项目作者」。**不要卡在桥接问题上 debug、不要 docker exec/psql 直连数据库绕过桥接、不要把 7 天保护口径扔到 >7 天查询上假装有数据**。
[快速降级] ≤7 天 K 线或实时行情：1 次重试后仍不通，立即降级走免费渠道，不要连续超过 2 轮 debug 桥接问题。`
};

// 工具名 → 定义（getLoadedToolDefs 按名字取定义用，勿删：删了会在加载工具组时抛 TOOL_BY_NAME is not defined）
export const TOOL_BY_NAME = new Map(TOOL_DEFS.map(def => [def.function.name, def]));

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

// 常驻工具：不经 load_tool_group冷加载，和 load_tool_group 一起每轮都发（所以描述要短）
export const CONTEXT_TOOL_DEFS = [
    { type: 'function', function: {
        name: 'retain_tool_data',
        description: '把本轮某个工具刚返回的原始数据登记为「跨轮上下文便签」：不进对话界面、不必抄进回复正文，下一轮起作为隐藏上下文回灌给你。tool 传本轮已调用且成功的工具名（如 read_stocks_kline），note 可选一句话说明用途。工具原始返回默认只在本轮有效，回复结束就没了；后续还要基于它分析就调本工具。',
        parameters: { type: 'object', properties: {
            tool: { type: 'string', description: '要保留的工具名（本轮调用过且成功）；不传则返回本轮可登记清单' },
            note: { type: 'string', description: '可选：一句话说明这份数据的用途/口径，便于后续判断是否过期' },
        }, required: [] },
    } },
];

// 工具描述送出字数上限（T1 控字符）。旧版把 description 压成「read stock kline」并删光参数描述，
// 实测模型因此凭记忆猜代码（“昂利康”→ 300534）；整组描述只有一千多字，留全文比留名字便宜得多。
const TOOL_DESC_CHARS = 320;
const TOOL_PARAM_DESC_CHARS = 80;

export function getLoadedToolDefs() {
    const names = new Set();
    for (const group of state.activeToolGroups) {
        for (const name of TOOL_GROUPS[group] || []) names.add(name);
    }
    return [...names].map(name => {
        const def = TOOL_BY_NAME.get(name);
        if (!def) return null;
        const compact = structuredClone(def);
        compact.function.description = clipDesc(def.function.description, TOOL_DESC_CHARS);
        for (const property of Object.values(compact.function.parameters?.properties || {})) {
            if (typeof property.description === 'string') {
                property.description = clipDesc(property.description, TOOL_PARAM_DESC_CHARS);
            }
        }
        return compact;
    }).filter(Boolean);
}

/** 工具描述截断（T1 控字符） */
function clipDesc(text, max) {
    const t = String(text || '');
    return t.length > max ? t.slice(0, max) + '…' : t;
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
        const rawNames = Array.isArray(args.names) ? args.names : (args.name ? [args.name] : []);
        const names = rawNames.map(n => String(n).trim()).filter(Boolean);
        if (names.length === 0) return { error: '股票名称不能为空，请提供 names 数组' };
        const portfolio = String(args.portfolio || '持仓').trim();
        const { portfolios, activePortfolio, stockList } = await storageGet(chrome.storage.local, ['portfolios', 'activePortfolio', 'stockList']);
        const combos = portfolios || {};
        const target = combos[portfolio];
        if (!target) return { error: `组合「${portfolio}」不存在`, available: Object.keys(combos) };
        const list = target.stockList || (target.stockList = []);
        const added = [];
        const skipped = [];
        for (const name of names) {
            const url = stockSearchUrl(name);
            if (list.some(s => String(s.url || '') === url)) { skipped.push(name); continue; }
            list.push({
                url, name: '', code: '', prefix: '',
                startPrice: null, currentPrice: null, percent: null,
                importPrice: null,
                targetPercentLe: null, targetPercentGe: null,
                importTargetPercentLe: null, importTargetPercentGe: null,
                stopRunning: false, notifiedDaily: false, notifiedImport: false,
                inTrash: false, pinned: false, pinOrder: null, createdAt: Date.now(),
            });
            added.push({ name, url });
        }
        if (added.length === 0 && skipped.length > 0) return { error: `全部已在组合「${portfolio}」中：${skipped.join('、')}` };
        const mirror = (combos[activePortfolio] && combos[activePortfolio].stockList) || stockList || [];
        await storageSet(chrome.storage.local, { portfolios: combos, stockList: mirror });
        // 为每只股票安排延迟+抖动的页面打开（后台执行，不阻塞返回）
        const now = Date.now();
        if (nextRefreshOneAt < now) nextRefreshOneAt = now;
        added.forEach(({ name, url }) => {
            nextRefreshOneAt += 1500 + Math.random() * 700;
            const scheduledTime = nextRefreshOneAt;
            setTimeout(() => {
                try { chrome.runtime.sendMessage({ action: 'refreshOne', url }); } catch {}
            }, scheduledTime - now);
        });
        const hintParts = [`已保存 ${added.length} 支到「${portfolio}」`];
        if (skipped.length > 0) hintParts.push(`${skipped.length} 支已在组合中`);
        hintParts.push(`页面将逐个打开抓取`);
        return { ok: true, names: added.map(a => a.name), portfolio, hint: hintParts.join('，') };
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
                start_note: '(可管理员运行 pwsh .\install设置永久开启)'
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
        const now = new Date();
        const today = localDateStr(now);
        const code6 = String(code).split('.')[0];
        // 盘中/午休：当日未收盘 bar 由实时行情拼接，因此不让补齐链去追当日，也不看库里残留的当日行
        const liveNeeded = hasLiveSession(now);
        const db = await readKlineFromDb(dir, [code], days);
        // 【本地库失败分流】按「根因」选话术，不按 days 猜：≤7 天不论桥接开没开都降级免费渠道，
        // >7 天无降级路径（保护免费渠道），此时必须把「库不可用」的真实原因讲清，不得冒充「保护免费渠道」
        const dbFailed = !!db.error && !isEtfCode(code6);
        if (dbFailed && days > FREE_DAILY_MAX_DAYS) {
            return { root: dir.name, code, name, ...klineDbUnavailable(db, days) };
        }
        const { rows, source, cacheLast, apiRows, apiWarning } = await fillKlineFromApi(code, days, db.map.get(String(code).toUpperCase()) || [], expectedDailyLastDate(now), { liveToday: liveNeeded });
        if (!rows.length) {
            return {
                root: dir.name, code, name,
                error: '未读取到该股票数据：本地日线库无记录（ETF/指数本库不收录），免费渠道（东方财富/同花顺）与小石接口也均未补齐' + (apiWarning ? '（' + apiWarning + '）' : ''),
                取数诊断: (db.diag || []).join('；'),
            };
        }
        const live = liveNeeded ? await fetchLiveQuotes([code6]) : { map: new Map(), diag: [] };
        const liveMap = live.map;
        const sp = liveNeeded ? applyIntradayBar(rows, liveMap.get(code6), today, days) : { rows, spliced: false };
        const lastRow = sp.rows[sp.rows.length - 1];
        return {
            root: dir.name, code, name, days, source: sp.spliced ? source + '+live' : source,
            数据表: isEtfCode(code6) ? '本库不含 ETF（走免费同花顺日线）' : (db.table || null),
            本地库诊断: ((db.diag || []).filter(Boolean).join('；')
                + (dbFailed ? `；本地日线库不可用（${db.error}），本次 ${days} 日 K 全部来自免费渠道（东方财富/同花顺）` : '')) || undefined,
            数据日期: lastRow.date || null, 最新已收盘交易日: lastClosedSessionStr(now),
            实时拼接: liveSpliceInfo(now, sp.spliced ? 1 : 0, 1, lastRow.as_of, liveMap.get(code6) && liveMap.get(code6).source, live.diag),
            接口调用: apiCallsNote(),
            cacheLastDate: cacheLast || null, apiLastDate: apiRows.length ? apiRows[apiRows.length - 1].date : null,
            warning: apiWarning || (dbFailed ? `本地日线库未参与本次取数（${db.error}），数据全部来自免费渠道` : null),
            hint: sp.spliced
                ? '末行为当日实时未收盘 bar（带 intraday/as_of）；前面各行为已收盘日线，量能按 实时拼接.量能说明 解读'
                : 'rows 均为已收盘日线（末行 date 即数据日期）；当日实时价请另调 get_stock_quote',
            rows: sp.rows,
        };
    },
    // 批量日线摘要（T1-1）：一次 SQL 取回多只（窗口函数分组取前 N 根），接口补齐限并发，输出派生指标而不是 OHLCV
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
            return { error: '工作目录未授权，无法读 flit/config.json 与本地日线库：' + (err && err.message || err), hint: '也可用 get_portfolio_quotes 取实时行情' };
        }
        const now = new Date();
        const expected = expectedDailyLastDate(now);
        const liveNeeded = hasLiveSession(now);
        const today = localDateStr(now);
        // 代码解析并发（名称先本地列表命中，再本地库搜索，都不中才走小石搜索）
        const resolved = await Promise.all(targets.map(w => resolveStockCode(w)));
        // 一次 SQL 取回本批全部股票（代替逐只请求），ETF 不在本库范围、自然拿到 0 行后走免费接口
        const codesForCache = resolved.filter(r => r && r.code).map(r => r.code);
        const cacheRes = await readKlineFromDb(dir, codesForCache, days);
        const cacheMap = cacheRes.map;
        // 本地库不可用时：>7 天没有降级路径，整批直接给根因话术（混了 ETF 则 ETF 照样能取、只对股票逐项报错）；
        // ≤7 天不论桥接开没开都继续跑（空缓存 → 免费/小石），只是结果里不带 数据表
        const hasStock = codesForCache.some(c => !isEtfCode(String(c).split('.')[0]));
        const dbFailed = !!cacheRes.error && hasStock;
        const dbFailPayload = dbFailed && days > FREE_DAILY_MAX_DAYS ? klineDbUnavailable(cacheRes, days) : null;
        if (dbFailPayload && !codesForCache.some(c => isEtfCode(String(c).split('.')[0]))) {
            return { days, ...dbFailPayload, total: codesForCache.length };
        }
        // 盘中/午休：一次免费批量实时行情覆盖全部标的（不逐只调接口），把当日未收盘 bar 拼到末尾
        const live = liveNeeded
            ? await fetchLiveQuotes(codesForCache.map(c => String(c).split('.')[0]))
            : { map: new Map(), diag: [] };
        const liveMap = live.map;
        let liveCount = 0, liveAsOf = null, liveChannel = null;
        const stocks = await mapWithLimit(resolved, API_CONCURRENCY, async (r) => {
            if (!r || r.error) return { name: (r && r.name) || null, code: (r && r.code) || null, error: r && r.error || '代码解析失败' };
            const code6 = String(r.code).split('.')[0];
            if (dbFailPayload && !isEtfCode(code6)) {
                return {
                    name: r.name || null,
                    code: r.code,
                    error: dbFailPayload.error,
                };
            }
            const { rows, source, apiWarning } = await fillKlineFromApi(r.code, days, cacheMap.get(String(r.code).toUpperCase()) || [], expected, { liveToday: liveNeeded });
            const sp = liveNeeded ? applyIntradayBar(rows, liveMap.get(code6), today, days) : { rows, spliced: false };
            if (sp.spliced) {
                liveCount++;
                liveAsOf = liveAsOf || sp.rows[sp.rows.length - 1].as_of;
                liveChannel = liveChannel || (liveMap.get(code6) && liveMap.get(code6).source);
            }
            if (!sp.rows.length) {
                return { name: r.name || null, code: r.code, error: apiWarning || '无数据（本地日线库无记录且免费/小石接口未补齐）' };
            }
            // 批量路径不带 per-stock warning（文本重复占字），数据源由 source 字段体现
            const item = klineSummary(r.code, r.name, sp.rows, {
                source: sp.spliced ? source + '+live' : source,
                warning: apiWarning,
            });
            if (detail) item.rows = sp.rows.slice(-maxRows);
            return item;
        });
        const failed = stocks.filter(s => s.error).length;
        const dates = stocks.map(s => s.date).filter(Boolean).sort();
        // 取各股最旧的那个作为对外口径：宁可保守，也不把“只有部分股票拿到最新”当成整体最新
        const dataDate = dates.length ? dates[0] : null;
        return {
            days,
            // 时效自述：末行到底是哪一天、是不是未收盘，全看这几个字段
            数据表: hasStock ? (cacheRes.table || null) : '本库不含 ETF（走免费同花顺日线）',
            本地库诊断: ((cacheRes.diag || []).filter(Boolean).join('；')
                + (dbFailed && !dbFailPayload ? `；本地日线库不可用（${cacheRes.error}），本批 ${days} 日 K 全部来自免费渠道（东方财富/同花顺）` : '')) || undefined,
            数据日期: dataDate,
            最新已收盘交易日: expected,
            实时拼接: liveSpliceInfo(now, liveCount, codesForCache.length, liveAsOf, liveChannel, live.diag),
            接口调用: apiCallsNote(),
            数据日期不齐: (dates.length && dates[dates.length - 1] !== dates[0])
                ? ('各股末行日期不一致：' + dates[0] + ' ~ ' + dates[dates.length - 1] + '（以各项 date 为准）') : undefined,
            数据滞后: (dataDate && dataDate < expected)
                ? ('末行 ' + dataDate + ' 早于最新已收盘交易日 ' + expected + '，免费与小石渠道均未补齐，只能当作历史参照') : undefined,
            detail: detail ? maxRows : false,
            total: stocks.length,
            failed: failed || undefined,
            truncated: overflow ? {
                上限: MAX_BATCH_KLINE,
                未处理: want.slice(MAX_BATCH_KLINE).map(w => w.name || w.code),
                说明: '只处理了前 ' + MAX_BATCH_KLINE + ' 只，剩下的请再调一次',
            } : undefined,
            warning: [days > 7
                ? '超过 ' + FREE_DAILY_MAX_DAYS + ' 天仅查询本地数据库，未调用免费/小石日线接口；数据库数据不全时不会补齐'
                : (stocks.some(s => s.source && s.source !== 'db')
                    ? '部分数据不全部来自本地日线库（见各项 source：db 为本地库，adata 为免费东财/同花顺，xiaoshi 为小石接口，+live 为当日实时未收盘 bar）' : ''),
            ].filter(Boolean).join('；') || undefined,
            hint: '指标均由本地从日线行算出；末行 intraday=true 时为当日实时价（可当现价），否则最新价请另调 get_stock_quote / get_portfolio_quotes；需原始 OHLCV 才传 detail=true',
            stocks,
        };
    },
    async get_stock_quote(args) {
        // 兼容旧格式：name/code 单值自动转数组
        const rawNames = Array.isArray(args.names) ? args.names : (args.name ? [args.name] : []);
        let rawCodes = Array.isArray(args.codes) ? args.codes : (args.code ? [String(args.code).trim()] : []);
        if (rawNames.length === 0 && rawCodes.length === 0) return { error: '请提供股票名称或代码（names / codes）' };

        // 名称也需要解析为代码，逐个处理
        const targets = [];
        for (const n of rawNames) {
            const t = String(n).trim();
            if (t) targets.push({ name: t });
        }
        for (const c of rawCodes) {
            const t = String(c).trim();
            if (t) targets.push({ code: t });
        }

        const resolved = await Promise.all(targets.map(w => resolveStockCode(w)));
        const validCodes = []; // { code6, name }
        const errors = [];
        for (let i = 0; i < resolved.length; i++) {
            const r = resolved[i];
            if (r.error) {
                errors.push({ name: targets[i].name || targets[i].code, error: r.error });
            } else {
                validCodes.push({ code6: r.code.split('.')[0], name: r.name || targets[i].name });
            }
        }
        if (validCodes.length === 0) return { error: errors.map(e => e.error).join('；') };

        const { map, diag } = await fetchLiveQuotes(validCodes.map(c => c.code6));
        const quotes = validCodes.map(c => {
            const q = map.get(c.code6);
            if (!q) return { name: c.name, code: c.code6, error: '未获取到行情' };
            return {
                code: c.code6, name: q.name || c.name,
                price: q.price, change: q.change, change_pct: q.change_pct,
                open: q.open, high: q.high, low: q.low, previous_close: q.last_close,
                volume: q.volume, amount: q.amount, turnover_pct: q.turnover_pct,
                time: q.time, source: q.source,
            };
        });
        const result = { total: quotes.length, quotes, 渠道: diag };
        if (errors.length > 0) result.errors = errors;
        return result;
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

        const codes = []; // { code, name }
        const noCode = [];
        for (const s of list) {
            if (!s.code) { noCode.push(s.name || '(待抓取)'); continue; }
            codes.push({ code: String(s.code).split('.')[0], name: s.name });
        }

        const live = await fetchLiveQuotes(codes.map(c => c.code));
        const liveMap = live.map;
        const quotes = codes.map(c => {
            const hit = liveMap.get(c.code);
            if (hit) return {
                name: c.name || hit.name,
                code: c.code,
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
                time: hit.time || null,
                source: hit.source || null,
            };
            return { name: c.name, code: c.code, error: '未获取到行情' };
        });
        for (const n of noCode) {
            quotes.push({ name: n, error: '尚未获取到代码' });
        }
        const fetched = quotes.filter(q => !q.error).length;
        return {
            total: list.length,
            fetched,
            渠道: fetched ? (quotes.find(q => !q.error) || {}).source || null : null,
            note: 'price 为当日实时价（time 为行情时间，渠道见 source）；盘前/休市时它是上一交易日收盘价，勿与日线末行当成两个不同的“现价”',
            error: fetched ? undefined : '实时行情不可用：免费渠道（新浪/腾讯）与小石均失败，可稍后重试',
            渠道诊断: live.diag.length ? live.diag.join('；') : undefined,
            quotes,
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
    // 只拿本轮缓存的原文（ai.js executeToolCalls 负责填 state.turnToolResults）：
    // 上一轮的原始返回本来就不在上下文里，不允许模型凭记忆登记一份「想象中的数据」
    async retain_tool_data(args) {
        // 常驻工具的结果没保留价值（规则文本 / 本工具自己的回执），不列入可登记清单也登不上
        const META = new Set(['load_tool_group', 'retain_tool_data']);
        const cache = (state.turnToolResults || []).filter(r => r && !META.has(r.name));
        const available = () => [...new Set(cache.filter(r => r.ok).map(r => r.name))];
        const tool = String((args && args.tool) || '').trim();
        if (!tool) return { error: '请传 tool（本轮已调用过的工具名）', 本轮可登记: available() };
        const hits = cache.filter(r => r.name === tool);
        if (!hits.length) {
            return { error: `本轮没有 ${tool} 的调用结果可登记`, 说明: '工具原始返回只在当轮内缓存，更早的已经不在上下文里了；需要它就重新调一次该工具再登记', 本轮可登记: available() };
        }
        const src = hits[hits.length - 1];
        if (!src.ok) return { error: `${tool} 本轮没有取到数据，无内容可保留`, 它的返回: String(src.text || '').slice(0, 200) };
        const note = String((args && args.note) || '').slice(0, 160);
        const text = src.text.length > MAX_RETAIN_CHARS
            ? src.text.slice(0, MAX_RETAIN_CHARS) + `\n（便签已截断，原长 ${src.text.length} 字）` : src.text;
        const pending = (state.pendingRetains || []).filter(n => n && n.tool !== tool);
        pending.push({ tool, argsText: src.argsText, note, text, ts: src.ts || Date.now() });
        while (pending.length > 1
            && (pending.length > MAX_RETAINED_ENTRIES || pending.reduce((n, x) => n + x.text.length, 0) > MAX_RETAINED_TOTAL)) {
            pending.shift();
        }
        state.pendingRetains = pending;
        return {
            ok: true, 已登记: tool, 字符: text.length,
            生效: '你本轮回复结束后，下一轮起作为隐藏上下文回灌（对话界面不展示，不落用户可见正文）',
            当前便签: pending.map(n => `${n.tool}(${n.text.length}字)`).join('、'),
        };
    },
};

// ============== K 线辅助 ==============

/**
 * 名称 → 代码的本地库搜索（stock_basic_cache 一类表）：探不到表/桥接不可用就返 null，
 * 由小石搜索接管（名称解析不是 K 线，调用一次搜索接口可接受）。
 */
async function searchCodeInDatabase(name) {
    const kw = String(name || '').trim();
    if (!kw) return null;
    const plan = await resolveKlineDbPlan(await primaryRoot());
    if (plan.error || !plan.basicTable) return null;
    const codeCol = plan.basicCodeCol || 'ts_code';
    const sql = 'SELECT ' + codeCol + ', name FROM ' + plan.basicTable
        + ' WHERE name = ' + sqlText(kw) + ' OR name LIKE ' + sqlText(kw + '%')
        + ' ORDER BY (name = ' + sqlText(kw) + ') DESC LIMIT 5';
    const q = await dbQuery(sql, [codeCol, 'name'], plan.sourceName);
    if (!q.ok) { dbg('db name search failed', q.message); return null; }
    const rows = q.rows.filter(r => r && r[codeCol]);
    if (!rows.length) return null;
    const best = rows.find(r => String(r.name).trim() === kw) || rows[0];
    return { code: String(best[codeCol]).toUpperCase(), name: best.name || kw, table: plan.basicTable };
}

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
        // ETF 代码段与股票不同（51/58 上交所、159 深交所），不能沿用「6 开头才是 SH」的推断
        const etfPrefix = etfPrefixForCode(digits);
        if (etfPrefix) return { code: digits + '.' + etfPrefix, name };
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
    // 本地列表没命中先问工作目录数据库（免掉一次小石搜索额度）
    const dbHit = await searchCodeInDatabase(name);
    if (dbHit) return { code: dbHit.code, name: dbHit.name };
    try {
        trackCall('小石搜索');
        const items = await xiaoshiSearchStock(name, { timeoutMs: 15000 });
        const best = items.find(i => i.name === name) || items[0];
        if (best && best.symbol) return { code: best.symbol, name };
        return { error: `未能在小石搜索到「${name}」的股票代码，请核对名称后重试` };
    } catch (e) {
        return { error: `小石搜索接口不可用，无法解析「${name}」的代码：${e && e.message || e}。可改传 6 位代码（如 001309）` };
    }
}

// ============ 本地数据库日线（K 线唯一的本地来源，只读，经 flit_bridge 查询） ============
// 口径：库里的日线由用户自己的定时任务维护（含除权处理），扩展只查不写、也不碰同步脚本。
// parquet 年文件只是「某一时刻全市场快照」，用于回测或入库备份，**不参与 K 线取数**。
// ETF / 指数不在本库覆盖范围（实测 a_share_daily 无 51/15/58 开头代码），一律走免费同花顺 ETF 日线，失败再小石兜底。

// 批量取数一次最多几只 / 接口补齐并发度
const MAX_BATCH_KLINE = 12;
const API_CONCURRENCY = 4;
// 免费渠道可承担的最大日 K 跨度：≤ 7 天不论桥接开没开都能取（本地库 → 免费 → 小石），
// >7 天只能靠本地库（保护免费渠道），无库时按根因报错——取数口径里唯一允许出现的天数常量
const FREE_DAILY_MAX_DAYS = 7;
// 本地库查询超时（桥接侧还要 spawn docker exec psql，比直连慢一档）
const DB_TIMEOUT_MS = 12000;
// 库侧列名与工具行字段一致（parquet_to_postgres 约定：adjust,market,code,date,OHLC,volume,amount,change_pct,turnover_pct）
const KLINE_DB_COLUMNS = ['code', 'date', 'open', 'high', 'low', 'close', 'volume', 'amount', 'change_pct', 'turnover_pct'];
const KLINE_DB_REQUIRED = ['code', 'date', 'open', 'high', 'low', 'close'];
const KLINE_RANGE_PROTECTION = '保护免费渠道，仅支持查询近7日日K数据，或自备数据源和做项目适配，或联系项目作者';
const SAFE_TABLE_RE = /^[A-Za-z_][A-Za-z0-9_.]*$/;
// 一次会话内按「工作目录 + 数据源 + config 指纹」缓存探测结果，避免每次查 K 线都摸一遍 schema；
// 带指纹是为了改了 flit/config.json 不必重开 AI 窗口（P1-4），只留最近几个库的探测结果。
const dbPlanCache = new Map();
function dbPlanSet(key, plan) {
    if (dbPlanCache.size > 16) {
        const oldest = dbPlanCache.keys().next().value;
        if (oldest !== undefined && oldest !== key) dbPlanCache.delete(oldest);
    }
    dbPlanCache.set(key, plan);
}

/** 主工作目录 handle（未授权返回 null，不抛） */
async function primaryRoot() {
    try { return await readyRoot(state.workspaceHandles, ''); } catch { return null; }
}

/** SQL 字符串字面量：名称/代码都来自模型，必须在这里过一道 */
function sqlText(v) {
    return "'" + String(v).replace(/'/g, "''") + "'";
}

/** psql -A -t 输出的是文本：空串即 NULL；数值统一转数并收掉长尾小数 */
function dbNum(v, digits = 6) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    return Math.round(n * 10 ** digits) / 10 ** digits;
}

function dbKlineRow(r) {
    return {
        date: String(r.date || '').slice(0, 10),
        open: dbNum(r.open, 4), high: dbNum(r.high, 4), low: dbNum(r.low, 4), close: dbNum(r.close, 4),
        volume: dbNum(r.volume, 0), amount: dbNum(r.amount, 2),
        change_pct: dbNum(r.change_pct, 4), turnover_pct: dbNum(r.turnover_pct, 4),
    };
}

/** 桥接只读查询：成功回 { ok, rows }，失败回 { ok:false, message }（桥接没起来也走这里） */
async function dbQuery(sql, columns, sourceName) {
    if (!state.workspaceRootPath) return { ok: false, message: '未设置主工作目录' };
    trackCall('本地数据库');
    const r = await bridgeRequest('/v1/database/query', {
        workspace_root: state.workspaceRootPath,
        source: sourceName || undefined,
        sql, columns, timeout_ms: DB_TIMEOUT_MS,
    }, { timeoutMs: DB_TIMEOUT_MS + 3000 });
    if (!r || r.ok === false) {
        return { ok: false, message: (r && r.error && r.error.message) || '本地数据库查询失败', code: r && r.error && r.error.code };
    }
    return { ok: true, rows: r.rows || [] };
}

/** 读 flit/config.json 里登记的数据源（扩展自己用 File System Access 读，不经桥接）
 * 附带把原文做一次短指纹（stamp）：调用方拿它做缓存键，改了配置不必重开 AI 窗口。 */
async function readDbConfigSources(dir) {
    if (!dir) return { sources: [], note: '工作目录未授权', stamp: 'no-dir' };
    let text;
    try { text = (await readFile(dir.handle, 'flit/config.json', Infinity)).content; }
    catch { return { sources: [], note: '工作目录没有 flit/config.json', stamp: 'no-file' }; }
    let parsed;
    try { parsed = JSON.parse(text); } catch { return { sources: [], note: 'flit/config.json 不是有效 JSON', stamp: 'bad-json' }; }
    const raw = parsed && (parsed.data_sources || parsed.database);
    const sources = (Array.isArray(raw) ? raw : (raw && typeof raw === 'object' ? Object.values(raw) : []))
        .filter(s => s && typeof s === 'object');
    let stamp = text.length + ':';
    for (let i = 0; i < text.length; i += 97) stamp += (text.charCodeAt(i) ^ (i % 31)).toString(36);
    return { sources, note: sources.length ? '' : 'flit/config.json 未登记 data_sources', stamp };
}

/** 从候选源里挑一个能用来看日线的：优先登记了日线表的、其次 docker+库名齐全的 */
function pickDailySource(list) {
    const arr = (Array.isArray(list) ? list : [list]).filter(s => s && typeof s === 'object');
    return arr.find(s => s.tables && (s.tables.daily || s.tables.daily_view || s.tables.kline))
        || arr.find(s => s.access === 'docker' && s.container && s.database)
        || arr.find(s => s.database || s.name) || null;
}

/** 按列签名在真实 schema 里找日线表 / 股票基础信息表（config 没写表名时用） */
function probeTables(columns) {
    const byTable = new Map();
    for (const c of columns || []) {
        if (!c || !c.table) continue;
        if (!byTable.has(c.table)) byTable.set(c.table, new Set());
        byTable.get(c.table).add(String(c.column).toLowerCase());
    }
    const names = [...byTable.keys()];
    const hasAll = (t, need) => need.every(n => byTable.get(t).has(n));
    const daily = names.filter(t => hasAll(t, KLINE_DB_REQUIRED)
        && !/today|weekly|monthly|temp|backup|test/i.test(t))
        .sort((a, b) => (/daily/i.test(b) ? 1 : 0) - (/daily/i.test(a) ? 1 : 0) || a.localeCompare(b));
    const basic = names.filter(t => hasAll(t, ['name'])
        && (byTable.get(t).has('ts_code') || byTable.get(t).has('code') || byTable.get(t).has('symbol')))
        .sort((a, b) => (/basic|list|info/i.test(b) ? 1 : 0) - (/basic|list|info/i.test(a) ? 1 : 0) || a.localeCompare(b));
    const basicCodeCol = basic.length
        ? (['ts_code', 'code', 'symbol'].find(n => byTable.get(basic[0]).has(n)) || 'ts_code') : null;
    return { daily, basic, basicCodeCol, setOf: t => byTable.get(t) || new Set() };
}

/**
 * 解析「用哪个源、哪张表、什么复权口径」。flit/config.json 优先 → 配置为空再让桥接按
 * 工作目录（flit/memory.md、AGENTS.md、README.md）推断 → 表名没登记就按列签名探。
 * 都拿不到时 error='no_database'，由调用方换成对用户的话术。
 */
async function resolveKlineDbPlan(dir) {
    const diag = [];
    if (!state.bridgeEnabled) return { error: 'bridge_disabled', diag: ['AI 设置未启用 Agent 桥接'] };
    if (!state.workspaceRootPath) return { error: 'workspace_not_set', diag: ['尚未设置主工作目录'] };
    const root = dir || await primaryRoot();
    const { sources, note, stamp } = await readDbConfigSources(root);
    let source = pickDailySource(sources);
    if (!source) {
        diag.push(note || 'flit/config.json 没有可用数据源');
        const ctx = await bridgeRequest('/v1/workspace/context', { workspace_root: state.workspaceRootPath });
        const inferred = ctx && ctx.ok !== false ? ((ctx.context && ctx.context.database) || []) : [];
        source = pickDailySource(Array.isArray(inferred) ? inferred : [inferred]);
        if (source) diag.push('按工作目录搜索到候选数据源：' + (source.name || '(未命名)'));
    }
    if (!source) return { error: 'no_database', diag };

    const cacheKey = state.workspaceRootPath + '|' + String(source.name || source.database || '') + '|' + (stamp || '');
    const cached = dbPlanCache.get(cacheKey);
    if (cached) return { ...cached, diag };

    const tables = source.tables || {};
    let table = tables.daily || tables.daily_view || tables.kline || null;
    if (table && !SAFE_TABLE_RE.test(table)) return { error: 'bad_table', diag: [...diag, '登记的表名不合法：' + table] };
    let columns = [];
    const sch = await bridgeRequest('/v1/database/schema', {
        workspace_root: state.workspaceRootPath, source: source.name || undefined, timeout_ms: DB_TIMEOUT_MS,
    }, { timeoutMs: DB_TIMEOUT_MS + 3000 });
    if (sch && sch.ok !== false) columns = sch.tables || [];
    else diag.push('读取表结构失败：' + ((sch && sch.error && sch.error.message) || '未知错误'));

    const probed = probeTables(columns);
    if (table && !probed.setOf(table.toLowerCase()).size && columns.length) {
        // 大小写/引号差异：information_schema 里通常是小写
        const exact = columns.filter(c => String(c.table).toLowerCase() === String(table).toLowerCase());
        if (exact.length) table = exact[0].table;
        else { diag.push('登记的表 ' + table + ' 在库里不存在，改按列签名搜索'); table = null; }
    }
    if (!table) table = probed.daily[0] || null;
    let tableGuessed = false;
    if (!table && !columns.length) {
        // 桥接不可达且 config 没登记表名：先按默认表名试一次，让真正的报错从查询里出来（比猜「没库」更诚实），
        // 但这个表名**未经验证**，不能当成 `数据表` 回给用户（见 P1-5）。
        table = 'a_share_daily';
        tableGuessed = true;
        diag.push('未读到表结构且 config 未登记表名，暂按 a_share_daily 试查（表名未经验证）');
    }
    if (!table) return { error: 'no_table', diag: [...diag, '库里找不到含 code/date/open/high/low/close 的日线表'] };

    const cols = probed.setOf(String(table).toLowerCase());
    const plan = {
        sourceName: source.name || undefined,
        table,
        tableGuessed,
        adjust: (source.conventions && source.conventions.adjust) || 'qfq',
        hasAdjust: cols.has('adjust'),
        basicTable: probed.basic[0] || tables.stock_basic || null,
        basicCodeCol: probed.basicCodeCol || 'ts_code',
    };
    dbPlanSet(cacheKey, plan);
    return { ...plan, diag };
}

/** 只一次 SQL 取多只股票的已收盘日线（库里是 EOD，不含当日未收盘 bar） */
async function readKlineFromDb(dir, codes, days) {
    const uniq = [...new Set((codes || []).filter(Boolean).map(c => String(c).toUpperCase()))];
    const out = new Map(uniq.map(c => [c, []]));
    if (!uniq.length) return { map: out, diag: [], plan: null };
    const plan = await resolveKlineDbPlan(dir);
    if (plan.error) return { map: out, diag: plan.diag || [], error: plan.error, plan };
    const byShort = new Map(uniq.map(c => [String(c).split('.')[0], c]));
    // 带后缀与 6 位两种写法一起给：不依赖库里 code 的写法，且仍能走 (adjust,code,date) 主键索引
    const inList = [...byShort.keys(), ...uniq].map(c => sqlText(c)).join(',');
    const sql = 'WITH ranked AS (SELECT ' + KLINE_DB_COLUMNS.join(', ')
        + ', ROW_NUMBER() OVER (PARTITION BY substr(code, 1, 6) ORDER BY date DESC) AS rn'
        + ' FROM ' + plan.table
        + ' WHERE code IN (' + inList + ')'
        + (plan.hasAdjust ? ' AND adjust = ' + sqlText(plan.adjust) : '')
        + ' AND date >= ' + sqlText(klineStartDate(days)) + ')'
        + ' SELECT ' + KLINE_DB_COLUMNS.join(', ') + ' FROM ranked WHERE rn <= ' + Number(days) + ' ORDER BY code, date';
    const q = await dbQuery(sql, KLINE_DB_COLUMNS, plan.sourceName);
    if (!q.ok) return { map: out, diag: [...(plan.diag || []), '查询 ' + plan.table + ' 失败：' + q.message], error: 'query_failed', plan };
    for (const r of q.rows) {
        const target = byShort.get(String(r.code || '').slice(0, 6));
        if (target) out.get(target).push(dbKlineRow(r));
    }
    let hit = 0;
    for (const [c, list] of out) {
        const byDate = new Map(list.map(r => [r.date, r]));
        const rows = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
        out.set(c, rows);
        if (rows.length) hit++;
    }
    const last = [...out.values()].filter(l => l.length).map(l => l[l.length - 1].date).sort();
    const diag = [...(plan.diag || []), `本地库 ${plan.table}${plan.hasAdjust ? '(' + plan.adjust + ')' : ''} 命中 ${hit}/${uniq.length} 只`
        + (last.length ? '，末行 ' + (last[0] === last[last.length - 1] ? last[0] : last[0] + '~' + last[last.length - 1]) : '')];
    return { map: out, diag, plan, table: plan.tableGuessed ? null : plan.table, adjust: plan.adjust };
}

/**
 * K 线拿不到本地库时给模型的话术（桥接/目录问题单独说，别一律甩「联系作者」）。
 * 现在只在「days > FREE_DAILY_MAX_DAYS 且库不可用」时被调用——≤ 7 天已一律降级免费渠道，不再报错。
 * days 传进来是为了把「你查的是 N 天」讲清（旧版硬编码 30，问 60 天就对不上号）。
 */
function klineDbUnavailable(res, days = 0) {
    const diag = (res && res.diag || []).join('；');
    // 前置条件句：把「没库」与「接口故障/不给查」区分开，不然模型会转述成甩锅话
    const pre = days > FREE_DAILY_MAX_DAYS
        ? `你查的是 ${days} 个交易日，超过免费渠道可承担的 ${FREE_DAILY_MAX_DAYS} 天，这类长周期只能读本地日线库（需启用 Agent 桥接）——缺的是前置条件（本地库），不是接口故障，也不是渠道限流。`
        : '';
    const hint = `实时行情（现价/涨跌幅）与 ${FREE_DAILY_MAX_DAYS} 个交易日以内的日 K 都不需要数据库，可直接问（get_stock_quote / get_portfolio_quotes / read_stock_kline）；更长周期必须先有本地库。`;
    if (res.error === 'bridge_disabled') {
        return { error: pre + '本地数据库不可用：AI 设置里未启用「Agent 桥接」。启用后启动 flit_bridge（node flit_bridge/server.js）并重开 AI 窗口，才能查超过 ' + FREE_DAILY_MAX_DAYS + ' 天的日 K。', 取数诊断: diag, hint };
    }
    if (res.error === 'workspace_not_set') {
        return { error: pre + '本地数据库不可用：尚未设置主工作目录，请在 AI 窗口顶部选择工作目录（其中需有 flit/config.json）。', 取数诊断: diag, hint };
    }
    if (res.error === 'query_failed' || res.error === 'bad_table' || res.error === 'bridge_unreachable' || res.error === 'schema_failed' || res.error === 'config_invalid') {
        return { error: pre + '工作目录登记了数据库，但桥接不可用或配置未被识别：' + (diag || '详见 取数诊断') + `。当前 ${days || FREE_DAILY_MAX_DAYS} 日 K 线完全依赖本地数据库，桥接不通则无法查询。请确保 flit_bridge 已通过 start-server.ps1 启动且运行正常。可选替代：改查 ${FREE_DAILY_MAX_DAYS} 天以内的 K 线或实时行情（走免费渠道，无需数据库）；或自行修好桥接后重试；或联系项目作者做数据源适配。`, 取数诊断: diag, hint: `${FREE_DAILY_MAX_DAYS} 天内 K 线已可走免费渠道（无需数据库），实时行情也可用 get_stock_quote / get_portfolio_quotes；超过 ${FREE_DAILY_MAX_DAYS} 天无降级路径，必须修好桥接。` };
    }
    return {
        error: pre + '由于工作目录不存在可用数据库，当前无法查询该长度的 K 线，若有需求请联系项目作者。',
        取数诊断: diag || 'flit/config.json 与工作目录记忆中都没有可用的数据源',
        排查: ['工作目录 flit/config.json 的 data_sources[].tables.daily', 'flit_bridge 是否在运行（/health）', '桥接目前仅支持 access=docker 的 PostgreSQL'],
        hint,
    };
}

/**
 * 「本地日线库不够最新已收盘交易日 → 免费渠道 →（仅限小缺口）小石」补齐链。
 * 库里只缺 1~2 根时才升级到小石逐只接口（gapDays <= 1，weekdaysBetween 不含两端）；
 * 缺口更大不抽额度，直接让模型告知用户本地日线库待更新（库由用户自己的定时任务维护，扩展不跑同步脚本）。
 * 盘中拼接实时 bar 时，库里残存的当日未收盘行不计入缺口判断（否则永远判定为“已最新”）。
 */
async function fillKlineFromApi(code, days, cache, expected, { liveToday = false } = {}) {
    let source = cache.length ? 'db' : 'none';
    let apiRows = [];
    let apiWarning = null;
    const isEtf = isEtfCode(code);
    const today = localDateStr(new Date());
    // 盘中拼接实时 bar 时，先丢掉库里残留的当日未收盘行再算缺口（否则永远判定为“已最新”，补不到上一交易日）
    let refCache = cache;
    if (liveToday && refCache.length && refCache[refCache.length - 1].date === today) {
        refCache = refCache.slice(0, -1);
    }
    const cacheLast = refCache.length ? refCache[refCache.length - 1].date : '';
    const gapDays = weekdaysBetween(cacheLast, expected);
    // 【保护免费渠道】days > 7 时禁止走免费/小石接口，只返回本地数据库已有数据（含实时拼接）
    if (days > 7 && (!refCache.length || cacheLast < expected)) {
        // 只给保护文案会把「库里陈旧」说成「不给查」，库内有数据时得把缺口天数一并讲清（不代为补齐也不抽额度）
        apiWarning = refCache.length
            ? `${KLINE_RANGE_PROTECTION}；本地日线库缺 ${gapDays} 个交易日（${cacheLast} → ${expected}），缺口过大不逐只调用小石接口；请告知用户本地日线库待更新后重试（本项目不代为同步），当前价改用 get_stock_quote / get_portfolio_quotes 取`
            : KLINE_RANGE_PROTECTION;
        const rows = mergeKlineRows(refCache, [], days + (liveToday ? 1 : 0));
        return { rows, source, cacheLast, apiRows: [], apiWarning, gapDays };
    }
    if (!refCache.length || cacheLast < expected) {
        // 1）免费：股票走东财 push2his（内部已带回退同花顺/百度），ETF 只有同花顺一源
        try {
            trackCall('免费日线(东财/同花顺)');
            const freeRows = isEtf
                ? await adataGetMarketEtfDaily(code.split('.')[0], { startDate: klineStartDate(days) })
                : await adataGetMarketDaily(code.split('.')[0], { startDate: klineStartDate(days), adjustType: 1 });
            apiRows = adataToKlineRows(freeRows);
            if (apiRows.length) source = cache.length ? 'db+adata' : 'adata';
        } catch (e) {
            dbg('adata kline fetch failed', e);
            apiRows = [];
        }
        // 2）免费渠道拿不到：缺口只有一两个交易日才升级小石，大缺口不抽额度
        if (!apiRows.length) {
            if (gapDays <= 1) {
                try {
                    trackCall('小石日线');
                    // 小石的股票日线接口不认 ETF：需显式 instrument=etf，且历史只放未复权价（实测 adjust 只能 none）
                    apiRows = await xiaoshiDailyKline(code, isEtf
                        ? { limit: days, timeoutMs: 15000, instrument: 'etf', adjust: 'none' }
                        : { limit: days, timeoutMs: 15000 });
                    if (apiRows.length) source = cache.length ? 'db+xiaoshi' : 'xiaoshi';
                } catch (e) {
                    dbg('xiaoshi kline fetch failed', e);
                    apiWarning = '免费渠道与小石均未补齐（' + (e && e.message || e) + '）';
                }
                if (!apiRows.length && !apiWarning) apiWarning = '免费渠道返回空且小石未补齐（数据可能滞后）';
            } else {
                apiWarning = `本地日线库缺 ${gapDays} 个交易日（${cacheLast || '无'} → ${expected}），缺口过大不逐只调用小石接口；请告知用户本地日线库待更新后重试（本项目不代为同步），当前价改用 get_stock_quote / get_portfolio_quotes 取`;
            }
        }
    }
    const rows = mergeKlineRows(refCache, apiRows, days + (liveToday ? 1 : 0));
    return { rows, source, cacheLast, apiRows, apiWarning, gapDays };
}

/** 实时行情取数（新浪+腾讯→小石批量→小石单只），返回 { map, diag } */
// 实时行情：单批只数 / 单渠道超时 / 小石单只兜底上限（公开接口偶尔挂住或一颗脏代码带崩整批）
const LIVE_BATCH_MAX = 60;
const LIVE_TIMEOUT_MS = 6000;
const LIVE_SINGLE_MAX = 12;

/** 包一层超时，避免某个渠道挂住把整个工具调用拖死 */
function withTimeout(promise, ms, label) {
    let timer;
    return Promise.race([
        Promise.resolve(promise).finally(() => clearTimeout(timer)),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}超时 ${ms}ms`)), ms); }),
    ]);
}

/** 异常摘要（去掉长 body/堆栈，只留一句能给模型看的原因） */
function errBrief(e) {
    const s = String((e && e.message) || e || '未知错误');
    return s.length > 120 ? s.slice(0, 120) + '…' : s;
}

/**
 * 实时行情（全链路免费优先）：新浪+腾讯合并 → 小石批量 → 小石单只接口。
 * 返回 { map: Map<6 位代码, quote>, diag: string[] }；diag 是逐渠道结果，随工具结果回给模型，
 * 让模型（和排错的人）看得到“优先走了哪个渠道、为何降级”。
 * 小石批量接口对不存在的代码会整批 5xx，所以单只接口是必要的兜底。
 */
async function fetchLiveQuotes(codes6) {
    const out = new Map();
    const uniq = [...new Set((codes6 || []).filter(Boolean))].map(c => String(c).split('.')[0]);
    const diag = [];
    if (!uniq.length) return { map: out, diag };
    const put = (code, q, source) => {
        if (!q || !Number.isFinite(q.price) || q.price <= 0) return;
        out.set(String(code), {
            name: q.name || null,
            price: q.price,
            open: q.open ?? null,
            high: q.high ?? null,
            low: q.low ?? null,
            last_close: q.last_close ?? q.previous_close ?? null,
            change: q.change ?? null,
            change_pct: q.change_pct ?? null,
            volume: q.volume ?? null,
            amount: q.amount ?? null,
            turnover_pct: q.turnover_pct ?? null,
            time: q.time || q.quote_time || null,
            source,
        });
    };
    // 1）免费全字段批量（模块内部新浪+腾讯合并）
    for (let i = 0; i < uniq.length; i += LIVE_BATCH_MAX) {
        const chunk = uniq.slice(i, i + LIVE_BATCH_MAX);
        try {
            trackCall('实时批量(新浪/腾讯)');
            for (const r of await withTimeout(adataListMarketFull(chunk, diag), LIVE_TIMEOUT_MS, '免费实时')) {
                put(r.stock_code, r, '免费(新浪/腾讯)');
            }
        } catch (e) {
            dbg('adata live quotes failed', e);
            diag.push('免费实时异常：' + errBrief(e));
        }
    }
    if (out.size >= uniq.length) return { map: out, diag };
    const miss = uniq.filter(c => !out.has(c));
    const before = out.size;
    // 2）小石批量（只为缺的那几只；Key 未配置就直接说明）
    try {
        const apiKey = await getXiaoshiApiKey();
        if (!apiKey) {
            diag.push('小石 Key 未配置，跳过小石渠道');
        } else {
            const pull = async (list, instrument) => {
                if (!list.length) return;
                trackCall('小石批量');
                const r = await xiaoshiBatchQuotes(list, { apiKey, instrument });
                for (const it of r.items || []) put(it.code, it, 'xiaoshi');
                if (r.missing_codes && r.missing_codes.length) diag.push('小石批量未返回：' + r.missing_codes.join(','));
            };
            await pull(miss.filter(c => !isEtfCode(c)), 'stock');
            await pull(miss.filter(c => isEtfCode(c)), 'etf');
            diag.push(`小石批量 命中 ${out.size - before}/${miss.length}`);
        }
    } catch (e) {
        diag.push('小石批量 失败：' + errBrief(e));
    }
    // 3）小石单只接口兜底（批量整批 5xx 时单只往往仍可用），限 12 只、并发 4，避免拖时
    const still = uniq.filter(c => !out.has(c));
    if (still.length) {
        const apiKey = await getXiaoshiApiKey().catch(() => '');
        if (apiKey) {
            const list = still.slice(0, LIVE_SINGLE_MAX);
            const base = out.size;
            let lastErr = null;
            const got = await mapWithLimit(list, API_CONCURRENCY, async (c) => {
                try {
                    trackCall('小石单只');
                    const q = await xiaoshiQuote(c, { timeoutMs: 8000 });
                    return q && Number.isFinite(q.price) ? [c, q] : null;
                } catch (e) {
                    lastErr = errBrief(e);
                    return null;
                }
            });
            for (const g of got) if (g) put(g[0], g[1], 'xiaoshi(单只)');
            diag.push(`小石单只兜底 命中 ${out.size - base}/${list.length}${lastErr ? '，末错：' + lastErr : ''}${still.length > list.length ? `（尚有 ${still.length - list.length} 只未试）` : ''}`);
        } else {
            diag.push('小石 Key 未配置，无法用单只接口兜底');
        }
    }
    if (!out.size) diag.push('实时行情全渠道不可用，可稍后重试或改用页面刷新模式');
    return { map: out, diag };
}

/**
 * 把当日实时行情拼成日线最后一根（未收盘）。
 * 已有当日行（免费接口盘中也会返回未收盘的当日 bar）则覆盖，没有则追加，总行数仍限 days 根（“近 7 日”=6 根收盘 + 1 根实时）。
 */
function applyIntradayBar(rows, quote, today, days) {
    if (!quote || !Number.isFinite(quote.price) || quote.price <= 0) return { rows, spliced: false };
    const bar = {
        date: today,
        open: quote.open ?? null,
        high: quote.high ?? null,
        low: quote.low ?? null,
        close: quote.price,
        volume: quote.volume ?? null,
        amount: quote.amount ?? null,
        change_pct: quote.change_pct ?? null,
        turnover_pct: quote.turnover_pct ?? null,
        intraday: true,                     // 未收盘标识
        as_of: quote.time || null,          // 行情时刻，便于模型判断当日量已成交多少
        quote_source: quote.source || null,
    };
    const base = rows.filter(r => r.date !== today);
    return { rows: [...base, bar].sort((a, b) => (a.date < b.date ? -1 : 1)).slice(-(days || (base.length + 1))), spliced: true };
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
        // 末行是当日未收盘实时 bar 时才输出这两个字段，模型据此区分“现价”与“收盘价”
        intraday: last.intraday === true ? true : undefined,
        as_of: last.intraday === true ? (last.as_of || null) : null,
        source: source || null,
        warning: warning || null,
    });
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

// ============ A股交易时段与数据时效口径（工具结果与系统提示共用唯一一处） ============

// 09:30 开盘 / 11:30–13:00 午休 / 15:00 收盘，全天 240 分钟。未建模节假日，长假只影响时段提示。
const SESSION_OPEN = 9 * 60 + 30;
const MORNING_END = 11 * 60 + 30;
const AFTERNOON_START = 13 * 60;
const SESSION_CLOSE = 15 * 60;
const SESSION_MINUTES = 240;

function localDateStr(date) {
    const d = new Date(date);
    const p = v => String(v).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 严格早于 ref 的最近工作日（用本地年月日拼接，不用 toISOString，避开跨时区少一天） */
function prevWeekdayStr(date) {
    const d = new Date(date);
    d.setHours(12, 0, 0, 0);
    do { d.setDate(d.getDate() - 1); } while (d.getDay() === 0 || d.getDay() === 6);
    return localDateStr(d);
}

/** 给模型的实时拼接说明（未拼接/拼接失败时也说清楚，避免模型自己猜末行是不是今天） */
function liveSpliceInfo(now, splicedCount, totalCount, asOf, channel, diag) {
    if (!hasLiveSession(now)) return undefined;
    const info = {
        当日bar: localDateStr(now),
        覆盖只数: splicedCount + '/' + totalCount,
        量能说明: sessionVolumeNote(marketPhase(now).tradedMinutes),
    };
    if (!splicedCount) {
        info.说明 = '未拼接到当日实时行情（下列渠道均失败），末行仍为上一交易日收盘';
    } else {
        info.行情时间 = asOf || null;
        info.渠道 = channel || null;
    }
    if (Array.isArray(diag) && diag.length) info.渠道诊断 = diag.slice(-4).join('；');
    return info;
}
/** 时段信息 { phase: weekend|pre|intraday|lunch|closed, label, tradedMinutes } */
function marketPhase(now = new Date()) {
    const d = new Date(now);
    const dow = d.getDay();
    const minute = d.getHours() * 60 + d.getMinutes();
    if (dow === 0 || dow === 6) return { phase: 'weekend', label: '周末休市（未建模节假日）', tradedMinutes: 0 };
    if (minute < SESSION_OPEN) return { phase: 'pre', label: '盘前（尚未开盘）', tradedMinutes: 0 };
    if (minute <= MORNING_END) return { phase: 'intraday', label: '盘中（上午）', tradedMinutes: minute - SESSION_OPEN };
    if (minute < AFTERNOON_START) return { phase: 'lunch', label: '午间休市', tradedMinutes: 120 };
    if (minute <= SESSION_CLOSE) return { phase: 'intraday', label: '盘中（下午）', tradedMinutes: 120 + (minute - AFTERNOON_START) };
    return { phase: 'closed', label: '已收盘', tradedMinutes: SESSION_MINUTES };
}

/** 当日已有成交但未收盘（盘中/午休）——日线工具据此拼接实时 bar */
function hasLiveSession(now = new Date()) {
    const { phase } = marketPhase(now);
    return phase === 'intraday' || phase === 'lunch';
}

/**
 * 日线序列「应当已有的最后一根」日期：盘中/午休为上一交易日（当日由实时拼接提供），
 * 其余时段（盘前/收盘后/休市）等于最新已收盘交易日。
 */
function expectedDailyLastDate(now = new Date()) {
    return hasLiveSession(now) ? prevWeekdayStr(now) : lastClosedSessionStr(now);
}

/** 两个交易日之间隔了多少个工作日（不含两端：少 1 根 = 0、少 2 根 = 1）；只用于判断缺口大小 */
function weekdaysBetween(fromDate, toDate) {
    if (!fromDate || !toDate || toDate <= fromDate) return 0;
    const d = new Date(fromDate + 'T12:00:00');
    let n = 0;
    for (let i = 0; i < 400; i++) {
        d.setDate(d.getDate() + 1);
        if (localDateStr(d) >= toDate) break;
        if (d.getDay() !== 0 && d.getDay() !== 6) n++;
    }
    return n;
}

// ============ 接口调用计数（近 10 分钟窗口，用于向模型自证“没反复抽小石”） ============
const CALL_WINDOW_MS = 10 * 60 * 1000;
const callLog = {
    '免费日线(东财/同花顺)': [],
    '实时批量(新浪/腾讯)': [],
    '本地数据库': [],
    '小石日线': [],
    '小石批量': [],
    '小石单只': [],
    '小石搜索': [],
};

function trackCall(key) {
    const arr = callLog[key];
    if (!arr) return;
    const t = Date.now();
    while (arr.length && t - arr[0] > CALL_WINDOW_MS) arr.shift();
    arr.push(t);
}

function apiCallsNote() {
    const t = Date.now();
    const parts = [];
    for (const [k, arr] of Object.entries(callLog)) {
        while (arr.length && t - arr[0] > CALL_WINDOW_MS) arr.shift();
        if (arr.length) parts.push(`${k} ${arr.length} 次`);
    }
    return parts.length ? '近 10 分钟接口调用：' + parts.join('｜') : null;
}

/**
 * 最新「已收盘交易日」（YYYY-MM-DD）：工作日 15:00 之后算当天，否则回退上一工作日。
 * 只看时段，不管本地日线库是否已更新：盘中由实时行情补当日 bar，历史缺口再按免费/小石链路处理。
 */
function lastClosedSessionStr(now = new Date()) {
    const d = new Date(now);
    const dow = d.getDay();
    const minute = d.getHours() * 60 + d.getMinutes();
    if (dow >= 1 && dow <= 5 && minute >= SESSION_CLOSE) return localDateStr(d);
    return prevWeekdayStr(d);
}

/** 当日成交量能不能跟整日量直接比较，给模型的量比/缩量口径提示 */
function sessionVolumeNote(tradedMinutes) {
    const pct = Math.round(tradedMinutes / SESSION_MINUTES * 100);
    if (tradedMinutes >= 210) return `当日已成交 ${tradedMinutes}/${SESSION_MINUTES} 分钟（${pct}%），成交量已接近全天量，量比/缩量可基本按整日解读`;
    if (tradedMinutes <= 0) return '当日尚无成交';
    return `当日仅成交 ${tradedMinutes}/${SESSION_MINUTES} 分钟（${pct}%），末行成交量远小于全天量，量比/缩量等量能指标对末行不可直接比较，需按时段比例放大后再判`;
}

/**
 * 注入系统提示的「当前时间」上下文：日期 + 星期 + A股时段 + 最新已收盘交易日。
 * 旧版只给 HH:MM:SS（shared/utils.js 的 getDateTime），模型无从判断“日线最新一天是不是今天”，
 * 于是会把上一交易日收盘价当成现价输出。
 */
function nowContext(now = new Date()) {
    const d = new Date(now);
    const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
    const { label, tradedMinutes } = marketPhase(d);
    return `${fmtDateTimeStr(d.getTime())} ${week}｜A股${label}，当日已成交 ${tradedMinutes}/${SESSION_MINUTES} 分钟`
        + `｜最新已收盘交易日 ${lastClosedSessionStr(d)}`
        + (hasLiveSession(d) ? '｜日线工具已拼接当日实时未收盘 bar（各项标 intraday）' : '');
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
        ? '[桥接硬约束] 各组详细规则以 load_tool_group 返回的 rule 为准，不得推测表名/字段，先读 get_workspace_context 与 workflow 再查询。若 bridge_health 返回 bridge_unreachable，立即停止工具调用，只把 start_command 里的 pwsh 命令连同 start_note 的内容一起输出给用户手动执行；绝对禁止用 run_workspace_process 等工具自行启动 flit_bridge。凭据只能写入被 .gitignore 忽略的 flit/config.json，不得写入 memory.md。\n[桥接不通时无级可降] bridge 报 config_invalid / bridge_unreachable / query_failed 时，**不要** docker inspect 查容器标签、不要搜 bridge 源码找 label key、不要推测 bridge 内部机制。两种情况：① 用户要 ≤7 天 K 线或实时行情 → 告知桥接问题后立即降级免费渠道；② 用户要 >7 天 K 线 → 桥接不通就是彻底无路可走，直接告知用户「flit/config.json 已写入但桥接不认，请确保启动；当前无法查 30 日 K，可选：只查 7 天 / 修桥接 / 自备数据源」。禁止 docker exec/psql 直连绕过桥接。1 次重试即降级，不超 2 轮 debug。'
        : '[桥接] 当前未启用。若用户需要本地脚本或数据库查询，告知在 AI 设置中启用桥接、授权目录并启动 flit_bridge 后，重开 AI 窗口并新建会话。';
    const dataRules = '[强制取数] 只要回复里会出现行情数值（价格/涨跌幅/成交量/成交额/OHLCV/K 线表格/现价/收盘），本轮就必须先成功调用行情工具取到真实数据，禁止不调工具直接给出行情结论。工具没被调用、或调用失败，任何数值都不能出现——「之前问过」「规则说可查」「记得大概价位」都不构成数据来源；能用的是本轮工具返回，或已用 retain_tool_data 登记且仍然有效的跨轮便签。用户改查范围（如 30 日改 7 日）或换股票/换天数，必须重新调用取数工具，凭上一轮的失败信息或自己的记忆补写即视为编造。「≤7 个交易日不依赖本地库/桥接」只表示免费渠道能满足取数，绝不等于可以跳过工具直接回答。\n[取数纪律] 多只股票必须一次批量取数（日线用 read_stocks_kline，最多 12 只；实时行情用 get_portfolio_quotes），禁止逐只重复 query；[免费渠道保护] 日 K 跨度分两档：≤7 个交易日——本地库 → 免费（东财/同花顺）→ 小石，**Agent 桥接关闭或未选工作目录也照样能取**；>7 个交易日——为保护免费渠道只能读本地库，禁止改用免费/小石补齐。工具返回「本地数据库不可用/不存在可用数据库/保护免费渠道」等 error 时，照原样转述原因并给出可行替代（改查 7 天内、改查实时现价、或启用桥接），不要重复调用同一工具硬凑。同一批股票的同一类查询只调一次，不要把刚拿过的数据再拉一遍（每次调用都会真花免费接口额度并叠加延时）；最多 2 轮数据收集就要给出结论，超过 3 轮会触发旧工具结果驱逐（早期原始数据被丢弃）；结果被截断或已驱逐时不要反复重试同一查询，必要时缩小范围重取；工具提示本地缓存缺口过大时，直接告知用户跑历史更新脚本，不要反复重查。\n[禁止编造] 你绝对禁止凭空编造股票价格、涨跌幅、成交量等行情数据。没有通过工具（get_stock_quote / get_portfolio_quotes / read_stock_kline）实际获取到真实数据前，不得输出价格数字、涨跌幅、跌停/涨停判定。如果你不确定或没查到，直接说「我没有查到该股票的实时数据」——宁可说不知道也不准编造。每一条价格结论都必须有对应的工具调用记录佐证。\n[上下文口径] 工具的原始返回只在当轮有效：你给出回复后，tool 结果不进入后续上下文（下一轮只能看到一份「哪个工具调过、成功还是失败」的记账）。某份原始数据后面还要用（行情数值、K 线行、库配置、文件要点、SQL 结果），就在本轮调 retain_tool_data 登记成「跨轮上下文便签」：它以隐藏消息回灌给你、不出现在用户界面，也不必抄进回复正文；不登记就等于丢掉，需要时只能重新调用工具。正文只写给用户看的结论与必要数据。反过来，记账里标「失败」的查询从未给过你数据，后续任何一轮都不得把它的结果编成数值。';
    // 数据时效：用户的“今天”与日线的“最新一天”经常不是一个日期，不把这条讲清楚就会被当成查错数据
    const eodRules = '[数据时效] 日线取数按跨度分两档：≤7 个交易日——本地库（工作目录 flit/config.json 登记，经 Agent 桥接只读查询）→ 免费渠道（东方财富/同花顺）→ 小石，桥接关闭或未选工作目录时直接走免费，不影响这一档取数；>7 个交易日——只能读本地库（保护免费渠道），库不可用时工具会给「缺前置条件（本地库）」的原因，照原样转述并给替代方案，不得改用免费/小石补齐。不再读 parquet——年文件只是某时刻全市场快照，供回测/入库用。链路：本地库 → 免费渠道（新浪/腾讯实时、东方财富/同花顺日线）→ 小石 API（只缺 1~2 个交易日且免费不可用时才兜底）。本地库通常滞后一个交易日（由用户侧定时任务发布），工具会自动用免费接口补齐，不算错误；库里缺口更大时不补，如实告知用户本地日线库待更新，不要反复重试，也不要替用户执行任何同步脚本。ETF/指数不在该库，走免费同花顺 ETF 日线（失败再小石，且只有未复权价）。工具报「工作目录不存在可用数据库」时照原样转述，不要改用别的工具硬凑 K 线。盘中（含午休）时，日线末行是工具用一次免费批量行情拼上的当日未收盘 bar（行上标 intraday/as_of）：此时末行 close 可以当「现价」，但当日成交量不满全天，量能结论要看工具返回的 实时拼接.量能说明（已接近收盘时才可当整日量比）。没拼上实时（盘前/收盘后/渠道失败）时，末行只是已收盘日线，只能称「某日收盘价」，不得写成现价/最新价，当日价格请另调 get_stock_quote（单只）或 get_portfolio_quotes（批量）。结论中必须写明数据日期与行情时间；工具返回的 接口调用 / 渠道诊断 / 本地库诊断 是真实渠道状况，报告有异就如实告知用户，不要猜测或重复重试。';
    const lines = [
        '你是「flit stk - 量化盯盘」Chrome 扩展 AI 助手，使用中文。工具按组冷加载：需要能力时先调用 load_tool_group。全局设置只能修改 Cron，直接执行并说明修改结果。flit_stk 是 Chrome 扩展安装目录，不是 Agent 项目目录；不要把文件写入 flit_stk。写入/读取 flit/... 时使用 Agent 工作目录，多个工作目录时自行选择 root。' + wsGuide,
        '[工具组]\n' + bridgeCatalog,
        bridgeHardRules,
        dataRules,
        eodRules,
    ];
    if (state.memoryItems.length > 0) {
        lines.push('', '[长期记忆]：');
        for (const m of state.memoryItems) lines.push('- ' + m.content);
    }
    lines.push('', '[当前时间]：' + nowContext());
    return { role: 'system', content: lines.join('\n') };
}
