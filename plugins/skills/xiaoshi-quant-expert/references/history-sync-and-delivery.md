# History Sync And Artifact Delivery

## Daily 05:00 Incremental Check

When the Agent host supports scheduled jobs, create one daily job at `05:00 Asia/Shanghai`.

1. Fetch `/api/v3/history/manifest` with the user's current API Key.
2. Request two-hour R2 direct links from `/api/v3/history/download-urls` only for the required files.
3. Compare the remote manifest with the local data manifest by path, bytes, sha256, adjustment mode, year, and latest trade date.
4. Download only missing or changed partitions into a temporary file. Use a plain `GET` to the returned R2 URL with no `Authorization`, `X-API-Key`, AWS signing, or `x-amz-content-sha256` header; never reuse the Xiaoshi API session or forward the API Key to R2.
5. Verify bytes and sha256, then atomically replace the local file.
6. Update the local manifest only after every selected file passes validation.
7. If an R2 link expires or fails, request a fresh link once. If the second attempt fails, report the exact dataset, market, code, year, and object that is unavailable; never reroute historical reads to the edge API, home server, or repeated online K-line calls.

Do not redownload unchanged years. If the host cannot schedule jobs, run this check before every backtest or historical study.

Daily annual paths:

- `files/daily/none/year=YYYY/data.parquet`
- `files/daily/qfq/year=YYYY/data.parquet`
- `files/daily/hfq/year=YYYY/data.parquet`

For intraday research, download the required canonical 1-minute files once, save them locally, and verify `first_date`, `last_date`, and `count` before analysis. Derive 5/15/30-minute bars locally with OHLCV aggregation, separated by trading date and the A-share lunch break. Do not infer completeness from a single file; verify the requested symbol and date range against the manifest.

For A-share annual bulk daily research, request `dataset=daily`, one `year`, and `adjust=raw`, `qfq`, or `hfq`; do not send `market` or `code`.

For one stock and one year, request `dataset=daily-stock`, `market=CN|HK|US`, `code`, `year`, and the supported adjustment. The response has `scope=stock_bucket_year`. Download the small bucket file and filter the exact normalized `code` locally. Do not ask the home server to filter it during the request.

For one market date, request `dataset=daily-date`, `market=CN|HK|US`, `date=YYYY-MM-DD`, and the supported adjustment. The response has `scope=market_date` and is the direct R2 artifact for that date.

For HK or US annual bulk daily research, request `dataset=global-daily`, `market=HK` or `US`, and one `year` per call. Do not send `code`, `qfq`, or `hfq`. Each response has `scope=market_year` and identifies `market`, `year`, and `filter_columns`. The files cover approximately the latest ten years and contain raw, unadjusted daily bars. Verify every file, filter locally by `code`, combine by `market/code/date`, and never apply A-share adjustment factors, calendars, price limits, or lot rules to overseas records.

The 8-core compute node performs daily updates, materializes query-ready files, validates them, and is the only node that uploads and publishes them to R2. The home server retains the complete K-line archive and performs read-only consistency checks and disaster recovery. User reads do not perform request-time filtering or calculation on the home server. The API entry only authenticates and signs a two-hour R2 URL.

## Adjustment Verification

Record `adjust`, source, first/last date, row count, and checksum. Verify qfq/hfq with at least one symbol and period containing a corporate action. Equal date coverage does not mean adjustment is absent.

## Chart And Report Delivery

Generating a file is only the build step.

1. Render and validate the chart against the source rows.
2. Save the reproducible data and report artifacts.
3. If the channel supports attachments, upload and send the actual PNG, PDF, HTML, CSV, or ZIP.
4. If the channel supports inline media only, embed the rendered image and keep the data artifact available.
5. If neither is supported, provide a downloadable artifact and state the limitation.
6. Claim “sent” only after the channel reports success. Otherwise report the local path or upload failure honestly.

Record artifact name, mime type, bytes, sha256, channel, channel message ID when available, and delivery time.
