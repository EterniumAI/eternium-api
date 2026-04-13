-- Migration 032: transactions + integrations tables
-- For the Finance tab: general income/expense ledger + external provider sync state.

-- ── 1. transactions ─────────────────────────────────────────────────────────
-- General financial ledger for the Finance tab. Each Stripe webhook event
-- that involves money creates a row here. Not limited to credit purchases
-- (that's billing_transactions); this covers subscriptions, one-time purchases,
-- hosting fees, refunds, etc.

CREATE TABLE IF NOT EXISTS transactions (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    type        TEXT        NOT NULL CHECK (type IN ('income', 'expense', 'refund')),
    source      TEXT        NOT NULL DEFAULT 'stripe',
    category    TEXT        NOT NULL,
    -- e.g. 'purchase', 'subscription_renewal', 'new_subscription', 'churn',
    --      'charge', 'payment', 'payment_failed'

    amount      NUMERIC(12,2) NOT NULL,
    currency    TEXT        NOT NULL DEFAULT 'usd',
    description TEXT,
    date        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    metadata    JSONB       DEFAULT '{}',
    -- Stores stripe_event_id, stripe_customer_id, email, etc.

    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_transactions_date
    ON transactions (date DESC);

CREATE INDEX IF NOT EXISTS idx_transactions_source_category
    ON transactions (source, category);

CREATE INDEX IF NOT EXISTS idx_transactions_type
    ON transactions (type, date DESC);

-- RLS: service_role only (API worker writes, admin reads)
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
CREATE POLICY transactions_service_all ON transactions
    FOR ALL USING (auth.role() = 'service_role');

COMMENT ON TABLE transactions IS
    'General financial ledger for the Finance tab. '
    'Populated by Stripe webhook events via eternium-api worker.';

-- ── 2. integrations ─────────────────────────────────────────────────────────
-- Stores sync state and aggregate data from external providers.
-- The Finance tab reads MRR data from here (provider='stripe', key='mrr_sync').

CREATE TABLE IF NOT EXISTS integrations (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    provider    TEXT        NOT NULL,
    key         TEXT        NOT NULL,
    data        JSONB       NOT NULL DEFAULT '{}',
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(provider, key)
);

-- RLS: service_role only
ALTER TABLE integrations ENABLE ROW LEVEL SECURITY;
CREATE POLICY integrations_service_all ON integrations
    FOR ALL USING (auth.role() = 'service_role');

COMMENT ON TABLE integrations IS
    'External provider sync state. Finance tab reads MRR from '
    'provider=stripe, key=mrr_sync.';

-- ── Rollback ─────────────────────────────────────────────────────────────────
-- DROP TABLE IF EXISTS transactions;
-- DROP TABLE IF EXISTS integrations;
