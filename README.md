# AIVA Market Feed

Persistent Node.js worker subscribing to Live-Rates through Socket.IO and storing the latest XAUUSD quote in Supabase.

## Environment variables

- `LIVE_RATES_API_KEY`: Live-Rates provider key.
- `SUPABASE_URL`: Supabase project URL.
- `SUPABASE_SERVICE_ROLE_KEY`: privileged server-only key. Never expose it in frontend code, logs, or Git.
- `LIVE_RATES_SOCKET_HOST`: defaults to `eu-wss.live-rates.com`.
- `SYMBOLS`: comma-separated symbols, defaults to `XAUUSD`.
- `PORT`: health endpoint port, defaults to 3000.
- `AIVA_MONTE_CARLO_WORKERS`: worker-thread count for Monte Carlo calculations, defaults to 2 (allowed: 1–8).
- `AIVA_MONTE_CARLO_MAX_QUEUE`: maximum waiting Monte Carlo analyses, defaults to 32 (allowed: 0–1000). When full, `/api/analysis` returns HTTP 503 with a retry hint.

## Supabase schema

Requires `public.market_quotes` with primary key `symbol` and columns `bid`, `ask`, `mid`, `spread`, `provider_timestamp`, `received_at`, `updated_at`, `source`, `connection_status` and `latency_ms`.

The worker validates provider prices and upserts only received quotes. It does not fabricate market data. Health endpoint: `/health`.

## Deploy

Deploy this repository as a persistent Node.js/Docker service (Railway or another always-on host). Add the required secrets in the host's environment-variable settings, expose port 3000, then verify `/health` and the latest row in Supabase.

The Supabase service-role key bypasses RLS and has broad privileges. Keep it only in the worker's secret environment, never in browser code or Git. Rotate it if exposed.

## Local run

```bash
cp .env.example .env
npm install
npm start
```
