# Strategy Modes

Choose the smallest mode that answers the user's hypothesis. These are options, not mandatory layers.

| Mode | Best fit | Typical evidence | Main validation |
|---|---|---|---|
| News event-driven | Discrete policy, earnings, announcement, supply-chain, macro, or emergency catalysts | event time, novelty, source, affected entities, surprise, market response | event study, abnormal return, hit rate, MFE/MAE, calibration |
| Technical/trend | Persistent price/volume movement and breakout hypotheses | adjusted OHLCV, momentum, moving averages, volatility, volume | walk-forward stability, turnover, slippage, regime split |
| Mean reversion | Temporary deviations expected to normalize | spread/z-score, volatility, liquidity, market/industry residual | half-life, tail loss, capacity, structural-break tests |
| Fundamental/value | Medium/long horizon company quality, growth, or valuation | PIT financial statements, disclosure dates, price multiples | publication lag, sector neutrality, rebalancing lag, revisions |
| Multi-factor | Diversified cross-sectional ranking | momentum, quality, value, volatility, liquidity, event factors | IC/RankIC, decay, factor correlation, quantile returns |
| Statistical arbitrage | Relative-value relationships with controlled exposure | cointegration/spreads, residual returns, liquidity | stability, borrow/short constraints, costs, break detection |
| Machine learning | Nonlinear interactions with enough clean samples | PIT features and explicit labels | chronological split, nested tuning, calibration, drift |
| Portfolio/risk overlay | Allocation and exposure control after a signal exists | covariance, beta, sector exposure, drawdown, liquidity | stress tests, concentration, turnover, capacity |

## Selection Rules

1. Start from the user's hypothesis, horizon, and execution constraints; do not choose a mode because a library supports it.
2. Event-driven is preferred for a discrete news catalyst, but it is not required for pure technical, fundamental, or relative-value research.
3. Combine modes only when each contributes a named role, such as event signal + liquidity filter or fundamentals + technical timing.
4. Keep each component's standalone result so a failed combination can be diagnosed.
5. Do not use reinforcement learning by default. Require a realistic environment, transaction costs, stable state/action definitions, and strong simpler baselines first.
6. Treat event-driven evidence as an optional alpha source or timing overlay. Keep the base strategy result, event-only result, and combined result separate; promote the combination only if it improves walk-forward risk-adjusted performance after costs.
7. Keep alpha, portfolio construction, risk management, and execution as separate modules so each layer can be tested and replaced independently.

## Selection Matrix

Choose the mode from evidence availability and decision horizon, not from the user's preferred story:

| User intent | Primary mode | Optional confirmation | Do not silently add |
|---|---|---|---|
| “今天这条消息影响什么” | Event study/event-driven | technical reaction, fundamentals | portfolio Sharpe or position weight |
| “找中长期好公司” | Fundamental/value or quality | momentum timing, event risk | intraday execution claims |
| “跟随趋势” | Technical/trend | liquidity and regime filters | future fundamentals |
| “价格会回归吗” | Mean reversion | structural-break and event filters | unlimited averaging down |
| “全市场选股” | Multi-factor | neutralization and event overlay | untested factor stacking |
| “两个资产价差” | Statistical arbitrage | regime/break detector | unsupported shorting |
| “让模型学信号” | Machine learning | deterministic baseline | random train/test split |

When the user does not specify a mode, present at most three plausible modes with their required data, horizon, and falsification condition, then select the least complex defensible default. Record the rejected alternatives.

## Shared Baselines

- Compare against buy-and-hold, benchmark index, industry-neutral baseline, and a simpler strategy where appropriate.
- Use one research pipeline for backtest and shadow mode so timestamps, features, costs, and decisions remain comparable.
- Record experiment configuration and outputs; do not silently change data, prompt, model, or parameters between runs.
- Use a champion/challenger process. A challenger changes one named hypothesis or component, runs on the same frozen data and costs, and replaces the champion only after declared out-of-sample promotion gates pass.
