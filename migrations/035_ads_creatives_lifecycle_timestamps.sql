-- Add lifecycle timestamp columns to ads_creatives for retire/promote tracking

alter table public.ads_creatives
    add column if not exists retired_at timestamptz,
    add column if not exists promoted_at timestamptz;
