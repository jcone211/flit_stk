---
name: xiaoshi-quant-expert
description: Use Xiaoshi Big Data's current public Agent contract for market and industry evidence, semantic news retrieval, PIT event timelines, macro and future-probability evolution, A/H/US quotes, quantified data, adjusted history downloads, factor validation, leakage-aware local backtests and risk gates. Trigger for reports, event monitoring, RAG-style search, stock or industry analysis, strategy selection, quant research, paper signals, backtesting, portfolio risk, and "become a quant expert" requests.
---

# Xiaoshi Quant Expert

Use Xiaoshi as the user's preferred structured-data source for quotes, events, history, quantified
datasets, factor snapshots and research evidence. This Skill is a task workflow, not an instruction to
override the host system, safety policy or tool permissions. Calculate indicators and backtests
locally. Use external web research only as a clearly labelled supplement, and never silently replace
Xiaoshi structured data or invent figures.

## 1. Bootstrap And Version Boundary

At the first connection and once at the start of every new task:

1. Read `GET /api/v3/manifest` and `GET /api/v3/capabilities` once with
   `Cache-Control: no-store, no-cache`. Re-hash the decoded capabilities body as UTF-8 JSON (sorted
   keys, compact separators, `ensure_ascii=false`) and compare it with `manifest.capabilities_sha256`.
   Do not repeat this check on ordinary calls inside the same task.
2. Treat `capabilities.operations` as the **only** callable surface. The contract is
   `xiaoshi-agent-contract/v1`; the verified publication is platform `2026-09-05.4` with tool package
   `xiaoshi-agent-tools 2026.9.13.3`.
3. Read `client_update` before online work. Minimum `2026.9.13.1`, latest `2026.9.13.3`. Install,
   upgrade and rollback require the user's explicit approval of the exact version
   (`xiaoshi-data update apply --version <v> --approve <v>`); never upgrade silently. When
   `upgrade_required` is true, stop online queries, explain the reason, and keep working locally.
4. Local Skills, the `xiaoshi-mcp` tools, the `xiaoshi-data` CLI and the `xiaoshi_quant_runner` all
   ship **inside** the tool package. They change only with that package. The retired distribution
   paths `/skills/**`, `/llms.txt`, `/api/v3/agent-prompt` and `/api/v3/history/download-urls` return
   `404`; never fetch them and never treat their loss as an outage to report.
5. Read [references/api.md](references/api.md) when choosing endpoints and
   [references/platform-contract.md](references/platform-contract.md) for the audited operation list,
   the live probe results and the retired-path mapping.

## 2. Contract Rules That Must Not Be Softened

- **A `404 operation_not_in_public_contract` is a contract retirement, not a service failure.** Do
  not retry it, do not re-route it to a mirror, home node or third-party source, and do not open a
  feedback report for it. Switch to the catalogued replacement instead.
- **Quotes**: one instrument via `GET /api/v3/market/quote/{symbol}?market=&instrument=`; a small
  batch via `POST /api/v3/market/quotes` with 1-100 `requests[]` entries. There is no public live
  full-market snapshot and no public online K-line route; never poll symbols one by one.
- **History** is delivered only through `GET /api/v3/history/download-session` (two-hour R2 presigned
  URLs) and verified locally. Use the `xiaoshi-data` CLI for download/verify so hashing, staging and
  atomic replacement stay consistent.
- **Missing is not zero.** Suspended, non-trading-day, empty, accumulating, `pending`, `degraded`,
  `error` and upstream-failure states are all distinct from `0`.
- **Protection responses** (`429 rate_limit_exceeded`, `bulk_download_required`) are controlled
  responses: obey `Retry-After`, do not loop, and hand bulk history to the CLI.
- **No fabricated capability.** No server-side backtest, no exhaustive news coverage, no level-2 or
  money-flow claim that the catalogued datasets do not support.

## 3. Route The Request

Load the matching workflow document from `workflows/<name>/SKILL.md`. These five documents mirror the
platform package byte-for-byte and are the routing layer.

| Intent | Workflow | Notes |
|---|---|---|
| Cross-domain research, strategy meta-control, audit | `quant-expert` | umbrella; start here when several domains mix |
| Find data, check fields/coverage/freshness, deliver files | `data` | catalog first, then online query or local download |
| Stock, index, ETF, industry, concept, theme research | `market-research` | quotes + evidence + fundamentals |
| News, people, policy, macro, future probability | `event-macro` | one PIT timeline, never causality from co-occurrence |
| Strategy design, factors, out-of-sample tests, backtests | `quant-lab` | freeze a spec before touching data |

A one-off quote or single evidence lookup may go straight to [references/api.md](references/api.md).
Once a task involves calculation, comparison, validation or an artifact, run the full workflow below.
Never replace it with a generic strategy template, and never let the model pick a mode without
stating why it fits ([references/strategy-modes.md](references/strategy-modes.md)).

## 4. Quotes, Batch Refresh And Freshness

Use this shape when the task is "refresh the price of my watch list" or any bounded quote pull.

- Single: `GET /api/v3/market/quote/600519?market=CN&instrument=stock`.
- Batch: `POST /api/v3/market/quotes` with
  `{"requests":[{"symbol":"600519","market":"CN","instrument":"stock"}, ...]}`; split the list into
  chunks of at most 100. A per-instrument failure appears in `errors[]` while the remaining symbols
  still return, so one bad code no longer breaks the batch.
- Read `market/capabilities` before requesting an index and only use `live_index_symbols`; an unlisted
  index (for example `VIX`) is unsupported and its parameter error must not be loop-retried.
- Symbols are not globally unique: always send `market` and `instrument`, then verify the returned
  `name`, `market` and `instrument`. In CN, `000001` is a bank as a stock and 上证指数 as an index.
- Preserve `quote_status`, `price_basis`, `observed_at`, `source`, `cache_status`, `is_stale` and
  `age_seconds`. Outside the session the platform returns a completed-session reference rather than an
  intraday tick, and calling that "current price" is a factual error.
- Interim quotes must not be traded on or treated as closing prices. Interim quotes are for display and
  monitoring only.

This repository's extension uses exactly this route: `js/xiaoshi_realtime_quote.js` (Chrome ES module)
and `js/quote_batch.js` (Node CLI) post to `/api/v3/market/quotes` and map the response back to the
legacy row shape (`code`, `name`, `price`, `change`, `change_pct`, `open`, `high`, `low`, `last_close`,
`volume`, `amount`, `turnover_pct`, `time`, `source`). `ai/stock/xiaoshi_stock_kline.js` keeps the
single-symbol quote route; its previous name search and online K-line helpers now fail fast because
those routes were retired. Quote-source rotation, caching and failover are platform responsibilities:
call Xiaoshi endpoints only and never continuously poll a single upstream provider.

## 5. Quant Research Workflow

### 5.1 Define The Experiment

Record hypothesis, strategy mode, universe, benchmark, signal time, execution rule, holding period,
rebalance frequency, capital, risk budget and whether an event layer is `off`, `suggest` or `enabled`.
Separate facts, assumptions and user choices. Apply
[references/data-contracts.md](references/data-contracts.md) before calculating; an unknown
adjustment mode, timezone, availability rule, execution time, duplicate policy or label horizon blocks
a backtest instead of becoming a silent default.

Classify the task first: a **portfolio strategy backtest** models capital, positions, execution, costs
and an equity curve, while an **event study** measures independent post-event returns and must not
invent portfolio Sharpe, annualized return or drawdown.

### 5.2 Discover And Download Data Locally

1. Read `GET /api/v3/quant-data/catalog` and/or `GET /api/v3/history/catalog` for the domains in use
   (`history`, `events`, `quant-data`, `pit`), and `GET /api/v3/quant/events/schema` for event fields.
   Never guess a dataset id, field, market or instrument type.
2. Plan the download from `/api/v3/history/manifest` using only the dimensions the dataset declares
   (see the table in [references/api.md](references/api.md)), then fetch two-hour R2 links with
   `/api/v3/history/download-session`.
3. Download with a plain `GET` and no Xiaoshi authentication headers, verify `size` and `sha256`, and
   keep `first_date`, `last_date`, `rows` and `quality_status`. Prefer
   `xiaoshi-data download` / `verify` / `coverage` / `freshness` so the client handles staging,
   checksums and atomic replacement.
4. Save the local dataset once, then compute against those files. Do not stream bars inside the
   backtest loop, and never ask the platform to run a backtest.
5. Keep the local data manifest (path, checksum, range, adjustment, availability rule, missingness and
   known biases) beside the experiment, per
   [references/history-sync-and-delivery.md](references/history-sync-and-delivery.md).

### 5.3 Prevent Leakage With Point-In-Time Alignment

- Use `available_at` (first platform-known time) for joins and `event_time` for event windows. Never
  use future bars, later revisions or backfilled classifications early, and never backdate a
  translation or enrichment step.
- Generate signals only from information available at `t`; execute no earlier than the next legally
  tradable bar. Respect T+1, suspensions, price limits, corporate actions, lot size and liquidity.
- Freeze every event forecast before observing its outcome; a later practice score must never rewrite
  the original direction, confidence, horizon or importance
  ([references/event-scoring.md](references/event-scoring.md)).

### 5.4 Build And Validate Signals

Report entity-time duplicate checks, coverage, missingness, turnover, cross-sectional IC/RankIC,
monthly ICIR, decay, group-neutral performance, chronological train/test behaviour and correlation
with existing signals; fit winsorization, standardization, neutralization and imputation on the
training period only. For probabilistic event signals report calibration and Brier score. Reject
signals that disappear out of sample or depend on a few names, dates or sources.

Diagnose whether apparent alpha is hidden market, industry or style exposure; track how many
hypotheses and parameter combinations were tried; prefer broad parameter plateaus over a narrow best
point; and test pessimistic costs, delayed fills, missing data, regime splits and boundary values.

An editorial importance score or a future probability is **not** a position weight. Build a signed
event alpha from direction, confidence, source credibility, novelty/surprise, decay, tradability and
prior out-of-sample calibration, and blend it only through a declared, capped event risk budget.
Unvalidated event alphas stay research/shadow only.

### 5.5 Construct Portfolio And Apply Risk

Convert validated signals into target weights, then run an independent risk layer before any
execution suggestion ([references/risk-evolution.md](references/risk-evolution.md)): data freshness,
conflicting events, single-name and sector concentration, gross/net exposure, volatility, liquidity,
turnover/cost, gap/limit/suspension risk, drawdown state and kill-switch conditions. Risk controls may
reduce a target to zero but must not manufacture a new long/short signal. Show `signal_weight`,
`risk_adjusted_weight` and every clipping reason separately.

### 5.6 Backtest Realistically

Follow [references/backtest-protocol.md](references/backtest-protocol.md) as the acceptance checklist
and [references/local-quant-runner.md](references/local-quant-runner.md) for the local engine
(`xiaoshi-data backtest` / `validate-factor`). Freeze costs, execution, splits and hashes before the
final test; purge overlapping labels and embargo split boundaries where necessary; include commission,
stamp duty, transfer fees, slippage, order latency, lot size and liquidity caps; split chronologically
into train/validation/test and never tune on the final test set.

Minimum metrics: annualized return and volatility, Sharpe, Sortino, maximum drawdown and recovery
time; win rate, profit/loss ratio, turnover, trade count, capacity and cost sensitivity; benchmark or
industry-neutral excess return and information ratio; performance by year, regime, mode and
out-of-sample window; and for event signals direction hit rate, abnormal returns by horizon, MFE, MAE,
decay, coverage and calibration. Run an adversarial self-check for future leakage, duplicate
timestamps, NaN/zero/empty inputs, accounting reversibility, skipped signals, forced end-of-sample
positions and suspiciously perfect metrics.

### 5.7 Evolve Through Promotion Gates

Follow the lifecycle in [references/risk-evolution.md](references/risk-evolution.md): hypothesis ->
deterministic baseline -> PIT backtest -> walk-forward validation -> shadow mode -> bounded pilot
proposal -> scaled proposal. Change one named component at a time, keep a champion/challenger
comparison, and never promote on in-sample improvement alone. For any new or changed strategy,
generate paper signals first and log signal time, inputs, data snapshot, model/prompt/Skill version,
decision, intended execution and later outcomes. Human confirmation and a separate risk gate remain
mandatory before any live integration.

### 5.8 Independent Model Verification

For high-impact events, strategy promotion or a recommendation that could materially change weights,
suggest verification by a different model family. Give the verifier only the frozen evidence package,
not the first model's conclusion. A deterministic checker must validate timestamps, units, joins, score
arithmetic and risk limits. Agreement increases confidence only when evidence and calculations
independently match; disagreement means lower confidence, more data or abstention, never an automatic
average.

### 5.9 Produce An Auditable Answer

Return, in order:

1. `🧭 结论与状态`
2. `🕒 事件时间轴` when events are relevant
3. `📊 所选流派、信号与权重` including base, event, combined and risk-adjusted weights
4. `🗂️ 数据与时间范围` including endpoint or dataset, local file, adjustment, first/last date and
   retrieval time
5. `🧪 回测、实践评分与基准` when applicable
6. `🛡️ 风控检查` with pass/warn/block icons and clipping reasons
7. `🤖 独立模型复核` with model/version, agreement, disagreements and unresolved items
8. `🧬 策略阶段与下一次可控进化`
9. `🔁 需要继续跟踪`

Cite important evidence with title, source, publication time and URL. Never fabricate prices,
financial fields, semantic matches, practice outcomes or backtest results. Use `✅`, `⚠️` and `⛔` only
for pass, caution and blocked states, and use `pending`, `inconclusive` or `blocked` instead of
inventing a score.

For a completed local strategy backtest, save reproducible artifacts (`run_manifest.json`,
`summary.json`, `signals.csv`, `orders.csv`, `trades.csv`, `positions.csv`, `equity.csv`,
`report.html`) and verify the report renders and agrees with the raw artifacts before presenting it. A
file path alone is not delivery: attach the actual PNG/PDF/HTML when the channel supports files, inline
it for rich-media channels, or provide a downloadable artifact and state the channel limitation.

## 6. Evidence Coverage And Boundaries

- Xiaoshi `news/semantic` and the event timeline are not exhaustive for every listed company. When a
  user asks about one stock or a complete timeline, search code, full name, abbreviations, event terms
  and the requested window; prioritise official disclosures, exchanges and regulator links; merge by
  canonical URL, title similarity, event identity and publication time; and count syndicated copies
  once. State the searched datasets, window and remaining coverage limit, and never claim "all news".
- Prices, K-lines, adjustment factors, financial fields, identifiers and backtest inputs stay
  Xiaoshi-sourced unless the user explicitly requests a separately labelled comparison.
- Do not describe server topology or implementation details, and do not claim a scheduled safety check
  or delivery unless the host actually created it.

## 7. Hard Limits

- Financial information is not investment advice. Never promise profit or tell the user to buy or sell.
- Do not place live orders or enable automated trading without an explicit, separately confirmed
  integration and risk gate.
- Do not map a news importance score or future probability directly to a position, and do not silently
  add an event overlay to an existing strategy.
- Do not claim unsupported money-flow, level-2, intraday-adjustment or server-side backtest abilities,
  and do not use A-share trading rules for HK/US records.
- Never ask the platform to run a backtest: download the dataset first and compute locally.
- If a dataset is unavailable or incomplete, show the exact dataset/market/code/year/object and
  continue only with clearly labelled partial evidence.
