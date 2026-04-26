-- Migration 033: ad_commander_publish_queue
-- Durable handoff table between the Worker (enqueue) and the Bunker (consume).
-- Every swap-publish request creates a row here; the Bunker polls or reacts
-- via fleet_events to process the actual Meta publish/pause cycle.

CREATE TABLE IF NOT EXISTS ad_commander_publish_queue (
    id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    ads_account_id          UUID        NOT NULL,
    challenger_creative_id  UUID        NOT NULL,
    champion_creative_id    UUID        NOT NULL,
    mode                    TEXT        NOT NULL DEFAULT 'new_ad_pause_old',
    status                  TEXT        NOT NULL DEFAULT 'queued'
                            CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
    requested_by            TEXT        NOT NULL,
    requested_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at            TIMESTAMPTZ,
    result_payload          JSONB,
    error_text              TEXT,
    tenant_id               UUID        NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_publish_queue_status
    ON ad_commander_publish_queue (status, requested_at);

CREATE INDEX IF NOT EXISTS idx_publish_queue_account
    ON ad_commander_publish_queue (ads_account_id, requested_at DESC);

CREATE INDEX IF NOT EXISTS idx_publish_queue_tenant
    ON ad_commander_publish_queue (tenant_id);

-- RLS: service_role only (Worker writes, Bunker reads/updates, admin queries)
ALTER TABLE ad_commander_publish_queue ENABLE ROW LEVEL SECURITY;

CREATE POLICY publish_queue_service_all ON ad_commander_publish_queue
    FOR ALL USING (auth.role() = 'service_role');

COMMENT ON TABLE ad_commander_publish_queue IS
    'Durable queue for Ad Commander swap-publish requests. '
    'Worker enqueues; Sovereign Bunker dequeues and publishes via Meta Graph.';
