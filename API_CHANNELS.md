# API 数据渠道清单（flit stk）

> 本扩展的行情 / 日线取数**一律数据库优先**，本地库来自工作目录 `flit/config.json` 登记的 PostgreSQL，额度型接口（小石量化）只在数据库读不到或本地库缺口较大时兜底。
> 本文是渠道口径的唯一出处：改取数链路、新增端点、排查「为什么 AI 又去抽额度了」先看这里。
> 最近一次全渠道实测：2026-09-02 14:56（盘中）跑完全量 **116 项断言**（时段口径 12 + 假桥接库用例 86 + 真实实时/免费与提示词用例 18），0 失败；加 `--bridge=real` 再追加 3 条真库用例（E1 单只 30 根 0.7s / E2 十二只一次 SQL 0.3s / E3 名称解析不抽额度），合计 **127 项 0 失败**。详见 §5。

## 1. 两条链路

**历史日线**（`ai/core/ai_tools.js` → `read_stock_kline` / `read_stocks_kline` → `readKlineFromDb` + `fillKlineFromApi`）

```
工作目录 `flit/config.json` 登记的本地 PostgreSQL 日线库
  → 免费日线：东方财富 push2his（内部再回退 同花顺 / 百度）
  → 小石 /data/daily（逐只，只缺 1~2 个交易日时才调）
  → 缺口更大：不抽额度，返回「本地数据库缺 N 个交易日…请更新本地日线库」
```

**实时行情**（`ai/core/ai_tools.js` → `fetchLiveQuotes`，被 `get_stock_quote` / `get_portfolio_quotes` / 日线实时拼接共用）

```
① 免费全字段批量：新浪 hq.sinajs.cn + 腾讯 qt.gtimg.cn 并发取数后按代码合并（js/adata_realtime_quote.js: listMarketFull）
② 小石 /data/quotes 批量（只查第 ① 步没拿到的那几只，ETF 传 instrument=etf）
③ 小石 /market/quote/:code 单只兜底（限 12 只、并发 4）
```

交易时段（盘中 09:30–11:30、13:00–15:00 与午休 11:30–13:00）问「近 N 日」= **N-1 根已收盘日线 + 1 根当日实时 bar**（`applyIntradayBar` 拼接，行上标 `intraday` / `as_of` / `quote_source`），总行数仍为 N。盘前、15:01 之后、周末不拼，`实时拼接` 字段直接不出现。

## 2. 时段口径（唯一一处算法：`marketPhase` / `hasLiveSession` / `expectedDailyLastDate` / `lastClosedSessionStr`）

| 时刻 | 时段 | 是否拼当日实时 bar | 日线「应有末根」 |
| --- | --- | --- | --- |
| 工作日 09:00 | 盘前 | ✗ | 上一交易日 |
| 工作日 09:30–11:30 | 盘中（上午） | ✓ | 上一交易日（当日由实时提供） |
| 工作日 11:31–12:59 | 午间休市 | ✓ | 上一交易日 |
| 工作日 13:00–14:59 | 盘中（下午） | ✓ | 上一交易日 |
| **工作日 15:00 整点** | **按盘中处理（边界）** | **✓（当日 bar 仍标 intraday）** | 上一交易日 |
| 工作日 15:01 之后 | 已收盘 | ✗ | 当天 |
| 周六 / 周日 | 周末休市 | ✗ | 上周五 |

- **节假日未建模**：长假期间仍按「工作日」判断，后果只是多打一次免费接口，不会回错数据。
- 15:00 整点这一分钟内模型会把它当「现价」而非「收盘价」，影响仅限 60 秒，已知不改。
- 缺口计数 `weekdaysBetween` **不含两端**：少 1 根记 0、少 2 根记 1，所以阈值 `gapDays <= 1` 的实际含义是「最多缺 2 根才升级小石」。

## 3. 渠道清单

| 渠道 | 费用 | 实时行情 | 历史日线 | 批量能力 | 浏览器可用性 | 代码入口 |
| --- | --- | --- | --- | --- | --- | --- |
| 本地 PostgreSQL 日线库（工作目录 `flit/config.json`） | 持久化本地库，查询免费 | ✗ | ✓（qfq A 股全市场；ETF/指数不在库内） | ✓（一条 SQL 取多只） | ✓（需桥接/本地 docker postgres） | `ai/core/ai_tools.js: readKlineFromDb` |
| 新浪 `hq.sinajs.cn` | 免费 | ✓ | ✗ | ✓（一次数十只） | ✗ 扩展页禁止设置 `Referer`，常被 CORS 拦 | `js/adata_realtime_quote.js: listMarketFullSina` |
| 腾讯 `qt.gtimg.cn` | 免费 | ✓ | ✗ | ✓ | ✓ **扩展内主力免费实时源** | 同上 `listMarketFullQQ` / `listMarketCurrentQQ` |
| 东方财富 push2his | 免费 | ✗ | ✓（个股 / ETF 日线） | ✗（逐只） | ✓（偶发空数据，同花顺 / 百度兜底） | `ai/stock/adata_stock_kline.js: getMarketDaily / getMarketEtfDaily` |
| 同花顺 / 百度（adata 上游） | 免费 | ✗ | ✓（个股日线） | ✗ | 部分需 `Referer` | 同上 `trySources` 第二、三源；`js/adata_realtime_quote.js`（API 直取模式） |
| 小石量化 `/data/daily` | 需 Key（额度型） | ✗ | ✓（逐只，含 429 退避） | ✗ | ✓ | `ai/stock/xiaoshi_stock_kline.js: xiaoshiDailyKline` |
| 小石量化 `/market/quote/:code` | 需 Key | ✓ | ✗ | ✗（单只） | ✓ | 同上 `xiaoshiQuote`（实时第 ③ 级兜底） |
| 小石量化 `/data/quotes` | 需 Key | ✓ | ✗ | ✓（含 ETF，`instrument=etf`） | ✓ | `js/xiaoshi_realtime_quote.js: batchQuotes`（实时第 ② 级） |
| 小石量化 R2 年度/单日历史文件 | 需 Key（签名 URL） | ✗ | ✓（`dataset=daily` 一年一个全市场文件；`daily-date` 单日快照；`daily-stock` 单只一年） | ✓（一次一年 / 一日） | ✓（实测年文件 20s+，只适合后台跑） | **扩展内没有下载代码**（`ai/`、`js/`、`background/` 只调 `/data/*` 与行情端点，不调 `/history/*`）——年文件由小石官方增量更新器 `/api/v3/history/auto-update.py` 或你自己的脚本落地 |
| 小石量化 `/data/search` | 需 Key | ✗ | ✗ | 名称 → 代码 | ✓ | `xiaoshiSearchStock`（`resolveStockCode` 用） |

### 各渠道实测备注

- **本地日线库是「上一交易日 EOD」**，由用户自己的定时任务维护；扩展只读不写。缓存末行若是当日（未收盘残留），`fillKlineFromApi` 会先剔除再算缺口，否则永远判定「已最新」而补不到上一交易日。
- **CLI 与扩展页环境不同**：Node/Python 里新浪（GBK 正文）、腾讯、东财、adata、小石全部直连可用；用户 Debug 里看到的 `TypeError: Failed to fetch` 基本是扩展页 CORS/禁止头导致，**因此实时必须双源合并、且失败原因要回给模型**。
- **小石 `/data/quotes` 批量：一个代码不存在 → 整批 503**（实测 `codes=999999` 返回 `批量实时行情暂不可用`），同批有效代码也拿不到。第 ③ 级单只接口是必要兜底而非过度设计：实测屏蔽免费渠道后，`999999 + 600206` 这批里 600206 仍被单只接口救回（`渠道 = xiaoshi(单只)`）。
- **小石 `/data/daily` 是逐只接口**（文档明确「每次只取一只」+ 429 退避），不存在「一次拿一年全市场」的日线接口——那是下载 R2 年度 parquet 那条路径。
- **免费侧没有全市场某日快照、也没有指数日线**（adata 上游 `get_market_daily_a` 返回逐股列表而非指数），所以「一次请求补齐全市场缺口」在免费渠道做不到。
- **ETF 不在本地库内**（库里没有 51/15/58 代码），ETF 日线一律走免费 ETF 接口（失败再小石）。ETF 代码前缀规则与股票不同：`159 → SZ`、`51/58 → SH`（`shared/utils.js: etfPrefixForCode`，`resolveStockCode` 已复用，勿再用「6 开头才是 SH」的粗推断）。
- **`time` 字段格式随渠道不同**：免费渠道为 `2026-09-02 11:30:00`，小石为 ISO `2026-09-02T11:33:52`。展示层别做严格解析。
- **接口调用计数窗口 10 分钟**（`trackCall` / `apiCallsNote`），键为：`本地数据库`、`免费日线(东财/同花顺)`、`实时批量(新浪/腾讯)`、`小石日线`、`小石批量`、`小石单只`、`小石搜索`。新增渠道时要在 `callLog` 里补键，否则该渠道调用不计数（`小石单只` 曾漏加，已修）。`本地数据库` 按**一条 SQL 一次**计（批量取 12 只也算 1 次）。
- **K 线不读 parquet 年文件**：年文件是「某一时刻的全市场快照」，只用于回测 / 入库备份，`read_stock_kline` / `read_stocks_kline` 与提示词里都不该再出现它（`read_parquet` 工具仍在，但描述已写明「不参与 K 线取数」）。也不要在文案 / 提示词里提用户私人项目里的同步脚本名——库的新旧由用户侧定时任务负责，**扩展不代为同步**。
- **一条 SQL 取整批是真快**：12 只 × 20 根实测 0.4s（桥接侧还要 spawn `docker exec psql`），而旧的 parquet 路径实测 8.4s、15.6s。所以批量日线一律走 `read_stocks_kline`，别退回逐只循环。

## 3.1 本地库不可用时会发生什么（四种话术，别再一律「联系作者」）

K 线只从本地库取，所以「库拿不到」必须给用户**可行动**的结论。`resolveKlineDbPlan` 返回的 `error` 键决定话术，实现在 `ai/core/ai_tools.js: klineDbUnavailable`（四条都有回归用例：`--only=D1 / D2 / D8 / D9`）：

| 触发条件 | `error` 键 | 给模型的话术 |
| --- | --- | --- |
| AI 设置没勾「Agent 桥接」 | `bridge_disabled` | 本地数据库不可用：未启用 Agent 桥接 + **启用步骤**（`node flit_bridge/server.js`、重开 AI 窗口） |
| 没选主工作目录 | `workspace_not_set` | 请在 AI 窗口顶部选择工作目录（其中需有 `flit/config.json`） |
| 登记了库但读表 / 查询失败（表不存在、桥接中途挂了、SQL 被拒） | `query_failed` / `bad_table` | 工作目录登记了数据库，但日线表读取失败或桥接不可用：**附真实报错原文**（`取数诊断`）+「若持续失败请联系项目作者」 |
| config 没有 `data_sources`、工作目录记忆也搜不出数据源 | `no_database` | **由于工作目录不存在可用数据库，当前无法查询 K 线，若有需求请联系项目作者** + `排查` 三条 |

共同的软规则：

1. 四条话术都带 `hint`——**实时行情（现价 / 涨跌幅）不需要数据库**，`get_stock_quote` / `get_portfolio_quotes` 仍可正常使用，所以「没库」不等于「什么都答不了」。
2. 失败分支**不抽额度**：没库 / 查询报错时 `fillKlineFromApi` 根本不会被调用，回归用例直接数 HTTP 外呼断言「小石 0 次、免费 0 次」（假桥接模式下连一条 SQL 都不发）。
3. 系统提示已要求模型「照原样转述不可用结论，不要重试或换工具硬凑 K 线」。
4. **股票与 ETF 混批时不互相牵连**：`read_stocks_kline` 只在整批都是股票时才顶层报错，混了 ETF 就逐项给 error——ETF 本来就不在库里，走免费 ETF 日线照取（用例 D14）。
5. 库里**没有数据**（查询成功但 0 行）不算「库不可用」：走 §1 的补齐链，`source` 变成 `adata` / `xiaoshi`，`本地库诊断` 会写「命中 0/N 只」。
6. **已知口径（容易踩）**：日线 SQL 带 `date >= 今天-(days*2+5) 自然日`，所以「库里有数据但末行比这个窗口还老」会被滤成 0 行 → 按「库里没有这只股票」处理：`cacheLast` 为空 → `gapDays=0` → **免费拿不到时是允许升级到小石的**（一次 `limit=days` 的整窗请求，不是逐日循环）。要测「缺口过大不抽额度」，`days` 必须大到窗口能盖住库内末行（回归用例 D6 用 `days=60`，注释里写了原因）。

## 3.2 本地库链路：`flit/config.json` → 桥接 → 表探测 → SQL 形状

配置解析与表探测全在 `ai/core/ai_tools.js`（900-1090 行那段），**只读不写、只查不建**：

1. `readDbConfigSources(dir)`——用 File System Access 直接读工作目录 `flit/config.json`（不经桥接），取 `data_sources`（或 `database`）。
2. `pickDailySource(sources)`——挑源优先级：登记了 `tables.daily|daily_view|kline` 的 > `access:'docker'` 且 container/database 齐全的 > 只要有库名的。**config 为空才**问桥接 `/v1/workspace/context`（桥接侧读 `flit/memory.md` / `memory/FACT.md` / `AGENTS.md` / `README.md` 推断），命中就在 `本地库诊断` 里写「按工作目录搜索到候选数据源：xxx」。
3. `resolveKlineDbPlan`——定「用哪个源 / 哪张表 / 什么复权口径」：登记的表名先过 `SAFE_TABLE_RE` 白名单，再拿 `/v1/database/schema` 的真实列签名核对；表不存在就按列签名（`code/date/open/high/low/close`）重找，`probeTables` 会排掉 `*today|weekly|monthly|temp|backup|test` 这类干扰表，并把表名里带 `daily` 的排前面。`adjust` 取 `conventions.adjust`（缺省 `qfq`），且只有该表真有 `adjust` 列时才加过滤。
4. 结果按「工作目录 + 源名 + `flit/config.json` 原文指纹」缓存在 `dbPlanCache`（只留最近 16 个）：改了表名不必重开 AI 窗口，下一次查询就重新探测（用例 D16）；桥接读不到表结构又没登记表名时，仍按 `a_share_daily` 试一次让真报错浮出来，但这条表名标为「未经验证」、不会当成 `数据表` 回给用户（用例 D17）。名称 → 代码用的 `stock_basic_cache` 也由同一次探测得出（`basicTable` / `basicCodeCol` 按 `ts_code|code|symbol` 探测）。
5. `dbQuery(sql, columns, sourceName)` → 桥接 `POST /v1/database/query`：`docker exec -i <container> psql -X -At -F '\t'`，**只允许 `SELECT/WITH/EXPLAIN`**、超 `DB_TIMEOUT_MS=12s`。psql 的 NULL 输出是空串，`dbNum` 按此收数。

日线 SQL 形状（一条取完整批，实测 12 只 × 20 根 0.4s）：

```sql
WITH ranked AS (SELECT code, date, open, high, low, close, volume, amount, change_pct, turnover_pct,
       ROW_NUMBER() OVER (PARTITION BY substr(code, 1, 6) ORDER BY date DESC) AS rn
  FROM a_share_daily
 WHERE code IN ('600206.SH', '600206', …)      -- 带后缀与 6 位两种写法一起给，不依赖库里 code 的写法
   AND adjust = 'qfq'                           -- 仅当该表有 adjust 列
   AND date >= '<今天 - (days*2+5) 自然日>')
SELECT … FROM ranked WHERE rn <= <days> ORDER BY code, date
```

名称 → 代码的 SQL（`searchCodeInDatabase`，精确匹配优先）：

```sql
SELECT ts_code, name FROM stock_basic_cache
 WHERE name = '德明利' OR name LIKE '德明利%'
 ORDER BY (name = '德明利') DESC LIMIT 5
```

实测环境事实（用户机器，2026-09-02 校准，改链路时按此设计别猜）：`a_share_daily`（qfq）11,063,920 行、末行 2026-09-01、覆盖 SH 2417 / SZ 3045 / BJ 341（北交所自 2025-01-02）；**库里没有 ETF / 指数**（`code LIKE '51%|15%|58%'` = 0 行）；`stock_basic_cache` 5553 只（列 `ts_code,name,industry,list_date,dead_tag`，`ts_code` 形如 `001309.SZ`）。


## 4. 工具返回里的自证字段

本地库优先是否真的生效，不看代码看返回：

| 字段 | 出现在 | 含义 |
| --- | --- | --- |
| `source` | 日线类工具（各项） | `db` / `db+adata` / `db+xiaoshi` / `adata` / `xiaoshi` 的组合，`+live` 表示末行为当日实时 bar；**不会再出现 `parquet`** |
| `数据表` | `read_stock_kline` / `read_stocks_kline` | 实际查的表名（登记或探测得出，如 `a_share_daily`）；**查的是 ETF（单只或整批）时写「本库不含 ETF（走免费同花顺日线）」**，不摆股票表名；表名只在猜（读不到表结构且 config 未登记）时为空，细节去 `本地库诊断` 里看 |
| `本地库诊断` | 同上 | 逐段链路事实：用的哪张表 / 复权口径 / `命中 X/N 只` + 末行日期范围，以及探测阶段的 note（没登记 data_sources、按工作目录搜到候选源、读表结构失败…） |
| `取数诊断` / `排查` / `hint` | 库不可用的四个分支 | 真实报错原文 + 可行动指引（见 §3.1），`hint` 永远提醒「实时行情不需要库」 |
| `数据日期` | `read_stock_kline` / `read_stocks_kline` | 末行日期（盘中即当日，因已拼实时） |
| `最新已收盘交易日` | 同上 | 口径见 §2 |
| `数据滞后` | `read_stocks_kline` | 末行早于最新已收盘交易日时出现，免费与小石均未补齐 |
| `实时拼接` | 盘中 | `当日bar / 覆盖只数 / 行情时间 / 渠道 / 量能说明 / 渠道诊断` |
| `接口调用` | 日线类工具 | 近 10 分钟各渠道计数（含 `本地数据库`），用来自证「没反复抽小石」 |
| `渠道` / `渠道诊断` | 实时类工具 / 失败分支 | 逐渠道命中数与失败原因 |

实测样例（2026-09-02 14:42 盘中，真库真桥接，用例 E1，“600206 近 30 日”）：

```json
{
  "source": "db+live",
  "数据表": "a_share_daily",
  "本地库诊断": "本地库 a_share_daily(qfq) 命中 1/1 只，末行 2026-09-01",
  "数据日期": "2026-09-02",
  "最新已收盘交易日": "2026-09-01",
  "实时拼接": {
    "当日bar": "2026-09-02", "覆盖只数": "1/1",
    "行情时间": "2026-09-02 14:42:22", "渠道": "免费(新浪/腾讯)",
    "量能说明": "当日已成交 222/240 分钟（93%），成交量已接近全天量…",
    "渠道诊断": "免费实时 命中 1/1（新浪 1、腾讯补 0）"
  },
  "接口调用": "近 10 分钟接口调用：实时批量(新浪/腾讯) 1 次｜本地数据库 1 次",
  "cacheLastDate": "2026-09-01", "apiLastDate": null, "warning": null
}
```

注意该例里 **`免费日线` 为 0 次**：库里末行就是最新已收盘交易日，补齐链没动手，当日价那根 bar 只花了一次免费实时批量——这也就是「本地库优先真的生效」的标准形态。库里缺 1~2 根时才会多出 `db+adata` / `db+xiaoshi`。

## 5. 改取数链路后怎么验证（一次跑完，别反复打接口）

```bash
node docs/verify-free-first.mjs                       # 全量（116 项断言，约 25s）
node docs/verify-free-first.mjs --offline-cases       # 只跑不打网络、不起桥接的时段/缺口口径（12 项）
node docs/verify-free-first.mjs --only=D6             # 只跑某条（C*/D*/E* 前缀均可）
node docs/verify-free-first.mjs --bridge=real         # 追加真库用例 E1~E3（先 node flit_bridge/server.js）
node docs/verify-free-first.mjs --bridge=real --root "D:/path/to/workspace"   # 真库模式的工作目录（含 flit/config.json）
node docs/verify-free-first.mjs --bridge=real --bridge-url http://127.0.0.1:17321
```

三组用例，**库的部分全在假桥接里跑**，不拿用户真库当测试床：

| 组 | 依赖 | 覆盖 |
| --- | --- | --- |
| C1（12 项） | 无（假时钟） | 时段/缺口计数口径：盘前/开盘瞬间/盘中/午休/尾盘/15:00 边界/15:01/周末、`weekdaysBetween` 不含两端 |
| D1~D18（86 项） | `docs/mock-bridge.mjs` 假桥接，不打外部接口（除标注的补齐用例） | 四种不可用话术各自命中、库最新时 0 外呼、缺 3 根走免费、缺 2 根才升级小石、缺 30 根不抽额度、config 空走工作目录搜索、表名未登记按列签名探测（排除 `*_today` 干扰表）、名称→代码走库不抽小石搜索、批量一次 SQL、股票+ETF 混批不牵连、只读闸门 0 拒绝、改 config 表名不必重开窗口、未验证的表名不冒充「数据表」 |
| C2~C9（18 项） | 真实网络（新浪/腾讯/东财/小石） | 实时三级链（含脏代码整批 503 + 单只兜底）、提示词注入与库口径 |
| E1~E3（`--bridge=real`） | 真桥接 + docker my-postgres | 真 SQL：单只 30 根、十二只一次 SQL、真库名称解析 |

关键手法：

- **假桥接照抄真实响应形状**（`/v1/workspace/context` + `/v1/database/schema` + `/v1/database/query`），并且照拄它的只读闸门——扩展拼的 SQL 一旦不合规（非 SELECT / 全表拉取）脚本会直接 FAIL，而不是静默放过。SQL 是被**真解析**的（表名 / `code IN` / `adjust` / `date >=` / `rn <=` 都照做），行值由 fixture 造，所以「缺 3 根 / 缺 30 根」是可复现的。
- **看外呼次数而不是看文案**：脚本包了一层 `fetch` 按渠道计数（`免费日线/免费实时/小石/其他`），错误分支不返 `接口调用` 字段时仍能断言“没抽额度”；假桥接侧还记 `klineSql/nameSql/forbidden/looseSql` 累计值，用于断言「整批只发一条 SQL」。
- 工作目录由脚本在 `REPO/.verify-workspaces/` 下造（写假 `flit/config.json` / `flit/memory.md`），跑完删除——**这是脚本唯一写盘的地方**，每个用例用自己的目录以避开 `dbPlanCache`。
- 用例里靠**拦截 `fetch`** 模拟免费渠道失效，不额外消耗额度；小石相关用例合计约 3~5 次调用，请勿为了看日志反复跑。
- 桥接没起时 `--bridge=real` 会**显式 FAIL 一条 `E0`** 并给出启动命令，不会假装通过（探活用的是真桥接地址，不是假的那个）。

## 6. 密钥

- 小石 Key 优先级：调用方显式传入 → 全局设置「数据获取方式 - 小石大数据」（`chrome.storage.sync.apiKey`）→ 代码内置兜底 Key。
- 文档、日志、提交物里一律用 `<你的 Key>` 占位，真实 Key 不写入仓库与 Debug 日志。
