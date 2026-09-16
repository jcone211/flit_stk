# Xiaoshi API Reference

Base URL: `https://api.shizixi.com`. Contract: `xiaoshi-agent-contract/v1`.
`GET /api/v3/capabilities` is the only authoritative capability catalog; the operation list below
was verified against platform `2026-09-05.4`. See
[platform-contract.md](platform-contract.md) for the audit snapshot and the retired-path table.

## Bootstrap And Version Check

Read the platform Manifest and capability catalog once at the start of every new task with
`Cache-Control: no-store, no-cache`:

- `GET /api/v3/manifest` - `contract`, `platform_version`, `prompt_version`, `capabilities_url`,
  `capabilities_sha256`, `minimum_client_version`, `client_update`, `package_manifest_url`
- `GET /api/v3/capabilities` - groups, operations, protections, workflow catalog
- `GET /api/v3/status` - service and scheduler freshness
- `GET /api/v3/tools/xiaoshi-agent-tools/manifest` - packaged CLI/MCP/Skill files, sizes, hashes
- `GET /api/v3/bootstrap` - registration/login flow for the user's own account

Verify `capabilities_sha256` by re-hashing the decoded capabilities body as UTF-8 JSON with sorted
keys, compact separators and `ensure_ascii=false`. Do not download the tool package, prompt or Skill
bodies when the version and hash are unchanged.

Version and compatibility rules:

- Local Skills and the CLI/MCP entries ship **inside** `xiaoshi-agent-tools`; they update only with
  that package, never by fetching new online routes or ad-hoc resource bodies.
- Before online work, check `client_update`: minimum `2026.9.13.1`, latest `2026.9.13.3`. Install,
  upgrade and rollback need the user's explicit approval of the exact target version
  (`xiaoshi-data update apply --version <v> --approve <v>`). MCP never upgrades itself.
- When `upgrade_required` is true, stop online queries, report the reason, and ask for approval.
  Local verification and computation still work.
- Keep `FASTMCP_CHECK_FOR_UPDATES=off` for offline MCP checks.

## Market Quotes

- `GET /api/v3/market/capabilities` - read before any index request: `live_index_symbols`
  (CN: `000001 000016 000300 000688 000852 000905 399001 399006`; HK: `HSI HSTECH HSCEI`;
  US: `DJI IXIC NDX INX`), `instruments` (`stock/index/etf` ready, `future/option` adapter_reserved),
  cache (`fresh_seconds=30`, `stale_fallback_seconds=86400`), derived fields.
- `GET /api/v3/market/quote/{symbol}?market=CN|HK|US&instrument=stock|index|etf` - one instrument.
  Always pass both `market` and `instrument`: codes are not globally unique (`000001` is a bank as a
  stock and 上证指数 as an index). Never use a K-line route to identify an index.
- `POST /api/v3/market/quotes` - bounded cross-market batch, body
  `{"requests":[{"symbol":"600519","market":"CN","instrument":"stock"}, ...]}`.
  1-100 instruments per call; 101 requests return `400 requests must contain 1-100 instruments`.
  Use it for a small universe instead of polling symbols one by one. Per-instrument failures come
  back in `errors[]` while valid symbols still return; `count`/`error_count` summarize the call.

Quote rows carry `schema_version=market-quote-v1`, `market`, `instrument`, `symbol`, `name`,
`exchange`, `currency`, `price`, `previous_close`, `open`, `high`, `low`, `change`, `change_pct`,
`amplitude_pct`, `volume`, `amount`, `turnover_pct`, `bid1`/`ask1`/`mid_price`/`spread`/`spread_bps`
(level-1 only; `bids`/`asks` may contain unanswered levels with `volume=0`), `observed_at`,
`received_at`, `source`, `quote_status`, `price_basis`, `regular_session_completed`,
`closed_session_reference`, `intermission_reference`, `snapshot_age_seconds`, `cache_status`,
`is_stale`, `age_seconds`.

Read `quote_status`/`price_basis` before calling a price "live": outside the session the platform
returns completed-session references (`closed_session_reference`, `price_basis=completed_close`)
rather than an intraday tick. Keep `observed_at` as the market-observation time.

There is **no** public live full-market snapshot. Never reconstruct one by looping
`market/quote/{symbol}`; freeze a research universe from a downloaded history file instead.

## News And Event Evidence

- `GET /api/v3/news/semantic?q=<query>&k=<1-50>` - bounded semantic retrieval over stored financial
  evidence. Returns `query`, `count`, `results[]` with `news_id`, `title`, `source`,
  `original_source`, `pub_time`, `summary`, `url`, `original_url`, `similarity`, `detail_path`,
  `source_verified`. The query string must be UTF-8 percent-encoded. This is evidence retrieval, not
  an exhaustive web search, and it is not a server-generated answer engine.
- `GET /api/v3/quant/events/schema` - event field schema, event types and person/region vocabulary.
- `GET /api/v3/quant/events` - one point-in-time event timeline. Parameters: `since`, `to`,
  `event_types` (`news,person,research,macro,announcement,policy,future_dynamic,sector,
  sector_constituent`), `person`, `stock`, `industry`, `source`, `topic`, `min_score`, `limit`
  (<=500). The response is `quant-event-v2` with `point_in_time=true`.
- Future-probability evolution uses `event_types=future_dynamic`: without `topic` you get the latest
  observation of every open item in the window; with a factor ID, numeric topic ID or title keyword
  you get that item's probability timeline. Keep `future_probability.observed_at`, `available_at` and
  `observation_mode` (`source_history_backfill` vs `continuous_platform_observation`) separate.
  `change_24h` is a probability difference where `0.05` means 5 percentage points.
- `available_at` is the first time the platform could know the record; `event_time` is when the
  event happened. Join research and backtests on `available_at`.

The retired news projections (`/api/v3/news`, `/api/v3/public/*`, `/api/v3/future-dynamic/*`,
`/api/v3/briefings/*`, `/api/v3/sector/*`) are replaced by `quant/events` plus `quant-data`.

## Quant Data

- `GET /api/v3/quant-data/catalog` - datasets with `id`, `name`, `description`, `maturity`,
  `history_status`, `schedule`, `factor_fields`, `caveat`, `state` (as_of, sources, record_count,
  columns), plus published `derived_factors` definitions/snapshots and `strategy_research` status.
  Read the definitions first and merge snapshots by ID; a definition without a snapshot keeps its
  definition and reports `snapshot_status` instead of becoming zero.
- `GET /api/v3/quant-data/{dataset}/status` - state and freshness for one dataset.
- `GET /api/v3/quant-data/{dataset}?code=&since=&to=&limit=` - bounded records (`limit` <= 5000; the
  response is `quant-alt-v1` with `history_status`, `history_available_from/to`, `count`,
  `total_count`, `has_more`, `next_offset`).
- Verified dataset ids: `northbound_holdings`, `northbound_daily_stats`, `margin_trading`,
  `stock_fundflow`, `stock_fundflow_aggregate`, `block_trades`, `shareholder_count`,
  `top_shareholders`, `restricted_unlock`, `broker_consensus`, `etf_flow`, `derivatives_sentiment`,
  `convertible_bonds`, `convertible_bonds_realtime_estimate`, `high_frequency_macro`,
  `sector_boards`, `sector_constituents`.
- Quota: no daily quota after registration; batch enumeration still belongs to the CLI.

See [medium-low-frequency-data.md](medium-low-frequency-data.md) for field-level caveats and the
published derived-factor list.

## History Delivery (R2)

- `GET /api/v3/history/catalog?limit=&offset=&dataset=&market=&date=&since=&to=&event_type=` -
  versioned file catalog (items carry `dataset`, `market`, `year`, `adjust`, `key`, `size`, `rows`,
  `sha256`, `first_date`, `last_date`, `quality_status`, `min_available_at`, `max_available_at`,
  `partition`). The catalog does not stream data.
- `GET /api/v3/history/manifest` - accepts the same dimensions as a download spec (`dataset`,
  `market`, `code`, `year`, `date`, `as_of`, `event_type`, `adjust`) and returns coverage, quality
  gates and the publication revision. It is lenient about unknown dataset ids, so validate the id
  against the catalog or the CLI spec table.
- `GET /api/v3/history/download-session?dataset=&market=&code=&year=&date=&as_of=&event_type=&adjust=`
  - returns two-hour presigned R2 URLs plus file metadata, e.g.
  `dataset=cn-daily&adjust=qfq&year=2020`.
- `POST /api/v3/research/package` - body `{strategy_name, markets[], since, to, frequency, adjust,
  codes[]}` returns `strategy-research-package-v1` with `package_id`, `research_window`, `universe`,
  `history_manifest`, `download_endpoint` and `download_requests[]`. It plans market/year R2 files
  and never enumerates per stock.

Verified history dataset ids and their required dimensions:

| dataset | required dimensions | notes |
|---|---|---|
| `cn-daily` | `year`, `adjust` | A-share market-year file; do not send `market`/`code` |
| `adjustment-factors` | `year`, `adjust` | A-share adjustment factors |
| `cn-minute` | `code` | A-share minute history |
| `global-daily` | `market`, `year`, `adjust` | HK/US market-year raw daily bars |
| `daily-stock` | `market`, `code`, `year`, `adjust` | one stock, one year bucket |
| `daily-date` | `market`, `date`, `adjust` | one market date |
| `sector-constituents` | `date` | published memberships for one trading date |
| `event-timeline` | `date` (+ optional `event_type`) | PIT event archive for one date |
| `financial-current` | `year` (+ optional `code`) | current observable statement version |
| `financial-as-reported` | `date`, `as_of` (+ optional `code`) | as-reported vintage |

Rules:

- Dimensions outside the dataset's declaration are rejected
  (`history_dimensions_missing_or_unexpected`, `unsupported_history_dataset`).
- R2 URLs expire after two hours. Download with a plain `GET` and **no** `Authorization`,
  `X-API-Key`, AWS signing or `x-amz-content-sha256` header; never reuse the Xiaoshi API session for
  R2 and never forward the API Key.
- Verify both `size` and `sha256`. On expiry request one fresh link; if that fails, report the exact
  dataset/market/code/year/object instead of re-routing to a retired online endpoint.
- Prefer the packaged `xiaoshi-data` CLI (`download`, `verify`, `coverage`, `freshness`,
  `research-package`, `validate-factor`, `backtest`) so hashing, staging and atomic replacement stay
  consistent. See [history-sync-and-delivery.md](history-sync-and-delivery.md).

## PIT And Metadata

- `GET /api/v3/pit/catalog` - PIT datasets with the platform's vintage policy.
- `GET /api/v3/meta/data-contract` - official meaning of `event_time`, `available_at`, revisions,
  units, currencies and null states (`version=2026-09-05.4`, `compatibility=current-contract-only`).

## Account, Feedback And Errors

- `GET /api/v3/auth/api-key/check` - validate the agent Key.
- `GET /api/v3/account/overview` and `/api/v3/account/diagnostics` - permissions/usage and the error
  catalog; they authenticate with the **human web session cookie**, so an agent Key returns
  `401 Invalid session token`. Never present that as a Key failure.
- `POST /api/v3/feedback` - one bounded report per distinct failure with `category=bug|suggestion`,
  `source=agent`, endpoint, status code, request ID, client version and a short reproduction. Never
  include the API Key, Authorization header, email, IP, full logs or complete response bodies.
  `GET /api/v3/feedback/{report_id}` reads the handling status.
- `429` with `rate_limit_exceeded` or `bulk_download_required` is a protection response: stop, obey
  `Retry-After`, do not retry inside the window, and hand bulk history to the CLI.
- Send `Authorization: Bearer <API Key>` for authenticated endpoints (the pre-migration `X-API-Key`
  alias is retired). The website handles onboarding and governance; the API is authoritative.
