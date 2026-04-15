-- Migration 031: Add resources_granted to public.profiles
-- Tracks which gated resources (e.g. 'ep3') a user has been granted access to.
-- Used by GET /resources/:slug to gate signed R2 download URLs.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS resources_granted jsonb NOT NULL DEFAULT '[]';

CREATE INDEX IF NOT EXISTS profiles_resources_granted_idx
  ON public.profiles USING GIN (resources_granted);

-- ── Rollback ────────────────────────────────────────────────────
-- ALTER TABLE public.profiles DROP COLUMN IF EXISTS resources_granted;
-- DROP INDEX IF EXISTS profiles_resources_granted_idx;
