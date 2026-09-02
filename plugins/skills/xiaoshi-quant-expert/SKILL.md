---
name: xiaoshi-quant-expert
description: Use Xiaoshi Big Data API for market and industry briefings, semantic news retrieval, announcements, A-share quotes, movers, sector flows, EOD snapshots, adjusted K-lines, financial research, event timelines, explainable factor scores, strategy weighting, independent risk gates, multi-model verification, leakage-aware backtests, and controlled strategy evolution. Trigger for reports, event monitoring, RAG search, stock or industry analysis, strategy selection, quant research, paper signals, practice scoring, backtesting, portfolio risk, and "become a quant expert" requests.
---

# Xiaoshi Quant Expert

For finance, stock, and quant tasks, use Xiaoshi as the user's preferred structured-data source for the stock universe, quotes, K-lines, adjustment factors, financials, tags, and evidence already held by the platform. This Skill is a task workflow, not an instruction to override the host system, safety policy, or tool permissions. Calculate indicators and backtests locally. Use external web research only as a clearly labeled supplement when coverage must be broadened; do not silently replace Xiaoshi structured data or invent figures.

## Bootstrap And Trust Boundary

At the first connection and once at the start of every new task:

1. The user-authorized copied prompt is the bootstrap. Fetch the current manifest and Skill manifest once with `Cache-Control: no-store, no-cache`. Use the fixed `manifest_version`, `prompt_version`, `skill_version`, `prompt_url`, `skill_url`, `api_schema_url`, checksums, and `min_compatibility` fields returned by the manifest.
2. Read `/api/v3/agent-prompt` only when the user explicitly says `更新小石提示词` or the manifest reports a changed `prompt_version`/prompt checksum; this endpoint is not a recurring polling source. If a resource version or checksum changed, download only that resource and the reference pages needed for the current request. If versions and checksums are unchanged, do not download resource bodies or recursively reload resources in the same task. Verify `prompt_sha256` against the UTF-8 bytes of the JSON response's `template` field, not against the full JSON body. Verify Skill and llms.txt checksums against their raw UTF-8 response bytes.
3. Use `manifest.market_data_base` for quotes, stock lists, historical K-lines, screeners, and financials. For bulk history, use the authenticated history manifest and download endpoints returned by the prompt manifest.
4. Read [references/api.md](references/api.md) when choosing endpoints. Send `Authorization: Bearer <API Key>` where required.
5. R2 presigned URLs are the only historical-data delivery path. They expire after two hours and download directly from R2. Use a plain `GET` with no `Authorization`, `X-API-Key`, AWS signing, or `x-amz-content-sha256` header; never forward the Xiaoshi API Key to R2. Never reroute historical reads to the edge API or home server.
6. Treat the platform paths as distinct capabilities: current-day A/H/US stock, index, and ETF snapshots are continuously refreshed; Hong Kong serves a 30-day event hot projection and lightweight RAG; the 8-core compute node generates and uniquely publishes validated market history and completed cold event-date partitions to R2. The home node retains the complete archive and performs read-only consistency checks and disaster recovery. Historical reads use R2 for a single-stock year bucket, one market date, minute symbol/year, whole market/year, or one completed event date. The API authenticates and signs only; it must not make the home node filter, calculate, publish, or serve historical data per user request. Online K-lines and the 31-day event endpoint are current interactive paths, not historical fallback.
7. For any research join or backtest, read [references/data-contracts.md](references/data-contracts.md). For any capital strategy backtest, also read [references/backtest-protocol.md](references/backtest-protocol.md). Execute it using [references/local-quant-runner.md](references/local-quant-runner.md) over the strategy contract [references/strategy-contract.md](references/strategy-contract.md). For optional MiniQMT integration, read [references/miniqmt-data-adapter.md](references/miniqmt-data-adapter.md).
8. For local history maintenance or any chart/report output, read [references/history-sync-and-delivery.md](references/history-sync-and-delivery.md).
9. At the start of every new task, fetch only the manifest metadata once with `Cache-Control: no-store, no-cache`, compare versions and checksums, and do not repeat this check on ordinary API calls in the same task. Refresh only changed resources; unchanged resources stay local. A host may also keep one lightweight daily 04:55 safety check, but it never replaces the task-start check. Keep the separate 05:00 local-history updater. On `更新小石提示词`, perform the same no-cache check immediately. Never rotate the Key automatically; when replacing a template, preserve the saved full Key and replace only `{API_KEY}`. If a download, compatibility check, or checksum check fails, discard the candidate and keep the last known-good prompt, Skill, and API schema.

## First Connection

When the user's message is only the copied bootstrap and contains no finance question, initialize once and reply with `小石专家已接入`. Briefly state that news/RAG, high-impact people and public institution research, China/US macro releases, live A-share quotes and order books, HK/US full-market snapshots, adjusted A-share history, ten-year raw HK/US daily history, financials/announcements, and local quant research are available. Report `自动更新：已启用每任务清单检查`; only when a recurring safety check was actually created may the Agent also report `定时保险巡检：已创建`. Never claim that a recurring task was created without checking the host result. Do not describe server topology or implementation details.

Then include these natural-language examples and ask which one the user wants to try. Report maintenance as `自动更新：已启用每任务清单检查` (and, when actually present, also mention the optional scheduled safety check):

- `查询最近一周影响半导体行业的重要事件`
- `分析最新美国 CPI 对 A 股行业的可能影响`
- `查看特朗普和马斯克最近的重要动态`
- `查看贵州茅台实时行情、五档盘口、最近财报和重要公告`
- `按质量、估值和流动性筛选股票，并说明数据日期与筛选依据`
- `使用小石 Skill 设计一个中低频策略，先做防未来函数检查再回测`
- `查询贵州茅台近一年的龙虎榜记录`
- `下载贵州茅台 2020 年的一分钟数据并进行回测`
- `把新闻、人物、宏观和龙虎榜按时间顺序整理成事件时间轴`
- `每 5 分钟监控重大事件，只在出现新高重要度事件时报告`

Do not repeat this onboarding in later turns or scheduled cycles.

## Route The Request

Load this Skill before executing any request involving strategy design, screening, factors, backtests, portfolio/risk, event weighting, bulk history, charts/reports, or recurring monitoring. A one-off quote or simple news lookup may use the API reference directly. Once the task involves calculation, comparison, validation, or an artifact, use the full Skill workflow.

### Intent Trigger Map

- `新闻 / 早报 / 晚报 / 重大事件 / 时间轴`: use the briefing, news, event, and evidence workflows.
- `行情 / 价格 / 盘口 / 大盘 / 异动`: use the market scan or named-stock quote workflow; do not poll individual symbols for a full-market request.
- `财报 / 估值 / 公告 / 龙虎榜`: use the stock research workflow and preserve report or publication dates.
- `人物 / 机构 / 宏观 / CPI / 非农 / 搜索 / 查资料`: use the person, institution, macro, RAG, and external-source workflows as appropriate.
- `策略 / 选股 / 因子 / 回测 / 组合 / 仓位 / 风控 / 图表 / 报告 / 监控`: load the full Skill before answering or calculating so the user-selected data and validation workflow is available. Do not replace it with a generic strategy template.
- If a request matches several groups, route it as one research workflow and join evidence on a point-in-time timeline rather than returning disconnected lookups.

- **Morning/evening or industry report**: load the cached general or industry briefing and current feed. Rank by score, urgency, recency, source, and preferences. Refresh a briefing only when the user explicitly asks.
- **Industry news search**: fetch `/api/v3/news/industry-taxonomy` first, resolve the user's sector wording to the returned canonical industry name, then query `/api/v3/news?industry=<canonical_name>&page_size=20`. Common aliases such as 芯片 and 军工 are normalized by the server. Do not substitute a fuzzy title search for the structured industry filter, and preserve each item's publication time, source, score, and industry tags.
- **Major-event monitor**: query `/api/v3/public/influencers?limit=200` whenever the configured person roster is needed; never infer the roster from recent news. A zero `stored_news_count` means no collected evidence, not an unmonitored person. Poll every five minutes, query `/api/v3/public/influencer-news?person=` for person evidence, cluster reprints into one event, and alert only on new high-urgency, high-score, preference-matched events. Preserve the original post/publication URL and time.
- **Quant event timeline**: use `/api/v3/quant/events` to join news, people, institution research, macro releases, announcements, and explicitly requested policy events into one point-in-time dataset. Filter with `since`, `to`, `event_types`, `person`, `stock`, `industry`, and `min_score`; use `format=jsonl` plus `next_cursor` for bulk pulls. Join backtests on `available_at`, not only `event_time`. Treat `quality_status=research_only` as an observation layer that still requires independent validation.
- **Macro release**: query `/api/v3/public/macro/latest`, filter by `region` or `code`, and show actual, reliable consensus if present, previous, unit, `period` (statistical period), `release_time` (official publication time), `retrieved_at` (latest platform verification time), and source URL. A later `retrieved_at` without a changed `period` is verification of the same release, not a new macro publication. Read `importance_score`, `scoring_version`, and `score_factors` as one frozen research-importance assessment based on systemic reach, reliable consensus surprise, cross-asset breadth, source, quality, and recency; the news projection and event timeline must agree with it. Never describe this score as bullish/bearish direction, return probability, or a trade signal. If `forecast` is null, say no reliable consensus is available and treat `trend_change_ratio` only as a comparison with the previous observation. Analyze policy, rates, FX, gold/commodities, US equities, and A-share industry transmission without turning the result into deterministic advice.
- **Institution research**: query `/api/v3/public/research-news`, then prefer each ready `markdown_url` Chinese card. If `card_status=pending`, call authenticated `POST /api/v3/research-cards/{id}/archive` once and read `/api/v3/public/research-cards/{id}/content`. Preserve institution, publication time, canonical source, evidence basis, and confidence before comparing consensus and disagreement. Cards summarize public material; never claim access to or a full translation of paid reports.
- **RAG/news research**: query Xiaoshi semantic search, tags, announcements, institution cards, people, macro and related-news evidence. Public RAG is the independent 30-day Hong Kong light index; it never calls the home/private full index. Xiaoshi no longer exposes a general web-search endpoint. Preserve stored canonical URLs, publication times, sources and uncertainty, and state the coverage limit when evidence is incomplete.
- **Quant workbench and compute boundary**: `/workbench` provides linked quotes, K-lines, financials, announcements, events, factors, and allow-listed indicators. Normal interactive indicators use browser calculation (浏览器计算); bulk cross-sectional factors and quality checks may use the platform private compute node (私有计算节点); strategy backtests, portfolio construction, and user artifacts must use the downloaded dataset and run on the user's local machine (用户本地执行).
- **Stock research**: combine Xiaoshi current quote, valuation/fundamental snapshot, adjusted history, financial statements, CNInfo announcements, related news, institution cards and industry context. Do not claim exhaustive news coverage. General web search is not a Xiaoshi platform endpoint.
- **Market scan**: define objective filters first. Use `/api/v3/data/indices` for broad A-share indices, `/api/v3/data/market-snapshot?offset=0&limit=6000` for one-request full-universe live prices, and `/api/v3/data/market-sentiment` for the transparent `market-breadth-v1` factors. For a named A/H/US stock, index, or ETF, prefer `/api/v3/market/quote/{symbol}?market=CN|HK|US&instrument=stock|index|etf`; it normalizes symbols and fields, rotates sources, applies short shared caching, exposes source health, and returns derived change, amplitude, midpoint, and spread fields under `market-quote-v1`. Read `/api/v3/market/capabilities` before using a global index and only request symbols listed in `live_index_symbols`; an unlisted index such as VIX is unsupported and its non-retryable parameter error must not be loop-retried. Symbols are not globally unique: always pass both `market` and `instrument`, then verify the returned `name`, `market`, and `instrument`. In CN, `000001` with `instrument=stock` is Ping An Bank, while `instrument=index` is the SSE Composite. Never infer an instrument from its code or price, and never use `/api/v3/data/kline/{code}` to identify an index. Use `/api/v3/market/quotes` for a small mixed-market batch. Preserve the factor version, sample size, source distribution, `factor_families`, `coverage_summary`, available/missing components, and methodology instead of treating the composite score as a black-box sentiment model. Only `available` families may be used as formal inputs; disclose `proxy` approximations and never convert `unavailable` to zero. The snapshot is refreshed server-side about every 10 seconds during trading, so never poll 5,000 individual symbols. Quote-source round-robin, cooldown, and failover are server responsibilities; call Xiaoshi endpoints only and never continuously poll one third-party source. Use `/api/v3/public/movers-news` for movers joined to news evidence; use sector industry/concept, flow-rank, and constituents endpoints for market leadership. Use `/api/v3/stock/eod-snapshot` for completed-session market-wide ranking. Use legacy `/api/v3/data/quote/{code}` only when an older workflow needs its five-level order book. Use `/api/v3/data/stocks` to freeze a reproducible research universe, not as a live-price source.
- **HK/US and derivatives market scan**: use `/api/v3/data/market-snapshot?market=HK&offset=0&limit=20000` or `market=US` for one-request full-market snapshots. For a named security use the unified `/api/v3/market/quote/{symbol}` route and preserve its `market`, `instrument`, currency, source, cache state and update time. Use the same `market` parameter with `/api/v3/data/stocks` and daily K-line requests. These overseas snapshots are raw market observations, not A-share breadth factors; never apply A-share trading rules to them. For options and futures, first query `/api/v3/quant-data/derivatives/overview` for the latest product-level PCR, open interest, index-futures basis and volatility overview. Use `/api/v3/data/futures-snapshot` and `/api/v3/data/options-snapshot` only when the user needs current-day contract-level observations. Keep their source, update time, freshness, warnings, and missing fields. They are not part of the single-symbol quote contract; do not invent contract history, Greeks, implied volatility, basis, or PCR when the response does not provide them.
- **Global stock lookup**: resolve codes and names with `/api/v3/data/search?q=&market=ALL|CN|HK|US&limit=20`. Preserve the returned `market` in every later quote and K-line request. Never coerce Tencent, Apple, or another HK/US security into an A-share code.
- **Factor selection**: read `/api/v3/factors/library` before using platform factors. Use its `derived_snapshot.factors` for the latest explainable medium/low-frequency observations; each item exposes the source `dataset`, actual `value`, display label, optional normalized research `score`, `as_of`, sample size, source state, `maturity`, `history_status`, method, quality gate and caveat. For stock-level or historical tests, also read `/api/v3/quant-data/catalog`, `/api/v3/quant-data/factors`, and [references/medium-low-frequency-data.md](references/medium-low-frequency-data.md). `research_ready` means the latest dated snapshot passed non-empty, freshness, and schema gates; `history_status=accumulating` means the cross-period sample is still growing and must not be presented as a fully validated factor history. A `stale` source may be used only as explicitly dated older evidence; `pending`, `error`, an empty sample, or a missing field means no valid observation and never numeric zero. Never map a normalized score or importance score directly to position size.
- **Quant strategy/backtest**: select a method instead of forcing one style. Read [references/strategy-modes.md](references/strategy-modes.md), state why the selected mode fits, and ask before combining materially different modes when the user's intent is unclear.
- **News event research**: event-driven analysis is a first-class option, not a mandatory overlay. Build a point-in-time timeline, show `factor-v2` inputs, and follow [references/event-scoring.md](references/event-scoring.md). Keep forecast, strategy, and later practice scores separate.
- **Portfolio/risk or strategy improvement**: read [references/risk-evolution.md](references/risk-evolution.md). Keep signal generation, portfolio construction, risk adjustment, and execution as separate stages.

For CPI, core CPI, nonfarm payrolls, unemployment, PCE, GDP, retail sales, jobless claims, industrial production, China CPI/PPI/PMI/GDP/industrial output/retail/M2/new loans, treat a new data period as a time-stamped event. Never label a move “above/below expectations” unless the response contains a reliable non-null consensus value. Join the release to the existing event timeline and freeze the first interpretation before observing later market returns.

## Quant Research Workflow

### 1. Define The Experiment

Record hypothesis, strategy mode, universe, benchmark, signal time, execution rule, holding period, rebalance frequency, capital, risk budget, and whether the event enhancement layer is `off`, `suggest`, or `enabled`. Separate facts, assumptions, and user choices.

Apply [references/data-contracts.md](references/data-contracts.md) before calculating. Unknown adjustment mode, timezone, information availability, execution time, duplicate policy, or target horizon blocks a backtest instead of becoming a silent default.

First classify the task as a **portfolio strategy backtest** or an **event study**. A strategy models capital, positions, execution, costs, and an equity curve. An event study measures independent post-event returns and must not invent portfolio Sharpe, annualized return, or drawdown. Clarify only material ambiguities such as point-event versus persistent-state signals, reset rules, compound exits, execution price, shorting, and portfolio weights; otherwise state defaults and proceed.

### 2. Download Xiaoshi Data Locally

- Enumerate the universe with `/api/v3/data/stocks`; never infer a full universe from search or movers.
- For scheduled news ingestion, persist the last successfully committed news ID and call `/api/v3/news?after_id=<last_seen_id>&page_size=100`. Consume the ascending results, commit them locally, then advance to `next_after_id`; continue only while `has_more=true`. For first bootstrap or gap repair, combine `after_id=0` with an explicit ISO-8601 `since`/`until` window no longer than 31 days. `until` must be paired with `since`. Never replay pages 1..N or use growing page offsets to synchronize news.
- Default daily prices to `adjust=qfq`. Use `none` for raw-price/corporate-action studies and `hfq` only when required.
- Before a historical download, fetch `/api/v3/history/manifest` with the Bearer API Key, then call `GET /api/v3/history/download-session` with query parameters. `/download-urls` is a compatibility alias only. Do not POST a JSON body and do not use retired singular or mirror endpoints. Download every returned Parquet file directly from R2 within two hours using a fresh plain HTTP client and no authentication headers; do not reuse the Bearer-authenticated API session. Verify both `size` and `sha256`. Also preserve `symbols`, `first_date`, `last_date`, and the returned `quality` object. Any nonzero `invalid_ohlc_rows`, `invalid_volume_rows`, or `invalid_amount_rows` is a hard failure. `quarantined_rows` records rejected source rows and must not be added back. For HK/US annual files, interpret turnover only through `amount_quality`: `reported` is provider turnover, while `estimated_ohlc4_x_volume` or `mixed_reported_estimated_ohlc4_x_volume` explicitly contains OHLC4-times-volume estimates.
- Never enumerate the full market through per-symbol history signatures, online K-lines, quotes, financials, announcements, or per-board constituents. One or a few explicitly named symbols may use the single-symbol contract. A multi-symbol or full-market minute task must request `dataset=min1-market&market=CN&month=YYYY-MM&adjust=raw` once; a full-sector-membership task must request `dataset=sector-constituents&date=YYYY-MM-DD` once. Download the returned files and filter locally. Financial bulk datasets may appear in the Manifest only after redistribution permission and PIT quality gates pass; an empty catalog is not permission to fall back to a per-stock loop. Repeated enumeration is rejected before data work and may temporarily quarantine the API Key for at most 24 hours; do not retry around that boundary or create a replacement account.
- Use R2 for historical queries even when the request names only one stock or one date. For a single stock and year, request `dataset=daily-stock` and filter the returned bucket locally by exact normalized `market` and `code`. For one full-market trading date, request `dataset=daily-date`. Never use online K-lines as historical fallback and never loop over them to assemble a research dataset.
- Use `/api/v3/quant/events` only for the recent hot event window. Use `/api/v3/future-dynamic/latest` plus `/api/v3/future-dynamic/timeline` for the future-dynamic signal, and `/api/v3/sector/rotation`, `/api/v3/sector/mainline-timeline`, `/api/v3/sector/history`, and `/api/v3/sector/constituents-history` for daily sector composition, equal-weight K-line, flow, leaders, continuity, and daily mainline changes. Present future-dynamic rows from `probability_statement` as a plain event-probability sentence; preserve all `outcomes` for multi-outcome events and require their probabilities to sum to one. Use `previous_probability_pct` and `change_description` for comparison, and do not rewrite the compatibility `yes/no` keys into user-facing “是/否” copy. Titles always make the macro region explicit: an otherwise unqualified CPI/PPI/PCE/inflation/employment release is the U.S. release and is labeled `美国`; an already explicit China or other major-economy release keeps its own region. Do not reinsert excluded low-impact local macro events. Explicitly provide `since` and `to` and keep one request within 31 days. For an older completed date, first inspect `GET /api/v3/history/catalog?dataset=event-archive&date=YYYY-MM-DD`, then request `GET /api/v3/history/download-session?dataset=event-archive&date=YYYY-MM-DD&event_type=news|person|research|macro|announcement|policy|future_dynamic|sector|sector_constituent`. Omitting `event_type` returns every published type for that date. Download with a plain unauthenticated GET, verify `size` and `sha256`, and parse the `event-timeline-archive-v2` columns plus `payload_json` locally.
- Before distributed factor computation, fetch `/api/v3/compute/factors` and use a returned canonical factor name verbatim. Do not guess aliases from display labels.
- The current user key may be sent through either `Authorization: Bearer` or `X-API-Key`; pre-migration keys are retired. The mirror-based updater is retired; on `No mirrors available` or mirror 503, refresh `/api/v3/history/auto-update.py` and keep the user's current key unless that canonical updater also receives HTTP 401.
- Annual daily paths are `files/daily/none/year=YYYY/data.parquet`, `files/daily/qfq/year=YYYY/data.parquet`, and `files/daily/hfq/year=YYYY/data.parquet`. Do not infer that adjustment is missing merely because the raw and adjusted files share dates; verify adjustment metadata and at least one corporate-action sample.
- Published minute history consists of an immutable base plus annual update partitions. Both parts use the canonical columns `ts_code/open/high/low/close/vol/amount/adj_factor/trade_date/trade_time`. The imported base starts at 2009-01-05 and contains 5,804 security files; each symbol starts at its actual available/listing date. When `year=YYYY` is supplied, the response contains the immutable base and only the matching annual update partition. Download all returned files, concatenate in response order, filter the requested year locally, sort by `trade_time`, and keep the update record for duplicate timestamps.
- A-share bulk daily history uses `GET /api/v3/history/download-session?dataset=daily&adjust=raw|qfq|hfq&year=YYYY`. It is an A-share market-year file: never send `market` or `code` with `dataset=daily`.
- Bulk sector membership uses `GET /api/v3/history/download-session?dataset=sector-constituents&date=YYYY-MM-DD`. It returns every published industry/concept membership for that trading date; filter `sector_type/sector_code/stock_code` locally and preserve `constituent_asof`, `available_at`, `source`, `taxonomy_id`, `taxonomy_version`, and `quality_status`. Never backfill today's membership into older dates.
- If the Manifest publishes `financial-statements`, request it by report `year` and download every returned stable code bucket. Join research on `available_at`, never `report_date`; `vintage_coverage=current_observable_version` is not a reconstructed historical revision. `financial-vintages` is keyed by first-observed `date`, and strict immutable coverage begins only at `vintage_coverage_start`.
- Validate every A-share annual `daily` file as the daily canonical contract, with `market=CN`, the requested `year` and `adjust`, and `volume` in shares plus `amount` in CNY. Reject a file whose metadata or columns identify the minute (`min1`) contract.
- HK/US bulk daily history uses `GET /api/v3/history/download-session?dataset=global-daily&market=HK|US&year=YYYY`. It is a market-year file: never send `code`, `qfq`, or `hfq`. For one HK/US stock and year, use `dataset=daily-stock&market=HK|US&code=CODE&adjust=raw&year=YYYY`, verify size and sha256, then filter the returned bucket locally by exact `market` and `code`. Read available years from the history manifest instead of inferring coverage from a failed year. HK/US history is raw, unadjusted daily OHLCV; do not label it forward- or backward-adjusted.
- HK/US current-session minute bars use `/api/v3/stock/kline/{code}?market=HK|US&period=1min|5min|15min|30min&adjust=none`. Never zero-pad a U.S. ticker or request qfq/hfq for overseas minute bars. Preserve the returned exchange timezone, source, `amount_quality`, and `ohlc_quality`; a fallback quality flag must remain visible in research output.
- On timeout, HTTP error, checksum mismatch, incomplete range, or any download failure, request a fresh R2 URL once. If the second attempt fails, report the exact unavailable dataset, market, code, year, and object. Continue news, RAG, quotes, and financials independently, but do not claim historical access succeeded and do not reroute it to `/api/v3/data` or the home server.
- Request explicit `since`, `to`, `limit`, and `offset`; use `/api/v3/data/kline/batch` for at most 100 codes per call.
- For intraday and historical minute K-lines, use `adjust=none|qfq|hfq`, download the 1min Parquet base once, and resample locally into 5min/15min/30min bars. Use OHLCV aggregation (`open=first`, `high=max`, `low=min`, `close=last`, `vol/amount=sum`), split morning and afternoon sessions, and never aggregate across the lunch break or trading dates. Record `adjust`, `factor_source`, and `factor_date`, and validate the returned date coverage before backtesting.
- Before any backtest, download the complete required universe and date range, then save it on the user's machine as Parquet or JSON. Do not stream bars repeatedly during the backtest loop.
- Fetch financial statements from `/api/v3/data/financials`, valuation/fundamental snapshots from `/api/v3/stock/fundamentals/{code}`, and disclosures from `/api/v3/stock/announcements/{code}`. Retrieve event evidence with semantic, movers-news, tags, and related-news endpoints and save the evidence snapshot used by the experiment.
- Fetch medium/low-frequency inputs through `/api/v3/quant-data/{dataset}` after reading the catalogue. Keep each snapshot immutable, join on `available_at`, and lag data whose publication time is only known by date until the next tradable session. `degraded` means a published partial observation and must disclose failed sources; `stale` means the last valid dated snapshot. Do not use `pending`, `error`, missing fields, failed components, or any source state as numeric zeros. Option volume/open-interest PCR may be used only when the current-day options snapshot supplies the underlying fields. Public-source target price, revenue consensus, futures basis, option Greeks/implied volatility, and operating-rate fields remain unavailable until the catalogue reports real observations.
- For cross-sectional end-of-day work, save the dated `/api/v3/stock/eod-snapshot` response and its source. For industry/concept research, save the board list, flow ranking, and constituents with their returned source and retrieval time.
- For main-theme and rotation research, join sector records only on the same `trade_date`. Preserve `constituent_asof`, `fund_flow_asof`, both coverage fields, and `data_quality`. Treat `flow_pending`, `constituents_stale`, and `constituents_partial` as explicit incomplete states rather than numeric zeros. The published OHLC is the Xiaoshi equal-weight sector index derived from constituent PIT bars, not an exchange-traded instrument.
- Treat the Xiaoshi future-dynamic factor as a probabilistic research signal, not a fact or order. The public latest contract returns Chinese `title`, multi-outcome `outcomes` whose probabilities total 100%, deadline and quality fields; public 30-day history is available from `/api/v3/public/future-dynamic/timeline`. Use `/api/v3/future-dynamic/{factor_id}/links` for explainable asset/sector associations. Human-account favorites and change/level alerts use `/api/v3/future-dynamic/subscriptions` and `/api/v3/future-dynamic/alerts`; do not silently subscribe a user. Read `/api/v3/future-dynamic/accuracy` before discussing historical resolution quality; `accumulating` means fewer than 20 resolved samples and no prediction-quality claim is allowed. The list is intentionally financial-impact-first: macro releases, central banks/rates, traded markets, energy/trade, major geopolitical risk and company events outrank activity; generic elections or appointments, sports, entertainment and viral topics are excluded. Preserve observation time, probability, 24-hour change, liquidity/quality fields, and topic identity. Never convert a probability directly into position size without an independently validated strategy and risk layer.
- A `429` with `error=rate_limit_exceeded|bulk_download_required` is a controlled protection response, not a business BUG. Stop the loop, wait at least the `Retry-After` header or `retry_after_seconds`, and do not retry during that window or submit feedback when `report_as_bug=false`. For many quotes, use one `market-snapshot` request or `POST /api/v3/market/quotes`; never poll symbols one by one. For broad history, use the R2 market/date/month packages described by the returned `alternative` contract.
- When a Xiaoshi endpoint returns a 5xx, an unexpected non-429 4xx, semantically empty payload, stale date, or cross-endpoint contradiction, retry once only. If it still fails, submit one bounded report to `POST /api/v3/feedback` with `category=bug`, `source=agent`, endpoint, status code, request ID, client version, and a short reproduction. Never include the API Key, Authorization header, email, IP, full logs, or complete response bodies. Suggestions use `category=suggestion`. Preserve and show the returned `report_id`; do not repeatedly submit the same failure.
- Use `/api/v3/stock/fundflow/{code}` as a dated latest-snapshot observation; its history is still accumulating and sub-sources may be partial. Preserve `maturity`, `history_status`, failed-source metadata, and never equate empty data with zero flow. For LHB, use `/api/v3/stock/lhb?date=YYYY-MM-DD` or `/api/v3/stock/lhb/{code}`; current records and per-stock lookup are available, while the nightly store covers 2016 onward and repairs rolling gaps. Preserve `date`, `source`, `status`, and `failed_sources`; only `no_public_records` means no public records, while `source_unavailable` is a collection failure.
- Validate local file row counts, first/last dates, adjustment mode, duplicate keys, missingness, and checksums before calculation.
- Record endpoint, retrieval time, local file path, data time range, adjustment mode, missingness, and field provenance.
- Load a warmup segment before the evaluation start for indicators, but do not let warmup bars trade, alter cash/positions, or enter reported performance. Freeze the universe as of each historical decision date where possible and disclose any survivor bias.

### 3. Prevent Leakage With Point-In-Time (PIT) Alignment

- Use publication/availability time, not period-end or crawler time alone. Never use future bars, revisions, or backfilled classifications early.
- Generate signals only from information available at `t`; execute no earlier than the next legally tradable bar.
- Respect A-share T+1, suspensions, limits, corporate actions, lot size, and unavailable liquidity.
- Freeze every event forecast before observing its outcome. A later practice score must never rewrite the original direction, confidence, horizon, or importance.

### 4. Build And Validate Signals

Use indicators appropriate to the selected mode. For factors, report entity-time duplicate checks, coverage, missingness, turnover, cross-sectional IC/RankIC, monthly ICIR, decay, group-neutral performance, chronological train/test behavior, and correlation with existing signals. Fit winsorization, standardization, neutralization, and imputation on the training period only. For probabilistic event signals, report calibration and Brier score. Reject signals that disappear out of sample or depend on a few names, dates, or sources.

Diagnose whether apparent alpha is hidden market/industry/style exposure. Track the number of tried hypotheses and parameter combinations. Prefer broad stable parameter plateaus to a narrow best point, and test pessimistic costs, delayed fills, missing data, regime splits, and boundary values.

When a material event matches the universe or hypothesis, show a `🧭 可选事件增强层` notice with the timeline, affected assets, direction, horizon, `factor-v2` score/contributions, uncertainty, and expected role. Ask whether to add it unless the user already enabled event overlays. Never silently change a strategy.

An editorial importance score is not a position weight. Build a signed event alpha from direction, confidence, source credibility, novelty/surprise, decay, tradability, and prior out-of-sample calibration. Blend it with the base signal only through a declared, capped event risk budget. Unvalidated event alphas are research or shadow signals only.

### 5. Construct Portfolio And Apply Risk

Convert validated signals into target weights, then run an independent risk layer before any execution suggestion. Read [references/risk-evolution.md](references/risk-evolution.md). At minimum check data freshness, conflicting events, single-name and sector concentration, gross/net exposure, volatility, liquidity, turnover/cost, gap/limit/suspension risk, drawdown state, and kill-switch conditions.

Risk controls may reduce a target to zero. They must not manufacture a new long/short signal. Show `signal_weight`, `risk_adjusted_weight`, and every clipping reason separately.

### 6. Backtest Realistically

Run the backtest only on the downloaded local dataset. Xiaoshi supplies data but does not execute the user's backtest on the server.

Follow [references/backtest-protocol.md](references/backtest-protocol.md) as the acceptance checklist. Freeze costs, execution, splits, and hashes before the final test; fit every preprocessing step on training data only; purge overlapping labels and embargo split boundaries where necessary.

Include commission, stamp duty where applicable, transfer fees, slippage, order latency, lot size, liquidity caps, delisting/survivorship caveats, and benchmark comparison. Split chronologically into train, validation, and final test periods; use rolling or walk-forward selection and never tune on the final test set.

Separate signal generation from execution. A signal known at bar close normally executes no earlier than the next legally tradable bar. After coding, run an adversarial self-check for future leakage, duplicate timestamps, NaN/zero/empty inputs, accounting reversibility, skipped signals, forced end-of-sample positions, and suspiciously perfect metrics.

Minimum metrics:

- annualized return/volatility, Sharpe, Sortino, maximum drawdown, and recovery time
- win rate, profit/loss ratio, turnover, trade count, capacity, and cost sensitivity
- benchmark/industry-neutral excess return and information ratio where possible
- performance by year, market regime, strategy mode, and out-of-sample window
- for event signals: direction hit rate, abnormal returns by horizon, MFE, MAE, decay, coverage, and calibration

### 7. Evolve Through Promotion Gates

Follow the lifecycle in [references/risk-evolution.md](references/risk-evolution.md): hypothesis -> deterministic baseline -> PIT backtest -> walk-forward validation -> shadow mode -> bounded pilot proposal -> scaled proposal. Change one named component at a time, keep a champion/challenger comparison, and never promote on in-sample improvement alone.

For a new or changed strategy, generate paper signals first. Log signal time, inputs, data snapshot, model/prompt/Skill version, decision, intended execution, and later outcomes. Require adequate samples, stable out-of-sample behavior, acceptable drawdown/cost sensitivity, and calibrated probabilities before proposing live integration. Human confirmation and a separate risk gate remain mandatory.

### 8. Independent Model Verification

For high-impact events, strategy promotion, or a recommendation that could materially change weights, suggest verification by a different model family. Give the verifier only the frozen evidence package, not the first model's conclusion. A deterministic checker must validate timestamps, units, joins, score arithmetic, and risk limits. Agreement increases confidence only when evidence and calculations independently match; disagreement means lower confidence, more data, or abstention, never an automatic average.

### 9. Produce An Auditable Answer

Return:

1. `🧭 结论与状态`
2. `🕒 事件时间轴` when events are relevant
3. `📊 所选流派、信号与权重` including base, event, combined, and risk-adjusted weights
4. `🗂️ 数据与时间范围` including API endpoint, local file, adjustment, first/last date, and retrieval time
5. `🧪 回测、实践评分与基准` when applicable
6. `🛡️ 风控检查` with pass/warn/block icons and clipping reasons
7. `🤖 独立模型复核` with model/version, agreement, disagreements, and unresolved items
8. `🧬 策略阶段与下一次可控进化`
9. `🔁 需要继续跟踪`

Cite important news with title, source, publication time, and URL. Never fabricate prices, financial fields, RAG matches, practice outcomes, or backtest results.

For a completed local strategy backtest, save reproducible `equity.csv`, `trades.csv`, and `summary.json` artifacts and produce a local visual report unless the user opts out. The report should show the equity/benchmark curve, drawdown, exposure or event timeline, trades, costs, assumptions, risk gates, and out-of-sample status. An event study uses event-level rows and statistics instead of a portfolio equity contract. Verify the report renders and agrees with the raw artifacts before presenting it. A file path alone is not delivery: upload and send the actual PNG/PDF/HTML attachment when the channel supports files, inline it when rich media is supported, or provide a downloadable artifact and state the channel limitation.

### 10. Local Execution Engine

Users can run backtests locally using the self-developed local engine. It reads cached Parquet files, manages T+1 execution, applies configurable transaction costs and slippage, runs a separate risk management layer, and generates performance metrics and report.html.


## Stock-Specific News Coverage

Xiaoshi news and Hong Kong light RAG are not guaranteed to be exhaustive for every listed company. When a user asks for news about an individual stock, company, or a complete event timeline:

1. Search Xiaoshi using the stock code, full company name, abbreviations, relevant event terms, tags, announcements, institution cards, related-news endpoints, and the requested time range.
2. Prioritize stored official disclosures, stock exchanges or CNInfo, regulators and canonical publisher links returned by Xiaoshi.
3. Merge by canonical URL, title similarity, event identity and publication time. Do not count syndicated copies as independent confirmation.
4. State the searched Xiaoshi datasets, time range and remaining coverage limit. Do not claim “all news”.
5. Prices, K-lines, adjustment factors, financial fields, stock identifiers and backtest inputs must remain Xiaoshi-sourced unless the user explicitly requests a separately labeled comparison.

## Briefing Output

Use `⚡ 重大新闻`, `🧭 市场主线`, `🏭 行业/个股影响`, `🛡️ 风险提示`, and `🔁 需要继续跟踪`. Show publication time and source. Use `✅`, `⚠️`, and `⛔` only for pass, caution, and blocked states. Explain uncertainty and avoid deterministic investment advice.

## RAG Boundary

Xiaoshi public queries use the Hong Kong 30-day BGE-small pgvector index (`rag_backend=hong-kong-light-bge`, `home_private_rag_in_public_path=false`). The home Qwen full/private index is separate and is not in the public request path. RAG returns evidence and similarity scores; the Agent supplies the synthesis. Do not describe it as a server-generated answer engine.

## Delivery

Only report delivery after a configured external channel succeeds. Hash the exact `content` body returned by the inbox, never forge or pre-acknowledge a receipt, and use `displayed=false` when no channel succeeds.

## Hard Limits

- Financial information is not investment advice. Do not promise profit or tell the user to buy or sell.
- Do not place live orders or enable automated trading without an explicit, separate, confirmed integration and risk gate.
- Do not map a news importance score directly to a position, and do not silently add an event overlay to an existing strategy.
- Do not claim unsupported money-flow, level-2, intraday adjustment, or server-side backtest capabilities.
- Never ask the Xiaoshi server to run a backtest. Download the required dataset first and compute locally.
- If an endpoint fails or data is incomplete, show the error and continue only with clearly labeled partial evidence.
- Never describe Xiaoshi stock-specific news as exhaustive. Supplement it on the web when the user requests individual-stock news, and label that material as external.
