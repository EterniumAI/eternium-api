/**
 * Eternium API v3 — Cloudflare Worker
 * AI generation API powered by Kie.ai infrastructure.
 * Credit-based economy: 1 credit = $0.005
 *
 * Environment variables (Cloudflare Dashboard or wrangler secret):
 *   KIE_API_KEY            — Kie.ai API key
 *   OPENAI_API_KEY         — OpenAI API key (for chat, embeddings, audio proxy)
 *   STRIPE_SECRET_KEY      — Stripe API key
 *   STRIPE_WEBHOOK_SECRET  — Stripe webhook signing secret
 *   JWT_SECRET             — Session token secret
 *   ADMIN_EMAIL            — Admin email (ty@eternium.ai)
 *
 * KV Namespaces (bind in wrangler.toml):
 *   API_KEYS        — API key records
 *   USERS           — User accounts
 *   USAGE           — Per-key usage tracking (in credits)
 *   CACHE           — Generation result cache
 */

import {
	handleSignup, handleLogin, handleCheckout, handleProvisionKey, handleRegenerateKey,
	handleStripeSuccess, handleStripeWebhook,
	handleAdminOverview, handleAdminRevoke, handleAdminActivate, handleAdminTestInvite,
	resolveJWTAuth, resolveSupabaseUser,
} from './auth.js';

import {
	resolveTenant, validateTenantStatus, handleGetTenant,
	handleProvisionTenant, handleListTenants, handleUpdateTenant,
} from './tenant.js';

import {
	handleMediaUpload, handleMediaServe, handleMediaDelete,
} from './media.js';

const KIE_BASE = 'https://api.kie.ai/api/v1';
const API_VERSION = '3.0.0';
const CREDIT_VALUE = 0.005; // 1 credit = $0.005 (200 credits per dollar)

// CORS: Open to all origins. Security is enforced by API key authentication,
// not by origin restrictions. Every major API (OpenAI, Stripe, Twilio) does this.
// CORS is a browser-only mechanism and provides zero protection against
// server-side callers. The API key in X-API-Key header is the auth boundary.
//
// Sensitive internal origins get explicit matching for Vary/caching correctness.
const INTERNAL_ORIGINS = new Set([
	'https://eternium.ai',
	'https://api.eternium.ai',
	'https://helix.eternium.ai',
]);
// Managed hosting tenant domains also treated as internal for CORS
const TENANT_DOMAIN_SUFFIX = '.app.eternium.ai';

// ── Kie.ai base costs (USD) ────────────────────────────────────
// Image models: flat per-image cost
// Video models: nested by mode/resolution → duration
const KIE_COSTS = {
	// ── Image ──
	'nano-banana-2':    0.045,
	'nano-banana-pro':  0.03,
	'gpt-5.4-image':    0.05,
	'flux-kontext':     0.04,
	'seedream-5':       0.03,
	'qwen-image-2':     0.03,
	'midjourney':       0.04,
	// ── Video ──
	'kling-3.0':    { std: { 5: 0.35, 10: 0.65 }, pro: { 5: 0.55, 10: 1.10 } },
	'kling-3.0-mc': { std: { 5: 0.55, 10: 1.00 }, pro: { 5: 0.75, 10: 1.40 } },
	'kling-2.6':    { std: { 5: 0.28, 10: 0.55 }, pro: { 5: 0.45, 10: 0.90 } },
	'veo-3':        { fast: { 5: 0.40, 10: 0.80 }, quality: { 5: 1.00, 10: 2.00 } },
	'sora-2':       { std: { 5: 0.50, 10: 1.00 }, pro: { 5: 1.00, 10: 2.00 } },
	'wan-2.6':      { '720p': { 5: 0.30, 10: 0.60 }, '1080p': { 5: 0.50, 10: 1.00 } },
	'hailuo-2.3':   { std: { 5: 0.28, 10: 0.55 }, pro: { 5: 0.49, 10: 0.95 } },
	'seedance-2':   { std: { 5: 0.35, 10: 0.70 }, pro: { 5: 0.55, 10: 1.10 } },
};

// ── OpenAI base costs (USD per 1M tokens) ──────────────────────
const OPENAI_COSTS = {
	'gpt-5.1':             { input: 0.63,  output: 5.00 },
	'gpt-5.1-codex-mini':  { input: 0.25,  output: 2.00 },
	'gpt-5.4':             { input: 1.25,  output: 10.00 },
	'text-embedding-3-small': { input: 0.02, output: 0 },
	'text-embedding-3-large': { input: 0.13, output: 0 },
	'whisper-1':           { perMinute: 0.006 },
};

// ── Markup multipliers ──────────────────────────────────────────
const MARKUP = { image: 1.35, video: 1.30, chat: 1.30, embedding: 1.20, audio: 1.25 };
const PARTNER_MARKUP = 1.18; // flat 18% across all types for partner-tier clients

// ── Cost → credits (returns integer) ────────────────────────────
function getGenerationCost(model, params = {}, keyTier = null) {
	const base = KIE_COSTS[model];
	if (!base) return 0;
	const mul = keyTier === 'internal' ? 1 : keyTier === 'partner' ? PARTNER_MARKUP : null;

	if (typeof base === 'number') {
		const usd = base * (mul ?? MARKUP.image);
		return Math.ceil(usd / CREDIT_VALUE);
	}

	// Video: nested by mode/resolution → duration
	const mode = params.mode || params.resolution || Object.keys(base)[0];
	const duration = params.duration || 5;
	const tier = base[mode] || base[Object.keys(base)[0]];
	const raw = tier[duration] || tier[Object.keys(tier)[0]];
	const usd = raw * (mul ?? MARKUP.video);
	return Math.ceil(usd / CREDIT_VALUE);
}

// ── Chat/embedding/audio cost → credits ─────────────────────────
function getChatCost(model, inputTokens = 0, outputTokens = 0, keyTier = null) {
	const costs = OPENAI_COSTS[model];
	if (!costs) return 0;
	const mul = keyTier === 'internal' ? 1 : keyTier === 'partner' ? PARTNER_MARKUP : null;

	// Audio: per-minute pricing
	if (costs.perMinute !== undefined) {
		const usd = costs.perMinute * Math.max(1, inputTokens);
		const markup = mul ?? MARKUP.audio;
		return Math.max(2, Math.ceil((usd * markup) / CREDIT_VALUE));
	}

	// Chat / embedding: per-token pricing
	const inputCost = (inputTokens / 1_000_000) * costs.input;
	const outputCost = (outputTokens / 1_000_000) * (costs.output || 0);
	const usd = inputCost + outputCost;
	const markupType = costs.output > 0 ? 'chat' : 'embedding';
	const markup = mul ?? MARKUP[markupType];
	return Math.max(1, Math.ceil((usd * markup) / CREDIT_VALUE));
}

// ── Tier definitions (credits, not dollars) ─────────────────────
const TIERS = {
	free:       { name: 'Free',       monthlyCredits: 100,       rateLimit: 10,  concurrentTasks: 2  },
	starter:    { name: 'Starter',    monthlyCredits: 4400,      rateLimit: 30,  concurrentTasks: 5  },
	builder:    { name: 'Builder',    monthlyCredits: 12400,     rateLimit: 45,  concurrentTasks: 10 },
	scale:      { name: 'Scale',      monthlyCredits: 33000,     rateLimit: 60,  concurrentTasks: 20 },
	enterprise: { name: 'Enterprise', monthlyCredits: 200000,    rateLimit: 120, concurrentTasks: 50 },
	partner:    { name: 'Partner',    monthlyCredits: 500000,    rateLimit: 120, concurrentTasks: 50 },
	internal:   { name: 'Internal',   monthlyCredits: 2000000,   rateLimit: 200, concurrentTasks: 100 },
};

// ── Model catalog ──────────────────────────────────────────────
const MODELS = {
	// ── Image ── Featured first ──
	'nano-banana-2': {
		type: 'image', name: 'Nano Banana 2', provider: 'Google',
		description: 'Latest Gemini image model with sharper 2K output, improved text rendering, and character consistency',
		defaults: { aspect_ratio: '1:1', resolution: '2K', output_format: 'png' },
		credits_per_gen: 12, featured: true,
	},
	'gpt-5.4-image': {
		type: 'image', name: 'GPT-5.4 Image', provider: 'OpenAI',
		description: 'OpenAI flagship image generation with exceptional prompt understanding',
		defaults: { aspect_ratio: '1:1' },
		credits_per_gen: 14, featured: true,
	},
	'seedream-5': {
		type: 'image', name: 'Seedream 5.0 Lite', provider: 'ByteDance',
		description: 'ByteDance image model with up to 4K output and fast generation',
		defaults: { aspect_ratio: '1:1' },
		credits_per_gen: 8, featured: true,
	},
	'nano-banana-pro': {
		type: 'image', name: 'Nano Banana Pro', provider: 'Google',
		description: 'Fast, precise AI image generation with native 4K output',
		defaults: { aspect_ratio: '1:1', resolution: '1K', output_format: 'png' },
		credits_per_gen: 8,
	},
	'flux-kontext': {
		type: 'image', name: 'Flux Kontext', provider: 'Black Forest Labs',
		description: 'Advanced image generation and editing with reference images',
		defaults: { aspect_ratio: '1:1' },
		credits_per_gen: 11,
	},
	'qwen-image-2': {
		type: 'image', name: 'Qwen Image 2.0', provider: 'Qwen',
		description: 'Qwen image generation with strong text rendering',
		defaults: { aspect_ratio: '1:1' },
		credits_per_gen: 8,
	},
	'midjourney': {
		type: 'image', name: 'Midjourney', provider: 'Midjourney',
		description: 'Midjourney v6 via API — 4 variants per generation',
		defaults: { aspect_ratio: '1:1' },
		credits_per_gen: 11,
	},

	// ── Video ── Featured first ──
	'kling-3.0-mc': {
		type: 'video', name: 'Kling 3.0 Motion Control', provider: 'Kling',
		description: 'Advanced video with camera path control, element references, and multi-shot',
		defaults: { duration: 5, aspect_ratio: '16:9', mode: 'std', sound: false },
		credits_per_gen: '91-364', featured: true,
	},
	'veo-3': {
		type: 'video', name: 'Veo 3', provider: 'Google',
		description: 'Google Veo 3 — high-quality video generation with native audio',
		defaults: { duration: 5, mode: 'fast', sound: true },
		credits_per_gen: '104-520', featured: true,
	},
	'sora-2': {
		type: 'video', name: 'Sora 2', provider: 'OpenAI',
		description: 'OpenAI Sora 2 — text and image to video with cinematic quality',
		defaults: { duration: 5, aspect_ratio: '16:9', mode: 'std' },
		credits_per_gen: '130-520', featured: true,
	},
	'seedance-2': {
		type: 'video', name: 'Seedance 2.0', provider: 'ByteDance',
		description: 'ByteDance video generation with dance and motion specialization',
		defaults: { duration: 5, aspect_ratio: '16:9', mode: 'std' },
		credits_per_gen: '91-286', featured: true,
	},
	'kling-3.0': {
		type: 'video', name: 'Kling 3.0', provider: 'Kling',
		description: 'Advanced video generation with multi-shot and element references',
		defaults: { duration: 5, aspect_ratio: '16:9', mode: 'std', sound: false },
		credits_per_gen: '91-286',
	},
	'hailuo-2.3': {
		type: 'video', name: 'Hailuo 2.3', provider: 'MiniMax',
		description: 'MiniMax video generation with standard and pro quality modes',
		defaults: { duration: 5, aspect_ratio: '16:9', mode: 'std' },
		credits_per_gen: '73-247',
	},
	'wan-2.6': {
		type: 'video', name: 'Wan 2.6', provider: 'Alibaba',
		description: 'Multi-shot HD video with native audio support',
		defaults: { duration: 5, resolution: '720p' },
		credits_per_gen: '78-260',
	},
	'kling-2.6': {
		type: 'video', name: 'Kling 2.6', provider: 'Kling',
		description: 'High-quality video generation with audio support',
		defaults: { duration: 5, aspect_ratio: '16:9', mode: 'std', sound: false },
		credits_per_gen: '73-234',
	},

	// ── Chat Models ──
	'gpt-5.1': {
		type: 'chat', name: 'GPT-5.1', provider: 'OpenAI',
		description: 'OpenAI GPT-5.1 — fast, capable chat model for classification, extraction, and generation',
		pricing: { input_per_1m: 0.63, output_per_1m: 5.00 },
		featured: true,
	},
	'gpt-5.1-codex-mini': {
		type: 'chat', name: 'GPT-5.1 Codex Mini', provider: 'OpenAI',
		description: 'Compact GPT-5.1 variant — budget-friendly for simple classification and extraction',
		pricing: { input_per_1m: 0.25, output_per_1m: 2.00 },
	},
	'gpt-5.4': {
		type: 'chat', name: 'GPT-5.4', provider: 'OpenAI',
		description: 'OpenAI frontier model — maximum capability for complex reasoning',
		pricing: { input_per_1m: 1.25, output_per_1m: 10.00 },
		featured: true,
	},
	// ── Embedding Models ──
	'text-embedding-3-small': {
		type: 'embedding', name: 'Text Embedding 3 Small', provider: 'OpenAI',
		description: 'Fast, efficient embeddings for semantic search and RAG',
		pricing: { input_per_1m: 0.02 },
	},
	'text-embedding-3-large': {
		type: 'embedding', name: 'Text Embedding 3 Large', provider: 'OpenAI',
		description: 'High-dimensional embeddings for maximum retrieval accuracy',
		pricing: { input_per_1m: 0.13 },
	},

	// ── Audio Models ──
	'whisper-1': {
		type: 'audio', name: 'Whisper', provider: 'OpenAI',
		description: 'Speech-to-text transcription with multi-language support',
		pricing: { per_minute: 0.006 },
	},
};

// ── Pipeline definitions ────────────────────────────────────────
const PIPELINES = {
	'product-shot': {
		name: 'Product Shot Pipeline',
		description: 'Generate product image → 3 variations at different angles',
		steps: [
			{ model: 'nano-banana-pro', promptTemplate: '{prompt}, professional product photography, white background, studio lighting' },
			{ model: 'nano-banana-pro', promptTemplate: '{prompt}, product photography, 45-degree angle, soft shadows' },
			{ model: 'nano-banana-pro', promptTemplate: '{prompt}, product photography, close-up detail shot, macro' },
		],
	},
	'social-media-pack': {
		name: 'Social Media Pack',
		description: 'Generate images optimized for Instagram (1:1), Stories (9:16), and YouTube (16:9)',
		steps: [
			{ model: 'nano-banana-pro', promptTemplate: '{prompt}', overrides: { aspect_ratio: '1:1' } },
			{ model: 'nano-banana-pro', promptTemplate: '{prompt}', overrides: { aspect_ratio: '9:16' } },
			{ model: 'nano-banana-pro', promptTemplate: '{prompt}', overrides: { aspect_ratio: '16:9' } },
		],
	},
	'video-ad': {
		name: 'Video Ad Pipeline',
		description: 'Generate hero image → animate to 5s video with sound',
		steps: [
			{ model: 'nano-banana-pro', promptTemplate: '{prompt}, cinematic, high contrast, dramatic lighting' },
			{ model: 'kling-3.0', promptTemplate: '{prompt}, smooth camera motion, cinematic', useOutputAsInput: true, overrides: { duration: 5, sound: true, mode: 'pro' } },
		],
	},
	'thumbnail-pack': {
		name: 'Thumbnail Pack',
		description: 'Generate 4 YouTube thumbnail variations',
		steps: [
			{ model: 'gpt-5.4-image', promptTemplate: '{prompt}, YouTube thumbnail, bold text, high contrast, clickbait style, 16:9', overrides: { aspect_ratio: '16:9' } },
			{ model: 'gpt-5.4-image', promptTemplate: '{prompt}, YouTube thumbnail, dramatic reaction, vibrant colors, 16:9', overrides: { aspect_ratio: '16:9' } },
			{ model: 'nano-banana-pro', promptTemplate: '{prompt}, thumbnail, cinematic still, dramatic lighting', overrides: { aspect_ratio: '16:9' } },
			{ model: 'flux-kontext', promptTemplate: '{prompt}, YouTube thumbnail, bold composition, eye-catching', overrides: { aspect_ratio: '16:9' } },
		],
	},
};

// ── Cache helpers (KV-based, for agent dedup) ───────────────────
function getCacheKey(model, prompt, params) {
	const normalized = JSON.stringify({ model, prompt: prompt.trim().toLowerCase(), ...params });
	return `cache:${hashCode(normalized)}`;
}

function hashCode(str) {
	let hash = 0;
	for (let i = 0; i < str.length; i++) {
		const ch = str.charCodeAt(i);
		hash = ((hash << 5) - hash) + ch;
		hash |= 0;
	}
	return Math.abs(hash).toString(36);
}

async function getCached(env, key) {
	if (!env.CACHE) return null;
	try {
		const cached = await env.CACHE.get(key, 'json');
		return cached;
	} catch { return null; }
}

async function setCache(env, key, data, ttlSeconds = 3600) {
	if (!env.CACHE) return;
	try {
		await env.CACHE.put(key, JSON.stringify(data), { expirationTtl: ttlSeconds });
	} catch { /* non-critical */ }
}

// ── Usage tracking (KV-based, in credits) ───────────────────────
function getUsageKey(apiKey) {
	const month = new Date().toISOString().slice(0, 7);
	return `usage:${apiKey}:${month}`;
}

async function getUsage(env, apiKey) {
	if (!env.USAGE) return { spent: 0, generations: 0, cached: 0, tasks: [] };
	try {
		const data = await env.USAGE.get(getUsageKey(apiKey), 'json');
		return data || { spent: 0, generations: 0, cached: 0, tasks: [] };
	} catch {
		return { spent: 0, generations: 0, cached: 0, tasks: [] };
	}
}

async function trackUsage(env, apiKey, credits, model, cached = false) {
	if (!env.USAGE) return;
	const usage = await getUsage(env, apiKey);
	usage.spent += credits;
	usage.generations++;
	if (cached) usage.cached++;
	usage.tasks.unshift({ model, credits, cached, ts: Date.now() });
	if (usage.tasks.length > 100) usage.tasks = usage.tasks.slice(0, 100);
	try {
		await env.USAGE.put(getUsageKey(apiKey), JSON.stringify(usage), { expirationTtl: 90 * 86400 });
	} catch { /* non-critical */ }
}

async function checkBudget(env, apiKey, tier, credits) {
	const tierConfig = TIERS[tier] || TIERS.free;
	const usage = await getUsage(env, apiKey);
	if (usage.spent + credits > tierConfig.monthlyCredits) {
		return { allowed: false, spent: usage.spent, limit: tierConfig.monthlyCredits, overage: usage.spent + credits - tierConfig.monthlyCredits };
	}
	return { allowed: true, spent: usage.spent, limit: tierConfig.monthlyCredits, remaining: tierConfig.monthlyCredits - usage.spent - credits };
}

// ── API key management (KV-based) ──────────────────────────────
async function validateApiKey(key, env) {
	if (env.API_KEYS) {
		try {
			const data = await env.API_KEYS.get(`key:${key}`, 'json');
			if (data) return data;
		} catch { /* fall through */ }
	}
	try {
		const keys = JSON.parse(env.API_KEYS_JSON || '[]');
		return keys.find(k => k.key === key) || null;
	} catch { return null; }
}

// ── Rate limiting (in-memory, per-worker) ───────────────────────
const rateLimitMap = new Map();

function checkRateLimit(apiKey, limit = 30) {
	const now = Date.now();
	const window = 60_000;
	const entry = rateLimitMap.get(apiKey) || { count: 0, reset: now + window };
	if (now > entry.reset) { entry.count = 0; entry.reset = now + window; }
	entry.count++;
	rateLimitMap.set(apiKey, entry);
	if (entry.count > limit) return { allowed: false, remaining: 0, reset: entry.reset };
	return { allowed: true, remaining: limit - entry.count, reset: entry.reset };
}

// ── CORS ────────────────────────────────────────────────────────
function corsHeaders(origin) {
	const headers = {
		'Access-Control-Allow-Methods': 'POST, GET, PUT, OPTIONS, DELETE',
		'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key',
		'Access-Control-Max-Age': '86400',
		// Vary: Origin ensures CDN/browser caches don't mix responses across origins
		'Vary': 'Origin',
	};
	if (origin) {
		// Allow all origins. API key auth is the security boundary, not CORS.
		// Credentials (cookies) are never used — omitting Access-Control-Allow-Credentials
		// prevents browsers from sending ambient credentials cross-origin.
		headers['Access-Control-Allow-Origin'] = origin;
	}
	return headers;
}

// ── Kie.ai proxy ────────────────────────────────────────────────
async function kieRequest(path, body, env) {
	const res = await fetch(`${KIE_BASE}${path}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.KIE_API_KEY}` },
		body: JSON.stringify(body),
	});
	return res.json();
}

async function kieGet(path, env) {
	const res = await fetch(`${KIE_BASE}${path}`, {
		method: 'GET',
		headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.KIE_API_KEY}` },
	});
	return res.json();
}

// ── OpenAI proxy with OpenRouter fallback ──────────────────────
const OPENAI_BASE = 'https://api.openai.com/v1';
const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

// OpenRouter model mapping (our slug -> OpenRouter model ID)
const OPENROUTER_MODELS = {
	'gpt-5.1':            'openai/gpt-5.1',
	'gpt-5.1-codex-mini': 'openai/gpt-5.4-mini',
	'gpt-5.4':            'openai/gpt-5.4',
};

async function openaiProxy(path, request, env, keyData) {
	if (!env.OPENAI_API_KEY) {
		return { error: 'OpenAI API key not configured', code: 503 };
	}

	const contentType = request.headers.get('Content-Type') || '';
	const isMultipart = contentType.includes('multipart/form-data');

	// Forward the request to OpenAI
	const upstreamHeaders = {
		'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
	};
	if (!isMultipart) {
		upstreamHeaders['Content-Type'] = 'application/json';
	} else {
		upstreamHeaders['Content-Type'] = contentType;
	}

	const upstreamRes = await fetch(`${OPENAI_BASE}${path}`, {
		method: 'POST',
		headers: upstreamHeaders,
		body: request.body,
	});

	return upstreamRes;
}

// Fallback to OpenRouter when OpenAI fails (5xx / 429 / network error)
async function openrouterFallback(path, body, env) {
	if (!env.OPENROUTER_API_KEY) return null;

	// Remap model and params for OpenRouter compatibility
	const orModel = OPENROUTER_MODELS[body.model] || body.model;
	const orBody = { ...body, model: orModel };
	// OpenRouter requires max_tokens >= 16 for some providers
	if (orBody.max_tokens && orBody.max_tokens < 16) orBody.max_tokens = 16;

	try {
		const res = await fetch(`${OPENROUTER_BASE}${path}`, {
			method: 'POST',
			headers: {
				'Authorization': `Bearer ${env.OPENROUTER_API_KEY}`,
				'Content-Type': 'application/json',
				'HTTP-Referer': 'https://api.eternium.ai',
				'X-Title': 'Eternium API',
			},
			body: JSON.stringify(orBody),
		});
		if (res.ok) return res;
		// If OpenRouter also fails, log the error for debugging
		const errText = await res.text().catch(() => 'unknown');
		console.error(`OpenRouter fallback failed (${res.status}): ${errText.slice(0, 200)}`);
	} catch (e) {
		console.error(`OpenRouter fallback error: ${e.message || e}`);
	}
	return null;
}

async function handleChatCompletions(request, env, keyData) {
	let body;
	try {
		// Clone request so we can read body AND forward it
		const cloned = request.clone();
		body = await cloned.json();
	} catch {
		return { response: json({ error: 'Invalid JSON body' }, 400) };
	}

	const model = body.model || 'gpt-5.1';
	if (!OPENAI_COSTS[model]) {
		return { response: json({ error: `Unknown chat model: ${model}. Available: ${Object.keys(OPENAI_COSTS).filter(m => !OPENAI_COSTS[m].perMinute).join(', ')}` }, 400) };
	}

	const isStreaming = body.stream === true;

	// Pre-estimate budget (rough: ~1000 tokens input for classification tasks)
	const estimatedCredits = getChatCost(model, 1000, 500, keyData.tier);
	const budget = await checkBudget(env, keyData.key, keyData.tier, estimatedCredits);
	if (!budget.allowed) {
		return { response: json({ error: 'Monthly credit limit reached.', usage: { spent: budget.spent, limit: budget.limit } }, 402) };
	}

	// Inject stream_options for usage tracking on streaming
	if (isStreaming && !body.stream_options) {
		body.stream_options = { include_usage: true };
	}

	// Forward to OpenAI (with OpenRouter fallback on 5xx)
	let upstreamRes;
	try {
		upstreamRes = await fetch(`${OPENAI_BASE}/chat/completions`, {
			method: 'POST',
			headers: {
				'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(body),
		});
	} catch (e) {
		// Network error -- try OpenRouter
		upstreamRes = null;
	}

	// Fallback to OpenRouter on server error, quota exhaustion, or network failure
	if (!upstreamRes || upstreamRes.status >= 500 || upstreamRes.status === 429) {
		const fallback = await openrouterFallback('/chat/completions', body, env);
		if (fallback) upstreamRes = fallback;
	}

	if (!upstreamRes || !upstreamRes.ok) {
		const errBody = upstreamRes ? await upstreamRes.text() : '{"error":"All providers unavailable"}';
		const errStatus = upstreamRes ? upstreamRes.status : 503;
		return { response: new Response(errBody, { status: errStatus, headers: { 'Content-Type': 'application/json' } }) };
	}

	if (isStreaming) {
		// Stream through, track usage from the final chunk
		const { readable, writable } = new TransformStream();
		const writer = writable.getWriter();
		const reader = upstreamRes.body.getReader();
		const decoder = new TextDecoder();
		const encoder = new TextEncoder();

		(async () => {
			try {
				let buffer = '';
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					const chunk = decoder.decode(value, { stream: true });
					buffer += chunk;
					await writer.write(value);

					// Look for usage in SSE data
					const lines = buffer.split('\n');
					buffer = lines.pop() || '';
					for (const line of lines) {
						if (line.startsWith('data: ') && line !== 'data: [DONE]') {
							try {
								const parsed = JSON.parse(line.slice(6));
								if (parsed.usage) {
									const credits = getChatCost(model, parsed.usage.prompt_tokens || 0, parsed.usage.completion_tokens || 0, keyData.tier);
									await trackUsage(env, keyData.key, credits, model, false);
								}
							} catch { /* not JSON or no usage */ }
						}
					}
				}
			} catch { /* stream error */ }
			finally { await writer.close(); }
		})();

		return {
			response: new Response(readable, {
				status: 200,
				headers: {
					'Content-Type': 'text/event-stream',
					'Cache-Control': 'no-cache',
					'Connection': 'keep-alive',
				},
			}),
		};
	}

	// Non-streaming: parse response, track usage, return verbatim
	const data = await upstreamRes.json();
	if (data.usage) {
		const credits = getChatCost(model, data.usage.prompt_tokens || 0, data.usage.completion_tokens || 0, keyData.tier);
		await trackUsage(env, keyData.key, credits, model, false);
	}

	return { response: new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } }) };
}

async function handleEmbeddings(request, env, keyData) {
	let body;
	try {
		const cloned = request.clone();
		body = await cloned.json();
	} catch {
		return { response: json({ error: 'Invalid JSON body' }, 400) };
	}

	const model = body.model || 'text-embedding-3-small';

	// Budget check
	const estimatedCredits = getChatCost(model, 500, 0, keyData.tier);
	const budget = await checkBudget(env, keyData.key, keyData.tier, estimatedCredits);
	if (!budget.allowed) {
		return { response: json({ error: 'Monthly credit limit reached.' }, 402) };
	}

	let upstreamRes;
	try {
		upstreamRes = await fetch(`${OPENAI_BASE}/embeddings`, {
			method: 'POST',
			headers: {
				'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(body),
		});
	} catch { upstreamRes = null; }

	if (!upstreamRes || upstreamRes.status >= 500 || upstreamRes.status === 429) {
		const fallback = await openrouterFallback('/embeddings', body, env);
		if (fallback) upstreamRes = fallback;
	}

	if (!upstreamRes || !upstreamRes.ok) {
		const errBody = upstreamRes ? await upstreamRes.text() : '{"error":"All providers unavailable"}';
		return { response: new Response(errBody, { status: upstreamRes ? upstreamRes.status : 503, headers: { 'Content-Type': 'application/json' } }) };
	}

	const data = await upstreamRes.json();
	if (data.usage) {
		const credits = getChatCost(model, data.usage.prompt_tokens || data.usage.total_tokens || 0, 0, keyData.tier);
		await trackUsage(env, keyData.key, credits, model, false);
	}

	return { response: new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } }) };
}

async function handleAudioTranscriptions(request, env, keyData) {
	// Budget check (flat ~2 credits for short voice clips)
	const estimatedCredits = getChatCost('whisper-1', 1, 0, keyData.tier); // 1 minute estimate
	const budget = await checkBudget(env, keyData.key, keyData.tier, estimatedCredits);
	if (!budget.allowed) {
		return { response: json({ error: 'Monthly credit limit reached.' }, 402) };
	}

	// Forward multipart/form-data directly — pipe the body stream
	const contentType = request.headers.get('Content-Type') || '';
	const upstreamRes = await fetch(`${OPENAI_BASE}/audio/transcriptions`, {
		method: 'POST',
		headers: {
			'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
			'Content-Type': contentType,
		},
		body: request.body,
	});

	if (!upstreamRes.ok) {
		const errBody = await upstreamRes.text();
		return { response: new Response(errBody, { status: upstreamRes.status, headers: { 'Content-Type': 'application/json' } }) };
	}

	// Track usage (flat cost per transcription)
	await trackUsage(env, keyData.key, estimatedCredits, 'whisper-1', false);

	// Return verbatim
	const responseBody = await upstreamRes.text();
	const responseContentType = upstreamRes.headers.get('Content-Type') || 'application/json';
	return { response: new Response(responseBody, { status: 200, headers: { 'Content-Type': responseContentType } }) };
}

// ── Build Kie request body from our params ──────────────────────
function buildKieBody(model, prompt, params) {
	const modelConfig = MODELS[model];
	if (!modelConfig) return { model, input: { prompt } };

	// ── Kie.ai model slug mapping ──
	const KIE_SLUGS = {
		'nano-banana-2':   'nano-banana-2',
		'nano-banana-pro': 'nano-banana-pro',
		'gpt-5.4-image':   'gpt-5.4/generate',
		'flux-kontext':    'flux-kontext/generate',
		'seedream-5':      'seedream-5.0-lite/generate',
		'qwen-image-2':    'qwen-image-2.0/generate',
		'midjourney':      'midjourney/generate',
		'kling-3.0':       'kling-3.0/video',
		'kling-3.0-mc':    'kling-3.0/video',
		'kling-2.6':       'kling-2.6/video',
		'veo-3':           'veo-3/video',
		'sora-2':          'sora-2/video',
		'wan-2.6':         'wan-2.6/video',
		'hailuo-2.3':      'hailuo-2.3/video',
		'seedance-2':      'seedance-2.0/video',
	};

	const kieModel = KIE_SLUGS[model] || model;

	if (modelConfig.type === 'image') {
		return {
			model: kieModel,
			callBackUrl: params.callback_url || '',
			input: {
				prompt,
				image_input: params.image_urls || params.image_input || [],
				image_urls: params.image_urls || [],
				aspect_ratio: params.aspect_ratio || modelConfig.defaults.aspect_ratio || '1:1',
				resolution: params.resolution || modelConfig.defaults.resolution || '1K',
				output_format: params.output_format || modelConfig.defaults.output_format || 'png',
			},
		};
	} else {
		const kieBody = {
			model: kieModel,
			callBackUrl: params.callback_url || '',
			input: {
				prompt,
				image_urls: params.image_urls || [],
				duration: params.duration || modelConfig.defaults.duration || 5,
				aspect_ratio: params.aspect_ratio || modelConfig.defaults.aspect_ratio || '16:9',
				mode: params.mode || modelConfig.defaults.mode || 'std',
				sound: params.sound ?? modelConfig.defaults.sound ?? false,
				// KIE requires multi_shots to be explicitly set for Kling 3.0.
				// false = standard image-to-video (image_urls as start/end frames).
				multi_shots: false,
			},
		};
		if (params.resolution) kieBody.input.resolution = params.resolution;
		// Multi-shot mode: upgrade to true only when caller provides valid multi_prompt.
		const multiPrompts = Array.isArray(params.multi_prompt) && params.multi_prompt.length > 0
			? params.multi_prompt
			: null;
		if (model === 'kling-3.0-mc' || (model === 'kling-3.0' && params.multi_shots && multiPrompts)) {
			kieBody.input.multi_shots = true;
			kieBody.input.multi_prompt = multiPrompts;
			kieBody.input.sound = true;
			if (params.kling_elements) kieBody.input.kling_elements = params.kling_elements;
		}
		return kieBody;
	}
}

// ── Route handlers ──────────────────────────────────────────────

async function handleGenerate(body, env, keyData) {
	const { model, prompt, cache = true, ...params } = body;

	if (!model || !MODELS[model]) {
		return { error: `Invalid model. Available: ${Object.keys(MODELS).join(', ')}`, code: 400 };
	}
	if (!prompt) return { error: 'prompt is required', code: 400 };

	const credits = getGenerationCost(model, params, keyData.tier);

	// Budget check
	const budget = await checkBudget(env, keyData.key, keyData.tier, credits);
	if (!budget.allowed) {
		return {
			error: 'Monthly credit limit reached. Upgrade your tier or wait for reset.',
			code: 402,
			usage: { spent: budget.spent, limit: budget.limit },
		};
	}

	// Cache check (agent dedup)
	if (cache !== false) {
		const cacheKey = getCacheKey(model, prompt, params);
		const cached = await getCached(env, cacheKey);
		if (cached) {
			await trackUsage(env, keyData.key, 0, model, true);
			return {
				data: { ...cached, _cached: true, _saved: `${credits} credits` },
				code: 200,
			};
		}
	}

	const kieBody = buildKieBody(model, prompt, params);
	const result = await kieRequest('/jobs/createTask', kieBody, env);

	// Track usage
	await trackUsage(env, keyData.key, credits, model, false);

	// Cache the task creation response
	if (cache !== false && result.code === 200) {
		const cacheKey = getCacheKey(model, prompt, params);
		await setCache(env, cacheKey, result, 3600);
	}

	return {
		data: { ...result, _credits: credits, _budget_remaining: budget.remaining || 0 },
		code: result.code === 200 ? 200 : (result.code || 500),
	};
}

async function handlePipeline(body, env, keyData) {
	const { pipeline, prompt, ...params } = body;

	if (!pipeline || !PIPELINES[pipeline]) {
		return { error: `Invalid pipeline. Available: ${Object.keys(PIPELINES).join(', ')}`, code: 400 };
	}
	if (!prompt) return { error: 'prompt is required', code: 400 };

	const pipelineDef = PIPELINES[pipeline];
	const tasks = [];
	let totalCredits = 0;

	for (const step of pipelineDef.steps) {
		const stepParams = { ...params, ...step.overrides };
		const credits = getGenerationCost(step.model, stepParams, keyData.tier);
		totalCredits += credits;
	}

	// Budget check for entire pipeline
	const budget = await checkBudget(env, keyData.key, keyData.tier, totalCredits);
	if (!budget.allowed) {
		return {
			error: `Monthly credit limit reached. This pipeline costs ${totalCredits} credits.`,
			code: 402,
			usage: { spent: budget.spent, limit: budget.limit, pipeline_credits: totalCredits },
		};
	}

	// Execute all steps
	for (const step of pipelineDef.steps) {
		const stepPrompt = step.promptTemplate.replace('{prompt}', prompt);
		const stepParams = { ...params, ...step.overrides };
		const kieBody = buildKieBody(step.model, stepPrompt, stepParams);
		const result = await kieRequest('/jobs/createTask', kieBody, env);
		const credits = getGenerationCost(step.model, stepParams, keyData.tier);
		await trackUsage(env, keyData.key, credits, step.model, false);
		tasks.push({
			model: step.model,
			taskId: result.data?.taskId || null,
			credits,
			status: result.code === 200 ? 'submitted' : 'failed',
			error: result.code !== 200 ? result.msg : undefined,
		});
	}

	return {
		data: {
			pipeline: pipeline,
			name: pipelineDef.name,
			total_credits: totalCredits,
			budget_remaining: (budget.remaining || 0) - totalCredits,
			tasks,
		},
		code: 200,
	};
}

// ── Thumbnail concept generator (campaign-aware) ───────────────
// Accepts structured campaign data, builds 3 prompt variants, fires
// 3 parallel image generations. Returns task IDs for polling.
async function handleThumbnailGenerate(body, env, keyData) {
	const { title, hook, key_takeaways, content_pillar, style, model } = body;

	if (!title) return { error: 'title is required', code: 400 };
	if (!hook) return { error: 'hook is required', code: 400 };

	const imgModel = model || 'nano-banana-2';
	if (!MODELS[imgModel] || MODELS[imgModel].type !== 'image') {
		return { error: `Invalid image model: ${imgModel}. Available: ${Object.keys(MODELS).filter(m => MODELS[m].type === 'image').join(', ')}`, code: 400 };
	}

	const creditsPerGen = getGenerationCost(imgModel, { aspect_ratio: '16:9' }, keyData.tier);
	const totalCredits = creditsPerGen * 3;

	const budget = await checkBudget(env, keyData.key, keyData.tier, totalCredits);
	if (!budget.allowed) {
		return {
			error: `Monthly credit limit reached. Thumbnails cost ${totalCredits} credits (${creditsPerGen} x 3).`,
			code: 402,
			usage: { spent: budget.spent, limit: budget.limit, thumbnail_credits: totalCredits },
		};
	}

	// Build context string from campaign data
	const takeawayText = Array.isArray(key_takeaways) && key_takeaways.length > 0
		? key_takeaways.slice(0, 3).join(', ')
		: '';
	const pillar = content_pillar || 'general';
	const styleHint = style || 'bold and high-contrast';

	// 3 prompt variants (from content-system-productization.md spec)
	const variants = [
		{
			label: 'A',
			description: 'Face + tool logos + bold text overlay',
			prompt: `YouTube thumbnail, 16:9. Topic: "${title}". Bold large text overlay reading "${hook}". Show a confident person's face expressing excitement, with relevant tool logos or icons floating nearby. ${pillar} theme. Style: ${styleHint}, vibrant colors, high contrast, professional YouTube thumbnail composition. ${takeawayText ? `Key concepts: ${takeawayText}.` : ''}`,
		},
		{
			label: 'B',
			description: 'Stat/number as hero element + minimal face',
			prompt: `YouTube thumbnail, 16:9. Topic: "${title}". Large bold number or statistic as the hero element, taking up most of the frame. Small face or silhouette in the corner showing surprise. Text: "${hook}". ${pillar} theme. Style: ${styleHint}, clean layout, dramatic typography, single accent color pop against dark or contrasting background. ${takeawayText ? `Key stat context: ${takeawayText}.` : ''}`,
		},
		{
			label: 'C',
			description: 'Visual metaphor + text (no face)',
			prompt: `YouTube thumbnail, 16:9. Topic: "${title}". Strong visual metaphor representing the concept (no human face). Bold text overlay: "${hook}". ${pillar} theme. Style: ${styleHint}, cinematic composition, conceptual imagery, icon-driven design, eye-catching colors. ${takeawayText ? `Visual concepts: ${takeawayText}.` : ''}`,
		},
	];

	// Fire all 3 generations in parallel
	const tasks = await Promise.all(variants.map(async (v) => {
		const kieBody = buildKieBody(imgModel, v.prompt, { aspect_ratio: '16:9' });
		const result = await kieRequest('/jobs/createTask', kieBody, env);
		await trackUsage(env, keyData.key, creditsPerGen, imgModel, false);
		return {
			variant: v.label,
			description: v.description,
			task_id: result.data?.taskId || null,
			model: imgModel,
			credits: creditsPerGen,
			status: result.code === 200 ? 'submitted' : 'failed',
			error: result.code !== 200 ? result.msg : undefined,
		};
	}));

	return {
		data: {
			campaign_title: title,
			variants: tasks,
			total_credits: totalCredits,
			budget_remaining: (budget.remaining || 0) - totalCredits,
			next_steps: {
				poll: 'GET /v1/tasks/{task_id} — check generation status',
				download: 'GET /v1/tasks/{task_id}/download — get permanent R2 URL',
			},
		},
		code: 200,
	};
}

async function handleTaskStatus(taskId, env) {
	if (!taskId) return { error: 'task_id is required', code: 400 };
	const result = await kieGet(`/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`, env);
	return { data: result, code: result.code === 200 ? 200 : (result.code || 500) };
}

async function handleDownload(taskId, env) {
	if (!taskId) return { error: 'task_id is required', code: 400 };

	// Check R2 archive first — if already stored, return permanent URL immediately
	if (env.MEDIA_STORAGE) {
		const existing = await env.MEDIA_STORAGE.head(`generations/${taskId}`);
		if (existing) {
			const ext = (existing.httpMetadata?.contentType || '').includes('video') ? 'mp4' : 'png';
			const permanentUrl = `https://api.eternium.ai/media/generations/${taskId}`;
			return { data: { code: 200, data: { url: permanentUrl } }, code: 200 };
		}
	}

	// Get temp URL from KIE
	const result = await kieGet(`/common/download-url?taskId=${encodeURIComponent(taskId)}`, env);
	if (result.code !== 200) {
		return { data: result, code: result.code || 500 };
	}

	// Extract the temp download URL
	const tempUrl = result.data?.url || result.url;
	if (!tempUrl) {
		return { data: result, code: 200 };
	}

	// Archive to R2 in the background — return the permanent URL immediately
	if (env.MEDIA_STORAGE) {
		try {
			const mediaRes = await fetch(tempUrl);
			if (mediaRes.ok) {
				const contentType = mediaRes.headers.get('content-type') || 'application/octet-stream';
				const body = await mediaRes.arrayBuffer();
				await env.MEDIA_STORAGE.put(`generations/${taskId}`, body, {
					httpMetadata: { contentType },
					customMetadata: { taskId, archivedAt: new Date().toISOString() },
				});
				// Return permanent R2 URL
				const permanentUrl = `https://api.eternium.ai/media/generations/${taskId}`;
				return { data: { code: 200, data: { url: permanentUrl } }, code: 200 };
			}
		} catch (e) {
			// R2 upload failed — fall back to temp URL (non-fatal)
			console.error(`[r2] Archive failed for ${taskId}:`, e.message);
		}
	}

	// Fallback: return temp URL if R2 unavailable
	return { data: result, code: 200 };
}

async function handleUsage(env, keyData) {
	const usage = await getUsage(env, keyData.key);
	const tierConfig = TIERS[keyData.tier] || TIERS.free;
	return {
		data: {
			email: keyData.email,
			name: keyData.name,
			tier: keyData.tier,
			tier_name: tierConfig.name,
			credit_value: CREDIT_VALUE,
			monthly_limit: tierConfig.monthlyCredits,
			spent: usage.spent,
			remaining: tierConfig.monthlyCredits - usage.spent,
			generations: usage.generations,
			cached_hits: usage.cached,
			recent_tasks: (usage.tasks || []).slice(0, 20),
		},
		code: 200,
	};
}

// ── Main handler ────────────────────────────────────────────────
export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		const origin = request.headers.get('Origin') || '';
		const cors = corsHeaders(origin);

		if (request.method === 'OPTIONS') {
			return new Response(null, { status: 204, headers: cors });
		}

		// ── Tenant resolution ────────────────────────────────────────
		// Resolves tenant context from hostname (*.app.eternium.ai or custom domain).
		// Returns null for non-tenant requests (api.eternium.ai, eternium.ai).
		const tenant = await resolveTenant(request, env);

		// Tenant-specific routes (only when accessed via tenant subdomain)
		if (tenant) {
			// Validate tenant is in a servable state
			const tenantCheck = validateTenantStatus(tenant);
			if (!tenantCheck.ok && url.pathname !== '/v1/tenant') {
				return json({ error: tenantCheck.error }, tenantCheck.status, cors);
			}

			// GET /v1/tenant -- SPA boot endpoint (returns branding + config)
			if (url.pathname === '/v1/tenant' && request.method === 'GET') {
				const result = handleGetTenant(tenant, cors);
				return json(result.data, result.code, cors);
			}
		}

		// ── Public routes ────────────────────────────────────────────

		if (url.pathname === '/health') {
			return json({
				service: 'Eternium API',
				version: API_VERSION,
				status: 'operational',
				credit_value: CREDIT_VALUE,
				docs: 'https://api.eternium.ai/docs',
				models: Object.keys(MODELS).length,
				pipelines: Object.keys(PIPELINES).length,
				content_api: !!env.SUPABASE_URL,
			}, 200, cors);
		}

		// ── Media serve (R2 permanent storage) ──────────────────────
		const mediaMatch = url.pathname.match(/^\/media\/generations\/([a-f0-9]+)$/);
		if (mediaMatch && request.method === 'GET' && env.MEDIA_STORAGE) {
			const obj = await env.MEDIA_STORAGE.get(`generations/${mediaMatch[1]}`);
			if (!obj) return new Response('Not found', { status: 404, headers: cors });
			const resHeaders = new Headers(cors);
			resHeaders.set('Content-Type', obj.httpMetadata?.contentType || 'application/octet-stream');
			resHeaders.set('Cache-Control', 'public, max-age=31536000, immutable');
			return new Response(obj.body, { status: 200, headers: resHeaders });
		}

		// ── Media serve (R2 general storage) ────────────────────────
		if (url.pathname.startsWith('/v1/media/') && request.method === 'GET') {
			const key = decodeURIComponent(url.pathname.slice('/v1/media/'.length));
			if (!key) return json({ error: 'Media key required' }, 400, cors);
			const res = await handleMediaServe(key, env);
			// Merge CORS headers into the streaming response
			for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
			return res;
		}

		if (url.pathname === '/v1/models' && request.method === 'GET') {
			const models = Object.entries(MODELS).map(([id, m]) => ({
				id, type: m.type, name: m.name, provider: m.provider,
				description: m.description, credits_per_gen: m.credits_per_gen,
				featured: m.featured || false,
			}));
			return json({ models, credit_value: CREDIT_VALUE }, 200, cors);
		}

		if (url.pathname === '/v1/models/featured' && request.method === 'GET') {
			const models = Object.entries(MODELS)
				.filter(([, m]) => m.featured)
				.map(([id, m]) => ({
					id, type: m.type, name: m.name, provider: m.provider,
					description: m.description, credits_per_gen: m.credits_per_gen,
				}));
			return json({ models, credit_value: CREDIT_VALUE }, 200, cors);
		}

		if (url.pathname === '/v1/pipelines' && request.method === 'GET') {
			const pipelines = Object.entries(PIPELINES).map(([id, p]) => ({
				id, name: p.name, description: p.description, steps: p.steps.length,
			}));
			return json({ pipelines }, 200, cors);
		}

		if (url.pathname === '/v1/tiers' && request.method === 'GET') {
			return json({ tiers: TIERS, credit_value: CREDIT_VALUE }, 200, cors);
		}

		if (url.pathname === '/v1/docs' && request.method === 'GET') {
			return json({
				name: 'Eternium API',
				version: API_VERSION,
				base_url: 'https://api.eternium.ai',
				credit_value: CREDIT_VALUE,
				authentication: 'X-API-Key header or Authorization: Bearer <key>',
				features: ['Prompt caching (agent dedup)', 'Multi-model pipelines', 'Credit-based usage tracking', 'Per-key rate limiting'],
				endpoints: {
					'POST /v1/generate': { description: 'Generate image or video', body: { model: 'string', prompt: 'string', cache: 'boolean (default true)', '...': 'model-specific' } },
					'POST /v1/pipelines/run': { description: 'Run a multi-step pipeline', body: { pipeline: 'string', prompt: 'string' } },
					'POST /v1/thumbnails/generate': { description: 'Generate 3 campaign-aware thumbnail concepts', body: { title: 'string', hook: 'string', key_takeaways: 'string[] (optional)', content_pillar: 'string (optional)', style: 'string (optional)', model: 'string (optional, default nano-banana-2)' } },
					'POST /v1/chat/completions': { description: 'OpenAI-compatible chat completions proxy (supports streaming)', body: { model: 'string', messages: 'array', stream: 'boolean' } },
					'POST /v1/embeddings': { description: 'OpenAI-compatible embeddings proxy', body: { model: 'string', input: 'string|array' } },
					'POST /v1/audio/transcriptions': { description: 'OpenAI-compatible audio transcription proxy', body: 'multipart/form-data with file + model' },
					'GET /v1/tasks/:id': { description: 'Check task status' },
					'GET /v1/tasks/:id/download': { description: 'Get download URL (expires 20m)' },
					'GET /v1/models': { description: 'List all models (includes provider, featured flag, credits)' },
					'GET /v1/models/featured': { description: 'List featured/trending models only' },
					'GET /v1/pipelines': { description: 'List available pipelines' },
					'GET /v1/tiers': { description: 'List pricing tiers with credit allotments' },
					'GET /v1/usage': { description: 'Get your credit usage & budget (authenticated)' },
					'GET /v1/content/blog': { description: 'List published blog posts', query: { limit: 'number (max 100)', offset: 'number' } },
					'GET /v1/content/blog/:slug': { description: 'Get a blog post by slug' },
					'POST /v1/content/blog/publish': { description: 'Publish a blog post (admin only)', body: { item_id: 'uuid', title: 'string', content: 'markdown', seo_title: 'string', seo_description: 'string' } },
					'GET /v1/content/products': { description: 'List productized datasets and templates', query: { category: 'string' } },
					'GET /v1/content/datasets': { description: 'List all datasets', query: { category: 'string' } },
				},
				models: Object.entries(MODELS).map(([id, m]) => ({
					id, type: m.type, name: m.name, provider: m.provider, credits_per_gen: m.credits_per_gen, featured: m.featured || false,
				})),
				pipelines: Object.entries(PIPELINES).map(([id, p]) => ({ id, name: p.name, steps: p.steps.length })),
			}, 200, cors);
		}

		// ── Auth routes (public) ─────────────────────────────────────
		if (url.pathname === '/auth/signup' && request.method === 'POST') {
			const result = await handleSignup(request, env);
			return json(result.data || { error: result.error }, result.code, cors);
		}
		if (url.pathname === '/auth/login' && request.method === 'POST') {
			const result = await handleLogin(request, env);
			return json(result.data || { error: result.error }, result.code, cors);
		}
		if (url.pathname === '/auth/checkout' && request.method === 'POST') {
			const result = await handleCheckout(request, env);
			return json(result.data || { error: result.error }, result.code, cors);
		}
		if (url.pathname === '/auth/provision-key' && request.method === 'POST') {
			const result = await handleProvisionKey(request, env);
			return json(result.data || { error: result.error }, result.code, cors);
		}
		if (url.pathname === '/auth/regenerate-key' && request.method === 'POST') {
			const result = await handleRegenerateKey(request, env);
			return json(result.data || { error: result.error }, result.code, cors);
		}
		if (url.pathname === '/auth/stripe-success' && request.method === 'GET') {
			const result = await handleStripeSuccess(request, env);
			return json(result.data || { error: result.error }, result.code, cors);
		}

		// ── Stripe webhook ───────────────────────────────────────────
		if (url.pathname === '/webhooks/stripe' && request.method === 'POST') {
			const result = await handleStripeWebhook(request, env);
			return json(result.data || { error: result.error }, result.code, cors);
		}

		// ── Public Content API routes ────────────────────────────────
		// These are publicly readable (no auth required)
		if (url.pathname === '/v1/content/blog' && request.method === 'GET') {
			const result = await handleListBlogPosts(env, url.searchParams);
			return json(result.data, result.code, cors);
		}

		if (url.pathname === '/v1/content/products' && request.method === 'GET') {
			const result = await handleListProducts(env, url.searchParams);
			return json(result.data, result.code, cors);
		}

		if (url.pathname === '/v1/content/datasets' && request.method === 'GET') {
			const result = await handleListDatasets(env, url.searchParams);
			return json(result.data, result.code, cors);
		}

		// Blog slug match (must be after /blog to avoid conflict with /blog/publish)
		const publicBlogMatch = url.pathname.match(/^\/v1\/content\/blog\/([^/]+)$/);
		if (publicBlogMatch && request.method === 'GET' && publicBlogMatch[1] !== 'publish') {
			const result = await handleGetBlogPost(env, decodeURIComponent(publicBlogMatch[1]));
			return json(result.data || { error: result.error }, result.code, cors);
		}

		// ── Admin routes (require admin API key) ─────────────────────
		if (url.pathname.startsWith('/admin/')) {
			const adminKey = request.headers.get('X-API-Key');
			const adminData = adminKey ? await validateApiKey(adminKey, env) : null;
			const adminEmail = env.ADMIN_EMAIL || 'ty@eternium.ai';

			if (!adminData || adminData.email !== adminEmail) {
				return json({ error: 'Admin access required' }, 403, cors);
			}

			if (url.pathname === '/admin/overview' && request.method === 'GET') {
				const result = await handleAdminOverview(env);
				return json(result.data, result.code, cors);
			}

			// ── Tenant management routes ─────────────────────────────
			if (url.pathname === '/admin/tenants' && request.method === 'GET') {
				const result = await handleListTenants(env);
				return json(result.data || { error: result.error }, result.code, cors);
			}

			if (url.pathname === '/admin/tenants/provision' && request.method === 'POST') {
				const result = await handleProvisionTenant(request, env);
				return json(result.data || { error: result.error }, result.code, cors);
			}

			const tenantUpdateMatch = url.pathname.match(/^\/admin\/tenants\/([a-f0-9-]+)$/);
			if (tenantUpdateMatch && request.method === 'PATCH') {
				const result = await handleUpdateTenant(tenantUpdateMatch[1], request, env);
				return json(result.data || { error: result.error }, result.code, cors);
			}

			const revokeMatch = url.pathname.match(/^\/admin\/users\/(.+)\/revoke$/);
			if (revokeMatch) {
				const result = await handleAdminRevoke(decodeURIComponent(revokeMatch[1]), env);
				return json(result.data || { error: result.error }, result.code, cors);
			}

			const activateMatch = url.pathname.match(/^\/admin\/users\/(.+)\/activate$/);
			if (activateMatch) {
				const result = await handleAdminActivate(decodeURIComponent(activateMatch[1]), env);
				return json(result.data || { error: result.error }, result.code, cors);
			}

			if (url.pathname === '/admin/test-invite' && request.method === 'POST') {
				const result = await handleAdminTestInvite(request, env);
				return json(result.data || { error: result.error }, result.code, cors);
			}

			return json({ error: 'Not found' }, 404, cors);
		}

		// ── Authenticated routes ─────────────────────────────────────
		const apiKey = request.headers.get('X-API-Key')
			|| (request.headers.get('Authorization') || '').replace('Bearer ', '');

		if (!apiKey) {
			return json({ error: 'Authentication required. Pass API key via X-API-Key header, or Bearer token.' }, 401, cors);
		}

		let keyData = await validateApiKey(apiKey, env);

		// If not a valid API key, try as Supabase JWT
		if (!keyData) {
			const auth = await resolveJWTAuth(apiKey, env);
			if (auth) {
				keyData = await resolveSupabaseUser(auth.email, auth.supabaseUid, env);
			}
		}

		if (!keyData) {
			return json({ error: 'Invalid API key or token' }, 403, cors);
		}

		const tierConfig = TIERS[keyData.tier] || TIERS.free;
		const rateLimit = checkRateLimit(apiKey, tierConfig.rateLimit);
		const rlHeaders = {
			'X-RateLimit-Remaining': String(rateLimit.remaining),
			'X-RateLimit-Reset': String(Math.ceil(rateLimit.reset / 1000)),
			'X-Tier': keyData.tier,
		};

		if (!rateLimit.allowed) {
			return json({ error: 'Rate limit exceeded. Try again shortly.' }, 429, { ...cors, ...rlHeaders });
		}

		const headers = { ...cors, ...rlHeaders };

		// ── OpenAI-compatible routes (chat, embeddings, audio) ──────
		// POST /v1/chat/completions
		if (url.pathname === '/v1/chat/completions' && request.method === 'POST') {
			const result = await handleChatCompletions(request, env, keyData);
			// Add rate limit + CORS headers to the response
			const resHeaders = new Headers(result.response.headers);
			for (const [k, v] of Object.entries(headers)) resHeaders.set(k, v);
			return new Response(result.response.body, { status: result.response.status, headers: resHeaders });
		}

		// POST /v1/embeddings
		if (url.pathname === '/v1/embeddings' && request.method === 'POST') {
			const result = await handleEmbeddings(request, env, keyData);
			const resHeaders = new Headers(result.response.headers);
			for (const [k, v] of Object.entries(headers)) resHeaders.set(k, v);
			return new Response(result.response.body, { status: result.response.status, headers: resHeaders });
		}

		// POST /v1/audio/transcriptions
		if (url.pathname === '/v1/audio/transcriptions' && request.method === 'POST') {
			const result = await handleAudioTranscriptions(request, env, keyData);
			const resHeaders = new Headers(result.response.headers);
			for (const [k, v] of Object.entries(headers)) resHeaders.set(k, v);
			return new Response(result.response.body, { status: result.response.status, headers: resHeaders });
		}

		// ── Media upload / delete (R2) ──────────────────────────────
		if (url.pathname === '/v1/media/upload' && request.method === 'PUT') {
			const result = await handleMediaUpload(request, env, keyData);
			return json(result.data || { error: result.error }, result.code, headers);
		}

		if (url.pathname.startsWith('/v1/media/') && request.method === 'DELETE') {
			const key = decodeURIComponent(url.pathname.slice('/v1/media/'.length));
			if (!key) return json({ error: 'Media key required' }, 400, headers);
			const result = await handleMediaDelete(key, env, keyData);
			return json(result.data || { error: result.error }, result.code, headers);
		}

		// ── Kie.ai generation routes ────────────────────────────────
		// POST /v1/generate
		if (url.pathname === '/v1/generate' && request.method === 'POST') {
			let body;
			try { body = await request.json(); }
			catch { return json({ error: 'Invalid JSON body' }, 400, headers); }
			const result = await handleGenerate(body, env, keyData);
			return json(result.data || { error: result.error, usage: result.usage }, result.code, headers);
		}

		// POST /v1/pipelines/run
		if (url.pathname === '/v1/pipelines/run' && request.method === 'POST') {
			let body;
			try { body = await request.json(); }
			catch { return json({ error: 'Invalid JSON body' }, 400, headers); }
			const result = await handlePipeline(body, env, keyData);
			return json(result.data || { error: result.error, usage: result.usage }, result.code, headers);
		}

		// POST /v1/thumbnails/generate — campaign-aware thumbnail concepts
		if (url.pathname === '/v1/thumbnails/generate' && request.method === 'POST') {
			let body;
			try { body = await request.json(); }
			catch { return json({ error: 'Invalid JSON body' }, 400, headers); }
			const result = await handleThumbnailGenerate(body, env, keyData);
			return json(result.data || { error: result.error, usage: result.usage }, result.code, headers);
		}

		// GET /v1/usage
		if (url.pathname === '/v1/usage' && request.method === 'GET') {
			const result = await handleUsage(env, keyData);
			return json(result.data, result.code, headers);
		}

		// GET /v1/tasks/:id
		const taskMatch = url.pathname.match(/^\/v1\/tasks\/([^/]+)$/);
		if (taskMatch && request.method === 'GET') {
			const result = await handleTaskStatus(taskMatch[1], env);
			return json(result.data || { error: result.error }, result.code, headers);
		}

		// GET /v1/tasks/:id/download
		const downloadMatch = url.pathname.match(/^\/v1\/tasks\/([^/]+)\/download$/);
		if (downloadMatch && request.method === 'GET') {
			const result = await handleDownload(downloadMatch[1], env);
			return json(result.data || { error: result.error }, result.code, headers);
		}

		// ── Authenticated Content API routes ─────────────────────────
		// Publish a blog post (requires auth + admin)
		if (url.pathname === '/v1/content/blog/publish' && request.method === 'POST') {
			const body = await request.json();
			const result = await handlePublishBlogPost(env, keyData, body);
			return json(result.data || { error: result.error }, result.code, headers);
		}

		return json({ error: 'Not found' }, 404, headers);
	},
};

// ── Supabase REST helper ─────────────────────────────────────────
// Direct REST API calls to Supabase (no SDK needed in Workers)
async function supabaseQuery(env, table, { select = '*', filters = [], order, limit, single = false } = {}) {
	const baseUrl = env.SUPABASE_URL;
	const key = env.SUPABASE_SERVICE_KEY;

	if (!baseUrl || !key) {
		return { data: null, error: 'Supabase not configured' };
	}

	const params = new URLSearchParams();
	params.set('select', select);
	for (const f of filters) params.append(f.col, f.op + '.' + f.val);
	if (order) params.set('order', order);
	if (limit) params.set('limit', String(limit));

	const headers = {
		'apikey': key,
		'Authorization': `Bearer ${key}`,
		'Content-Type': 'application/json',
		'Prefer': single ? 'return=representation, count=exact' : 'return=representation',
	};
	if (single) headers['Accept'] = 'application/vnd.pgrst.object+json';

	const resp = await fetch(`${baseUrl}/rest/v1/${table}?${params}`, { headers });

	if (!resp.ok) {
		const err = await resp.text();
		return { data: null, error: `Supabase error: ${resp.status} ${err}` };
	}

	const data = await resp.json();
	return { data, error: null };
}

async function supabaseUpdate(env, table, id, updates) {
	const baseUrl = env.SUPABASE_URL;
	const key = env.SUPABASE_SERVICE_KEY;

	const resp = await fetch(`${baseUrl}/rest/v1/${table}?id=eq.${id}`, {
		method: 'PATCH',
		headers: {
			'apikey': key,
			'Authorization': `Bearer ${key}`,
			'Content-Type': 'application/json',
			'Prefer': 'return=representation',
		},
		body: JSON.stringify(updates),
	});

	if (!resp.ok) {
		const err = await resp.text();
		return { data: null, error: `Update failed: ${resp.status} ${err}` };
	}

	return { data: await resp.json(), error: null };
}

// ── Content API handlers ─────────────────────────────────────────

async function handleListBlogPosts(env, params) {
	const limit = Math.min(parseInt(params.get('limit') || '20'), 100);
	const offset = parseInt(params.get('offset') || '0');

	const { data, error } = await supabaseQuery(env, 'content_pipeline', {
		select: 'id,title,notes,external_urls,published_at,tags,campaign_id,created_at',
		filters: [
			{ col: 'type', op: 'eq', val: 'blog' },
			{ col: 'status', op: 'eq', val: 'published' },
		],
		order: 'published_at.desc',
		limit: limit,
	});

	if (error) return { data: { error }, code: 500 };

	const posts = (data || []).map(item => ({
		id: item.id,
		title: item.external_urls?.seo_title || item.title,
		slug: item.external_urls?.blog_slug || slugify(item.title),
		excerpt: item.external_urls?.seo_description || (item.notes || '').slice(0, 200),
		content: item.notes || '',
		published_at: item.published_at,
		author: 'Tyrin Barney',
		tags: item.tags || [],
		image: item.external_urls?.image_url || null,
		url: item.external_urls?.blog_url || `https://eternium.ai/blog/${item.external_urls?.blog_slug || slugify(item.title)}`,
	}));

	return { data: { posts, count: posts.length, offset }, code: 200 };
}

async function handleGetBlogPost(env, slug) {
	const { data, error } = await supabaseQuery(env, 'content_pipeline', {
		select: 'id,title,notes,external_urls,published_at,tags,campaign_id,created_at',
		filters: [
			{ col: 'type', op: 'eq', val: 'blog' },
			{ col: 'status', op: 'eq', val: 'published' },
			{ col: 'external_urls->>blog_slug', op: 'eq', val: slug },
		],
		single: true,
	});

	if (error || !data) return { data: null, error: 'Blog post not found', code: 404 };

	return {
		data: {
			id: data.id,
			title: data.external_urls?.seo_title || data.title,
			slug: data.external_urls?.blog_slug || slug,
			content: data.notes || '',
			excerpt: data.external_urls?.seo_description || '',
			published_at: data.published_at,
			author: 'Tyrin Barney',
			tags: data.tags || [],
			image: data.external_urls?.image_url || null,
			seo: {
				title: data.external_urls?.seo_title || data.title,
				description: data.external_urls?.seo_description || '',
			},
		},
		code: 200,
	};
}

async function handlePublishBlogPost(env, keyData, body) {
	// Only admin or internal tier can publish
	const adminEmail = env.ADMIN_EMAIL || 'ty@eternium.ai';
	if (keyData.email !== adminEmail && keyData.tier !== 'internal') {
		return { data: null, error: 'Admin access required to publish blog posts', code: 403 };
	}

	const { item_id, title, content, seo_title, seo_description, tags, image_url } = body;

	if (item_id) {
		// Publish existing pipeline item
		const slug = slugify(seo_title || title || 'untitled');
		const now = new Date().toISOString();
		const blogUrl = `https://eternium.ai/blog/${slug}`;

		const { error } = await supabaseUpdate(env, 'content_pipeline', item_id, {
			status: 'published',
			published_at: now,
			published_url: blogUrl,
			external_urls: {
				blog_slug: slug,
				blog_url: blogUrl,
				blog_published_at: now,
				seo_title: seo_title || title,
				seo_description: seo_description || '',
				image_url: image_url || null,
			},
		});

		if (error) return { data: null, error, code: 500 };
		return { data: { slug, url: blogUrl, published_at: now }, code: 200 };
	}

	// Create new blog post directly via API
	if (!title || !content) {
		return { data: null, error: 'title and content are required', code: 400 };
	}

	const slug = slugify(seo_title || title);
	const now = new Date().toISOString();
	const blogUrl = `https://eternium.ai/blog/${slug}`;

	const baseUrl = env.SUPABASE_URL;
	const key = env.SUPABASE_SERVICE_KEY;

	const resp = await fetch(`${baseUrl}/rest/v1/content_pipeline`, {
		method: 'POST',
		headers: {
			'apikey': key,
			'Authorization': `Bearer ${key}`,
			'Content-Type': 'application/json',
			'Prefer': 'return=representation',
		},
		body: JSON.stringify({
			title,
			type: 'blog',
			status: 'published',
			platforms: ['website'],
			notes: content,
			tags: tags || [],
			published_at: now,
			published_url: blogUrl,
			external_urls: {
				blog_slug: slug,
				blog_url: blogUrl,
				blog_published_at: now,
				seo_title: seo_title || title,
				seo_description: seo_description || '',
				image_url: image_url || null,
			},
		}),
	});

	if (!resp.ok) {
		const err = await resp.text();
		return { data: null, error: `Failed to create blog post: ${err}`, code: 500 };
	}

	const created = await resp.json();
	return { data: { id: created[0]?.id, slug, url: blogUrl, published_at: now }, code: 201 };
}

async function handleListProducts(env, params) {
	const category = params.get('category');
	const filters = [
		{ col: 'is_productized', op: 'eq', val: 'true' },
	];
	if (category) filters.push({ col: 'category', op: 'eq', val: category });

	const { data, error } = await supabaseQuery(env, 'datasets', {
		select: 'id,name,description,category,pricing_tier,status,metadata',
		filters,
		order: 'category,name',
	});

	if (error) return { data: { error }, code: 500 };

	const products = (data || []).map(d => ({
		id: d.id,
		name: d.name,
		description: d.description,
		category: d.category,
		tier: d.pricing_tier,
		status: d.status,
		download_url: d.metadata?.download_url || null,
		preview_url: d.metadata?.preview_url || null,
	}));

	return { data: { products, count: products.length }, code: 200 };
}

async function handleListDatasets(env, params) {
	const category = params.get('category');
	const filters = [];
	if (category) filters.push({ col: 'category', op: 'eq', val: category });

	const { data, error } = await supabaseQuery(env, 'datasets', {
		select: 'id,name,description,category,is_productized,pricing_tier,status',
		filters,
		order: 'category,name',
		limit: 100,
	});

	if (error) return { data: { error }, code: 500 };
	return { data: { datasets: data || [], count: (data || []).length }, code: 200 };
}

function slugify(text) {
	return (text || 'untitled')
		.toLowerCase()
		.replace(/[^a-z0-9\s-]/g, '')
		.replace(/\s+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '')
		.slice(0, 80);
}

function json(data, status = 200, extraHeaders = {}) {
	return new Response(JSON.stringify(data, null, 2), {
		status,
		headers: { 'Content-Type': 'application/json', ...extraHeaders },
	});
}
