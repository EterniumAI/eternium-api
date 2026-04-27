/**
 * lib/ad-commander-lifecycle.js -- Ad Commander Retire / Hold / Promote endpoints
 *
 * Handlers: handleRetireCreative, handleHoldCreative, handlePromoteCreative
 * All return { code, data }.
 */

import { assertAdCommanderAccess } from './ad-commander-copy.js';

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

// ── Shared helpers ───────────────────────────────────────────────────────────

function actorString(keyData) {
	if (keyData.__userId) return `user:${keyData.__userId}`;
	if (keyData.supabase_uid) return `user:${keyData.supabase_uid}`;
	if (keyData.key_id) return `api_key:${keyData.key_id}`;
	return `email:${keyData.email || 'unknown'}`;
}

async function fetchCreativeWithAccount(env, creativeId) {
	const qs = new URLSearchParams({
		select: 'id,ads_account_id,status,platform_ad_id,created_at,name',
		id: `eq.${creativeId}`,
	});
	const { data, error } = await supabaseFetch(env, `ads_creatives?${qs}`);
	if (error || !data || data.length === 0) return null;
	return data[0];
}

async function fetchTrailing14dMetrics(env, creativeId) {
	const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
	const qs = new URLSearchParams({
		select: 'spend_usd,conversions',
		creative_id: `eq.${creativeId}`,
		date: `gte.${since}`,
	});
	const { data } = await supabaseFetch(env, `ads_daily_insights?${qs}`);
	if (!data || data.length === 0) return { spend: null, conversions: null, cpa: null };

	let totalSpend = 0;
	let totalConversions = 0;
	for (const row of data) {
		totalSpend += parseFloat(row.spend_usd) || 0;
		totalConversions += parseInt(row.conversions) || 0;
	}
	const cpa = totalConversions > 0 ? totalSpend / totalConversions : null;
	return { spend: totalSpend, conversions: totalConversions, cpa };
}

async function getChampionBaselineCpa(env, adsAccountId, excludeId) {
	const qs = new URLSearchParams({
		select: 'id',
		ads_account_id: `eq.${adsAccountId}`,
		status: `eq.champion`,
	});
	if (excludeId) qs.append('id', `neq.${excludeId}`);
	const { data } = await supabaseFetch(env, `ads_creatives?${qs}`);
	if (!data || data.length === 0) return null;

	let lowestCpa = Infinity;
	for (const champion of data) {
		const metrics = await fetchTrailing14dMetrics(env, champion.id);
		if (metrics.cpa !== null && metrics.cpa < lowestCpa) {
			lowestCpa = metrics.cpa;
		}
	}
	return lowestCpa === Infinity ? null : lowestCpa;
}

async function getChampionsOnAccount(env, adsAccountId) {
	const qs = new URLSearchParams({
		select: 'id,created_at',
		ads_account_id: `eq.${adsAccountId}`,
		status: `eq.champion`,
		order: 'created_at.asc',
	});
	const { data } = await supabaseFetch(env, `ads_creatives?${qs}`);
	return data || [];
}

async function writeFleetEvent(env, eventType, payload) {
	await supabaseFetch(env, 'fleet_events', {
		method: 'POST',
		body: { event_type: eventType, payload },
		prefer: 'return=minimal',
	});
}

async function pauseMetaAd(env, metaAdId) {
	const token = env.META_SYSTEM_USER_TOKEN;
	if (!token) {
		return { ok: false, code: 503, error: 'Meta system user token not configured on Worker -- set via wrangler secret put META_SYSTEM_USER_TOKEN' };
	}

	const resp = await fetch(`https://graph.facebook.com/v23.0/${metaAdId}?access_token=${token}&status=PAUSED`, {
		method: 'POST',
	});

	const body = await resp.text();
	let parsed;
	try { parsed = JSON.parse(body); } catch { parsed = { raw: body }; }

	if (!resp.ok) {
		return { ok: false, code: resp.status, error: parsed };
	}
	return { ok: true, data: parsed };
}

// ── POST /v1/ad-commander/creatives/:id/retire ──────────────────────────────

export async function handleRetireCreative(creativeId, body, env, keyData) {
	const creative = await fetchCreativeWithAccount(env, creativeId);
	if (!creative) {
		return { code: 404, data: { error: 'Creative not found', code: 'NOT_FOUND' } };
	}

	const access = await assertAdCommanderAccess(env, creative.ads_account_id, keyData);
	if (!access.ok) {
		return { code: access.code, data: { error: access.error, code: access.code === 403 ? 'PROJECT_ACCESS_DENIED' : 'ACCOUNT_NOT_FOUND' } };
	}

	if (!creative.platform_ad_id) {
		return { code: 422, data: { error: 'creative not linked to a Meta ad -- cannot pause via API; remove from rotation manually', code: 'NO_META_LINK' } };
	}

	const metrics = await fetchTrailing14dMetrics(env, creativeId);
	const championBaselineCpa = await getChampionBaselineCpa(env, creative.ads_account_id, creativeId);

	// Pause on Meta
	const metaResult = await pauseMetaAd(env, creative.platform_ad_id);
	if (!metaResult.ok) {
		if (metaResult.code === 503) {
			return { code: 503, data: { error: metaResult.error, code: 'META_TOKEN_MISSING' } };
		}
		// Log failure event
		await writeFleetEvent(env, 'creative_retire_failed', {
			creative_id: creativeId,
			account_id: creative.ads_account_id,
			meta_ad_id: creative.platform_ad_id,
			meta_error: metaResult.error,
		});
		const statusCode = metaResult.code >= 400 && metaResult.code < 600 ? metaResult.code : 502;
		return { code: statusCode, data: { error: 'Meta API error', meta_error: metaResult.error, code: 'META_API_ERROR' } };
	}

	// Update ads_creatives status
	const updateQs = new URLSearchParams({ id: `eq.${creativeId}` });
	await supabaseFetch(env, `ads_creatives?${updateQs}`, {
		method: 'PATCH',
		body: { status: 'retired', retired_at: new Date().toISOString() },
		prefer: 'return=minimal',
	});

	// Compute days_live
	const daysLive = creative.created_at
		? Math.floor((Date.now() - new Date(creative.created_at).getTime()) / (24 * 60 * 60 * 1000))
		: null;

	const actor = body?.actor || actorString(keyData);

	// Insert ad_commander_retire_requests row
	await supabaseFetch(env, 'ad_commander_retire_requests', {
		method: 'POST',
		body: {
			creative_id: creativeId,
			ads_account_id: creative.ads_account_id,
			requested_action: 'retire',
			cpa_at_request: metrics.cpa,
			champion_baseline_cpa: championBaselineCpa,
			days_live: daysLive,
			spend: metrics.spend,
			conversions: metrics.conversions,
			requested_by: actor,
			confirmed_at: new Date().toISOString(),
			confirmed_by: actor,
			auto_confirmed: false,
			status: 'confirmed',
		},
		prefer: 'return=minimal',
	});

	// Fleet event
	await writeFleetEvent(env, 'creative_retired', {
		creative_id: creativeId,
		account_id: creative.ads_account_id,
		cpa_at_action: metrics.cpa,
		champion_baseline_cpa: championBaselineCpa,
		actor,
		reason: body?.reason || null,
		meta_ad_id: creative.platform_ad_id,
	});

	return {
		code: 200,
		data: {
			ok: true,
			creative_id: creativeId,
			status: 'retired',
			cpa_at_action: metrics.cpa,
			meta_response: metaResult.data,
		},
	};
}

// ── POST /v1/ad-commander/creatives/:id/hold ────────────────────────────────

export async function handleHoldCreative(creativeId, body, env, keyData) {
	const creative = await fetchCreativeWithAccount(env, creativeId);
	if (!creative) {
		return { code: 404, data: { error: 'Creative not found', code: 'NOT_FOUND' } };
	}

	const access = await assertAdCommanderAccess(env, creative.ads_account_id, keyData);
	if (!access.ok) {
		return { code: access.code, data: { error: access.error, code: access.code === 403 ? 'PROJECT_ACCESS_DENIED' : 'ACCOUNT_NOT_FOUND' } };
	}

	const metrics = await fetchTrailing14dMetrics(env, creativeId);
	const championBaselineCpa = await getChampionBaselineCpa(env, creative.ads_account_id, creativeId);

	const holdUntil = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
	const daysLive = creative.created_at
		? Math.floor((Date.now() - new Date(creative.created_at).getTime()) / (24 * 60 * 60 * 1000))
		: null;

	const actor = body?.actor || actorString(keyData);

	// Insert ad_commander_retire_requests row with hold status
	await supabaseFetch(env, 'ad_commander_retire_requests', {
		method: 'POST',
		body: {
			creative_id: creativeId,
			ads_account_id: creative.ads_account_id,
			requested_action: 'hold',
			cpa_at_request: metrics.cpa,
			champion_baseline_cpa: championBaselineCpa,
			days_live: daysLive,
			spend: metrics.spend,
			conversions: metrics.conversions,
			requested_by: actor,
			auto_confirmed: false,
			status: 'overridden',
			hold_until: holdUntil,
		},
		prefer: 'return=minimal',
	});

	// Fleet event
	await writeFleetEvent(env, 'creative_hold_extended', {
		creative_id: creativeId,
		account_id: creative.ads_account_id,
		hold_until: holdUntil,
		actor,
		reason: body?.reason || null,
	});

	return {
		code: 200,
		data: {
			ok: true,
			creative_id: creativeId,
			hold_until: holdUntil,
		},
	};
}

// ── POST /v1/ad-commander/creatives/:id/promote ─────────────────────────────

export async function handlePromoteCreative(creativeId, body, env, keyData) {
	const creative = await fetchCreativeWithAccount(env, creativeId);
	if (!creative) {
		return { code: 404, data: { error: 'Creative not found', code: 'NOT_FOUND' } };
	}

	const access = await assertAdCommanderAccess(env, creative.ads_account_id, keyData);
	if (!access.ok) {
		return { code: access.code, data: { error: access.error, code: access.code === 403 ? 'PROJECT_ACCESS_DENIED' : 'ACCOUNT_NOT_FOUND' } };
	}

	const metrics = await fetchTrailing14dMetrics(env, creativeId);
	const championBaselineCpa = await getChampionBaselineCpa(env, creative.ads_account_id, creativeId);

	// Server-side Promote threshold validation
	// CPA < 0.8 x Champion CPA, >= 30 conversions, >= 14 days live
	const daysLive = creative.created_at
		? Math.floor((Date.now() - new Date(creative.created_at).getTime()) / (24 * 60 * 60 * 1000))
		: 0;

	if (metrics.cpa === null || metrics.conversions === null) {
		return { code: 422, data: { error: 'Does not meet Promote threshold: insufficient data (no conversions or spend recorded)', code: 'THRESHOLD_NOT_MET' } };
	}
	if (metrics.conversions < 30) {
		return { code: 422, data: { error: `Does not meet Promote threshold: conversions (${metrics.conversions}) < 30 required`, code: 'THRESHOLD_NOT_MET' } };
	}
	if (daysLive < 14) {
		return { code: 422, data: { error: `Does not meet Promote threshold: days live (${daysLive}) < 14 required`, code: 'THRESHOLD_NOT_MET' } };
	}
	if (championBaselineCpa !== null && metrics.cpa >= 0.8 * championBaselineCpa) {
		return { code: 422, data: { error: `Does not meet Promote threshold: CPA ($${metrics.cpa.toFixed(2)}) must be < 80% of champion CPA ($${championBaselineCpa.toFixed(2)})`, code: 'THRESHOLD_NOT_MET' } };
	}

	const actor = body?.actor || actorString(keyData);
	let demotedCreativeId = null;

	// Check champion cap (max 2)
	const champions = await getChampionsOnAccount(env, creative.ads_account_id);
	if (champions.length >= 2) {
		// Find highest CPA champion to demote
		let highestCpa = -1;
		let championToDemote = null;
		for (const champ of champions) {
			const champMetrics = await fetchTrailing14dMetrics(env, champ.id);
			if (champMetrics.cpa !== null && champMetrics.cpa > highestCpa) {
				highestCpa = champMetrics.cpa;
				championToDemote = champ.id;
			}
		}

		if (championToDemote) {
			// Retire the demoted champion (recursive call via same logic)
			const retireResult = await handleRetireCreative(championToDemote, {
				reason: 'Demoted: new challenger promoted to champion',
				actor,
			}, env, keyData);

			if (retireResult.code === 200) {
				demotedCreativeId = championToDemote;
			}
			// If retire fails (e.g. no platform_ad_id), still proceed with promote
			// but update status directly
			if (retireResult.code !== 200) {
				const updateQs = new URLSearchParams({ id: `eq.${championToDemote}` });
				await supabaseFetch(env, `ads_creatives?${updateQs}`, {
					method: 'PATCH',
					body: { status: 'retired', retired_at: new Date().toISOString() },
					prefer: 'return=minimal',
				});
				demotedCreativeId = championToDemote;
			}
		}
	}

	// Promote the creative
	const updateQs = new URLSearchParams({ id: `eq.${creativeId}` });
	await supabaseFetch(env, `ads_creatives?${updateQs}`, {
		method: 'PATCH',
		body: { status: 'champion', promoted_at: new Date().toISOString() },
		prefer: 'return=minimal',
	});

	// Insert ad_commander_retire_requests row
	await supabaseFetch(env, 'ad_commander_retire_requests', {
		method: 'POST',
		body: {
			creative_id: creativeId,
			ads_account_id: creative.ads_account_id,
			requested_action: 'promote',
			cpa_at_request: metrics.cpa,
			champion_baseline_cpa: championBaselineCpa,
			days_live: daysLive,
			spend: metrics.spend,
			conversions: metrics.conversions,
			requested_by: actor,
			confirmed_at: new Date().toISOString(),
			confirmed_by: actor,
			auto_confirmed: false,
			status: 'confirmed',
		},
		prefer: 'return=minimal',
	});

	// Fleet event
	await writeFleetEvent(env, 'creative_promoted', {
		creative_id: creativeId,
		account_id: creative.ads_account_id,
		cpa_at_action: metrics.cpa,
		prior_champion_id: demotedCreativeId,
		actor,
		reason: body?.reason || null,
	});

	return {
		code: 200,
		data: {
			ok: true,
			creative_id: creativeId,
			status: 'champion',
			demoted_creative_id: demotedCreativeId,
		},
	};
}
