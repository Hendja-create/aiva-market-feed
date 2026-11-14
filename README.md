# AIVA Market Feed

Persistent Node.js worker subscribing to configured Live-Rates instruments through Socket.IO and storing quotes plus Dukascopy Bid/Ask history in Supabase.

## Environment variables

- `LIVE_RATES_API_KEY`: Live-Rates provider key. Required only when real-time quotes are enabled; omit it on historical-only workers to disable the Live-Rates socket and watchdog.
- `SUPABASE_URL`: Supabase project URL.
- `SUPABASE_SERVICE_ROLE_KEY`: privileged server-only key. Never expose it in frontend code, logs, or Git.
- `LIVE_RATES_SOCKET_HOST`: defaults to `eu-wss.live-rates.com`.
- `SYMBOLS`: comma-separated Live-Rates symbols, defaults to `XAUUSD`.
- `DUKASCOPY_INSTRUMENT_MAP`: optional JSON object mapping the app/provider symbols to Dukascopy instrument IDs. Built-in mappings: `XAUUSD=xauusd`, `US30=usa30idxusd`, `NAS100=usatechidxusd`, `SP500=usa500idxusd`, `GER40=deuidxeur`, `JP225=jpnidxjpy`. Other Forex symbols default to their lowercase symbol.
- `DUKASCOPY_M1_START_DATE` / `DUKASCOPY_M5_START_DATE`: optional initial import date per timeframe.
- `PORT`: health endpoint port, defaults to 3000.

## Supabase schema

Requires `public.market_quotes` with primary key `symbol` and columns `bid`, `ask`, `mid`, `spread`, `provider_timestamp`, `received_at`, `updated_at`, `source`, `connection_status` and `latency_ms`.

The worker validates provider prices and upserts only received quotes. It does not fabricate market data. Without `LIVE_RATES_API_KEY`, the Live-Rates socket and watchdog stay disabled while Dukascopy M1/M5 historical imports and the HTTP API continue to run. Health endpoint: `/health`.

## Deploy

Deploy this repository as a persistent Node.js/Docker service (Railway or another always-on host). Add the required secrets in the host's environment-variable settings, expose port 3000, then verify `/health` and the latest row in Supabase.

The Supabase service-role key bypasses RLS and has broad privileges. Keep it only in the worker's secret environment, never in browser code or Git. Rotate it if exposed.

## Local run

```bash
cp .env.example .env
npm install
npm start
```

## Multi-market historical imports

Add only symbols confirmed by your Live-Rates subscription to `SYMBOLS`, for example:

```env
SYMBOLS=XAUUSD,US30,NAS100,SP500,GER40,JP225
```

The worker keeps the app symbol (for example `US30`) in Supabase while resolving it to the corresponding Dukascopy instrument ID only for historical downloads. This keeps live quotes, candles, backtests and API requests on the same symbol key.

If your Live-Rates plan uses different aliases, keep the app symbols consistent and configure the Dukascopy mapping separately, for example:

```env
DUKASCOPY_INSTRUMENT_MAP={"US30":"usa30idxusd","NAS100":"usatechidxusd"}
```

M1 and M5 import locks and M1 retry windows are tracked per symbol, so one market's import or provider cooldown does not block the other configured markets. Historical import availability still depends on the instrument's published data range and Dukascopy's service response.
