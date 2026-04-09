# Eternium API

## Identity
This is the **Eternium API** — a Cloudflare Worker that serves as the public AI generation API for Eternium LLC.
Read `../Sovereign/SOUL.md` for personality and chain of command.

## Project Overview
- **What:** REST API proxying Kie.ai for image/video generation, OpenAI for chat/embeddings/audio, with auth, billing (Stripe), usage tracking, caching, multi-step pipelines, content API, managed hosting, and R2 media storage
- **Runtime:** Cloudflare Workers (V8 isolates)
- **Storage:** Cloudflare KV (API_KEYS, USERS, USAGE, CACHE, TENANTS) + R2 (MEDIA_STORAGE)
- **Upstream providers:** Kie.ai (image/video), OpenAI (chat/embeddings/audio), OpenRouter (fallback)
- **Domain:** api.eternium.ai
- **Repo:** EterniumAI/eternium-api

## Architecture
```
eternium-api/
├── worker.js          # Main Worker — routing, generation, pipelines, thumbnails, usage, content API
├── auth.js            # Auth module — signup, login, Stripe, admin, Armory webhooks
├── tenant.js          # Managed hosting — tenant resolution, CRUD, subdomain routing
├── media.js           # R2 media — upload, serve, delete
├── wrangler.toml      # Cloudflare config + KV bindings + R2 bucket + routes
├── package.json       # wrangler dev dependency
├── public/            # Static assets served by Cloudflare
│   ├── signup.html    # Self-serve signup page
│   ├── docs.html      # API documentation page
│   ├── dashboard.html # User usage dashboard
│   └── admin.html     # Admin panel
├── sdk/
│   ├── js/            # JavaScript/TypeScript SDK (eternium-sdk)
│   └── python/        # Python SDK (eternium-sdk)
├── DEPLOY.md          # Step-by-step deployment guide
├── CLAUDE.md          # This file
└── README.md          # Public README
```

## Development Commands
```bash
npm install            # Install wrangler
npm run dev            # Local dev server (wrangler dev)
npm run deploy         # Deploy to Cloudflare
npm run tail           # Stream live logs
```

## Key Conventions
- Commit messages: `type(scope): description`
- All secrets via `wrangler secret put` — never in code
- KV namespace IDs in wrangler.toml — already configured
- Stripe price IDs in auth.js STRIPE_PRICES — configured for live
- Credit economy: 1 credit = $0.005 (200 credits per dollar)

## Authentication

Two auth mechanisms:
1. **API key:** `X-API-Key: etrn_...` header or `Authorization: Bearer etrn_...`
   - Used for all generation, usage, media, and content endpoints
   - Keys stored in KV namespace `API_KEYS` with tier + rate limit metadata
2. **JWT:** `Authorization: Bearer <jwt>` — used for account management (signup/login/checkout/provision-key)
   - 1-hour expiry, HMAC-SHA256 signed with `JWT_SECRET`

Admin routes require an API key whose email matches `ADMIN_EMAIL` (ty@eternium.ai).

## Endpoints Quick Reference

### Public (no auth)
- `GET /health` — service status
- `GET /v1/models` — all 21 models
- `GET /v1/models/featured` — featured models only
- `GET /v1/pipelines` — available pipelines
- `GET /v1/tiers` — pricing tiers
- `GET /v1/docs` — full API docs as JSON
- `GET /v1/content/blog` — published blog posts
- `GET /v1/content/blog/:slug` — single blog post
- `GET /v1/content/products` — productized datasets
- `GET /v1/content/datasets` — all datasets
- `GET /media/generations/:id` — permanent media URLs (R2)
- `GET /v1/media/:key` — general R2 media

### Auth (JWT)
- `POST /auth/signup` — create account
- `POST /auth/login` — login
- `POST /auth/checkout` — Stripe checkout
- `POST /auth/provision-key` — get API key
- `POST /auth/regenerate-key` — rotate API key

### Authenticated (API key)
- `POST /v1/generate` — generate image or video
- `POST /v1/pipelines/run` — run multi-step pipeline
- `POST /v1/thumbnails/generate` — generate 3 campaign-aware thumbnail concepts
- `POST /v1/chat/completions` — OpenAI-compatible chat (streaming supported)
- `POST /v1/embeddings` — OpenAI-compatible embeddings
- `POST /v1/audio/transcriptions` — Whisper transcription
- `GET /v1/tasks/:id` — poll task status
- `GET /v1/tasks/:id/download` — get download URL (auto-archives to R2)
- `GET /v1/usage` — credit usage and budget
- `PUT /v1/media/upload` — upload to R2
- `DELETE /v1/media/:key` — delete from R2
- `POST /v1/content/blog/publish` — publish blog (admin only)

### Admin (admin API key)
- `GET /admin/overview` — dashboard metrics
- `GET /admin/tenants` — list tenants
- `POST /admin/tenants/provision` — provision tenant
- `PATCH /admin/tenants/:id` — update tenant
- `POST /admin/users/:email/revoke` — suspend user
- `POST /admin/users/:email/activate` — reactivate user

### Webhooks
- `POST /webhooks/stripe` — subscription, Armory product, hosting events

## Available Models

**Image (7):** nano-banana-2, gpt-5.4-image, seedream-5, nano-banana-pro, flux-kontext, qwen-image-2, midjourney
**Video (8):** kling-3.0-mc, veo-3, sora-2, seedance-2, kling-3.0, hailuo-2.3, wan-2.6, kling-2.6
**Chat (3):** gpt-5.1, gpt-5.1-codex-mini, gpt-5.4
**Embedding (2):** text-embedding-3-small, text-embedding-3-large
**Audio (1):** whisper-1

Models are defined in the `MODELS` object in worker.js (~line 145). Costs in `KIE_COSTS` and `OPENAI_COSTS`.

## Pipelines

- `product-shot` — 3 product angles (nano-banana-pro)
- `social-media-pack` — 3 aspect ratios for social platforms
- `video-ad` — hero image + animated video
- `thumbnail-pack` — 4 generic YouTube thumbnail variations

## Thumbnail Generation (Content System)

`POST /v1/thumbnails/generate` accepts structured campaign data and generates 3 concept variants:

```json
{
  "title": "Campaign title",
  "hook": "The hook text for overlay",
  "key_takeaways": ["takeaway 1", "takeaway 2"],
  "content_pillar": "business",
  "style": "bold and dramatic",
  "model": "nano-banana-2"
}
```

Returns 3 variants (A: face + logos + text, B: stat/number hero, C: visual metaphor) with task IDs for polling. See `handleThumbnailGenerate` in worker.js.

## Role in Eternium Ecosystem

The API is the **compute layer**. Other services call it:
- **Website edge functions** (Supabase) call `/v1/generate` and `/v1/thumbnails/generate` for content pipeline automation
- **Command Center** (website-ui) calls `/v1/content/*` for blog and product data
- **SDKs** (js/python) wrap the API for external developers
- **Managed hosting** tenants use subdomain-resolved endpoints on `*.app.eternium.ai`

## Secrets (set via `wrangler secret put`)
- `KIE_API_KEY` — Kie.ai upstream
- `OPENAI_API_KEY` — OpenAI upstream
- `OPENROUTER_API_KEY` — fallback provider (optional)
- `STRIPE_SECRET_KEY` — billing
- `STRIPE_WEBHOOK_SECRET` — webhook verification
- `JWT_SECRET` — session tokens
- `GITHUB_PAT` — Armory product repo invitations
- `SUPABASE_URL` — content API backend
- `SUPABASE_SERVICE_KEY` — content API auth

## Environment
- **Platform:** Cloudflare Workers
- **GitHub Org:** EterniumAI
- **Parent project:** Sovereign (C:\Eternium\Sovereign)
