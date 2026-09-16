# Local Quant Runner (packaged client)

## 1. What It Is

The local quant runner is the client half of the Xiaoshi contract: it caches verified Parquet data
locally and runs point-in-time-safe backtests on the user's machine. All computation happens locally;
the platform never runs a user's backtest. The runner ships inside the `xiaoshi-agent-tools` package
(`2026.9.13.3`) together with the `xiaoshi-data` CLI, the `xiaoshi-mcp` MCP server and the five
workflow Skills.

Division of labour:

- `xiaoshi-mcp` handles bounded queries and planning only (it never downloads, writes files or
  creates a download session).
- `xiaoshi-data` handles local files: batch download, verification, coverage/freshness, factor
  validation and backtests.
- Save an MCP-returned `plan` object verbatim as JSON and run it once with `--plan`; do not re-plan or
  pre-create sessions. If a plan is expired or version-mismatched, stop and explain instead of
  silently re-planning.

## 2. Version And Key Handling

```bash
xiaoshi-data update check
xiaoshi-data update apply --version 2026.9.13.3 --approve 2026.9.13.3
xiaoshi-data update rollback --version <previous> --approve <previous>
```

Minimum compatible client is `2026.9.13.1`; the current release is `2026.9.13.3`. Install, upgrade
and rollback require the user's explicit approval of the exact target version. A failed candidate keeps
the last verified environment; the stable entry point is switched only after local protocol
verification, and an existing MCP process must be reconnected afterwards. Windows installs at or below
`2026.9.10.2` cannot self-apply and need one manual package install first.

Never pass the API Key as a command argument or write it into a plan, log or report. Inject it through
the protected `XIAOSHI_API_KEY` secret; `--api-key` exists only for interactive local use.

## 3. Commands

### Environment and catalog

```bash
xiaoshi-data status
xiaoshi-data capabilities
xiaoshi-data catalog --dataset cn-daily --limit 100
xiaoshi-data schema --dataset cn-daily
xiaoshi-data freshness
xiaoshi-data coverage --dataset cn-daily
```

`catalog`, `schema`, `coverage`, `freshness`, `download` and `research-package` accept `--quality
complete|available` and `--revision <manifest_version>`. `complete` is the default snapshot;
`available` explicitly accepts newest-available data with gaps and must be stored in a separate
`--data-dir`.

### One bounded download spec

```bash
xiaoshi-data download --dataset cn-daily --year 2020 --adjust qfq --data-dir ./xiaoshi_data
xiaoshi-data download --dataset daily-stock --market CN --code 600519 --year 2020 --adjust qfq --data-dir ./xiaoshi_data
xiaoshi-data download --dataset event-timeline --date 2026-09-01 --event-type announcement --data-dir ./xiaoshi_data
xiaoshi-data download --plan history-plan.json --data-dir ./xiaoshi_data
```

Every call uses exactly one dataset and only that dataset's declared dimensions; there is no
per-symbol enumeration and no market-wide loop. Reproduce an earlier publication with
`--revision <manifest_version>`.

### Verification and local query

```bash
xiaoshi-data verify --data-dir ./xiaoshi_data --output verify.json
xiaoshi-data query --data-dir ./xiaoshi_data --dataset cn-daily --code 600519 --since 2020-01-01 --to 2020-12-31 --limit 500
```

`verify` checks Parquet files, hashes, schema and semantics (duplicate keys, ranges, availability and
adjustment). `query` runs a bounded local query and returns JSONL or writes Parquet. Data validation
always uses `verify`; there is no `validate-data` alias any more.

### Factor validation and backtest

```bash
xiaoshi-data validate-factor --input factor.csv --output factor_validation.json --quantiles 5
xiaoshi-data backtest --strategy ./my_strategy.py --data-dir ./xiaoshi_data \
  --codes 600519,000001 --start 2020-01-01 --end 2025-12-31 \
  --adjust qfq --capital 1000000 --benchmark 000300 --seed 42 \
  --output-dir ./backtest_output
```

A strategy file must export a `Strategy` class derived from `StrategyBase`, or a `strategy` instance.
The factor validator expects `date,factor,forward_return` columns and reports out-of-sample quantile
behaviour. The backtest engine applies T+1 execution, configurable fees/slippage and a separate risk
layer, and it never uploads strategy code or results.

### Strategy research package

```bash
xiaoshi-data research-package --request ./research-request.json --data-dir ./xiaoshi_research
xiaoshi-data research-package --plan research-plan.json --data-dir ./xiaoshi_research
```

`research-request.json` carries `strategy_name`, `markets`, `since`, `to`, `frequency`, `adjust` and
optional `codes`. The server only plans market/year (or market/month) R2 files; `codes` is a local
filter and never a server-side loop.

## 4. Output Artifacts

A local backtest writes a reproducible package into `--output-dir`:

- `run_manifest.json` - seed, window, adjustment, cost configuration, execution parameters, data
  sources and the SHA-256 of every local input
- `summary.json` - annualized return, Sharpe, Sortino, maximum drawdown, recovery time, trade count
- `signals.csv`, `orders.csv`, `trades.csv`, `positions.csv`, `equity.csv`
- `report.html` - Chart.js report of strategy/benchmark equity, drawdown, exposure and cash

Pre-open signals are simulated at the same day's open; close and after-close signals execute no
earlier than the next tradable session's open. Signals still pending at the end of the sample must be
kept as `pending_signals`, never filled in as trades.

## 5. Boundaries

- The platform is a data and evidence provider; it never executes the user's backtest or stores
  strategy artifacts.
- Local factors and strategies remain research results until they pass the promotion gates in
  [risk-evolution.md](risk-evolution.md); nothing here authorizes live trading.
- A plan, verify report or backtest report that contains a signed URL, API Key or local secret must be
  rejected and regenerated — plans are hash-bound and secret-free by contract.
