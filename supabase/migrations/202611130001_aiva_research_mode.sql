create table if not exists public.aiva_research_observations (
  id uuid primary key default gen_random_uuid(),
  source_analysis_id uuid not null unique,
  symbol text not null,
  direction text not null check (direction in ('BUY', 'SELL')),
  source_decision text not null check (source_decision in ('BUY', 'SELL', 'NO_TRADE')),
  blocking_reasons jsonb not null default '[]'::jsonb,
  candidate_probability numeric,
  confidence numeric,
  entry_bid numeric not null,
  entry_ask numeric not null,
  entry_spread numeric not null,
  entry_quote_at timestamptz not null,
  entry_provider_timestamp timestamptz,
  entry_quote_source text,
  execution_assumptions jsonb not null,
  outcome_5m jsonb,
  outcome_15m jsonb,
  outcome_30m jsonb,
  outcome_60m jsonb,
  evaluated_5m_at timestamptz,
  evaluated_15m_at timestamptz,
  evaluated_30m_at timestamptz,
  evaluated_60m_at timestamptz,
  status text not null default 'OPEN' check (status in ('OPEN', 'CLOSED')),
  created_at timestamptz not null default now()
);

create index if not exists aiva_research_observations_symbol_created_idx
  on public.aiva_research_observations (symbol, created_at desc);
create index if not exists aiva_research_observations_open_idx
  on public.aiva_research_observations (symbol, created_at)
  where status = 'OPEN';

alter table public.aiva_research_observations enable row level security;
revoke all on table public.aiva_research_observations from anon, authenticated;
grant select, insert, update, delete on table public.aiva_research_observations to service_role;
