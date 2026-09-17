# Cron 交易时间限制实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 仅限制全局配置中的 Cron 定时全量刷新，使其只在 09:30-11:30、13:00-15:00 执行，不影响手动刷新。

**架构：** Cron 表达式仍负责计算下一次触发分钟；background 在 Cron alarm 到点后增加交易时间门禁。下一次 Cron 始终先重排，因此非交易时间跳过本次刷新不会影响后续调度。手动刷新继续调用现有 `refreshAllStocks()`，不经过该门禁。

**技术栈：** Chrome MV3 Service Worker、原生 ES modules、Chrome alarms API、Node.js 语法检查。

---

### 任务 1：增加交易时间判断

**文件：**
- 修改：`thswc/shared/cron.js`

- [ ] 增加导出函数 `isTradingTime(date = new Date())`，按本地时间判断 `09:30 <= time <= 11:30` 或 `13:00 <= time <= 15:00`。
- [ ] 函数不判断星期和法定节假日，保持用户确认的“仅限制时段”规则。

### 任务 2：限制 Cron 全量刷新

**文件：**
- 修改：`thswc/background/background.js`

- [ ] 从 `../shared/cron.js` 引入 `isTradingTime`。
- [ ] 在 `handleCronAlarm()` 中保留 `scheduleOneCron(job)`，然后仅当 `isTradingTime()` 返回 `true` 时调用 `refreshAllStocks()`。
- [ ] 手动 `refreshAll` 消息路径不增加交易时间判断。

### 任务 3：验证

**文件：**
- 验证：`thswc/shared/cron.js`、`thswc/background/background.js`

- [ ] 运行 `node --check "thswc/shared/cron.js"`。
- [ ] 运行 `node --check "thswc/background/background.js"`。
- [ ] 运行 `git diff --check`。
- [ ] 检查差异确认只有 Cron 交易时间逻辑被修改，且手动刷新入口未改变。
