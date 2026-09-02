# Data Contracts And Point-In-Time Rules

Use this contract before joining news, prices, financial statements, factors, or labels. A result is not reproducible until its timestamps, units, adjustment mode, availability rule, and missing-data policy are explicit.

## 1. Required Provenance

For every dataset record:

```text
dataset_name, endpoint, retrieval_time, source, source_record_id,
code, exchange, timezone, event_time, available_at, revision_time,
frequency, adjustment, currency, unit, schema_version, content_hash
```

- `event_time` is when the market or business event occurred.
- `available_at` is the first time the strategy could legally know the value. This controls PIT joins.
- `retrieval_time` is when the Agent downloaded it and never replaces `available_at`.
- `revision_time` identifies a later correction or restatement. Preserve the earlier vintage where possible.
- Use `Asia/Shanghai` for A-share trading calendars and retain the original timezone for overseas or macro releases.

## 2. Market Data Contract

- Normalize A-share codes to six digits and keep exchange as a separate field. Never infer exchange from a company name.
- Store OHLC prices, volume, amount, turnover, and quote time exactly as returned, then document each field's unit from endpoint metadata. Do not silently guess whether volume means shares or lots.
- Require `open <= max(high, close)` and `low <= min(open, close)` only when all fields are present and positive. Flag, do not silently repair, violations.
- Daily research defaults to `adjust=qfq`. Use `none` for corporate-action or raw-tradable-price studies and `hfq` for long-horizon return continuity only when the hypothesis requires it.
- Never mix `none`, `qfq`, and `hfq` in one return series. Record `factor_date` and adjustment-factor vintage. Intraday adjustment is unsupported unless the endpoint explicitly returns it.
- Keep market snapshot freshness, coverage, expected universe size, suspensions, and missing symbols. A stale or partial snapshot is a warning or block, not zero return.

## 3. Financial And Macro Contract

- Separate `report_period`, `announcement_time`, `available_at`, and `revision_time`. A fiscal period end is never the information-availability date.
- Join a statement to prices only from the first tradable bar after `available_at`. Apply the same lag rule to analyst, regulator, CPI, payroll, unemployment, central-bank, and other scheduled releases.
- Preserve original currency and units. Convert only with a timestamped FX source and show both original and converted values.
- Distinguish flow fields from point-in-time balance fields. Do not compare quarterly, year-to-date, annual, and trailing-twelve-month figures without an explicit transformation.
- Restatements create a new vintage. Historical research must use the vintage available at the decision date whenever obtainable; otherwise disclose revision bias.

## 4. News And Event Contract

- Preserve `published_at`, `first_seen_at`, translation/enrichment time, and `available_at`. A later Chinese translation cannot be backdated to the original English publication time.
- Cluster syndicated copies into one event. Source count is not independent confirmation unless ownership and reporting chains differ.
- Keep editorial importance, urgency, ex-ante signal, strategy contribution, and ex-post practice score as separate versioned fields.
- Entity and industry mappings available only after enrichment may affect signals no earlier than their recorded availability time.

## 5. Missingness And Joins

Classify missing values as `not_applicable`, `not_reported`, `source_unavailable`, `not_yet_available`, or `invalid`. Never turn missing values into zero unless zero is a documented economic value.

Before a join, report:

```text
left_rows, right_rows, matched_rows, unmatched_rows, duplicate_keys,
coverage_pct, earliest_available_at, latest_available_at
```

Use an as-of join on `available_at` for PIT features. Exact-date joins are allowed only when both datasets share the same market calendar and availability rule. Freeze universe membership at each decision date where possible; otherwise label survivorship bias.

## 6. Validation Gate

Block a backtest when any required item is unknown: adjustment mode, timezone, signal availability, execution timestamp, duplicate key policy, or target label horizon. Warn and continue only when the missing item cannot change the direction of the conclusion.

Save a machine-readable data manifest beside every experiment:

```json
{
  "dataset_hash": "sha256:...",
  "retrieved_at": "...",
  "range": ["...", "..."],
  "universe": "...",
  "adjustment": "qfq",
  "availability_rule": "next_tradable_bar_after_available_at",
  "missingness": {},
  "known_biases": []
}
```
