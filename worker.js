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
	handleSignup, handleLogin, handleCheckout, handleProvisionKey,
	handleStripeSuccess, handleStripeWebhook,
	handleAdminOverview, handleAdminRevoke, handleAdminActivate,
} from './auth.js';

const KIE_BASE = 'https://api.kie.ai/api/v1';
const API_VERSION = '3.0.0';
const CREDIT_VALUE = 0.005; // 1 credit = $0.005 (200 credits per dollar)

const ALLOWED_ORIGINS = [
	'https://eternium.ai',
	'https://api.eternium.ai',
	'https://helix.eternium.ai',
	'http://localhost:3000',
	'http://localhost:5173',
	'http://localhost:8787',
];

// ── Kie.ai base costs (USD) ────────────────────────────────────
// Image models: flat per-image cost
// Video models: nested by mode/resolution → duration
const KIE_COSTS = {
	// ── Image ──
	'nano-banana-2':    0.045,
	'nano-banana-pro':  0.03,
	'gpt-5.4-image':    0.05,
	'gpt4o-image':      0.05,
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
	'gpt-4o':              { input: 2.50,  output: 10.00 },  // legacy/sunset
	'gpt-4o-mini':         { input: 0.15,  output: 0.60 },   // legacy/sunset
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
	free:       { name: 'Free',       monthlyCredits: 400,       rateLimit: 10,  concurrentTasks: 2  },
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
	'gpt4o-image': {
		type: 'image', name: 'GPT-4o Image', provider: 'OpenAI',
		description: 'OpenAI GPT-4o image generation',
		defaults: { aspectRatio: '1:1' },
		credits_per_gen: 14,
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
	'gpt-4o': {
		type: 'chat', name: 'GPT-4o (Legacy)', provider: 'OpenAI',
		description: 'Legacy model — sunset Feb 2026. Use GPT-5.1 instead.',
		pricing: { input_per_1m: 2.50, output_per_1m: 10.00 },
		deprecated: true,
	},
	'gpt-4o-mini': {
		type: 'chat', name: 'GPT-4o Mini (Legacy)', provider: 'OpenAI',
		description: 'Legacy compact model — sunset Feb 2026. Use GPT-5.1-Codex-Mini instead.',
		pricing: { input_per_1m: 0.15, output_per_1m: 0.60 },
		deprecated: true,
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
			{ model: 'gpt4o-image', promptTemplate: '{prompt}, YouTube thumbnail, bold text, high contrast, clickbait style, 16:9', overrides: { aspect_ratio: '16:9' } },
			{ model: 'gpt4o-image', promptTemplate: '{prompt}, YouTube thumbnail, dramatic reaction, vibrant colors, 16:9', overrides: { aspect_ratio: '16:9' } },
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
		'Access-Control-Allow-Methods': 'POST, GET, OPTIONS, DELETE',
		'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key',
		'Access-Control-Max-Age': '86400',
	};
	if (ALLOWED_ORIGINS.includes(origin)) {
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

// ── OpenAI proxy (chat, embeddings, audio) ──────────────────────
const OPENAI_BASE = 'https://api.openai.com/v1';

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

	// Forward to OpenAI
	const upstreamRes = await fetch(`${OPENAI_BASE}/chat/completions`, {
		method: 'POST',
		headers: {
			'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify(body),
	});

	if (!upstreamRes.ok) {
		const errBody = await upstreamRes.text();
		return { response: new Response(errBody, { status: upstreamRes.status, headers: { 'Content-Type': 'application/json' } }) };
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

	const upstreamRes = await fetch(`${OPENAI_BASE}/embeddings`, {
		method: 'POST',
		headers: {
			'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify(body),
	});

	if (!upstreamRes.ok) {
		const errBody = await upstreamRes.text();
		return { response: new Response(errBody, { status: upstreamRes.status, headers: { 'Content-Type': 'application/json' } }) };
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
		'nano-banana-2':   'nano-banana-2/generate',
		'nano-banana-pro': 'nano-banana-pro',
		'gpt-5.4-image':   'gpt-5.4/generate',
		'gpt4o-image':     'gpt4o-image/generate',
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
			},
		};
		if (params.resolution) kieBody.input.resolution = params.resolution;
		if (model === 'kling-3.0-mc' || (model === 'kling-3.0' && params.multi_shots)) {
			kieBody.input.multi_shots = true;
			kieBody.input.multi_prompt = params.multi_prompt || [];
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

async function handleTaskStatus(taskId, env) {
	if (!taskId) return { error: 'task_id is required', code: 400 };
	const result = await kieGet(`/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`, env);
	return { data: result, code: result.code === 200 ? 200 : (result.code || 500) };
}

async function handleDownload(taskId, env) {
	if (!taskId) return { error: 'task_id is required', code: 400 };
	const result = await kieGet(`/common/download-url?taskId=${encodeURIComponent(taskId)}`, env);
	return { data: result, code: result.code === 200 ? 200 : (result.code || 500) };
}

async function handleUsage(env, keyData) {
	const usage = await getUsage(env, keyData.key);
	const tierConfig = TIERS[keyData.tier] || TIERS.free;
	return {
		data: {
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
			}, 200, cors);
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
		if (url.pathname === '/auth/stripe-success' && request.method === 'GET') {
			const result = await handleStripeSuccess(request, env);
			return json(result.data || { error: result.error }, result.code, cors);
		}

		// ── Stripe webhook ───────────────────────────────────────────
		if (url.pathname === '/webhooks/stripe' && request.method === 'POST') {
			const result = await handleStripeWebhook(request, env);
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

			return json({ error: 'Not found' }, 404, cors);
		}

		// ── Authenticated routes ─────────────────────────────────────
		const apiKey = request.headers.get('X-API-Key')
			|| (request.headers.get('Authorization') || '').replace('Bearer ', '');

		if (!apiKey) {
			return json({ error: 'API key required. Pass via X-API-Key header or Authorization: Bearer <key>' }, 401, cors);
		}

		const keyData = await validateApiKey(apiKey, env);
		if (!keyData) {
			return json({ error: 'Invalid API key' }, 403, cors);
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

		return json({ error: 'Not found' }, 404, headers);
	},
};

function json(data, status = 200, extraHeaders = {}) {
	return new Response(JSON.stringify(data, null, 2), {
		status,
		headers: { 'Content-Type': 'application/json', ...extraHeaders },
	});
}
