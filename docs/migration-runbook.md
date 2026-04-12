# Unified Auth Phase 2 -- Migration Runbook

Sync existing KV USERS records into Supabase Auth and link them back.

## What the script does

1. Lists all `user:*` KV entries via the Cloudflare API.
2. Skips records that already have a `supabaseUid` (already migrated) or belong to internal domains (`eternium.ai`).
3. For each remaining user: creates a Supabase auth account (`email_confirm: true`; random password -- users log in via magic link or OAuth, never this password).
4. Upserts `public.profiles` with `tier`, `stripe_customer_id`, `api_key_hint`, `supabase_uid`.
5. Backfills `supabaseUid` onto the KV user record and writes a `uid:<uid>` index key for fast reverse lookup.
6. Saves a checkpoint to `/tmp/migrate-users-progress.json` after each successful user so partial runs can resume.

## Prerequisites

Run `migrations/029_profiles_auth_fields.sql` against the Supabase project first to add the required columns to `public.profiles`.

## Required env vars

```
CF_API_TOKEN=<cloudflare token with KV read+write>
CF_ACCOUNT_ID=<cloudflare account ID>
CF_KV_NAMESPACE_ID=60a2ff86e6fb45d7a4f7b34a9f7db6cf   # USERS namespace (from wrangler.toml)
SUPABASE_URL=https://wmahfjguvqvefgjpbcdc.supabase.co
SUPABASE_SERVICE_KEY=<service_role key>
```

## Dry-run (review before any writes)

```bash
CF_API_TOKEN=... CF_ACCOUNT_ID=... CF_KV_NAMESPACE_ID=... \
  SUPABASE_URL=... SUPABASE_SERVICE_KEY=... \
  node scripts/migrate-users-to-supabase.mjs
```

Inspect the output. Confirm user count, which would be created, which are already done.

## Live run

```bash
CF_API_TOKEN=... CF_ACCOUNT_ID=... CF_KV_NAMESPACE_ID=... \
  SUPABASE_URL=... SUPABASE_SERVICE_KEY=... \
  node scripts/migrate-users-to-supabase.mjs --apply
```

Rate is 5 users/sec by default. Override with `RATE_LIMIT_PER_SEC=2` for caution.

## Resuming after partial failure

The checkpoint at `/tmp/migrate-users-progress.json` tracks processed emails and created UIDs. Re-run with `--apply` -- already-processed users are skipped automatically.

## Rollback

If migration must be reverted:

1. Delete Supabase auth users created during the run. Their IDs are listed in the checkpoint `created` array:
   ```bash
   # For each uid in checkpoint.created[].uid:
   curl -X DELETE "${SUPABASE_URL}/auth/v1/admin/users/<uid>" \
     -H "Authorization: Bearer ${SUPABASE_SERVICE_KEY}" \
     -H "apikey: ${SUPABASE_SERVICE_KEY}"
   ```
2. Remove `supabaseUid` from KV user records (write back the original record without the field).
3. Remove `uid:*` KV index keys written by the migration.

The SQL migration (029) is additive -- columns can be dropped if needed via the rollback block at the bottom of that file.
