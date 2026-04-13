/**
 * lib/credits.js -- Credit balance, deduction, and ledger endpoints
 *
 * Balance = monthly_allocation - spent_this_month + purchased_balance
 *
 * Monthly allocation comes from tier (KV: USAGE namespace).
 * Purchased balance comes from Supabase profiles.api_credit_balance.
 * Deductions increment KV spent, and once monthly credits are exhausted,
 * draw from purchased balance.
 * All mutations are logged to Supabase credit_ledger.
 */

// ── Supabase helpers ────────────────────────────────────────────────────────

async function supabaseQuery(env, table, params = '') {
	const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}${params ? '?' + params : ''}`, {
		headers: {
			'apikey': env.SUPABASE_SERVICE_KEY,
			'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
		},
	});
	if (!res.ok) return null;
	return res.json();
}

async function supabaseInsert(env, table, row) {
	const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}`, {
		method: 'POST',
		headers: {
			'apikey': env.SUPABASE_SERVICE_KEY,
			'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
			'Content-Type': 'application/json',
			'Prefer': 'return=representation',
		},
		body: JSON.stringify(row),
	});
	if (!res.ok) {
		const err = await res.text().catch(() => String(res.status));
		console.log(`[Credits] Insert ${table} failed: ${err}`);
		return null;
	}
	const data = await res.json();
	return Array.isArray(data) ? data[0] : data;
}

async function supabaseRpc(env, method, path, body = null) {
	const opts = {
		method,
		headers: {
			'apikey': env.SUPABASE_SERVICE_KEY,
			'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
			'Content-Type': 'application/json',
		},
	};
	if (body) opts.body = JSON.stringify(body);
	const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, opts);
	if (!res.ok) return null;
	return res.json();
}

// ── KV usage helpers (mirroring worker.js) ──────────────────────────────────

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

async function putUsage(env, apiKey, usage) {
	if (!env.USAGE) return;
	try {
		await env.USAGE.put(getUsageKey(apiKey), JSON.stringify(usage), { expirationTtl: 90 * 86400 });
	} catch { /* non-critical */ }
}

// ── Purchased balance (Supabase) ────────────────────────────────────────────

async function getPurchasedBalance(env, email) {
	if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) return 0;
	const rows = await supabaseQuery(env, 'profiles',
		`select=api_credit_balance&email=eq.${encodeURIComponent(email)}&limit=1`);
	return rows?.[0]?.api_credit_balance || 0;
}

async function updatePurchasedBalance(env, email, newBalance) {
	if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) return false;
	const res = await fetch(
		`${env.SUPABASE_URL}/rest/v1/profiles?email=eq.${encodeURIComponent(email)}`,
		{
			method: 'PATCH',
			headers: {
				'apikey': env.SUPABASE_SERVICE_KEY,
				'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
				'Content-Type': 'application/json',
				'Prefer': 'return=representation',
			},
			body: JSON.stringify({ api_credit_balance: newBalance }),
		}
	);
	return res.ok;
}

// ── Ledger logging ──────────────────────────────────────────────────────────

async function logToLedger(env, entry) {
	if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) return null;
	return supabaseInsert(env, 'credit_ledger', {
		email: entry.email,
		credits: entry.credits,
		direction: entry.direction, // 'debit' or 'credit'
		reason: entry.reason || null,
		reference_id: entry.reference_id || null,
		balance_after: entry.balance_after,
		source: entry.source || 'api',
		created_at: new Date().toISOString(),
	});
}

// ── Endpoint handlers ───────────────────────────────────────────────────────

/**
 * GET /v1/credits/balance
 */
export async function handleCreditBalance(env, keyData, tiers) {
	const tierConfig = tiers[keyData.tier] || tiers.free;
	const usage = await getUsage(env, keyData.key);
	const purchased = await getPurchasedBalance(env, keyData.email);

	const monthlyAllocation = tierConfig.monthlyCredits;
	const spentThisMonth = usage.spent;
	const monthlyRemaining = Math.max(monthlyAllocation - spentThisMonth, 0);

	return {
		data: {
			email: keyData.email,
			tier: keyData.tier,
			monthly_allocation: monthlyAllocation,
			spent_this_month: spentThisMonth,
			remaining: monthlyRemaining,
			purchased_balance: purchased,
			total_available: monthlyRemaining + purchased,
		},
		code: 200,
	};
}

/**
 * POST /v1/credits/deduct
 */
export async function handleCreditDeduct(env, keyData, body, tiers) {
	const credits = body?.credits;
	if (!credits || typeof credits !== 'number' || credits <= 0) {
		return { data: { error: 'credits must be a positive number' }, code: 400 };
	}

	const tierConfig = tiers[keyData.tier] || tiers.free;
	const usage = await getUsage(env, keyData.key);
	const purchased = await getPurchasedBalance(env, keyData.email);

	const monthlyAllocation = tierConfig.monthlyCredits;
	const monthlyRemaining = Math.max(monthlyAllocation - usage.spent, 0);
	const totalAvailable = monthlyRemaining + purchased;

	if (credits > totalAvailable) {
		return {
			data: {
				error: 'Insufficient credits',
				credits_requested: credits,
				total_available: totalAvailable,
				monthly_remaining: monthlyRemaining,
				purchased_balance: purchased,
			},
			code: 402,
		};
	}

	// Deduct: use monthly credits first, then purchased
	let fromMonthly = Math.min(credits, monthlyRemaining);
	let fromPurchased = credits - fromMonthly;

	// Update KV (increment spent by fromMonthly)
	if (fromMonthly > 0) {
		usage.spent += fromMonthly;
		usage.tasks.unshift({
			model: body.reason || 'external_deduction',
			credits: fromMonthly,
			cached: false,
			ts: Date.now(),
		});
		if (usage.tasks.length > 100) usage.tasks = usage.tasks.slice(0, 100);
		await putUsage(env, keyData.key, usage);
	}

	// Update Supabase purchased balance
	if (fromPurchased > 0) {
		const newPurchased = Math.max(purchased - fromPurchased, 0);
		await updatePurchasedBalance(env, keyData.email, newPurchased);
	}

	const newMonthlyRemaining = Math.max(monthlyAllocation - usage.spent, 0);
	const newPurchased = Math.max(purchased - fromPurchased, 0);
	const newTotal = newMonthlyRemaining + newPurchased;

	// Log to ledger
	await logToLedger(env, {
		email: keyData.email,
		credits: -credits,
		direction: 'debit',
		reason: body.reason || 'api_deduction',
		reference_id: body.reference_id || null,
		balance_after: newTotal,
	});

	return {
		data: {
			success: true,
			credits_deducted: credits,
			from_monthly: fromMonthly,
			from_purchased: fromPurchased,
			remaining: newTotal,
		},
		code: 200,
	};
}

/**
 * POST /v1/credits/add (admin only)
 */
export async function handleCreditAdd(env, body) {
	const { email, credits, reason, stripe_payment_id } = body || {};

	if (!email || typeof email !== 'string') {
		return { data: { error: 'email is required' }, code: 400 };
	}
	if (!credits || typeof credits !== 'number' || credits <= 0) {
		return { data: { error: 'credits must be a positive number' }, code: 400 };
	}

	const currentBalance = await getPurchasedBalance(env, email);
	const newBalance = currentBalance + credits;

	const updated = await updatePurchasedBalance(env, email, newBalance);
	if (!updated) {
		return { data: { error: 'Failed to update balance. Profile may not exist.' }, code: 500 };
	}

	// Log to ledger
	await logToLedger(env, {
		email,
		credits: credits,
		direction: 'credit',
		reason: reason || 'admin_add',
		reference_id: stripe_payment_id || null,
		balance_after: newBalance,
		source: stripe_payment_id ? 'stripe' : 'admin',
	});

	return {
		data: {
			success: true,
			email,
			credits_added: credits,
			previous_balance: currentBalance,
			new_balance: newBalance,
		},
		code: 200,
	};
}

/**
 * GET /v1/credits/history
 */
export async function handleCreditHistory(env, keyData) {
	if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) {
		return { data: { error: 'Supabase not configured' }, code: 500 };
	}

	const rows = await supabaseQuery(env, 'credit_ledger',
		`select=*&email=eq.${encodeURIComponent(keyData.email)}&order=created_at.desc&limit=50`);

	return {
		data: {
			email: keyData.email,
			entries: rows || [],
			count: (rows || []).length,
		},
		code: 200,
	};
}
