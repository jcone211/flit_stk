---
name: quant-expert
description: 组织小石上的完整量化研究，把数据、事件、策略、因子、回测与风险证据合并为可审计结论；适用于跨域研究与总控，不替代单一快速查询。
---

# 量化研究总控

先读取 `get_platform_contract`，再按任务加载 `data`、`market-research`、`event-macro` 或 `quant-lab`。不要猜测数据集、字段、市场或证券类型。

## 工作流

1. 写清研究对象、市场、时间、频率、复权、时区、基准与决策时点。
2. 用 `get_data_catalog` 核对 history、events、quant-data、pit 的结构、覆盖和新鲜度。
3. 将原始数据、事件证据、策略规则、因子值、交易假设与结论分层保存。
4. 在线工具只做有界查询；大范围历史交给 `plan_history_download` 或 `prepare_local_research`，再由 `xiaoshi-data` 在本机下载和验签。
5. 因子先形成明确公式、输入字段、滞后、缺失值和方向，再运行 `validate-factor`；通过后才进入 `backtest`。
6. 使用时间滚动或样本外验证，报告交易成本、滑点、换手、容量、回撤和失败样本。

## 输出要求

结论必须区分事实数据、研究假设和推断；附数据版本、覆盖边界、`available_at`、单位、币种和来源时间。空值不等于 0，结果不是投资建议。
