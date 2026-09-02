# 实施计划：AI 取数链路「免费优先 + 当日实时拼接」收尾

> 状态记录用文档，写给下一个会话/接手的人。
> **更新（2026-09-02 盘中）**：§3 的 P0 四项已全部完成，见 §7。原「未再跑联网验证」的说法已失效——现在有 `docs/verify-free-first.mjs` 一次性回归（44 项断言全通过）。
> **⚠️ 已被后续任务覆盖**：同日用户改口径——**K 线不再读 parquet，改读 `flit/config.json` 登记的本地数据库**。本文件的 §1/§2/§5 中「本地 parquet」口径已失效，进度与待办见 `docs/plan-K线取数改本地数据库.md`（实时行情三级链、时段口径、API_CHANNELS.md 那部分仍然有效）。
> 时间：2026-09-02 盘中之后整理。仓库：`D:/codes/ai/flit_stk`

## 1. 起因与目标

用户实测（Debug 信息）暴露三个问题：

1. **9.2 凌晨提问，AI 返回 8.31 数据并称「现价 34.16」** —— 根因：小石全量 EOD 日线次日上午才发布，9.2 01:04 本地日线最新只到 8.31；而系统提示只给 `HH:MM:SS` 不给日期，模型无从判断时效。
2. **AI 工具明明可以免费拿数据却去抽小石额度** —— 日线/实时都直连小石，且免费渠道（新浪/腾讯/东财）基本没被用上（Debug 里 `source: parquet`、`data_2026.parquet` 耗时 23s）。
3. **调用次数与耗时偏高** —— 一次问 12 只股票跑了 8.4s；名称解析还会先抽一次小石搜索。

目标（用户确认的口径）：

- 取数优先级：**本地 parquet → 免费公开渠道（新浪/腾讯实时、东财/同花顺日线）→ 小石 API（额度型，仅兜底）**。
- 交易时段问「近 N 日」应返回 **N-1 根已收盘日线 + 当日实时未收盘 bar**，bar 带 `intraday` + 行情时间 + 量能说明（14:30 的当日量可近似当整日量，10:00 不行）。
- 渠道结果与失败原因**要能让模型看到**（从而对用户说明白「为什么走了这条路」）。
- 根目录新增 API 渠道清单文档，README 引用。

## 2. 已完成（代码已落盘）

### 2.1 `ai/core/ai_tools.js`

| 项 | 位置/名字 | 说明 |
| --- | --- | --- |
| 时段与时效口径 | `marketPhase()` / `lastClosedSessionStr()` / `expectedDailyLastDate()` / `hasLiveSession()` / `sessionVolumeNote()` / `localDateStr()` / `nowContext()` | 取代旧的 `eodAvailableThrough`（那个 08:00 发布闸门与"盘中不得取当日"规则已删除，因为现在由实时拼接承担当日数据） |
| 单只日线 | `read_stock_kline` | 缓存末行若是当日（未收盘残留）则剔除；`liveNeeded = hasLiveSession()` 时不让补齐链追当日；收盘后仍需 1 根则先免费再小石；`rows` 改为 `detail=true` 才返回（省 token） |
| 批量日线 | `read_stocks_kline` / `readOneStockKline` | 同上一套规则；`klineSummary` 新增 `intraday` / `as_of` |
| 实时拼接 | `applyIntradayBar(rows, quote, today, days)` | 覆盖或追加当日 bar，标 `intraday/as_of/quote_source`，总行数仍为 days（"近 7 日"= 6 收盘 + 1 实时） |
| 接口补齐降级 | `fillKlineFromApi` / `needApiFill` / `freeDailyGapLimit = MAX_BATCH_KLINE(12)` | 缺口 ≤1 交易日才试小石；缺口更大返回 `{rows:[], warning:'本地日线缓存缺口 N 个交易日…请运行历史数据更新脚本'}`；ETF 走 `getMarketEtfDaily`，股票走 `getMarketDaily`；`maxApiCodes` 防大批量抽额度 |
| 实时行情链路 | `fetchLiveQuotes(codes6)` → **`{ map, diag }`** | ① 免费全字段批量（模块内部新浪+腾讯）② 小石批量（只为缺的几只）③ **小石单只接口兜底**（限 `LIVE_SINGLE_MAX=12`、并发 `API_CONCURRENCY=4`）；渠道结果写进 `diag`；带 `withTimeout(..., LIVE_TIMEOUT_MS=6000)` 防挂死；`put()` 统一字段（含 `previous_close→last_close`、`quote_time→time`） |
| 渠道诊断透出 | `liveSpliceInfo(now, spliced, total, asOf, channel, diag)` | 输出 `当日bar / 覆盖只数 / 行情时间 / 渠道 / 量能说明 / 渠道诊断`，随 `实时拼接` 字段给模型 |
| 调用计数 | `trackCall()` / `apiCallsNote()`、`callLog`（10 分钟窗口） | 结果带 `接口调用: "近10分钟 免费日线×28、实时批量(新浪/腾讯)×2"`；`'小石搜索'` 已加入 callLog 并在 `resolveStockCode` 里计数 |
| 系统提示 | `buildSystemPrompt` 内 `eodRules` / `dataRules` / `nowContext()` | 头部 `[当前时间]：2026-09-02 10:31:12 周三｜A股盘中｜当日日线未收盘（已用实时行情拼到日线末行，标 intraday+as_of）｜最新已收盘交易日 2026-09-01`；`[数据时效]` 讲清"末行带 intraday 才可称现价"；`[取数纪律]` 新增"同一批股票同一类查询只调一次、缺口大直接提示用户跑更新脚本" |
| 工具描述 | TOOL_DEFS `read_stock_kline` / `read_stocks_kline` / `get_portfolio_quotes` | 已改为免费优先 + 实时拼接 + `数据日期/最新已收盘交易日/实时拼接/接口调用` 口径 |

### 2.2 `js/adata_realtime_quote.js`

- `listMarketFullSina` / `listMarketFullQQ` **已 export**（调试用）。
- `listMarketFull(codeList, diag = null)`：新浪与腾讯**并发取数后按代码合并去重**（主源优先，另一路只补没拿到的；`price` 非正数视为停牌/脏数据剔除）——修掉「一路为空就丢弃另一路结果」的错误回退写法。
- 每个渠道的命中数/失败原因 push 进 `diag`（`免费实时 命中 1/1（新浪 0、腾讯补 1）`）。
- 新增 `shortErr(e)`；`change` / `change_pct` 由 `price` 与 `last_close` 现算。

### 2.3 已做过但可能被后续编辑覆盖的项（**下一个人请复核**）

- `get_stock_quote` 目前返回 `渠道` + `quote.time`，失败时返回 `渠道诊断`，但**没有 `接口调用` 字段**（其它三个数据工具都有）。
- `get_portfolio_quotes` 的 `note` 文案已改成「price 为接口实时报的当日价（各项 time 为行情时间）…渠道见 渠道诊断」。

## 3. 待办清单（按优先级）

### P0 —— 必须做完才能交

1. **回归验证（务必合并成一次脚本跑，别再反复打接口）**
   建议一个临时 mjs 里顺序跑完全部用例，覆盖：
   - `read_stock_kline`：盘中 → 末行 `intraday=true`、`实时拼接.覆盖只数=1/1`、`接口调用` 不含小石；
   - `read_stocks_kline(['600206','512880'])`：混合股票+ETF 不串味、`source` 含 `+live`；
   - `get_stock_quote` / `get_portfolio_quotes`：返回 `time`/`source`，正常路径 0 次小石；
   - **负例 `999999`（无效代码）**：验证「小石批量遇无效代码整批 503」时，单只兜底能否救回来 + `渠道诊断` 是否说清楚；
   - **盘后/周末**：`hasLiveSession()=false` → 不应拼当日 bar、`实时拼接` 字段应为 `undefined`；
   - 用假时钟（覆盖 `getMergedSettings` 或注入 `now`）验 09:30 前 / 11:35 午休 / 15:00 后 / 周六 五种时段的 `nowContext` 与 `数据日期`。
2. **新建 `API_CHANNELS.md`（根目录，README 旁边）** —— 草稿见 §5，直接落地并按实测补「备注」。
3. **README.md 加一段引用**：说明行情/日线渠道、免费优先、`API_CHANNELS.md` 链接。
4. **CLAUDE.md 同步**：把「日线数据时效（重要）」那条 bullet 改写为现在的口径（免费优先 + 盘中实时拼接 + `fetchLiveQuotes` 三级渠道 + `接口调用`/`渠道诊断` 字段），并在 `plugins 目录` 一节补一句「渠道清单见 `API_CHANNELS.md`」。

### P1 —— 需要用户确认后再动

5. **`ai/ai.html`「数据获取方式」区块（约 174-189 行）**：用户倾向「只影响小石就删掉」。
   - **但注意**：该区块含 `apiKey`（小石 Key）与 `dataSource`（API 直取模式选 小石/adata）两项，`background/background.js:1454` 与 `ai/core/ai_tools.js:821` 都在读它们；删了 UI 等于让所有人只能用代码里的内置 Key，并失去「API 直取-小石」这个选项。
   - 建议做法（**先问用户再改**）：保留 `apiKey` 输入框，删掉 `dataSource` 下拉？或者整块保留、只把描述文案改成「小石为额度型接口，AI 工具已免费优先，这里仅在你需要自有 Key / 用 API 直取-小石模式时填写」。**不要在未确认前删功能。**
6. **耗时优化**（用户问过「单次执行时间较长能否优化」）：现状 12 只 ≈ 8.4s，瓶颈是**每只各发一次免费日线请求**（12 次 HTTP，约 500ms/只）。可选方案，需用户拍：
   - a) 缓存健康时不请求日线接口（现在只有缺口才请求，已是这样）→ 真正把耗时降下来靠**用户跑年度更新脚本**，把 parquet 补到最新；
   - b) 缺口大时改用**小石年度文件**（一次请求补多年，R2 CDN，但 23s 量级，见 `docs/debug.txt`）；
   - c) 把免费日线的 `retries` 从默认 3 降到 1、并在 `fillKlineFromApi` 里对同一批代码只请求一次窗口（当前每只独立调用，无法合并——`adata_stock_kline.js` 无批量接口）；
   - d) 并发度 `API_CONCURRENCY` 从 4 提到 6~8（会加重大概率 429 风险，谨慎）。
   **建议：默认只做 (a)（文档里写清楚"缺口大请跑更新脚本"），(b)(c)(d) 等用户明确要求再做。**
7. **名称解析仍走小石搜索**：`resolveStockCode` 在只有 `name` 无 `code` 时直接调 `xiaoshiSearchStock`，而 `ai/core/tools/market_tools.js` 里已有免费 `searchStockInfo`。若要彻底免费优先，可改成 免费搜索 → 小石搜索，并把 `trackCall('小石搜索')` 前再加 `'免费搜索'`。**（改动小但涉及另一工具组，等用户确认）**

### P2 —— 可选

8. `get_stock_quote` 补 `接口调用: apiCallsNote()`（与其他工具一致）。
9. `read_stocks_kline` 的 `perStockHint` 在只数 > 6 时提示「耗时约 Xs，若只需现价改用 get_portfolio_quotes（一次请求）」。
10. DEBUG 侧（`ai/core/ai_debug.js`）把 `接口调用`/`渠道诊断` 单独登记成 `tool_channel` 事件，便于事后统计免费命中率（已提交的 `dbfd22e` 是同类连续报错折叠，与此无关）。

## 4. 实测结论（避免下一个人重复踩）

- **CLI 里所有渠道都能直连**：新浪 `hq.sinajs.cn`（Node 有 undici 警告但能返回 GBK）、腾讯 `qt.gtimg.cn`、东财 push2his、`api.adata.stock.es`、小石 REST。所以用户看到的失败**基本都是浏览器扩展页环境**：扩展页无法设置 `Referer`（禁止头）→ 新浪常被 CORS 拦（Debug 里 `TypeError: Failed to fetch`）。这就是「必须双源合并 + 失败原因可见」的理由。
- **腾讯是浏览器里的主力免费源**：`listMarketCurrentQQ` 已在 background 的 API 直取模式生产可用。
- **小石 `/data/quotes` 批量接口：单个代码不存在会导致整批 503**（实测 `codes=999999` → `503 批量实时行情暂不可用`，其余有效代码也拿不到）。所以第三级「单只接口」是必要兜底，不是过度设计。
- **小石日线 `/data/daily` 是逐只接口**：`xiaoshi_stock_kline.js` 文档明确「每次只取一只」「429 退避」，不存在"一次拿一年全市场"的日线接口（"按年拿全市场"是**下载年度 parquet 文件**那条路径）。
- 免费日线接口**没有全市场某日快照 / 没有指数日线**（adata 上游有 `get_market_daily_a` 但返回逐股列表，不是指数），所以「一次请求补齐全市场缺口」在免费侧做不到。
- **不要打印 API Key**：`API_CHANNELS.md` 与提交物里一律用 `<你的 Key>` 占位。
- **验证时少打接口**：小石免费额度低、东财/腾讯会限流（429）。请把多个用例合进一个脚本跑完。

## 5. `API_CHANNELS.md` 草稿（待落地）

| 渠道 | 费用 | 实时行情 | 历史日线 | 批量能力 | 浏览器可用性 | 代码入口 |
| --- | --- | --- | --- | --- | --- | --- |
| 本地 parquet（小石全量 EOD 镜像） | 一次性下载，读盘免费 | ✗ | ✓（按年文件，qfq 全市场） | ✓（一次解析服务多只，`code $in`） | ✓ | `ai/core/ai_tools.js: readStocksFromParquet` |
| 新浪 `hq.sinajs.cn` | 免费 | ✓ | ✗ | ✓（一次数十只） | ✗ Referer 禁止头，常被拦 | `js/adata_realtime_quote.js: listMarketFullSina` |
| 腾讯 `qt.gtimg.cn` | 免费 | ✓ | ✗ | ✓ | ✓（本项目主力免费实时源） | 同上 `listMarketFullQQ` / `listMarketCurrentQQ` |
| 东方财富 push2his | 免费 | ✗ | ✓（个股/ETF 日线） | ✗（逐只） | ✓（偶发空数据，同花顺兜底） | `ai/stock/adata_stock_kline.js: getMarketDaily / getMarketEtfDaily` |
| 同花顺 / 百度（adata 上游） | 免费 | ✗ | ✓（个股日线） | ✗ | 部分需 Referer | `js/adata_realtime_quote.js`、adata 直取模式 |
| 小石量化 `/data/daily` | 需 Key（额度型） | ✗ | ✓（逐只，含 429 退避） | ✗ | ✓ | `ai/stock/xiaoshi_stock_kline.js: xiaoshiDailyKline` |
| 小石量化 `/market/quote/:code` | 需 Key | ✓ | ✗ | ✗（单只） | ✓ | 同上 `xiaoshiQuote`（实时第 3 级兜底） |
| 小石量化 `/data/quotes` | 需 Key | ✓ | ✗ | ✓（含 ETF，`instrument=etf`） | ✓ | `js/xiaoshi_realtime_quote.js: batchQuotes`（实时第 2 级） |
| 小石量化 R2 年度文件 | 需 Key（签名 URL） | ✗ | ✓（全市场某年快照） | ✓（一次一年） | ✓（实测单次可达 20s+） | `downloadKline` / `getDownloadUrl` |
| 小石量化 `/data/search` | 需 Key | ✗ | ✗ | 名称→代码 | ✓ | `xiaoshiSearchStock`（`resolveStockCode` 用） |

## 6. 交接注意

- 工作树当前**同时含有用户自己的改动**（`ai/ai.css`、`ai/ai.js`、`ai/core/ai_debug.js`、`background/background.js`、`docs/debug.txt`、`js/quote_batch.js`、`shared/quickOpen.js`、`CLAUDE.md`、`ai/core/ai_state.js`、新增 `quick_panel.js/html`、`plugins/` 等）。**提交前务必 `git diff --stat` 与用户确认范围**，不要 `git add -A`。
- 语法检查方式：`cp ai/core/ai_tools.js /tmp/chk.mjs && node --check /tmp/chk.mjs`（Windows 下用 `$TEMP`）。
- 本项目无构建/测试/lint，最终需用户在 Chrome 里 `chrome://extensions` 重新加载扩展并关窗重开 AI 助手验证。

## 7. P0 收尾记录（2026-09-02 盘中执行）

### 7.1 P0-1 回归验证：已做，方式与 §3.1 的设想不同

新增 `docs/verify-free-first.mjs`：在 Node 里用假 `chrome` / 假 `document` / 假 File System Access 目录句柄（直接映射到真实 parquet 目录）驱动 `toolExecutors`，**一次进程内跑完全部用例**，避免反复打接口。用法见 `API_CHANNELS.md` §5。

| 用例 | 覆盖点 | 结果 |
| --- | --- | --- |
| C1 | 9 个假时钟点（09:00/09:30/10:30/11:35/14:40/15:00/15:01/16:30/周六/周一08:00）+ 缺口计数语义 | ✓ 12/12（0 次接口） |
| C2 | `get_portfolio_quotes`（3 只含 ETF） | ✓ 全部走免费，0 次小石 |
| C3 | `get_stock_quote` 正常路径 | ✓ `渠道=免费(新浪/腾讯)`、带 `time` |
| C4 | 负例 `999999` | ✓ 不抛异常、`渠道诊断` 逐级说明 |
| C4b | 屏蔽免费实时 + 同批混脏代码 | ✓ 小石批量整批 503 后，正常代码被**单只兜底**救回（§4 的结论成立） |
| C6b | **空缓存**（qfq 目录为空）问 2 只近 30 日 | ✓ `source=adata+live`、`bars=30`、`免费日线×2 + 实时批量×1 + 小石×0`，全程 0.3s（扩展不下载 parquet） |
| C5 | `read_stock_kline` 盘中：末行 `intraday`、`覆盖只数 1/1`、`source=…+live`、小石增量 0 | ✓（`parquet+adata+live`，缓存停在 08-14 由免费补齐） |
| C6 | `read_stocks_kline` 股票+ETF 混合 | ✓ `2/2`、不串味、免费渠道 |
| C7 | 缓存停在 2023 + 屏蔽免费日线 | ✓ 返回「本地缓存缺 285 个交易日…请跑更新脚本」，**未抽小石** |
| C8 | 无本地缓存 + 屏蔽免费日线 | ✓ 升级到小石且有数据（本次唯一 1 次小石日线） |
| C9 | `buildSystemPrompt` 时间头 | ✓ `2026-09-02 11:33:11 周三｜A股午间休市…｜最新已收盘交易日 2026-09-01｜…已拼接当日实时未收盘 bar` |

合计 52 项断言全通过（首次全量 44 项 @11:32，C4b/C6b 为后补、单跑通过）；小石相关调用合计约 5 次（含 C4 批量 503、C4b 批量+单只、C8 日线 1 次）。盘后 / 周末的端到端用例没在今天跑（当时是盘中），**改口径请在 15:05 后或周末重跑一次 `--offline-cases` + C5**（C1 已用假时钟覆盖判定逻辑，C5/C6 有 `LIVE` 分支自动改断言）。

### 7.2 验证中发现并已修的缺陷（原计划未列出）

1. **`get_portfolio_quotes` 直接崩溃**：`fetchLiveQuotes` 已改返回 `{map, diag}`，本函数仍写 `live.get(...)` → `TypeError: live.get is not a function`（AI 批量行情工具 100% 失败）。改为 `liveMap.get(...)`。——就是 §2.3 担心的「被后续编辑覆盖」，现已证实并修掉。
2. **`小石单只` 不计入 `接口调用`**：`callLog` 缺该键，`trackCall('小石单只')` 静默丢计数，模型会误报「没抽额度」。已补键。
3. **ETF 代码后缀推错**：`resolveStockCode` 用「6 开头才 SH」，`512880` 被写成 `512880.SZ`。改为复用 `shared/utils.js: etfPrefixForCode`（159→SZ，51/58→SH），实测输出 `512880.SH`。
4. **批量日线混进 ETF 会把 11 个年文件全读一遍**（实测 15.6s，浏览器里更糟）：ETF 不在 `a_share_daily` 数据集内，`pending` 永远清不掉。`readStocksFromParquet` 改为「最新一年文件里 0 命中的代码不再往前扫」，实测降到 1.3s。这属 P1-6 的耗时项，因是缺陷级放大顺手做掉。
5. **口径文案与实现差一根**：`gapDays <= 1` 的实际含义是「最多缺 2 根」（`weekdaysBetween` 不含两端），但注释与 `[数据时效]` 提示写的是「缺口 ≤1 交易日」。按实测行为改文案（不改阈值）。

### 7.3 已知未改（留给用户拍板）

- `get_stock_quote` / `get_portfolio_quotes` 仍无 `接口调用` 字段（P2-8），要靠 `渠道` / `渠道诊断` 判断。
- 缺口极大时（C7）**仍会把当日实时 bar 拼到末行**：`rows` 里看不出中间缺 9 个月，只有 `warning` / `数据滞后` 说明。要不要在这种情况下不拼接（或截断到缺口前），属产品口径，未动。
- `time` 格式随渠道不同（免费 `2026-09-02 11:30:00`、小石 ISO `2026-09-02T11:33:52`），未统一。
- 15:00 整点仍按盘中处理（`marketPhase` 用 `<= SESSION_CLOSE`），只影响 60 秒。
- P1-5（`ai.html` 数据获取方式区块）：核实后**该区块不在 `ai.html`**，`apiKey` / `dataSource` 的 UI 在 `popup.html` + `popup/popup.js:1106-1124`，§3.5 的定位要按此修正；仍未动任何功能。
- P1-6 其余选项、P1-7（名称解析改免费搜索优先）、P2-9 / P2-10：未动。

### 7.4 交付物

- 新增 `API_CHANNELS.md`（渠道清单 + 时段口径 + 实测备注 + 验证脚本用法 + Key 优先级），P0-2。
- `README.md`：核心能力加「免费优先取数」一行、详细文档加 `API_CHANNELS.md` 链接，P0-3。
- `CLAUDE.md`：旧的「日线数据时效（`EOD_PUBLISH_HOUR`/`eodAvailableThrough`）」bullet 已换成三条新口径（渠道链 / 时段口径 / 自证字段），`plugins` 一节的回退链方向修正并指向 `API_CHANNELS.md`，P0-4。
- 新增 `docs/verify-free-first.mjs`；`ai/core/ai_tools.js` 见 §7.2 的 5 项修改（`node --check` 通过）。
