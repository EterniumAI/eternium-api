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

	const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
	const createdByCandidate = keyData.__userId || keyData.supabase_uid;
	const row = {
		ads_account_id: body.ads_account_id,
		tenant_id: account.tenant_id,
		name: body.name || (body.headline ? body.headline.slice(0, 80) : 'Untitled creative'),
		status: 'draft',
		headline: body.headline,
		body_copy: body.body_copy,
		cta_type: body.cta_type,
		link_url: body.link_url,
		workflow_status: 'draft',
		generation_source: body.generation_source,
		...(createdByCandidate && uuidRe.test(createdByCandidate) ? { created_by: createdByCandidate } : {}),
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

	// Resolve account for tenant_id
	const account = await resolveAdsAccount(env, creative.ads_account_id);
	if (!account.ok) {
		return { code: 500, data: { error: 'Failed to resolve account', code: 'INTERNAL' } };
	}

	const actor = actorString(keyData);

	// Insert into publish queue with mode='new_ad_only'.
	// champion_creative_id is set to the same creative (self-reference) because
	// the column is NOT NULL, but the worker never reads it in new_ad_only mode.
	const queueRow = {
		ads_account_id: creative.ads_account_id,
		challenger_creative_id: creativeId,
		champion_creative_id: creativeId,
		mode: 'new_ad_only',
		status: 'queued',
		requested_by: actor,
		tenant_id: account.tenant_id,
	};

	const { data: queueData, error: queueErr } = await supabaseFetch(env, 'ad_commander_publish_queue', {
		method: 'POST',
		body: queueRow,
		prefer: 'return=representation',
	});

	if (queueErr) {
		return { code: 500, data: { error: 'Failed to enqueue publish', code: 'INTERNAL', detail: queueErr } };
	}

	const inserted = Array.isArray(queueData) ? queueData[0] : queueData;
	const queueId = inserted.id;

	// Write ad_actions_log row
	await supabaseFetch(env, 'ad_actions_log', {
		method: 'POST',
		body: {
			action: 'publish_creative',
			status: 'pending',
			tenant_id: account.tenant_id,
			payload: { stage: 'queued', mode: 'new_ad_only' },
			response: { queue_id: queueId, creative_id: creativeId },
		},
		prefer: 'return=minimal',
	});

	return {
		code: 202,
		data: {
			queue_id: queueId,
			status: 'queued',
			creative_id: creativeId,
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

// ── POST /v1/ad-commander/projects/:pid/ad-accounts/:aid/creatives/:cid/swap-publish ──

export async function handleSwapPublish(projectId, adsAccountId, challengerCreativeId, body, env, keyData) {
	const { champion_creative_id, mode } = body || {};

	if (!champion_creative_id) {
		return { code: 400, data: { error: 'champion_creative_id is required', code: 'MISSING_FIELD' } };
	}
	if (mode && mode !== 'new_ad_pause_old') {
		return { code: 400, data: { error: 'mode must be "new_ad_pause_old"', code: 'INVALID_FIELD' } };
	}

	const start = Date.now();

	// Access gate
	const access = await assertAdCommanderAccess(env, adsAccountId, keyData);
	if (!access.ok) {
		return { code: access.code, data: { error: access.error, code: access.code === 403 ? 'PROJECT_ACCESS_DENIED' : 'ACCOUNT_NOT_FOUND' } };
	}

	// Resolve tenant for the queue row
	const account = await resolveAdsAccount(env, adsAccountId);
	if (!account.ok) {
		return { code: 500, data: { error: 'Failed to resolve account', code: 'INTERNAL' } };
	}

	// Validate challenger creative: must belong to this ads_account, must be draft or approved
	const challengerQs = new URLSearchParams({
		select: 'id,ads_account_id,workflow_status',
		id: `eq.${challengerCreativeId}`,
	});
	const { data: challengers, error: chErr } = await supabaseFetch(env, `ads_creatives?${challengerQs}`);
	if (chErr || !challengers || challengers.length === 0) {
		return { code: 404, data: { error: 'Challenger creative not found', code: 'NOT_FOUND' } };
	}
	const challenger = challengers[0];
	if (challenger.ads_account_id !== adsAccountId) {
		return { code: 400, data: { error: 'Challenger creative does not belong to this ads account', code: 'WRONG_ACCOUNT' } };
	}
	if (!['draft', 'approved'].includes(challenger.workflow_status)) {
		return { code: 400, data: { error: `Challenger creative must be draft or approved. Current status: ${challenger.workflow_status}`, code: 'INVALID_STATUS' } };
	}

	// Validate champion creative: must be published
	const championQs = new URLSearchParams({
		select: 'id,ads_account_id,workflow_status',
		id: `eq.${champion_creative_id}`,
	});
	const { data: champions, error: cpErr } = await supabaseFetch(env, `ads_creatives?${championQs}`);
	if (cpErr || !champions || champions.length === 0) {
		return { code: 404, data: { error: 'Champion creative not found', code: 'NOT_FOUND' } };
	}
	const champion = champions[0];
	if (champion.workflow_status !== 'published') {
		return { code: 400, data: { error: `Champion creative must be published. Current status: ${champion.workflow_status}`, code: 'INVALID_STATUS' } };
	}

	const actor = actorString(keyData);
	const effectiveMode = mode || 'new_ad_pause_old';

	// Insert into publish queue
	const queueRow = {
		ads_account_id: adsAccountId,
		challenger_creative_id: challengerCreativeId,
		champion_creative_id: champion_creative_id,
		mode: effectiveMode,
		status: 'queued',
		requested_by: actor,
		tenant_id: account.tenant_id,
	};

	const { data: queueData, error: queueErr } = await supabaseFetch(env, 'ad_commander_publish_queue', {
		method: 'POST',
		body: queueRow,
		prefer: 'return=representation',
	});

	if (queueErr) {
		return { code: 500, data: { error: 'Failed to enqueue swap-publish', code: 'INTERNAL', detail: queueErr } };
	}

	const inserted = Array.isArray(queueData) ? queueData[0] : queueData;
	const queueId = inserted.id;

	// Write ad_actions_log row. Action+status enums are pinned by check
	// constraint: action in (create_creative, create_ad, pause_ad,
	// update_budget, publish_creative, swap_publish); status in
	// (pending, success, failed). Queue lifecycle stage lives in payload.stage.
	const { error: logErr } = await supabaseFetch(env, 'ad_actions_log', {
		method: 'POST',
		body: {
			action: 'swap_publish',
			actor,
			status: 'pending',
			tenant_id: account.tenant_id,
			project_id: account.project_id,
			ads_account_id: adsAccountId,
			creative_id: challengerCreativeId,
			payload: {
				stage: 'queued',
				champion_creative_id: champion_creative_id,
				mode: effectiveMode,
			},
			response: {
				queue_id: queueId,
				challenger_creative_id: challengerCreativeId,
				champion_creative_id: champion_creative_id,
				mode: effectiveMode,
			},
		},
		prefer: 'return=minimal',
	});
	if (logErr) {
		console.error('ad_actions_log insert failed:', logErr);
	}

	// Write fleet_events row
	await supabaseFetch(env, 'fleet_events', {
		method: 'POST',
		body: {
			event_type: 'ad_commander_swap_requested',
			payload: {
				queue_id: queueId,
				ads_account_id: adsAccountId,
				challenger_creative_id: challengerCreativeId,
				champion_creative_id: champion_creative_id,
				mode: effectiveMode,
				requested_by: actor,
			},
		},
		prefer: 'return=minimal',
	});

	return {
		code: 200,
		data: {
			ok: true,
			queued: true,
			queue_id: queueId,
			took_ms: Date.now() - start,
		},
	};
}

// ── GET /v1/ad-commander/projects/:pid/ad-accounts/:aid/swap-status/:queue_id ──

export async function handleSwapStatus(projectId, adsAccountId, queueId, env, keyData) {
	// Access gate
	const access = await assertAdCommanderAccess(env, adsAccountId, keyData);
	if (!access.ok) {
		return { code: access.code, data: { error: access.error, code: access.code === 403 ? 'PROJECT_ACCESS_DENIED' : 'ACCOUNT_NOT_FOUND' } };
	}

	const qs = new URLSearchParams({
		select: 'id,ads_account_id,challenger_creative_id,champion_creative_id,mode,status,requested_by,requested_at,completed_at,result_payload,error_text',
		id: `eq.${queueId}`,
		ads_account_id: `eq.${adsAccountId}`,
	});
	const { data, error } = await supabaseFetch(env, `ad_commander_publish_queue?${qs}`);

	if (error || !data || data.length === 0) {
		return { code: 404, data: { error: 'Queue entry not found', code: 'NOT_FOUND' } };
	}

	const row = data[0];
	return {
		code: 200,
		data: {
			id: row.id,
			status: row.status,
			challenger_creative_id: row.challenger_creative_id,
			champion_creative_id: row.champion_creative_id,
			mode: row.mode,
			requested_by: row.requested_by,
			requested_at: row.requested_at,
			completed_at: row.completed_at,
			result_payload: row.result_payload,
			error_text: row.error_text,
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

// ── GET /v1/ad-commander/projects/:project_id/ad-accounts/:ads_account_id/ad-sets ──

const adSetsCache = new Map();

export async function handleListAdSets(projectId, adsAccountId, env, keyData) {
	const access = await assertAdCommanderAccess(env, adsAccountId, keyData);
	if (!access.ok) {
		return { code: access.code, data: { error: access.error, code: access.code === 403 ? 'PROJECT_ACCESS_DENIED' : 'ACCOUNT_NOT_FOUND' } };
	}

	// Resolve external_account_id from ads_accounts
	const acctQs = new URLSearchParams({
		select: 'external_account_id',
		id: `eq.${adsAccountId}`,
	});
	const { data: acctData, error: acctError } = await supabaseFetch(env, `ads_accounts?${acctQs}`);
	if (acctError || !acctData || acctData.length === 0) {
		return { code: 404, data: { error: 'Ads account not found', code: 'ACCOUNT_NOT_FOUND' } };
	}
	const extAccountId = acctData[0].external_account_id;
	if (!extAccountId) {
		return { code: 400, data: { error: 'Ads account has no external Meta account ID', code: 'NO_EXTERNAL_ID' } };
	}

	// Check in-memory cache (60s TTL)
	const cacheKey = `adsets:${extAccountId}`;
	const cached = adSetsCache.get(cacheKey);
	if (cached && Date.now() - cached.ts < 60_000) {
		return { code: 200, data: cached.value };
	}

	// Fetch from Meta Graph API
	const metaToken = env.META_SYSTEM_USER_TOKEN;
	if (!metaToken) {
		return { code: 503, data: { error: 'Meta token not configured', code: 'META_TOKEN_MISSING' } };
	}

	const fields = 'id,name,status,effective_status,daily_budget,optimization_goal,billing_event,campaign_id,campaign%7Bid,name,objective%7D';
	const metaUrl = `https://graph.facebook.com/v23.0/act_${extAccountId}/adsets?fields=${fields}&limit=100&access_token=${metaToken}`;

	let metaResp;
	try {
		metaResp = await fetch(metaUrl);
	} catch (err) {
		return { code: 502, data: { error: `Meta API request failed: ${err.message}`, code: 'META_UPSTREAM_ERROR' } };
	}

	if (!metaResp.ok) {
		const errBody = await metaResp.text().catch(() => '');
		return { code: 502, data: { error: `Meta API error ${metaResp.status}: ${errBody.slice(0, 300)}`, code: 'META_UPSTREAM_ERROR' } };
	}

	let metaJson;
	try {
		metaJson = await metaResp.json();
	} catch {
		return { code: 502, data: { error: 'Failed to parse Meta response', code: 'META_UPSTREAM_ERROR' } };
	}

	const allAdSets = metaJson.data || [];
	const filtered = allAdSets.filter(a => !['DELETED', 'ARCHIVED'].includes(a.effective_status));

	const result = {
		ad_sets: filtered,
		fetched_at: new Date().toISOString(),
	};

	// Cache for 60 seconds
	adSetsCache.set(cacheKey, { ts: Date.now(), value: result });

	return { code: 200, data: result };
}
