# plan —— 模型上下文容量标识 / token 环形指示器 / 动态上下文预算

## 目标

1. AI 设置「模型」输入框右侧新增「□ 1M」复选框：默认勾选（模型按 1M token 上下文计），不勾选则按 256k token 计。
2. 发送按钮左侧新增细空心圆环指示器：显示当前上下文 token 占模型总 token 的比例；
   色调阈值 <40% 绿 / 40–60% 橙 / ≥60% 红；鼠标悬浮显示
   `45,000 / 1,000,000 (4%) qwen3.8-flash [压缩]`（模型名 + 压缩标记）。
3. 实现具体的上下文 token 计数逻辑（中/西文分权估算）。
4. `MAX_CONTEXT_CHARS`（固定 24000 字符）改为动态读取当时所用模型的最大支持长度
   （勾选 1M → 1,000,000 token；否则 256,000 token），驱逐阈值同时由「字符」口径改为「token」口径。
5. （跟进）工具调用轮数上限默认改为 50 且无最大限制；修复环形指示器悬浮提示过长导致右侧超出插件边框。
6. （跟进）真正的「[压缩] /compact」能力：用户可手动把整段对话交给模型压成摘要并替换历史、腾出上下文（此前 tooltip 的 `[压缩]` 只是「发生过驱逐」的状态标记，不是该能力）。
7. （跟进）上下文统计交互升级：不用悬浮 tooltip，改为**悬浮 div 面板**——内容区上方细长进度条（颜色与外部圆环一致）+「上下文用量」中文标题 + 明细文本右侧浮动「压缩」按钮；鼠标移出悬浮面板即消失。
8. （跟进）圆环与发送按钮间距 +6px；圆环半径放大 1.2 倍；AI 助手初始宽度调整到与插件主页一致（popup 580px，原 480px）。

## 拆分任务

| # | 任务 | 状态 |
|---|------|------|
| T1 | 设置项「□ 1M」：ai.html 模型行加复选框 + ai_state.js DOM 引用 + settings 持久化（provider.context1M，默认 true）+ demo seed 同步 | ✅ 已完成 |
| T2 | token 估算与动态预算常量：ai_state.js 新增 `estimateTokens` / `maxContextTokens` / `contextBudgetChars`，取代 `MAX_CONTEXT_CHARS` | ✅ 已完成 |
| T3 | 发送按钮旁环形指示器：ai.html 结构 + ai.css 样式（颜色分级、SVG 进度弧、CSS tooltip）+ ai.js `updateContextMeter` | ✅ 已完成 |
| T4 | evictToolResults / trimHiddenEntries 采用动态预算与 token 口径；ai.js import 与记录日志同步；CLAUDE.md 行 41 与相关注释更新 | ✅ 已完成 |
| T5 | 语法自检（node vm.SourceTextModule 解析）与逻辑核对 | ✅ 已完成 |
| T6 | 工具调用轮数上限：默认 50、去掉最大限制（ai_state 默认值 / settings clamp / HTML min-max / popup 备份导入 clamp / demo seed） | ✅ 已完成 |
| T7 | 修复环形指示器悬浮提示右侧超出插件边框：tooltip 改为右对齐 + max-width 自动换行 | ✅ 已完成 |
| T8 | 手动上下文压缩（/compact 能力）：发送框旁「压缩」按钮 + `/compact` `/压缩` 斜杠指令；`sendRound` 增加 `suppressRender`；`handleCompact` 用非流式模型调用生成摘要并替换历史（`kind:'compact_note'`，界面只显示一行提示）；渲染、话题判定、环形指示器与记录同步 | ✅ 已完成 |
| T9 | 上下文统计悬浮面板：移除 tooltip，改为悬停圆环显示的悬浮 div（「上下文用量」标题 + 细长进度条颜色与圆环一致 + 明细文本 + 右侧浮动「压缩」按钮）；移出面板即隐藏 | ✅ 已完成 |
| T10 | 圆环与发送按钮间距 +6px（margin-right:6px）；圆环尺寸 16px→19.2px（1.2 倍，SVG 等比缩放半径 6.5→7.8）；AI 窗口初始宽度 480→580 与插件主页 popup 一致（background.js createAiChatWindow + demo/run.mjs） | ✅ 已完成 |
| T11 | 压缩后摘要流式输出到页面（仅前 1,000 token，超出提示不展示）且 `renderHistory` 恢复时同理可见；新增 `cutToTokens`（二分法截断）/ `streamCompactOutput`（逐字流式）/ `COMPACT_PREVIEW_TOKENS=1000` | ✅ 已完成 |
| T12 | 修复压缩器返回"好的/收到"等无意义内容：`handleCompact` 改为把所有对话文本嵌入单条 system prompt（不以 user/assistant 角色发送，杜绝角色误解）；移除不再需要的 `buildCompactSource` 与 `COMPACT_SOURCE_MAX_CHARS` | ✅ 已完成 |

## 改动清单

- `ai/ai.html`：模型行「□ 1M」复选框；composer-actions 发送按钮左侧 `.ctx-meter` 环形指示器（SVG 双圆环）。
- `ai/ai.css`：`.ai-model-row` / `.ai-ctx-flag`（设置面板）；`.ctx-meter` 及 `lv-green/lv-orange/lv-red` 颜色分级、进度弧、`::after` 悬浮提示。
- `ai/core/ai_state.js`：`estimateTokens`（东亚 0.7 token/字、其余 0.25 token/字）、`maxContextTokens(provider)`（1M / 256k）、`contextBudgetChars(provider)`；移除 `MAX_CONTEXT_CHARS`；新增 `ctxMeter`、`aiModelContext1MInput` DOM 引用与 `state.contextEvicted` 标记。
- `ai/core/ai_settings.js`：provider 增加 `context1M` 字段（默认 true、旧数据兼容）；读写复选框并持久化。
- `ai/ai.js`：`updateContextMeter`（每轮构建 requestMessages 后刷新）；`evictToolResults(apiMessages, provider)` 改 token 口径动态预算并置 `state.contextEvicted`；init/供应商切换/切换会话/清空会话时刷新指示器并重置压缩标记。
- `demo/lib/seed.mjs`：提供 `context1M` 默认值（demo 目录未入库，本地一致性）。
- `CLAUDE.md`：行 41 上下文预算口径描述与实现同步。
- `docs/plan-optimization.md` 保留历史 T1-2 记录（24k 字符时代），未改动。

## 验证

- `node --experimental-vm-modules` SourceTextModule 解析 `ai.js` / `ai_state.js` / `ai_settings.js` 全部通过。
- `estimateTokens` 单测：纯中文 1000 字→700、ASCII 2000 字→500、混合→950；千分位与「used / limit (pct%) model [压缩]」格式与需求示例一致。
- 全局 `MAX_CONTEXT_CHARS` 仅剩历史文档 `docs/plan-optimization.md:143` 引用（不加区分上下文预算符号）。
- T6 后：4 个文件语法全过；`1-50` / `max="50"` / `n > 50` / `Math.min(50,…)` 等旧上限已全部清除（仅剩新文案文字）。
- T7 后：`.ctx-meter::after` 右对齐圆环右缘 + `max-width:260px` + 自动换行，长模型名不再向窗口右侧溢出。
- T8 后：3 个文件 syntax 全过；`compact` 相关引用完整闭环：HTML 按钮 → `ai_state` DOM/常量 → `ai.js` import → `sendRound(suppressRender)` → `handleCompact/applyCompact/buildCompactSource` → `renderHistory` 摘要行 → `quoteTopicNearby` 跳过 → `bindEvents` 绑定 → CLAUDE.md 备注。
- T9 后：删除 `.ctx-meter::after` tooltip；`ctxPanel` 作为 `ctxMeter` 子元素，`.ctx-panel-fill` 用 `background:currentColor` 继承 `lv-*` 色（与圆环一致）；`showCtxPanel`/`hideCtxPanelSoon`（150ms 间隙宽限）绑定于圆环与面板的 mouseenter/mouseleave；`compactBtn` 保持 id 不变移到面板内，`/compact` 指令不受影响。
- T10 后：`.ctx-meter` 19.2px + `margin-right:6px`（与发送按钮间距 8→14px）；SVG viewBox 保持 0 0 16 16、r=6.5（strokeDasharray 弧长计算不变），容器 1.2 倍等比放大即半径 1.2 倍；`background.js` node --check 通过，`width=580` 与 popup 一致且 `left` 按 580 重算（`baseLeft - 580 - 8`）。
- 待人工验证：Chrome 扩展内手动查看（AI 窗口需关闭重开）——`.ctx-meter` 初始 0%，发送后按估算 token 刷新；设置面板切换「□ 1M」后 ring 上限随之变 1M/256k；设置里轮数上限默认显示 50 且可填任意大数；点「压缩」或输入 `/compact` 后，历史被替换为一行「已压缩的上下文摘要」提示，环形 tooltip 显示 `[压缩]`。

## 关键设计决策

- **计数口径**：估算器 `estimateTokens(text)`：东亚字符每字符约 0.7 token（≈1.43 字符/token），
  其余按 0.25 token/字符（4 字符/token）；取整相加。tools 定义按 `JSON.stringify(tools).length` 计入。
- **预算口径**：`maxContextTokens(provider)` = `provider.context1M ? 1_000_000 : 256_000`。
  驱逐判定与环形占比共用该值，保证「显示占比」与「驱逐触发」一致。
- **驱逐逻辑**：仍只驱逐「最近一轮以外」的旧 tool 结果；比较基准从总字符数改为估算 token 总量。
- **压缩标记**：`state.contextEvicted` 在会话内发生过驱逐后置 true，环形 tooltip 追加 `[压缩]`。
- **兼容旧数据**：`normalizeProvider` 将缺失的 `context1M` 视作 `true`（默认 1M）。
- **手动压缩（/compact）**：触发器=发送框旁「压缩」按钮 / 输入 `/compact` / `/压缩`；用一次非流式模型调用（`sendRound` + `suppressRender`）生成摘要；结果以 `kind:'compact_note'`（role=user）单条替换整段历史；界面仅显示一行摘要提示，后续回灌模型时只带正文；压缩后 `state.contextEvicted=true`（tooltip 显示 `[压缩]`），环形指示器按新摘要占比刷新。