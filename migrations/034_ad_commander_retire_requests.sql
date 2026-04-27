-- Ad Commander retire/hold/promote request tracking
-- Shared between operator-1 (UI) and operator-2 (API endpoints)

create table if not exists public.ad_commander_retire_requests (
    id uuid primary key default gen_random_uuid(),
    creative_id uuid not null references public.ads_creatives(id),
    ads_account_id uuid not null references public.ads_accounts(id),
    requested_action text not null check (requested_action in ('retire', 'hold', 'promote')),
    cpa_at_request numeric,
    champion_baseline_cpa numeric,
    days_live integer,
    spend numeric,
    conversions integer,
    requested_by text,
    confirmed_at timestamptz,
    confirmed_by text,
    auto_confirmed boolean default false,
    status text not null default 'pending' check (status in ('pending', 'confirmed', 'overridden', 'rejected')),
    hold_until timestamptz,
    created_at timestamptz default now(),
    updated_at timestamptz default now()
);

-- Index for lookups by creative and account
create index if not exists idx_retire_requests_creative on public.ad_commander_retire_requests(creative_id);
create index if not exists idx_retire_requests_account on public.ad_commander_retire_requests(ads_account_id);
