/**
 * lib/stripe.js — Stripe integration stubs
 *
 * Cloudflare Worker runtime: no npm `stripe` package. All requests are raw
 * fetch calls to https://api.stripe.com/v1 using form-encoded bodies.
 * This mirrors the existing stripeRequest() helper in auth.js, extracted
 * here as the authoritative module for all billing-related Stripe calls.
 *
 * Secrets required (set via `wrangler secret put`):
 *   STRIPE_SECRET_KEY        — sk_live_... or sk_test_...
 *   STRIPE_WEBHOOK_SECRET    — whsec_...
 *
 * Usage:
 *   import { createCustomer, createSetupIntent, chargeCard, handleWebhook } from './lib/stripe.js';
 */

// ── Internal helper ──────────────────────────────────────────────────────────

/**
 * Make a raw request to the Stripe REST API.
 *
 * @param {'GET'|'POST'|'PATCH'|'DELETE'} method
 * @param {string} path  e.g. '/customers'
 * @param {Record<string,string>|null} body  Form-encoded fields (flat, no nesting helpers)
 * @param {object} env   Cloudflare Worker env with STRIPE_SECRET_KEY
 * @returns {Promise<object>}  Parsed JSON response from Stripe
 */
async function stripeRequest(method, path, body, env) {
	const res = await fetch(`https://api.stripe.com/v1${path}`, {
		method,
		headers: {
			Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
			'Content-Type': 'application/x-www-form-urlencoded',
		},
		body: body ? new URLSearchParams(body).toString() : undefined,
	});
	return res.json();
}

// ── Webhook signature verification ──────────────────────────────────────────

/**
 * Verify the Stripe-Signature header on an incoming webhook request.
 * Uses HMAC-SHA256 via the Web Crypto API (CF Workers native).
 *
 * @param {string} rawBody  Raw request body text (not parsed)
 * @param {string} sigHeader  Value of the Stripe-Signature header
 * @param {string} secret  Webhook signing secret (whsec_...)
 * @returns {Promise<boolean>}
 */
async function verifyStripeSignature(rawBody, sigHeader, secret) {
	const parts = sigHeader.split(',').reduce((acc, part) => {
		const [k, v] = part.split('=');
		acc[k] = v;
		return acc;
	}, {});

	const timestamp = parts.t;
	const signature = parts.v1;
	if (!timestamp || !signature) return false;

	const payload = `${timestamp}.${rawBody}`;
	const key = await crypto.subtle.importKey(
		'raw', new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
	);
	const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
	const expected = Array.from(new Uint8Array(sig))
		.map(b => b.toString(16).padStart(2, '0')).join('');
	return expected === signature;
}

// ── Customer management ──────────────────────────────────────────────────────

/**
 * Create a Stripe Customer for a new billing user.
 *
 * Called lazily — only when a user takes their first billing action
 * (card save or credit purchase). Returns the full Stripe Customer object.
 *
 * @param {string} userId   Eternium user identifier (email or UUID)
 * @param {string} email    Customer email address
 * @param {object} env      CF Worker env
 * @returns {Promise<{ id: string, email: string, [key: string]: any }>}
 */
export async function createCustomer(userId, email, env) {
	throw new Error('not yet implemented');
}

// ── SetupIntent (card save without charge) ───────────────────────────────────

/**
 * Create a Stripe SetupIntent so the client can save a card via Stripe.js.
 *
 * The client receives the `client_secret`, calls stripe.confirmCardSetup(),
 * and then POSTs the resulting `payment_method_id` to /billing/set-default-pm.
 *
 * @param {string} customerId  Stripe customer ID (cus_...)
 * @param {object} env         CF Worker env
 * @returns {Promise<{ client_secret: string, id: string }>}
 */
export async function createSetupIntent(customerId, env) {
	throw new Error('not yet implemented');
}

// ── PaymentIntent (charge saved card for credit purchase) ────────────────────

/**
 * Create and confirm a Stripe PaymentIntent using a saved payment method.
 *
 * If the customer has a default PM on file, pass it as paymentMethodId and
 * set confirm=true. If 3DS is required, the response will include a
 * next_action and the client must handle it via Stripe.js.
 *
 * IMPORTANT: Credits are added ONLY in the payment_intent.succeeded webhook,
 * never here. This prevents double-credits on retries.
 *
 * @param {string} customerId        Stripe customer ID (cus_...)
 * @param {string} paymentMethodId   Stripe PM ID (pm_...) — saved card to charge
 * @param {number} amountUsd         Purchase amount in USD (e.g. 5.00)
 * @param {string} description       Human-readable description for the charge
 * @param {Record<string,string>} metadata  Metadata attached to the PI (user_id, package_id, etc.)
 * @param {object} env               CF Worker env
 * @returns {Promise<{
 *   id: string,
 *   status: 'succeeded'|'requires_action'|'requires_payment_method',
 *   client_secret?: string,
 *   next_action?: object,
 * }>}
 */
export async function chargeCard(customerId, paymentMethodId, amountUsd, description, metadata, env) {
	throw new Error('not yet implemented');
}

// ── Webhook dispatcher ───────────────────────────────────────────────────────

/**
 * Verify and parse an incoming Stripe webhook request.
 *
 * Returns the parsed event object if the signature is valid, or null if
 * verification fails. The caller is responsible for acting on event.type.
 *
 * Supported event types for billing:
 *   payment_intent.succeeded       — add credits, record billing_transaction
 *   payment_intent.payment_failed  — mark transaction failed, notify user
 *   setup_intent.succeeded         — log card saved
 *
 * @param {string} rawBody     Raw request body (not JSON.parsed)
 * @param {string} signature   Value of the stripe-signature request header
 * @param {object} env         CF Worker env (needs STRIPE_WEBHOOK_SECRET)
 * @returns {Promise<object|null>}  Parsed Stripe Event or null on bad sig
 */
export async function handleWebhook(rawBody, signature, env) {
	throw new Error('not yet implemented');
}

// ── Payment method management ────────────────────────────────────────────────

/**
 * List all PaymentMethods attached to a Stripe Customer.
 *
 * @param {string} customerId  Stripe customer ID
 * @param {object} env         CF Worker env
 * @returns {Promise<Array<{ id: string, card: { brand: string, last4: string, exp_month: number, exp_year: number } }>>}
 */
export async function listPaymentMethods(customerId, env) {
	throw new Error('not yet implemented');
}

/**
 * Detach a PaymentMethod from a Customer (removes saved card).
 *
 * @param {string} paymentMethodId  PM to detach (pm_...)
 * @param {object} env              CF Worker env
 * @returns {Promise<{ id: string, customer: null }>}
 */
export async function detachPaymentMethod(paymentMethodId, env) {
	throw new Error('not yet implemented');
}

/**
 * Set the default payment method on a Stripe Customer.
 *
 * @param {string} customerId      Stripe customer ID
 * @param {string} paymentMethodId PM to set as default
 * @param {object} env             CF Worker env
 * @returns {Promise<object>}  Updated Stripe Customer object
 */
export async function setDefaultPaymentMethod(customerId, paymentMethodId, env) {
	throw new Error('not yet implemented');
}

// Re-export the low-level helper for use in auth.js migration path.
export { stripeRequest, verifyStripeSignature };
