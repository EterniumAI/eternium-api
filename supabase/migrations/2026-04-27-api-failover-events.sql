create table if not exists public.api_failover_events (
    id bigint generated always as identity primary key,
    occurred_at timestamptz not null default now(),
    model text,
    kie_status int,
    fallback_provider text,
    success boolean,
    latency_ms int
);

create index if not exists idx_api_failover_events_occurred_at
    on public.api_failover_events (occurred_at desc);

create index if not exists idx_api_failover_events_model
    on public.api_failover_events (model, occurred_at desc);
