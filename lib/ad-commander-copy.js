/**
 * lib/ad-commander-copy.js -- Ad Commander copy generation
 *
 * Two modes:
 *   scaffold    - generic Meta best-practices prompt
 *   from_winners - few-shot from account's top-5 CTR creatives
 *
 * Uses OpenAI (same upstream as /v1/chat/completions) via fetch.
 */

// ── Prompt templates ────────────────────────────────────────────────────────

const SCAFFOLD_SYSTEM = `You are a senior Meta (Facebook/Instagram) ad copywriter.
You write ad copy that drives clicks without tripping Meta's policy review.

Rules:
- Headline: 4-8 words. Punchy. No emojis. No all-caps.
- Body copy: 90-150 characters. Lead with the outcome, not the feature. One-line CTA last.
- No "click here", no "buy now" in headline. Use CTA buttons for that.
- Match CTA type to intent. Service = LEARN_MORE or CONTACT_US. Product = SHOP_NOW.
  SaaS = SIGN_UP. Downloadable = DOWNLOAD. Application = APPLY_NOW.
- Never promise outcomes you cannot deliver ("guaranteed results", "100% success").
- Never use em dashes. Hyphens or rephrase.

Return strictly a JSON object of shape {"variants": [...]} containing exactly
3 variant objects. Each variant has fields: headline (string), body_copy
(string), cta_type (enum), rationale (one sentence explaining why this
variant will perform). No preamble, no trailing commentary, just the JSON
object.`;

const FROM_WINNERS_SYSTEM = SCAFFOLD_SYSTEM + `

You will also receive this account's top 5 historical performers. Match their
voice, their sentence rhythm, and the type of hook they use. Do not copy them
verbatim. Create variants that feel like natural siblings of the winners.`;

const VALID_CTA_TYPES = [
	'LEARN_MORE', 'SIGN_UP', 'SHOP_NOW', 'SUBSCRIBE', 'CONTACT_US',
	'BOOK_TRAVEL', 'DOWNLOAD', 'GET_OFFER', 'APPLY_NOW',
];

const VALID_MODES = ['scaffold', 'from_winners'];

// ── Supabase helpers (PostgREST via service key) ────────────────────────────

async function supabaseFetch(env, path) {
	const resp = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
		headers: {
			'apikey': env.SUPABASE_SERVICE_KEY,
			'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
			'Accept': 'application/json',
		},
	});
	if (!resp.ok) {
		const err = await resp.text();
		return { data: null, error: `Supabase ${resp.status}: ${err}` };
	}
	return { data: await resp.json(), error: null };
}

// ── Tenant / access gating ──────────────────────────────────────────────────

export async function assertAdCommanderAccess(env, adsAccountId, authedTenantId) {
	const qs = new URLSearchParams({
		select: 'project_id,projects(id,project_type,tenant_id)',
		id: `eq.${adsAccountId}`,
	});
	const { data, error } = await supabaseFetch(env, `ads_accounts?${qs}`);
	if (error) return { ok: false, code: 500, error: 'Failed to verify account access', detail: error };
	if (!data || data.length === 0) return { ok: false, code: 404, error: 'Ads account not found', detail: null };

	const row = data[0];
	const project = row.projects;
	if (!project) return { ok: false, code: 404, error: 'Ads account has no linked project', detail: null };

	const allowedTypes = ['advertising_client', 'internal_saas'];
	if (project.tenant_id !== authedTenantId || !allowedTypes.includes(project.project_type)) {
		return { ok: false, code: 403, error: 'Access denied to this ads account', detail: null };
	}

	return { ok: true, projectId: project.id };
}

// ── Top-5 winners query ─────────────────────────────────────────────────────

async function fetchTopWinners(env, adsAccountId) {
	const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
	const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

	// Fetch creative insights joined with creatives for this account, last 30 days
	const qs = new URLSearchParams({
		select: 'creative_id,clicks,impressions,ads_creatives(id,headline,body_copy,cta_type)',
		ads_account_id: `eq.${adsAccountId}`,
		date: `gte.${thirtyDaysAgo}`,
	});
	const { data, error } = await supabaseFetch(env, `ads_creative_insights?${qs}`);
	if (error) return { winners: null, error, daysAvailable: 0 };
	if (!data || data.length === 0) return { winners: null, error: null, daysAvailable: 0 };

	// Check if we have at least 14 days of data
	const dates = data.map(r => r.date).filter(Boolean);
	const uniqueDates = [...new Set(dates)];
	const daysAvailable = uniqueDates.length;

	if (daysAvailable < 14) {
		return { winners: null, error: null, daysAvailable };
	}

	// Aggregate per creative: sum clicks, sum impressions
	const agg = {};
	for (const row of data) {
		const cid = row.creative_id;
		if (!agg[cid]) {
			agg[cid] = {
				id: cid,
				clicks: 0,
				impressions: 0,
				creative: row.ads_creatives,
			};
		}
		agg[cid].clicks += row.clicks || 0;
		agg[cid].impressions += row.impressions || 0;
	}

	// Filter noise: impressions > 500, compute CTR, sort desc, take top 5
	const ranked = Object.values(agg)
		.filter(c => c.impressions > 500 && c.creative)
		.map(c => ({
			id: c.id,
			headline: c.creative.headline,
			body_copy: c.creative.body_copy,
			cta_type: c.creative.cta_type,
			ctr: c.clicks / c.impressions,
			impressions: c.impressions,
		}))
		.sort((a, b) => b.ctr - a.ctr)
		.slice(0, 5);

	if (ranked.length === 0) {
		return { winners: null, error: null, daysAvailable };
	}

	return { winners: ranked, error: null, daysAvailable };
}

// ── Prompt builders ─────────────────────────────────────────────────────────

function buildScaffoldPrompt(productDescription, targetAudience) {
	return {
		system: SCAFFOLD_SYSTEM,
		messages: [
			{
				role: 'user',
				content: `Product/service: ${productDescription}\n\nTarget audience: ${targetAudience}`,
			},
		],
	};
}

function buildFromWinnersPrompt(productDescription, targetAudience, winners) {
	const winnersJson = JSON.stringify(winners.map((w, i) => ({
		rank: i + 1,
		headline: w.headline,
		body_copy: w.body_copy,
		cta_type: w.cta_type,
		ctr: (w.ctr * 100).toFixed(2) + '%',
		impressions: w.impressions,
	})), null, 2);

	return {
		system: FROM_WINNERS_SYSTEM,
		messages: [
			{
				role: 'user',
				content: `Product/service: ${productDescription}\n\nTarget audience: ${targetAudience}`,
			},
			{
				role: 'assistant',
				content: `Here are this account's top 5 performing creatives:\n\n${winnersJson}\n\nI'll now generate 3 new variants that match their voice and structure.`,
			},
			{
				role: 'user',
				content: 'Generate the 3 new ad copy variants as a JSON array.',
			},
		],
	};
}

// ── OpenAI caller (mirrors handleChatCompletions upstream) ──────────────────

const COPY_GEN_MODEL = 'gpt-5.4';

async function callLLM(env, prompt) {
	if (!env.OPENAI_API_KEY) {
		return { result: null, error: 'OPENAI_API_KEY not configured', tokenUsage: null };
	}

	const messages = [
		{ role: 'system', content: prompt.system },
		...prompt.messages,
	];

	const resp = await fetch('https://api.openai.com/v1/chat/completions', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
		},
		body: JSON.stringify({
			model: COPY_GEN_MODEL,
			messages,
			response_format: { type: 'json_object' },
			max_completion_tokens: 1024,
		}),
	});

	if (!resp.ok) {
		const errBody = await resp.text();
		let msg = `OpenAI error ${resp.status}`;
		try {
			const parsed = JSON.parse(errBody);
			msg = parsed.error?.message || msg;
		} catch { /* use default */ }
		return { result: null, error: msg, tokenUsage: null };
	}

	const body = await resp.json();
	const text = body.choices?.[0]?.message?.content || '';
	const tokenUsage = {
		input: body.usage?.prompt_tokens || 0,
		output: body.usage?.completion_tokens || 0,
	};

	return { result: text, error: null, tokenUsage };
}

// ── Response parser ─────────────────────────────────────────────────────────

function parseVariants(raw) {
	let cleaned = raw.trim();
	const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (fenceMatch) cleaned = fenceMatch[1].trim();

	const parsed = JSON.parse(cleaned);
	const arr = Array.isArray(parsed) ? parsed : parsed.variants;
	if (!Array.isArray(arr) || arr.length === 0) {
		throw new Error('Expected variants array');
	}

	return arr.map(v => ({
		headline: String(v.headline || ''),
		body_copy: String(v.body_copy || ''),
		cta_type: VALID_CTA_TYPES.includes(v.cta_type) ? v.cta_type : 'LEARN_MORE',
		rationale: String(v.rationale || ''),
	}));
}

// ── Main handler ────────────────────────────────────────────────────────────

export async function handleAdCommanderDraft(body, env, keyData) {
	// Validate required fields
	const { ads_account_id, format, product_description, target_audience, mode } = body || {};

	if (!ads_account_id) {
		return { code: 400, data: { error: 'ads_account_id is required', code: 'MISSING_FIELD' } };
	}
	if (!product_description) {
		return { code: 400, data: { error: 'product_description is required', code: 'MISSING_FIELD' } };
	}
	if (!target_audience) {
		return { code: 400, data: { error: 'target_audience is required', code: 'MISSING_FIELD' } };
	}
	if (!mode || !VALID_MODES.includes(mode)) {
		return { code: 400, data: { error: `mode must be one of: ${VALID_MODES.join(', ')}`, code: 'INVALID_MODE' } };
	}

	// Tenant access check
	const authedTenantId = keyData.tenant_id;
	const access = await assertAdCommanderAccess(env, ads_account_id, authedTenantId);
	if (!access.ok) {
		return { code: access.code, data: { error: access.error, code: access.code === 403 ? 'FORBIDDEN' : access.code === 404 ? 'NOT_FOUND' : 'INTERNAL' } };
	}

	let prompt;
	let winnersReferenced = null;

	if (mode === 'from_winners') {
		const { winners, error: winnersError, daysAvailable } = await fetchTopWinners(env, ads_account_id);

		if (winnersError) {
			return { code: 500, data: { error: 'Failed to fetch creative insights', code: 'INTERNAL' } };
		}

		if (!winners) {
			return {
				code: 409,
				data: {
					error: 'insufficient_history',
					code: 'INSUFFICIENT_HISTORY',
					days_available: daysAvailable,
				},
			};
		}

		prompt = buildFromWinnersPrompt(product_description, target_audience, winners);
		winnersReferenced = winners.map(w => w.id);
	} else {
		prompt = buildScaffoldPrompt(product_description, target_audience);
	}

	const { result, error: llmError, tokenUsage } = await callLLM(env, prompt);

	if (llmError) {
		return { code: 503, data: { error: llmError, code: 'OPENAI_UPSTREAM' } };
	}

	let variants;
	try {
		variants = parseVariants(result);
	} catch (e) {
		return { code: 502, data: { error: 'Failed to parse LLM response', code: 'PARSE_ERROR' } };
	}

	const response = {
		variants,
		mode_used: mode,
		model: COPY_GEN_MODEL,
		token_usage: tokenUsage,
	};

	if (winnersReferenced) {
		response.winners_referenced = winnersReferenced;
	}

	return { code: 200, data: response };
}
