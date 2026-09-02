# Xiaoshi API Reference

Base URL: `https://api.shizixi.com`

## Discovery And Skill

- `GET /llms.txt`
- `GET /api/v3/manifest`
- `GET /api/v3/history/manifest`
- `GET /api/v3/history/download-session` (query parameters only; `/download-urls` remains a compatibility alias)
- `GET /api/v3/history/auto-update.py`
- `GET /skills/xiaoshi-quant-expert/SKILL.md`
- `GET /skills/xiaoshi-quant-expert/references/api.md`
- `GET /skills/xiaoshi-quant-expert/references/strategy-modes.md`
- `GET /skills/xiaoshi-quant-expert/references/event-scoring.md`
- `GET /skills/xiaoshi-quant-expert/references/risk-evolution.md`
- `GET /skills/xiaoshi-quant-expert/references/local-quant-runner.md`
- `GET /skills/xiaoshi-quant-expert/references/miniqmt-data-adapter.md`
- `GET /skills/xiaoshi-quant-expert/references/strategy-contract.md`
- `GET /skills/xiaoshi-quant-expert/references/medium-low-frequency-data.md`

Read the manifest metadata once at first connection and once at the start of every new task with `Cache-Control: no-store, no-cache`. The manifest's fixed `manifest_version`, `prompt_version`, `skill_version`, `prompt_url`, `skill_url`, `api_schema_url`, checksums, and `min_compatibility` fields are the publication contract. Do not repeat the manifest check on ordinary API calls in the same task. Read `/api/v3/agent-prompt` only after the user explicitly says `更新小石提示词` or the manifest reports a changed prompt version/checksum. Download a resource only when its version/checksum changed; unchanged versions mean no body download. A daily 04:55 metadata check may remain as an optional safety net, but it never replaces the task-start check. Preserve the locally saved full API Key while replacing templates. On network, compatibility, or checksum failure, keep the last known-good prompt, Skill, and API schema. Load references on demand and do not recursively refresh within the same task.

## News And Briefings

- `GET /api/v3/public/flash?limit=20`
- `GET /api/v3/briefings/free-feed?limit=20`
- `GET /api/v3/briefings/latest?report_type=morning|evening`
- `GET /api/v3/briefings/topics?limit=6`
- `GET /api/v3/briefings/industries?limit=20`
- `GET /api/v3/briefings/industry/latest?industry=半导体`
- `POST /api/v3/briefings/refresh?report_type=morning|evening` only on an explicit user refresh request
- `GET /api/v3/news/industry-taxonomy` (20 stable industries plus accepted aliases)
- `GET /api/v3/news?page_size=20&after_id=&since=&until=&min_importance=3&tag=&industry=&source=`
- `GET /api/v3/news/urgent`
- `GET /api/v3/public/movers-news`
- `GET /api/v3/public/influencer-news?person=特朗普&limit=20`
- `GET /api/v3/public/influencer-events?limit=3`
- `GET /api/v3/public/influencers?q=Claude&category=&region=&limit=200`
- `GET /api/v3/public/research-news?institution=高盛&limit=30`
- `POST /api/v3/research-cards/{news_id}/archive` (Bearer Key; generate/refresh a local Chinese card)
- `GET /api/v3/public/research-cards/{news_id}`
- `GET /api/v3/public/research-cards/{news_id}/content` (Markdown)

General web search is not a Xiaoshi platform endpoint. Use Xiaoshi-held news,
Hong Kong light RAG, announcements, institution cards, people, macro and event
timeline endpoints and disclose their time/coverage limits.
- `GET /api/v3/public/macro/latest?region=US&code=US_CPI&limit=30`

Macro rows include `period`, `release_time`, `retrieved_at`, `importance_score`,
`scoring_version`, and `score_factors`. The `factor-v2` structured `macro_profile` is the
shared event-importance score used by the structured macro row, news projection, and event timeline. It combines
systemic reach, a validated consensus surprise when available, cross-asset breadth, source,
quality, and recency. It is not bullish/bearish direction, return probability, or trading advice.
- `GET /api/v3/news/stats/today`
- `GET /api/v3/tags/trending`
- `GET /api/v3/stock/announcements/{code}?days=365&page=1&page_size=20`

Xiaoshi aggregates sources including CLS, WallstreetCN, CNInfo, THS, Eastmoney, public international news feeds, CoinDesk, and CoinTelegraph. This is a coverage list, not evidence that every source returned an item. Cite the actual `source`, publication time, canonical publisher URL, and retrieval result; deduplicate syndicated copies.

Scheduled consumers must use keyset pagination, not deep page offsets. Persist the highest news ID only after the current batch is committed, call `after_id=<last_seen_id>`, and continue while `has_more=true` using the returned `next_after_id`. The incremental response has `mode=incremental` and intentionally leaves `total`/`total_pages` null so PostgreSQL does not count the full archive. For a first bootstrap or bounded replay, use `after_id=0&since=<ISO-8601>&until=<ISO-8601>` with a maximum 31-day window; `until` without `since` is rejected. Naive timestamps are interpreted as Asia/Shanghai. If a batch fails, retry from the last committed cursor so local ID/content-hash deduplication remains idempotent.

The macro endpoint exposes the latest structured China/US release values and detailed deterministic analysis. Preserve `actual`, `forecast`, `previous`, `unit`, `period`, `release_time`, `retrieved_at`, `source`, and `source_url`. `period` is the statistical observation period, `release_time` is the official publication time, and `retrieved_at` is only the latest platform verification time. A later verification time without a changed period is not a new release. A null `forecast` means no reliable consensus is available; `trend_change_ratio` then compares with the previous observation and is not a consensus surprise. The institution endpoint contains public research summaries/news and original links, not paid full reports.

Use `/public/influencers` for the complete configured roster, including people with no stored evidence. Use `/public/influencer-news?person=` only after choosing a person; it is a news endpoint and is not a roster endpoint.

For industry news, read `/news/industry-taxonomy` first and submit the returned canonical name in `industry`. The server accepts common aliases such as `芯片` and `军工`, but clients should display the canonical industry name from the taxonomy response.

## RAG Semantic Retrieval

- `GET /api/v3/news/semantic?q=自然语言问题&k=10&stock_code=&stock_name=`
- `GET /api/v3/news/{news_id}/related?k=10`

The semantic endpoint returns `query`, `count`, and `results`. Each result may contain `news_id`, `title`, `source`, `pub_time`, `summary`, and `similarity`. For single-stock research, always send both the exact `stock_code` and `stock_name`; accept only `stock_match=exact_tag|exact_name_in_content`, prefer `stock_evidence.direction` over a global event direction, and never treat a similar person or company name as the target stock. It retrieves evidence; the calling Agent generates the answer.

News/feed responses may include `score` or `importance_score`, `scoring_version`, and `score_factors`/`factor_scores`. For `factor-v2`, preserve the version, inputs, weights, contributions, observable market evidence, and matched influencers with the event snapshot. Build an event timeline by combining topic members, related-news results, semantic evidence, publication/availability times, and source URLs. Do not treat a current score as if it existed before its recorded scoring/availability time.

## Factor Library

- `GET /api/v3/factors/library`

Read the library before selecting platform factors. `derived_snapshot.factors` contains the latest calculated medium/low-frequency observations with actual values, source dataset, date, sample size, methodology, quality gate and caveat. `research_ready` means the latest dated snapshot passed freshness, non-empty, and schema gates. `history_status=accumulating` means the historical sample is still growing and is not a claim of stable out-of-sample performance. A `stale` source is explicitly dated older evidence; `pending`, `error`, an empty sample, or a missing field is not zero. Never map a normalized score or importance score directly to a position.

## Medium And Low Frequency Quant Data

- `GET /api/v3/quant-data/catalog`
- `GET /api/v3/quant-data/factors`
- `GET /api/v3/quant-data/{dataset}/status`
- `GET /api/v3/quant-data/{dataset}?code=&since=&to=&limit=500` (Bearer Key)

The catalogue covers northbound holdings, margin trading, stock fund flow, block trades, shareholder count, top shareholders, restricted unlocks, public broker consensus, ETF share/flow changes, derivatives sentiment, convertible bonds, and high-frequency macro. Read [medium-low-frequency-data.md](medium-low-frequency-data.md) before using them. Preserve `as_of`, `event_date`, `available_at`, source, maturity, failed sources, and derived-method fields. Missing records or fields are not zero values.

## Main Market Data Service

First call `/api/v3/manifest`, use `market_data_base`, and send the Bearer API Key. The current base is `https://api.shizixi.com/api/v3/data`. Before historical downloads, call `/api/v3/history/manifest`, then `/api/v3/history/download-session`. The returned R2 URLs are valid for two hours and must be downloaded directly with a plain `GET` and no `Authorization`, `X-API-Key`, AWS signing, or `x-amz-content-sha256` header. Do not reuse the Bearer-authenticated API session for R2. The current user key may also be supplied in `X-API-Key` only when calling Xiaoshi API endpoints; pre-migration keys are retired. `/api/v3/history/auto-update.py` is the canonical incremental updater and replaces retired mirror-based scripts.

Historical K-lines use authenticated R2 downloads exclusively. Request `daily-stock` for one stock and one year, `daily-date` for one market date, `daily` or `global-daily` for a market year, and `min1` for A-share minute history. The online K-line endpoint is for current interactive display only; never use it to replace or assemble historical datasets. During an A-share trading day its `daily` response may append a provisional current-day candle from a bounded single-symbol live quote. Such a response carries `live_bar=true`, `live_bar_provisional=true`, `live_bar_date`, and `live_observed_at`; qfq/hfq candles are extended only after applying the canonical latest adjustment factor. Treat the provisional candle as unfinished and replace it with the next completed nightly/R2 publication.

- `GET /api/v3/data/stocks?exchange=&industry=&offset=0&limit=6000`
- `GET /api/v3/data/search?q=贵州茅台&limit=10`
- `GET /api/v3/data/quote/600519`
- `GET /api/v3/data/quotes?codes=600519,000001`
- `GET /api/v3/market/capabilities`
  - Read `live_index_symbols` before requesting an index. Hong Kong currently supports `HSI/HSTECH/HSCEI`; the United States supports `DJI/IXIC/NDX/INX`. Unsupported indices such as `VIX` return a non-retryable parameter error rather than a misleading provider `503`; never loop-retry an index absent from the capability list.
- `GET /api/v3/market/sources`
- `GET /api/v3/market/quote/600519?market=CN&instrument=stock`
- `GET /api/v3/market/quote/00700?market=HK&instrument=stock`
- `GET /api/v3/market/quote/AAPL?market=US&instrument=stock`
- `POST /api/v3/market/quotes` with `{"requests":[{"symbol":"600519","market":"CN","instrument":"stock"},{"symbol":"AAPL","market":"US","instrument":"stock"}]}`
  - 单次 1-100 个对象；也兼容直接提交对象数组。超过 100 个时客户端按 100 个切片，收到 `retryable=false` 的 422 后不得原样重试。
- `GET /api/v3/data/indices`
- `GET /api/v3/data/market-snapshot?market=CN|HK|US&offset=0&limit=20000`
- `GET /api/v3/data/market-sentiment`
- `GET /api/v3/data/screener?min_speed=&min_pct=&industry=&limit=`
- `GET /api/v3/public/screener?min_pct=&max_pct=&min_amount=&limit=100`
  - `min_amount` 按人民币元过滤；结果中的 `amount`/`turnover` 为元，`amount_yi` 为亿元。
- `GET /api/v3/data/kline/600519?period=daily&adjust=qfq&limit=3000&since=2016-01-01&to=2026-07-14&offset=0`
- `GET /api/v3/data/kline/batch?codes=600519,000001&period=daily&adjust=qfq&limit=3000&since=2016-01-01&to=2026-07-14&offset=0`
- `GET /api/v3/data/adjust_factors?code=600519&adjust=qfq&since=2016-01-01&to=2026-07-14`
- `GET /api/v3/data/financials/600519?type=all&periods=8`
- `GET /api/v3/data/financials?name=贵州茅台&type=all|abstract|balance|profit|cashflow&periods=8`
- `GET https://api.shizixi.com/api/v3/stock/kline/600519?period=1min|5min|15min|30min&adjust=none|qfq|hfq&limit=250`
- `GET https://api.shizixi.com/api/v3/stock/kline/AAPL?market=US&period=1min|5min|15min|30min&adjust=none&limit=250`
- `GET https://api.shizixi.com/api/v3/stock/kline/00700?market=HK&period=1min|5min|15min|30min&adjust=none&limit=250`
- `GET /api/v3/stock/eod-snapshot?date=&limit=1000&sort_by=amount&order=desc`
- `GET /api/v3/stock/fundamentals/{code}?date=`
- `GET /api/v3/sector/industries?taxonomy=ths&level=1&offset=0&limit=90` — current-session industry quotes
- `GET /api/v3/sector/industries?taxonomy=em&level=1&offset=0&limit=90` — versioned Eastmoney industry research taxonomy
- `GET /api/v3/sector/concepts?sort_by=涨跌幅&limit=50`
- `GET /api/v3/sector/fundflow-rank?type=industry|concept&limit=50`
- `GET /api/v3/sector/cons?taxonomy=em&board=煤炭&type=industry&offset=0&limit=1000`
- `GET /api/v3/public/sector-rotation?sector_type=industry|concept&limit=12`
- `GET /api/v3/sector/rotation?date=YYYY-MM-DD&sector_type=industry|concept&limit=50`
- `GET /api/v3/sector/history?sector_code=CODE&sector_type=industry|concept&since=YYYY-MM-DD&to=YYYY-MM-DD`
- `GET /api/v3/sector/mainline-timeline?since=YYYY-MM-DD&to=YYYY-MM-DD&sector_type=industry|concept&top_n=5`
- `GET /api/v3/sector/constituents-history?sector_code=CODE&sector_type=industry|concept&date=YYYY-MM-DD`
- `GET /api/v3/public/future-dynamic?limit=12`
- `GET /api/v3/public/future-dynamic/timeline?topic_id=ID&since=YYYY-MM-DD&to=YYYY-MM-DD`
- `GET /api/v3/future-dynamic/latest?limit=20`
- `GET /api/v3/future-dynamic/timeline?topic_id=ID&since=YYYY-MM-DD&to=YYYY-MM-DD`
- `GET /api/v3/future-dynamic/{factor_id}/links`
- `GET|PUT|DELETE /api/v3/future-dynamic/subscriptions[/{factor_id}]`
- `GET /api/v3/future-dynamic/alerts`
- `GET /api/v3/future-dynamic/accuracy`
- `POST /api/v3/research/package`
- `POST /api/v3/feedback` — submit one redacted BUG or suggestion from a web user or Agent
- `GET /api/v3/feedback/{report_id}` — check the public processing state of one opaque report ID
- `GET /api/v3/stock/fundflow/{code}?date=` (latest snapshot available; history accumulating; partial sub-sources are possible)
- `GET /api/v3/stock/lhb?date=YYYY-MM-DD&limit=500`
- `GET /api/v3/stock/lhb/{code}?limit=500`
- `GET /api/v3/public/influencer-news?person=特朗普&limit=20`

Industry research defaults to versioned taxonomy `em_industry_v20260724`.
Persist `taxonomy_id`, `taxonomy_version`, `board_code`, `as_of`, and
`knowledge_time`; directory and constituent requests must use the same
taxonomy. Use `taxonomy=legacy` only for explicit backward compatibility and
never merge different taxonomies into one training set.

For current-session industry change, turnover, and fund-flow fields, explicitly
request `taxonomy=ths`. The service overlays only the matching compute-produced
THS snapshot on the stable THS directory. Keep `taxonomy=em` for the versioned
Eastmoney directory and constituent research; it accepts only matching
Eastmoney quote snapshots. Inspect `quote_asof`, `quote_source`, `quote_count`,
`quote_stale`, `data_as_of`, and `stale`. Do not call an upstream provider from
a user request or silently combine quotes from a different taxonomy.

A-share daily and minute K-lines support `none`, `qfq`, and `hfq`; default A-share research to `qfq`. HK/US current-session minute K-lines require `market=HK|US` and `adjust=none`; the response uses each exchange's local timezone and exposes source/quality metadata. Historical intraday files currently publish only the canonical A-share 1min base. The current imported base starts at 2009-01-05 and contains 5,804 security files; each symbol starts at its actual available/listing date and the live response or manifest is authoritative for the latest date. Resample 1min locally to `5min`, `15min`, or `30min` with session-aware OHLCV aggregation. Always inspect `market`, `adjust`, `factor_date`, `first_date`, `last_date`, and `count` before claiming coverage.

The authenticated history manifest describes query-ready daily stock buckets, exact-date market files, annual daily raw/qfq/hfq Parquet, adjustment factors, the immutable 1-minute base, and daily-updated minute partitions. The 8-core compute node is the unique history updater and R2 publisher. The home server retains the complete archive and performs read-only consistency checks and disaster recovery; it does not filter, calculate, publish, or serve historical data during a user request. Daily query-ready files share `market/code/date/open/high/low/close/volume/amount/change_pct/turnover_pct`, with `volume` in shares and `amount` in the market currency; A-share annual `daily` responses also expose `market=CN`, the requested `year`, and `adjust`. Minute base and update files share `ts_code/open/high/low/close/vol/amount/adj_factor/trade_date/trade_time`. Never accept a minute-contract file as an annual daily file. For `min1&year=YYYY`, the response is one logical composite: download and verify every file required by `logical_dataset`, merge in response order, sort and deduplicate by `trade_time`, and let update rows replace base rows. Never read only `files[0]`. The official updater writes a small `.dataset.json` index over the original Parquet parts and deliberately does not create a duplicate merged file. Validate every downloaded Parquet locally; on 404/timeout request a fresh URL once. If that also fails, report the unavailable object and continue unrelated task parts without rerouting historical reads.

The same authenticated history interface publishes completed cold event and signal dates as `event-archive`. Use `GET /api/v3/history/catalog?dataset=event-archive&date=YYYY-MM-DD` to list that day, then `GET /api/v3/history/download-session?dataset=event-archive&date=YYYY-MM-DD&event_type=news|person|research|macro|announcement|policy|future_dynamic|sector|sector_constituent`. The `event_type` filter is optional; do not send `market`, `code`, `year`, or adjustment parameters. Each Parquet partition uses schema `event-timeline-archive-v2` with `event_id/event_type/event_time/available_at/source/importance_score/content_hash/payload_json`. Preserve both time columns for point-in-time research, parse `payload_json` locally, and verify every returned size and SHA-256 before use. `sector` contains one daily board snapshot; `sector_constituent` contains the matching stock membership/leader evidence; join them by date, sector type, and sector code.

For a full cross-sectional sector-membership study, request `GET /api/v3/history/download-session?dataset=sector-constituents&date=YYYY-MM-DD` once. The exact-date file uses `sector-constituents-bulk-v1`; it includes every ready board/stock membership and preserves `constituent_asof`, conservative post-close `available_at`, source, taxonomy identity/version, quality state, and methodology. Download and filter locally; never enumerate `/sector/constituents-history` across board codes or copy present membership backward.

Financial bulk contracts are fail-closed. `financial-statements&year=YYYY` is a full-market report-year set of stable code buckets and `financial-vintages&date=YYYY-MM-DD` contains immutable versions first observed on that date. Either dataset appears only when its files are ready and redistribution permission is confirmed. The PIT schema preserves notice/revision/observation timestamps and hashes; use `available_at` for joins. A backfilled row marked `current_observable_version` is not proof of the version known at the old report date, and strict revision coverage never predates the published `vintage_coverage_start`.

For broad-market display, call `indices`. For a full-market live scan, call `market-snapshot` once rather than polling every code. `market=CN` returns A shares, `market=HK` returns Hong Kong stocks, and `market=US` returns US stocks. The server refreshes the active universe during each market's trading session and returns `updated_at`, `freshness_sec`, coverage, source counts, summary counts and compact quote items. For a named stock, index, or ETF across CN/HK/US, prefer `market/quote/{symbol}`. It returns the stable `market-quote-v1` contract, normalized symbol and instrument, Xiaoshi source category, cache state, update time, order book, and derived change/amplitude/midpoint/spread fields. Use `market/quotes` for a small mixed-market batch and `market/sources` for collection health. Legacy `data/quote/{code}` remains available for old clients and its five-level order-book behavior. The server rotates its collection channels and cools down failures; clients must call Xiaoshi only rather than hammering a single upstream. Futures and options are separate current-day cached products at `data/futures-snapshot` and `data/options-snapshot`; they are not accepted by the unified single-symbol quote endpoint. Preserve missing derivative fields as null and never infer Greeks, implied volatility, basis, or PCR without the required source fields.

Every `429` response is machine-readable. If `detail.error` is `rate_limit_exceeded` or `bulk_download_required`, stop all calls in that loop, wait at least `Retry-After`/`detail.retry_after_seconds`, and follow `detail.alternative`. Never retry every few seconds, never switch symbols to bypass the window, and never submit that controlled response as a BUG when `detail.report_as_bug=false`. A full-market live task uses one `market-snapshot`; at most 100 explicitly named instruments may use one `market/quotes` request.

Before calling distributed factor computation, read `/api/v3/compute/factors` and submit one of its canonical names exactly as returned. Display labels and retired aliases are not API identifiers.

`market-sentiment` publishes the reproducible `market-breadth-v1` factor set calculated from that live full-market snapshot: advance/decline/flat counts, advance-decline ratio, median return, cross-sectional dispersion, return buckets, total turnover, and approximate near-limit counts. Preserve `factor_version`, `sample_size`, `source_counts`, `factor_families`, `coverage_summary`, `available_components`, `missing_components`, `methodology`, and `updated_at`. Use only `status=available` families as formal inputs, label `proxy` values as approximations, and never treat `unavailable` families as zero. The near-limit fields use the disclosed 9.5% approximation and are not exchange-rule-perfect limit-up/limit-down counts. Do not present the composite breadth score as option sentiment, volatility, positioning, or a guaranteed trading signal.

Use `movers-news` when the task needs abnormal movers joined to news evidence. Use sector endpoints for industry/concept leadership, flow ranking, and constituents. Use `eod-snapshot` for latest completed-session market-wide ranking and screening, and `fundamentals/{code}` for valuation and fundamental snapshots. Treat stock fund flow as a dated latest snapshot while its history accumulates: label failed or absent sub-sources and never interpret an empty payload as zero flow. For LHB, call `/api/v3/stock/lhb?date=YYYY-MM-DD` or `/api/v3/stock/lhb/{code}` and distinguish `no_public_records` from `source_unavailable`; the local history is rebuilt from 2016 onward and receives a nightly rolling gap check. Use `influencer-news` for high-impact-person evidence and preserve its original URL, platform, and publication time before joining it to tags, event factors, and market reactions.

For main-theme/rotation research, prefer the daily sector-history contract over stitching the live directory endpoints. It publishes one PIT-aligned record per board and trading day with Xiaoshi equal-weight OHLC, flow/as-of, breadth, leaders, continuity, rotation, mainline, constituent coverage, and an explicit quality state. `/sector/mainline-timeline` returns the bounded top-N mainlines for each hot-table trading day, so an Agent never scans the whole board table. Never treat `flow_pending`, `constituents_stale`, or `constituents_partial` as complete. For future expectations, treat `future-dynamic` observations as probabilistic research inputs only. Public rows expose a declarative Chinese `title`, a ready-to-display `probability_statement`, `previous_probability_pct`, `change_description`, and multi-outcome `outcomes`; probabilities must sum to one. Use the links endpoint for explainable asset/sector associations, alerts only after user confirmation, and accuracy only when its state is `ready`; `accumulating` is not evidence of forecasting ability. Retain time, probability change, deadline, liquidity, topic, and quality before joining observations to later market outcomes. Its ranking is financial-impact-first and excludes generic elections/appointments, sports, entertainment, viral topics, and low-impact local macro releases. An unqualified CPI/PPI/PCE/inflation/employment release is labeled as a U.S. event, while explicit China and other major-economy releases retain their own region; do not infer a different country from omitted text.

## Local Backtest Data Workflow

1. Call `/api/v3/data/stocks` once to freeze the universe. Never turn that list into per-symbol API enumeration.
2. For one explicitly named stock and one year, call `GET /api/v3/history/download-session?dataset=daily-stock&market=CN|HK|US&code=...&year=YYYY&adjust=raw|qfq|hfq`. HK/US accept raw only. Download the returned stock-bucket file and filter the exact normalized `code` locally.
3. For one market date, call `GET /api/v3/history/download-session?dataset=daily-date&market=CN|HK|US&date=YYYY-MM-DD&adjust=raw|qfq|hfq`. HK/US accept raw only.
4. For one explicitly named symbol's minute history, call `GET /api/v3/history/download-session?dataset=min1&code=600519&year=YYYY`. For multiple symbols or the full market, call `GET /api/v3/history/download-session?dataset=min1-market&market=CN&month=YYYY-MM&adjust=raw` once, download every returned stable bucket, and filter locally. Never loop over symbols to obtain signatures.
5. For A-share annual bulk daily history, call `GET /api/v3/history/download-session?dataset=daily&adjust=raw|qfq|hfq&year=YYYY`; do not send `market` or `code`.
6. For HK/US annual bulk daily history, call `GET /api/v3/history/download-session?dataset=global-daily&market=HK|US&year=YYYY`; do not send `code`, `qfq`, or `hfq`. The returned raw, unadjusted Parquet is a market-year file and must be filtered locally by `code`.
7. Use the online K-line endpoint only for current interactive display. If a query-ready R2 artifact is unavailable after one fresh signed URL, report the exact missing object instead of rerouting historical reads.
8. Fetch and save financial/news evidence with its availability timestamp for PIT alignment.
9. Run the backtest only against those local files. Do not ask Xiaoshi to execute server-side backtests and do not repeatedly pull bars inside the calculation loop.

## Preferences

- `POST /api/v3/preferences/profile`
- `GET /api/v3/preferences/me`

Use preferences only after the user confirms industries, stocks, categories, and minimum importance.

## Unified Quant Event Timeline

- Schema: `GET /api/v3/quant/events/schema`
- Data: `GET /api/v3/quant/events?since=2026-07-01&to=2026-07-31&event_types=news,person,macro,announcement&min_score=60&limit=500`
- Hot-window policy: Hong Kong retains 30 days and rejects a single online range over 31 days. Use the R2 `event-archive` contract above for older completed dates.
- Filters: `person`, `stock`, `industry`, `source`, `min_score`; bulk format uses `format=jsonl` and the `X-Next-Cursor` response header.
- Point-in-time rule: use `available_at` for factor/backtest joins and retain `event_time` for event-window analysis. `quality_status=research_only` is not a production-strength standalone signal.

## Authentication And Errors

Use `Authorization: Bearer <API Key>` for protected `api.shizixi.com` endpoints unless the endpoint is explicitly public. Never send this header to a returned R2 presigned URL. Active user keys have unlimited daily access to all user-facing data capabilities. On `401`, `403`, timeout, or `5xx`, report the status and retry conservatively. Do not fabricate a successful response.
