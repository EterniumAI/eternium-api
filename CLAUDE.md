# Eternium API

## Identity
This is the **Eternium API** — a Cloudflare Worker that serves as the public AI generation API for Eternium LLC.
Read `../Sovereign/SOUL.md` for personality and chain of command.

## Project Overview
- **What:** REST API proxying Kie.ai for image/video generation, with auth, billing (Stripe), usage tracking, caching, and multi-step pipelines
- **Runtime:** Cloudflare Workers (V8 isolates)
- **Storage:** Cloudflare KV (API_KEYS, USERS, USAGE, CACHE)
- **Domain:** api.eternium.ai
- **Repo:** EterniumAI/eternium-api

## Architecture
```
eternium-api/
├── worker.js          # Main Worker — routing, generation, pipelines, usage
├── auth.js            # Auth module — signup, login, Stripe, admin
├── wrangler.toml      # Cloudflare deployment config + KV bindings
├── package.json       # wrangler dev dependency
├── signup.html        # Self-serve signup page
├── docs.html          # API documentation page
├── dashboard.html     # User usage dashboard
├── admin.html         # Admin panel
├── DEPLOY.md          # Step-by-step deployment guide
├── CLAUDE.md          # This file
├── README.md          # Public README
└── sdk/
    ├── js/            # JavaScript/TypeScript SDK (eternium-sdk)
    └── python/        # Python SDK (eternium-sdk)
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
- KV namespace IDs in wrangler.toml — replace REPLACE_WITH_* placeholders before first deploy
- Stripe price IDs in auth.js STRIPE_PRICES — replace before going live

## Environment
- **Platform:** Cloudflare Workers
- **GitHub Org:** EterniumAI
- **Parent project:** Sovereign (C:\Eternium\Sovereign)
