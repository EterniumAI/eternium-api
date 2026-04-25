/**
 * lib/ad-commander.js -- Ad Commander REST surface
 *
 * Endpoints: create, autofill-copy, patch, review, publish,
 *            action-logs, metrics, list creatives.
 *
 * All handlers receive (body|params, env, keyData) and return { code, data }.
 */

import { assertAdCommanderAccess, handleAdCommanderDraft } from './ad-commander-copy.js';

// ── Supabase helpers ─────────────────────────────────────────────────────────

async function supabaseFetch(env, path, options = {}) {
	const { method = 'GET', body, prefer } = options;
	const headers = {
		'apikey': env.SUPABASE_SERVICE_KEY,
		'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
		'Accept': 'application/json',
		'Content-Type': 'application/json',
	};
	if (prefer) headers['Prefer'] = prefer;

	const resp = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
		method,
		headers,
		...(body ? { body: JSON.stringify(body) } : {}),
	});

	if (!resp.ok) {
		const err = await resp.text();
		return { data: null, error: `Supabase ${resp.status}: ${err}` };
	}

	const text = await resp.text();
	if (!text) return { data: null, error: null };
	return { data: JSON.parse(text), error: null };
}

// ── Resolve tenant + project from ads_account_id ─────────────────────────────

async function resolveAdsAccount(env, adsAccountId) {
	const qs = new URLSearchParams({
		select: 'id,tenant_id,project_id,projects(id,project_type)',
		id: `eq.${adsAccountId}`,
	});
	const { data, error } = await supabaseFetch(env, `ads_accounts?${qs}`);
	if (error) return { ok: false, error };
	if (!data || data.length === 0) return { ok: false, error: 'Account not found' };
	const row = data[0];
	return {
		ok: true,
		project_id: row.project_id,
		tenant_id: row.tenant_id,
		project_type: row.projects?.project_type,
	};
}

// ── Actor string (safe for logging, no key material) ─────────────────────────

function actorString(keyData) {
	if (keyData.__userId) return `user:${keyData.__userId}`;
	if (keyData.supabase_uid) return `user:${keyData.supabase_uid}`;
	if (keyData.key_id) return `api_key:${keyData.key_id}`;
	return `email:${keyData.email || 'unknown'}`;
}

// ── POST /v1/ad-commander/creatives ──────────────────────────────────────────

export async function handleCreateCreative(body, env, keyData) {
	const required = ['ads_account_id', 'headline', 'body_copy', 'cta_type', 'link_url', 'generation_source'];
	for (const field of required) {
		if (!body[field]) {
			return { code: 400, data: { error: `${field} is required`, code: 'MISSING_FIELD' } };
		}
	}

	const validSources = ['manual', 'claude_scaffold', 'claude_from_winners', 'external_llm'];
	if (!validSources.includes(body.generation_source)) {
		return { code: 400, data: { error: `generation_source must be one of: ${validSources.join(', ')}`, code: 'INVALID_FIELD' } };
	}

	const access = await assertAdCommanderAccess(env, body.ads_account_id, keyData);
	if (!access.ok) {
		return { code: access.code, data: { error: access.error, code: access.code === 403 ? 'PROJECT_ACCESS_DENIED' : 'ACCOUNT_NOT_FOUND' } };
	}

	const account = await resolveAdsAccount(env, body.ads_account_id);
	if (!account.ok) {
		return { code: 500, data: { error: 'Failed to resolve account', code: 'INTERNAL' } };
	}

	const row = {
		ads_account_id: body.ads_account_id,
		tenant_id: account.tenant_id,
		project_id: account.project_id,
		headline: body.headline,
		body_copy: body.body_copy,
		cta_type: body.cta_type,
		link_url: body.link_url,
		workflow_status: 'draft',
		generation_source: body.generation_source,
		created_by: keyData.__userId || keyData.supabase_uid || keyData.email,
	};

	if (body.thumbnail_url) row.thumbnail_url = body.thumbnail_url;
	if (body.asset_url) row.asset_url = body.asset_url;
	if (body.generation_metadata) row.generation_metadata = body.generation_metadata;

	const { data, error } = await supabaseFetch(env, 'ads_creatives', {
		method: 'POST',
		body: row,
		prefer: 'return=representation',
	});

	if (error) {
		return { code: 500, data: { error: 'Failed to create creative', code: 'INTERNAL', detail: error } };
	}

	const created = Array.isArray(data) ? data[0] : data;
	return {
		code: 201,
		data: { id: created.id, workflow_status: created.workflow_status, created_at: created.created_at },
	};
}

// ── POST /v1/ad-commander/creatives/:id/autofill-copy ────────────────────────

export async function handleAutofillCopy(creativeId, body, env, keyData) {
	const { product_description, target_audience, mode } = body || {};

	if (!product_description) return { code: 400, data: { error: 'product_description is required', code: 'MISSING_FIELD' } };
	if (!target_audience) return { code: 400, data: { error: 'target_audience is required', code: 'MISSING_FIELD' } };
	if (!mode) return { code: 400, data: { error: 'mode is required', code: 'MISSING_FIELD' } };

	// Fetch the creative to get ads_account_id
	const qs = new URLSearchParams({ select: 'id,ads_account_id,workflow_status', id: `eq.${creativeId}` });
	const { data: creatives, error: fetchErr } = await supabaseFetch(env, `ads_creatives?${qs}`);
	if (fetchErr || !creatives || creatives.length === 0) {
		return { code: 404, data: { error: 'Creative not found', code: 'NOT_FOUND' } };
	}

	const creative = creatives[0];

	// Access check
	const access = await assertAdCommanderAccess(env, creative.ads_account_id, keyData);
	if (!access.ok) {
		return { code: access.code, data: { error: access.error, code: access.code === 403 ? 'PROJECT_ACCESS_DENIED' : 'ACCOUNT_NOT_FOUND' } };
	}

	// Delegate to copy-gen core logic
	const draftResult = await handleAdCommanderDraft({
		ads_account_id: creative.ads_account_id,
		product_description,
		target_audience,
		mode,
	}, env, keyData);

	if (draftResult.code !== 200) {
		return draftResult;
	}

	const variants = draftResult.data.variants;
	const chosen = variants[0];

	// Update the creative with the first variant
	const updateQs = new URLSearchParams({ id: `eq.${creativeId}` });
	const updateBody = {
		headline: chosen.headline,
		body_copy: chosen.body_copy,
		cta_type: chosen.cta_type,
		generation_source: mode === 'from_winners' ? 'claude_from_winners' : 'claude_scaffold',
		generation_metadata: {
			mode: draftResult.data.mode_used,
			model: draftResult.data.model,
			token_usage: draftResult.data.token_usage,
			variant_count: variants.length,
			chosen_index: 0,
		},
	};

	await supabaseFetch(env, `ads_creatives?${updateQs}`, {
		method: 'PATCH',
		body: updateBody,
		prefer: 'return=minimal',
	});

	return {
		code: 200,
		data: {
			chosen_variant_index: 0,
			variants,
			generation_metadata: updateBody.generation_metadata,
		},
	};
}

// ── PATCH /v1/ad-commander/creatives/:id ─────────────────────────────────────

export async function handlePatchCreative(creativeId, body, env, keyData) {
	// Fetch the creative
	const qs = new URLSearchParams({ select: 'id,ads_account_id,workflow_status', id: `eq.${creativeId}` });
	const { data: creatives, error: fetchErr } = await supabaseFetch(env, `ads_creatives?${qs}`);
	if (fetchErr || !creatives || creatives.length === 0) {
		return { code: 404, data: { error: 'Creative not found', code: 'NOT_FOUND' } };
	}

	const creative = creatives[0];

	// Access check
	const access = await assertAdCommanderAccess(env, creative.ads_account_id, keyData);
	if (!access.ok) {
		return { code: access.code, data: { error: access.error, code: access.code === 403 ? 'PROJECT_ACCESS_DENIED' : 'ACCOUNT_NOT_FOUND' } };
	}

	// Only editable in draft or pending_review
	if (!['draft', 'pending_review'].includes(creative.workflow_status)) {
		return { code: 400, data: { error: `Cannot edit creative in status: ${creative.workflow_status}`, code: 'INVALID_STATUS' } };
	}

	const allowedFields = ['headline', 'body_copy', 'cta_type', 'thumbnail_url', 'asset_url', 'link_url'];
	const patch = {};
	for (const field of allowedFields) {
		if (body[field] !== undefined) patch[field] = body[field];
	}

	if (Object.keys(patch).length === 0) {
		return { code: 400, data: { error: 'No valid fields to update', code: 'EMPTY_PATCH' } };
	}

	const updateQs = new URLSearchParams({ id: `eq.${creativeId}` });
	const { data, error } = await supabaseFetch(env, `ads_creatives?${updateQs}`, {
		method: 'PATCH',
		body: patch,
		prefer: 'return=representation',
	});

	if (error) {
		return { code: 500, data: { error: 'Failed to update creative', code: 'INTERNAL' } };
	}

	const updated = Array.isArray(data) ? data[0] : data;
	return { code: 200, data: updated };
}

// ── POST /v1/ad-commander/creatives/:id/review ───────────────────────────────

const VALID_TRANSITIONS = {
	'draft': ['pending_review'],
	'pending_review': ['approved'],
	'approved': ['archived'],
};

export async function handleReviewCreative(creativeId, body, env, keyData) {
	const { next_status, review_notes } = body || {};

	if (!next_status) {
		return { code: 400, data: { error: 'next_status is required', code: 'MISSING_FIELD' } };
	}

	// Fetch the creative
	const qs = new URLSearchParams({ select: 'id,ads_account_id,workflow_status', id: `eq.${creativeId}` });
	const { data: creatives, error: fetchErr } = await supabaseFetch(env, `ads_creatives?${qs}`);
	if (fetchErr || !creatives || creatives.length === 0) {
		return { code: 404, data: { error: 'Creative not found', code: 'NOT_FOUND' } };
	}

	const creative = creatives[0];

	// Access check
	const access = await assertAdCommanderAccess(env, creative.ads_account_id, keyData);
	if (!access.ok) {
		return { code: access.code, data: { error: access.error, code: access.code === 403 ? 'PROJECT_ACCESS_DENIED' : 'ACCOUNT_NOT_FOUND' } };
	}

	// Validate transition
	const currentStatus = creative.workflow_status;

	// Special case: any status can transition to 'failed' (with required review_notes)
	if (next_status === 'failed') {
		if (!review_notes) {
			return { code: 400, data: { error: 'review_notes is required when transitioning to failed', code: 'MISSING_FIELD' } };
		}
	} else {
		const allowed = VALID_TRANSITIONS[currentStatus];
		if (!allowed || !allowed.includes(next_status)) {
			return {
				code: 400,
				data: {
					error: `Invalid transition: ${currentStatus} -> ${next_status}`,
					code: 'INVALID_TRANSITION',
				},
			};
		}
	}

	const patch = { workflow_status: next_status };
	if (review_notes) patch.review_notes = review_notes;
	if (next_status === 'approved') {
		patch.reviewed_by = keyData.__userId || keyData.supabase_uid || keyData.email;
	}

	const updateQs = new URLSearchParams({ id: `eq.${creativeId}` });
	const { data, error } = await supabaseFetch(env, `ads_creatives?${updateQs}`, {
		method: 'PATCH',
		body: patch,
		prefer: 'return=representation',
	});

	if (error) {
		return { code: 500, data: { error: 'Failed to update creative', code: 'INTERNAL' } };
	}

	const updated = Array.isArray(data) ? data[0] : data;
	return { code: 200, data: updated };
}

// ── POST /v1/ad-commander/creatives/:id/publish ──────────────────────────────

export async function handlePublishCreative(creativeId, body, env, keyData) {
	// Fetch the creative
	const qs = new URLSearchParams({ select: 'id,ads_account_id,workflow_status', id: `eq.${creativeId}` });
	const { data: creatives, error: fetchErr } = await supabaseFetch(env, `ads_creatives?${qs}`);
	if (fetchErr || !creatives || creatives.length === 0) {
		return { code: 404, data: { error: 'Creative not found', code: 'NOT_FOUND' } };
	}

	const creative = creatives[0];

	// Access check
	const access = await assertAdCommanderAccess(env, creative.ads_account_id, keyData);
	if (!access.ok) {
		return { code: access.code, data: { error: access.error, code: access.code === 403 ? 'PROJECT_ACCESS_DENIED' : 'ACCOUNT_NOT_FOUND' } };
	}

	if (creative.workflow_status !== 'approved') {
		return {
			code: 400,
			data: {
				error: `Creative must be approved before publishing. Current status: ${creative.workflow_status}`,
				code: 'NOT_APPROVED',
			},
		};
	}

	// Stub: op-4 write-library not yet deployed
	return {
		code: 501,
		data: {
			error: 'publish_not_wired',
			code: 'PUBLISH_NOT_WIRED',
			reason: 'op-4 write-library not yet deployed',
		},
	};
}

// ── GET /v1/ad-commander/action-logs/:id ─────────────────────────────────────

export async function handleGetActionLog(logId, env, keyData) {
	const qs = new URLSearchParams({
		select: 'id,action,status,response,error_message,created_at,tenant_id',
		id: `eq.${logId}`,
	});
	const { data, error } = await supabaseFetch(env, `ad_actions_log?${qs}`);

	if (error || !data || data.length === 0) {
		return { code: 404, data: { error: 'Action log not found', code: 'NOT_FOUND' } };
	}

	const log = data[0];

	const isAdmin = keyData?.email && env.ADMIN_EMAIL && keyData.email === env.ADMIN_EMAIL;
	if (!isAdmin && log.tenant_id !== keyData.tenant_id) {
		return { code: 403, data: { error: 'Access denied', code: 'FORBIDDEN' } };
	}

	return {
		code: 200,
		data: {
			id: log.id,
			action: log.action,
			status: log.status,
			response: log.response,
			error_message: log.error_message,
			created_at: log.created_at,
		},
	};
}

// ── GET /v1/ad-commander/projects/:project_id/ad-accounts/:ads_account_id/metrics ──

export async function handleGetMetrics(projectId, adsAccountId, searchParams, env, keyData) {
	// Access check
	const access = await assertAdCommanderAccess(env, adsAccountId, keyData);
	if (!access.ok) {
		return { code: access.code, data: { error: access.error, code: access.code === 403 ? 'PROJECT_ACCESS_DENIED' : 'ACCOUNT_NOT_FOUND' } };
	}

	const days = parseInt(searchParams.get('days') || '14', 10);
	if (isNaN(days) || days < 1 || days > 90) {
		return { code: 400, data: { error: 'days must be between 1 and 90', code: 'INVALID_PARAM' } };
	}

	const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

	const qs = new URLSearchParams({
		select: 'date,spend_usd,impressions,clicks',
		ads_account_id: `eq.${adsAccountId}`,
		date: `gte.${since}`,
		order: 'date.asc',
	});

	const { data, error } = await supabaseFetch(env, `ads_daily_insights?${qs}`);
	if (error) {
		return { code: 500, data: { error: 'Failed to fetch metrics', code: 'INTERNAL' } };
	}

	const rows = data || [];

	let totalSpend = 0;
	let totalImpressions = 0;
	let totalClicks = 0;

	const daily = rows.map(r => {
		const spend = parseFloat(r.spend_usd) || 0;
		const impressions = parseInt(r.impressions) || 0;
		const clicks = parseInt(r.clicks) || 0;
		totalSpend += spend;
		totalImpressions += impressions;
		totalClicks += clicks;

		const ctr = impressions > 0 ? clicks / impressions : 0;
		const cpm = impressions > 0 ? (spend / impressions) * 1000 : 0;
		const cpc = clicks > 0 ? spend / clicks : 0;

		return {
			date: r.date,
			spend_usd: spend,
			impressions,
			clicks,
			ctr: parseFloat(ctr.toFixed(6)),
			cpm: parseFloat(cpm.toFixed(2)),
			cpc: parseFloat(cpc.toFixed(2)),
		};
	});

	const avgCtr = totalImpressions > 0 ? totalClicks / totalImpressions : 0;
	const avgCpm = totalImpressions > 0 ? (totalSpend / totalImpressions) * 1000 : 0;
	const avgCpc = totalClicks > 0 ? totalSpend / totalClicks : 0;

	return {
		code: 200,
		data: {
			days,
			total_spend_usd: parseFloat(totalSpend.toFixed(2)),
			total_impressions: totalImpressions,
			total_clicks: totalClicks,
			avg_ctr: parseFloat(avgCtr.toFixed(6)),
			avg_cpm: parseFloat(avgCpm.toFixed(2)),
			avg_cpc: parseFloat(avgCpc.toFixed(2)),
			daily,
		},
	};
}

// ── GET /v1/ad-commander/projects/:project_id/ad-accounts/:ads_account_id/creatives ──

export async function handleListCreatives(projectId, adsAccountId, searchParams, env, keyData) {
	// Access check
	const access = await assertAdCommanderAccess(env, adsAccountId, keyData);
	if (!access.ok) {
		return { code: access.code, data: { error: access.error, code: access.code === 403 ? 'PROJECT_ACCESS_DENIED' : 'ACCOUNT_NOT_FOUND' } };
	}

	const select = 'id,headline,body_copy,cta_type,thumbnail_url,workflow_status,generation_source,meta_creative_id,published_at,created_at';
	const params = new URLSearchParams({
		select,
		ads_account_id: `eq.${adsAccountId}`,
		order: 'created_at.desc',
	});

	const status = searchParams.get('status');
	if (status) {
		params.set('workflow_status', `eq.${status}`);
	}

	const { data, error } = await supabaseFetch(env, `ads_creatives?${params}`);
	if (error) {
		return { code: 500, data: { error: 'Failed to fetch creatives', code: 'INTERNAL' } };
	}

	return { code: 200, data: { creatives: data || [] } };
}
