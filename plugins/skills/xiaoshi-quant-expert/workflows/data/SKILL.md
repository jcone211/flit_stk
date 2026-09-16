---
name: data
description: 发现、查询和交付小石金融数据，核对字段、范围、新鲜度、版本、时间与缺失语义；适用于找数据和准备可复核数据文件。
---

# 数据发现与交付

## 工作流

1. 用 `get_platform_status` 检查平台和数据新鲜度。
2. 用 `get_data_catalog` 读取最接近需求的目录：history、events、quant-data 或 pit。
3. 明确市场、证券类型、代码、时间窗口、频率、复权、币种、单位与 PIT 截止时间。
4. 单标的行情用 `get_live_quote`；一个明确数据集用 `query_dataset`；事件用 `get_event_timeline`。
5. 大文件和历史数据用 `plan_history_download`，由代理调用 `xiaoshi-data download`，完成后运行 `verify`。用户要求下载、验证或回测且本地能力与相应授权可用时，完成执行和验证，不以给出命令代替执行；仅在用户请求操作说明或能力缺失时交付步骤。此规则不授权安装、升级、改变身份、付费或扩大下载范围。

## 边界

目录显示积累中、未覆盖或上游缺失时，原样报告；不得补造、前值填充或把空值解释为 0。遇到 429 不循环重试：`Retry-After` 是禁止重试的最短窗口，不是自动重试指令；遇到 `bulk_download_required` 停止在线枚举并在已授权范围内转本地下载。通用下载重试不适用于 429、`bulk_download_required`、权限拒绝或禁用状态；仅在合同明确支持的 URL 过期情形续签，不借续签绕过保护。

交付时附目录版本、文件清单、哈希、覆盖起止、来源时间和任何缺口。

## 全市场范围与客户端校验

当前公开能力以 `/api/v3/capabilities` 为准。旧 Skill 中的 旧版 market-snapshot 和 market/stocks 路径 不属于当前公开接口；不得继续调用或将其当作 429 的替代路径。当前未提供公开的实时全市场批量快照。历史证券范围可从已授权下载的完整日线文件按市场、日期和代码提取；这只代表该文件的历史覆盖，不保证实时上市全集。市值和财务字段须逐项检查当前目录、来源与日期，不从日线价格推算或伪称现有接口支持。

日线优先使用 `trade_date`；兼容字段 `trade_time` 全为空不代表数据缺失。仅明确标记 `no_turnover_observed`、四个 OHLC 原值全空且成交量额为 0 的规范行可保留空价格；不得填充价格或放行其他异常。下载后的 `verify` 和 `query --since` 应使用最新版客户端。


### Explicit latest-available history

Default history downloads remain the complete snapshot. If the user explicitly accepts
newer data with gaps, inspect `xiaoshi-data coverage --quality available`, then download
with `--quality available` into a separate `--data-dir`. The client prints per-date
accepted/expected counts and missing codes, and rejects mixing with a complete directory.
Inspect `availability.watermarks` for each dataset/market/adjustment: available dates and
complete dates differ; newer raw daily data does not advance qfq/hfq. Never fill gaps.
Each download pins its manifest revision; use `--revision <manifest_version>` to reproduce
an earlier available revision. CLI/HTTP support this choice; MCP saved plans stay complete.
