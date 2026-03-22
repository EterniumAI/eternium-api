/**
 * Eternium API v2 — Cloudflare Worker
 * AI generation API powered by Kie.ai infrastructure.
 * Deploy with: cd api && wrangler deploy
 *
 * Environment variables (Cloudflare Dashboard or wrangler secret):
 *   KIE_API_KEY            — Kie.ai API key
 *   STRIPE_SECRET_KEY      — Stripe API key
 *   STRIPE_WEBHOOK_SECRET  — Stripe webhook signing secret
 *   JWT_SECRET             — Session token secret
 *   ADMIN_EMAIL            — Admin email (ty@eternium.ai)
 *
 * KV Namespaces (bind in wrangler.toml):
 *   API_KEYS        — API key records  { key, name, tier, rateLimit, createdAt }
 *   USERS           — User accounts    { email, passwordHash, name, tier, apiKey, ... }
 *   USAGE           — Per-key usage tracking
 *   CACHE           — Generation result cache (prompt dedup for agents)
 */

import {
	handleSignup, handleLogin, handleCheckout, handleProvisionKey,
	handleStripeSuccess, handleStripeWebhook,
	handleAdminOverview, handleAdminRevoke, handleAdminActivate,
} from './auth.js';

const KIE_BASE = 'https://api.kie.ai/api/v1';
const API_VERSION = '2.0.0';

const ALLOWED_ORIGINS = [
	'https://eternium.ai',
	'https://api.eternium.ai',
	'https://helix.eternium.ai',
	'http://localhost:3000',
	'http://localhost:5173',
];

// ── Pricing (our cost from Kie.ai in USD) ───────────────────────
const KIE_COSTS = {
	'nano-banana-pro': 0.03,
	'flux-kontext': 0.04,
	'gpt4o-image': 0.05,
	'kling-3.0': { std: { 5: 0.35, 10: 0.65 }, pro: { 5: 0.55, 10: 1.10 } },
	'kling-2.6': { std: { 5: 0.28, 10: 0.55 }, pro: { 5: 0.45, 10: 0.90 } },
	'wan-2.6': { '720p': { 5: 0.30, 10: 0.60 }, '1080p': { 5: 0.50, 10: 1.00 } },
};

// ── Our pricing (35% markup on images, 30% on video) ────────────
const MARKUP = { image: 1.35, video: 1.30 };

function getGenerationCost(model, params = {}, keyTier = null) {
	const base = KIE_COSTS[model];
	if (!base) return 0;
	const noMarkup = keyTier === 'internal';
	if (typeof base === 'number') return +(base * (noMarkup ? 1 : MARKUP.image)).toFixed(4);
	// Video pricing by mode/resolution and duration
	const mode = params.mode || params.resolution || Object.keys(base)[0];
	const duration = params.duration || 5;
	const tier = base[mode] || base[Object.keys(base)[0]];
	const raw = tier[duration] || tier[Object.keys(tier)[0]];
	return +(raw * (noMarkup ? 1 : MARKUP.video)).toFixed(4);
}

// ── Tier definitions ────────────────────────────────────────────
const TIERS = {
	free:       { name: 'Free',       monthlyCredits: 2.00,   rateLimit: 10,  concurrentTasks: 2  },
	starter:    { name: 'Starter',    monthlyCredits: 22.00,  rateLimit: 30,  concurrentTasks: 5  },
	builder:    { name: 'Builder',    monthlyCredits: 62.00,  rateLimit: 45,  concurrentTasks: 10 },
	scale:      { name: 'Scale',      monthlyCredits: 165.00, rateLimit: 60,  concurrentTasks: 20 },
	enterprise: { name: 'Enterprise', monthlyCredits: 999.00, rateLimit: 120, concurrentTasks: 50 },
	internal:   { name: 'Internal',   monthlyCredits: 9999.00, rateLimit: 200, concurrentTasks: 100 },
};

// ── Supported models ────────────────────────────────────────────
const MODELS = {
	'nano-banana-pro': {
		type: 'image', name: 'Nano Banana Pro',
		description: 'Fast, precise AI image generation with native 4K output',
		defaults: { aspect_ratio: '1:1', resolution: '1K', output_format: 'png' },
		cost_per_gen: '$0.04',
	},
	'flux-kontext': {
		type: 'image', name: 'Flux Kontext',
		description: 'Advanced image generation and editing',
		defaults: { aspect_ratio: '1:1' },
		cost_per_gen: '$0.05',
	},
	'gpt4o-image': {
		type: 'image', name: 'GPT-4o Image',
		description: 'OpenAI GPT-4o image generation',
		defaults: { aspectRatio: '1:1' },
		cost_per_gen: '$0.07',
	},
	'kling-3.0': {
		type: 'video', name: 'Kling 3.0',
		description: 'Advanced video generation with multi-shot and element references',
		defaults: { duration: 5, aspect_ratio: '16:9', mode: 'std', sound: false },
		cost_per_gen: '$0.46-$1.43',
	},
	'kling-2.6': {
		type: 'video', name: 'Kling 2.6',
		description: 'High-quality video generation with audio support',
		defaults: { duration: 5, aspect_ratio: '16:9', mode: 'std', sound: false },
		cost_per_gen: '$0.36-$1.17',
	},
	'wan-2.6': {
		type: 'video', name: 'Wan 2.6',
		description: 'Multi-shot HD video with native audio',
		defaults: { duration: 5, resolution: '720p' },
		cost_per_gen: '$0.39-$1.30',
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

// ── Usage tracking (KV-based) ───────────────────────────────────
function getUsageKey(apiKey) {
	const month = new Date().toISOString().slice(0, 7); // YYYY-MM
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

async function trackUsage(env, apiKey, cost, model, cached = false) {
	if (!env.USAGE) return;
	const usage = await getUsage(env, apiKey);
	usage.spent = +(usage.spent + cost).toFixed(4);
	usage.generations++;
	if (cached) usage.cached++;
	// Keep last 100 tasks for the dashboard
	usage.tasks.unshift({ model, cost, cached, ts: Date.now() });
	if (usage.tasks.length > 100) usage.tasks = usage.tasks.slice(0, 100);
	try {
		await env.USAGE.put(getUsageKey(apiKey), JSON.stringify(usage), { expirationTtl: 90 * 86400 });
	} catch { /* non-critical */ }
}

async function checkBudget(env, apiKey, tier, cost) {
	const tierConfig = TIERS[tier] || TIERS.free;
	const usage = await getUsage(env, apiKey);
	if (usage.spent + cost > tierConfig.monthlyCredits) {
		return { allowed: false, spent: usage.spent, limit: tierConfig.monthlyCredits, overage: usage.spent + cost - tierConfig.monthlyCredits };
	}
	return { allowed: true, spent: usage.spent, limit: tierConfig.monthlyCredits, remaining: tierConfig.monthlyCredits - usage.spent - cost };
}

// ── API key management (KV-based) ──────────────────────────────
async function validateApiKey(key, env) {
	// Try KV first
	if (env.API_KEYS) {
		try {
			const data = await env.API_KEYS.get(`key:${key}`, 'json');
			if (data) return data;
		} catch { /* fall through */ }
	}
	// Fallback to JSON env var
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

// ── Build Kie request body from our params ──────────────────────
function buildKieBody(model, prompt, params) {
	const modelConfig = MODELS[model];
	if (modelConfig.type === 'image') {
		if (model === 'gpt4o-image') {
			return {
				model: 'gpt4o-image/generate',
				callBackUrl: params.callback_url || '',
				input: { prompt, aspectRatio: params.aspect_ratio || '1:1' },
			};
		} else if (model === 'flux-kontext') {
			return {
				model: 'flux-kontext/generate',
				callBackUrl: params.callback_url || '',
				input: { prompt, image_urls: params.image_urls || [], aspect_ratio: params.aspect_ratio || '1:1' },
			};
		} else {
			return {
				model: 'nano-banana-pro',
				callBackUrl: params.callback_url || '',
				input: {
					prompt,
					image_input: params.image_urls || [],
					aspect_ratio: params.aspect_ratio || '1:1',
					resolution: params.resolution || '1K',
					output_format: params.output_format || 'png',
				},
			};
		}
	} else {
		const slugMap = { 'kling-3.0': 'kling-3.0/video', 'kling-2.6': 'kling-2.6/video', 'wan-2.6': 'wan-2.6/video' };
		const kieBody = {
			model: slugMap[model] || model,
			callBackUrl: params.callback_url || '',
			input: {
				prompt,
				image_urls: params.image_urls || [],
				duration: params.duration || modelConfig.defaults.duration,
				aspect_ratio: params.aspect_ratio || modelConfig.defaults.aspect_ratio,
				mode: params.mode || modelConfig.defaults.mode || 'std',
				sound: params.sound ?? modelConfig.defaults.sound ?? false,
			},
		};
		if (model === 'kling-3.0' && params.multi_shots) {
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

	const cost = getGenerationCost(model, params, keyData.tier);

	// Budget check
	const budget = await checkBudget(env, keyData.key, keyData.tier, cost);
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
				data: { ...cached, _cached: true, _saved: `$${cost}` },
				code: 200,
			};
		}
	}

	const kieBody = buildKieBody(model, prompt, params);
	const result = await kieRequest('/jobs/createTask', kieBody, env);

	// Track usage
	await trackUsage(env, keyData.key, cost, model, false);

	// Cache the task creation response
	if (cache !== false && result.code === 200) {
		const cacheKey = getCacheKey(model, prompt, params);
		await setCache(env, cacheKey, result, 3600);
	}

	return {
		data: { ...result, _cost: `$${cost}`, _budget_remaining: `$${(budget.remaining || 0).toFixed(2)}` },
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
	let totalCost = 0;

	for (const step of pipelineDef.steps) {
		const stepParams = { ...params, ...step.overrides };
		const cost = getGenerationCost(step.model, stepParams, keyData.tier);
		totalCost += cost;
	}

	// Budget check for entire pipeline
	const budget = await checkBudget(env, keyData.key, keyData.tier, totalCost);
	if (!budget.allowed) {
		return {
			error: 'Monthly credit limit reached. This pipeline costs $' + totalCost.toFixed(2),
			code: 402,
			usage: { spent: budget.spent, limit: budget.limit, pipeline_cost: totalCost },
		};
	}

	// Execute all steps
	for (const step of pipelineDef.steps) {
		const stepPrompt = step.promptTemplate.replace('{prompt}', prompt);
		const stepParams = { ...params, ...step.overrides };
		const kieBody = buildKieBody(step.model, stepPrompt, stepParams);
		const result = await kieRequest('/jobs/createTask', kieBody, env);
		const cost = getGenerationCost(step.model, stepParams, keyData.tier);
		await trackUsage(env, keyData.key, cost, step.model, false);
		tasks.push({
			model: step.model,
			taskId: result.data?.taskId || null,
			cost: `$${cost.toFixed(4)}`,
			status: result.code === 200 ? 'submitted' : 'failed',
			error: result.code !== 200 ? result.msg : undefined,
		});
	}

	return {
		data: {
			pipeline: pipeline,
			name: pipelineDef.name,
			total_cost: `$${totalCost.toFixed(2)}`,
			budget_remaining: `$${((budget.remaining || 0) - totalCost).toFixed(2)}`,
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
			monthly_limit: `$${tierConfig.monthlyCredits.toFixed(2)}`,
			spent: `$${usage.spent.toFixed(2)}`,
			remaining: `$${(tierConfig.monthlyCredits - usage.spent).toFixed(2)}`,
			generations: usage.generations,
			cached_hits: usage.cached,
			cache_savings: usage.cached > 0 ? `~$${(usage.cached * 0.04).toFixed(2)}` : '$0.00',
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

		if (url.pathname === '/' || url.pathname === '/health') {
			return json({
				service: 'Eternium API',
				version: API_VERSION,
				status: 'operational',
				docs: 'https://api.eternium.ai/v1/docs',
				models: Object.keys(MODELS).length,
				pipelines: Object.keys(PIPELINES).length,
			}, 200, cors);
		}

		if (url.pathname === '/v1/models' && request.method === 'GET') {
			const models = Object.entries(MODELS).map(([id, m]) => ({
				id, type: m.type, name: m.name, description: m.description, cost_per_gen: m.cost_per_gen,
			}));
			return json({ models }, 200, cors);
		}

		if (url.pathname === '/v1/pipelines' && request.method === 'GET') {
			const pipelines = Object.entries(PIPELINES).map(([id, p]) => ({
				id, name: p.name, description: p.description, steps: p.steps.length,
			}));
			return json({ pipelines }, 200, cors);
		}

		if (url.pathname === '/v1/tiers' && request.method === 'GET') {
			return json({ tiers: TIERS }, 200, cors);
		}

		if (url.pathname === '/v1/docs' && request.method === 'GET') {
			return json({
				name: 'Eternium API',
				version: API_VERSION,
				base_url: 'https://api.eternium.ai',
				authentication: 'X-API-Key header or Authorization: Bearer <key>',
				features: ['Prompt caching (agent dedup)', 'Multi-model pipelines', 'Usage tracking & budget alerts', 'Per-key rate limiting'],
				endpoints: {
					'POST /v1/generate': { description: 'Generate image or video', body: { model: 'string', prompt: 'string', cache: 'boolean (default true)', callback_url: 'string', '...': 'model-specific' } },
					'POST /v1/pipelines/run': { description: 'Run a multi-step pipeline', body: { pipeline: 'string', prompt: 'string' } },
					'GET /v1/tasks/:id': { description: 'Check task status' },
					'GET /v1/tasks/:id/download': { description: 'Get download URL (expires 20m)' },
					'GET /v1/models': { description: 'List available models' },
					'GET /v1/pipelines': { description: 'List available pipelines' },
					'GET /v1/tiers': { description: 'List pricing tiers' },
					'GET /v1/usage': { description: 'Get your usage & budget (authenticated)' },
				},
				models: Object.entries(MODELS).map(([id, m]) => ({ id, type: m.type, name: m.name, cost_per_gen: m.cost_per_gen })),
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

			// Check if this key belongs to admin
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
