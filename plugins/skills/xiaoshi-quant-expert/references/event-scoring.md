# News Event Practice Scoring

Use this protocol only when the selected strategy includes news events. It measures whether an event forecast worked in later market data without contaminating the original forecast.

## 1. Build One Point-In-Time Event

Cluster reprints and follow-ups into one `event_id`. Keep the first usable timestamp and attach later updates instead of counting each article as a separate prediction.

Freeze this ex-ante record before looking at outcomes:

```text
event_id, news_ids, published_at, available_at, first_seen_at,
source, source_tier, event_type, entities, stocks, industries,
direction, expected_horizon, importance_0_100, confidence_0_1,
novelty_0_1, surprise_0_1, breadth_0_1, tradability_0_1,
reasoning, prompt_version, skill_version, model_version
```

`available_at` controls when a signal may exist. Do not backdate translated, enriched, clustered, or revised fields.

## 2. Build The Event Timeline

Produce one ordered timeline instead of a flat article list:

```text
t0 first_seen/available: first tradable evidence and frozen factor-v2 snapshot
t1 confirmation: independent source, official filing, or regulator statement
t2 development: material facts that change direction, magnitude, horizon, or entities
t3 market response: first legal execution bar, volume/volatility reaction, benchmark response
t4 resolution: completed horizon, invalidation, cancellation, or superseding event
```

Each node must contain `published_at`, `available_at`, source, URL/news_id, what changed, and whether it was knowable at that time. Later confirmations may raise confidence prospectively; they may not rewrite the t0 forecast. Cluster syndicated copies into the same node.

## 3. Separate Four Scores

- **Editorial importance**: public impact and urgency. It is not a return forecast.
- **Ex-ante signal score**: predicted direction, magnitude band, horizon, confidence, novelty, source credibility, surprise, breadth, and tradability. Freeze it.
- **Strategy contribution**: the signed, capped contribution after decay and prior calibration. It is not the final portfolio weight.
- **Ex-post practice score**: computed later from observable market outcomes. Never overwrite either score above.

Use Xiaoshi `factor-v2` as an explainable input package, not a direct trading instruction. Keep its ten inputs, observable market evidence, and contributions with the event snapshot. `market_impact` prioritizes measured index, volatility, rate, commodity, currency, and synchronized constituent moves; it is editorial ranking evidence, not a direct trading instruction. A generic composition is:

```text
signed_event_alpha = direction
  * confidence * source_credibility * novelty_surprise
  * time_decay * tradability * prior_oos_calibration

combined_alpha = (1 - event_budget) * base_alpha
  + event_budget * signed_event_alpha
```

`event_budget` is user-declared and capped by the independent risk layer. Before enough out-of-sample event samples exist, set it to zero for execution and report the event as research/shadow only. Conflicting active events reduce confidence; do not add their absolute scores.

A practical 0-100 score may combine normalized components with fixed, versioned weights:

```text
30% direction accuracy
25% benchmark/industry-neutral abnormal return rank
15% confidence calibration
10% speed within expected horizon
10% favorable/adverse excursion quality
10% breadth consistency across named stocks/industry
```

If a component is unavailable, mark it missing and renormalize only among declared available components. Do not treat missing data as success.

## 4. Outcome Windows

Evaluate only after each window closes: `5m`, `30m`, `1d`, `3d`, `5d`, and `20d`, subject to the event's expected horizon and market hours. Use the first legally tradable bar after `available_at` as entry reference.

For each affected asset record:

- raw and benchmark/industry-neutral abnormal return
- maximum favorable excursion (MFE) and maximum adverse excursion (MAE)
- volume and volatility reaction versus a pre-event baseline
- direction hit, time to peak response, and signal decay
- suspension, limit-up/down, missing bar, and liquidity flags

An event study treats each eligible event as an independent observation. Report event count, average, median, win rate, best/worst event, dispersion, and confidence intervals where feasible. Do not report portfolio Sharpe, annualized return, or maximum drawdown unless a separate, fully specified capital/position strategy was actually simulated.

Do not score overnight information as if it were tradable before the next open. Respect T+1 and price limits in strategy returns.

## 5. Aggregate And Calibrate

- Report sample size and coverage by event type, source tier, industry, horizon, and market regime.
- Use RankIC or Spearman correlation for ranking quality and Precision@K for top-event selection.
- Use Brier score and reliability buckets for predicted direction probabilities. Fit sigmoid/isotonic calibration only on prior training/validation data, never the final test window.
- Weight repeated updates from one event once; otherwise syndication volume will inflate confidence.
- Track rolling performance and concept drift. Decay or suspend a rule only from out-of-sample evidence, not a single miss.

## 6. Practice Report

Return the frozen forecast beside observed outcomes:

```text
事件与首次可用时间
原始预测: direction / horizon / confidence / importance
市场结果: each completed window, abnormal return, MFE, MAE
实践评分: score version, available components, sample context
是否符合预期: yes / no / inconclusive
误差来源: timing / mapping / source / regime / liquidity / confounder
下一步: keep / recalibrate / collect more samples / suspend
```

Also show the current timeline node, factor score version, base signal, event contribution, risk-adjusted target, and whether the event layer was user-enabled. Use `pending`, `inconclusive`, or `blocked` instead of inventing a score.

An incomplete window is `pending`, not zero. A result with missing benchmark, stale quote, or confounding major event is `inconclusive`, not a clean hit or miss.
