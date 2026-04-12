-- Migration 029: Add auth/billing fields to public.profiles for Unified Auth Phase 2
-- Run once against the Supabase project: wmahfjguvqvefgjpbcdc
-- Safe to run multiple times (all statements use IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).

-- Add tier (maps to KV user.tier)
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS tier TEXT NOT NULL DEFAULT 'free';

-- Add stripe_customer_id (maps to KV user.stripeCustomerId)
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;

-- Add api_key hint (first 12 chars of etrn_ key; NOT the full secret)
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS api_key_hint TEXT;

-- Add supabase_uid as inverse link (should equal auth.users.id = profiles.id, stored for clarity)
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS supabase_uid UUID;

-- Add updated_at trigger if not already present
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'set_profiles_updated_at'
      AND tgrelid = 'public.profiles'::regclass
  ) THEN
    CREATE OR REPLACE FUNCTION public.set_updated_at()
    RETURNS TRIGGER AS $fn$
    BEGIN
      NEW.updated_at = NOW();
      RETURN NEW;
    END;
    $fn$ LANGUAGE plpgsql;

    CREATE TRIGGER set_profiles_updated_at
      BEFORE UPDATE ON public.profiles
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
END
$$;

-- Index on tier for admin queries
CREATE INDEX IF NOT EXISTS profiles_tier_idx ON public.profiles (tier);

-- Index on stripe_customer_id for webhook lookups
CREATE INDEX IF NOT EXISTS profiles_stripe_customer_id_idx ON public.profiles (stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;

-- ── Rollback ────────────────────────────────────────────────────
-- ALTER TABLE public.profiles DROP COLUMN IF EXISTS tier;
-- ALTER TABLE public.profiles DROP COLUMN IF EXISTS stripe_customer_id;
-- ALTER TABLE public.profiles DROP COLUMN IF EXISTS api_key_hint;
-- ALTER TABLE public.profiles DROP COLUMN IF EXISTS supabase_uid;
-- DROP TRIGGER IF EXISTS set_profiles_updated_at ON public.profiles;
-- DROP INDEX IF EXISTS profiles_tier_idx;
-- DROP INDEX IF EXISTS profiles_stripe_customer_id_idx;
