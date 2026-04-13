/**
 * lib/daily-sop.js -- Daily SOP Morning Brief
 *
 * Runs every morning at 7:30 AM MST (13:30 UTC) via cron trigger.
 * Compiles: ad performance, task hygiene, financial snapshot, fleet health.
 * Stores brief in `morning_briefs` table, sends summary to Telegram.
 *
 * Can also be triggered manually via GET /admin/morning-brief.
 */

import { sendTelegram } from './telegram.js';

// ── Supabase helpers ────────────────────────────────────────────────────────

async function supabaseQuery(env, table, params = '') {
	const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}${params ? '?' + params : ''}`, {
		headers: {
			'apikey': env.SUPABASE_SERVICE_KEY,
			'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
		},
	});
	if (!res.ok) {
		console.log(`[DailySOP] Query ${table} failed: ${res.status}`);
		return null;
	}
	return res.json();
}

async function supabaseUpsert(env, table, row) {
	const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}`, {
		method: 'POST',
		headers: {
			'apikey': env.SUPABASE_SERVICE_KEY,
			'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
			'Content-Type': 'application/json',
			'Prefer': 'resolution=merge-duplicates,return=representation',
		},
		body: JSON.stringify(row),
	});
	if (!res.ok) {
		const err = await res.text().catch(() => String(res.status));
		console.log(`[DailySOP] Upsert ${table} failed: ${err}`);
		return null;
	}
	const data = await res.json();
	return Array.isArray(data) ? data[0] : data;
}

// ── Date helpers ────────────────────────────────────────────────────────────

function todayMST() {
	return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Denver' });
}

function yesterdayMST() {
	const d = new Date();
	d.setDate(d.getDate() - 1);
	return d.toLocaleDateString('en-CA', { timeZone: 'America/Denver' });
}

function daysAgoISO(n) {
	const d = new Date();
	d.setDate(d.getDate() - n);
	return d.toISOString();
}

function formatDate(iso) {
	return new Date(iso).toLocaleDateString('en-US', {
		timeZone: 'America/Denver',
		month: 'short',
		day: 'numeric',
		year: 'numeric',
	});
}

function timeAgo(iso) {
	if (!iso) return 'never';
	const diff = Date.now() - new Date(iso).getTime();
	const mins = Math.floor(diff / 60000);
	if (mins < 1) return 'just now';
	if (mins < 60) return `${mins}m ago`;
	const hrs = Math.floor(mins / 60);
	if (hrs < 24) return `${hrs}h ago`;
	const days = Math.floor(hrs / 24);
	return `${days}d ago`;
}

function fmt$(n) {
	return '$' + Number(n || 0).toFixed(2);
}

function fmtInt(n) {
	return Number(n || 0).toLocaleString('en-US');
}

// ── Section 1: Ad Performance ───────────────────────────────────────────────

async function pullAdPerformance(env) {
	const yesterday = yesterdayMST();
	const sevenDaysAgo = new Date();
	sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
	const sevenDaysAgoStr = sevenDaysAgo.toLocaleDateString('en-CA', { timeZone: 'America/Denver' });

	// Yesterday's totals
	const yesterdayData = await supabaseQuery(env, 'ads_daily_insights',
		`select=*&date=eq.${yesterday}`);

	// 7-day data for averages
	const weekData = await supabaseQuery(env, 'ads_daily_insights',
		`select=*&date=gte.${sevenDaysAgoStr}&date=lte.${yesterday}`);

	const yd = (yesterdayData || []).reduce((acc, r) => ({
		spend: acc.spend + (r.spend || 0),
		impressions: acc.impressions + (r.impressions || 0),
		clicks: acc.clicks + (r.clicks || 0),
		conversions: acc.conversions + (r.conversions || 0),
	}), { spend: 0, impressions: 0, clicks: 0, conversions: 0 });

	yd.ctr = yd.impressions > 0 ? ((yd.clicks / yd.impressions) * 100).toFixed(2) : '0.00';
	yd.cpa = yd.conversions > 0 ? (yd.spend / yd.conversions).toFixed(2) : null;

	// 7-day averages
	const weekRows = weekData || [];
	const uniqueDays = new Set(weekRows.map(r => r.date)).size || 1;
	const weekTotals = weekRows.reduce((acc, r) => ({
		spend: acc.spend + (r.spend || 0),
		conversions: acc.conversions + (r.conversions || 0),
	}), { spend: 0, conversions: 0 });
	const avgCpa = weekTotals.conversions > 0
		? (weekTotals.spend / weekTotals.conversions).toFixed(2)
		: null;

	// Check for creative-level CPA flags (if ads_creative_insights exists)
	let creativeFlags = [];
	try {
		const creativeInsights = await supabaseQuery(env, 'ads_creative_insights',
			`select=creative_id,spend,conversions,cpa&date=eq.${yesterday}`);

		if (creativeInsights && creativeInsights.length > 0 && avgCpa) {
			const avgCpaNum = parseFloat(avgCpa);
			for (const ci of creativeInsights) {
				const creativeCpa = ci.cpa || (ci.conversions > 0 ? ci.spend / ci.conversions : null);
				if (creativeCpa && creativeCpa > avgCpaNum * 1.5) {
					creativeFlags.push({ creative_id: ci.creative_id, cpa: creativeCpa, signal: 'Pause' });
				} else if (creativeCpa && creativeCpa < avgCpaNum * 0.8) {
					creativeFlags.push({ creative_id: ci.creative_id, cpa: creativeCpa, signal: 'Promote' });
				}
			}
		}
	} catch (e) {
		// Table may not exist yet
	}

	return {
		yesterday: yd,
		avgCpa7d: avgCpa,
		creativeFlags,
		hasData: (yesterdayData || []).length > 0,
	};
}

// ── Section 2: Task Hygiene ─────────────────────────────────────────────────

async function pullTaskHygiene(env) {
	const now = new Date();
	const yesterday = daysAgoISO(1);
	const fortyEightHoursAgo = daysAgoISO(2);

	// Completed in last 24h
	const completed = await supabaseQuery(env, 'fleet_tasks',
		`select=id&status=eq.done&updated_at=gte.${yesterday}`);

	// Also check general tasks table
	const completedTasks = await supabaseQuery(env, 'tasks',
		`select=id&status=eq.done&updated_at=gte.${yesterday}`);

	// In progress
	const inProgress = await supabaseQuery(env, 'fleet_tasks',
		`select=id&status=in.(claimed,in_progress)`);

	const inProgressTasks = await supabaseQuery(env, 'tasks',
		`select=id&status=eq.in_progress`);

	// Stuck (>48h in claimed/in_progress)
	const stuck = await supabaseQuery(env, 'fleet_tasks',
		`select=id,title,status&status=in.(claimed,in_progress)&updated_at=lte.${fortyEightHoursAgo}`);

	const stuckTasks = await supabaseQuery(env, 'tasks',
		`select=id,title,status&status=eq.in_progress&updated_at=lte.${fortyEightHoursAgo}`);

	// Fleet events in last 24h
	const fleetEvents = await supabaseQuery(env, 'fleet_events',
		`select=id&created_at=gte.${yesterday}`);

	return {
		completedCount: (completed?.length || 0) + (completedTasks?.length || 0),
		inProgressCount: (inProgress?.length || 0) + (inProgressTasks?.length || 0),
		stuckCount: (stuck?.length || 0) + (stuckTasks?.length || 0),
		stuckItems: [...(stuck || []), ...(stuckTasks || [])].slice(0, 5),
		fleetEventsCount: fleetEvents?.length || 0,
	};
}

// ── Section 3: Financial Snapshot ───────────────────────────────────────────

async function pullFinancialSnapshot(env) {
	const now = new Date();
	const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
	const yesterday = yesterdayMST();

	// MTD transactions
	const transactions = await supabaseQuery(env, 'transactions',
		`select=type,amount&date=gte.${monthStart}`);

	const mtd = (transactions || []).reduce((acc, t) => {
		if (t.type === 'income') acc.income += (t.amount || 0);
		else acc.expenses += (t.amount || 0);
		return acc;
	}, { income: 0, expenses: 0 });
	mtd.net = mtd.income - mtd.expenses;

	// Upcoming recurring bills (next 7 days)
	const sevenDaysOut = new Date();
	sevenDaysOut.setDate(sevenDaysOut.getDate() + 7);
	const sevenDaysStr = sevenDaysOut.toLocaleDateString('en-CA', { timeZone: 'America/Denver' });

	const bills = await supabaseQuery(env, 'recurring_bills',
		`select=name,amount,next_due&next_due=gte.${todayMST()}&next_due=lte.${sevenDaysStr}&order=next_due.asc`);

	// Yesterday's Stripe revenue
	const stripePayments = await supabaseQuery(env, 'stripe_payments',
		`select=amount_cents,status&created_at=gte.${yesterday}T00:00:00&created_at=lt.${todayMST()}T00:00:00&status=eq.succeeded`);

	const yesterdayRevenue = (stripePayments || []).reduce((acc, p) => acc + (p.amount_cents || 0), 0) / 100;

	// Fixed monthly burn rate
	const FIXED_BURN = 397;
	const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
	const dayOfMonth = now.getDate();
	const projectedMonthlyExpenses = mtd.expenses > 0
		? (mtd.expenses / dayOfMonth) * daysInMonth
		: FIXED_BURN;

	return {
		mtdIncome: mtd.income,
		mtdExpenses: mtd.expenses,
		mtdNet: mtd.net,
		yesterdayRevenue,
		upcomingBills: bills || [],
		fixedBurn: FIXED_BURN,
		projectedExpenses: projectedMonthlyExpenses,
	};
}

// ── Section 4: Fleet Health ─────────────────────────────────────────────────

async function pullFleetHealth(env) {
	const instances = await supabaseQuery(env, 'fleet_instances',
		`select=*&order=name.asc`);

	const oneHourAgo = daysAgoISO(0.0417); // ~1 hour

	const rows = instances || [];
	const online = rows.filter(i => i.status === 'online' || i.status === 'busy');
	const offline = rows.filter(i => i.status === 'offline');
	const staleHeartbeat = rows.filter(i =>
		i.last_heartbeat && new Date(i.last_heartbeat).getTime() < new Date(oneHourAgo).getTime()
	);

	// Last dispatch
	const lastDispatch = await supabaseQuery(env, 'fleet_events',
		`select=created_at&event_type=eq.dispatch&order=created_at.desc&limit=1`);

	return {
		total: rows.length,
		onlineCount: online.length,
		offlineCount: offline.length,
		staleInstances: staleHeartbeat.map(i => i.name || i.id),
		lastDispatchAt: lastDispatch?.[0]?.created_at || null,
	};
}

// ── Compile + Store + Send ──────────────────────────────────────────────────

function formatTelegramBrief(date, ads, tasks, finance, fleet) {
	const lines = [];

	lines.push(`\u2600\uFE0F *Morning Brief -- ${formatDate(date)}*`);
	lines.push('');

	// Ads
	lines.push('\uD83D\uDCCA *ADS*');
	if (ads.hasData) {
		lines.push(`\u2022 Yesterday spend: ${fmt$(ads.yesterday.spend)} | Calls: ${fmtInt(ads.yesterday.conversions)} | CPA: ${ads.yesterday.cpa ? fmt$(ads.yesterday.cpa) : 'N/A'}`);
		lines.push(`\u2022 7-day avg CPA: ${ads.avgCpa7d ? fmt$(ads.avgCpa7d) : 'N/A'}`);
		lines.push(`\u2022 CTR: ${ads.yesterday.ctr}% | Impressions: ${fmtInt(ads.yesterday.impressions)} | Clicks: ${fmtInt(ads.yesterday.clicks)}`);
		if (ads.creativeFlags.length > 0) {
			const flagStr = ads.creativeFlags.map(f => `${f.signal} (CPA ${fmt$(f.cpa)})`).join(', ');
			lines.push(`\u2022 Flags: ${flagStr}`);
		} else {
			lines.push('\u2022 Flags: None');
		}
	} else {
		lines.push('\u2022 No ad data for yesterday');
	}
	lines.push('');

	// Tasks
	lines.push('\u2705 *TASKS*');
	lines.push(`\u2022 Completed (24h): ${tasks.completedCount}`);
	lines.push(`\u2022 In progress: ${tasks.inProgressCount}`);
	lines.push(`\u2022 Stuck (>48h): ${tasks.stuckCount}`);
	if (tasks.stuckItems.length > 0) {
		lines.push(`\u2022 Stuck: ${tasks.stuckItems.map(s => s.title || s.id).join(', ')}`);
	}
	if (tasks.fleetEventsCount > 0) {
		lines.push(`\u2022 Fleet events (24h): ${tasks.fleetEventsCount}`);
	}
	lines.push('');

	// Finance
	lines.push('\uD83D\uDCB0 *FINANCE*');
	lines.push(`\u2022 MTD Revenue: ${fmt$(finance.mtdIncome)}`);
	lines.push(`\u2022 MTD Expenses: ${fmt$(finance.mtdExpenses)}`);
	lines.push(`\u2022 Net: ${fmt$(finance.mtdNet)}`);
	if (finance.yesterdayRevenue > 0) {
		lines.push(`\u2022 Yesterday Stripe: ${fmt$(finance.yesterdayRevenue)}`);
	}
	if (finance.upcomingBills.length > 0) {
		const billList = finance.upcomingBills.map(b => `${b.name} ${fmt$(b.amount)}`).join(', ');
		lines.push(`\u2022 Upcoming bills (7d): ${billList}`);
	} else {
		lines.push('\u2022 No bills due in next 7 days');
	}
	lines.push('');

	// Fleet
	lines.push('\uD83E\uDD16 *FLEET*');
	lines.push(`\u2022 Online: ${fleet.onlineCount}/${fleet.total}`);
	lines.push(`\u2022 Last dispatch: ${timeAgo(fleet.lastDispatchAt)}`);
	if (fleet.staleInstances.length > 0) {
		lines.push(`\u2022 Stale heartbeat: ${fleet.staleInstances.join(', ')}`);
	}
	lines.push('');

	lines.push('Have a great day, Ty.');

	return lines.join('\n');
}

/**
 * Run the full Daily SOP routine.
 * @param {object} env  CF Worker env bindings
 * @returns {Promise<object>} The compiled brief data
 */
export async function runDailySOP(env) {
	if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) {
		console.log('[DailySOP] Supabase not configured, skipping');
		return { error: 'Supabase not configured' };
	}

	const briefDate = todayMST();
	console.log(`[DailySOP] Running morning brief for ${briefDate}`);

	// Pull all sections in parallel
	const [ads, tasks, finance, fleet] = await Promise.all([
		pullAdPerformance(env).catch(err => {
			console.log(`[DailySOP] Ad performance error: ${err.message}`);
			return { yesterday: {}, avgCpa7d: null, creativeFlags: [], hasData: false };
		}),
		pullTaskHygiene(env).catch(err => {
			console.log(`[DailySOP] Task hygiene error: ${err.message}`);
			return { completedCount: 0, inProgressCount: 0, stuckCount: 0, stuckItems: [], fleetEventsCount: 0 };
		}),
		pullFinancialSnapshot(env).catch(err => {
			console.log(`[DailySOP] Financial snapshot error: ${err.message}`);
			return { mtdIncome: 0, mtdExpenses: 0, mtdNet: 0, yesterdayRevenue: 0, upcomingBills: [], fixedBurn: 397, projectedExpenses: 0 };
		}),
		pullFleetHealth(env).catch(err => {
			console.log(`[DailySOP] Fleet health error: ${err.message}`);
			return { total: 0, onlineCount: 0, offlineCount: 0, staleInstances: [], lastDispatchAt: null };
		}),
	]);

	const briefData = { ads, tasks, finance, fleet, generated_at: new Date().toISOString() };

	// Store in morning_briefs
	const stored = await supabaseUpsert(env, 'morning_briefs', {
		date: briefDate,
		data: briefData,
	});

	if (stored) {
		console.log(`[DailySOP] Brief stored for ${briefDate}`);
	}

	// Send Telegram summary
	const telegramText = formatTelegramBrief(briefDate, ads, tasks, finance, fleet);
	const sent = await sendTelegram(env, telegramText);
	console.log(`[DailySOP] Telegram ${sent ? 'sent' : 'skipped/failed'}`);

	return { date: briefDate, data: briefData, telegram_sent: sent };
}
