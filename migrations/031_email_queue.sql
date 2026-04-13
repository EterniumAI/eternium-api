-- Migration 031: email_queue
-- Outbound email scheduling table for drip sequences and transactional mail.
-- Rows are inserted at signup with staggered scheduled_for timestamps.
-- The /v1/email/process endpoint (cron or manual) reads pending rows,
-- sends via Resend, and marks them sent or failed.
--
-- Run once against Supabase project: wmahfjguvqvefgjpbcdc
-- Safe to re-run (all statements use IF NOT EXISTS).
--
-- QUERYING:
--   Due emails:
--     SELECT * FROM email_queue
--     WHERE status = 'pending' AND scheduled_for <= now()
--     ORDER BY scheduled_for ASC LIMIT 50;
--
--   Failed emails:
--     SELECT * FROM email_queue WHERE status = 'failed' ORDER BY created_at DESC;
--
--   Sequence for a recipient:
--     SELECT template_name, scheduled_for, status
--     FROM email_queue WHERE recipient_email = 'user@example.com'
--     ORDER BY scheduled_for;

CREATE TABLE IF NOT EXISTS public.email_queue (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    recipient_email text NOT NULL,
    template_name   text NOT NULL,
    scheduled_for   timestamptz NOT NULL DEFAULT now(),
    sent_at         timestamptz,
    status          text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'sent', 'failed')),
    metadata        jsonb NOT NULL DEFAULT '{}',
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_queue_pending
    ON public.email_queue (scheduled_for)
    WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_email_queue_recipient
    ON public.email_queue (recipient_email);

-- RLS: only service role reads/writes (no user-facing access needed)
ALTER TABLE public.email_queue ENABLE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS "email_queue_service_all"
    ON public.email_queue FOR ALL
    TO service_role USING (true) WITH CHECK (true);

-- ── Rollback ─────────────────────────────────────────────────────
-- DROP TABLE IF EXISTS public.email_queue;
