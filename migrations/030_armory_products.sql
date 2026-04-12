-- Migration 030: Armory product catalog
-- Canonical source of truth for the AI Builder's Playbook product series.
-- Powers GET /v1/products on eternium-api (consumed by tyrinbarney.com + eternium.ai).
-- Safe to re-run (all statements use IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS public.armory_products (
    id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    slug                 text        UNIQUE NOT NULL,
    name                 text        NOT NULL,
    series               text,
    episode              text,
    tagline              text,
    description          text,
    demo_url             text,
    github_repo          text,
    pdf_url              text,
    pdf_filename         text,
    resource_title       text,
    resource_description text,
    manychat_keyword     text,
    requires_auth        boolean     NOT NULL DEFAULT true,
    image_url            text,
    stats                jsonb       NOT NULL DEFAULT '{}',
    features             jsonb       NOT NULL DEFAULT '[]',
    sort_order           integer     NOT NULL DEFAULT 0,
    is_active            boolean     NOT NULL DEFAULT true,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS armory_products_slug_idx   ON public.armory_products (slug);
CREATE INDEX IF NOT EXISTS armory_products_active_idx ON public.armory_products (sort_order) WHERE is_active;

-- updated_at trigger
CREATE OR REPLACE FUNCTION public.set_armory_products_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_armory_products_updated_at ON public.armory_products;
CREATE TRIGGER trg_armory_products_updated_at
  BEFORE UPDATE ON public.armory_products
  FOR EACH ROW EXECUTE FUNCTION public.set_armory_products_updated_at();

-- ── Seed data: AI Builder's Playbook series ──────────────────────────────────
INSERT INTO public.armory_products
    (slug, name, series, episode, tagline, description,
     demo_url, github_repo, pdf_url, pdf_filename,
     resource_title, resource_description,
     manychat_keyword, requires_auth, image_url,
     stats, features, sort_order)
VALUES
(
    'claude-kit',
    'Claude Code Starter Kit',
    'The AI Builder''s Playbook',
    'EP1',
    'Ship production-ready AI features in 45 minutes.',
    'A complete starter kit for building with Claude Code. Includes file structure, prompt templates, workflow patterns, and real-world examples so you can skip the boilerplate and start shipping.',
    'https://armory-claude-kit.pages.dev',
    'EterniumAI/armory-claude-kit',
    null,
    'ep1-claude-code-starter-kit.pdf',
    'Claude Code Starter Kit',
    'Get the full kit: file structure, prompt templates, workflow patterns, and real examples.',
    'CLAUDE',
    true,
    null,
    '{"files": 25, "lines": "4,767", "buildTime": "45 min"}',
    '["Pre-built file structure", "Production prompt templates", "Workflow automation patterns", "Real project examples", "CLAUDE.md best practices"]',
    10
),
(
    'money-machine',
    'AI Money Machine',
    'The AI Builder''s Playbook',
    'EP2',
    'The complete system for monetizing AI-built tools.',
    'Every component you need to turn an AI tool into recurring revenue: pricing frameworks, checkout flows, usage tracking, and the exact tech stack that scales from 0 to $10k MRR.',
    null,
    'EterniumAI/armory-money-machine',
    null,
    'ep2-ai-money-machine.pdf',
    'AI Money Machine System',
    'The exact framework, code, and stack for building AI tools that generate recurring revenue.',
    'MONEY',
    true,
    null,
    '{"components": 12, "templates": 8, "avgMRR": "$4,200"}',
    '["Pricing tier framework", "Stripe integration templates", "Usage tracking system", "Upgrade flow patterns", "Revenue dashboard"]',
    20
),
(
    'tech-stack',
    'AI Tech Stack Blueprint',
    'The AI Builder''s Playbook',
    'EP3',
    'The exact stack powering production AI apps in 2025.',
    'A curated, battle-tested reference for every layer of the modern AI stack: models, infra, auth, billing, deployment, and monitoring. Stop researching and start building.',
    null,
    'EterniumAI/armory-tech-stack',
    'https://api.eternium.ai/v1/media/lead-magnets/ep3-ai-tech-stack-blueprint.pdf',
    'ep3-ai-tech-stack-blueprint.pdf',
    'AI Tech Stack Blueprint',
    'The battle-tested stack reference covering every layer of a production AI app.',
    'STACK',
    true,
    null,
    '{"layers": 7, "tools": 42, "integrations": 18}',
    '["Model selection guide", "Infra + deployment options", "Auth and billing wiring", "Monitoring and observability", "Cost optimization patterns"]',
    30
),
(
    'centramind-blueprint',
    'CentraMind Blueprint',
    'The AI Builder''s Playbook',
    'EP4',
    'Build your own multi-agent AI operations fleet.',
    'The architecture, prompt system, and coordination patterns behind CentraMind -- a multi-agent AI fleet that runs software projects autonomously. Fork it, extend it, deploy it.',
    null,
    'EterniumAI/armory-centramind-blueprint',
    null,
    'ep4-centramind-blueprint.pdf',
    'CentraMind Blueprint',
    'The full architecture and prompt system for building a production multi-agent AI fleet.',
    'CENTRAMIND',
    true,
    null,
    '{"agents": 6, "prompts": 34, "patterns": 11}',
    '["Multi-agent coordination patterns", "Operator role system", "Dispatch and routing logic", "Context handoff protocol", "Fleet identity system"]',
    40
),
(
    'utm-tracker',
    'AI UTM Tracker',
    'The AI Builder''s Playbook',
    'EP5',
    'Know exactly which content drives conversions.',
    'A lightweight UTM tracking system built for solo operators and small teams. Captures source, medium, and campaign at signup, stores it with the user record, and surfaces it in your dashboard.',
    null,
    'EterniumAI/armory-utm-tracker',
    null,
    'ep5-ai-utm-tracker.pdf',
    'AI UTM Tracker',
    'The lightest UTM system that actually answers: where are your best customers coming from?',
    'UTM',
    true,
    null,
    '{"files": 6, "setupTime": "20 min", "integrations": 4}',
    '["UTM capture at signup", "Source attribution dashboard", "Conversion tracking", "Supabase + KV storage", "Zero-dependency implementation"]',
    50
)
ON CONFLICT (slug) DO NOTHING;

-- ── Rollback ─────────────────────────────────────────────────────────────────
-- DROP TRIGGER IF EXISTS trg_armory_products_updated_at ON public.armory_products;
-- DROP FUNCTION IF EXISTS public.set_armory_products_updated_at();
-- DROP TABLE IF EXISTS public.armory_products;
