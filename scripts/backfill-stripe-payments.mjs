#!/usr/bin/env node
/**
 * backfill-stripe-payments.mjs
 *
 * One-shot sync: pulls historical Stripe PaymentIntents (succeeded) and
 * inserts them into Supabase stripe_payments table.
 *
 * Usage:
 *   STRIPE_SECRET_KEY=sk_live_... \
 *   SUPABASE_URL=https://xxx.supabase.co \
 *   SUPABASE_SERVICE_KEY=service_role_key \
 *   node scripts/backfill-stripe-payments.mjs
 *
 * Options (env vars):
 *   BACKFILL_LIMIT   — max PaymentIntents to fetch total (default: 5000)
 *   BACKFILL_CREATED_GTE — Unix timestamp, only sync PIs created after this
 *   DRY_RUN=true     — print rows, do not insert
 */

const STRIPE_SECRET_KEY  = process.env.STRIPE_SECRET_KEY;
const SUPABASE_URL        = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const DRY_RUN             = process.env.DRY_RUN === 'true';
const BACKFILL_LIMIT      = parseInt(process.env.BACKFILL_LIMIT || '5000', 10);
const BACKFILL_CREATED_GTE = process.env.BACKFILL_CREATED_GTE
  ? parseInt(process.env.BACKFILL_CREATED_GTE, 10)
  : null;

// Rate limit: stay well under Stripe's 100 req/s and Supabase's burst limit
const STRIPE_PAGE_SIZE = 100;  // max per Stripe list call
const INSERT_BATCH     = 50;   // rows per Supabase upsert
const SLEEP_MS         = 200;  // between Stripe pages

if (!STRIPE_SECRET_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing required env vars: STRIPE_SECRET_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchStripePayments() {
  const rows = [];
  let startingAfter = undefined;
  let fetched = 0;

  while (fetched < BACKFILL_LIMIT) {
    const params = new URLSearchParams({
      limit: String(Math.min(STRIPE_PAGE_SIZE, BACKFILL_LIMIT - fetched)),
      'expand[]': 'data.charges',
    });
    params.set('status', 'succeeded');
    if (startingAfter) params.set('starting_after', startingAfter);
    if (BACKFILL_CREATED_GTE) params.set('created[gte]', String(BACKFILL_CREATED_GTE));

    const res = await fetch(`https://api.stripe.com/v1/payment_intents?${params}`, {
      headers: {
        'Authorization': `Bearer ${STRIPE_SECRET_KEY}`,
        'Stripe-Version': '2024-04-10',
      },
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Stripe API error ${res.status}: ${err}`);
    }

    const page = await res.json();

    for (const pi of page.data) {
      const email = pi.receipt_email
        || pi.metadata?.email
        || pi.charges?.data?.[0]?.billing_details?.email
        || null;

      rows.push({
        stripe_payment_intent_id: pi.id,
        stripe_customer_id:        pi.customer || null,
        email,
        amount_cents:              pi.amount,
        currency:                  pi.currency || 'usd',
        status:                    pi.status,
        description:               pi.description || null,
        metadata:                  pi.metadata || {},
        created_at:                new Date(pi.created * 1000).toISOString(),
      });
    }

    fetched += page.data.length;
    console.log(`  Fetched ${fetched} PaymentIntents so far...`);

    if (!page.has_more || page.data.length === 0) break;
    startingAfter = page.data[page.data.length - 1].id;

    await sleep(SLEEP_MS);
  }

  return rows;
}

async function upsertToSupabase(rows) {
  let inserted = 0;
  let skipped  = 0;

  for (let i = 0; i < rows.length; i += INSERT_BATCH) {
    const batch = rows.slice(i, i + INSERT_BATCH);

    if (DRY_RUN) {
      console.log(`[DRY RUN] Would upsert batch ${i / INSERT_BATCH + 1}: ${batch.length} rows`);
      inserted += batch.length;
      continue;
    }

    const res = await fetch(`${SUPABASE_URL}/rest/v1/stripe_payments`, {
      method: 'POST',
      headers: {
        'apikey':        SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type':  'application/json',
        'Prefer':        'resolution=ignore-duplicates',
      },
      body: JSON.stringify(batch),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error(`Supabase upsert error (batch ${i / INSERT_BATCH + 1}): ${err}`);
      skipped += batch.length;
    } else {
      inserted += batch.length;
    }

    await sleep(50);
  }

  return { inserted, skipped };
}

async function main() {
  console.log(`Backfill starting — limit=${BACKFILL_LIMIT}, dry_run=${DRY_RUN}`);
  if (BACKFILL_CREATED_GTE) {
    console.log(`  Only syncing PIs created after ${new Date(BACKFILL_CREATED_GTE * 1000).toISOString()}`);
  }

  console.log('\nStep 1: Fetching succeeded PaymentIntents from Stripe...');
  const rows = await fetchStripePayments();
  console.log(`  Total rows to sync: ${rows.length}`);

  if (rows.length === 0) {
    console.log('Nothing to sync. Exiting.');
    return;
  }

  console.log('\nStep 2: Upserting to Supabase stripe_payments...');
  const { inserted, skipped } = await upsertToSupabase(rows);

  console.log(`\nDone.`);
  console.log(`  Inserted/updated: ${inserted}`);
  console.log(`  Skipped (errors): ${skipped}`);
  if (DRY_RUN) console.log('  (DRY RUN — no data written)');
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
