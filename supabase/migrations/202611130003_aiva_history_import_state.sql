create table if not exists public.aiva_history_import_state (
  symbol text not null,
  timeframe text not null check (timeframe in ('M1', 'M5')),
  mode text not null check (mode in ('backfill', 'complete')),
  next_start timestamptz not null,
  target_before timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key (symbol, timeframe)
);

alter table public.aiva_history_import_state enable row level security;

comment on table public.aiva_history_import_state is
  'Server-side cursor for resumable historical Bid/Ask candle backfills. Service role only.';
