# AI 工具冷加载与 Cron 确认修改规格

## 目标

优化 `thswc` AI 对话窗口的工具上下文和全局 Cron 修改流程：

- Cron 定时全量刷新交易时段从 `09:30-11:30` 调整为 `09:15-11:30`，下午保持 `13:00-15:00`。
- 仅 Cron 定时全量刷新受交易时间限制；手动刷新、一键刷新和单股刷新不受影响。
- AI 不再每轮携带全部工具定义，改为极简工具目录和工具组按需冷加载。
- AI 修改 Cron 直接执行，返回表达式、含义和实际执行时间。
- API Key 等敏感配置不读取、不修改。

## Cron 交易时间

`isTradingTime(date = new Date())` 使用本地时间判断：

- `09:15 <= time <= 11:30`
- `13:00 <= time <= 15:00`

不判断星期、法定节假日，保持当前已确认规则。Cron alarm 到点后先重排下一次 alarm，再检查交易时间；非交易时间只跳过本次刷新。手动 `refreshAll` 消息路径继续直接调用全量刷新函数。

## 工具冷加载

每次用户请求开始时，模型只收到精简工具目录和核心规则。工具按以下组划分：

| 工具组 | 工具 |
| --- | --- |
| `portfolio` | `get_stock_list`、`get_portfolios`、`switch_portfolio`、`add_stock_to_portfolio`、`move_stock_to_combo`、`get_current_view` |
| `market` | `get_stock_quote`、`refresh_all` |
| `events` | `get_key_points`、`create_key_point`、`update_key_point`、`delete_key_point`、`get_events`、`create_event`、`update_event`、`delete_event` |
| `settings` | `get_settings`、`update_cron` |
| `workspace` | `list_workspaces`、`list_dir`、`read_file`、`write_file`、`append_file`、`read_parquet`、`read_stock_kline` |
| `memory` | `save_memory` |

模型调用 `load_tool_group({ group })` 后，下一轮请求才携带该组详细定义。已加载组只在当前请求循环内有效，不写入聊天历史；新请求重新从目录开始。重试应恢复失败请求循环中已经加载的工具组。

工具描述使用短句。事件归档规则仅随 `events` 组加载，工作区权限规则仅随 `workspace` 组加载，行情/K 线规则仅随 `market` 组加载，避免每轮系统提示词重复注入。

## Cron 修改

### 预览

`update_cron` 直接校验并写入配置。支持新增、修改、删除、启用、停用 Cron 任务，单次最多影响 3 个任务。修改目标可按任务序号、任务 ID 或当前表达式定位。

预览至少返回：

- 操作类型
- 原配置和目标配置
- Cron 表达式
- 中文含义
- 接下来 5 次实际刷新时间
- `applied: true`

实际刷新时间先按 Cron 计算候选时间，再过滤 `isTradingTime()` 为 `false` 的时间；不展示非交易时间的 Cron 命中点。

修改前再次校验表达式和任务数量，成功后：

1. 写入 `chrome.storage.sync.cronJobs`。
2. 发送 `{ action: 'syncCronJobs' }`。
3. 返回新配置及下一次实际刷新时间。

修改成功后返回新配置和后续实际刷新时间，Cron 后台 alarm 立即重排。

## 安全与兼容性

- AI 工具只能直接修改 Cron，不开放其他全局设置写入。
- `apiKey` 不出现在工具读取白名单、工具结果或系统提示词中。
- 现有 `get_settings` 保留，继续只读取非敏感配置。
- 现有手动刷新和普通监控调度不改变。
- 工具结果继续受现有长度限制。

## 验证要求

- 校验 `09:14`、`09:15`、`11:30`、`11:31`、`12:59`、`13:00`、`15:00`、`15:01` 边界。
- 验证 Cron 预览只返回交易时间内的未来执行时间。
- 验证无确认不能写入，明确确认后能写入并触发 `syncCronJobs`。
- 验证新请求只携带工具目录，加载组后才携带组工具定义。
- 运行相关 JavaScript `node --check` 和 `git diff --check`。
