/**
 * Eternium API — Auth & Admin Module
 * Self-serve signup, Stripe integration, admin dashboard data.
 *
 * Secrets needed:
 *   STRIPE_SECRET_KEY      — Stripe API key (sk_live_...)
 *   STRIPE_WEBHOOK_SECRET  — Stripe webhook signing secret (whsec_...)
 *   ADMIN_EMAIL            — Admin email (ty@eternium.ai)
 *   SUPABASE_JWT_SECRET    — Supabase JWT signing secret (HS256)
 *   SUPABASE_PROJECT_REF   — Supabase project ref for issuer validation (env var in wrangler.toml)
 *
 * KV Namespaces:
 *   USERS          — User records by email  { email, passwordHash, name, tier, apiKey, stripeCustomerId, createdAt, active }
 *   API_KEYS       — API key → user lookup  { key, email, name, tier, rateLimit, createdAt }
 *   USAGE          — Per-key usage data
 */

import { handleProvisionTenant, handleUpdateTenant } from './tenant.js';

// ── Tier → Stripe Price ID mapping ──────────────────────────────
// Create these products/prices in Stripe Dashboard, then paste IDs here.
const STRIPE_PRICES = {
	starter: 'price_1TDYXRIyAjP5WeLpNtfCtiCB',    // $29/mo
	builder: 'price_1TDYXTIyAjP5WeLpVz7mCzG6',    // $79/mo
	scale: 'price_1TDYXVIyAjP5WeLpWo6KL0oE',      // $199/mo
};

// ── One-time product purchases (Armory products) ───────────────
// Stripe product → GitHub repo mapping. When a checkout completes
// for one of these products, the customer's GitHub username (from
// checkout metadata) gets invited as a collaborator on the repo.
const ARMORY_PRODUCTS = {
	'prod_UHejbvU2MKbD2b': {
		name: 'Content System Pro',
		repo: 'EterniumAI/armory-content-system-pro',
		prices: {
			founding: 'price_1TJ5PnIyAjP5WeLps63x8sh6',  // $297 Founding 20
			standard: 'price_1TJ5PnIyAjP5WeLp9xtyyeGp',  // $497 Standard
		},
	},
};

// ── Managed Hosting tier → Stripe Price ID mapping ────────────
// Create these in Stripe Dashboard, then paste IDs here.
const HOSTING_PRICES = {
	starter: 'price_1TJNw0IyAjP5WeLp7vxHkE2e',     // $29/mo
	pro: 'price_1TJNwjIyAjP5WeLpMI25csJ0',          // $79/mo
	enterprise: 'price_1TJO02IyAjP5WeLpvDLUVsWs',   // $299/mo
};

const VALID_HOSTING_TIERS = new Set(['starter', 'pro', 'enterprise']);
const TENANT_SLUG_RE = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;

const MRR_VALUES = { free: 0, starter: 29, builder: 79, scale: 199, enterprise: 0, partner: 0, internal: 0 };

// ── Crypto helpers ──────────────────────────────────────────────
function generateApiKey() {
	const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
	const rand = Array.from(crypto.getRandomValues(new Uint8Array(32)))
		.map(b => chars[b % chars.length]).join('');
	return `etrn_${rand}`;
}

// ── Supabase JWT verification (HS256 + RS256, base64url) ───────
function base64UrlDecode(str) {
	return atob(str.replace(/-/g, '+').replace(/_/g, '/'));
}

async function verifySupabaseJWT(token, secret, expectedIssuer) {
	try {
		const parts = token.split('.');
		if (parts.length !== 3) return null;
		const [header, body, sig] = parts;

		const key = await crypto.subtle.importKey(
			'raw', new TextEncoder().encode(secret),
			{ name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
		);
		const sigBytes = Uint8Array.from(base64UrlDecode(sig), c => c.charCodeAt(0));
		const valid = await crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(`${header}.${body}`));
		if (!valid) return null;

		const payload = JSON.parse(base64UrlDecode(body));
		if (payload.exp !== undefined && payload.exp !== null && payload.exp < Math.floor(Date.now() / 1000)) return null;
		if (!payload.email) return null;
		if (expectedIssuer && payload.iss !== expectedIssuer) return null;

		return payload;
	} catch { return null; }
}

// ── JWKS cache for RS256 verification ──────────────────────────
const _jwksCache = new Map(); // issuer -> { keys, fetchedAt }
const JWKS_CACHE_MS = 3_600_000; // 1 hour

async function fetchJwks(issuer) {
	const cached = _jwksCache.get(issuer);
	if (cached && Date.now() - cached.fetchedAt < JWKS_CACHE_MS) return cached.keys;
	try {
		const res = await fetch(`${issuer}/.well-known/jwks.json`);
		if (!res.ok) return null;
		const { keys } = await res.json();
		if (!Array.isArray(keys)) return null;
		_jwksCache.set(issuer, { keys, fetchedAt: Date.now() });
		return keys;
	} catch { return null; }
}

async function verifyJwtRS256(token, issuer) {
	try {
		const parts = token.split('.');
		if (parts.length !== 3) return null;
		const [headerB64, bodyB64, sigB64] = parts;

		const header  = JSON.parse(base64UrlDecode(headerB64));
		const payload = JSON.parse(base64UrlDecode(bodyB64));

		if (header.alg !== 'RS256') return null;
		if (payload.exp !== undefined && payload.exp !== null && payload.exp < Math.floor(Date.now() / 1000)) return null;
		if (!payload.email) return null;
		if (issuer && payload.iss !== issuer) return null;

		const keys = await fetchJwks(issuer);
		if (!keys || keys.length === 0) return null;

		// Prefer the key matching the token's kid; fall back to first key
		const jwk = header.kid ? (keys.find(k => k.kid === header.kid) || keys[0]) : keys[0];
		if (!jwk) return null;

		const cryptoKey = await crypto.subtle.importKey(
			'jwk', jwk,
			{ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
			false, ['verify']
		);
		const sigBytes = Uint8Array.from(base64UrlDecode(sigB64), c => c.charCodeAt(0));
		const data = new TextEncoder().encode(`${headerB64}.${bodyB64}`);
		const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', cryptoKey, sigBytes, data);
		return valid ? payload : null;
	} catch { return null; }
}

// Resolve JWT auth — accepts Supabase HS256 (SUPABASE_JWT_SECRET) and RS256 (JWKS).
// Returns { email, source: 'supabase', supabaseUid } or null.
export async function resolveJWTAuth(token, env) {
	if (!token) return null;

	const projectRef = env.SUPABASE_PROJECT_REF || 'wmahfjguvqvefgjpbcdc';
	const issuer = `https://${projectRef}.supabase.co/auth/v1`;

	// HS256 path (requires secret; fast, no network)
	if (env.SUPABASE_JWT_SECRET) {
		const payload = await verifySupabaseJWT(token, env.SUPABASE_JWT_SECRET, issuer);
		if (payload) return { email: payload.email, source: 'supabase', supabaseUid: payload.sub };
	}

	// RS256 path via JWKS (network, cached 1 hour)
	const rs256Payload = await verifyJwtRS256(token, issuer);
	if (rs256Payload) return { email: rs256Payload.email, source: 'supabase', supabaseUid: rs256Payload.sub };

	return null;
}

// Ensure a KV user record exists for a Supabase-authed user. Returns the user object.
export async function ensureSupabaseUser(email, supabaseUid, env) {
	const lowerEmail = email.toLowerCase();
	let user = await getUser(env, lowerEmail);

	if (user) {
		if (!user.supabaseUid && supabaseUid) {
			user.supabaseUid = supabaseUid;
			await saveUser(env, user);
		}
		return user;
	}

	// Write user record first (sentinel) to minimize race window
	const newUser = {
		email: lowerEmail,
		name: lowerEmail.split('@')[0],
		passwordHash: null,
		tier: 'free',
		apiKey: null,
		supabaseUid,
		stripeCustomerId: null,
		createdAt: new Date().toISOString(),
		active: true,
	};
	await saveUser(env, newUser);

	// Re-read to catch concurrent writes (another request may have provisioned first)
	return await getUser(env, lowerEmail);
}

// Resolve a Supabase-authed user to KV API key data. Auto-provisions if user is new.
export async function resolveSupabaseUser(email, supabaseUid, env) {
	const user = await ensureSupabaseUser(email, supabaseUid, env);
	if (!user) return null;

	if (user.apiKey && env.API_KEYS) {
		const keyData = await env.API_KEYS.get(`key:${user.apiKey}`, 'json');
		if (keyData) return keyData;
	}

	// Provision API key (use whatever key the user record has after re-read)
	const apiKey = await provisionKey(env, user.email, user.tier || 'free', user.name);
	user.apiKey = apiKey;
	await saveUser(env, user);
	return env.API_KEYS ? await env.API_KEYS.get(`key:${apiKey}`, 'json') : null;
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
		rateLimit: { free: 10, starter: 30, builder: 45, scale: 60, enterprise: 120, internal: 200 }[tier] || 10,
		createdAt: new Date().toISOString(),
	};

	// Save to API_KEYS KV
	if (env.API_KEYS) {
		await env.API_KEYS.put(`key:${apiKey}`, JSON.stringify(keyData));
	}

	return apiKey;
}

// ── Route handlers ──────────────────────────────────────────────

export async function handleCheckout(request, env) {
	const authHeader = request.headers.get('Authorization') || '';
	const token = authHeader.replace('Bearer ', '');
	const auth = await resolveJWTAuth(token, env);
	if (!auth) return { error: 'Not authenticated', code: 401 };

	let body;
	try { body = await request.json(); }
	catch { return { error: 'Invalid body', code: 400 }; }

	const tier = body.tier;
	const priceId = STRIPE_PRICES[tier];
	if (!priceId || priceId.includes('REPLACE')) {
		return { error: `Stripe price not configured for tier: ${tier}. Set STRIPE_PRICES in auth.js.`, code: 500 };
	}

	let user = await ensureSupabaseUser(auth.email, auth.supabaseUid, env);
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
	const auth = await resolveJWTAuth(token, env);
	if (!auth) return { error: 'Not authenticated', code: 401 };

	let body;
	try { body = await request.json(); }
	catch { return { error: 'Invalid body', code: 400 }; }

	let user = await ensureSupabaseUser(auth.email, auth.supabaseUid, env);
	if (!user) return { error: 'User not found', code: 404 };

	// Don't allow re-provisioning if key exists (they should use regenerate)
	if (user.apiKey) {
		return { error: 'API key already exists. Use POST /auth/regenerate-key to rotate it.', code: 409 };
	}

	const isAdmin = user.email.toLowerCase() === (env.ADMIN_EMAIL || 'ty@eternium.ai').toLowerCase();
	const tier = isAdmin ? (body.tier || user.tier || 'free') : (user.tier || 'free');
	const apiKey = await provisionKey(env, user.email, tier, user.name);

	user.apiKey = apiKey;
	user.tier = tier;
	await saveUser(env, user);

	return { data: { api_key: apiKey, tier }, code: 200 };
}

export async function handleRegenerateKey(request, env) {
	let user = null;

	// Support API key auth (X-API-Key header or Bearer token that matches a key)
	const apiKey = request.headers.get('X-API-Key');
	const authHeader = request.headers.get('Authorization') || '';
	const bearerToken = authHeader.replace('Bearer ', '');

	if (apiKey || bearerToken) {
		const keyToCheck = apiKey || bearerToken;
		// Try API key lookup first
		if (env.API_KEYS) {
			try {
				const keyData = await env.API_KEYS.get(`key:${keyToCheck}`, 'json');
				if (keyData && keyData.email) {
					user = await getUser(env, keyData.email);
				}
			} catch { /* fall through to JWT */ }
		}
		// Fall back to JWT auth (custom or Supabase) if API key lookup didn't find a user
		if (!user) {
			const auth = await resolveJWTAuth(bearerToken, env);
			if (auth) {
				user = await getUser(env, auth.email);
			}
		}
	}

	if (!user) return { error: 'Not authenticated', code: 401 };
	if (!user.apiKey) return { error: 'No API key to regenerate. Use POST /auth/provision-key first.', code: 404 };

	// Revoke old key from API_KEYS KV
	const oldKey = user.apiKey;
	if (env.API_KEYS) {
		await env.API_KEYS.delete(`key:${oldKey}`);
	}

	// Provision new key with same tier
	const tier = user.tier || 'free';
	const newKey = await provisionKey(env, user.email, tier, user.name);

	user.apiKey = newKey;
	await saveUser(env, user);

	return {
		data: {
			api_key: newKey,
			tier,
			message: 'New API key generated. Your old key has been revoked immediately.',
		},
		code: 200,
	};
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

// ── GitHub App auth (preferred) ────────────────────────────────
// Signs an RS256 JWT with the App private key, exchanges it for an
// installation token (1 hr lifetime), caches the token in KV.
// Falls back to GITHUB_PAT if App is not configured or fails.

function b64urlFromBytes(bytes) {
	let str = '';
	for (const b of bytes) str += String.fromCharCode(b);
	return btoa(str).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function b64urlFromJSON(obj) {
	return btoa(JSON.stringify(obj)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function generateAppJWT(env) {
	const now = Math.floor(Date.now() / 1000);
	const payload = {
		iat: now - 60,              // 60s back-dated for clock skew
		exp: now + 600,             // 10 min lifetime (GitHub max)
		iss: env.GITHUB_APP_ID,     // App ID
	};

	const pem = env.GITHUB_APP_PRIVATE_KEY;
	const keyData = pem
		.replace(/-----BEGIN PRIVATE KEY-----/, '')
		.replace(/-----END PRIVATE KEY-----/, '')
		.replace(/-----BEGIN RSA PRIVATE KEY-----/, '')
		.replace(/-----END RSA PRIVATE KEY-----/, '')
		.replace(/\s/g, '');
	const binaryKey = Uint8Array.from(atob(keyData), c => c.charCodeAt(0));

	const cryptoKey = await crypto.subtle.importKey(
		'pkcs8',
		binaryKey,
		{ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
		false,
		['sign']
	);

	const header = { alg: 'RS256', typ: 'JWT' };
	const signingInput = `${b64urlFromJSON(header)}.${b64urlFromJSON(payload)}`;
	const sig = await crypto.subtle.sign(
		'RSASSA-PKCS1-v1_5',
		cryptoKey,
		new TextEncoder().encode(signingInput)
	);
	return `${signingInput}.${b64urlFromBytes(new Uint8Array(sig))}`;
}

async function getInstallationToken(env) {
	// Check KV cache (installation tokens last ~1 hour)
	const cached = await env.CACHE?.get('github_app_installation_token');
	if (cached) {
		try {
			const { token, expiresAt } = JSON.parse(cached);
			if (token && expiresAt > Date.now() + 60000) return token;
		} catch {}
	}

	const jwt = await generateAppJWT(env);
	const res = await fetch(
		`https://api.github.com/app/installations/${env.GITHUB_APP_INSTALLATION_ID}/access_tokens`,
		{
			method: 'POST',
			headers: {
				Authorization: `Bearer ${jwt}`,
				Accept: 'application/vnd.github+json',
				'X-GitHub-Api-Version': '2022-11-28',
				'User-Agent': 'Eternium-API-Worker',
			},
		}
	);

	if (!res.ok) {
		const err = await res.text();
		throw new Error(`GitHub App token exchange failed: ${res.status} ${err}`);
	}

	const data = await res.json();
	const expiresAt = new Date(data.expires_at).getTime();
	const ttlSeconds = Math.max(60, Math.floor((expiresAt - Date.now()) / 1000) - 60);

	await env.CACHE?.put(
		'github_app_installation_token',
		JSON.stringify({ token: data.token, expiresAt }),
		{ expirationTtl: ttlSeconds }
	);

	return data.token;
}

async function inviteViaToken(token, repo, githubUsername) {
	const [owner, repoName] = repo.split('/');
	const url = `https://api.github.com/repos/${owner}/${repoName}/collaborators/${githubUsername}`;
	const res = await fetch(url, {
		method: 'PUT',
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: 'application/vnd.github+json',
			'X-GitHub-Api-Version': '2022-11-28',
			'User-Agent': 'Eternium-API-Worker',
		},
		body: JSON.stringify({ permission: 'pull' }),
	});
	if (res.status === 201) return { ok: true, status: 'invited' };
	if (res.status === 204) return { ok: true, status: 'already-collaborator' };
	const body = await res.text();
	return { ok: false, status: res.status, error: body };
}

// ── GitHub repo invite for Armory product purchases ────────────
// Prefers GitHub App flow (auto-rotating installation tokens).
// Falls back to GITHUB_PAT for the 7-day soak period.
export async function inviteToGitHubRepo(env, repo, githubUsername) {
	if (!githubUsername) return { ok: false, error: 'Missing username' };

	// Try GitHub App flow first
	if (env.GITHUB_APP_ID && env.GITHUB_APP_INSTALLATION_ID && env.GITHUB_APP_PRIVATE_KEY) {
		try {
			const token = await getInstallationToken(env);
			const result = await inviteViaToken(token, repo, githubUsername);
			if (result.ok) {
				console.log(`[GitHub] invite via App: ${repo} -> ${githubUsername} (${result.status})`);
				return { ...result, via: 'app' };
			}
			console.warn(`[GitHub] App invite failed (${result.status}): ${result.error}. Falling back to PAT.`);
		} catch (err) {
			console.warn(`[GitHub] App flow threw: ${err.message}. Falling back to PAT.`);
		}
	}

	// Fallback: PAT (7-day soak period — remove after GitHub App flow is stable)
	if (!env.GITHUB_PAT) return { ok: false, error: 'No GitHub auth configured (App or PAT)' };
	const result = await inviteViaToken(env.GITHUB_PAT, repo, githubUsername);
	if (result.ok) console.log(`[GitHub] invite via PAT fallback: ${repo} -> ${githubUsername} (${result.status})`);
	return { ...result, via: 'pat' };
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

			// ── Armory product purchases (one-time, GitHub repo invite) ──
			const productId = session.metadata?.product_id;
			const armoryProduct = productId ? ARMORY_PRODUCTS[productId] : null;
			if (armoryProduct) {
				// Read github_username from metadata (website create-checkout flow)
				// or from custom_fields (Stripe Payment Links / native custom field flow)
				let githubUsername = session.metadata?.github_username;
				if (!githubUsername && Array.isArray(session.custom_fields)) {
					const field = session.custom_fields.find(f => f.key === 'github_username');
					githubUsername = field?.text?.value;
				}
				const customerEmail = session.customer_email || session.customer_details?.email || session.metadata?.email;
				if (githubUsername) {
					const result = await inviteToGitHubRepo(env, armoryProduct.repo, githubUsername.trim());
					console.log(`[Armory] ${armoryProduct.name}: invited ${githubUsername} → ${result.status || result.error}`);
				} else {
					console.log(`[Armory] ${armoryProduct.name}: no github_username in metadata or custom_fields, email=${customerEmail}. Manual invite needed.`);
				}
				break;
			}

			// ── Managed hosting provisioning ──
			const hostingTier = session.metadata?.hosting_tier;
			if (hostingTier) {
				if (!VALID_HOSTING_TIERS.has(hostingTier)) {
					console.log(`[Hosting] Invalid tier "${hostingTier}" in checkout metadata`);
					break;
				}
				const slug = session.metadata?.slug;
				const ownerEmail = session.customer_email || session.customer_details?.email || session.metadata?.email;
				const productSlug = session.metadata?.product_slug || 'imageforge';

				if (!slug || !TENANT_SLUG_RE.test(slug)) {
					console.log(`[Hosting] Invalid or missing slug "${slug}" in checkout metadata`);
					break;
				}
				if (!ownerEmail) {
					console.log(`[Hosting] No owner email in checkout for slug "${slug}"`);
					break;
				}

				const provisionBody = {
					slug,
					name: session.metadata?.company_name || slug,
					owner_email: ownerEmail,
					product_slug: productSlug,
					plan: hostingTier,
					stripe_customer_id: session.customer,
					stripe_subscription_id: session.subscription,
				};
				const fakeRequest = new Request('https://internal/provision', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(provisionBody),
				});
				const result = await handleProvisionTenant(fakeRequest, env);
				console.log(`[Hosting] Provisioned ${slug}: ${result.data ? 'OK' : result.error}`);
				break;
			}

			// ── API subscription provisioning (existing flow) ──
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
			const sub = event.data.object;
			const priceId = sub.items?.data?.[0]?.price?.id;

			// ── Hosting plan change ──
			const newHostingTier = Object.entries(HOSTING_PRICES).find(([, id]) => id === priceId)?.[0];
			if (newHostingTier && sub.metadata?.tenant_id) {
				const fakeReq = new Request(`https://internal/admin/tenants/${sub.metadata.tenant_id}`, {
					method: 'PATCH',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ plan: newHostingTier }),
				});
				const result = await handleUpdateTenant(sub.metadata.tenant_id, fakeReq, env);
				console.log(`[Hosting] Plan updated ${sub.metadata.tenant_id} -> ${newHostingTier}: ${result.data ? 'OK' : result.error}`);
				break;
			}

			// ── API tier change ──
			const newTier = Object.entries(STRIPE_PRICES).find(([, id]) => id === priceId)?.[0];
			if (newTier && sub.metadata?.email) {
				const user = await getUser(env, sub.metadata.email);
				if (user) {
					user.tier = newTier;
					await saveUser(env, user);
					if (user.apiKey && env.API_KEYS) {
						const keyData = await env.API_KEYS.get(`key:${user.apiKey}`, 'json');
						if (keyData) {
							keyData.tier = newTier;
							keyData.rateLimit = { free: 10, starter: 30, builder: 45, scale: 60, enterprise: 120, internal: 200 }[newTier] || 10;
							await env.API_KEYS.put(`key:${user.apiKey}`, JSON.stringify(keyData));
						}
					}
				}
			}
			break;
		}
		case 'customer.subscription.deleted': {
			const sub = event.data.object;

			// ── Hosting cancellation ──
			if (sub.metadata?.tenant_id) {
				const fakeReq = new Request(`https://internal/admin/tenants/${sub.metadata.tenant_id}`, {
					method: 'PATCH',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ status: 'cancelled' }),
				});
				const result = await handleUpdateTenant(sub.metadata.tenant_id, fakeReq, env);
				console.log(`[Hosting] Cancelled ${sub.metadata.tenant_id}: ${result.data ? 'OK' : result.error}`);
				break;
			}

			// ── API subscription downgrade to free ──
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
		case 'invoice.payment_failed': {
			// ── Suspend hosting tenant on payment failure ──
			const invoice = event.data.object;
			const subId = invoice.subscription;
			if (subId && env.TENANTS && env.SUPABASE_URL) {
				// Look up tenant by stripe_subscription_id
				try {
					const res = await fetch(
						`${env.SUPABASE_URL}/rest/v1/tenants?stripe_subscription_id=eq.${subId}&select=id&limit=1`,
						{ headers: { 'apikey': env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}` } }
					);
					const tenants = await res.json();
					if (tenants?.[0]?.id) {
						const fakeReq = new Request(`https://internal/admin/tenants/${tenants[0].id}`, {
							method: 'PATCH',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify({ status: 'suspended' }),
						});
						const result = await handleUpdateTenant(tenants[0].id, fakeReq, env);
						console.log(`[Hosting] Suspended ${tenants[0].id} (payment failed): ${result.data ? 'OK' : result.error}`);
					}
				} catch (err) {
					console.log(`[Hosting] Failed to suspend tenant for sub ${subId}: ${err.message}`);
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

	// 1 credit = $0.005  →  200 credits = $1.00
	const CREDITS_PER_USD = 200;

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

		// Model breakdown — tasks are stored as { model, credits, cached, ts }.
		// Convert credits to USD before accumulating revenue/cost.
		for (const task of (usage.tasks || [])) {
			if (!modelCounts[task.model]) modelCounts[task.model] = { count: 0, revenue: 0, cost: 0 };
			modelCounts[task.model].count++;
			const taskUSD = (task.credits || 0) / CREDITS_PER_USD;
			modelCounts[task.model].revenue += taskUSD;
			// Estimate Kie cost (~75% of our price, since we mark up ~30-35%)
			modelCounts[task.model].cost += taskUSD * 0.75;
		}

		enrichedUsers.push({
			email: user.email,
			name: user.name,
			tier: user.tier,
			key: user.apiKey,
			spent: usage.spent / CREDITS_PER_USD,   // USD for display
			credits: usage.spent,                    // raw credits
			generations: usage.generations,
			cached: usage.cached,
			created: user.createdAt,
			active: user.active,
			stripeCustomerId: user.stripeCustomerId,
		});
	}

	// totalSpent is in credits — convert to USD before financial calculations.
	const totalSpentUSD = totalSpent / CREDITS_PER_USD;
	const estimatedKieCost = totalSpentUSD * 0.75;
	const cacheHitRate = totalGens > 0 ? Math.round((totalCached / totalGens) * 100) : 0;

	// Generate alerts
	const alerts = [];
	if (estimatedKieCost > mrr * 0.8) {
		alerts.push({ level: 'danger', title: 'Cost Warning', message: `Kie.ai costs ($${estimatedKieCost.toFixed(2)}) are approaching your MRR ($${mrr.toFixed(2)}). Review pricing or reduce free tier.` });
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
			total_spent: totalSpentUSD,      // USD (was credits — fixed)
			total_credits: totalSpent,        // raw credit count for reference
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
			rateLimit: { free: 10, starter: 30, builder: 45, scale: 60, enterprise: 120, internal: 200 }[user.tier] || 10,
			createdAt: user.createdAt,
		}));
	}
	return { data: { activated: true, email }, code: 200 };
}

// ── Admin: test GitHub repo invite (bypasses Stripe webhook) ───
export async function handleAdminTestInvite(request, env) {
	const hasApp = env.GITHUB_APP_ID && env.GITHUB_APP_INSTALLATION_ID && env.GITHUB_APP_PRIVATE_KEY;
	if (!hasApp && !env.GITHUB_PAT) {
		return { error: 'No GitHub auth configured (need GitHub App or GITHUB_PAT)', code: 500 };
	}

	let body;
	try { body = await request.json(); }
	catch { return { error: 'Invalid JSON body', code: 400 }; }

	const { repo, github_username } = body;
	if (!repo || !github_username) {
		return { error: 'repo and github_username required', code: 400 };
	}
	if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repo)) {
		return { error: 'repo must be in "owner/name" format', code: 400 };
	}

	const result = await inviteToGitHubRepo(env, repo, github_username.trim());
	if (!result.ok) {
		return { error: result.error || 'Invite failed', data: result, code: result.status || 500 };
	}
	return { data: { repo, github_username, ...result }, code: 200 };
}
