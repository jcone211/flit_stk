# flit_stk AI 对话优化方案

> 基于 `docs/debug.txt`（2026-09-01 对话中断事故）的系统性优化计划。
> 完成状态标记：✅ 已实现 | 🔲 待实现 | ⏳ 实现中

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

### T0-1 超时改滑动空闲 (🔲)

| 文件 | 位置 | 改动 |
|------|------|------|
| `ai/core/ai_state.js:16` | `REQUEST_TIMEOUT_MS` | 拆为 `REQUEST_IDLE_TIMEOUT_MS=45s` + `REQUEST_MAX_TIMEOUT_MS=300s` |
| `ai/ai.js:146-149` | `sendRound` | 收到 `ready`/`chunk` 时 `clearTimeout` + 重排空闲超时 |

```js
// 改动后 behavior:
// - 启动时设 idle=45s, max=300s
// - 每收一个 chunk 重置 idle 计时器
// - 45s 无任何 delta → 超时（retriable）；300s 硬上限 → 超时（retriable）
```

background 侧 `AI_CHAT_TIMEOUT_MS`（`background/background.js:566`）同样改为滑动空闲，
或直接移除 SW 侧总超时，改由页面侧统一控制 + SW keepalive 兜底。

### T0-2 SW Keepalive (🔲)

| 文件 | 位置 | 改动 |
|------|------|------|
| `ai/ai.js` sendRound 尾部 | 启动定时调度 | 请求在途时每 20s `postMessage({action:'aiChatPing', requestId})` |
| `background/background.js` | handleAiChatMessage 新增分支 | 收到 ping 回 pong（port 消息重置 30s 空闲计时器）；断开时页面侧收到 `onDisconnect` |

只需 2 个 postMessage 交换 + 页面侧 20s `setInterval`，消灭「请求在途 SW 死亡」场景。

### T0-3 断连即刻失败 (🔲)

| 文件 | 位置 | 改动 |
|------|------|------|
| `ai/ai.js:112` | `port.onDisconnect` | 遍历 `pending` Map，所有在途请求以 `{retriable:true, error:'后台已重启，请求中断'}` 结束 |

```js
state.port.onDisconnect.addListener(() => {
    if (pending.size > 0) {
        for (const [id, p] of pending) { clearTimeout(p.timeoutId); p.resolve({ ok:false, error:'后台已重启，请求中断', retriable:true }); }
        pending.clear();
    }
    setTimeout(connectPort, 500);
});
```

### T0-4 解析 reasoning_content (🔲)

| 文件 | 位置 | 改动 |
|------|------|------|
| `ai/ai_backend.js:127` | `choice.delta.content` 旁 | 加 `choice.delta.reasoning_content` 分支 |
| `ai/ai.js` | `appendToCurrentAssistant` | 收到 reasoning 时显示折叠灰字「思考中…」并**重置空闲超时** |
| 供应商设置 | 设置面板 | 新增「关闭思考」复选框，注入 `enable_thinking:false` 或 `chat_template_kwargs` |

关键效果：
1. 用户在 10-30s 内看到「思考中…」（不是空转），知道模型在工作。
2. reasoning delta 重置空闲超时，不会因为无 content 而杀死请求。

---

## 三、T1 · 瘦身（1~2 小时，把 6 轮 29k 字符压成 2 轮 3k）

> 目标：从数据结构层面减少每轮通信量，让模型可在 1-2 轮内完成同类需求。

### T1-1 批量摘要取数 `read_stocks_kline` (🔲)

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

**实现要点：**
- 并发拉取（`Promise.all(xiaoshiDailyKline)` + parquet 缓存读取），总耗时 ≈ 6s 而不是串行 35s
- `isEtfCode` 分桶统一处理，无单独 ETF 逻辑
- 旧 `read_stock_kline` 保留不变，已有 workflow/memory 不崩

### T1-2 逐轮工具结果驱逐 (🔲)

| 位置 | 改动 |
|------|------|
| `ai/ai.js` `runAgentLoop` | 每轮工具结果返回后、进入下一轮前，检查 `apiMessages` 总字符数 < `MAX_CONTEXT_CHARS`（默认 ~24k） |
| 同上 | 超预算时将最旧 1-2 轮 `role:'tool'` 消息替换为存根：`{role:'tool', tool_call_id:..., content: '«read_stock_kline:600206有研新材 已执行（摘要已归档）》'}` |

注意保留 `tool_call_id` 配对合法性（assistant 的 `tool_calls` 必须对应 tool 消息）。

### T1-3 单工具结果分级上限 (🔲)

| 常量 | 位置 | 当前值 | 改后 |
|------|------|--------|------|
| `MAX_TOOL_RESULT_CHARS` | `ai_state.js:15` | 20000（全局统一） | 改为按工具配置 |
| K 线 | — | 20000 | **2000**（摘要） / **6000**（detail） |
| `read_file` | — | 20000 | 8000 |
| 数据库/script | — | 20000 | 10000 |
| 单轮总预算 | — | 不限 | **16000**，超限自动驱逐旧轮 |

### T1-4 系统提示去重 (🔲)

| 文件 | 位置 | 问题 |
|------|------|------|
| `ai/core/ai_tools.js` | `buildSystemPrompt` + TOOL_CATALOG | bridge 规则 1.3k 在 `TOOL_CATALOG` + `bridgeGuide` + `bridgeRules` 里出现**三份** |

方案：目录每组只留一行摘要（如 "bridge: 本地脚本/数据库查询"），详细规则由 `load_tool_group`
的返回字段 `rule` 给（本来已经返回了）。

### T1-5 并行工具执行 (✅ 已部分实现 | 🔲 get_portfolio_quotes)

`get_portfolio_quotes` 已改为批量接口（1 次请求代替 N 次），见下文「已交付修改」。

其他工具的并行化：`executeToolCalls`（`ai.js:310`）仍为串行 `await`，
但经过 T1-1 批量化后，单轮工具调用数会从 4-6 降到 1-2，现有串行不再成为瓶颈。

### T1-6 取数纪律 (🔲)

在系统提示末尾加一条：

```
- 多只股票必须一次批量取数（read_stocks_kline），禁止逐只 query
- 最多 2 轮数据收集即给结论，超过 3 轮会触发结果驱逐
```

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

### 第一优先级（T0, 70% 断连问题）

| 项 | 估时 | 回归风险 |
|----|------|----------|
| T0-3 断连即刻失败 | 15 分钟 | 低（只在 onDisconnect 加清理）|
| T0-2 SW Keepalive | 20 分钟 | 低（仅请求在途时发 ping）|
| T0-1 滑动空闲超时 | 20 分钟 | 中（改常量 + reset 逻辑）|
| T0-4 reasoning_content | 20 分钟 | 低（新增字段解析 + 折叠 UI）|

合计：约 75 分钟

### 第二优先级（T1, 70% 字符量压缩）

| 项 | 估时 | 备注 |
|----|------|------|
| T1-1 `read_stocks_kline` | 90 分钟 | 最复杂，收益最大 |
| T1-3 单工具上限分级 | 20 分钟 | 与 T1-1 配套 |
| T1-4 系统提示去重 | 15 分钟 | 可独立做 |
| T1-2 结果驱逐 | 60 分钟 | 需 T1-1 做完才有效 |

### 第三优先级（T2, 进阶优化）

按需分批实施，不设具体时间表。