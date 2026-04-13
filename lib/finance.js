/**
 * lib/finance.js -- Stripe webhook finance sync + MRR calculation
 *
 * Handles the finance side-effects of Stripe webhook events:
 *   1. Upsert stripe_payments row
 *   2. Insert transactions record
 *   3. Send Telegram notification
 *
 * Also provides MRR sync from live Stripe subscription data.
 *
 * Secrets required:
 *   STRIPE_SECRET_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY,
 *   TELEGRAM_BOT_TOKEN (optional), TELEGRAM_CHAT_ID (optional)
 */

import { stripeRequest } from './stripe.js';
import { notifyTransaction, sendTelegram } from './telegram.js';

// ── Supabase helpers (local to this module) ────────────────────────────────

async function supabaseUpsert(env, table, row, onConflict) {
	const headers = {
		'apikey': env.SUPABASE_SERVICE_KEY,
		'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
		'Content-Type': 'application/json',
		'Prefer': `resolution=merge-duplicates,return=representation`,
	};
	const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}`, {
		method: 'POST',
		headers,
		body: JSON.stringify(row),
	});
	if (!res.ok) {
		const err = await res.text().catch(() => String(res.status));
		console.log(`[Finance] Supabase upsert ${table} failed: ${err}`);
		return null;
	}
	const data = await res.json();
	return Array.isArray(data) ? data[0] : data;
}

async function supabaseInsert(env, table, row) {
	const headers = {
		'apikey': env.SUPABASE_SERVICE_KEY,
		'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
		'Content-Type': 'application/json',
		'Prefer': 'return=representation',
	};
	const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}`, {
		method: 'POST',
		headers,
		body: JSON.stringify(row),
	});
	if (!res.ok) {
		const err = await res.text().catch(() => String(res.status));
		console.log(`[Finance] Supabase insert ${table} failed: ${err}`);
		return null;
	}
	const data = await res.json();
	return Array.isArray(data) ? data[0] : data;
}

async function supabaseQuery(env, table, params = '') {
	const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}${params ? '?' + params : ''}`, {
		headers: {
			'apikey': env.SUPABASE_SERVICE_KEY,
			'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
		},
	});
	if (!res.ok) return null;
	return res.json();
}

// ── Event type → transaction category mapping ──────────────────────────────

const EVENT_CATEGORIES = {
	'checkout.session.completed': 'purchase',
	'invoice.paid': 'subscription_renewal',
	'invoice.payment_failed': 'payment_failed',
	'customer.subscription.created': 'new_subscription',
	'customer.subscription.deleted': 'churn',
	'charge.succeeded': 'charge',
	'payment_intent.succeeded': 'payment',
};

// ── Extract common fields from different Stripe event types ────────────────

function extractEventData(event) {
	const obj = event.data.object;
	const type = event.type;

	let email = null;
	let amountCents = 0;
	let currency = 'usd';
	let description = null;
	let stripeCustomerId = null;
	let stripePaymentIntentId = null;
	let status = 'succeeded';

	switch (type) {
		case 'checkout.session.completed': {
			email = obj.customer_email || obj.customer_details?.email || obj.metadata?.email;
			amountCents = obj.amount_total || 0;
			currency = obj.currency || 'usd';
			description = obj.metadata?.product_name || obj.metadata?.tier || 'Checkout';
			stripeCustomerId = obj.customer;
			stripePaymentIntentId = obj.payment_intent;
			break;
		}
		case 'invoice.paid': {
			email = obj.customer_email;
			amountCents = obj.amount_paid || 0;
			currency = obj.currency || 'usd';
			description = obj.lines?.data?.[0]?.description || 'Invoice payment';
			stripeCustomerId = obj.customer;
			stripePaymentIntentId = obj.payment_intent;
			break;
		}
		case 'invoice.payment_failed': {
			email = obj.customer_email;
			amountCents = obj.amount_due || 0;
			currency = obj.currency || 'usd';
			description = 'Payment failed';
			stripeCustomerId = obj.customer;
			stripePaymentIntentId = obj.payment_intent;
			status = 'failed';
			break;
		}
		case 'customer.subscription.created': {
			email = obj.metadata?.email || null;
			const item = obj.items?.data?.[0];
			amountCents = item?.price?.unit_amount || 0;
			currency = item?.price?.currency || 'usd';
			description = `New subscription: ${item?.price?.nickname || item?.plan?.nickname || 'plan'}`;
			stripeCustomerId = obj.customer;
			break;
		}
		case 'customer.subscription.deleted': {
			email = obj.metadata?.email || null;
			const cancelItem = obj.items?.data?.[0];
			amountCents = cancelItem?.price?.unit_amount || 0;
			currency = cancelItem?.price?.currency || 'usd';
			description = `Subscription cancelled: ${cancelItem?.price?.nickname || 'plan'}`;
			stripeCustomerId = obj.customer;
			status = 'cancelled';
			break;
		}
		case 'charge.succeeded': {
			email = obj.billing_details?.email || obj.receipt_email;
			amountCents = obj.amount || 0;
			currency = obj.currency || 'usd';
			description = obj.description || 'Charge';
			stripeCustomerId = obj.customer;
			stripePaymentIntentId = obj.payment_intent;
			break;
		}
		case 'payment_intent.succeeded': {
			email = obj.receipt_email || obj.metadata?.email || obj.charges?.data?.[0]?.billing_details?.email;
			amountCents = obj.amount || 0;
			currency = obj.currency || 'usd';
			description = obj.description || 'Payment';
			stripeCustomerId = obj.customer;
			stripePaymentIntentId = obj.id;
			break;
		}
	}

	return { email, amountCents, currency, description, stripeCustomerId, stripePaymentIntentId, status };
}

// ── Main handler: process finance side-effects for a Stripe event ──────────

/**
 * Process finance side-effects for a verified Stripe webhook event.
 * Called from the existing handleStripeWebhook in auth.js AFTER its own logic.
 *
 * @param {object} event  Parsed Stripe event
 * @param {object} env    CF Worker env
 */
export async function processFinanceEvent(event, env) {
	if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) {
		console.log('[Finance] Supabase not configured, skipping finance sync');
		return;
	}

	const category = EVENT_CATEGORIES[event.type];
	if (!category) return; // Not a finance-relevant event

	const data = extractEventData(event);
	const obj = event.data.object;
	const isNegative = event.type === 'invoice.payment_failed' || event.type === 'customer.subscription.deleted';

	// 1. Upsert stripe_payments (skip for subscription lifecycle events without a payment)
	if (data.stripePaymentIntentId && data.amountCents > 0) {
		await supabaseUpsert(env, 'stripe_payments', {
			stripe_payment_intent_id: data.stripePaymentIntentId,
			stripe_customer_id: data.stripeCustomerId,
			email: data.email,
			amount_cents: data.amountCents,
			currency: data.currency,
			status: data.status,
			description: data.description,
			metadata: obj.metadata || {},
			created_at: obj.created ? new Date(obj.created * 1000).toISOString() : new Date().toISOString(),
		});
	}

	// 2. Insert transactions record (for the Finance tab)
	if (data.amountCents > 0 || event.type === 'customer.subscription.deleted') {
		await supabaseInsert(env, 'transactions', {
			type: isNegative ? 'expense' : 'income',
			source: 'stripe',
			category,
			amount: data.amountCents / 100,
			currency: data.currency,
			description: data.description,
			date: new Date().toISOString(),
			metadata: {
				stripe_event_id: event.id,
				stripe_event_type: event.type,
				stripe_customer_id: data.stripeCustomerId,
				email: data.email,
			},
		});
	}

	// 3. Send Telegram notification (non-blocking, fire-and-forget)
	if (data.amountCents > 0 && data.status !== 'failed') {
		notifyTransaction(env, {
			amount_cents: data.amountCents,
			currency: data.currency,
			type: category,
			email: data.email,
			description: data.description,
			source: 'Stripe',
		}).catch(err => console.log(`[Finance] Telegram notification error: ${err.message}`));
	}

	// For failed payments, send a different notification
	if (data.status === 'failed') {
		const amount = (data.amountCents / 100).toFixed(2);
		sendTelegram(env, [
			'\u{26A0}\u{FE0F} *Payment Failed*',
			'',
			`Amount: $${amount} ${data.currency.toUpperCase()}`,
			`Customer: ${data.email || 'unknown'}`,
			`Description: ${data.description}`,
		].join('\n')).catch(() => {});
	}

	console.log(`[Finance] Processed ${event.type}: ${data.email || 'unknown'}, $${(data.amountCents / 100).toFixed(2)}`);
}

// ── MRR Sync ───────────────────────────────────────────────────────────────

/**
 * Fetch all active Stripe subscriptions, calculate MRR, and upsert
 * the result into the Supabase `integrations` table.
 *
 * @param {object} env  CF Worker env
 * @returns {Promise<{ mrr: number, active_subscribers: number, subscriptions: Array }>}
 */
export async function syncMRR(env) {
	if (!env.STRIPE_SECRET_KEY) {
		return { error: 'STRIPE_SECRET_KEY not configured' };
	}

	// Paginate through all active subscriptions
	let subscriptions = [];
	let hasMore = true;
	let startingAfter = null;

	while (hasMore) {
		const params = { status: 'active', limit: '100' };
		if (startingAfter) params.starting_after = startingAfter;

		const result = await stripeRequest('GET', '/subscriptions?' + new URLSearchParams(params).toString(), null, env);

		if (result.error) {
			return { error: `Stripe API error: ${result.error.message}` };
		}

		subscriptions = subscriptions.concat(result.data || []);
		hasMore = result.has_more;
		if (result.data?.length > 0) {
			startingAfter = result.data[result.data.length - 1].id;
		}
	}

	// Calculate MRR (normalize all intervals to monthly)
	let mrrCents = 0;
	for (const sub of subscriptions) {
		for (const item of (sub.items?.data || [])) {
			const price = item.price;
			const qty = item.quantity || 1;
			const unitAmount = price.unit_amount || 0;
			const interval = price.recurring?.interval;
			const intervalCount = price.recurring?.interval_count || 1;

			let monthlyAmount = 0;
			switch (interval) {
				case 'month':
					monthlyAmount = (unitAmount * qty) / intervalCount;
					break;
				case 'year':
					monthlyAmount = (unitAmount * qty) / (12 * intervalCount);
					break;
				case 'week':
					monthlyAmount = (unitAmount * qty * 4.33) / intervalCount;
					break;
				case 'day':
					monthlyAmount = (unitAmount * qty * 30.44) / intervalCount;
					break;
			}
			mrrCents += monthlyAmount;
		}
	}

	const mrr = Math.round(mrrCents) / 100;
	const activeSubscribers = subscriptions.length;

	// Upsert into integrations table (Finance tab reads from here)
	if (env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY) {
		await supabaseUpsert(env, 'integrations', {
			provider: 'stripe',
			key: 'mrr_sync',
			data: {
				mrr,
				active_subscribers: activeSubscribers,
				synced_at: new Date().toISOString(),
			},
			updated_at: new Date().toISOString(),
		});
	}

	return { mrr, active_subscribers: activeSubscribers, subscription_count: subscriptions.length };
}
