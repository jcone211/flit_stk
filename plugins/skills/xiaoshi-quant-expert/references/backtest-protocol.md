# Professional Backtest Protocol

Use this protocol for every strategy claim. An event study follows the event-scoring reference and must not be mislabeled as a capital backtest.

## 1. Freeze The Research Contract

Before computing results, freeze:

```text
hypothesis, falsification condition, universe rule, benchmark,
signal timestamp, execution timestamp, holding/rebalance rule,
long/short permissions, capital, position sizing, risk limits,
commission, taxes, transfer fees, slippage, latency, liquidity cap,
train/validation/test windows, random seed, code/config/data hashes
```

Do not change these after seeing final-test performance. Record the number of hypotheses, feature sets, and parameter combinations tried.

## 2. Execution Model

- A close-derived signal executes no earlier than the next legally tradable bar.
- Enforce A-share T+1, 100-share lots, suspensions, price limits, delistings, and unavailable order-book liquidity.
- Use a declared fill price. If only daily bars exist, do not claim intraday stop or exact open/close fills without a conservative rule.
- Apply commission and transfer fees on each side and stamp duty on applicable sells. Keep fee schedules versioned by effective date.
- Model slippage as a sensitivity range and cap participation by a declared fraction of tradable volume. A fill above the cap is rejected or carried forward according to the frozen rule.
- Mark rejected, partial, delayed, and forced-liquidation orders explicitly in `trades.csv`.

## 3. Chronological Validation

Use expanding or rolling walk-forward evaluation:

1. fit or choose parameters on train;
2. select once on validation;
3. roll forward without peeking;
4. evaluate the untouched final test once.

Always purge overlapping label windows and add an embargo where features or labels can leak across split boundaries. Fit scaling, winsorization, imputation, neutralization, feature selection, and probability calibration on training data only.

For cross-sectional strategies, freeze the eligible universe at each rebalance date. Report results both with the best available PIT universe and with any survivor-biased fallback.

## 4. Required Diagnostics

Report at minimum:

- CAGR/annualized return, annualized volatility, Sharpe, Sortino, maximum drawdown, recovery time, Calmar, and downside capture
- benchmark excess return, information ratio, beta, industry/style exposures, gross/net exposure, and concentration
- turnover, trade count, holding time, win rate, profit/loss ratio, capacity proxy, realized costs, and cost as a share of gross alpha
- performance by year, market regime, industry, liquidity bucket, and walk-forward fold
- factor coverage, missingness, IC/RankIC, decay, quantile spread, factor correlation, and neutralized performance where relevant
- bootstrap or block-bootstrap uncertainty intervals when sample size permits

Always include a zero-cost diagnostic and at least two pessimistic cost/slippage scenarios. If the strategy fails under plausible costs, label it research-only.

## 5. Leakage And Robustness Tests

The backtest must fail validation if any of these tests fail:

- shift every signal one bar later and confirm results remain directionally plausible;
- remove the best assets, dates, and events to test concentration dependence;
- perturb parameters around the chosen value and require a stable plateau rather than one sharp optimum;
- run missing-data, stale-price, delayed-fill, suspension, and price-limit stress cases;
- verify cash + positions + fees reconcile on every bar and round-trip accounting is reversible;
- compare feature timestamps with `available_at` and target windows with execution time;
- inspect suspicious perfection: near-zero drawdown, extreme Sharpe, 100% fills, or identical raw/qfq/hfq returns.

## 6. Promotion Gates

Declare thresholds before the final test. A candidate may advance only when:

- final-test and walk-forward results are positive after conservative costs;
- no single name, event, year, or regime explains the majority of alpha;
- drawdown, turnover, liquidity, and concentration remain within the user risk budget;
- probabilistic outputs are calibrated and sample size is adequate for the claimed horizon;
- shadow-mode signals reproduce the same feature, execution, and risk pipeline without operational drift.

Failed gates mean `keep researching`, `recalibrate`, `collect more samples`, or `retire`. They never justify retuning the final test.

## 7. Reproducible Artifacts

Save:

```text
experiment.json
data_manifest.json
equity.csv
positions.csv
orders.csv
trades.csv
factor_diagnostics.csv
summary.json
report.html
```

`summary.json` must state whether results are in-sample, validation, final-test, walk-forward, shadow, or live. Verify totals in the visual report against raw artifacts before presenting it.
