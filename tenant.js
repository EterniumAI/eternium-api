/**
 * Tenant Resolution Module
 * Resolves tenant context from hostname for managed hosting.
 *
 * Tenant resolution flow:
 *   1. Parse hostname from request
 *   2. If *.app.eternium.ai, extract slug and lookup in TENANTS KV
 *   3. If custom domain, lookup domain in TENANTS KV
 *   4. If api.eternium.ai or eternium.ai, no tenant (null context)
 *   5. Attach tenant context to request for downstream use
 */

const MANAGED_DOMAIN = 'app.eternium.ai';

/**
 * Resolve tenant from request hostname.
 * Returns tenant config object or null if not a tenant request.
 */
export async function resolveTenant(request, env) {
	const host = (request.headers.get('Host') || '').toLowerCase().replace(/:\d+$/, '');

	// Check if this is a tenant subdomain: {slug}.app.eternium.ai
	if (host.endsWith(`.${MANAGED_DOMAIN}`)) {
		const slug = host.replace(`.${MANAGED_DOMAIN}`, '');
		if (!slug || slug.includes('.')) return null; // invalid or nested subdomain

		return lookupTenantBySlug(slug, env);
	}

	// Skip internal/reserved hosts
	if (isInternalHost(host)) return null;

	// Check if this is a custom domain
	if (env.TENANTS) {
		return lookupTenantByDomain(host, env);
	}

	return null;
}

/**
 * Lookup tenant by slug in KV.
 */
async function lookupTenantBySlug(slug, env) {
	if (!env.TENANTS) return null;

	try {
		const data = await env.TENANTS.get(`slug:${slug}`, 'json');
		if (!data) return null;
		return { ...data, slug, resolution: 'subdomain' };
	} catch {
		return null;
	}
}

/**
 * Lookup tenant by custom domain in KV.
 */
async function lookupTenantByDomain(domain, env) {
	if (!env.TENANTS) return null;

	try {
		const data = await env.TENANTS.get(`domain:${domain}`, 'json');
		if (!data) return null;
		return { ...data, resolution: 'custom_domain' };
	} catch {
		return null;
	}
}

/**
 * Check if host is an internal Eternium domain (not a tenant).
 */
const RESERVED_SUBDOMAINS = new Set([
	'eternium.ai', 'www.eternium.ai',
	'api.eternium.ai', 'helix.eternium.ai',
	'media.eternium.ai', 'docs.eternium.ai',
	'admin.eternium.ai', 'mail.eternium.ai',
	'staging.eternium.ai',
]);

function isInternalHost(host) {
	return RESERVED_SUBDOMAINS.has(host)
		|| host === 'localhost'
		|| host.startsWith('localhost:')
		|| host.startsWith('127.0.0.1');
}

/**
 * Validate that a tenant is in a servable state.
 * Returns { ok: true, tenant } or { ok: false, status, error }.
 */
export function validateTenantStatus(tenant) {
	if (!tenant) {
		return { ok: false, status: 404, error: 'Tenant not found' };
	}

	switch (tenant.status) {
		case 'active':
			return { ok: true, tenant };
		case 'provisioning':
			return { ok: false, status: 503, error: 'Your instance is being provisioned. Please check back shortly.' };
		case 'suspended':
			return { ok: false, status: 402, error: 'Account suspended. Please update your payment method.' };
		case 'cancelled':
			return { ok: false, status: 410, error: 'This instance has been cancelled.' };
		default:
			return { ok: false, status: 500, error: 'Unknown tenant status' };
	}
}

/**
 * Build the KV value for a tenant (used during provisioning).
 */
export function buildTenantKVValue(tenant) {
	return {
		tenant_id: tenant.id,
		owner_id: tenant.owner_id,
		status: tenant.status,
		plan: tenant.plan,
		product_slug: tenant.product_slug,
		branding: tenant.branding || {},
		config: tenant.config || {},
		storage_limit_mb: tenant.storage_limit_mb,
		api_credits_included: tenant.api_credits_included,
	};
}

// ---- Tenant Admin Routes ----

/**
 * GET /v1/tenant -- Returns tenant config for SPA boot.
 */
export function handleGetTenant(tenant, cors) {
	return {
		data: {
			slug: tenant.slug,
			name: tenant.branding?.company_name || tenant.slug,
			plan: tenant.plan,
			branding: tenant.branding,
			config: tenant.config,
			status: tenant.status,
		},
		code: 200,
	};
}

/**
 * POST /admin/tenants/provision -- Create a new tenant.
 * Called by Stripe webhook or admin manually.
 */
export async function handleProvisionTenant(request, env) {
	let body;
	try {
		body = await request.json();
	} catch {
		return { error: 'Invalid JSON body', code: 400 };
	}

	const { slug, name, owner_email, product_slug, plan, stripe_customer_id, stripe_subscription_id, branding } = body;

	if (!slug || !name || !owner_email || !product_slug) {
		return { error: 'Missing required fields: slug, name, owner_email, product_slug', code: 400 };
	}

	// Validate slug format (alphanumeric + hyphens, 3-32 chars)
	if (!/^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/.test(slug)) {
		return { error: 'Slug must be 3-32 chars, lowercase alphanumeric with hyphens', code: 400 };
	}

	// Check slug not taken
	if (env.TENANTS) {
		const existing = await env.TENANTS.get(`slug:${slug}`, 'json');
		if (existing) {
			return { error: `Slug "${slug}" is already taken`, code: 409 };
		}
	}

	// Create tenant in Supabase
	const tenantId = crypto.randomUUID();
	const tenantRow = {
		id: tenantId,
		slug,
		name,
		owner_id: null, // Will be set after user lookup/creation
		product_slug,
		plan: plan || 'starter',
		status: 'provisioning',
		stripe_customer_id: stripe_customer_id || null,
		stripe_subscription_id: stripe_subscription_id || null,
		branding: branding || { logo_url: null, primary_color: '#06b6d4', company_name: name },
		config: buildDefaultConfig(plan || 'starter'),
		storage_limit_mb: plan === 'pro' ? 2048 : plan === 'enterprise' ? 10240 : 500,
		api_credits_included: plan === 'pro' ? 500 : plan === 'enterprise' ? 2000 : 100,
	};

	// Store in KV for fast subdomain resolution
	if (env.TENANTS) {
		const kvValue = buildTenantKVValue(tenantRow);
		await env.TENANTS.put(`slug:${slug}`, JSON.stringify(kvValue));
	}

	// Queue compute provisioning via infra_commands (VPS picks it up)
	// This is a Supabase insert -- the VPS cron polls for pending commands
	if (env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY) {
		try {
			// Insert tenant row
			await supabaseQuery(env, 'tenants', 'POST', tenantRow);

			// Queue Docker container provisioning
			await supabaseQuery(env, 'infra_commands', 'POST', {
				target: 'compute',
				service: 'imageforge',
				action: 'provision',
				params: { tenant_slug: slug, tenant_id: tenantId, plan: tenantRow.plan },
				status: 'pending',
			});
		} catch (err) {
			console.error('Tenant provisioning DB error:', err);
		}
	}

	return {
		data: {
			tenant_id: tenantId,
			slug,
			url: `https://${slug}.${MANAGED_DOMAIN}`,
			status: 'provisioning',
			message: 'Tenant created. Compute environment is being provisioned.',
		},
		code: 201,
	};
}

/**
 * GET /admin/tenants -- List all tenants.
 */
export async function handleListTenants(env) {
	if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) {
		return { error: 'Supabase not configured', code: 503 };
	}

	try {
		const res = await fetch(
			`${env.SUPABASE_URL}/rest/v1/tenants?select=id,slug,name,plan,status,product_slug,created_at&order=created_at.desc`,
			{
				headers: {
					'apikey': env.SUPABASE_SERVICE_KEY,
					'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
				},
			}
		);
		const data = await res.json();
		return { data: { tenants: data }, code: 200 };
	} catch (err) {
		return { error: 'Failed to list tenants', code: 500 };
	}
}

/**
 * PATCH /admin/tenants/:id -- Update tenant status/config.
 */
export async function handleUpdateTenant(tenantId, request, env) {
	let body;
	try {
		body = await request.json();
	} catch {
		return { error: 'Invalid JSON body', code: 400 };
	}

	const allowed = ['status', 'plan', 'branding', 'config', 'custom_domain', 'storage_limit_mb', 'api_credits_included'];
	const updates = {};
	for (const key of allowed) {
		if (body[key] !== undefined) updates[key] = body[key];
	}

	if (Object.keys(updates).length === 0) {
		return { error: 'No valid fields to update', code: 400 };
	}

	if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) {
		return { error: 'Supabase not configured', code: 503 };
	}

	try {
		const res = await fetch(
			`${env.SUPABASE_URL}/rest/v1/tenants?id=eq.${tenantId}`,
			{
				method: 'PATCH',
				headers: {
					'apikey': env.SUPABASE_SERVICE_KEY,
					'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
					'Content-Type': 'application/json',
					'Prefer': 'return=representation',
				},
				body: JSON.stringify(updates),
			}
		);
		const data = await res.json();

		// Update KV if status or config changed
		if (env.TENANTS && data[0]) {
			const tenant = data[0];
			const kvValue = buildTenantKVValue(tenant);
			await env.TENANTS.put(`slug:${tenant.slug}`, JSON.stringify(kvValue));
			if (tenant.custom_domain) {
				await env.TENANTS.put(`domain:${tenant.custom_domain}`, JSON.stringify(kvValue));
			}
		}

		return { data: { tenant: data[0] }, code: 200 };
	} catch (err) {
		return { error: 'Failed to update tenant', code: 500 };
	}
}

// ---- Helpers ----

function buildDefaultConfig(plan) {
	const base = {
		features: {
			imageforge: true,
			content_pipeline: true,
			analytics: false,
			auto_poster: false,
		},
	};

	if (plan === 'pro' || plan === 'enterprise') {
		base.features.analytics = true;
		base.features.auto_poster = true;
	}

	return base;
}

async function supabaseQuery(env, table, method, body) {
	const url = `${env.SUPABASE_URL}/rest/v1/${table}`;
	const res = await fetch(url, {
		method,
		headers: {
			'apikey': env.SUPABASE_SERVICE_KEY,
			'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
			'Content-Type': 'application/json',
			'Prefer': 'return=minimal',
		},
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		const err = await res.text();
		throw new Error(`Supabase ${method} ${table}: ${res.status} ${err}`);
	}
	return res;
}
