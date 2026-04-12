#!/usr/bin/env node
/**
 * migrate-users-to-supabase.mjs
 * One-shot migration: sync KV USERS records into Supabase Auth + public.profiles.
 *
 * Default mode is DRY-RUN — no writes are made.
 * Pass --apply to perform live writes.
 *
 * Required env vars:
 *   CF_API_TOKEN        — Cloudflare API token (read + write KV)
 *   CF_ACCOUNT_ID       — Cloudflare account ID
 *   CF_KV_NAMESPACE_ID  — KV namespace ID for USERS (from wrangler.toml)
 *   SUPABASE_URL        — e.g. https://wmahfjguvqvefgjpbcdc.supabase.co
 *   SUPABASE_SERVICE_KEY — service_role key (has admin auth access)
 *
 * Optional:
 *   CHECKPOINT_FILE     — path to resume file (default: /tmp/migrate-users-progress.json)
 *   RATE_LIMIT_PER_SEC  — max users/sec (default: 5)
 *   SKIP_DOMAINS        — comma-separated email domains to skip (default: eternium.ai)
 *
 * Usage:
 *   node scripts/migrate-users-to-supabase.mjs              # dry-run
 *   node scripts/migrate-users-to-supabase.mjs --apply      # live mode
 *   node scripts/migrate-users-to-supabase.mjs --dry-run    # explicit dry-run
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';

// ── Config ──────────────────────────────────────────────────────
const APPLY        = process.argv.includes('--apply');
const DRY_RUN      = !APPLY;
const CF_TOKEN     = process.env.CF_API_TOKEN;
const CF_ACCOUNT   = process.env.CF_ACCOUNT_ID;
const CF_NS        = process.env.CF_KV_NAMESPACE_ID;
const SB_URL       = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SB_KEY       = process.env.SUPABASE_SERVICE_KEY;
const CHECKPOINT   = process.env.CHECKPOINT_FILE || '/tmp/migrate-users-progress.json';
const RATE_MS      = Math.round(1000 / Number(process.env.RATE_LIMIT_PER_SEC || 5));
const SKIP_DOMAINS = new Set((process.env.SKIP_DOMAINS || 'eternium.ai').split(',').map(s => s.trim().toLowerCase()));

// ── Colors ──────────────────────────────────────────────────────
const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', D = '\x1b[2m', B = '\x1b[1m', X = '\x1b[0m';

function log(prefix, msg)  { console.log(`${prefix}${msg}${X}`); }
function info(msg)  { log(`${B}[info] `, msg); }
function ok(msg)    { log(`${G}[ok]   `, msg); }
function warn(msg)  { log(`${Y}[warn] `, msg); }
function err(msg)   { log(`${R}[err]  `, msg); }
function dim(msg)   { log(`${D}[---]  `, msg); }

// ── Validation ──────────────────────────────────────────────────
function assertEnv() {
	const missing = [];
	if (!CF_TOKEN)   missing.push('CF_API_TOKEN');
	if (!CF_ACCOUNT) missing.push('CF_ACCOUNT_ID');
	if (!CF_NS)      missing.push('CF_KV_NAMESPACE_ID');
	if (!SB_URL)     missing.push('SUPABASE_URL');
	if (!SB_KEY)     missing.push('SUPABASE_SERVICE_KEY');
	if (missing.length) {
		err(`Missing required env vars: ${missing.join(', ')}`);
		err('See script header for usage.');
		process.exit(1);
	}
}

// ── Checkpoint ──────────────────────────────────────────────────
function loadCheckpoint() {
	if (existsSync(CHECKPOINT)) {
		try {
			const data = JSON.parse(readFileSync(CHECKPOINT, 'utf8'));
			info(`Resuming from checkpoint: ${data.processed ?? 0} already processed`);
			return data;
		} catch { /* ignore corrupt checkpoint */ }
	}
	return { processed: 0, created: [], failed: [], skipped: [], done: [] };
}

function saveCheckpoint(cp) {
	if (DRY_RUN) return; // never write checkpoint in dry-run
	try { writeFileSync(CHECKPOINT, JSON.stringify(cp, null, 2)); } catch { /* non-fatal */ }
}

// ── Cloudflare KV API ───────────────────────────────────────────
const CF_BASE = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/storage/kv/namespaces/${CF_NS}`;

async function cfFetch(path, opts = {}) {
	const res = await fetch(`${CF_BASE}${path}`, {
		...opts,
		headers: { 'Authorization': `Bearer ${CF_TOKEN}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
	});
	const body = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(`CF KV ${opts.method || 'GET'} ${path}: ${res.status} ${body?.errors?.[0]?.message || ''}`);
	return body;
}

async function* listKvUsers() {
	let cursor = null;
	let page = 0;
	do {
		const params = new URLSearchParams({ prefix: 'user:', limit: '100' });
		if (cursor) params.set('cursor', cursor);
		const data = await cfFetch(`/keys?${params}`);
		page++;
		const keys = (data.result || []).map(k => k.name);
		// Batch-fetch values (CF KV has no multi-get; do it in parallel chunks of 10)
		for (let i = 0; i < keys.length; i += 10) {
			const chunk = keys.slice(i, i + 10);
			const values = await Promise.all(
				chunk.map(key =>
					cfFetch(`/values/${encodeURIComponent(key)}`)
						.then(v => ({ key, value: v }))
						.catch(() => ({ key, value: null }))
				)
			);
			for (const { key, value } of values) {
				if (value && typeof value === 'object' && value.email) yield value;
			}
		}
		cursor = data.result_info?.cursor;
	} while (cursor);
}

async function kvPut(key, value) {
	await cfFetch(`/values/${encodeURIComponent(key)}`, {
		method: 'PUT',
		headers: { 'Content-Type': 'text/plain' },
		body: JSON.stringify(value),
	});
}

// ── Supabase Admin API ──────────────────────────────────────────
async function sbFetch(path, opts = {}) {
	const res = await fetch(`${SB_URL}${path}`, {
		...opts,
		headers: {
			'apikey': SB_KEY,
			'Authorization': `Bearer ${SB_KEY}`,
			'Content-Type': 'application/json',
			...(opts.headers || {}),
		},
	});
	const body = await res.json().catch(() => ({}));
	if (!res.ok && res.status !== 422) { // 422 = already exists (acceptable)
		throw new Error(`Supabase ${opts.method || 'GET'} ${path}: ${res.status} ${JSON.stringify(body)}`);
	}
	return { status: res.status, body };
}

async function getSupabaseUserByEmail(email) {
	// Search admin users list — filter by email
	const { body } = await sbFetch(`/auth/v1/admin/users?email=${encodeURIComponent(email)}&page=1&per_page=1`);
	const users = body?.users || [];
	return users.find(u => u.email?.toLowerCase() === email.toLowerCase()) || null;
}

async function createSupabaseUser(user) {
	// Generate a secure random password — user will use magic link, never this password
	const pw = Array.from(crypto.getRandomValues(new Uint8Array(24)))
		.map(b => b.toString(16).padStart(2, '0')).join('');
	const { status, body } = await sbFetch('/auth/v1/admin/users', {
		method: 'POST',
		body: JSON.stringify({
			email: user.email,
			email_confirm: true,
			password: pw,
			user_metadata: {
				tier: user.tier || 'free',
				created_at: user.createdAt,
				stripe_customer_id: user.stripeCustomerId || null,
				api_key_hint: user.apiKey ? user.apiKey.slice(0, 12) : null,
				migrated_from_kv: true,
			},
		}),
	});
	if (status === 422 && body?.msg?.includes('already')) {
		// Already exists — fetch and return
		return await getSupabaseUserByEmail(user.email);
	}
	return body; // { id, email, ... }
}

async function upsertProfile(uid, user) {
	const { status, body } = await sbFetch('/rest/v1/profiles', {
		method: 'POST',
		headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },
		body: JSON.stringify({
			id: uid,
			email: user.email,
			tier: user.tier || 'free',
			stripe_customer_id: user.stripeCustomerId || null,
			api_key_hint: user.apiKey ? user.apiKey.slice(0, 12) : null,
			supabase_uid: uid,
		}),
	});
	if (status >= 400) {
		warn(`  Profile upsert failed (status ${status}): ${JSON.stringify(body)}`);
		warn('  Profiles table may be missing columns from migration 029. Run migrations/029_profiles_auth_fields.sql first.');
	}
}

// ── Rate limiter ────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Main ────────────────────────────────────────────────────────
async function main() {
	console.log(`\n${B}migrate-users-to-supabase${X}  mode: ${DRY_RUN ? `${Y}DRY-RUN${X}` : `${R}LIVE (--apply)${X}`}`);
	console.log(`${D}Supabase: ${SB_URL}${X}`);
	console.log(`${D}KV namespace: ${CF_NS}${X}\n`);

	assertEnv();

	const cp = loadCheckpoint();
	const doneSet = new Set(cp.done || []);

	let total = 0, skipped = 0, alreadyDone = 0, wouldCreate = 0, created = 0, failed = 0;

	for await (const user of listKvUsers()) {
		total++;
		const email = user.email?.toLowerCase();

		if (!email) { warn(`Skipping record with no email`); skipped++; continue; }

		// Skip internal/admin accounts
		const domain = email.split('@')[1] || '';
		if (SKIP_DOMAINS.has(domain)) {
			dim(`Skip (internal domain): ${email}`);
			skipped++;
			continue;
		}

		// Skip already migrated (has supabase_uid)
		if (user.supabaseUid) {
			dim(`Skip (already migrated): ${email} -> ${user.supabaseUid}`);
			alreadyDone++;
			continue;
		}

		// Skip if checkpoint says done
		if (doneSet.has(email)) {
			dim(`Skip (checkpoint): ${email}`);
			alreadyDone++;
			continue;
		}

		wouldCreate++;

		if (DRY_RUN) {
			info(`[dry-run] Would create Supabase user: ${email} (tier=${user.tier || 'free'}, stripe=${user.stripeCustomerId || 'none'})`);
			continue;
		}

		// Live mode
		try {
			// 1. Create or find Supabase auth user
			let sbUser = await getSupabaseUserByEmail(email);
			if (sbUser) {
				dim(`  Supabase user exists: ${email} -> ${sbUser.id}`);
			} else {
				sbUser = await createSupabaseUser(user);
				if (!sbUser?.id) throw new Error(`No ID returned for ${email}`);
				ok(`  Created Supabase user: ${email} -> ${sbUser.id}`);
				created++;
				cp.created.push({ email, uid: sbUser.id });
			}

			// 2. Upsert into public.profiles
			await upsertProfile(sbUser.id, user);

			// 3. Backfill KV user record with supabase_uid
			user.supabaseUid = sbUser.id;
			await kvPut(`user:${email}`, user);
			// Write UID index for fast reverse lookup
			await kvPut(`uid:${sbUser.id}`, email);

			doneSet.add(email);
			cp.done = [...doneSet];
			saveCheckpoint(cp);

		} catch (e) {
			err(`  Failed: ${email} — ${e.message}`);
			failed++;
			cp.failed.push({ email, error: e.message });
			saveCheckpoint(cp);
		}

		await sleep(RATE_MS);
	}

	// Summary
	console.log(`\n${B}── Summary ─────────────────────────────────────────────────────${X}`);
	console.log(`  Total KV users found:    ${total}`);
	console.log(`  Skipped (internal):      ${skipped}`);
	console.log(`  Already migrated:        ${alreadyDone}`);
	console.log(`  ${DRY_RUN ? `Would create` : `Created`}:             ${DRY_RUN ? wouldCreate : created}`);
	if (!DRY_RUN) console.log(`  Failed:                  ${failed}`);
	if (DRY_RUN) {
		console.log(`\n${Y}Dry-run complete. No writes performed.${X}`);
		console.log(`Run with ${B}--apply${X} to execute the migration.`);
	} else {
		console.log(`\n${G}Live migration complete.${X}`);
		if (failed > 0) console.log(`${Y}${failed} failures — check checkpoint at ${CHECKPOINT}${X}`);
	}
}

main().catch(e => { err(e.message); process.exit(1); });
