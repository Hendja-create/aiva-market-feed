# AIVA Market Feed

Persistent Node.js worker subscribing to Live-Rates through Socket.IO and storing the latest XAUUSD quote in Supabase.

## Environment variables

- `LIVE_RATES_API_KEY`: Live-Rates provider key. Required only when real-time quotes are enabled; omit it on historical-only workers to disable the Live-Rates socket and watchdog.
- `SUPABASE_URL`: Supabase project URL.
- `SUPABASE_SERVICE_ROLE_KEY`: privileged server-only key. Never expose it in frontend code, logs, or Git.
- `LIVE_RATES_SOCKET_HOST`: defaults to `eu-wss.live-rates.com`.
- `SYMBOLS`: comma-separated symbols, defaults to `XAUUSD`.
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
