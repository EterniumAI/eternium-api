/**
 * lib/email.js -- Welcome sequence templates + Resend send logic
 *
 * Five-email drip fired when a new user signs up on eternium.ai.
 * Uses the Resend API via fetch (no SDK dependency required).
 *
 * Env secrets required:
 *   RESEND_API_KEY   -- CF Worker secret (already set)
 *   SUPABASE_URL     -- for email_queue read/write
 *   SUPABASE_SERVICE_KEY
 *
 * Sequence:
 *   Day 0  welcome-intro       -- who Ty is, what Eternium builds
 *   Day 1  tech-stack-blueprint -- free tech stack guide
 *   Day 3  centramind-story    -- how one system replaced 15 tools
 *   Day 5  community-invite    -- The Digital Armory on Skool
 *   Day 7  whats-your-build    -- reply invite + book a call
 */

const FROM = 'Ty Barney <ty@eternium.ai>';
const BASE_URL = 'https://eternium.ai';
const UNSUBSCRIBE_PATH = '/unsubscribe';

// ── HTML wrapper ─────────────────────────────────────────────────

function wrap(body, unsubscribeUrl) {
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:Inter,Arial,sans-serif;color:#e5e5e5;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0a;">
  <tr><td align="center" style="padding:40px 16px;">
    <table role="presentation" width="560" cellpadding="0" cellspacing="0"
      style="max-width:560px;width:100%;background:#141414;border:1px solid rgba(6,182,212,0.15);border-radius:12px;overflow:hidden;">
      <tr>
        <td style="padding:32px 36px 0;">
          <p style="margin:0 0 28px;font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:#06b6d4;">Eternium</p>
          ${body}
        </td>
      </tr>
      <tr>
        <td style="padding:28px 36px 28px;border-top:1px solid rgba(255,255,255,0.06);">
          <p style="margin:0;font-size:12px;color:rgba(229,229,229,0.35);line-height:1.6;">
            Eternium LLC -- AI infrastructure for builders.<br>
            <a href="${unsubscribeUrl}" style="color:rgba(6,182,212,0.55);text-decoration:underline;">Unsubscribe</a>
          </p>
        </td>
      </tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

function cta(text, href) {
	return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:28px 0 4px;">
  <tr>
    <td style="background:#06b6d4;border-radius:8px;">
      <a href="${href}"
        style="display:inline-block;padding:13px 28px;font-size:13px;font-weight:700;
               letter-spacing:0.06em;color:#050505;text-decoration:none;">${text}</a>
    </td>
  </tr>
</table>`;
}

function p(text, style = '') {
	return `<p style="margin:0 0 16px;font-size:15px;line-height:1.65;color:rgba(229,229,229,0.85);${style}">${text}</p>`;
}

function h1(text) {
	return `<h1 style="margin:0 0 24px;font-size:22px;font-weight:700;color:#e5e5e5;line-height:1.3;">${text}</h1>`;
}

function sig() {
	return `<p style="margin:28px 0 0;font-size:15px;line-height:1.65;color:rgba(229,229,229,0.85);">-- Ty</p>`;
}

// ── Email 1: Welcome (Day 0) ─────────────────────────────────────

function templateWelcomeIntro(name, unsubscribeUrl) {
	const displayName = name ? name.split(' ')[0] : 'Hey';
	const body = `
    ${h1(`Welcome to Eternium, ${displayName}.`)}
    ${p("I'm Ty. I build AI infrastructure for founders and developers who want to move fast without a full engineering team behind them.")}
    ${p("Eternium is the API and tooling layer I built for myself first -- image generation, content pipelines, agent workflows, and the infrastructure to run them at scale.")}
    ${p("You now have API access. The free tier gives you 100 credits a month. More than enough to test what's possible.")}
    ${p("Your dashboard is live. Grab your API key, run a request, see what happens.")}
    ${cta('Open your dashboard', `${BASE_URL}/dashboard.html`)}
    ${p("Over the next week I'll send you the pieces I use every day. Nothing padded. Just the tools and the reasoning behind them.", 'margin-top:20px;')}
    ${sig()}
  `;
	return {
		subject: 'Welcome. Here is what you just unlocked.',
		html: wrap(body, unsubscribeUrl),
	};
}

// ── Email 2: AI Tech Stack Blueprint (Day 1) ─────────────────────

function templateTechStackBlueprint(name, unsubscribeUrl) {
	const displayName = name ? name.split(' ')[0] : 'Hey';
	const body = `
    ${h1("The stack running my entire AI business.")}
    ${p(`${displayName},`)}
    ${p("Most people waste months picking tools. I built a simple framework: one database, one edge layer, one AI provider, one email system, and a deployment pipeline that runs on free tiers until you need to scale.")}
    ${p("The AI Tech Stack Blueprint is a free guide that walks through every piece. What it does, what it costs at zero users and at 10,000, and what I would swap out if I were starting today.")}
    ${p("It is the same stack powering Eternium right now.")}
    ${cta('Get the Blueprint', `${BASE_URL}/products/tech-stack`)}
    ${sig()}
  `;
	return {
		subject: 'The stack running my AI business (free)',
		html: wrap(body, unsubscribeUrl),
	};
}

// ── Email 3: CentraMind story (Day 3) ────────────────────────────

function templateCentraMindStory(name, unsubscribeUrl) {
	const displayName = name ? name.split(' ')[0] : 'Hey';
	const body = `
    ${h1("How I replaced 15 tools with one system.")}
    ${p(`${displayName},`)}
    ${p("I was running Slack, Notion, Airtable, a CRM, a content scheduler, a task manager, a client portal, and a handful of AI tools that did not talk to each other.")}
    ${p("I spent more time syncing tools than actually building.")}
    ${p("So I built CentraMind: a single agent workspace with persistent memory, a React dashboard, a built-in CRM, a content engine, and a client portal. Forty database tables, eleven migrations, seven Claude Code skills. All open source.")}
    ${p("The whole thing runs on Supabase and Cloudflare. Monthly infrastructure cost at my usage level: under $30.")}
    ${cta('See how it works', `${BASE_URL}/products/centramind-blueprint`)}
    ${sig()}
  `;
	return {
		subject: 'How I replaced 15 tools with one system',
		html: wrap(body, unsubscribeUrl),
	};
}

// ── Email 4: Community invite (Day 5) ────────────────────────────

function templateCommunityInvite(name, unsubscribeUrl) {
	const displayName = name ? name.split(' ')[0] : 'Hey';
	const body = `
    ${h1("The Digital Armory is open.")}
    ${p(`${displayName},`)}
    ${p("I built the Digital Armory for one reason: the best conversations about AI are happening in small, focused communities, not on social media.")}
    ${p("It is a community of builders who are actually shipping things. Founders, developers, and operators using AI to run lean and move fast. No hype. No gurus. Just people who build.")}
    ${p("Inside you will find all the Digital Armory resources, direct access to me, and a growing group of people who share what is actually working.")}
    ${cta('Join the community', 'https://tyrinbarney.com/community')}
    ${p("It is free. See you in there.", 'margin-top:20px;')}
    ${sig()}
  `;
	return {
		subject: 'The Digital Armory is open',
		html: wrap(body, unsubscribeUrl),
	};
}

// ── Email 5: What are you building? (Day 7) ──────────────────────

function templateWhatsYourBuild(name, unsubscribeUrl) {
	const displayName = name ? name.split(' ')[0] : 'Hey';
	const body = `
    ${h1("What are you building?")}
    ${p(`${displayName},`)}
    ${p("You have been in the Eternium ecosystem for a week. I want to know what you are working on.")}
    ${p("Reply to this email and tell me: what are you trying to build, and what is the thing slowing you down right now? I read every reply.")}
    ${p("If you want to talk through it properly, you can also book a call. I do a limited number of 30-minute strategy sessions for people who are serious about shipping an AI product.")}
    ${cta('Book a call', `${BASE_URL}/build`)}
    ${p("Either way, hit reply. I want to know what you are working on.", 'margin-top:20px;')}
    ${sig()}
  `;
	return {
		subject: "What are you building?",
		html: wrap(body, unsubscribeUrl),
	};
}

// ── Template registry ────────────────────────────────────────────

const TEMPLATES = {
	'welcome-intro':         templateWelcomeIntro,
	'tech-stack-blueprint':  templateTechStackBlueprint,
	'centramind-story':      templateCentraMindStory,
	'community-invite':      templateCommunityInvite,
	'whats-your-build':      templateWhatsYourBuild,
};

/**
 * Sequence definition: [templateName, offsetDays]
 * Day 0 fires immediately.
 */
export const WELCOME_SEQUENCE = [
	['welcome-intro',        0],
	['tech-stack-blueprint', 1],
	['centramind-story',     3],
	['community-invite',     5],
	['whats-your-build',     7],
];

// ── Resend send ──────────────────────────────────────────────────

/**
 * Send a single email via Resend.
 * Returns { ok: true, id } or { ok: false, error }.
 */
export async function sendEmail(env, { to, subject, html }) {
	const key = env.RESEND_API_KEY;
	if (!key) return { ok: false, error: 'RESEND_API_KEY not configured' };

	const res = await fetch('https://api.resend.com/emails', {
		method: 'POST',
		headers: {
			'Authorization': `Bearer ${key}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({ from: FROM, to: [to], subject, html }),
	});

	if (!res.ok) {
		const err = await res.text();
		return { ok: false, error: `Resend ${res.status}: ${err.slice(0, 200)}` };
	}

	const data = await res.json();
	return { ok: true, id: data.id };
}

// ── Queue helpers ────────────────────────────────────────────────

function daysFromNow(days) {
	const d = new Date();
	d.setDate(d.getDate() + days);
	return d.toISOString();
}

/**
 * Insert 5 email_queue rows for a new signup.
 * Called from the /webhooks/new-user handler.
 */
export async function queueWelcomeSequence(env, email, name = '') {
	if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) {
		return { ok: false, error: 'Supabase not configured' };
	}

	const rows = WELCOME_SEQUENCE.map(([template, days]) => ({
		recipient_email: email.toLowerCase(),
		template_name: template,
		scheduled_for: daysFromNow(days),
		status: 'pending',
		metadata: { name: name || '' },
	}));

	const res = await fetch(`${env.SUPABASE_URL}/rest/v1/email_queue`, {
		method: 'POST',
		headers: {
			'apikey': env.SUPABASE_SERVICE_KEY,
			'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
			'Content-Type': 'application/json',
			'Prefer': 'return=minimal',
		},
		body: JSON.stringify(rows),
	});

	if (!res.ok) {
		const err = await res.text();
		return { ok: false, error: `Supabase ${res.status}: ${err.slice(0, 200)}` };
	}

	return { ok: true, queued: rows.length };
}

/**
 * Read up to `limit` pending emails due now, send each via Resend,
 * mark sent or failed. Called from POST /v1/email/process (admin).
 * Returns a summary of results.
 */
export async function processEmailQueue(env, limit = 50) {
	if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) {
		return { ok: false, error: 'Supabase not configured' };
	}

	// Fetch due rows
	const params = new URLSearchParams({
		select: 'id,recipient_email,template_name,metadata',
		status: 'eq.pending',
		scheduled_for: `lte.${new Date().toISOString()}`,
		order: 'scheduled_for.asc',
		limit: String(limit),
	});

	const fetchRes = await fetch(`${env.SUPABASE_URL}/rest/v1/email_queue?${params}`, {
		headers: {
			'apikey': env.SUPABASE_SERVICE_KEY,
			'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
		},
	});

	if (!fetchRes.ok) {
		return { ok: false, error: `Queue fetch failed: ${fetchRes.status}` };
	}

	const rows = await fetchRes.json();
	if (!rows.length) return { ok: true, sent: 0, failed: 0, message: 'No emails due' };

	const results = { sent: 0, failed: 0, errors: [] };

	for (const row of rows) {
		const templateFn = TEMPLATES[row.template_name];
		if (!templateFn) {
			await markRow(env, row.id, 'failed');
			results.failed++;
			results.errors.push({ id: row.id, error: `Unknown template: ${row.template_name}` });
			continue;
		}

		const name = row.metadata?.name || '';
		const unsubscribeUrl = `${BASE_URL}${UNSUBSCRIBE_PATH}?email=${encodeURIComponent(row.recipient_email)}`;
		const { subject, html } = templateFn(name, unsubscribeUrl);

		const send = await sendEmail(env, { to: row.recipient_email, subject, html });

		if (send.ok) {
			await markRow(env, row.id, 'sent', { resend_id: send.id });
			results.sent++;
		} else {
			await markRow(env, row.id, 'failed', { error: send.error });
			results.failed++;
			results.errors.push({ id: row.id, email: row.recipient_email, error: send.error });
		}
	}

	return { ok: true, ...results };
}

async function markRow(env, id, status, extraMeta = {}) {
	const patch = {
		status,
		...(status === 'sent' ? { sent_at: new Date().toISOString() } : {}),
		...(Object.keys(extraMeta).length ? { metadata: extraMeta } : {}),
	};

	await fetch(`${env.SUPABASE_URL}/rest/v1/email_queue?id=eq.${id}`, {
		method: 'PATCH',
		headers: {
			'apikey': env.SUPABASE_SERVICE_KEY,
			'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
			'Content-Type': 'application/json',
			'Prefer': 'return=minimal',
		},
		body: JSON.stringify(patch),
	});
}
