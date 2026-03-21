# Eternium API — Deployment Guide

## Prerequisites
- Node.js 18+
- Wrangler CLI: `npm i -g wrangler`
- Cloudflare account (logged in: `wrangler login`)
- Kie.ai API key (from https://kie.ai)
- Stripe account with API keys (from https://dashboard.stripe.com)

## 1. Create KV Namespaces

```bash
cd api
wrangler kv namespace create API_KEYS
wrangler kv namespace create USERS
wrangler kv namespace create USAGE
wrangler kv namespace create CACHE
```

Copy ALL namespace IDs into `wrangler.toml` — replace every `REPLACE_WITH_*` placeholder.

## 2. Set Up Stripe Products

In Stripe Dashboard (https://dashboard.stripe.com/products):

1. Create product "Eternium API — Starter" → Price: $29/mo recurring
2. Create product "Eternium API — Builder" → Price: $79/mo recurring
3. Create product "Eternium API — Scale" → Price: $199/mo recurring

Copy each price ID (starts with `price_`) into `auth.js` → `STRIPE_PRICES` object.

## 3. Set Secrets

```bash
wrangler secret put KIE_API_KEY             # Your Kie.ai API key
wrangler secret put STRIPE_SECRET_KEY       # sk_live_... from Stripe
wrangler secret put STRIPE_WEBHOOK_SECRET   # whsec_... (created in step 5)
wrangler secret put JWT_SECRET              # Any random string (64+ chars)
```

## 4. Deploy

```bash
wrangler deploy
```

## 5. Configure Stripe Webhook

In Stripe Dashboard → Developers → Webhooks:

1. Add endpoint: `https://api.eternium.ai/webhooks/stripe`
2. Select events:
   - `checkout.session.completed`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
3. Copy the webhook signing secret → `wrangler secret put STRIPE_WEBHOOK_SECRET`

## 6. Custom Domain

In Cloudflare Dashboard:
1. Go to Workers & Pages → eternium-api
2. Settings → Domains & Routes
3. Add Custom Domain: `api.eternium.ai`
4. Cloudflare handles SSL automatically

## 7. Create Your Admin Account

```bash
# Create admin API key manually for admin dashboard access
wrangler kv key put --namespace-id=YOUR_API_KEYS_NS_ID \
  "key:etrn_admin_001" \
  '{"key":"etrn_admin_001","email":"ty@eternium.ai","name":"Ty Barney","tier":"enterprise","rateLimit":120,"createdAt":"2026-03-21"}'

# Also create user record
wrangler kv key put --namespace-id=YOUR_USERS_NS_ID \
  "user:ty@eternium.ai" \
  '{"email":"ty@eternium.ai","name":"Ty Barney","tier":"enterprise","apiKey":"etrn_admin_001","active":true,"createdAt":"2026-03-21"}'
```

## 8. Verify Everything

```bash
# Health check
curl https://api.eternium.ai/health

# List models
curl https://api.eternium.ai/v1/models

# Test signup (self-serve)
curl -X POST https://api.eternium.ai/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"testpass123","name":"Test User"}'

# Admin dashboard data
curl https://api.eternium.ai/admin/overview \
  -H "X-API-Key: etrn_admin_001"

# Test generation
curl -X POST https://api.eternium.ai/v1/generate \
  -H "Content-Type: application/json" \
  -H "X-API-Key: etrn_admin_001" \
  -d '{"model":"nano-banana-pro","prompt":"Test image, blue sky"}'
```

## Self-Serve User Flow

1. User visits `/signup` → creates account (email + password)
2. Chooses tier:
   - **Free** → API key generated instantly
   - **Paid** → redirects to Stripe Checkout → after payment, key auto-generated
3. User gets API key on success screen
4. User can view usage at `/dashboard`
5. Stripe webhook auto-handles: upgrades, downgrades, cancellations

## File Structure

```
api/
├── worker.js          # Main Cloudflare Worker (API + routing)
├── auth.js            # Auth, Stripe, admin logic
├── wrangler.toml      # Deployment config + KV bindings
├── package.json       # Dev dependencies (wrangler)
├── signup.html        # Self-serve signup + tier selection + Stripe checkout
├── docs.html          # API documentation page
├── dashboard.html     # User usage dashboard
├── admin.html         # Admin panel (all users, revenue, costs, alerts)
├── DEPLOY.md          # This file
└── sdk/
    ├── js/            # JavaScript/TypeScript SDK
    │   ├── index.js   # ESM entry
    │   ├── index.cjs  # CommonJS entry
    │   ├── index.d.ts # TypeScript types
    │   └── package.json
    └── python/        # Python SDK
        ├── eternium/
        │   ├── __init__.py
        │   └── client.py
        └── setup.py
```

## Pages to Host

These HTML pages should be served via Cloudflare Pages or as worker routes:

| Page | URL | Purpose |
|------|-----|---------|
| signup.html | api.eternium.ai/signup | Self-serve account creation |
| docs.html | api.eternium.ai/docs | API documentation |
| dashboard.html | api.eternium.ai/dashboard | User usage dashboard |
| admin.html | api.eternium.ai/admin | Admin panel (Ty only) |

## Pricing Tiers

| Tier | Monthly | Credits | Rate Limit | Concurrent |
|------|---------|---------|------------|------------|
| free | $0 | $2.00 | 10/min | 2 |
| starter | $29 | $22.00 | 30/min | 5 |
| builder | $79 | $62.00 | 45/min | 10 |
| scale | $199 | $165.00 | 60/min | 20 |
| enterprise | Custom | Custom | 120/min | 50 |

## Monitoring Checklist

- [ ] Check admin dashboard daily for first 2 weeks
- [ ] Monitor Kie.ai credit balance (no alert system from them)
- [ ] Watch Stripe dashboard for failed payments / chargebacks
- [ ] Review cache hit rate — high rate = happy agents
- [ ] If Kie.ai costs > 80% of MRR, adjust pricing or restrict free tier

## Next Steps

- [ ] Publish JS SDK: `cd sdk/js && npm publish`
- [ ] Publish Python SDK: `cd sdk/python && python -m build && twine upload dist/*`
- [ ] Serve HTML pages (Pages deployment or worker static routes)
- [ ] Set up Stripe price IDs in auth.js
- [ ] Add multi-provider routing (fal.ai, Replicate fallbacks)
- [ ] D1 database for full analytics (request logs, per-model breakdowns)
