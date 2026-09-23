# flit_stk 文档导航（docs/）

> 本文是 `docs/` 目录的索引与维护约定，先读这里再决定去哪找东西。

## 文档分层

`docs/` 按「生命周期」分层，只保留有持续阅读价值的文档；开发记录类内容用完之后即归档。

| 目录 | 内容 | 状态 | 什么时候读 |
| --- | --- | --- | --- |
| [incidents/](./incidents/) | 事故复盘（guard 误判 / 漏拦截等，含根因与修复） | 有效（问题已修复，教训保留） | 排查同类问题 / 改动 guard 相关逻辑前 |
| [design/](./design/) | 技术解析（ReAct 循环 / 上下文压缩 / 沙箱安全模型） | 有效（注意：文内行号会随代码漂移，以代码为准） | 新人了解架构 / 深入改某模块前 |
| [archive/](./archive/) | 已完成/已失效的开发记录、旧版文档、DEBUG 日志快照 | 已归档（只读，不再更新） | 查历史结论 / 复盘旧事故时 |

## 活口径真源（权威，改行为前必看）

以下两份在仓库根目录，是「当前真相」的唯一出处，`docs/` 历史记录不与其重复维护：

| 文件 | 内容 |
| --- | --- |
| [`CLAUDE.md`](../CLAUDE.md) | 开发约定、架构口径、关键机制（上下文 / guard / 取数链路） |
| [`API_CHANNELS.md`](../API_CHANNELS.md) | 行情/日线渠道清单、时段口径、改链路后的验证方法 |

## 可执行脚本（已迁出 docs/）

验证脚本与工具统一放在 [`scripts/verify/`](../scripts/verify/)（原散落在 docs/ 下）：

- `verify-free-first.mjs` —— AI 取数链路全量回归（`--offline-cases` / `--only=xxx` / `--bridge=real`）
- `verify-stock-lookup.mjs` —— 股票名称/代码 → 标的解析口径（直接读真实的 `assets/stock_basic_cache.json`，38 项断言，0 外呼）
- `verify-ai-auto-add.mjs` —— AI「按名称添加股票」自动模式真实路径（A1~A11，55 项断言，0 外呼；把扩展内资源映射成仓库文件，补 `verify-free-first` 桩打不开资源的那一段；A11 断言条目地址按目标组合自己的选择器生成）
- `verify-memory.mjs` / `verify-quickimport-race.mjs` / `verify-quickopen-landing.mjs` —— 功能专项验证
- `mock-bridge.mjs` —— 假 Agent 桥接（verify-free-first 依赖，不打真实接口）
- `read-debug.mjs` —— DEBUG 日志读取器（默认读 `docs/archive/debug.txt`）

「输入名称时自动匹配股票代码」（自动模式）这条链路按能力分三段验证，改动任一段都要跑对应脚本：

| 环节 | 脚本 | 覆盖 |
| --- | --- | --- |
| 解析口径 | `verify-stock-lookup.mjs` | 精确 / 唯一模糊 / 多候选 / 查不到 / ETF(基金) 名称拒收 / 基金代码推前缀 / 代码表读取失败降级 |
| 自动路径 | `verify-ai-auto-add.mjs` | 名称 → 6 位代码 → 批量直取行情并落地、`import_price` 不被行情覆盖、取数失败才回退打开个股页、返回带 `items` 落地明细（A9）、已在组合回 `ok:true`+`alreadyPresent`（A10） |
| 降级路径 | `verify-free-first.mjs --only=H` | 扩展内资源读不到时 H1~H4 回退原有「打开页面抓取」方式，条目仍能落地；H7 断言 `find_stock` 一次跨全部组合查（含名称归一、代码命中、垃圾池标记、查不到提示），H8 断言刷新地址「选择器说了算」（wc1 非 ETF → 问财搜索页、ETF 恒雪球、xq1 拼雪球个股页、api/港股/裸网址回退存储 URL） |

## 维护约定（新增文档时遵守）

1. **不新增第二份「活口径」**：「当前行为」一律写进 `CLAUDE.md` / `API_CHANNELS.md`；docs 文档只写分析、复盘、历史。
2. **归档文档盖状态章**：任务收尾后把临时记录移到 [`archive/`](./archive/)，顶部标注 `ARCHIVED` 与「当时结论见哪份活文档」。
3. **验证脚本进 `scripts/verify/`**，不要在 docs/ 下新增可执行代码。
4. **DEBUG 日志快照**归档到 [`archive/debug.txt`](./archive/debug.txt)，复盘用它 + `scripts/verify/read-debug.mjs`，不要把长日志直接贴进新文档。
