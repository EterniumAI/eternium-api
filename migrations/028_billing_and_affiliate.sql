-- migrations/028_billing_and_affiliate.sql
-- Billing (credit top-up, transaction history, auto top-up) + affiliate program tables.
--
-- Status: STUB — reviewed by operator-2, pending sign-off from Sovereign before apply.
-- Apply with: psql $DATABASE_URL < migrations/028_billing_and_affiliate.sql
-- Or via Supabase Dashboard → SQL Editor.
--
-- Depends on: Supabase auth.users (for FK references).
-- No changes to existing tables.
--
-- ⚠️  The CREATE TABLE statements are uncommented below.
--     A trailing block (marked UNSAFE / DO NOT RUN) contains DROP TABLE
--     statements for rollback — commented out for safety.
-- ──────────────────────────────────────────────────────────────────────────────


-- ── 1. stripe_customers ───────────────────────────────────────────────────────
-- Maps each Eternium user to their Stripe Customer object.
-- Created lazily on first billing action.

CREATE TABLE IF NOT EXISTS stripe_customers (
    user_id                  TEXT        NOT NULL PRIMARY KEY,
    -- Eternium user identifier. Matches email in KV USERS namespace.
    -- TEXT not UUID because existing user records use email as PK.

    stripe_customer_id       TEXT        NOT NULL UNIQUE,
    -- cus_...

    default_payment_method_id TEXT       DEFAULT NULL,
    -- pm_... — set after user saves a card via SetupIntent.
    -- NULL means no card on file.

    created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stripe_customers_stripe_id
    ON stripe_customers (stripe_customer_id);

COMMENT ON TABLE stripe_customers IS
    'Stripe Customer records. One row per Eternium user who has taken a billing action.';


-- ── 2. billing_transactions ───────────────────────────────────────────────────
-- Authoritative ledger of all credit purchases.
-- A row is inserted when payment_intent.succeeded fires in the Stripe webhook.
-- KV creditBalance is updated from this table; this is the source of truth.

CREATE TABLE IF NOT EXISTS billing_transactions (
    id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                  TEXT        NOT NULL,
    -- Eternium user identifier (email). Not FK to auth.users — KV user is authoritative.

    stripe_payment_intent_id TEXT        NOT NULL UNIQUE,
    -- pi_... — idempotency key. Duplicate webhooks are ignored if this exists.

    amount_usd               NUMERIC(10,4) NOT NULL CHECK (amount_usd > 0),
    -- Gross charge amount in USD.

    credits_added            INTEGER     NOT NULL CHECK (credits_added > 0),
    -- Credits granted from this transaction (e.g. 1000, 10000, 105000, 275000).

    status                   TEXT        NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending', 'completed', 'failed', 'refunded')),

    invoice_data             JSONB       DEFAULT NULL,
    -- Arbitrary invoice metadata: billing address, company name, VAT number.
    -- Editable by user post-purchase (for Invoice Information UX).

    package_id               TEXT        DEFAULT NULL,
    -- Identifier of the credit package purchased (e.g. 'pack_5', 'pack_50').
    -- NULL if this was an auto top-up charge.

    is_auto_topup            BOOLEAN     NOT NULL DEFAULT FALSE,

    created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at             TIMESTAMPTZ DEFAULT NULL
);

CREATE INDEX IF NOT EXISTS idx_billing_transactions_user
    ON billing_transactions (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_billing_transactions_pi
    ON billing_transactions (stripe_payment_intent_id);

COMMENT ON TABLE billing_transactions IS
    'Authoritative credit purchase ledger. One row per Stripe PaymentIntent. '
    'Source of truth for creditBalance — KV is an optimistic cache of this table.';


-- ── 3. auto_topup_configs ─────────────────────────────────────────────────────
-- Per-user auto top-up settings. One row per user, upserted when the user
-- configures their auto top-up preferences.

CREATE TABLE IF NOT EXISTS auto_topup_configs (
    user_id                  TEXT        NOT NULL PRIMARY KEY,

    enabled                  BOOLEAN     NOT NULL DEFAULT FALSE,

    threshold_credits        INTEGER     NOT NULL DEFAULT 100
                             CHECK (threshold_credits >= 0),
    -- Auto top-up fires when creditBalance drops below this value.

    topup_amount_usd         NUMERIC(6,2) NOT NULL DEFAULT 5.00
                             CHECK (topup_amount_usd IN (5, 50, 500, 1250)),
    -- Must be a valid package price.

    cooldown_seconds         INTEGER     NOT NULL DEFAULT 600,
    -- Minimum seconds between auto top-up attempts. Enforced at Worker level
    -- via KV TTL key (auto_topup_last_attempt:{apiKey}), NOT here.
    -- This column stores the configured cooldown for display purposes only.

    last_attempt_at          TIMESTAMPTZ DEFAULT NULL,
    -- Informational: last time an auto top-up was attempted.

    created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE auto_topup_configs IS
    'Auto top-up settings per user. The actual cooldown gate is enforced via KV TTL '
    'key in the Worker (auto_topup_last_attempt:{apiKey}), not via this table, '
    'because KV reads are faster than Supabase round-trips in the critical path.';


-- ── 4. affiliate_accounts ─────────────────────────────────────────────────────
-- Users who have opted into the affiliate program. Created by POST /affiliate/join.

CREATE TABLE IF NOT EXISTS affiliate_accounts (
    user_id                  TEXT        NOT NULL PRIMARY KEY,

    referral_code            TEXT        NOT NULL UNIQUE,
    -- Format: {base36(userId[0..7]).toUpperCase()}-{4 random chars}
    -- Example: TY1A2B3C-X9KZ

    commission_rate_pct      NUMERIC(4,2) NOT NULL DEFAULT 10.00
                             CHECK (commission_rate_pct BETWEEN 0 AND 100),
    -- Adjustable per affiliate by admin PATCH endpoint.

    stripe_connect_id        TEXT        DEFAULT NULL,
    -- acct_... — populated when Stripe Connect Express onboarding completes.
    -- NULL for MVP (manual payouts).

    created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_affiliate_accounts_code
    ON affiliate_accounts (referral_code);

COMMENT ON TABLE affiliate_accounts IS
    'Affiliate program participants. Users opt in explicitly. '
    'stripe_connect_id is NULL for MVP; populated when Connect onboarding ships.';


-- ── 5. affiliate_referrals ────────────────────────────────────────────────────
-- One row per referred user. Created at signup when a referral_code is present.
-- Attribution is first-touch; a referred user has at most one row.

CREATE TABLE IF NOT EXISTS affiliate_referrals (
    id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

    referrer_user_id         TEXT        NOT NULL,
    -- Eternium user_id of the affiliate who owns the referral_code.
    -- References affiliate_accounts.user_id.

    referred_user_id         TEXT        NOT NULL UNIQUE,
    -- Eternium user_id of the newly signed-up user. UNIQUE enforces one-per-referred.

    attributed_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Timestamp of signup attribution.

    first_payment_at         TIMESTAMPTZ DEFAULT NULL
    -- Set by the payment_intent.succeeded webhook on the referred user's first purchase.
    -- Commission window = 12 months from this timestamp. NULL = never paid.
);

CREATE INDEX IF NOT EXISTS idx_affiliate_referrals_referrer
    ON affiliate_referrals (referrer_user_id, attributed_at DESC);

COMMENT ON TABLE affiliate_referrals IS
    'Attribution records. One row per referred user (UNIQUE on referred_user_id). '
    'first_payment_at is set on first purchase; commission window = 12 months from that date.';


-- ── 6. affiliate_commissions ──────────────────────────────────────────────────
-- One row per commission event. Created in the payment_intent.succeeded webhook
-- when the paying user has an open commission window.

CREATE TABLE IF NOT EXISTS affiliate_commissions (
    id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

    referrer_user_id         TEXT        NOT NULL,
    -- Affiliate who earns the commission.

    source_transaction_id    UUID        NOT NULL,
    -- billing_transactions.id that triggered this commission.

    referred_user_id         TEXT        NOT NULL,
    -- The user whose purchase generated the commission.

    purchase_amount_usd      NUMERIC(10,4) NOT NULL,
    -- Gross purchase that the commission is based on.

    amount_usd               NUMERIC(10,4) NOT NULL,
    -- Commission amount = purchase_amount_usd * commission_rate_pct / 100.

    commission_rate_pct      NUMERIC(4,2) NOT NULL,
    -- Snapshotted from affiliate_accounts.commission_rate_pct at time of calculation.

    status                   TEXT        NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending', 'paid', 'cancelled')),

    paid_at                  TIMESTAMPTZ DEFAULT NULL,
    -- Set when admin marks payout as sent (or Stripe Connect transfer completes).

    stripe_transfer_id       TEXT        DEFAULT NULL,
    -- tr_... — populated when Stripe Connect transfer fires.

    created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_affiliate_commissions_referrer
    ON affiliate_commissions (referrer_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_affiliate_commissions_source
    ON affiliate_commissions (source_transaction_id);

COMMENT ON TABLE affiliate_commissions IS
    'One row per commission event. Created in the Stripe webhook. '
    'status=pending until admin (or Stripe Connect) processes payout.';


-- ─────────────────────────────────────────────────────────────────────────────
-- ROLLBACK BLOCK — UNSAFE / DO NOT RUN without explicit sign-off from Sovereign
-- ─────────────────────────────────────────────────────────────────────────────
-- Uncomment ONLY to roll back this migration on a non-production database.
-- Production rollback requires a data recovery plan first.
--
-- DROP TABLE IF EXISTS affiliate_commissions;
-- DROP TABLE IF EXISTS affiliate_referrals;
-- DROP TABLE IF EXISTS affiliate_accounts;
-- DROP TABLE IF EXISTS auto_topup_configs;
-- DROP TABLE IF EXISTS billing_transactions;
-- DROP TABLE IF EXISTS stripe_customers;
