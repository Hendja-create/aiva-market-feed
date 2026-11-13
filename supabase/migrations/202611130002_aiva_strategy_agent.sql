create table if not exists public.aiva_strategy_agent_reports (
  id uuid primary key default gen_random_uuid(),
  symbol text not null,
  model text not null,
  report jsonb not null,
  evidence_summary jsonb not null,
  source_counts jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists aiva_strategy_agent_reports_symbol_created_idx
  on public.aiva_strategy_agent_reports (symbol, created_at desc);
alter table public.aiva_strategy_agent_reports enable row level security;
revoke all on table public.aiva_strategy_agent_reports from anon, authenticated;
grant select, insert on table public.aiva_strategy_agent_reports to service_role;
