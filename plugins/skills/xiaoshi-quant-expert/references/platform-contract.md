# Xiaoshi Public Agent Contract (verified snapshot)

Verified on 2026-09-16 against `https://api.shizixi.com` with a live `xs_live_*` user key and
`Cache-Control: no-store, no-cache`.

## 1. Publication Identity

| Item | Value |
|---|---|
| contract | `xiaoshi-agent-contract/v1` |
| platform_version | `2026-09-05.4` |
| prompt_version | `2026-09-06.1` |
| capabilities_sha256 | `318c40ac5384ff5db02c6db3f5ae9687c2acc2fa0906af6bc9372be653b599f2` |
| tool package | `xiaoshi-agent-tools` `2026.9.13.3` (sha256 `b0100b2d521e4a71e37abcf9e9c9ba0994731f48945bf621f9f78323e198d41d`) |
| minimum_client_version | `2026.9.13.1` |
| api_base | `https://api.shizixi.com` |

Discovery endpoints (all public, no Key required):

- `GET /api/v3/manifest` — contract version, capability hash, package URL, client lifecycle
- `GET /api/v3/capabilities` — the **only authoritative** capability catalog
- `GET /api/v3/bootstrap` — registration/login flows for interactive email OTP
- `GET /api/v3/status` — platform and scheduler freshness
- `GET /api/v3/tools/xiaoshi-agent-tools/manifest` — packaged-file sizes and hashes
- `GET /api/v3/tools/xiaoshi-agent-tools/package.zip?v=<version>` — the agent tool package

Verify the catalog yourself: re-hash the decoded `capabilities` body as UTF-8 JSON with sorted
keys and compact separators (`ensure_ascii=false`) and compare with `manifest.capabilities_sha256`.

## 2. Public Operations (complete list)

Reproduced from `capabilities.operations`. Anything absent from this list is not part of the
current public Agent contract.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v3/capabilities` | unique capability catalog |
| GET | `/api/v3/manifest` | contract version and capability hash |
| GET | `/api/v3/tools/xiaoshi-agent-tools/manifest` | agent tool package manifest |
| GET | `/api/v3/tools/xiaoshi-agent-tools/package.zip` | agent tool package download |
| GET | `/api/v3/status` | service and data freshness |
| GET | `/api/v3/meta/data-contract` | time, version and null semantics |
| GET | `/api/v3/bootstrap` | agent onboarding flow |
| POST | `/api/v3/auth/email/send-code` | send email code |
| POST | `/api/v3/auth/agent/register` | interactive agent registration |
| POST | `/api/v3/auth/email/verify` | code login |
| POST | `/api/v3/auth/register` `/login` `/password/forgot` `/password/reset` `/password/set` `/logout` | human account flows |
| GET | `/api/v3/auth/me` | web session identity |
| GET | `/api/v3/auth/api-key/check` | agent key check |
| POST | `/api/v3/auth/api-key/agent-prompt` | generate the personal bootstrap prompt (human session cookie only) |
| POST | `/api/v3/auth/api-key/regenerate` | rotate the agent key |
| GET | `/api/v3/account/overview` `/diagnostics` | permission/usage overview, error catalog (human session) |
| GET | `/api/v3/market/capabilities` | quote coverage, live index symbols, source health |
| GET | `/api/v3/market/quote/{symbol}` | single-instrument live quote |
| POST | `/api/v3/market/quotes` | bounded cross-market quote batch (1–100 instruments) |
| GET | `/api/v3/news/semantic` | bounded financial-evidence semantic search |
| GET | `/api/v3/quant/events/schema` | event field schema |
| GET | `/api/v3/quant/events` | PIT event timeline (all event types) |
| GET | `/api/v3/pit/catalog` | PIT data catalog |
| GET | `/api/v3/quant-data/catalog` | quantified-data catalog (incl. derived factors/strategy research) |
| GET | `/api/v3/quant-data/{dataset}/status` | dataset state and freshness |
| GET | `/api/v3/quant-data/{dataset}` | bounded dataset query |
| GET | `/api/v3/history/catalog` | versioned history file catalog |
| GET | `/api/v3/history/manifest` | versioned history file manifest |
| GET | `/api/v3/history/download-session` | two-hour R2 presigned download session |
| POST | `/api/v3/research/package` | local research task package planning |
| POST | `/api/v3/feedback`, GET `/api/v3/feedback/{report_id}` | bounded error/suggestion reports |

Groups map to MCP tools and CLI commands:

- discover: `get_platform_contract`, `get_platform_status`, `get_data_catalog`, `get_agent_workflow`
  / `capabilities status catalog schema coverage freshness`
- query: `get_live_quote`, `search_financial_news`, `get_event_timeline`, `query_dataset` / `query`
- deliver: `plan_history_download`, `prepare_local_research` /
  `download verify research-package validate-factor backtest`
## 3. Retired Paths (do not call, do not retry)

Every path below returned
`404 {"detail":{"error":"operation_not_in_public_contract","message":"该路径不属于当前公开 Agent 契约，请重新读取 /api/v3/capabilities。"}}`
in the 2026-09-16 verification. Retrying, falling back, or re-routing them is a contract violation,
not an outage.

| Retired path | Replaced by |
|---|---|
| `GET /api/v3/data/quotes` | `POST /api/v3/market/quotes` |
| `GET /api/v3/data/quote/{code}` | `GET /api/v3/market/quote/{symbol}?market=&instrument=` |
| `GET /api/v3/data/kline/{code}`, `/data/daily`, `/data/kline/batch` | no online replacement; use `history/download-session` (R2) and compute locally |
| `GET /api/v3/data/search` | no online replacement; resolve codes from local data or user input |
| `GET /api/v3/data/stocks`, `/api/v3/data/market-snapshot` | no public full-market snapshot; freeze a universe from a downloaded history file |
| `GET /api/v3/data/indices`, `/api/v3/data/market-sentiment` | `market/capabilities` (`live_index_symbols`) + `market/quote`; breadth factors live in `quant-data` |
| `GET /api/v3/data/financials` | `history/download-session?dataset=financial-current\|financial-as-reported` |
| `GET /api/v3/stock/fundamentals/{code}`, `/api/v3/stock/announcements/{code}` | `quant-data` datasets / `quant/events` (`event_types=announcement`) |
| `GET /api/v3/stock/fundflow/{code}` | `GET /api/v3/quant-data/stock_fundflow` |
| `GET /api/v3/stock/eod-snapshot`, `/api/v3/stock/lhb*` | no online replacement |
| `GET /api/v3/news`, `/api/v3/news/urgent`, `/api/v3/flash`, `/api/v3/news/industry-taxonomy` | `GET /api/v3/news/semantic?q=&k=`; structured/news projections via `quant/events` |
| `GET /api/v3/public/*` (flash, movers-news, influencers, influencer-news, research-news, macro/latest, research-cards, future-dynamic/timeline) | `GET /api/v3/quant/events` (`event_types=macro\|person\|research\|future_dynamic` …) |
| `GET /api/v3/future-dynamic/*`, `/api/v3/sector/*`, `/api/v3/briefings/*`, `/api/v3/factors/library`, `/api/v3/compute/factors` | `quant-data/catalog`, `quant-data/{dataset}`, `quant/events` |
| `GET/POST /api/v3/agent-prompt`, `/llms.txt`, `/skills/**`, `/api/v3/history/download-urls`, `/api/v3/history/auto-update.py` | `tools/xiaoshi-agent-tools/package.zip` (skills + CLI ship inside it) |

### Live checks performed

| Probe | Result |
|---|---|
| `POST /api/v3/market/quotes` `{"requests":[{"symbol":"600519"},{"symbol":"000001"}]}` | `200`, `count=2`, `market-quote-v1` items |
| `POST /api/v3/market/quotes` with `999999` + `600519` | `200`, `count=1`, `error_count=1`, valid symbol still returned |
| `POST /api/v3/market/quotes` with 101 requests | `400 requests must contain 1-100 instruments` |
| `GET /api/v3/market/quote/000001?market=CN&instrument=index` | `200`, 上证指数 |
| `POST /api/v3/market/quotes` (`00700`, market=HK) | `200`, 腾讯控股 |
| `GET /api/v3/news/semantic?q=<utf8>&k=2` | `200` (a non-UTF-8 query string returns `400`) |
| `GET /api/v3/quant/events?since=&to=` | `200`, `quant-event-v2`, `point_in_time=true` |
| `GET /api/v3/quant-data/catalog` `/history/catalog` `/history/manifest` `/pit/catalog` `/meta/data-contract` `/market/capabilities` `/status` | `200` |
| `GET /api/v3/account/overview` | `401 Invalid session token` (human web session required, not an agent Key) |
| `GET /api/v3/data/quotes`, `/data/kline/600519`, `/data/search`, `/data/stocks`, `/data/market-snapshot`, `/news`, `/public/flash`, `/public/macro/latest`, `/factors/library`, `/stock/eod-snapshot`, `/sector/rotation`, `/future-dynamic/latest`, `/history/auto-update.py`, `/llms.txt`, `/skills/xiaoshi-quant-expert/SKILL.md` | `404 operation_not_in_public_contract` (skills/llms.txt return plain `404 Not Found`) |

## 4. Null, Failure And Protection Semantics

- `capabilities.protections.missing`: empty, suspended, non-trading-day, accumulating and
  upstream-failure states are **not** zero.
- `capabilities.protections.rate_limit`: obey `Retry-After`; never loop. `Retry-After` is the
  minimum no-retry window, not an instruction to retry automatically.
- `capabilities.protections.bulk`: `bulk_download_required` must be handed to `xiaoshi-data`
  instead of online enumeration.
- `POST /api/v3/market/quotes` isolates per-instrument failures in `errors[]`; a single bad code no
  longer breaks the batch.
- Client lifecycle: install/upgrade/rollback require explicit user approval of the exact version;
  `upgrade_required=true` blocks further online queries until the local CLI is upgraded.
- verify: `verify_publication` / `update`