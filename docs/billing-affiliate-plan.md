# Billing & Affiliate Program — Implementation Plan

**Author:** operator-2
**Date:** 2026-04-11
**Status:** Scoping complete, implementation pending
**Target:** Eternium API (EterniumAI/eternium-api, `api.eternium.ai`)

---

## 1. Context and Goals

Ty wants two things:

1. **KIE-style credit billing UX** — replace the current subscription-only model with a credit-purchase flow:
   a card-on-file, one-time credit packs, auto top-up when balance runs low, and a transaction
   history table with invoices.

2. **Affiliate program** — per-user referral links, a commission dashboard, and a payout flow
   (Stripe Connect initially; PayPal as a follow-up option).

### Current billing state (as of A1 fix)

| What | Where | Notes |
|------|-------|-------|
| User records | KV `USERS` keyed by email | Includes `stripeCustomerId`, `tier`, `apiKey` |
| API keys | KV `API_KEYS` keyed by `key:{apiKey}` | Tier + rate limit metadata |
| Usage | KV `USAGE` keyed by `usage:{apiKey}:{YYYY-MM}` | `{ spent (credits), generations, cached, tasks[] }` |
| Monthly credits | `TIERS` constant in `worker.js` | free=100 … internal=2M |
| Stripe subscriptions | `auth.js` via raw `stripeRequest()` | starter/builder/scale tiers wired |
| CREDITS_PER_USD | 200 (1 credit = $0.005) | Established in fix/operator-2-provider-cost-accuracy |

What does NOT exist yet: credit top-up, saved cards, auto reload, transaction history, affiliate program.

---

## 2. Credit Model Design

### 2.1 Balance semantics

Keep the existing tier system for **rate limits and feature gates**. Add a separate
**credit balance** that accumulates from purchases and decays as the user generates.

```
effective_credits_available = tier_monthly_allocation + purchased_balance - used_this_month
```

Purchased credits do not expire (matching KIE). Monthly tier credits reset on the 1st.
Purchased balance persists across months.

User KV record gains two new fields:
```json
{
  "creditBalance": 0,
  "creditBalanceUpdatedAt": "2026-04-11T00:00:00Z"
}
```

`creditBalance` is the persistent purchased-credits pool. `trackUsage` deducts from
`creditBalance` first, then from tier allocation.

> **KV atomicity warning:** KV is eventually consistent. Do NOT use KV for the
> authoritative transaction ledger. Use Supabase `billing_transactions` as the
> source of truth. KV `creditBalance` is an optimistic cache; it is replenished on
> `payment_intent.succeeded` webhook and re-hydrated from Supabase on mismatch.

### 2.2 Credit packages

| Price | Credits | Rate | Bonus |
|-------|---------|------|-------|
| $5    | 1,000   | 200/$ | — |
| $50   | 10,000  | 200/$ | — |
| $500  | 105,000 | 210/$ | 5% |
| $1,250 | 275,000 | 220/$ | 10% |

Define in `lib/billing-packages.js` (created in W1). Match KIE's pricing exactly so
Ty can reference competitive positioning.

---

## 3. Stripe Integration Design

### 3.1 Package decision

Do **not** add the `stripe` npm package. The existing raw `stripeRequest(method, path, body, env)`
helper in `auth.js` already works in the CF Worker runtime and has zero bundle overhead.
Extend that helper (or promote it to `lib/stripe.js`) rather than importing a 150 KB SDK.

Stripe API compatibility date: `2024-12-01` (matches `wrangler.toml`). All endpoints used
below are stable at that date.

### 3.2 Customer lifecycle

```
First billing action
  → POST /v1/customers { email, name, metadata.eternium_user_id }
  → Store stripe_customer_id in KV user record AND Supabase stripe_customers
```

Customer is created lazily (on first card save or first purchase) so we don't spam
Stripe with customers who never pay.

### 3.3 Saved card flow (SetupIntent)

```
Client                    Worker                    Stripe
  │── POST /billing/setup-intent ──►│
  │                                 │── POST /v1/setup_intents ──►│
  │                                 │◄── { client_secret } ────────│
  │◄── { client_secret } ───────────│
  │
  │ [Stripe.js confirms SetupIntent, returns payment_method_id]
  │
  │── POST /billing/set-default-pm { payment_method_id } ──►│
  │                                 │── PATCH /v1/customers/:id ──►│
  │                                 │   { invoice_settings.default_payment_method }
  │                                 │── Write default_payment_method_id to Supabase
  │◄── { ok: true } ────────────────│
```

### 3.4 One-time credit purchase (PaymentIntent)

```
Client                    Worker                    Stripe
  │── POST /billing/purchase { package_id } ──►│
  │                                 │── POST /v1/payment_intents ──►│
  │                                 │   { amount, currency, customer,
  │                                 │     payment_method, confirm: true,
  │                                 │     metadata.package_id, metadata.user_id }
  │                                 │◄── { status: "succeeded" / requires_action }─│
  │◄── { status, client_secret? } ──│
```

If `payment_method` is on file: `confirm: true`, no client round-trip needed.
If no card on file, return `client_secret` for Stripe.js to handle 3DS/redirect.

### 3.5 Webhook: `payment_intent.succeeded`

```
Stripe ──► POST /webhooks/stripe (existing route, extend handler)
  1. Verify signature (existing verifyStripeSignature())
  2. If event.type === 'payment_intent.succeeded' AND metadata.package_id present:
     a. Resolve user from metadata.user_id
     b. Look up package credit amount
     c. Insert row into Supabase billing_transactions (status=completed)
     d. Add credits to KV user.creditBalance
     e. Add credits to KV USAGE.spent inverse (or store separately)
```

> The webhook is the **only** place credits are added. Never add credits in the
> POST /billing/purchase response — only confirm that payment was accepted.
> This prevents double-credits if the client retries.

### 3.6 Auto top-up

Checked in `trackUsage()` after deducting credits. If:

```
user.creditBalance < auto_topup_config.threshold_credits
AND auto_topup_config.enabled
AND now - last_attempt_at > cooldown_seconds (default: 600)
```

Then fire a PaymentIntent for `topup_amount_usd` using the default payment method.

**KV cooldown enforcement:** Store `auto_topup_last_attempt:{apiKey}` in USAGE KV with TTL=600.
Check before firing. This is the only reliable cooldown in a stateless Worker — do not rely
on Supabase round-trip latency for this gate.

**Important:** Auto top-up fires asynchronously via `waitUntil()` — do not block the
generation response. Log attempts and outcomes to Supabase.

---

## 4. Affiliate Program Design

### 4.1 Referral code generation

```
referral_code = base36(userId.slice(0,8)).toUpperCase() + "-" + random4chars
```

Example: `TY1A2B3C-X9KZ`

Codes are unique, stored in `affiliate_accounts.referral_code` with a UNIQUE index.
Users opt in to the affiliate program explicitly (POST /affiliate/join).

### 4.2 Attribution flow

```
New user visits /signup?ref=TY1A2B3C-X9KZ
  → Landing page stores ref code in sessionStorage
  → On Supabase auth signup, POST /auth/provision-key with body { referral_code: "TY1A2B3C-X9KZ" }
  → Worker resolves referral_code → referrer_user_id
  → Insert affiliate_referrals row { referrer_user_id, referred_user_id, attributed_at }
```

Attribution window: first-touch, set at signup. No re-attribution after the fact.

### 4.3 Commission calculation

- Rate: **10% of each credit purchase** made by the referred user
- Window: **12 months** from `first_payment_at` in `affiliate_referrals`
- Calculation runs in the `payment_intent.succeeded` webhook, same handler as credit grants:
  ```
  1. Check if referred_user has an affiliate_referrals row
  2. Check if first_payment_at + 12mo > now
  3. Calculate commission = purchase_amount_usd * referrer.commission_rate_pct / 100
  4. Insert affiliate_commissions row { status: pending }
  ```

### 4.4 Payout workflow

MVP: **manual Stripe transfers** (Ty initiates from Stripe Dashboard). This avoids Stripe
Connect onboarding complexity for the initial launch.

Phase 2: Stripe Connect Express (operator can implement separately).

Affiliate requests a payout via POST /affiliate/payout-request. This creates a row in
a `payout_requests` table (out of scope for this migration — add in W4). Admin reviews
and fires transfer manually.

### 4.5 Commission rates by tier

Default: 10% for all users. Promote affiliates manually via admin PATCH endpoint.

---

## 5. Data Model Deltas

### 5.1 KV changes (no new namespaces needed)

| Key pattern | New fields | Notes |
|-------------|------------|-------|
| `users:{email}` | `creditBalance`, `creditBalanceUpdatedAt`, `referralCode` | Extend existing record |
| `usage:{key}:{month}` | no changes | |
| `auto_topup_last_attempt:{apiKey}` | string timestamp (ISO) | TTL=600s, prevents hammering |

### 5.2 Supabase tables (see migration 028)

```
stripe_customers       — 1:1 with user, Stripe customer + default PM
billing_transactions   — one row per PaymentIntent, source of truth for credits
auto_topup_configs     — per-user auto top-up settings
affiliate_accounts     — opt-in per user
affiliate_referrals    — 1 row per referred user (at most)
affiliate_commissions  — 1 row per commission event
```

Full DDL in `migrations/028_billing_and_affiliate.sql`.

---

## 6. Worker Endpoint Deltas

All new routes go in a new `lib/billing.js` and `lib/affiliate.js` module, registered
in `worker.js` under `/billing/*` and `/affiliate/*`. Auth: Supabase JWT or API key.

### 6.1 Billing endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | /billing/balance | API key | Current credit balance (tier alloc + purchased) |
| GET | /billing/packages | public | List credit packages with prices |
| POST | /billing/setup-intent | JWT | Create SetupIntent to save a card |
| POST | /billing/set-default-pm | JWT | Attach + set default PaymentMethod |
| GET | /billing/payment-methods | JWT | List saved PMs for the customer |
| DELETE | /billing/payment-methods/:id | JWT | Detach a PaymentMethod |
| POST | /billing/purchase | JWT or API key | Create PaymentIntent for a package |
| GET | /billing/transactions | JWT or API key | Paginated transaction history |
| GET | /billing/auto-topup | JWT or API key | Get auto top-up config |
| PUT | /billing/auto-topup | JWT or API key | Update auto top-up config |

Extend existing webhook handler at `POST /webhooks/stripe` for `payment_intent.succeeded`.

### 6.2 Affiliate endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | /affiliate/join | JWT | Opt in, generates referral code |
| GET | /affiliate/info | JWT or API key | Referral code, link, stats summary |
| GET | /affiliate/commissions | JWT or API key | Paginated commission history |
| POST | /affiliate/payout-request | JWT | Request a payout (manual review) |
| GET | /admin/affiliate/overview | admin | All affiliates + commission totals |

### 6.3 Public dashboard UI new pages

| File | Purpose |
|------|---------|
| `public/billing.html` | Member billing dashboard: balance, packages, saved card, auto top-up, history |
| `public/affiliate.html` | Affiliate dashboard: referral link, stats tiles, commission table, payout button |

The existing `public/admin.html` gets a new "Affiliate Overview" section and a
"Billing Transactions" section. No changes to existing tiles.

---

## 7. Implementation Waves

### W1 — Credit purchase flow (backend only)
**Task:** Supabase migration + credit packages constant + `POST /billing/purchase` + webhook
`payment_intent.succeeded` handler + `GET /billing/balance` + `GET /billing/packages`.
No UI, no saved card yet.
**Estimated turns:** 6–8

### W2 — Saved card + auto top-up
**Task:** `POST /billing/setup-intent`, `POST /billing/set-default-pm`, `GET/DELETE /billing/payment-methods`,
`GET/PUT /billing/auto-topup`. Wire auto top-up check into `trackUsage()` via `waitUntil()`.
KV cooldown key. Update webhook handler to respect cooldown.
**Estimated turns:** 6–8

### W3 — Member billing dashboard (`public/billing.html`)
**Task:** New static HTML page served by Cloudflare Assets. Balance tile, 4 package tiles,
saved card section with Stripe.js SetupIntent flow, auto top-up toggle + config form,
transaction history table (paginated). Mirror KIE UX as reference.
**Estimated turns:** 6–8

### W4 — Affiliate program backend
**Task:** `POST /affiliate/join`, `GET /affiliate/info`, `GET /affiliate/commissions`,
`POST /affiliate/payout-request`, `GET /admin/affiliate/overview`. Referral code generation.
Attribution hook in `handleProvisionKey`. Commission calculation in webhook handler.
**Estimated turns:** 6–8

### W5 — Affiliate dashboard (`public/affiliate.html`)
**Task:** New static HTML page. Referral link with copy-to-clipboard, stats tiles
(clicks / signups / commissions earned / pending payout), commission history table,
payout request button. Wire to W4 endpoints.
**Estimated turns:** 4–6

---

## 8. Constraints and Decisions

- **No `stripe` npm package** — use the existing `stripeRequest()` raw fetch helper, promoted
  to `lib/stripe.js`. Keeps the CF Worker bundle lean (<1 MB total).
- **KV for balance cache, Supabase for ledger** — KV is fast but eventually consistent;
  Supabase `billing_transactions` is the authoritative credit source of truth.
- **Auto top-up cooldown in KV** — Supabase round-trip is too slow to gate auto top-up
  (would add ~100 ms to every generation). KV TTL key is the correct pattern.
- **Credits never expire** — purchased `creditBalance` persists in KV user record and
  Supabase; monthly tier allocation resets but purchased balance does not.
- **Affiliate attribution is first-touch** — simpler to audit, acceptable for launch.
- **Payout: manual Stripe transfers MVP** — Stripe Connect adds 2-3 days of onboarding UX;
  defer to W6+ unless Ty explicitly requests it.

---

## 9. Open Questions for Ty

1. **Credit model:** Should purchased credits fully replace tier monthly allocations (pure
   prepaid like KIE), or layer on top (tier allocation + top-up pool)? Current plan assumes
   layered. Fully prepaid would require removing `monthlyCredits` from `TIERS`.

2. **Payment methods:** Is Card + Apple Pay sufficient for launch, or must PayPal and BTC
   be available at the same time? PayPal/BTC require different integrations (not Stripe).

3. **Affiliate commission rate:** 10% of purchase for 12 months post-first-payment — confirm
   this rate, window, and whether it applies to subscription revenue as well as credit purchases.

4. **Auto top-up scope:** Does auto top-up apply only to credit-balance users, or also
   trigger a subscription upgrade for tier users who hit their monthly limit?

5. **Stripe Connect:** Should affiliate payouts use Stripe Connect Express (users fill out
   payout info themselves) or manual transfer via Ty in Stripe Dashboard for MVP?

6. **Referral attribution:** Should existing users (signed up before affiliate launch) be
   retroactively attributable if they enter a referral code in their profile?
