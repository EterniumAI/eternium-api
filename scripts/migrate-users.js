#!/usr/bin/env node
/**
 * Phase 2: Migrate KV Users to Supabase
 *
 * Reads all users from Cloudflare KV USERS namespace, creates corresponding
 * Supabase auth users, populates profiles, and links KV API_KEYS entries
 * with supabase_uid.
 *
 * Usage:
 *   node scripts/migrate-users.js --dry-run    # Preview changes
 *   node scripts/migrate-users.js              # Execute migration
 *
 * Secrets are read from vault files at runtime (never hardcoded).
 */

import { readFileSync } from 'fs';
import { randomBytes } from 'crypto';

// ── Config ──────────────────────────────────────────────────────
const CF_ACCOUNT_ID = '823fff5f71452a59d212a31561210ebd';
const KV_USERS_NS = '60a2ff86e6fb45d7a4f7b34a9f7db6cf';
const KV_API_KEYS_NS = '7a99702bb5a7469797a66c2fcd051db2';
const SUPABASE_URL = 'https://wmahfjguvqvefgjpbcdc.supabase.co';
const SUPABASE_PROJECT_REF = 'wmahfjguvqvefgjpbcdc';

const DRY_RUN = process.argv.includes('--dry-run');

// ── Secrets ─────────────────────────────────────────────────────
function loadSecrets() {
	const cfVault = JSON.parse(readFileSync('C:\\Eternium\\Sovereign\\data\\vault\\cloudflare_sovereign.json', 'utf-8'));
	// Service role key from website .env
	const envFile = readFileSync('C:\\Eternium\\Eternium Projects\\Eternium Website\\.env', 'utf-8');
	const serviceRoleMatch = envFile.match(/SUPABASE_SERVICE_ROLE_KEY=(.+)/);
	if (!serviceRoleMatch) throw new Error('SUPABASE_SERVICE_ROLE_KEY not found in website .env');

	return {
		cfToken: cfVault.token,
		supabaseServiceKey: serviceRoleMatch[1].trim(),
	};
}

// ── Cloudflare KV helpers ───────────────────────────────────────
async function kvListKeys(cfToken, namespaceId, prefix = '') {
	const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${namespaceId}/keys?prefix=${encodeURIComponent(prefix)}&limit=1000`;
	const res = await fetch(url, { headers: { Authorization: `Bearer ${cfToken}` } });
	const data = await res.json();
	if (!data.success) throw new Error(`KV list failed: ${JSON.stringify(data.errors)}`);
	return data.result.map(k => k.name);
}

async function kvGet(cfToken, namespaceId, key) {
	const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${namespaceId}/values/${encodeURIComponent(key)}`;
	const res = await fetch(url, { headers: { Authorization: `Bearer ${cfToken}` } });
	if (!res.ok) return null;
	return res.json();
}

async function kvPut(cfToken, namespaceId, key, value) {
	const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${namespaceId}/values/${encodeURIComponent(key)}`;
	const res = await fetch(url, {
		method: 'PUT',
		headers: { Authorization: `Bearer ${cfToken}`, 'Content-Type': 'application/json' },
		body: JSON.stringify(value),
	});
	const data = await res.json();
	if (!data.success) throw new Error(`KV put failed for ${key}: ${JSON.stringify(data.errors)}`);
}

// ── Supabase helpers ────────────────────────────────────────────
async function supabaseAdminListUsers(serviceKey) {
	const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?per_page=1000`, {
		headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
	});
	const data = await res.json();
	return data.users || [];
}

async function supabaseCreateUser(serviceKey, email, displayName) {
	const password = randomBytes(24).toString('base64url');
	const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
		method: 'POST',
		headers: {
			apikey: serviceKey,
			Authorization: `Bearer ${serviceKey}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			email,
			password,
			email_confirm: true,
			user_metadata: { display_name: displayName || email.split('@')[0] },
		}),
	});
	if (!res.ok) {
		const err = await res.text();
		throw new Error(`Supabase create user failed for ${email}: ${res.status} ${err}`);
	}
	return res.json();
}

async function supabaseUpsertProfile(serviceKey, profile) {
	const res = await fetch(`${SUPABASE_URL}/rest/v1/profiles`, {
		method: 'POST',
		headers: {
			apikey: serviceKey,
			Authorization: `Bearer ${serviceKey}`,
			'Content-Type': 'application/json',
			Prefer: 'resolution=merge-duplicates',
		},
		body: JSON.stringify(profile),
	});
	if (!res.ok) {
		const err = await res.text();
		throw new Error(`Supabase upsert profile failed for ${profile.id}: ${res.status} ${err}`);
	}
}

// ── Main ────────────────────────────────────────────────────────
async function main() {
	console.log(`\n=== Eternium KV → Supabase User Migration ===`);
	console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no changes)' : 'LIVE'}\n`);

	const secrets = loadSecrets();

	// Step 1: List all KV users
	console.log('Step 1: Loading KV users...');
	const userKeys = await kvListKeys(secrets.cfToken, KV_USERS_NS, 'user:');
	console.log(`  Found ${userKeys.length} KV user entries`);

	const kvUsers = [];
	for (const key of userKeys) {
		const user = await kvGet(secrets.cfToken, KV_USERS_NS, key);
		if (user) kvUsers.push(user);
	}
	console.log(`  Loaded ${kvUsers.length} user records\n`);

	// Step 2: Get existing Supabase users
	console.log('Step 2: Loading existing Supabase auth users...');
	const supabaseUsers = await supabaseAdminListUsers(secrets.supabaseServiceKey);
	const supabaseByEmail = new Map(supabaseUsers.map(u => [u.email.toLowerCase(), u]));
	console.log(`  Found ${supabaseUsers.length} existing Supabase users\n`);

	// Step 3: Migrate each user
	console.log('Step 3: Migrating users...');
	const stats = { skipped: 0, created: 0, profileUpdated: 0, apiKeyLinked: 0, errors: [] };

	for (const kvUser of kvUsers) {
		const email = kvUser.email.toLowerCase();
		const displayName = kvUser.name || email.split('@')[0];
		let supabaseUser = supabaseByEmail.get(email);

		// Skip test/ephemeral users auto-provisioned by security testing
		if (kvUser.passwordHash === null && kvUser.supabaseUid?.startsWith('test-')) {
			console.log(`  SKIP ${email} (test user, auto-provisioned)`);
			stats.skipped++;
			continue;
		}

		try {
			// Create Supabase auth user if not exists
			if (supabaseUser) {
				console.log(`  EXISTS ${email} (Supabase UID: ${supabaseUser.id})`);
				stats.skipped++;
			} else {
				if (DRY_RUN) {
					console.log(`  WOULD CREATE ${email} (tier: ${kvUser.tier}, stripe: ${kvUser.stripeCustomerId || 'none'})`);
					stats.created++;
					continue; // Can't upsert profile or link key without a real UID
				}
				console.log(`  CREATE ${email}...`);
				supabaseUser = await supabaseCreateUser(secrets.supabaseServiceKey, email, displayName);
				console.log(`    UID: ${supabaseUser.id}`);
				stats.created++;

				// Small delay to avoid rate limits
				await new Promise(r => setTimeout(r, 200));
			}

			// Upsert profile
			const profile = {
				id: supabaseUser.id,
				display_name: displayName,
				role: email === 'ty@eternium.ai' ? 'admin' : 'customer',
			};

			if (DRY_RUN) {
				console.log(`  WOULD UPSERT profile for ${email}: ${JSON.stringify(profile)}`);
			} else {
				await supabaseUpsertProfile(secrets.supabaseServiceKey, profile);
				console.log(`    Profile upserted`);
			}
			stats.profileUpdated++;

			// Link KV API_KEYS entry with supabase_uid
			if (kvUser.apiKey) {
				const apiKeyData = await kvGet(secrets.cfToken, KV_API_KEYS_NS, `key:${kvUser.apiKey}`);
				if (apiKeyData && !apiKeyData.supabaseUid) {
					apiKeyData.supabaseUid = supabaseUser.id;
					if (DRY_RUN) {
						console.log(`  WOULD LINK API key ${kvUser.apiKey.slice(0, 12)}... → UID ${supabaseUser.id}`);
					} else {
						await kvPut(secrets.cfToken, KV_API_KEYS_NS, `key:${kvUser.apiKey}`, apiKeyData);
						console.log(`    API key linked`);
					}
					stats.apiKeyLinked++;
				} else if (apiKeyData?.supabaseUid) {
					console.log(`    API key already linked (UID: ${apiKeyData.supabaseUid})`);
				}
			}

			// Update KV user record with supabaseUid
			if (!kvUser.supabaseUid && supabaseUser?.id) {
				kvUser.supabaseUid = supabaseUser.id;
				if (!DRY_RUN) {
					await kvPut(secrets.cfToken, KV_USERS_NS, `user:${email}`, kvUser);
					console.log(`    KV user record updated with supabaseUid`);
				}
			}

		} catch (err) {
			console.error(`  ERROR ${email}: ${err.message}`);
			stats.errors.push({ email, error: err.message });
		}
	}

	// Summary
	console.log(`\n=== Migration Summary ===`);
	console.log(`  Total KV users: ${kvUsers.length}`);
	console.log(`  Skipped (already exists or test): ${stats.skipped}`);
	console.log(`  Created in Supabase: ${stats.created}`);
	console.log(`  Profiles upserted: ${stats.profileUpdated}`);
	console.log(`  API keys linked: ${stats.apiKeyLinked}`);
	console.log(`  Errors: ${stats.errors.length}`);
	if (stats.errors.length > 0) {
		for (const e of stats.errors) {
			console.log(`    - ${e.email}: ${e.error}`);
		}
	}
	console.log(`\nMode: ${DRY_RUN ? 'DRY RUN — no changes were made' : 'LIVE — changes applied'}`);
}

main().catch(err => {
	console.error(`\nFATAL: ${err.message}`);
	process.exit(1);
});
