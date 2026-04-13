/**
 * lib/resend.js -- Resend webhook handler + API sync for email delivery metrics
 *
 * Receives Resend webhook events and populates:
 *   - email_metrics_daily   (aggregate daily counts)
 *   - email_campaign_metrics (aggregate by template_key)
 *   - email_domains          (domain verification status)
 *
 * Secrets required (set via `wrangler secret put`):
 *   RESEND_API_KEY          -- Resend API key (re_...)
 *   RESEND_WEBHOOK_SECRET   -- Resend webhook signing secret (optional)
 *   SUPABASE_URL            -- Supabase REST API base
 *   SUPABASE_SERVICE_KEY    -- Supabase service role key
 */

// ── Supabase helpers ────────────────────────────────────────────────────────

async function supabaseRpc(env, table, method, body, params = '') {
	const url = `${env.SUPABASE_URL}/rest/v1/${table}${params}`;
	const headers = {
		'apikey': env.SUPABASE_SERVICE_KEY,
		'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
		'Content-Type': 'application/json',
		'Prefer': 'resolution=merge-duplicates,return=representation',
	};
	const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
	if (!res.ok) {
		const err = await res.text().catch(() => String(res.status));
		console.log(`[Resend] Supabase ${method} ${table} failed: ${err}`);
		return null;
	}
	const data = await res.json().catch(() => null);
	return data;
}

async function supabaseUpsert(env, table, row) {
	return supabaseRpc(env, table, 'POST', row);
}

async function supabaseSelect(env, table, params = '') {
	return supabaseRpc(env, table, 'GET', null, params);
}

// ── Webhook signature verification ──────────────────────────────────────────

async function verifyWebhookSignature(request, env) {
	const secret = env.RESEND_WEBHOOK_SECRET;
	if (!secret) return true; // Skip verification if no secret configured

	const svixId = request.headers.get('svix-id');
	const svixTimestamp = request.headers.get('svix-timestamp');
	const svixSignature = request.headers.get('svix-signature');

	if (!svixId || !svixTimestamp || !svixSignature) {
		console.log('[Resend] Missing svix headers for webhook verification');
		return false;
	}

	// Timestamp check: reject if older than 5 minutes
	const now = Math.floor(Date.now() / 1000);
	const ts = parseInt(svixTimestamp, 10);
	if (Math.abs(now - ts) > 300) {
		console.log('[Resend] Webhook timestamp too old');
		return false;
	}

	const body = await request.clone().text();
	const signedContent = `${svixId}.${svixTimestamp}.${body}`;

	// Resend uses svix under the hood; secret is base64 after "whsec_" prefix
	const secretBytes = Uint8Array.from(
		atob(secret.startsWith('whsec_') ? secret.slice(6) : secret),
		c => c.charCodeAt(0)
	);

	const key = await crypto.subtle.importKey(
		'raw', secretBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
	);
	const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedContent));
	const computed = btoa(String.fromCharCode(...new Uint8Array(sig)));

	// svix-signature can contain multiple signatures separated by spaces (e.g., "v1,<base64> v1,<base64>")
	const signatures = svixSignature.split(' ');
	for (const s of signatures) {
		const [, val] = s.split(',');
		if (val === computed) return true;
	}

	console.log('[Resend] Webhook signature mismatch');
	return false;
}

// ── Event field mapping ─────────────────────────────────────────────────────

const EVENT_TO_COLUMN = {
	'email.sent':       'sent',
	'email.delivered':  'delivered',
	'email.opened':     'opened',
	'email.clicked':    'clicked',
	'email.bounced':    'bounced',
	'email.complained': 'complained',
};

/**
 * Extract a template key from Resend event data.
 * Resend includes tags as an array of { name, value } objects.
 * Falls back to a slugified subject line.
 */
function extractTemplateKey(eventData) {
	// Check tags for a "template" or "campaign" tag
	const tags = eventData.tags || [];
	for (const tag of tags) {
		if (tag.name === 'template' || tag.name === 'campaign') {
			return tag.value;
		}
	}
	// Fallback: slugify the subject
	const subject = eventData.subject || 'unknown';
	return subject
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '')
		.slice(0, 64);
}

// ── Webhook handler ─────────────────────────────────────────────────────────

/**
 * Handle incoming Resend webhook POST.
 * Upserts daily metrics and campaign metrics in Supabase.
 */
export async function handleResendWebhook(request, env) {
	// Verify signature
	const valid = await verifyWebhookSignature(request, env);
	if (!valid) {
		return { code: 401, error: 'Invalid webhook signature' };
	}

	let payload;
	try {
		payload = await request.json();
	} catch {
		return { code: 400, error: 'Invalid JSON body' };
	}

	const eventType = payload.type;
	const column = EVENT_TO_COLUMN[eventType];
	if (!column) {
		// Unknown event type -- acknowledge it so Resend does not retry
		console.log(`[Resend] Ignoring event type: ${eventType}`);
		return { code: 200, data: { received: true, ignored: true } };
	}

	const eventData = payload.data || {};
	const createdAt = eventData.created_at || payload.created_at || new Date().toISOString();
	const date = createdAt.slice(0, 10); // YYYY-MM-DD
	const templateKey = extractTemplateKey(eventData);

	// 1. Upsert email_metrics_daily
	// First fetch existing row for this date, then upsert with incremented count
	const existingDaily = await supabaseSelect(env, 'email_metrics_daily', `?date=eq.${date}&select=*`);
	const daily = (existingDaily && existingDaily[0]) || {};
	const dailyRow = {
		date,
		sent: (daily.sent || 0) + (column === 'sent' ? 1 : 0),
		delivered: (daily.delivered || 0) + (column === 'delivered' ? 1 : 0),
		opened: (daily.opened || 0) + (column === 'opened' ? 1 : 0),
		clicked: (daily.clicked || 0) + (column === 'clicked' ? 1 : 0),
		bounced: (daily.bounced || 0) + (column === 'bounced' ? 1 : 0),
		complained: (daily.complained || 0) + (column === 'complained' ? 1 : 0),
	};
	await supabaseUpsert(env, 'email_metrics_daily', dailyRow);

	// 2. Upsert email_campaign_metrics
	const existingCampaign = await supabaseSelect(env, 'email_campaign_metrics', `?template_key=eq.${encodeURIComponent(templateKey)}&select=*`);
	const campaign = (existingCampaign && existingCampaign[0]) || {};
	const isUnique = !campaign.id; // first event for this template = unique
	const campaignRow = {
		template_key: templateKey,
		label: campaign.label || (eventData.subject || templateKey),
		sent: (campaign.sent || 0) + (column === 'sent' ? 1 : 0),
		delivered: (campaign.delivered || 0) + (column === 'delivered' ? 1 : 0),
		opened: (campaign.opened || 0) + (column === 'opened' ? 1 : 0),
		clicked: (campaign.clicked || 0) + (column === 'clicked' ? 1 : 0),
		bounced: (campaign.bounced || 0) + (column === 'bounced' ? 1 : 0),
		complained: (campaign.complained || 0) + (column === 'complained' ? 1 : 0),
		unique_opens: (campaign.unique_opens || 0) + (column === 'opened' && isUnique ? 1 : 0),
		unique_clicks: (campaign.unique_clicks || 0) + (column === 'clicked' && isUnique ? 1 : 0),
	};
	await supabaseUpsert(env, 'email_campaign_metrics', campaignRow);

	console.log(`[Resend] Processed ${eventType} for date=${date} template=${templateKey}`);
	return { code: 200, data: { received: true, event: eventType, date, template_key: templateKey } };
}

// ── Manual sync (backfill from Resend API) ──────────────────────────────────

/**
 * GET /admin/resend/sync -- Fetch recent emails from Resend API and backfill metrics.
 * Calls Resend GET /emails to fetch the last 100 emails and aggregates counts.
 */
export async function handleResendSync(env) {
	const apiKey = env.RESEND_API_KEY;
	if (!apiKey) {
		return { code: 500, error: 'RESEND_API_KEY not configured' };
	}

	// Fetch recent emails from Resend
	const res = await fetch('https://api.resend.com/emails', {
		headers: { 'Authorization': `Bearer ${apiKey}` },
	});

	if (!res.ok) {
		const err = await res.text().catch(() => String(res.status));
		return { code: 502, error: `Resend API error: ${err}` };
	}

	const result = await res.json();
	const emails = result.data || [];

	// Aggregate by date and template
	const dailyMap = new Map();
	const campaignMap = new Map();
	let processed = 0;

	for (const email of emails) {
		const date = (email.created_at || '').slice(0, 10);
		if (!date) continue;

		// Daily aggregation
		if (!dailyMap.has(date)) {
			dailyMap.set(date, { date, sent: 0, delivered: 0, opened: 0, clicked: 0, bounced: 0, complained: 0 });
		}
		const daily = dailyMap.get(date);
		daily.sent += 1;
		// Resend list endpoint shows last_event status
		const status = email.last_event || '';
		if (status === 'delivered' || status === 'opened' || status === 'clicked') daily.delivered += 1;
		if (status === 'opened' || status === 'clicked') daily.opened += 1;
		if (status === 'clicked') daily.clicked += 1;
		if (status === 'bounced') daily.bounced += 1;
		if (status === 'complained') daily.complained += 1;

		// Campaign aggregation
		const templateKey = extractTemplateKey(email);
		if (!campaignMap.has(templateKey)) {
			campaignMap.set(templateKey, {
				template_key: templateKey,
				label: email.subject || templateKey,
				sent: 0, delivered: 0, opened: 0, clicked: 0, bounced: 0, complained: 0,
				unique_opens: 0, unique_clicks: 0,
			});
		}
		const camp = campaignMap.get(templateKey);
		camp.sent += 1;
		if (status === 'delivered' || status === 'opened' || status === 'clicked') camp.delivered += 1;
		if (status === 'opened' || status === 'clicked') { camp.opened += 1; camp.unique_opens += 1; }
		if (status === 'clicked') { camp.clicked += 1; camp.unique_clicks += 1; }
		if (status === 'bounced') camp.bounced += 1;
		if (status === 'complained') camp.complained += 1;

		processed++;
	}

	// Upsert all daily rows
	for (const row of dailyMap.values()) {
		await supabaseUpsert(env, 'email_metrics_daily', row);
	}

	// Upsert all campaign rows
	for (const row of campaignMap.values()) {
		await supabaseUpsert(env, 'email_campaign_metrics', row);
	}

	return {
		code: 200,
		data: {
			synced: true,
			emails_processed: processed,
			daily_rows: dailyMap.size,
			campaign_rows: campaignMap.size,
		},
	};
}

// ── Domain status sync ──────────────────────────────────────────────────────

/**
 * GET /admin/resend/domains -- Fetch domain list from Resend and upsert email_domains.
 */
export async function handleResendDomains(env) {
	const apiKey = env.RESEND_API_KEY;
	if (!apiKey) {
		return { code: 500, error: 'RESEND_API_KEY not configured' };
	}

	const res = await fetch('https://api.resend.com/domains', {
		headers: { 'Authorization': `Bearer ${apiKey}` },
	});

	if (!res.ok) {
		const err = await res.text().catch(() => String(res.status));
		return { code: 502, error: `Resend API error: ${err}` };
	}

	const result = await res.json();
	const domains = result.data || [];
	const upserted = [];

	for (const d of domains) {
		// Map Resend status to our schema: verified/pending/failed
		let status = 'pending';
		if (d.status === 'verified' || d.status === 'active') status = 'verified';
		else if (d.status === 'failed' || d.status === 'not_started') status = 'failed';

		const row = {
			domain: d.name,
			status,
			provider: 'resend',
			last_checked_at: new Date().toISOString(),
		};
		const result = await supabaseUpsert(env, 'email_domains', row);
		upserted.push(row);
	}

	return {
		code: 200,
		data: {
			synced: true,
			domains: upserted,
		},
	};
}
