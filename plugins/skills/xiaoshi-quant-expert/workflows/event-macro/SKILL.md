---
name: event-macro
description: 分析小石事件时间线、人物观点、政策、宏观与未来概率演化；适用于事件驱动研究、时间线复盘和持续监测。
---

# 事件、人物与宏观

## 工作流

1. 用 events 目录确认事件类型和字段，再用 `get_event_timeline` 做有界查询。
2. 通过 `person`、`stock`、`industry`、`source`、`topic`、`min_score` 和时间窗口缩小范围；筛选可组合。
3. 将 `event_time` 作为事件或来源观察时间，将 `available_at` 作为平台首次可用时间；回测与复盘只能使用决策时点前已可用记录。
4. 未来概率只走 `get_event_timeline`：以 `event_types=future_dynamic` 且不传 `topic` 读取窗口内各开放项目的最新观察；选定项目后传其 factor ID、数字主题 ID 或标题关键词作为 `topic` 拉取概率时间线。不要调用已退役的专用概率接口。
5. 未来概率结果同时保留 `future_probability.observed_at`、`available_at` 与 `observation_mode`。来源历史回填的观察时间可早于平台入库，但只能从 `available_at` 起用于决策；`source_history_backfill` 与 `continuous_platform_observation` 不得混写。
6. `change_24h` 是概率差，0.05 表示 5 个百分点。它优先采用来源提供的 24 小时变化；来源缺失时，使用距 24 小时前最近且位于 18 至 30 小时窗口内的观察计算。分别呈现当前概率、变化、成交量、流动性、截止时间与解决状态，不把概率当作确定结果。
7. 在线事件窗口外用 `plan_history_download` 下载 event-timeline，并在本地验签；历史归档仍按 `available_at` 做 PIT 连接。

## 输出要求

按时间排序并保留修订信息；区分原始事实、人物观点、模型概率和 Agent 推断。人物名单、地区与类别以当前 events schema 为准，持续维护但不代表全网全部人物。
