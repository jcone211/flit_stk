# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概览

**flit_stk** — 轻量浏览器股票监控 Chrome 扩展（Manifest V3），定时刷新股票页面，实时抓取价格数据，达到阈值时弹出系统通知。支持同花顺问财、雪球双站点，也可选择「调用 API 直取」模式不经页面、直接调用实时行情接口批量刷新。

## 开发方式

- 无构建系统、无 package.json、无测试、无 lint。全部为原生 JS（ES2020），popup.html 与 background 均以 ES module 加载（script 带 `type="module"`）。
- 根目录 `tsconfig.json` 仅供编辑器做 JS 类型提示，无 TS 源码、不参与构建。
- 开发流程：Chrome 打开 `chrome://extensions` → 开启开发者模式 →「加载已解压的扩展程序」→ 选择本项目目录。改代码后在扩展卡片上点刷新；popup 是独立窗口（`chrome.windows.create` 创建），需关闭后点击扩展图标重新打开。
- 刷新间隔下限 30 秒，由 popup.js 在 UI 层强制（`interval < 30` 时重置为 30）。

## 架构：「抓取 → 解析 → 落库 → 通知」管线

1. **content.js 抓取整页**：页面加载完成后把 `document.documentElement.outerHTML` 连同 title/url/timestamp 以 `{type: 'DOCUMENT_CAPTURED'}` 消息发给 background。
2. **background.js（service worker）调度**：用 `chrome.alarms` 按周期触发（主定时器名固定为 `refreshTimer`）。主定时器触发后为每只股票排一个一次性 alarm（名称前缀 `refreshStock:`，随机延迟反风控）；alarm 触发时对目标 URL `chrome.tabs.query` → 存在则 reload，不存在则 create。alarm 由浏览器进程托管，不随 service worker 回收丢失，因此调度不用 `setTimeout`。
3. **解析与通知**：数据在 SW 经 offscreen 隐藏页解析（SW 无 DOM），读 storage 最新数据匹配合并后写回并触发通知，popup 只做展示。

关键点：数据提取不发生在 content script——content.js 只负责搬运原始 HTML。解析逻辑在 background/landing.js + offscreen 隐藏页（弹窗关闭期间照常落地与通知）。

### 关键设计

- 数据落地（`background/landing.js`）一律「读 storage 最新 → 合并 → 写回」，不依赖内存快照；修改落地/匹配逻辑时保持该模式，避免覆盖 popup/AI 窗口的并发写入。
- 设置（interval/selector/pageSize）在 `chrome.storage.sync`，stockList/currentView 在 `local`（sync 单项 8KB 上限装不下大列表）。
- content.js 顶层 `window.__thswcContentInjected` 标记防重复注入。
- 选择器表 `selectorsEnum`：`wc1`（iwencai 结果页）/ `xq1`（雪球个股页）两组。**抓取解析按抓取页域名派发**（`selectorKeyForUrl`，与下拉框无关，过渡期两站点页面都能解析）；**刷新目标与名称跳转由下拉选择器决定**：`xq1` 且股票已有 `prefix+code` 时，以 `effectiveStockUrl`（shared/utils.js）拼接雪球个股页 `https://xueqiu.com/S/<prefix><code>` 作为刷新/跳转地址（问财链接添加的股票也会改刷雪球），代码未知则回退存储 URL。**ETF 例外**：问财不支持 ETF 查询，code 为 6 位且以 159/51/58 开头时不论选择器一律走雪球——`etfPrefixForCode` 由代码推导交易所前缀（159→SZ，51/58→SH），刷新（`effectiveStockUrl`）、名称跳转（`buildJumpUrl`）、快速打开（quickOpen 输入 ETF 代码直开雪球个股页）三处共用该规则。选择器变更时持久化到 sync 并镜像当前组合，发 `{action:'refresh'}` 触发 background 立即重排 alarm。支持新版式 = 在 `shared/selectors.js` 加一组枚举（解析由 offscreen 页调用 `popup/parsers.js` 完成）。
- 开盘价由 `当前价 - 涨跌额` 反推（`kpj = dqj - zdf`），页面上没有直接的开盘价字段。
- 股票条目 `stopRunning: true` 表示不参与定时刷新，`inTrash: true` 表示在垃圾池。background 调度按 `currentView`（list/trash，持久化在 local）+ `inTrash` + `stopRunning` 三重过滤——只刷新当前视图下的股票；增删股票/切换启停发 `{action: 'refresh'}`，切换视图发 `{action: 'setView'}`。
- 数据模型：`importPrice`（初始价，首次抓取自动回填当前价，之后仅手动改）；`importTargetPercentLe/Ge`（导入以来目标阈值）；通知锁存 `notifiedDaily`/`notifiedImport` 相互独立，当日或导入以来任一越界即通知；导入以来涨跌幅为派生值 `(currentPrice-importPrice)/importPrice*100`，不存储。
- 首次启动自动把 stockList 从 sync 迁移到 local（background `ensureMigrated` 幂等，background 是唯一迁移执行者，popup 不自行迁移）；存储的 url 恒为 `new URL().href` 百分号编码形态，显示层统一 `safeDecodeUrl` 解码。
- popup 列表支持分页（pageSize 存 sync，默认 10）、按当日/导入以来涨跌幅排序、股票列表与垃圾池双视图；数据可经工具栏导入导出 JSON（导入按 URL 合并），导入导出可登记为命名组合（不超过 4 字），页脚首行「持仓组合」标签 + 导入导出图标 + 分页同行、组合卡片独立成行，一键切换组合；非活动组合可经 chip 内 × 删除（活动组合须先切走；初始组合「默认」固定首位、不可删除）。
- 股票列表通过 DOM 字符串拼接渲染（`renderStock`），编辑/启停按钮在渲染时逐个绑定事件，勿依赖事件委托。
- AI 对话链路可靠性（T0）：单轮请求为「滑动空闲 45s + 硬上限 300s」双档超时（`REQUEST_IDLE_TIMEOUT_MS` / `REQUEST_MAX_TIMEOUT_MS`），每收 ready/chunk/reasoning 重置空闲计时，超时主动发 `aiChatStop` 中止 SW 在途流；后台 `AI_CHAT_IDLE_TIMEOUT_MS=60s`/`MAX=360s` 只作兜底（均比页面宽一档）。请求在途时每 20s `aiChatPing` 保活 SW（MV3 下光靠 long-lived port 吊不住）；port `onDisconnect` 立即把 pending 全部以 `{retriable:true}` 收尾（`failAllPending`），重连由 `ensurePortReady` 在下一次发送前兜住——改超时/重连逻辑时不要再回到固定总超时。
- AI 思考过程（T0）：`ai_backend.js` 解析 `delta.reasoning_content`（兼容 `delta.reasoning`）并 emit `reasoning` 事件，后台转 `AI_CHAT_REASONING`，页面 `beginThinking/appendToCurrentThinking/finishThinking` 渲染可折叠灰字（不并入正文、不落库）。供应商可选 `disableThinking`，开启后请求体才注入 `enable_thinking:false` + `chat_template_kwargs`。
- AI 字符量控制（T1）：多只股票日线一律走 `read_stocks_kline`（一次读年文件 `filter: {code:{$in:[...]}}` + `mapWithLimit` 并发 4，只回 `klineSummary` 派生指标）；工具结果按 `TOOL_RESULT_CHARS` 分级上限截断，单轮总预算 `MAX_ROUND_TOOL_CHARS=16000`，上下文超 `MAX_CONTEXT_CHARS=24000` 时 `evictToolResults` 驱逐最旧几轮 tool 结果（只改 content，保留 role/tool_call_id 配对，最近一轮不驱）。系统提示只留一行工具组目录（`TOOL_GROUP_SUMMARY`）与硬约束，详细规则由 `load_tool_group` 的 `rule` 字段给出。
- AI 助手 DEBUG 模式（优化与排错）：开关在「AI 设置 → 全局设置」复选框，存 sync `aiDebugMode`；记录器 `ai/core/ai_debug.js` 按会话记录用户问题、AI 回复、工具调用方法与传参、工具返回、思考过程（reasoning）、上下文驱逐（evict）、请求/响应元信息与报错（含 window error / unhandledrejection），存 local `aiDebugLogs`（单会话 300 条、单字段 4000 字符、最多 8 个会话，落库前先读最新存量再合并写回，与数据落地同一套并发约定）。开启后头部目录行最右侧显示「Debug信息」按钮（`debugInfoBtn`，由 `syncDebugBtn` 控制显隐），点击即把当前会话记录以纯文本复制到剪切板（clipboard API 失败降级 `execCommand`）。同类连续报错走 `recordRepeat(kind, data)`（`ai/core/ai_debug.js`）折叠：key = kind + text，同组（两次间隔 ≤ `REPEAT_COLLAPSE_WINDOW_MS`=120s，允许其他类型日志插入）只留首条与一条「滚动末条」，后续重复就地带新字段并移到末尾（附 `连续重复: N` / `首次发生`），长期挂机时「SW 每 30s 断连重连」不再刷屏；`__rk`/`__roll`/`__n`/`__firstTs` 为内部字段，formatEvent 不输出。

## 编码约定

- 界面文案与注释使用中文；变量名、消息 action 名使用英文。
- 消息协议两套字段并存：`action`（控制指令：`startRefresh` / `stopRefresh` / `getStatus` / `refresh` / `setView` / `aiChatStream` / `aiChatStop` / `aiChatPing`，内部另有 background→offscreen 的 `parseDocument`）与 `type`（数据上报：`DOCUMENT_CAPTURED`，background→popup 的 `DATA_LANDED`/`DATA_LAND_ERROR`，background→AI 窗口的 `AI_CHAT_READY`/`AI_CHAT_CHUNK`/`AI_CHAT_REASONING`/`AI_CHAT_DONE`/`AI_CHAT_ERROR`/`AI_CHAT_ABORTED`/`AI_CHAT_PONG`），新增消息沿用此风格。

## plugins 目录（外部技能/工具引用，可选存在）

- `plugins/` 用来存放外部下载的技能包与工具引用，与扩展运行时无关：不被 `manifest.json` 加载、不参与打包、目录或其中条目随时可能被删除。**当前仅有** `plugins/skills/xiaoshi-quant-expert/`（`SKILL.md` + `references/` 下 11 个文档：`api.md`、`data-contracts.md`、`backtest-protocol.md`、`local-quant-runner.md`、`strategy-contract.md`、`strategy-modes.md`、`event-scoring.md`、`risk-evolution.md`、`medium-low-frequency-data.md`、`history-sync-and-delivery.md`、`miniqmt-data-adapter.md`）。
- **禁止代码依赖**：任何扩展内文件（含 `manifest.json` 的 `web_accessible_resources`）不得 `import`/`require`/`fetch` `plugins/` 下的内容，也不得因该目录缺失而中断工作；它只作为开发期「查资料」的引用。缺文档时按本项目代码与 README 继续实现即可。
- 与代码的对应关系（小石 / Xiaoshi，`https://api.shizixi.com/api/v3`）：`ai/stock/xiaoshi_stock_kline.js`（搜索 / 单只行情 / 日线，含 429 与重试）、`js/xiaoshi_realtime_quote.js` 与 `js/quote_batch.js`（批量行情，单次 100 只上限；`background/background.js` 的 API 直取模式由 `refreshAllByApi` 按全局设置 `dataSource`（`'xiaoshi'` / `'adata'`，缺省 `'adata'`）在 `js/adata_realtime_quote.js` 与小石之间**二选一**，两者互为可替代的行情源而非自动回退链）、`ai/core/ai_tools.js`（`read_stock_kline` / `read_stocks_kline` / `get_stock_quote` 等的 parquet → 小石 → adata 回退链）。
- **何时读**：改动小石接口调用、新增端点、历史数据 / R2 presigned 下载、限流（429 `rate_limit_exceeded` / `bulk_download_required`）、字段语义（`adjust`、`amount_quality`、`history_status`、`available_at` / `retrieved_at` 等）或回测相关功能时，按需读 `SKILL.md` 与 `references/api.md` 取权威口径，不要凭猜测加参数；不需要时不必加载，也不要整包全量读入上下文。
- 该技能包自带的「manifest + sha256 版本巡检」是小石平台的 Agent 侧机制，开发本项目代码时无需照做；要升级文档直接替换文件即可。真实 API Key 不写入本文件、`plugins/` 或任何提交内容（扩展 Key 存 `chrome.storage.sync` 的 `apiKey`，日志与文档一律脱敏）。

## Skills 清单（仅本项目开发期使用）

> **扩展内置的「AI 助手」（`ai/` 窗口）不接入 skills 体系**：它的能力由 `ai/core/ai_tools.js` 中硬编码的 function tools + `load_tool_group` 分组决定，新增或删除 skill 不会给 AI 助手增加任何能力。下列清单只面向在本仓库里干活的编码代理（Claude Code / pi 等）。

**A. `.claude/skills/` — superpowers-zh 工作流技能（20 个，本地安装、已在 `.gitignore` 中，不随仓库分发）**

完整逐条说明见本文件末尾由 superpowers-zh 托管的 `<!-- superpowers-zh:begin/end -->` 区块，勿在此重复抄写、也勿在托管区块内改动（会被重新安装覆盖）。按用途速记：

- 流程类：`brainstorming`、`writing-plans`、`executing-plans`、`subagent-driven-development`、`dispatching-parallel-agents`、`finishing-a-development-branch`、`using-git-worktrees`
- 质量类：`test-driven-development`、`verification-before-completion`、`systematic-debugging`、`requesting-code-review`、`receiving-code-review`
- 中文协作参考：`chinese-code-review`、`chinese-commit-conventions`、`chinese-documentation`、`chinese-git-workflow`
- 元能力：`using-superpowers`、`writing-skills`、`mcp-builder`、`workflow-runner`
- 本项目基调：无测试、无构建，**不自动匹配 skill**；除用户显式点名，简单改动直接读写代码 + 语法/diff 检查（详见「任务处理节奏」）。

**B. `plugins/skills/` — 外部数据源技能（可选存在，仅按需读取）**

- `xiaoshi-quant-expert`：小石大数据 API 使用手册——行情 / 新闻 / 人物 / 宏观 / 机构研报 / 事件时间轴 / 因子库 / 历史 Parquet 批量下载（R2 presigned）/ 防未来函数（PIT）/ 本地回测协议 / 风控与策略进化门禁。**开发期参考文档**，用于校准本项目对 `api.shizixi.com` 的调用与数据口径；不做自动触发，涉及小石接口时再读。

**维护约定**：新增/删除技能时，只在上面加/删一行，写清「路径 + 何时用 + 是否自动触发」，不复制 `SKILL.md` 正文；A 组的详细清单交给托管区块生成，B 组随 `plugins/` 的实际存在情况更新（目录被删时本节改为「暂无」）。

## 任务处理节奏

- 对小范围功能、样式调整和局部 bug 修复，直接读取相关文件并实现，不默认启动 brainstorming、设计文档、worktree、子代理或多轮代码审查流程。
- 简单任务的标准流程：修改代码 → 运行必要的语法/差异检查 → 交给用户在 Chrome 扩展中手动验证。
- 只有在用户明确要求，或任务确实涉及复杂架构、多文件协作、较高回归风险时，才使用 worktree、计划、子代理或完整技能流程。
- 用户已明确表示会在代码完成后立即手动验证时，不要额外搭建视觉原型或重复执行复杂审查；应直接报告修改内容和验证命令。

<!-- superpowers-zh:begin (do not edit between these markers) -->
# Superpowers-ZH 中文增强版

本项目已安装 superpowers-zh 技能框架（20 个 skills）。

## 核心规则

1. **设计先于编码** — 收到功能需求时，先用 brainstorming skill 做需求分析
2. **验证先于完成** — 声称完成前必须运行验证命令

> 本项目例外：无测试、无构建系统，不要求 TDD；skills 仅在显式调用时使用，不做自动匹配检查。

## 可用 Skills

Skills 位于 `.claude/skills/` 目录，每个 skill 有独立的 `SKILL.md` 文件。

- **brainstorming**: 在任何创造性工作之前必须使用此技能——创建功能、构建组件、添加功能或修改行为。在实现之前先探索用户意图、需求和设计。
- **chinese-code-review**: 中文 review 沟通参考——话术模板、分级标注（必须修复/建议修改/仅供参考）、国内团队常见反模式应对。仅在用户显式 /chinese-code-review 时调用，不要根据上下文自动触发。
- **chinese-commit-conventions**: 中文 commit 与 changelog 配置参考——Conventional Commits 中文适配、commitlint/husky/commitizen 中文模板、conventional-changelog 中文配置。仅在用户显式 /chinese-commit-conventions 时调用，不要根据上下文自动触发。
- **chinese-documentation**: 中文文档排版参考——中英文空格、全半角标点、术语保留、链接格式、中文文案排版指北约定。仅在用户显式 /chinese-documentation 时调用，不要根据上下文自动触发。
- **chinese-git-workflow**: 国内 Git 平台配置参考——Gitee、Coding.net、极狐 GitLab、CNB 的 SSH/HTTPS/凭据/CI 接入差异与镜像同步配置。仅在用户显式 /chinese-git-workflow 时调用，不要根据上下文自动触发。
- **dispatching-parallel-agents**: 当面对 2 个以上可以独立进行、无共享状态或顺序依赖的任务时使用
- **executing-plans**: 当你有一份书面实现计划需要在单独的会话中执行，并设有审查检查点时使用
- **finishing-a-development-branch**: 当实现完成、所有测试通过、需要决定如何集成工作时使用——通过提供合并、PR 或清理等结构化选项来引导开发工作的收尾
- **mcp-builder**: MCP 服务器构建方法论 — 系统化构建生产级 MCP 工具，让 AI 助手连接外部能力
- **receiving-code-review**: 收到代码审查反馈后、实施建议之前使用，尤其当反馈不明确或技术上有疑问时——需要技术严谨性和验证，而非敷衍附和或盲目执行
- **requesting-code-review**: 完成任务、实现重要功能或合并前使用，用于验证工作成果是否符合要求
- **subagent-driven-development**: 当在当前会话中执行包含独立任务的实现计划时使用
- **systematic-debugging**: 遇到任何 bug、测试失败或异常行为时使用，在提出修复方案之前执行
- **test-driven-development**: 在实现任何功能或修复 bug 时使用，在编写实现代码之前
- **using-git-worktrees**: 当需要开始与当前工作区隔离的功能开发，或在执行实现计划之前使用——通过原生工具或 git worktree 回退机制确保隔离工作区存在
- **using-superpowers**: 在开始任何对话时使用——确立如何查找和使用技能，要求在任何响应（包括澄清性问题）之前调用 Skill 工具
- **verification-before-completion**: 在宣称工作完成、已修复或测试通过之前使用，在提交或创建 PR 之前——必须运行验证命令并确认输出后才能声称成功；始终用证据支撑断言
- **workflow-runner**: 在 Claude Code / OpenClaw / Cursor 中直接运行 agency-orchestrator YAML 工作流——无需 API key，使用当前会话的 LLM 作为执行引擎。当用户提供 .yaml 工作流文件或要求多角色协作完成任务时触发。
- **writing-plans**: 当你有规格说明或需求用于多步骤任务时使用，在动手写代码之前
- **writing-skills**: 当创建新技能、编辑现有技能或在部署前验证技能是否有效时使用

## 如何使用

当任务匹配某个 skill 时，使用 `Skill` 工具加载对应 skill 并严格遵循其流程。绝不要用 Read 工具读取 SKILL.md 文件。
<!-- superpowers-zh:end -->