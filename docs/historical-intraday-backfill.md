# AIVA historical intraday backfill

## Purpose

The daily XAUUSD history (2016 onward) is useful for long-horizon regime context, but it is not a substitute for intraday Bid/Ask candles. This importer adds a resumable, chunked Dukascopy backfill for M5 and M1.

## Safe activation

1. Apply `supabase/migrations/202611130003_aiva_history_import_state.sql` to the AIVA Supabase project.
2. Confirm the table `public.aiva_history_import_state` exists.
3. Set `DUKASCOPY_M5_BACKFILL_ENABLED=true` in the Railway service variables.
4. Keep `DUKASCOPY_M5_BACKFILL_START_DATE=2016-01-01`.
5. Deploy only after reviewing and merging this change. The existing M5 importer runs one seven-day chunk per cycle (default every two minutes), so a multi-year backfill is deliberately gradual.
6. Monitor the worker logs and the state row. The cursor advances only after both Bid/Ask data are fetched and all matched rows are upserted. Empty market weeks still advance the cursor, avoiding a permanent stall.
7. When the cursor reaches the earliest candle already present, the importer switches to normal incremental updates.

M1 backfill remains disabled. Enable it separately only after M5 data quality, storage growth, provider limits, and processing capacity have been reviewed.

## Data integrity

- Bid and Ask candles must share the exact timestamp.
- Negative or invalid spreads are discarded.
- Existing candles are upserted on `symbol,timeframe,candle_at`, making retries idempotent.
- The state cursor is not advanced when provider requests or database writes fail.
- Backfill does not change strategy eligibility, paper-trading decisions, risk limits, or execution settings.

## Important limitations

Dukascopy availability and history completeness must be verified during import. A ten-year request does not guarantee ten years of usable XAUUSD M5 data. Weekends, market closures, feed gaps, and instrument-history boundaries are expected and must be measured before backtests.
