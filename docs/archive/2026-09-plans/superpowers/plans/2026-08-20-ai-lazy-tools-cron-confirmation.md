# AI 工具冷加载与 Cron 确认实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将 Cron 交易时间起点改为 09:15，增加 AI 工具组冷加载，并实现 Cron 修改的预览确认流程。

**架构：** 保留现有页面本地 function-calling 循环。将单一 `TOOL_DEFS` 拆为工具组定义，初始请求只携带极简 `load_tool_group` 工具；工具组加载后在当前循环中携带对应定义。Cron 预览状态保存在 AI 页面内存中，应用工具要求有效预览和下一轮明确确认，并通过现有 `syncCronJobs` 消息重排后台 alarm。

**技术栈：** Chrome MV3、原生 ES modules、Chrome Storage、Node.js。

---

### 任务 1：更新交易时间与 Cron 计算辅助函数

**文件：**
- 修改：`thswc/shared/cron.js`
- 修改：`thswc/background/background.js`

- [ ] 将 `isTradingTime()` 上午起点改为 `09:15`，保留 `11:30`、`13:00`、`15:00` 边界。
- [ ] 增加按 Cron 计算未来实际刷新时间的函数：从 `nextCronTime()` 生成候选时间并过滤 `isTradingTime()`，返回指定数量结果。
- [ ] 确认后台 Cron alarm 使用更新后的 `isTradingTime()`，手动 `refreshAll` 分支不增加判断。
- [ ] 运行边界命令覆盖 `09:14`、`09:15`、`11:30`、`11:31`、`13:00`、`15:00`、`15:01`。

### 任务 2：拆分 AI 工具定义并实现工具组冷加载

**文件：**
- 修改：`thswc/ai/ai.js`

- [ ] 将现有工具定义按 `portfolio`、`market`、`events`、`settings`、`workspace`、`memory` 分组，保持现有 executor 名称不变。
- [ ] 新增精简 `load_tool_group` 定义和组说明；初始请求只发送该工具，不发送全部工具 schema。
- [ ] 让 `runAgentLoop()` 维护当前请求的已加载组，并在每轮根据已加载组拼接详细工具定义。
- [ ] 让 `load_tool_group` 校验组名并返回加载结果；未知组不改变状态。
- [ ] 将事件、行情、工作区等长规则从全局系统提示词移到对应工具组加载后的短规则中。
- [ ] 让失败重试恢复请求快照中的已加载组，其他新请求从空组开始。

### 任务 3：实现 Cron 预览与确认执行

**文件：**
- 修改：`thswc/ai/ai.js`
- 修改：`thswc/shared/cron.js`

- [ ] 新增 `update_cron` 工具，支持新增、修改、删除、启停，并按任务序号、ID或表达式定位。
- [ ] 直接校验 Cron 和最多 3 个任务，写入 `chrome.storage.sync` 后发送 `{ action: 'syncCronJobs' }`。
- [ ] 返回最终配置、表达式含义和未来 5 次实际刷新时间，不等待用户二次确认。

### 任务 4：精简配置区说明并验证

**文件：**
- 修改：`thswc/popup.html`

- [ ] 在 Cron 说明中补充修改需要 AI 预览并经用户确认的行为，保持文案简洁。
- [ ] 运行 `node --check "thswc/shared/cron.js"`、`node --check "thswc/background/background.js"`、`node --check "thswc/ai/ai.js"`。
- [ ] 运行 AI 工具组、Cron 边界和预览纯函数验证命令。
- [ ] 运行 `git diff --check`，确认手动刷新入口未改变且敏感配置不在工具读取白名单中。
