# flit_stk AI 对话优化方案

> 基于 `docs/debug.txt`（2026-09-01 对话中断事故）的系统性优化计划。
> 完成状态标记：✅ 已实现 | 🔲 待实现 | ⏳ 实现中
>
> 进度（2026-09-02）：第一优先级 T0（T0-1~T0-4）与第二优先级 T1（T1-1~T1-4、T1-6）已全部交付；
> T2（token 计量、parquet LRU、摘要落库、rank_stocks）待排期。

---

## 一、事故诊断（`docs/debug.txt` 复盘）

10 轮 `read_stock_kline`（29k 字符）→ 第 6 轮模型要写长结论 → 思考型模型(`qwen3.8-flash`) 的
`reasoning_content` 未被解析 → **120s 内页面上收不到任何 `content` delta** →
固定总超时触发 + MV3 service worker 在请求在途期间被回收 2 次 ×
→ 请求孤儿化，页面侧 pending 空等。

**真正的断连原因不是上下文超长**（~1.8 万 token，模型能装），是**大脑在算但没人看到进度
+ 总超时固定 + SW 无 keepalive** 三重叠加。

---

## 二、T0 · 止血（~30 分钟，4 处改动）

> 目标：消灭「对话进行中突然断连」的故障模式。

### T0-1 超时改滑动空闲 (✅)

| 文件 | 位置 | 改动 |
|------|------|------|
| `ai/core/ai_state.js` | `REQUEST_TIMEOUT_MS` | 已拆为 `REQUEST_IDLE_TIMEOUT_MS=45s` + `REQUEST_MAX_TIMEOUT_MS=300s` |
| `ai/ai.js` `sendRound` | pending 条目 | `touch()` 在 `ready`/`chunk`/`reasoning` 任一事件到来时重置空闲计时；硬上限单独计时 |
| `background/background.js` | `AI_CHAT_TIMEOUT_MS` | 已改为 `AI_CHAT_IDLE_TIMEOUT_MS=60s` + `AI_CHAT_MAX_TIMEOUT_MS=360s`（比页面放宽一档，只作窗口挂起兜底），每个上游事件 `entry.touch()` 重置 |

```js
// 已落地行为：
// - 启动时设 idle=45s, max=300s
// - 每收一个 chunk/reasoning 重置 idle 计时器
// - 45s 无任何 delta → 超时（retriable）；300s 硬上限 → 超时（retriable）
// - 页面超时同时下发 aiChatStop，让 SW 中止在途流，不再白烧 token
```

### T0-2 SW Keepalive (✅)

| 文件 | 位置 | 改动 |
|------|------|------|
| `ai/ai.js` | `startKeepAlive`/`stopKeepAlive` | pending 非空时每 20s（`KEEPALIVE_INTERVAL_MS`）对每个在途 requestId 发 `{action:'aiChatPing', requestId}` |
| `background/background.js` | `handleAiChatMessage` | 新增 `aiChatPing` 分支：回 `{type:'AI_CHAT_PONG'}` 并 `entry.touch()` 重置 SW 空闲计时 |

port 断开时页面侧收 `onDisconnect` → 走 T0-3；实际只需 port 消息往返即吊住 SW。

### T0-3 断连即刻失败 (✅)

| 文件 | 位置 | 改动 |
|------|------|------|
| `ai/ai.js` | `port.onDisconnect` | `failAllPending('后台已重启，请求中断')` 遍历 pending 以 `{retriable:true}` 收尾（保留已流式到的正文），并 `stopKeepAlive()` |
| `ai/ai.js` | `sendRound` 开头 | 新增 `ensurePortReady()`：port 不可用时最多等 2s，避免重连窗口（500ms）内的重试直接撞空 port |

```js
state.port.onDisconnect.addListener(() => {
    state.portAlive = false;
    stopKeepAlive();
    record('error', { text: '与后台 service worker 连接断开，500ms 后重连', 在途请求数: pending.size });
    failAllPending('后台已重启，请求中断');   // 页面不再空等超时
    setTimeout(connectPort, 500);
});
```

### T0-4 解析 reasoning_content (✅)

| 文件 | 位置 | 改动 |
|------|------|------|
| `ai/ai_backend.js` | `handleLine` / `handleNonStream` | 新增 `choice.delta.reasoning_content`（兼容 `reasoning`）→ `emit({type:'reasoning'})` |
| `background/background.js` | 事件转发 | `reasoning` → `AI_CHAT_REASONING`，并重置 SW 空闲计时 |
| `ai/ai.js` | `appendToCurrentThinking` / `finishThinking` | 折叠灰字块「思考中… → 思考过程（N 字）」，同时重置空闲超时；正文到达自动收起 |
| 供应商设置 | 「关闭思考」复选框 | `provider.disableThinking`（存 storage.sync `aiProviders`）→ 请求体注入 `enable_thinking:false` + `chat_template_kwargs` |

关键效果（已达成）：
1. 用户在几秒内看到「思考中…」与实时思考文本（不是空转）。
2. reasoning delta 重置空闲超时，不会因为无 content 而杀死请求。
3. DEBUG 日志新增 `reasoning` 事件与 `思考字符` 字段，下次同类事故能直接看出卡在哪个阶段。

---

## 三、T1 · 瘦身（1~2 小时，把 6 轮 29k 字符压成 2 轮 3k）

> 目标：从数据结构层面减少每轮通信量，让模型可在 1-2 轮内完成同类需求。

### T1-1 批量摘要取数 `read_stocks_kline` (✅)

**新工具**，取代逐只调用 `read_stock_kline`：

```yaml
name: read_stocks_kline
parameters:
  names:       # 股票名称数组，最多 12 只
    type: array, items: string
  codes:       # 股票代码数组（与 names 二选一）
    type: array, items: string
  days:        # 近 N 个交易日，缺省 18
    type: integer, min:1, max:60
  detail:      # false（默认）= 只返回派生指标；true = 含原始 K 线 rows
    type: boolean
  max_rows:    # detail=true 时最多返回行数，缺省 5
    type: integer, max: 18
```

**默认输出（每只股票约 150-250 字符）：**

```json
{
  "name": "有研新材", "code": "600206.SH",
  "close": 48.87, "change_pct": -5.51,
  "ma5": 52.10, "ma10": 48.30, "ma20": 41.25,
  "dd_20d": -18.6,    // 距 20d 高点的回撤百分比
  "vol_ratio_5d": 0.62,          // 今日量 / 5日均量
  "down_streak": 3,              // 连续下跌天数
  "shrink_days": 2,              // 缩量天数（vol < 0.8×5d_avg）
  "amplitude_pct": 6.13,
  "turnover_pct": 7.83,
  "closes": "51.7,51.8,50.2,49.1,48.9"  // 近 5 日收盘价快照
}
```

10 只 ≈ **2.5k 字符**（现在是 29k），且「急跌缩量 / 回踩低位 / 冲高回落」这类判据本来
就是代码可算的，不需要让模型看 180 行 OHLCV 再心算。

**实现要点（已落地，`ai/core/ai_tools.js`）：**
- `readStocksFromParquet(rootHandle, codes, days)`：一年文件只解析一次，用 hyparquet 的
  `filter: { code: { $in: [...] } }` 一次服务多只代码，磁盘 IO 从 N×年数 压成 年数
- 接口补齐走 `mapWithLimit(..., API_CONCURRENCY=4, ...)`，串行 35s → 并发 4 路
- `loadKlineRows` / `fillKlineFromApi` 与 `read_stock_kline`、`read_stocks_kline` 共用同一条
  「parquet → 小石 → adata」回退链，`isEtfCode` 只影响 adata 接口选择，无单独 ETF 分支
- 指标由 `klineSummary` 算：`ma5/ma10/ma20`、`dd_20d`、`vol_ratio_5d`、`down_streak`、
  `shrink_days`、`amplitude_pct`、`fade_pct`（冲高回落/上影幅度）、`turnover_pct`、`closes`、
  `bars`、`source`；`compactObj` 去空字段，实测单只 ≈ 320 字（12 只 ≈ 3.8k）
- 旧 `read_stock_kline` 保留不变，已有 workflow/memory 不崩

### T1-2 逐轮工具结果驱逐 (✅)

| 位置 | 改动 |
|------|------|
| `ai/ai.js` `runAgentLoop` | 每轮拼 `requestMessages` 前调 `evictToolResults(apiMessages)`，用 `msgChars` 求和与 `MAX_CONTEXT_CHARS`（24k）比较 |
| `ai/ai.js` `evictToolResults` | 超预算时按「最旧优先」把 `role:'tool'` 消息换成存根，一回到预算内立即停手（最少驱逐），并写 DEBUG `evict` 事件 + 一条系统提示 |

存根带工具名与原文字数，告知模型可重取：

```json
{ "role": "tool", "tool_call_id": "c1", "content": "«read_stock_kline: 早先的 8000 字结果已驱逐归档（需重新查看请再次调用该工具）»" }
```

已保留 `tool_call_id` 配对合法性：只改 `content` 并打 `m.evicted` 标记，不动 `role`/`tool_call_id`。
与计划的一点差异：**末尾连续的 tool 消息（最近一轮结果）绝不驱逐**，否则模型手上正在用的数据会
丢；若只剩最近一轮仍超预算就不再处理，只记一条 `evict` 诊断日志供调上限。

### T1-3 单工具结果分级上限 (✅)

| 常量 | 位置 | 改后（已落地） |
|------|------|--------------|
| `MAX_TOOL_RESULT_CHARS` | `ai_state.js` | 保留为硬顶 20000，实际不再直接使用 |
| `TOOL_RESULT_CHARS` | `ai_state.js` | read_stock_kline 6000 / read_stocks_kline 5000 / read_file 8000 / read_parquet 8000 / query_local_database 10000 / run_workspace_process 10000 / get_workspace_context 8000 |
| `DEFAULT_TOOL_RESULT_CHARS` | `ai_state.js` | 12000（未列入的工具） |
| `MAX_ROUND_TOOL_CHARS` | `ai_state.js` | 16000（单轮总预算，逐条压缩后续工具上限，每条至少留 600 字） |

超限截断时会告知模型原文字数与「缩小范围/传 limit 重取」的出路，不再只写一句「已截断」。

### T1-4 系统提示去重 (✅)

| 文件 | 问题 | 做法 |
|------|------|------|
| `ai/core/ai_tools.js` | bridge 规则 1.3k 在目录、guide、rules 里出现**三份** | 新增 `TOOL_GROUP_SUMMARY`，`TOOL_CATALOG` 改为每组一行摘要；详细规则只由 `load_tool_group` 返回的 `rule` 给出 |
| 同上 | `bridgeGuide` / `bridgeRules` 两大段重复叙述 | 合并为一句 `[桥接硬约束]`，只保留不能交给按需加载的安全红线（禁止自行启动 flit_bridge、凭据只写 config.json、只写 flit/） |

系统提示由约 3.5k 字符降到约 0.9k（未启用桥接时更少）。

### T1-5 并行工具执行 (✅ | 🔲 其余工具暂不动)

`get_portfolio_quotes` 已改为批量接口（1 次请求代替 N 次），见下文「已交付修改」。

其他工具的并行化：`executeToolCalls`（`ai.js:310`）仍为串行 `await`，
但经过 T1-1 批量化后，单轮工具调用数会从 4-6 降到 1-2，现有串行不再成为瓶颈。

### T1-6 取数纪律 (✅)

已落到 `buildSystemPrompt` 的 `[取数纪律]` 一段：日线走 read_stocks_kline、实时走
get_portfolio_quotes、最多 2 轮取数即给结论、结果被截断/驱逐时不反复重试同一查询。

---

## 四、T2 · 可观测与进阶

### T2-1 Token 用量计量 (🔲)

请求体加 `stream_options: {include_usage: true}` → 响数返回 `usage.prompt_tokens / completion_tokens`。
AI 对话头部状态栏显示 `token 占用: 12.4k/32k` 进度条，DEBUG 日志记录每次请求的 token 数。

### T2-2 parquet 年文件 LRU 缓存 (🔲)

现在每次 `readStockFromParquet` 都重新 `readFileBinary` 整年 + `parquetReadObjects` 全量解析
（见 `ai_tools.js:723`），日志里耗时从 1.6s 涨到 6.3s。

方案：用 `Map` 做 LRU（最多 3 个文件，key = 文件路径），解析后的 ArrayBuffer 和 schema 缓存
在 window 级变量中，同一年份第二次查询直接命中。

### T2-3 取数摘要落库 (🔲)

目前 tool 消息不落库，Session 切换或新用户追问"第三只怎么样"会重新取数。

方案：在 `commitAssistant` 前把压缩摘要（T1-1 输出）作为一条 `role:'assistant'` 备注落库，
标记 `entry.isSummary = true`，渲染时不显示但 LLM 可通过 `continuation` 读到。

### T2-4 本地运算辅助工具 `rank_stocks` (🔲)

对于"10 选 3"类需求，新增本地运算工具：

```yaml
name: rank_stocks
parameters:
  names: string[]         # 股票名称
  by: 'pullback_level' | 'volume_ratio' | 'ma_distance' | 'turnover_surge'
```

在 JS 里算分返回排序表，模型只写结论。参考策略可保存到 `flit/memory.md` 下次复用。

---

## 五、已交付修改

### ✅ T0 止血四项 + T1 瘦身五项（2026-09-02）

| 项 | 主要文件 |
|----|----------|
| T0-1 滑动空闲超时 | `ai/core/ai_state.js`、`ai/ai.js`、`background/background.js` |
| T0-2 SW keepalive（aiChatPing / AI_CHAT_PONG） | `ai/ai.js`、`background/background.js` |
| T0-3 断连即刻失败 + `ensurePortReady` | `ai/ai.js` |
| T0-4 reasoning_content + 思考折叠块 + 「关闭思考」开关 | `ai/ai_backend.js`、`background/background.js`、`ai/ai.js`、`ai/ai.css`、`ai/ai.html`、`ai/core/ai_settings.js` |
| T1-1 `read_stocks_kline` 批量摘要 | `ai/core/ai_tools.js`、`ai/core/ai_state.js` |
| T1-2 逐轮工具结果驱逐 | `ai/ai.js` |
| T1-3 单工具结果分级上限 + 单轮预算 | `ai/core/ai_state.js`、`ai/ai.js` |
| T1-4 系统提示去重 | `ai/core/ai_tools.js` |
| T1-6 取数纪律 | `ai/core/ai_tools.js` |

验证：`node --input-type=module --check` 全部通过；`klineSummary` / `mapWithLimit` /
`evictToolResults` 纯逻辑跑过 25 项断言（指标数值、tool_call_id 配对、并发上限、退化输入）。
端到端（parquet 命中、思考流展示、断连恢复）需在 Chrome 扩展内手动验证。

### ✅ 小石 API Key 修复（2026-09-01）

**文件：** `ai/stock/xiaoshi_stock_kline.js`

改动：`xiaoshiFetch` 在调用方未传入 apiKey 时自动读 `chrome.storage.sync.apiKey`
（全局设置「数据获取方式 - 小石大数据」），均无则回落内置兜底 Key (`DEFAULT_XIAOSHI_API_KEY`)。

Key 来源优先级：调用方传入 > 全局设置 > 内置兜底

新增 `getSettingApiKey()` 导出，供其他模块复用（已用于 `get_portfolio_quotes`）。

401/403 新增归因提示：区分「调用方传入 / 全局设置 / 内置兜底」三种来源，
避免用户误去 AI 设置里的供应商 Key。

### ✅ `get_portfolio_quotes` 改用批量接口（2026-09-01）

**文件：** `ai/core/ai_tools.js`

改动：由原来的 `Promise.allSettled(list.map(xiaoshiQuote))`（N 次 HTTP）
改为调用 `js/xiaoshi_realtime_quote.js` 的 `batchQuotes`（1 次 HTTP + 按 100 只自动切片）。
按 stock/etf 分桶（ETF 前缀 159/51/58 传 `instrument:'etf'`）。

备案字段改为 `compactQuote` 输出：`code/name/price/change/change_pct/open/high/low/last_close/volume/amount/turnover_pct/ time/source` → spotted change: `previous_close` (原用) vs `last_close` (批量接口用)。

**依赖关系：** `ai_tools.js` 新增 import `batchQuotes` from `../../js/xiaoshi_realtime_quote.js`。

---

## 六、实施路径

### 第一优先级（T0, 70% 断连问题）—— ✅ 已完成（2026-09-02）

| 项 | 估时 | 回归风险 | 状态 |
|----|------|----------|------|
| T0-3 断连即刻失败 | 15 分钟 | 低（只在 onDisconnect 加清理）| ✅ |
| T0-2 SW Keepalive | 20 分钟 | 低（仅请求在途时发 ping）| ✅ |
| T0-1 滑动空闲超时 | 20 分钟 | 中（改常量 + reset 逻辑）| ✅ |
| T0-4 reasoning_content | 20 分钟 | 低（新增字段解析 + 折叠 UI）| ✅ |

### 第二优先级（T1, 70% 字符量压缩）—— ✅ 已完成（2026-09-02）

| 项 | 估时 | 备注 | 状态 |
|----|------|------|------|
| T1-1 `read_stocks_kline` | 90 分钟 | 最复杂，收益最大 | ✅ |
| T1-3 单工具上限分级 | 20 分钟 | 与 T1-1 配套 | ✅ |
| T1-4 系统提示去重 | 15 分钟 | 可独立做 | ✅ |
| T1-2 结果驱逐 | 60 分钟 | 需 T1-1 做完才有效 | ✅ |
| T1-6 取数纪律 | 5 分钟 | 系统提示一段 | ✅ |

实测收益：10 只股票日线从 10 次调用 / 29k 字符 → 1 次调用 / ≈ 3.2k 字符；系统提示从
≈ 3.5k → ≈ 0.9k；单轮工具结果封顶 16k，总体上下文超 24k 自动驱逐旧轮。

### 第三优先级（T2, 进阶优化）

按需分批实施，不设具体时间表。