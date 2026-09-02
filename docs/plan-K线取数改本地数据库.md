# 代码与回归已完成：AI K 线取数改「本地数据库优先」（不再读 parquet）

> 交接/状态文档，写给下一个会话。日期：2026-09-02（盘中开始，回归收尾约 14:50）。仓库：`D:/codes/ai/flit_stk`
> 前一条任务线（免费优先 + 实时拼接）的收尾见 `docs/plan-免费优先取数链路.md`，其 P0 已完成。
> **当前状态（2026-09-02 第二轮）：§4 的 P0-1（回归脚本改造）与 P0-2（文档收尾）已做完——`node docs/verify-free-first.mjs` 116 项断言 0 失败（含 `--bridge=real` 真库用例）。剩下的只有 P0-3（Chrome 人工验证，唯一不可省）与 P1/P2 优化项。**
> 桥接注意：`curl http://127.0.0.1:17321/health` 在本机因代理环境变量会误报 connection refused，用 `curl --noproxy '*'` 或 `node` 探活才准。

## 1. 需求与已确认口径（用户拍板，照此实现，不要再问）

起因：parquet 年文件是「某一时刻全市场快照」，因除权问题只该用于回测或入库备份，不能当 AI 的实时数据源。

1. **K 线永远不读 parquet**：删除读取 parquet 的代码与相关提示词。
2. 用户访问 K 线时，**读工作目录 `flit/config.json` 拿数据库连接，直接查库**。
3. `flit/config.json` 为空 → 走「当前从工作目录搜索」的逻辑（= 桥接已有的 `flit/memory.md` / `memory/FACT.md` / `AGENTS.md` / `README.md` 推断）；仍搜不到 → 返回：
   `由于工作目录不存在可用数据库，当前无法查询 K 线，若有需求请联系项目作者`
4. **ETF**：库里没有 → 继续走免费同花顺 ETF 日线，失败再用小石兜底。
5. **补齐链保留**：库里只缺最近 1~2 根时先用免费日线补，免费不可用才小石；缺口过大不抽额度。
6. **扩展不执行任何同步脚本**：`sync_daily.py` 是用户私人项目文件，**不得**在文案/提示词/依赖里出现（原「请跑历史数据更新脚本」的文案已改掉）。
7. **名称 → 代码不再优先抽小石搜索**：先本地列表 → 再查库 `stock_basic_cache` → 都没有才小石搜索。
8. **AI 不关心除权**：用户库侧已有除权定时任务，不要加「复权口径为入库时点快照」一类提示。

## 2. 已完成的代码改动

### `ai/core/ai_tools.js`（主战场，语法已 OK）

| 位置 | 内容 |
| --- | --- |
| 16-21 行 | 取数优先级注释改为「本地数据库 → 免费 → 小石」；`parquet 年文件只是某时刻全市场快照，不参与 K 线取数` |
| 50-52 行 | `read_parquet` 工具保留但描述改为「仅用于查看回测/备份文件，不参与 K 线取数」；`read_stock_kline` / `read_stocks_kline` 描述全部改写为本地库口径，并加「报『工作目录不存在可用数据库』时直接转述、不要重试或换工具硬凑」 |
| 597-637 | `read_stock_kline`：`readKlineFromDb(dir, [code], days)` 取代 `loadKlineRows`；`db.error && !isEtfCode` → 直接返回统一话术；结果新增 `数据表` / `本地库诊断`；`source` 前缀由 `parquet` 改 `db` |
| 638-741 | `read_stocks_kline`：一次 SQL 取整批；`dbError` 时**整批都是股票**才顶层报错，混了 ETF 则只对股票逐项给 error；结果新增 `数据表` / `本地库诊断`；`warning` 文案改 `db / adata / xiaoshi / +live` |
| 832-848 | 新增 `searchCodeInDatabase(name)`：查 `plan.basicTable`（`stock_basic_cache` 一类，列名按 `ts_code/code/symbol` 探测），`ORDER BY (name = kw) DESC` 精确匹配优先；探不到表/桥接不可用 → 返 `null` 由小石接管 |
| 849-880 | `resolveStockCode`：传入 code → 本地 stockList/portfolios → **本地库搜索** → 小石搜索；ETF 前缀用 `etfPrefixForCode`（159→SZ，51/58→SH） |
| 891-1088 | 新增本地库层：`MAX_BATCH_KLINE/API_CONCURRENCY/DB_TIMEOUT_MS(12s)/KLINE_DB_COLUMNS/KLINE_DB_REQUIRED/SAFE_TABLE_RE/dbPlanCache`、`primaryRoot()`、`sqlText()`（转义单引号）、`dbNum/dbKlineRow`（psql `-A -t` 出文本，**空串即 NULL**）、`dbQuery()`、`readDbConfigSources()`、`pickDailySource()`、`probeTables()`、`resolveKlineDbPlan()`、`readKlineFromDb()` |
| 1090-1110 | `klineDbUnavailable()`：四种话术分开——桥接未启用（给启用步骤）/ 未设主目录 / 登记了库但读表失败或桥接不可达 / **兜底那句「请联系项目作者」**（附 `排查` 三条 + `hint` 说实时行情仍可用） |
| 1116-1170 | `fillKlineFromApi`：`source` 基准改 `db`；ETF 小石兜底传 `{instrument:'etf', adjust:'none'}`；缺口过大文案改「本地日线库缺 N 个交易日…请告知用户本地日线库待更新（**本项目不代为同步**）」 |
| 1495-1503 | `callLog` 新增键 **`本地数据库`**（每次 SQL 计数），`dbQuery` 里 `trackCall('本地数据库')` |
| 1671 | `[数据时效]` 系统提示整段重写为库口径（含「不要替用户执行任何同步脚本」「照原样转述不可用结论」） |

已删除：`readStockFromParquet` / `readStocksFromParquet` / `KLINE_COLUMNS` / `loadKlineRows` / `klineRow` / `fmtKlineDate`（含上一轮为 ETF 加的 `notCached` 早停逻辑——不再读年文件，那段随之下线）。
保留：`hyparquet` 相关 import（`read_parquet` 工具仍用）、`mergeKlineRows`、`applyIntradayBar`、`fetchLiveQuotes` 三级实时链路（未动）。

### 本轮（第二轮）追加的改动

| 文件 | 内容 |
| --- | --- |
| **新增 `docs/mock-bridge.mjs`** | 假 Agent 桥接：`node:http` 临时端口，照抄 `flit_bridge/server.js` 的 `/v1/workspace/context`、`/v1/database/schema`、`/v1/database/query` 响应形状与**只读 SQL 闸门**；真解析扩展拼出的 SQL（表名 / `code IN` / `adjust` / `date >=` / `rn <=`），行值由 fixture 造。暴露 `total.{klineSql,nameSql,forbidden,looseSql,klineTables}` 累计计数供安全自证 |
| `docs/verify-free-first.mjs` | 删 parquet 语境（`PARQUET_ROOT`/`maxYear`/空 qfq 目录/C6b 全下线），新增 **D1~D18**（假桥接库用例）+ **E1~E3**（`--bridge=real` 真库用例，桥接没起会显式 FAIL 一条 `E0` 而不是静默跳过）；新增按渠道计数 `fetch` 包层 `markNet/netDelta`；`--root` 改为「含 `flit/config.json` 的工作目录」；临时目录写 `REPO/.verify-workspaces/` 跑完删 |
| `ai/core/ai_tools.js` | 顺带做掉 P1-4 / P1-5 与一条 ETF 细节：① `readDbConfigSources` 返回 config 原文稀疏指纹 `stamp`，`dbPlanCache` 的 key 变成「目录+源名+指纹」并加 16 条上限（`dbPlanSet`）——**改了表名不必重开 AI 窗口**；② 猜出来的表名标 `plan.tableGuessed`，`readKlineFromDb` 不再往上报 `table` → `数据表` 留空、只在 `本地库诊断` 里写「表名未经验证」；③ `数据表` 对 ETF 一律给「本库不含 ETF（走免费同花顺日线）」（单只与整批都算），不再摆股票表名 |
| `API_CHANNELS.md` | §3.1 重写为「本地库不可用时的四种话术」；新增 §3.2「config → 桥接 → 表探测 → SQL 形状」（两段真实 SQL + 用户库实测事实）；备注补 `本地数据库` 计数键、「K 线不读 parquet / 不提私人同步脚本」「一条 SQL 取整批的实测耗时」；§4 自证字段补 `数据表`/`本地库诊断`/`取数诊断`，样例换成真库真桥接输出；§5 换成三组用例表。删掉 `sync_daily.py` / 年文件刷新那段说明（需求 6） |
| `CLAUDE.md` | 开发方式里回归脚本一行更新；「取数渠道」bullet 改题「取数渠道与本地库优先口径」并补 config/桥接/探测/四话术/名称解析链；自证字段 bullet 补 `数据表`/`本地库诊断` |
| `.gitignore` | 忽略 `.verify-workspaces/`、`.verify-empty-root/` |

本轮实测（2026-09-02 14:58 盘中）：`--offline-cases` 12/12；全量 **116 项 0 失败**（约 25s）；`--bridge=real` 后 **127 项 0 失败**，E1 单只 30 根真 SQL 0.68s、E2 十二只一批 0.31s、E3 名称解析 0 次小石外呼。

### `ai/stock/xiaoshi_stock_kline.js:98`

`xiaoshiDailyKline(code, {limit, since, to, instrument='stock', adjust='qfq'})`：新增 `instrument`；非 stock 时强制 `adjust=none` 并带 `instrument` 查询参数（实测：`/data/kline/512880?adjust=qfq` → 404「证券代码不在A股股票主表」；带 `instrument=etf` → 拒绝并提示「CN ETF 历史当前仅支持未复权价格」）。**向后兼容**，其他调用点行为不变。

### 文档

- `API_CHANNELS.md`：§1 历史日线链路图、§3 渠道表第一行（本地 PostgreSQL 日线库）、`source` 取值表、示例 JSON 已改成 `db+adata+live`。
- `README.md`：核心能力那一行由「免费优先取数 / 本地 parquet」改为「数据库优先取数 / 本地数据库」。
- `CLAUDE.md`：「取数渠道」bullet 与 plugins 一节的小石回退链方向已改为「本地数据库 → 免费 → 小石」。

### 回归脚本与文档（2026-09-02 第二轮补完，P0-1 / P0-2）

| 文件 | 内容 |
| --- | --- |
| **新增 `docs/mock-bridge.mjs`** | 假 Agent 桥接（`node:http`，临时端口）。照抄 `flit_bridge/server.js` 的三个响应形状与**只读 SQL 闸门**；真解析扩展拼出的 SQL（表名 / `code IN` / `adjust` / `date >=` / `rn <=`），行值由 fixture 造 → 「缺 3 根 / 缺 30 根 / config 空 / 无记忆 / 查表报错」全部可复现。累计计数 `total.{klineSql,nameSql,forbidden,looseSql,klineTables}` 不随 `resetCounts()` 清零，供安全自证用例用。`contextDatabase`（工作目录推断结果）只有在工作目录真的存在 `flit/memory.md`/`AGENTS.md`/`README.md` 时才给，避免把推断做成凭空捏造 |
| `docs/verify-free-first.mjs` | 重写：删掉 `PARQUET_ROOT`/`maxYear`/空 qfq 目录那套；新增 **D1~D18**（假桥接库用例）与 **E1~E3**（`--bridge=real` 真库用例）；C5/C6/C6b/C7/C8 的口径迁入 D 系列（断言改为 `数据表`/`本地库诊断`/`source=db…`）。新增按渠道计数的 `fetch` 包层（`markNet/netDelta`）——错误分支不返 `接口调用` 字段时，仍能断言「没抽小石额度」。`--root` 语义改为「含 `flit/config.json` 的工作目录」（仅真库模式用）；临时工作目录写 `REPO/.verify-workspaces/`（已进 `.gitignore`），跑完删除 |
| `API_CHANNELS.md` | §3.1 重写为「本地库不可用时的四种话术」（表格 + 软规则）；新增 §3.2「`flit/config.json` → 桥接 → 表探测 → SQL 形状」（含两段真实 SQL 与用户库实测事实）；备注补 `本地数据库` 计数键与「K 线不读 parquet / 不提私人同步脚本」；§4 自证字段表补 `数据表`/`本地库诊断`/`取数诊断`，样例换成 09-02 14:42 真库真桥接输出；§5 换成三组用例表 + 新参数。`sync_daily.py` / 年文件刷新那段说明已删 |
| `CLAUDE.md` | 「取数渠道」bullet 改题为「取数渠道与本地库优先口径」，补 config/桥接/探测/四话术/名称解析链；自证字段 bullet 补 `数据表`/`本地库诊断`；开发方式里回归脚本一行更新（116 项、假桥接、`--bridge=real`） |
| `.gitignore` | 忽略 `.verify-workspaces/`、`.verify-empty-root/` |

### P1-4 / P1-5 一并做掉了（`ai/core/ai_tools.js`）

- **计划缓存带 config 指纹**：`readDbConfigSources` 现在顺手对 `flit/config.json` 原文做一次稀疏 hash（`stamp`，不额外 I/O），`resolveKlineDbPlan` 的 cacheKey 变成「目录 + 源名 + 指纹」，并给 `dbPlanCache` 加了 16 条上限（`dbPlanSet`）——改了表名不必重开 AI 窗口（用例 D16）。
- **未验证的表名不当 `数据表`**：桥接读不到表结构且 config 没登记表名时仍按 `a_share_daily` 试查（让真报错从查询里出来，比猜「没库」诚实），但 `plan.tableGuessed=true` 且 `readKlineFromDb` 不往上报 `table` → 结果里 `数据表` 为空，只在 `本地库诊断` 里写「暂按 a_share_daily 试查（表名未经验证）」（用例 D17）。
- **ETF 不再被摆一个股票表名**（本轮顺手修的产品细节，对齐 §4.3 的验收期望）：`数据表` 原来是 `db.table || (isEtf ? 说明 : null)`，库可用时问 ETF 会回一个 `a_share_daily`，看起来像 ETF 是从库里取的。现在单只 ETF 一律给「本库不含 ETF（走免费同花顺日线）」，整批都是 ETF 时同理（混批仍给真实表名 + `命中 1/2`）；用例 D13 末段盯着这条。
- 以上三条都在 `ai/core/ai_tools.js`，`node --check` 通过，对应回归用例 D13 / D16 / D17。

实测结果（2026-09-02 14:58 盘中复跑）：`--offline-cases` 12/12；全量 **116 项 0 失败**（约 25s）；加 `--bridge=real` 后 **127 项 0 失败**，其中 E1 单只 30 根真 SQL **0.68s**、E2 十二只一批 **0.31s**（旧 parquet 路径 8.4s）、E3 名称解析走库 0 次小石外呼。桥接断开时 `--bridge=real` 会显式 FAIL 一条 `E0` 并给出启动命令（不会假装通过）。

## 3. 实测到的用户环境事实（照此设计，别猜）

- `flit/config.json`（工作目录 `D:/sundry/7-ai/agents/stock-assistant`）：`data_sources[0]` = `local-postgres`，`type=postgresql`，`access=docker`，`container=my-postgres`，`database=stock`，`tables={daily:a_share_daily, daily_view:v_share_daily, stock_basic:stock_basic_cache}`，`conventions={adjust:qfq, code_format:'XXXXXX.SZ/.SH/.BJ'}`。
- `a_share_daily`（qfq）：11,063,920 行，**最新 2026-09-01**；列 `adjust,market,code,date,open,high,low,close,volume,amount,change_pct,turnover_pct`，主键 `(adjust,code,date)`；覆盖 SH 2417 / SZ 3045 / BJ 341（北交所自 2025-01-02）。
- **库里没有 ETF/指数**（`code LIKE '51%/15%/58%'` = 0 行），`stock_basic_cache` 也只有 5553 只股票（列 `ts_code,name,industry,list_date,dead_tag`，`ts_code` 形如 `001309.SZ`）。
- 一条 SQL（12 只 × 30 根，`ROW_NUMBER() OVER (PARTITION BY substr(code,1,6) ORDER BY date DESC)`）实测 **0.585s**；原先 parquet 路径 8.4s。
- `psql -X -At -F '\t'` 的 NULL 输出为**空串**（已按此写 `dbNum`）。
- 小石 ETF 日线：`/data/kline/512880?instrument=etf&adjust=none` → `{"code":"512880","detail":"ETF 历史快照尚未发布","available_symbols":["512480"],"retryable":false}` → **绝大多数 ETF 拿不到**，所以 ETF 主要还得靠同花顺免费源，小石只是形式上的兜底。
- 桥接：`flit_bridge/server.js` 是 CommonJS 本地服务，默认 `127.0.0.1:17321`；`/v1/database/query` **只支持 `access:'docker'` 的 PostgreSQL**（`docker exec -i <container> psql`），只允许 `SELECT/WITH/EXPLAIN`，且禁止 `insert|update|delete|drop|alter|truncate|create|grant|revoke` 关键字；未启用时 `/health` 无响应（**本次会话期间桥接没在跑**）。
- `state.bridgeEnabled` / `state.workspaceRootPath` / `state.bridgeUrl`（默认 `http://127.0.0.1:17321`）在 `ai/core/ai_state.js:59-63`，由 `ai/core/ai_settings.js` 从 sync 读取。

## 4. 待办（按优先级，下一个会话从这里接）

### P0 —— 只剩 1 项（1、2 已完成，留着当变更说明）

1. ~~**改造 `docs/verify-free-first.mjs`**~~ ✅ **已完成**（2026-09-02 第二轮）。做法比原计划多做了一步：把假桥接抽成 `docs/mock-bridge.mjs`（真解析 SQL、行值由 fixture 造、照抄只读闸门），用例分成 C（真网络实时）/ D（假库，可复现）/ E（真库，`--bridge=real`）三组。原计划的六条要求逐条落地：错误分支不假设 `rows`、断言改成 `数据表`/`本地库诊断`/`source=db`、默认走 mock 而真桥接要显式 `--bridge=real`、`--root` 改成工作目录语义、C6b 换成 D4（库缺 3 根）、顶部注释与统计同步更新。**旧脚本的 `:356` TypeError 已不存在**。
2. ~~**文档收尾**~~ ✅ **已完成**：`API_CHANNELS.md` §3.1 重写为四种话术、新增 §3.2（config → 桥接 → 表探测 → SQL 形状，含两段真实 SQL 与环境事实）、§4 自证字段补 `数据表`/`本地库诊断`/`取数诊断` 并换成真库实测样例、§5 换成三组用例表；`CLAUDE.md` 的开发方式一行 + 取数渠道 bullet + 自证字段 bullet 已改（T1 bullet 上一轮已改）；`docs/plan-免费优先取数链路.md` 顶部已指向本文件。`sync_daily.py` 与年文件刷新那段说辞已从 `API_CHANNELS.md` 删除。
3. **Chrome 内人工验证**（唯一未做、也不可省的一项）：

   前提：`node flit_bridge/server.js` 在跑（**本轮会话已替用户在后台起了一个，127.0.0.1:17321，只读服务；不需要就关掉那个终端/window**），docker 的 `my-postgres` 已在跑，AI 设置里「Agent 桥接」已勾选。然后 `chrome://extensions` 重载扩展 → 关窗重开 AI 助手：

   - 问「600206 近 30 日走势」→ 期望 `数据表=a_share_daily`、`source=db`（盘中为 `db+live`）、`接口调用` 出现「本地数据库 1 次」且无小石；
   - 问 ETF（512880）→ 期望 `数据表` = 「本库不含 ETF（走免费同花顺日线）」（不再是 `a_share_daily`）、`本地库诊断` 写 `命中 0/1 只`、`source=adata(+live)`；
   - 问「德明利现价」→ 期望名称解析走本地库、**不出现**「小石搜索」；
   - 关掉桥接再问 K 线 → 期望是「未启用 Agent 桥接」那条，而不是「联系项目作者」；
   - 把 `flit/config.json` 改名再问 → 期望走工作目录搜索；搜不到时才是那句「请联系项目作者」。

   已拿到的部分代替证据（不算替代 Chrome 验证）：E1~E3 在 Node 里跑通了真实桥接 + 真实 docker postgres + 真实表（`数据表=a_share_daily`、`source=db+live`、十二只一次 SQL 0.4s、名称解析不抽额度）。扩展页与 Node 的差异主要在校验 CORS/禁止头与目录权限上，而 K 线库路径只多一个 `fetch(127.0.0.1)`——风险点集中在「扩展页能不能访问本地 http 服务」，第一条问就能看出来。

### P1 —— 4/5 已做，6/7 未做

4. ~~`dbPlanCache` 永不过期~~ ✅ 已做（cacheKey 带 config 指纹，用例 D16）。
5. ~~`table = 'a_share_daily'` 猜表名会污染 `数据表`~~ ✅ 已做（`tableGuessed` → `数据表` 为空，用例 D17）。
6. 名称解析查库会给每次解析多 1 次 docker exec（~0.4s）。可只在 `read_stocks_kline`/`get_stock_quote` 批量场景缓存 name→code。**未做**（D11 已量化这件事：一次名称解析 = 2 条 SQL）。
7. 北交所（BJ）库里从 2025-01-02 起：`days` 大于该跨度时末行会偏旧，属数据覆盖而非 bug——`本地库诊断` 已带「末行 X~Y」，够用。

### P2 —— 可选

8. `get_stock_quote` / `get_portfolio_quotes` 仍无 `接口调用` 字段（旧计划 P2-8）。
9. `read_stocks_kline` 只数 >6 时的耗时提示（旧 P2-9）、DEBUG 侧单独登记 `tool_channel`（旧 P2-10）。
10. 上一轮遗留未改的口径观察项：`time` 格式随渠道不统一（免费 `2026-09-02 11:30:00` / 小石 ISO）、15:00 整点按盘中、缺口过大时仍会拼当日实时 bar。

## 5. 重跑与校验命令

```bash
cd D:/codes/ai/flit_stk
node --check ai/core/ai_tools.js && node --check docs/mock-bridge.mjs && node --check docs/verify-free-first.mjs   # 当前均通过
node docs/verify-free-first.mjs --offline-cases   # 时段/缺口口径 12 项，0 次接口 → 全通过
node docs/verify-free-first.mjs                   # 全量 116 项（约 25s）→ 0 失败
node docs/verify-free-first.mjs --only=D6         # 单跑一条（D* 靠假桥接，不打用户库）
node flit_bridge/server.js                        # 真桥接（默认 127.0.0.1:17321），只读查询
node docs/verify-free-first.mjs --bridge=real     # 追加 E1~E3 真库用例（需上一步在跑）
```

已知环境坑：本机 bash 里 `curl http://127.0.0.1:17321/health` 会因代理环境变量报 connection refused（`--noproxy '*'` 也拒），要确认桥接在不在，用 `netstat -ano | grep 17321` 或直接跑 `--bridge=real` 看 E0。

小石相关调用请继续合并进一次脚本跑（额度低、东财/腾讯会限流）；文档与日志里不要出现真实 Key，用 `<你的 Key>` 占位。

## 6. 工作树提交范围提醒

工作树同时含用户自己的在途改动：`ai/ai.html`、`ai/core/ai_state.js`、`docs/debug.txt`、`js/adata_realtime_quote.js`，以及未跟踪的 `plugins/`。本任务真正碰过的文件是：`ai/core/ai_tools.js`、`ai/stock/xiaoshi_stock_kline.js`、`API_CHANNELS.md`、`README.md`、`CLAUDE.md`、`.gitignore`、`docs/mock-bridge.mjs`（新增）、`docs/verify-free-first.mjs`、`docs/plan-*.md`。**提交前 `git diff --stat` 与用户确认，勿 `git add -A`。**
