/**
 * Eternium API — Auth & Admin Module
 * Self-serve signup, Stripe integration, admin dashboard data.
 *
 * Secrets needed:
 *   STRIPE_SECRET_KEY      — Stripe API key (sk_live_...)
 *   STRIPE_WEBHOOK_SECRET  — Stripe webhook signing secret (whsec_...)
 *   ADMIN_EMAIL            — Admin email (ty@eternium.ai)
 *   JWT_SECRET             — Token signing secret
 *
 * KV Namespaces:
 *   USERS          — User records by email  { email, passwordHash, name, tier, apiKey, stripeCustomerId, createdAt, active }
 *   API_KEYS       — API key → user lookup  { key, email, name, tier, rateLimit, createdAt }
 *   USAGE          — Per-key usage data
 */

// ── Tier → Stripe Price ID mapping ──────────────────────────────
// Create these products/prices in Stripe Dashboard, then paste IDs here.
const STRIPE_PRICES = {
	starter: 'price_1TDYXRIyAjP5WeLpNtfCtiCB',    // $29/mo
	builder: 'price_1TDYXTIyAjP5WeLpVz7mCzG6',    // $79/mo
	scale: 'price_1TDYXVIyAjP5WeLpWo6KL0oE',      // $199/mo
};

const MRR_VALUES = { free: 0, starter: 29, builder: 79, scale: 199, enterprise: 0 };

// ── Crypto helpers ──────────────────────────────────────────────
async function hashPassword(password, existingSalt = null) {
	const salt = existingSalt || crypto.getRandomValues(new Uint8Array(16));
	const keyMaterial = await crypto.subtle.importKey(
		'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']
	);
	const hash = await crypto.subtle.deriveBits(
		{ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
		keyMaterial, 256
	);
	const saltHex = Array.from(new Uint8Array(salt)).map(b => b.toString(16).padStart(2, '0')).join('');
	const hashHex = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
	return `${saltHex}:${hashHex}`;
}

async function verifyPassword(password, storedHash) {
	if (!storedHash || !storedHash.includes(':')) {
		const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(password));
		const legacyHash = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
		return legacyHash === storedHash;
	}
	const [saltHex] = storedHash.split(':');
	const salt = new Uint8Array(saltHex.match(/.{2}/g).map(b => parseInt(b, 16)));
	const newHash = await hashPassword(password, salt);
	return newHash === storedHash;
}

function generateApiKey() {
	const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
	const rand = Array.from(crypto.getRandomValues(new Uint8Array(32)))
		.map(b => chars[b % chars.length]).join('');
	return `etrn_${rand}`;
}

async function signJWT(payload, secret) {
	const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
	const body = btoa(JSON.stringify(payload));
	const msg = `${header}.${body}`;
	const key = await crypto.subtle.importKey(
		'raw', new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
	);
	const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
	return `${msg}.${btoa(String.fromCharCode(...new Uint8Array(sig)))}`;
}

async function verifyJWT(token, secret) {
	try {
		const [header, body, sig] = token.split('.');
		const key = await crypto.subtle.importKey(
			'raw', new TextEncoder().encode(secret),
			{ name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
		);
		const sigBytes = Uint8Array.from(atob(sig), c => c.charCodeAt(0));
		const valid = await crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(`${header}.${body}`));
		if (!valid) return null;
		const payload = JSON.parse(atob(body));
		if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
		return payload;
	} catch { return null; }
}

// ── Stripe helpers ──────────────────────────────────────────────
async function stripeRequest(method, path, body, env) {
	const res = await fetch(`https://api.stripe.com/v1${path}`, {
		method,
		headers: {
			'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
			'Content-Type': 'application/x-www-form-urlencoded',
		},
		body: body ? new URLSearchParams(body).toString() : undefined,
	});
	return res.json();
}

async function verifyStripeSignature(body, sigHeader, secret) {
	// Stripe webhook verification
	const parts = sigHeader.split(',').reduce((acc, part) => {
		const [key, val] = part.split('=');
		acc[key] = val;
		return acc;
	}, {});

	const timestamp = parts.t;
	const signature = parts.v1;
	if (!timestamp || !signature) return false;

	const payload = `${timestamp}.${body}`;
	const key = await crypto.subtle.importKey(
		'raw', new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
	);
	const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
	const expected = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
	return expected === signature;
}

// ── User management ─────────────────────────────────────────────
async function getUser(env, email) {
	if (!env.USERS) return null;
	try { return await env.USERS.get(`user:${email.toLowerCase()}`, 'json'); }
	catch { return null; }
}

async function saveUser(env, user) {
	if (!env.USERS) return;
	await env.USERS.put(`user:${user.email.toLowerCase()}`, JSON.stringify(user));
}

async function listAllUsers(env) {
	if (!env.USERS) return [];
	const list = await env.USERS.list({ prefix: 'user:' });
	const users = [];
	for (const key of list.keys) {
		const user = await env.USERS.get(key.name, 'json');
		if (user) users.push(user);
	}
	return users;
}

// ── Provision API key ───────────────────────────────────────────
async function provisionKey(env, email, tier, name) {
	const apiKey = generateApiKey();
	const keyData = {
		key: apiKey,
		email: email.toLowerCase(),
		name: name || email.split('@')[0],
		tier: tier || 'free',
		rateLimit: { free: 10, starter: 30, builder: 45, scale: 60, enterprise: 120 }[tier] || 10,
		createdAt: new Date().toISOString(),
	};

	// Save to API_KEYS KV
	if (env.API_KEYS) {
		await env.API_KEYS.put(`key:${apiKey}`, JSON.stringify(keyData));
	}

	return apiKey;
}

// ── Route handlers ──────────────────────────────────────────────

export async function handleSignup(request, env) {
	let body;
	try { body = await request.json(); }
	catch { return { error: 'Invalid request body', code: 400 }; }

	const { email, password, name } = body;
	if (!email || !password) return { error: 'Email and password required', code: 400 };
	if (password.length < 8) return { error: 'Password must be at least 8 characters', code: 400 };

	// Check existing
	const existing = await getUser(env, email);
	if (existing) return { error: 'Account already exists. Please sign in.', code: 409 };

	const passwordHash = await hashPassword(password);
	const user = {
		email: email.toLowerCase(),
		name: name || '',
		passwordHash,
		tier: 'free',
		apiKey: null,
		stripeCustomerId: null,
		createdAt: new Date().toISOString(),
		active: true,
	};

	await saveUser(env, user);

	if (!env.JWT_SECRET) return { error: 'Server misconfigured: JWT_SECRET not set', code: 500 };
	const secret = env.JWT_SECRET;
	const token = await signJWT({
		sub: user.email,
		iat: Math.floor(Date.now() / 1000),
		exp: Math.floor(Date.now() / 1000) + 3600,
	}, secret);

	return { data: { token, email: user.email }, code: 200 };
}

export async function handleLogin(request, env) {
	let body;
	try { body = await request.json(); }
	catch { return { error: 'Invalid request body', code: 400 }; }

	const { email, password } = body;
	if (!email || !password) return { error: 'Email and password required', code: 400 };

	const user = await getUser(env, email);
	if (!user) return { error: 'Invalid credentials', code: 401 };

	const valid = await verifyPassword(password, user.passwordHash);
	if (!valid) return { error: 'Invalid credentials', code: 401 };
	if (user.active === false) return { error: 'Account suspended', code: 403 };

	if (!env.JWT_SECRET) return { error: 'Server misconfigured: JWT_SECRET not set', code: 500 };
	const secret = env.JWT_SECRET;
	const token = await signJWT({
		sub: user.email,
		iat: Math.floor(Date.now() / 1000),
		exp: Math.floor(Date.now() / 1000) + 3600,
	}, secret);

	return { data: { token, email: user.email, api_key: user.apiKey }, code: 200 };
}

export async function handleCheckout(request, env) {
	const authHeader = request.headers.get('Authorization') || '';
	const token = authHeader.replace('Bearer ', '');
	if (!env.JWT_SECRET) return { error: 'Server misconfigured: JWT_SECRET not set', code: 500 };
	const secret = env.JWT_SECRET;
	const payload = await verifyJWT(token, secret);
	if (!payload) return { error: 'Not authenticated', code: 401 };

	let body;
	try { body = await request.json(); }
	catch { return { error: 'Invalid body', code: 400 }; }

	const tier = body.tier;
	const priceId = STRIPE_PRICES[tier];
	if (!priceId || priceId.includes('REPLACE')) {
		return { error: `Stripe price not configured for tier: ${tier}. Set STRIPE_PRICES in auth.js.`, code: 500 };
	}

	const user = await getUser(env, payload.sub);
	if (!user) return { error: 'User not found', code: 404 };

	// Create or get Stripe customer
	let customerId = user.stripeCustomerId;
	if (!customerId) {
		const customer = await stripeRequest('POST', '/customers', {
			email: user.email,
			name: user.name || undefined,
			'metadata[eternium_tier]': tier,
		}, env);
		customerId = customer.id;
		user.stripeCustomerId = customerId;
		await saveUser(env, user);
	}

	// Create Checkout Session
	const origin = new URL(request.url).origin;
	const session = await stripeRequest('POST', '/checkout/sessions', {
		customer: customerId,
		'line_items[0][price]': priceId,
		'line_items[0][quantity]': '1',
		mode: 'subscription',
		success_url: `${origin}/signup?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
		cancel_url: `${origin}/signup`,
		'metadata[email]': user.email,
		'metadata[tier]': tier,
	}, env);

	return { data: { checkout_url: session.url }, code: 200 };
}

export async function handleProvisionKey(request, env) {
	const authHeader = request.headers.get('Authorization') || '';
	const token = authHeader.replace('Bearer ', '');
	if (!env.JWT_SECRET) return { error: 'Server misconfigured: JWT_SECRET not set', code: 500 };
	const secret = env.JWT_SECRET;
	const payload = await verifyJWT(token, secret);
	if (!payload) return { error: 'Not authenticated', code: 401 };

	let body;
	try { body = await request.json(); }
	catch { return { error: 'Invalid body', code: 400 }; }

	const user = await getUser(env, payload.sub);
	if (!user) return { error: 'User not found', code: 404 };

	// Don't allow re-provisioning if key exists (they should use regenerate)
	if (user.apiKey) {
		return { error: 'API key already exists. Use /auth/regenerate-key to get a new one.', code: 409 };
	}

	const tier = body.tier || user.tier || 'free';
	const apiKey = await provisionKey(env, user.email, tier, user.name);

	user.apiKey = apiKey;
	user.tier = tier;
	await saveUser(env, user);

	return { data: { api_key: apiKey, tier }, code: 200 };
}

export async function handleStripeSuccess(request, env) {
	const url = new URL(request.url);
	const sessionId = url.searchParams.get('session_id');
	if (!sessionId) return { error: 'Missing session_id', code: 400 };

	// Retrieve checkout session from Stripe
	const session = await stripeRequest('GET', `/checkout/sessions/${sessionId}`, null, env);
	if (!session || session.payment_status !== 'paid') {
		return { error: 'Payment not completed', code: 402 };
	}

	const email = session.metadata?.email;
	const tier = session.metadata?.tier;
	if (!email) return { error: 'Missing email in session metadata', code: 500 };

	const user = await getUser(env, email);
	if (!user) return { error: 'User not found', code: 404 };

	// Provision key if they don't have one
	let apiKey = user.apiKey;
	if (!apiKey) {
		apiKey = await provisionKey(env, user.email, tier, user.name);
		user.apiKey = apiKey;
	}

	user.tier = tier;
	user.stripeSubscriptionId = session.subscription;
	await saveUser(env, user);

	return { data: { api_key: apiKey, tier, email }, code: 200 };
}

export async function handleStripeWebhook(request, env) {
	const body = await request.text();
	const sig = request.headers.get('stripe-signature');

	if (!env.STRIPE_WEBHOOK_SECRET || !sig) {
		return { error: 'Webhook verification not configured', code: 500 };
	}
	const sigValid = await verifyStripeSignature(body, sig, env.STRIPE_WEBHOOK_SECRET);
	if (!sigValid) return { error: 'Invalid signature', code: 400 };

	const event = JSON.parse(body);

	switch (event.type) {
		case 'checkout.session.completed': {
			const session = event.data.object;
			const email = session.metadata?.email;
			const tier = session.metadata?.tier;
			if (email && tier) {
				const user = await getUser(env, email);
				if (user) {
					if (!user.apiKey) {
						const apiKey = await provisionKey(env, user.email, tier, user.name);
						user.apiKey = apiKey;
					}
					user.tier = tier;
					user.stripeSubscriptionId = session.subscription;
					await saveUser(env, user);
				}
			}
			break;
		}
		case 'customer.subscription.updated': {
			// Handle tier changes
			const sub = event.data.object;
			const priceId = sub.items?.data?.[0]?.price?.id;
			const newTier = Object.entries(STRIPE_PRICES).find(([, id]) => id === priceId)?.[0];
			if (newTier && sub.metadata?.email) {
				const user = await getUser(env, sub.metadata.email);
				if (user) {
					user.tier = newTier;
					await saveUser(env, user);
					// Update API_KEYS KV too
					if (user.apiKey && env.API_KEYS) {
						const keyData = await env.API_KEYS.get(`key:${user.apiKey}`, 'json');
						if (keyData) {
							keyData.tier = newTier;
							keyData.rateLimit = { free: 10, starter: 30, builder: 45, scale: 60, enterprise: 120 }[newTier] || 10;
							await env.API_KEYS.put(`key:${user.apiKey}`, JSON.stringify(keyData));
						}
					}
				}
			}
			break;
		}
		case 'customer.subscription.deleted': {
			// Downgrade to free
			const sub = event.data.object;
			if (sub.metadata?.email) {
				const user = await getUser(env, sub.metadata.email);
				if (user) {
					user.tier = 'free';
					await saveUser(env, user);
					if (user.apiKey && env.API_KEYS) {
						const keyData = await env.API_KEYS.get(`key:${user.apiKey}`, 'json');
						if (keyData) {
							keyData.tier = 'free';
							keyData.rateLimit = 10;
							await env.API_KEYS.put(`key:${user.apiKey}`, JSON.stringify(keyData));
						}
					}
				}
			}
			break;
		}
	}

	return { data: { received: true }, code: 200 };
}

// ── Admin endpoints ─────────────────────────────────────────────

export async function handleAdminOverview(env) {
	const users = await listAllUsers(env);
	const month = new Date().toISOString().slice(0, 7);

	let totalSpent = 0;
	let totalGens = 0;
	let totalCached = 0;
	let payingUsers = 0;
	let mrr = 0;
	const modelCounts = {};

	const enrichedUsers = [];

	for (const user of users) {
		const usage = user.apiKey && env.USAGE
			? (await env.USAGE.get(`usage:${user.apiKey}:${month}`, 'json')) || { spent: 0, generations: 0, cached: 0, tasks: [] }
			: { spent: 0, generations: 0, cached: 0, tasks: [] };

		totalSpent += usage.spent;
		totalGens += usage.generations;
		totalCached += usage.cached;

		if (user.tier && user.tier !== 'free') {
			payingUsers++;
			mrr += MRR_VALUES[user.tier] || 0;
		}

		// Model breakdown
		for (const task of (usage.tasks || [])) {
			if (!modelCounts[task.model]) modelCounts[task.model] = { count: 0, revenue: 0, cost: 0 };
			modelCounts[task.model].count++;
			modelCounts[task.model].revenue += task.cost || 0;
			// Estimate Kie cost (~75% of our price, since we mark up ~30-35%)
			modelCounts[task.model].cost += (task.cost || 0) * 0.75;
		}

		enrichedUsers.push({
			email: user.email,
			name: user.name,
			tier: user.tier,
			key: user.apiKey,
			spent: usage.spent,
			generations: usage.generations,
			cached: usage.cached,
			created: user.createdAt,
			active: user.active,
			stripeCustomerId: user.stripeCustomerId,
		});
	}

	const estimatedKieCost = totalSpent * 0.75;
	const cacheHitRate = totalGens > 0 ? Math.round((totalCached / totalGens) * 100) : 0;

	// Generate alerts
	const alerts = [];
	if (estimatedKieCost > mrr * 0.8) {
		alerts.push({ level: 'danger', title: 'Cost Warning', message: `Kie.ai costs ($${estimatedKieCost.toFixed(2)}) are approaching your MRR ($${mrr}). Review pricing or reduce free tier.` });
	}
	if (users.filter(u => u.tier === 'free').length > users.length * 0.9 && users.length > 10) {
		alerts.push({ level: 'warning', title: 'Conversion Rate Low', message: `${Math.round((payingUsers / users.length) * 100)}% conversion. Consider limiting free tier or improving upgrade prompts.` });
	}
	if (cacheHitRate > 50) {
		alerts.push({ level: 'info', title: 'High Cache Rate', message: `${cacheHitRate}% cache hits — agents are benefiting from dedup. Highlight this in marketing.` });
	}

	return {
		data: {
			total_users: users.length,
			paying_users: payingUsers,
			mrr,
			total_spent: totalSpent,
			total_generations: totalGens,
			estimated_kie_cost: estimatedKieCost,
			cache_hit_rate: cacheHitRate,
			kie_status: 'OK',
			alerts,
			users: enrichedUsers.sort((a, b) => (b.spent || 0) - (a.spent || 0)),
			model_breakdown: Object.entries(modelCounts)
				.map(([model, d]) => ({ model, ...d }))
				.sort((a, b) => b.count - a.count),
		},
		code: 200,
	};
}

export async function handleAdminRevoke(email, env) {
	const user = await getUser(env, email);
	if (!user) return { error: 'User not found', code: 404 };
	user.active = false;
	await saveUser(env, user);
	// Remove API key
	if (user.apiKey && env.API_KEYS) {
		await env.API_KEYS.delete(`key:${user.apiKey}`);
	}
	return { data: { revoked: true, email }, code: 200 };
}

export async function handleAdminActivate(email, env) {
	const user = await getUser(env, email);
	if (!user) return { error: 'User not found', code: 404 };
	user.active = true;
	await saveUser(env, user);
	// Re-add API key
	if (user.apiKey && env.API_KEYS) {
		await env.API_KEYS.put(`key:${user.apiKey}`, JSON.stringify({
			key: user.apiKey,
			email: user.email,
			name: user.name,
			tier: user.tier,
			rateLimit: { free: 10, starter: 30, builder: 45, scale: 60, enterprise: 120 }[user.tier] || 10,
			createdAt: user.createdAt,
		}));
	}
	return { data: { activated: true, email }, code: 200 };
}
