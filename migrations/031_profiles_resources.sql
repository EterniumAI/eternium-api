-- Migration 031: Add resource access + lead magnet tracking to public.profiles
-- Powers POST /resources/grant and GET /resources/ep3 access gate.
-- Safe to re-run (all ADD COLUMN IF NOT EXISTS).

-- Array of resource slugs the user has been granted (e.g. ['ep3'])
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS resources_granted jsonb NOT NULL DEFAULT '[]';

-- Lead magnet tag identifying which resource acquisition brought this user in
-- (e.g. 'ep3_ai_tech_stack'). Single value -- the primary attribution source.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS lead_magnet text;

-- Index for admin analytics: "how many users came in via ep3_ai_tech_stack?"
CREATE INDEX IF NOT EXISTS profiles_lead_magnet_idx ON public.profiles (lead_magnet)
  WHERE lead_magnet IS NOT NULL;

-- Index for access gate: "find users who have ep3 access"
-- Uses @> (jsonb contains) operator so GIN is the right index type.
CREATE INDEX IF NOT EXISTS profiles_resources_granted_gin_idx
  ON public.profiles USING gin (resources_granted);

-- ── Rollback ─────────────────────────────────────────────────────────────────
-- ALTER TABLE public.profiles DROP COLUMN IF EXISTS resources_granted;
-- ALTER TABLE public.profiles DROP COLUMN IF EXISTS lead_magnet;
-- DROP INDEX IF EXISTS profiles_lead_magnet_idx;
-- DROP INDEX IF EXISTS profiles_resources_granted_gin_idx;
