# Risk Layer, Model Verification, And Strategy Evolution

Use this reference for portfolio weights, risk review, strategy improvement, and high-impact conclusions.

## 1. Separate The Four Layers

1. **Alpha** produces signed forecasts with horizon and confidence.
2. **Portfolio construction** converts validated forecasts into pre-risk target weights.
3. **Risk management** clips or blocks targets using independent constraints.
4. **Execution** specifies when and how a permitted target could be reached.

Record the input and output of each layer. Risk may reduce or close exposure but must not invent a new alpha. Execution assumptions must not change the historical signal.

## 2. Risk Gate

Before presenting any actionable target, return a gate table with `✅ pass`, `⚠️ caution`, or `⛔ block`:

| Gate | Required check |
|---|---|
| Data | timestamp, freshness, coverage, adjustment, missingness, stale or conflicting evidence |
| Event | timeline state, independent confirmation, source tier, novelty, decay, confounders |
| Position | single-name cap, sector cap, event-budget cap, gross/net exposure |
| Market | volatility scaling, beta, correlation, regime, gap and tail scenarios |
| Liquidity | turnover, ADV participation, slippage, lot size, limit/suspension risk |
| Portfolio | expected drawdown, current drawdown, stress loss, capacity, benchmark exposure |
| Operations | API/data failure, duplicate signal, clock drift, model/version mismatch, kill switch |

Use user-specified limits. If absent, ask for risk budget before an actionable portfolio; do not invent a supposedly universal percentage. Research-only output may use clearly labeled sensitivity ranges. Show pre-risk and post-risk weights plus each clipping reason.

## 3. Strategy Evolution Ladder

Advance one gate at a time:

0. **Hypothesis**: falsifiable idea, horizon, universe, causal story, failure condition.
1. **Baseline**: simplest deterministic rule and benchmark.
2. **PIT backtest**: frozen local data, costs, no leakage, reproducible artifact.
3. **Walk-forward challenger**: chronological retraining/tuning and untouched final test.
4. **Shadow mode**: live paper signals with later outcomes and operational failures.
5. **Bounded pilot proposal**: human-approved, separately integrated, smallest risk budget.
6. **Scale proposal**: only after capacity, drift, drawdown, and stability gates pass.

Keep a champion and one or more challengers. Change one named component per challenger. Log dataset hash, code/config hash, prompt/Skill/model versions, parameters, costs, metrics, and rejection reason. Never delete failed experiments; they prevent repeated overfitting.

Promotion requires predeclared thresholds for sample size, out-of-sample return/risk, maximum drawdown, turnover/cost sensitivity, concentration, calibration, stability across regimes, and operational reliability. Failure means keep, recalibrate, collect more samples, or retire; it does not mean tune on the final test.

## 4. Independent Model Verification

Use a different model family/provider for material event interpretation or strategy promotion when available.

1. Freeze one evidence package: timestamps, sources, raw fields, factor snapshot, data hashes, assumptions, and requested decision.
2. Ask Model A for the primary analysis.
3. Ask Model B blindly using the same evidence package but not Model A's conclusion.
4. Run deterministic checks for timestamps, joins, units, score arithmetic, risk limits, and reproducibility.
5. Compare direction, horizon, entities, causal chain, confidence, missing evidence, and risk flags.

Do not average prose or confidence automatically. If models disagree on a material item, show the disagreement, lower confidence, gather evidence, or abstain. Never expose the user's API key or unrelated private data to a verifier.

## 5. Feedback Contract

Use a compact, channel-friendly structure:

- `🧭 Decision`: research / shadow / candidate / blocked
- `🕒 Timeline`: t0..tn with source and availability time
- `📊 Weights`: base -> event contribution -> pre-risk -> post-risk
- `🛡️ Risk`: pass/warn/block gates and reasons
- `🧪 Evidence`: backtest/practice score, benchmark, sample and OOS status
- `🤖 Verification`: models used, agreement and unresolved differences
- `🧬 Evolution`: current stage, promotion gate, next single change
- `🔁 Tracking`: invalidation conditions and next evaluation time
