# History Sync And Artifact Delivery

## Client And Dataset Boundary

Local history work uses the packaged `xiaoshi-data` client from `xiaoshi-agent-tools`
(`2026.9.13.3`), not ad-hoc scripts against retired endpoints. `xiaoshi-data` consumes the same
`xiaoshi_client` contract as `xiaoshi-mcp`: MCP plans, the CLI downloads, verifies and backtests.

Version gate: run `xiaoshi-data update check` first. Minimum `2026.9.13.1`, latest `2026.9.13.3`.
Apply or roll back only with the user's explicit approval of the exact target version
(`xiaoshi-data update apply --version <v> --approve <v>`); a failed candidate keeps the last verified
environment and never silently swaps the stable entry point.

## Recurring Incremental Check

When the Agent host supports scheduled jobs, create one daily job at `05:00 Asia/Shanghai`.

1. Read `GET /api/v3/history/manifest` with the user's current Key and keep the publication revision
   (`version`, `generated_at`, `quality_status`, `publication_gate`).
2. Request two-hour R2 links from `GET /api/v3/history/download-session` only for the files you need.
   `/api/v3/history/download-urls` is retired and returns `404 operation_not_in_public_contract`.
3. Compare the remote manifest with the local data manifest by partition, bytes, sha256, adjustment,
   year and latest trade date.
4. Download only missing or changed partitions into a temporary file with a plain `GET` and no
   `Authorization`, `X-API-Key`, AWS signing or `x-amz-content-sha256` header; never reuse the Xiaoshi
   API session for R2.
5. Verify bytes and sha256, then atomically replace the local file. `xiaoshi-data download` and
   `xiaoshi-data verify` already enforce this; prefer them over hand-rolled scripts.
6. Update the local manifest only after every selected file passes validation.
7. If an R2 link expires or fails, request a fresh link once. If the second attempt fails, report the
   exact dataset, market, code, year and object. Never re-route historical reads to a retired endpoint,
   a mirror, the home node or repeated online quote calls.

Do not redownload unchanged years. If the host cannot schedule jobs, run this check before every
backtest or historical study.

## Download Specs

Read the dataset's declared dimensions from the CLI spec table (mirrored in
[api.md](api.md#history-delivery-r2)) and send only those parameters; unexpected or missing dimensions
are rejected (`history_dimensions_missing_or_unexpected`, `unsupported_history_dataset`).

```text
xiaoshi-data download --dataset cn-daily --year 2020 --adjust qfq --data-dir ./xiaoshi_data
xiaoshi-data download --dataset global-daily --market HK --year 2020 --adjust raw --data-dir ./xiaoshi_data
xiaoshi-data download --dataset daily-stock --market CN --code 600519 --year 2020 --adjust qfq --data-dir ./xiaoshi_data
xiaoshi-data download --dataset daily-date --market CN --date 2026-09-15 --adjust raw --data-dir ./xiaoshi_data
xiaoshi-data download --dataset event-timeline --date 2026-09-01 --event-type announcement --data-dir ./xiaoshi_data
xiaoshi-data download --dataset financial-as-reported --date 2026-08-31 --as-of 2026-09-01T09:00:00+08:00 --code 600519 --data-dir ./xiaoshi_data
xiaoshi-data download --dataset sector-constituents --date 2026-09-15 --data-dir ./xiaoshi_data
xiaoshi-data verify --data-dir ./xiaoshi_data
```

- A-share daily is `cn-daily` (market-year, `year` + `adjust`); do not send `market` or `code`.
- `cn-minute` is keyed by `code`; derive 5/15/30-minute bars locally with OHLCV aggregation
  (`open=first`, `high=max`, `low=min`, `close=last`, `vol/amount=sum`), split morning and afternoon
  sessions, and never aggregate across the lunch break or across trading dates.
- `global-daily` is HK/US raw, unadjusted daily bars keyed by `market` + `year` + `adjust`; do not send
  `code`. Never apply A-share adjustment factors, calendars, price limits or lot rules to overseas rows.
- `event-timeline` is keyed by `date` with an optional `event_type`; join the archive on `available_at`.
- `financial-current` is keyed by `year` and `financial-as-reported` by `date` + `as_of`; both accept an
  optional `code`. Join fundamental research on `available_at`, never on `report_date`.
- Market CN is redundant for `cn-daily` and `adjustment-factors` and is removed by the client.

## Explicit Partial Coverage

If the user explicitly accepts newer data with gaps, inspect
`xiaoshi-data coverage --quality available`, download with `--quality available` into a separate
`--data-dir`, and read per-date accepted/expected counts and missing codes. The client refuses to mix an
available-quality directory with a complete one. Check `availability.watermarks` per
dataset/market/adjustment: available dates and complete dates differ, and newer raw daily data does not
advance qfq/hfq. Each download pins a manifest revision; use `--revision <manifest_version>` to
reproduce an earlier one. Never fill gaps synthetically.

## Adjustment Verification

Record `adjust`, source, first/last date, row count and checksum, and verify qfq/hfq with at least one
symbol/period containing a corporate action. Equal date coverage does not mean adjustment is absent.
Daily rows prefer `trade_date`; an all-empty compatibility `trade_time` is not missing data. Only rows
that are explicitly marked `no_turnover_observed` with four empty OHLC values and zero volume/amount may
keep empty prices; never fill prices or accept other anomalies.

## Chart And Report Delivery

Generating a file is only the build step.

1. Render and validate the chart against the source rows.
2. Save the reproducible data, `run_manifest.json` and report artifacts.
3. If the channel supports attachments, upload and send the actual PNG, PDF, HTML, CSV or ZIP.
4. If the channel supports inline media only, embed the rendered image and keep the data artifact.
5. If neither is supported, provide a downloadable artifact and state the limitation.
6. Claim "sent" only after the channel reports success; otherwise report the local path or upload
   failure honestly.

Record artifact name, mime type, bytes, sha256, channel, channel message ID when available, and
delivery time.
