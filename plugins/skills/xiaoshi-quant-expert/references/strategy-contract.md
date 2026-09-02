# 小石本地策略生命周期契约 / Strategy Lifecycle Contract

## 1. 策略契约限制与安全边界
小石平台的本地量化接口采用分层架构以实现安全风控门禁：
- **只读上下文 (Read-Only Context)**: 策略只能通过 `StrategyContext` 读取当前资产和行情，**严禁直接修改现金、持仓或成交列表**。
- **纯信号输出 (Signals Only)**: 策略的生命周期回调中只能返回包含目标仓位或交易量的 `Signal` 对象，实际的下单和资金清算完全由底层的执行器与风控层异步处理。
- **防止未来函数 (Point-in-Time Alignment)**: 引擎会自动进行 PIT 对齐。在 `t` 时刻决策时，策略在 `context.bars` 中只能看到 `available_at <= t` 的历史行情（即当前 Bar 关闭且已对齐披露时间的历史数据），避免信息泄露。
- **成交时点**: `before_market` 只能使用盘前已知数据，可按当日开盘模拟成交；`on_bar` 和 `after_market` 使用收盘后才完整可知的数据，因此信号不得早于下一根合法可交易 K 线成交。回测区间最后一天产生但尚无下一根 K 线的信号保持待执行状态。
- **目标权重语义**: `target_weight` 是目标持仓，而不是每次追加买入比例。执行器只交易“目标持仓减当前持仓”的差额，并在风控裁剪后重新计算差额。

## 2. 接口生命周期方法
用户编写的自定义策略类必须继承自 `StrategyBase` 并实现以下接口：

```python
from tools.xiaoshi_quant_runner.strategy_api import StrategyBase, StrategyContext
from tools.xiaoshi_quant_runner.schemas import Bar, Signal, Action
from typing import Dict, List

class MyStrategy(StrategyBase):
    @property
    def name(self) -> str:
        return "双均线策略演示"

    def initialize(self, ctx: StrategyContext) -> None:
        """回测开始前调用，常用于设定初始状态或指示器参数"""
        ctx.state["ma_fast"] = 5
        ctx.state["ma_slow"] = 20

    def before_market(self, ctx: StrategyContext) -> List[Signal]:
        """每日开盘前触发，支持基于盘前事件返回交易信号"""
        return []

    def on_bar(self, ctx: StrategyContext, bars: Dict[str, Bar]) -> List[Signal]:
        """每个 K 线 Bar 周期触发。bars 参数包含当前最新的 Bar 快照。
        必须在这里评估策略条件并返回交易 Signal 列表。
        """
        signals = []
        for code, bar in bars.items():
            # 计算 ma 指标...
            # 产生买卖信号：
            sig = Signal(
                strategy_id=self.name,
                code=code,
                signal_time=ctx.current_time,
                action=Action.BUY,
                target_weight=0.1,  # 目标仓位 10%
                reason="均线金叉"
            )
            signals.append(sig)
        return signals

    def after_market(self, ctx: StrategyContext) -> List[Signal]:
        """每日收盘后触发，可进行对账、清洗或计算盘后信号"""
        return []

    def finalize(self, ctx: StrategyContext) -> None:
        """回测结束后调用，用于总结记录、导出额外指标等"""
        pass
```
