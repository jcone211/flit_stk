# 实施计划：桥接未启用时的 AI 对话体验修复（M1~M6）

> 状态记录用文档，写给下一个会话/接手的人。口径来源：`docs/debug.txt` 两次导出（会话 `chat_mtk7gshxtw7` / `chat_mtk7pokg1o2`，扩展 v1.9.0，qwen3.8-flash，**Agent桥接 关闭**，工作目录 stock-assistant）。
> 状态（2026-09-02 深夜）：**M1~M7 已全部落盘**，`node docs/verify-free-first.mjs` → **163 项断言、0 失败**（`--offline-cases` 12/12）；尚待用户在 Chrome 扩展里实测（§4 第 4 步），尚未 commit。
> 相关代码改动：`ai/core/ai_tools.js`（分流/话术/描述）、`ai/core/ai_guard.js`（新增）、`ai/ai.js`（guard 改写 + 账本带目标代码）、`docs/verify-free-first.mjs`（D1/D2/D8/D9/D14 重写 + D19/G1/G2 新增）、`CLAUDE.md`、`API_CHANNELS.md`。
> 时间：2026-09-02 22:51 之后整理。仓库：`D:/codes/ai/flit_stk`
> 相关既有文档：`API_CHANNELS.md`（渠道清单）、`docs/plan-免费优先取数链路.md`、`docs/plan-K线取数改本地数据库.md`。

## 0. 现象

同一句「查询昂利康30日日k」，在**未启用 Agent 桥接**的环境下：

- 3 次用户提问（`查询昂利康30日日k` / `好的` / `1`）→ **10 次模型请求**、约 73 秒；
- 用户最终拿到 **0 条行情数据**、**2 条红色报错**（[020]/[048]），中间只有一条像样的解释（[034]）也是碰运气没被拦；
- 报错文案给的补救建议（「改问 7 日内走免费渠道」）**在当前代码里根本不成立**——用户照做只会再失败一次。

日志时间线（事件编号取自 debug.txt）：

| 编号 | 发生了什么 | 判定 |
| --- | --- | --- |
| [007]-[008] | `load_tool_group(market)` 成功 | 正常（T1 设计，多花一轮） |
| [011]-[012] | `read_stock_kline(昂利康,30)` → 3ms 返回「保护免费渠道…自备数据源…联系项目作者」，`取数诊断: AI 设置未启用 Agent 桥接` | **根因 1**：真实原因是桥接没开，主 error 却讲免费渠道 |
| [014]-[019] | 模型正文 327 字 → guard 一次命中（`价格字样:true / 表格:false`）→ 强制纠正 → 424 字 → 二次命中**丢弃正文** → 红条报错 | **根因 3**：解释型回复被当编造 |
| [023]-[031] | 用户只回「好的」→ guard 又跑一循环 → 模型为交差改调 `read_stocks_kline(codes:["300534"])` | **根因 4**：300534 不是昂利康（工具自己在 [012] 已解析出 `002940.SZ`），代码是编的 |
| [034] | 模型给出「缩短到 7 天以内 / 启用桥接 / 查实时」三选一 | 措辞侥幸不含被禁名词才放行；且方案 1 无法兑现 |
| [036]-[040] | 用户选 1（`days=7`）→ 「本地数据库不可用…请先启用桥接」，**一次免费接口都没打** | **根因 2**：≤7 天并不走免费渠道 |
| [042]-[048] | 同样的解释正文再被 guard 两轮丢弃 → 第二条红条报错 | 根因 3 |
| [022] | SW 30s 断连重连 | 已知正常，与体验无关 |

## 1. 根因定位（file:line 为当前工作区）

### R1 `days > 7` 一律套「保护免费渠道」，把根因盖掉

`ai/core/ai_tools.js:630-633`（单只）、`:694-696` + `:709-713`（批量）：

```js
if (db.error && !isEtfCode(code6)) {
    return days > 7 ? { ...klineRangeProtection(db) } : { ...klineDbUnavailable(db) };
}
```

分流只看 `days`，不看 `db.error` 的**根因**。`KLINE_RANGE_PROTECTION`（`:972`，包装函数 `:1177`）的正当适用场景只有一处：库能用但有缺口（`fillKlineFromApi` `:1227-1231`）。桥接关闭 / 未选主目录属于「库压根没启用」，应该出 `klineDbUnavailable`（`:1187-1197`）里的引导话术。

### R2 `days ≤ 7 && db.error` 直接短路，免费渠道没机会跑

同一处 `else` 分支返回 `klineDbUnavailable`，永远不进 `fillKlineFromApi`——而后者内部才是按 days 决定是否用免费/小石的逻辑（`:1226` 起，仅 `days > 7` 禁用）。结果：三处文档承诺「≤7 天可走免费渠道」，代码一处都不兑现：

- `TOOL_GROUP_RULES.market`（`:79`）：「日 K 超过 7 天时为保护免费渠道，只能查询本地数据库」→ 反义即 ≤7 天可以走免费；
- `klineDbUnavailable` 自己的 `hint`（`:1197`）：「7 天内 K 线可走免费渠道（无需数据库）」；
- `CLAUDE.md`「AI 工具取数一律 本地数据库 → 免费公开渠道 → 小石额度兜底」。

**注意**：`docs/verify-free-first.mjs` 的 D1 / D8 / D9 现在断言「桥接关闭/无库 → 0 次免费日线」，坏行为被回归脚本锁住了，改代码必须连断言一起改。

### R3 反编造 guard 只有「成功 / 没查」两态

`ai/ai.js:415` `quoteEvidence = turnCalls.some(c => QUOTE_TOOLS.has(c.name) && c.ok)`；`summarizeToolCall`（`:497-520`）把「返回体带 `error`」判为 `ok:false`。于是「查过、被明确挡下并给出了原因」＝「没查」。

命中条件 `ai/ai.js:422`：

```js
const hasPriceData = /(现价|收盘|开盘|最高价|最低价|涨跌幅|涨跌额|成交量|成交额|换手率|跌停|涨停|股价)/.test(replyText);
```

**只匹配名词、不要求任何数字**——而「解释为什么取不到数据」的天然措辞就是「无法给出收盘价/涨跌幅」。命中后 `:432-436` 注入命令式「请立即调用 … 重新取数」，模型只能再调（必然再失败）→ 二次命中 `:444-446` `dropAssistantBubble()` + 报错。日志 4 次命中全部 `表格:false / 价格字样:true`，两次丢弃正文。

排障盲区：被拦截的正文**没写进 DEBUG**（`record('guard', { 文本字符 })` 只记长度），事后无法判定真假阳性——[014] 那条 327 字有可能是模型凭预训练记忆真编了数字，[042] 那条 389 字大概率是正当解释。

### R4 账本丢掉解析出的代码 + 丢弃正文 → 模型编代码

`resolveStockCode` 已在 [012] 把「昂利康」解析成 `002940.SZ`，但：账本行（`ai/ai.js:515-518` 失败分支）只带 `argsText` 与失败原因，不带解析结果；正文又被 `dropAssistantBubble()` 丢掉。下一轮模型被强制纠正逼着取数，只能凭记忆写代码 → `codes:["300534"]`。guard 只审正文价格字样，不审工具入参代码来源，真正的编造畅通无阻。

加重因素：第 2 轮起的工具定义来自 `getLoadedToolDefs()`（`ai/core/ai_tools.js:130-144`），description 压成 `read stock kline`、参数 description 全删——模型此时不知道「可传 name、不要猜代码」。

## 2. 修复项（按性价比排序，M1+M2+M3 为止血三件套）

| # | 改动 | 位置 | 验收口径 |
| --- | --- | --- | --- |
| **M1** ✅ | `db.error` 分流按**根因**不按 days：`bridge_disabled` / `workspace_not_set` / `config_invalid` 等「库没启用」类一律走 `klineDbUnavailable`，并在 days>7 时补一句「超过 7 天的日 K 必须有本地库，桥接是前置条件」；`KLINE_RANGE_PROTECTION` 只留给「库能用但有缺口」 | `ai_tools.js:630-633`、`:694-696`、`:709-713` | 30 日 K + 桥接关闭 → error 里出现「未启用 Agent 桥接」与启动步骤，**不出现**「自备数据源/联系项目作者」 |
| **M2** ✅ | `days ≤ 7 && db.error` 不再短路：空 cache 继续 `fillKlineFromApi`（真走免费/小石），结果带 `数据表: null` + `本地库诊断: 本地库不可用，本次 7 日内数据全部来自免费渠道（东财/同花顺）` | 同 M1 三处 | 桥接关闭问 7 日 K → 拿到 7 行真数据、`source` 含 `adata`；小石调用次数 0（免费可用时）；>7 天仍 0 次免费 |
| **M3** ✅ | guard 加第三态：本轮有 `QUOTE_TOOLS` 调用且返回体带 `error` + 诊断（终局拒绝）→ 视为已尽取数义务，放行解释型正文并补一行灰字，不再注入强制纠正；命中条件收紧为「行情名词 + 价格形态数值」 | `ai/core/ai_guard.js`（新增纯函数模块）+ `ai/ai.js:423-460` | G1/G2：解释型→note、终局拒绝后给数值→drop、无证据→correct；真编数字仍被拦 |
| **M4** ✅ | 强制纠正文案去命令式（`correctionPromptText`：已拿不到就照原样转述原因 + 给替代，不要重调同一工具）；`record('guard')` 附被拦正文前 300 字 | `ai/core/ai_guard.js:correctionPromptText`、`ai/ai.js:437-448` | DEBUG 里 guard 事件带 `原因` 与 `正文摘录`；终局拒绝不再白烧一轮 |
| **M5** ✅ | 账本失败行带工具已解析出的 `目标 code/name`；纠正消息内加「只能用本轮或账本中出现过的代码，拿不准就传 name/names」 | `ai/ai.js:summarizeToolCall` 失败分支、`ai_guard.js:correctionPromptText` | 下一轮不再出现来路不明的代码（配合 M7：参数描述真的送给了模型） |
| **M6** ✅ | 文案与实现对齐：`TOOL_GROUP_RULES.market`、两个 kline 工具描述与参数描述、`buildSystemPrompt` 的 `[取数纪律]`/`[数据时效]`、`klineDbUnavailable` hint 全部改成「≤7 天：本地库→免费→小石（桥接开关无关）；>7 天：仅本地库」；`API_CHANNELS.md` §1/§3.1/§5 与 `CLAUDE.md` 同步 | `ai_tools.js:52-53`、`:79`、`dataRules`/`eodRules` | C9 断言全绿；模型不再对用户做出代码不支持的承诺 |
| **M7** ✅（新发现，并入本轮） | `getLoadedToolDefs()` 不再把 description 压成 `read stock kline`、不再删参数描述，改为保留原文 + 上限截断（`TOOL_DESC_CHARS=320` / `TOOL_PARAM_DESC_CHARS=80`）——旧压缩使模型看不到「名称传 name」等参数语义，是 R4（猜代码 300534）的直接成因 | `ai_tools.js:130-152` | C10 新增两项：description 非名字且≤上限、参数描述仍在；market 组实测送出 1380 字 |

### 2.1 回归脚本同步的点（已全部落地）

- D1 → 改名「>7 天给启用指引、≤ 7 天照样降级免费」，双跑 `days=30`/`days=7`，新增 5 项（实际落地见 §2.2）。
- D8 / D9 → 话术类断言改用 `days=30`（该分支现在只在 >7 天命中），D9 加 ≤ 7 天降级断言；D2 同步。
- 新增 **D19**（桥接关闭 + 批量 ≤ 7 天全部走免费）与 **D14 的 >7 天分支**（含钉住「>7 天 ETF 取不到」现状）。
- 新增 **G1/G2**：guard 判定抽成纯函数模块 `ai/core/ai_guard.js` 后直接 import 断言（未采用 `new Function` 抽取），G2 用真工具载荷回放 debug.txt 当时那一轮。
- 断言数 132 → 147（M1/M2）→ **163**（M3~M7）；`CLAUDE.md` 两处与 `API_CHANNELS.md` §0/§5 计数已同步。

### 2.2 已完成

#### ✅ M3 + M4 + M5 + M6 + M7（2026-09-02 23:5x，代码已落盘，回归 **163 项全通过**）

**新增文件 `ai/core/ai_guard.js`**（纯函数、不碰 DOM/chrome，回归脚本可直接 import）：

| 导出 | 作用 |
| --- | --- |
| `QUOTE_TOOLS` | 从 `ai/ai.js` 搬过来，guard / 账本 / `hasPriorQuoteEvidence` 共用一份口径 |
| `quoteFabricationSignal(text, topicIsQuote)` | `{hit, strong, why}`：**名词 + 价格形态数字**才算编造（strong）；「带数字表格 + 行情话题」为弱信号。`stripLookAlikeNumbers` 先剥日期/时间、6 位代码（含 `.SZ/.SH`、`SH600000`）、URL，避免 `2026-09-02`、`002940.SZ` 误判 |
| `isTerminalRefusal(payload)` | 回了 `error` 且带 `取数诊断/本地库诊断/渠道诊断/排查/hint` 之一 → 终局拒绝；抛异常（无结构化 error）不算 |
| `decideQuoteGuard({text, topicIsQuote, refusal, retried})` | 返回 `action`：`pass` / `note`（拒绝后解释型，放行加一行灰字）/ `correct`（无证据首次命中）/ `pass_warn`（弱信号二次命中）/ `drop`（拒绝后仍给数值，或纠正后仍给强信号） |
| `correctionPromptText()` | 强制纠正正文（M4/M5）：不命令「立即重调」，而是「照原样转述不可用原因 + 给可行替代」+「只能用本轮或账本里出现过的代码，拿不准就传 name/names」 |

**`ai/ai.js`**

- 新增 `quoteRefused`（与 `quoteEvidence` 并列，`:419-420`），来源是 `summarizeToolCall` 新返回的 `refusal` 字段。
- guard 整块改写为 `decideQuoteGuard` + 五个分支（`:423-460`），旧版的 `hasPriceData`（只匹配名词）与 `hasTable` 删除；`QUOTE_TOOLS` 本地定义删除、改 import。
- `record('guard')` 统一带 `原因` 与 `正文摘录: clipText(replyText, 300)`（M4，旧版只记长度）。
- `drop` 分支报错文案分两种：终局拒绝场景告诉用户「7 日内日 K 与实时行情不需要库，可直接问」；旧「启用桥接」建议保留（M2 后「改问 7 日内走免费渠道」这句变成真话）。
- `summarizeToolCall` 失败行加 `目标 <code|name>`（M5）。

**M6/M7 文案与描述（`ai/core/ai_tools.js`）**

- `TOOL_GROUP_RULES.market`、`read_stock_kline` / `read_stocks_kline` 描述与 `days`/`name` 参数描述、`buildSystemPrompt` 的 `[取数纪律]`/`[数据时效]`：全部改成两档口径，并新增「按名称查询就传 name/names，禁止自己猜代码」；旧的「提示『保护免费渠道…联系项目作者』」写法在提示词里删除（仅 `KLINE_RANGE_PROTECTION` 常量本身保留，用于 `fillKlineFromApi` 缺口路径）。
- `getLoadedToolDefs()`（M7）：保留真实 description（上限 320）与参数 description（上限 80）。**实测 market 组共送出 1380 字**（旧压缩≈ 60 字），对比模型猜代码的代价，这点预算值得。

**`docs/verify-free-first.mjs` 新增**

- `G1 guard 判定`（10 项）：解释型不算编造 / 日期代码不误判 / 真编造型仍识别 / note / drop / correct→drop / 弱信号 pass_warn / `isTerminalRefusal` 三例 / 纠正文案口径。
- `G2 debug.txt 场景回放`（4 项）：桥接关闭 + `days=30` 的真载荷→refusal=true→解释型回复判 `note`（当时正是这类正文被连丢两次），同载荷下编造型判 `drop`，全程 0 次外呼。
- `C10` 由 4 项 → 6 项：新增「description 保留原文且不超长」「参数描述未被删」。
- 断言数 147 → **163**（`C1 12 / D1~D19 102 / C2~C9 21 / C10 6 / R1 8 / G1+G2 14`）；`CLAUDE.md` 与 `API_CHANNELS.md` 计数已同步。

**尚待 Chrome 实测**（脚本无法覆盖的部分）：打开桥接关闭状态的 AI 窗口，依次问「查昂利康 30 日 K」「查昂利康 7 日 K」「现价」，确认：① 30 日得到桥接启用指引（不再出现「自备数据源」）；② 7 日得到 7 行真数据；③ 全程无 guard 误命中（DEBUG 不应出现 `处理: 丢弃正文` 的 `原因: 工具本轮已终局拒绝…` 之外的条目）。

#### ✅ M1 + M2（2026-09-02 23:3x，代码已落盘，回归 147 项全通过）——本地库失败分流 + ≤7 天无条件降级免费渠道

**`ai/core/ai_tools.js`**

| 改动 | 位置 | 内容 |
| --- | --- | --- |
| 新增天数常量 | `API_CONCURRENCY` 下方 | `const FREE_DAILY_MAX_DAYS = 7;` ——取数口径里唯一允许出现的天数，三处判断均改用它 |
| 单只日线分流 | `read_stock_kline`（原 `:630-633`） | `const dbFailed = !!db.error && !isEtfCode(code6);` → **只有** `dbFailed && days > FREE_DAILY_MAX_DAYS` 才 `return klineDbUnavailable(db, days)`；≤ 7 天不再短路，空缓存继续走 `fillKlineFromApi`（免费→小石） |
| 单只结果自证 | 同上返回体 | `本地库诊断` 追加「本地日线库不可用（bridge_disabled），本次 7 日 K 全部来自免费渠道（东方财富/同花顺）」；`数据表` 为 `null`；`warning` 追加「本地日线库未参与本次取数」 |
| 批量分流 | `read_stocks_kline`（原 `:694-696`/`:709-713`） | `dbFailPayload = dbFailed && days > FREE_DAILY_MAX_DAYS ? klineDbUnavailable(cacheRes, days) : null`；整批返回与逐项 error 均用 `dbFailPayload`，删掉逐项的 `days > 7 ? KLINE_RANGE_PROTECTION : …` |
| 批量结果自证 | 同上返回体 | `本地库诊断` / `warning` 同步追加免费渠道说明 |
| 话术按根因 | `klineDbUnavailable(res, days)` | 新增 `days` 参；四个分支统一前置一句 `你查的是 N 个交易日，超过免费渠道可承担的 7 天……缺的是前置条件（本地库），不是接口故障，也不是渠道限流。`；`hint` 改为「≤ 7 天日 K 与实时行情都不需要库」；旧版硬编码的「当前 30 日 K」「让用户只查 7 天内」已改为动态 `${days}` / 「改查 7 天以内」 |
| 死代码清理 | 原 `klineRangeProtection()` | **已删除**（只有误用的两处引用）；`KLINE_RANGE_PROTECTION` 常量保留，仍是 `fillKlineFromApi` 缺口路径的话术 |

**效果（对比 debug.txt）**：[012] 的「保护免费渠道…自备数据源…联系项目作者」变成「本地数据库不可用：AI 设置里未启用「Agent 桥接」……才能查超过 7 天的日 K」；[040] 的 `days=7` 从「拒绝 + 0 次接口」变成「7 行真数据，source=adata，0 次小石」。

**`docs/verify-free-first.mjs` 回归同步**（旧断言锁死了坏行为，已改）

- D1 → 改名「>7 天给启用指引、≤ 7 天照样降级免费」，双跑 `days=30`/`days=7`，新增 5 项（不冒充保护免费渠道 / N 天前置条件句 / ≤ 7 天拿到 7 行 / 数据表=null 与诊断文案 / 只打免费不抽小石）。
- D2 / D8 / D9 → 话术类断言改用 `days=30`（该分支现在只在 >7 天命中），D2/D9 各加 ≤ 7 天降级断言；D8 原文正则同步新文案「当前无法查询该长度的 K 线」。
- D14 → 重写为「≤ 7 天股票照取、>7 天只对股票报错」，并新增一项锁定 **已知缺口**：`>7 天 ETF 必然吃保护话术`（见 §5 Q4）。
- 新增 D19 → 桥接关闭下 `read_stocks_kline(['600206','001309'], days=7)`：两只均拿到数据、`source` 全为 `adata`、`数据表=null`、`0 次小石`、`0 条 SQL`。
- 断言数 132 → **147**（`CLAUDE.md` 计数待 M6 一起更新）。

#### ✅ 上一轮（同批工作区，未提交）

- `ai/core/ai_tools.js:91-92` 恢复被 `7e33b64` 误删的 `export const TOOL_BY_NAME`（缺失导致每轮组装工具时 `ReferenceError: TOOL_BY_NAME is not defined`，整轮对话必死）。
- `docs/verify-free-first.mjs` 新增 **C10 工具表完整性**（4 项）：真跑 `getLoadedToolDefs()` 全组激活 + 校对 TOOL_DEFS/TOOL_GROUPS/toolExecutors 三者对齐。反向验证过：注掉 TOOL_BY_NAME 后 C10 立刻 FAIL。
- `docs/verify-free-first.mjs` D9 断言同步 `7e33b64` 已改写的话术（旧断言还在匹配被删掉的「日线表读取失败或桥接不可用」）。
- `CLAUDE.md` 断言计数与 C10 口径说明。

## 3. 不做清单（红线，别为了体验破口径）

1. **不为 `days > 7` 放开免费/小石补齐**——「保护免费渠道」是产品约束，M1 只改**文案归因**。（M2 改变的只是 ≤ 7 天的可得性，已于 2026-09-02 由用户明确确认：「桥接无论开启或关闭，都能降级至调用免费 api 获取 7 日日 k」。）
2. **不代用户启动 flit_bridge、不跑任何同步脚本**（`sync_daily.py` 等字样不得出现在文案里）——沿用 `CLAUDE.md` 既有硬约束。
3. **不因为「拿不到数据」而允许模型编**：M3 放行的是**解释型**正文，不是数值型正文；`[禁止编造]` 规则与二次命中丢弃机制保留。
4. **不新增渠道却不补 `callLog` 键**（`小石单只` 曾漏加）。
5. **不为录 demo 改产品代码**；`plugins/` 不参与依赖。
6. 保留既有并发约定：数据落地/写回一律「读最新 → 合并 → 写回」，不依赖内存快照。

## 4. 落地顺序与验证

1. ✅ M1 + M2（同一次改，都在 `ai_tools.js` 日线入口三处）→ D 系列断言同步 + 新增 D19（147 项全通过）。
2. ✅ M3 + M4 + M5（新增 `ai/core/ai_guard.js` 纯函数 + `ai/ai.js` 改写 guard）→ 新增 G1/G2（163 项全通过）。
3. ✅ M6 文案对齐 + M7 工具描述不再压成名字（C10 加两项断言钉住）。
4. ⏳ Chrome 实测（用户手动）三组：① 桥接关闭问「30 日 K」② 桥接关闭问「7 日 K」③ 桥接关闭问「现价」；每组看 DEBUG 是否有 guard 误命中、是否有来路不明的代码。
5. 提交拆分建议（尚未 commit）：
   - `fix(ai): 桥接未启用时日线话术按根因分流 + ≤7 天降级免费渠道（M1/M2）`
   - `fix(ai): 反编造 guard 改三态判定并抽出 ai/core/ai_guard.js（M3/M4/M5）`
   - `docs(ai): 两档取数口径同步到工具描述/系统提示/API_CHANNELS/CLAUDE + 工具描述不再压成名字（M6/M7）`

## 5. 待用户确认的开放问题

1. ~~**M2 是否要做**~~ → **已确认做**（2026-09-02）：桥接开/关都一样，≤ 7 天日 K 一律允许降级免费渠道，代码已按此落地（见 §2.2 M1+M2）。
2. ~~guard 的 `hasPriceData` 收紧后是否还要求「表格 + 话题像行情」也走丢弃~~ → **已按保守方案实现**：弱信号（带数字表格 + 行情话题）二次命中仍为 `pass_warn`（放行加免责），不强杀文件清单类回答；只有「行情名词 + 价格形态数字」的强信号与「终局拒绝后仍给数值」会丢弃（`ai_guard.js:decideQuoteGuard`，G1 已断言）。
3. 未启用桥接时，AI 窗口顶部状态是否需要一个「去 AI 设置启用桥接」的直达按钮（纯 UI，不改取数）。
4. **（M1/M2 跑回归时新发现的旧缺口）>7 天的 ETF 日 K 结构性取不到**：ETF 不入库 → 空缓存必命中 `fillKlineFromApi` 的 `days > 7` 闸门 → 永远返回「保护免费渠道…」。而 `TOOL_GROUP_RULES.market` 写着「ETF 不在本地库内，由免费接口负责」、`CLAUDE.md` 写着「ETF/指数不在本库，一律走免费同花顺 ETF 日线」——三者对不上。本轮**未动**（属产品额度策略），已在 D14 用断言钉住现状。可选：① ETF 豁免 7 天闸门（一根 ETF 日线 = 1 次 HTTP，与股票同量级）；② 把 ETF 也纳入本地库；③ 保留现状但把三处「ETF 由免费接口负责」改成「ETF 仅 ≤7 天可查」。
