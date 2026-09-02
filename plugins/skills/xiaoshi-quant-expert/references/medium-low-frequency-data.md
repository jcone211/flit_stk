# Medium And Low Frequency Research Data

These datasets are free research inputs collected from public sources. They are not guaranteed trading signals. Read `GET /api/v3/factors/library` first for the latest derived snapshot, then use the quant-data endpoints for stock-level evidence and historical validation. A `stale` snapshot is dated older evidence, not a current value and not zero.

## Endpoints

- Catalogue: `GET /api/v3/quant-data/catalog`
- Factor mapping: `GET /api/v3/quant-data/factors`
- Records: `GET /api/v3/quant-data/{dataset}?code=&since=&to=&limit=500`
- Freshness: `GET /api/v3/quant-data/{dataset}/status`
- Latest explainable derived values: `GET /api/v3/factors/library` -> `derived_snapshot.factors`
- Individual stock fund flow remains at `GET /api/v3/stock/fundflow/{code}`.

Authenticated record requests use the same Bearer API Key as the rest of Xiaoshi. Catalogue and freshness are public. There is no daily quota.

## Dataset Catalogue

| Dataset | Research use | Important fields | Current boundary |
|---|---|---|---|
| `northbound_holdings` | foreign holding change and crowding | holding shares/value/ratio/change | official individual holdings are quarterly from 2024-08-19, not a daily-flow signal |
| `margin_trading` | leverage and crowded-long sentiment | financing balance/buy, lending balance, total | exchange publication lag applies |
| `stock_fundflow` | order-size flow evidence | main/large/medium/small net inflow | latest dated snapshot available; history accumulating; partial sources possible |
| `block_trades` | institutional transfer and discount/premium | price, amount, premium rate, buyer/seller | business departments are not always final beneficial owners |
| `shareholder_count` | ownership concentration | count, change, average holding | disclosure date, not report period, controls availability |
| `top_shareholders` | major-holder position changes | shares, market value, change | quarterly and subject to publication lag; holding ratio stays null when the public source omits it |
| `restricted_unlock` | supply-event calendar | date, shares, value, ratio | estimated value changes with price |
| `broker_consensus` | public earnings expectation dispersion | report count, rating distribution, EPS forecasts | target price and revenue stay null without a continuous reliable source |
| `etf_flow` | sector allocation and subscription evidence | shares, share change, estimated subscription value, market flow | share-change estimate is separate from secondary-market order flow |
| `derivatives_sentiment` | volatility/positioning overlay | QVIX, PCR, open interest, basis | PCR/basis stay null unless components are complete |
| `convertible_bonds` | defensive/convexity screen | bond price, conversion value/premium, pure-bond value, issue size, credit rating | issue size is not current remaining size; keep remaining size null without a reliable source |
| `high_frequency_macro` | cycle and industry-nowcast evidence | electricity, freight, operating rate | operating rates stay null until continuous sources pass validation |

## Point-In-Time Contract

Every row carries `schema_version`, `as_of`, `event_date`, `available_at`, `source`, `source_url`, canonical fields, and `raw_json`. Use `available_at` for backtest joins. If a source only exposes a date, lag the observation to the next tradable session unless an earlier verified publication time is available.

Keep `failed_sources` from the status response. `pending`, `degraded`, `error`, an empty list, and a null field are different states and none of them means numeric zero.

## Published Derived Snapshot

| Factor id | Public calculation | Boundary |
|---|---|---|
| `northbound-position-change-v1` | quarterly holding change / absolute holdings | quarterly disclosure, never daily northbound flow |
| `margin-leverage-activity-v1` | financing buy / financing balance | activity, not directional conviction |
| `stock-main-flow-v1` | median stock main-flow ratio and positive breadth | public order-size classification is estimated |
| `block-trade-premium-v1` | amount-weighted block-trade premium | counterparties may not be final beneficial owners |
| `shareholder-concentration-v1` | median shareholder-count change | mixed reporting dates, medium/low frequency only |
| `top-shareholder-accumulation-v1` | share of covered companies with net top-holder accumulation | quarterly disclosed top holders only |
| `unlock-supply-30d-v1` | disclosed unlock market value in the next 30 days | planned supply is not actual selling |
| `broker-consensus-bias-v1` | positive public ratings / all public ratings | public research has a positive-rating bias |
| `etf-secondary-flow-v1` | main net flow / ETF turnover | not primary-market subscriptions/redemptions |
| `derivatives-positioning-v1` | source-scoped PCR, volatility and index-futures basis | components remain separate and missing values stay null |
| `convertible-valuation-v1` | median conversion premium | issue size is not remaining size |
| `high-frequency-activity-v1` | latest electricity growth and verified freight index | operating rate is excluded until validated |

The raw `value` is the published observation. `score` is an optional clipped research normalization for ranking; it is not a forecast, probability, or target position. Preserve `dataset`, `as_of`, `data_status`, `sample_size`, `methodology`, `quality_gate`, `caveat`, and `components` in any research artifact.

## Factor Construction Gate

1. Freeze universe and point-in-time snapshots.
2. Keep raw and derived fields separate; record the derivation method.
3. Check stock-date uniqueness, missingness, coverage, stale observations, outliers, source concentration, and corporate actions.
4. Fit winsorization, scaling, neutralization, and imputation on training data only.
5. Report daily cross-sectional IC/RankIC, monthly ICIR, quantile spread, turnover, decay, industry/size-neutral results, and chronological out-of-sample results.
6. Treat `research_ready` as permission to use the latest dated observation in research, not proof of stable history. If `history_status=accumulating`, keep it out of an established baseline until coverage, IC/RankIC, turnover, decay, neutrality and chronological out-of-sample gates pass. Never turn editorial importance or one raw flow number directly into a position weight.

Example research requests:

- Align the latest disclosed quarterly Northbound holdings change with daily margin balance and stock flow, then test whether the combination predicts next-month returns without forward-filling beyond its publication time.
- Screen future 90-day unlocks together with falling shareholder count and major-holder accumulation.
- Build an ETF share-change sector rotation signal and validate it against industry-neutral returns.
- Combine convertible-bond premium, liquidity, issue size, credit rating, and underlying-stock trend into a low-frequency candidate set; use remaining size only when independently verified.
