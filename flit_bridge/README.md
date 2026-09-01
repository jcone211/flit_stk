# flit_bridge

本地 HTTP 桥接服务，通过 JSON API 提供工作区上下文、结构化进程和本地数据库查询，减少扩展读取原始文件带来的 Token 消耗。

## 安装

在 PowerShell 7 中运行：

```powershell
.\install.ps1
Start-ScheduledTask -TaskPath '\flit_bridge\' -TaskName 'flit_bridge_watcher'
```

调试时可直接运行：

```powershell
.\start-server.ps1
```

服务默认监听 `http://127.0.0.1:17321`。

在扩展中启用本地桥接并设置 Agent 工作目录。服务会自动发现：

```text
<workspace>/flit/config.json
<workspace>/flit/memory.md
<workspace>/memory/FACT.md
<workspace>/AGENTS.md
<workspace>/README.md
```

其中 `flit/config.json` 保存结构化配置，`flit/memory.md` 保存人类可读的工作区记忆。Agent 可以通过扩展工具自动创建和修改 `flit/` 下的文件。服务端会缓存解析结果，并按文件修改时间自动刷新。

## HTTP API

- `GET /health`：检查服务状态。
- `POST /v1/workspace/context`：返回工作区配置和记忆摘要，不返回完整文件内容。
- `POST /v1/workspace/memory`：将确认后的适配经验追加到工作区 `flit/memory.md`。
- `POST /v1/database/query`：执行只读数据库查询并返回 JSON 行。
- `POST /v1/database/schema`：返回数据库真实表、字段、类型和空值信息。
- 数据库连接配置由扩展端 `save_workspace_database_config` 工具写入工作区 `flit/config.json`，并自动维护 `flit/.gitignore` 中的 `config.json` 忽略项。
- `POST /v1/process`：使用结构化程序、参数数组和 stdin 执行受限本地进程。
- `POST /v1/process/{request_id}/cancel`：取消运行中的进程。

示例：

```json
{
  "workspace_root": "D:\\workspace\\stock-assistant",
  "source": "local-postgres",
  "sql": "SELECT code, date, close FROM a_share_daily LIMIT 7",
  "format": "json"
}
```

默认只允许 `SELECT`、`WITH` 和 `EXPLAIN` 查询。SQL 通过 stdin 传给 `psql`，不会经过 PowerShell 命令字符串拼接。

## 工作区记忆与流程格式

`flit/memory.md` 顶部必须先有数据库连接状态，使用以下结构：

```markdown
# 工作区记忆

## 数据库连接状态
- status: verified
- source: local-postgres

## 可复用流程与查询约定
- workflow: flit/workflow/query-stock-daily.md
- 用途：查询股票近 N 个交易日行情
```

`status` 只能是 `verified`、`unverified` 或 `unknown`。不得在此文件写入密码、Token 或完整连接串。

可复用 workflow 是通用的工作流定义，不限于数据库或股票查询。每个 workflow 至少应说明：目标、触发条件、输入参数、前置条件、执行步骤、工具调用顺序、输出结果、错误处理、验证标准，以及何时需要重新检查前置条件。标题和文件名应面向可复用任务，不能绑定某只股票或某个日期。

如果 workflow 用于从数据库查询股票，才额外要求包含：适用条件、数据源名称、相关表和关键字段、股票名称/代码/交易日数量等可替换参数、可直接执行的基础 SQL，以及何时必须重新调用 `discover_database_schema`。这些要求不适用于其他类型的 workflow。

`/v1/process` 的 `cwd` 必须是当前工作目录内的相对路径，因此可以执行工作目录其他目录中的已有脚本，也可以执行 Agent 在 `flit/` 中创建的脚本。允许的程序包括 `python`、`python3`、`node`、`git`、`docker` 和 `psql`。

## 配置示例

工作区下的 `flit/config.json`：

```json
{
  "version": 1,
  "data_sources": [
    {
      "name": "local-postgres",
      "type": "postgresql",
      "access": "docker",
      "container": "my-postgres",
      "database": "stock",
      "user": "postgres"
    }
  ],
  "market": {
    "quote_table": "a_share_daily",
    "stock_table": "stock_basic_cache",
    "adjustment": "qfq",
    "trading_day_only": true
  }
}
```

如果 Agent 成功验证了数据库连接且工作区尚无配置，应调用扩展端 `save_workspace_database_config` 工具将完整连接信息保存到工作区 `flit/config.json`，并自动创建 `flit/.gitignore`，至少包含 `config.json`，避免凭据被 Git 跟踪。密码、Token 和完整连接串不得写入 `flit/memory.md`、`flit/workflow/`、普通日志或模型回复。

旧的 `.claude-command.md` 文件协议已经移除，不再参与执行。`watch-command.ps1` 和 `actions.ps1` 也不再使用。
