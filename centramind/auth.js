/**
 * Resolves an API key to an AuthContext.
 * Storage shape (KV: API_KEYS):
 *   key: api_key value (or hashed lookup)
 *   value: JSON {
 *     id, tenant_id, user_id, role, scopes: string[], created_at, last_used_at, status
 *   }
 */
export async function resolveAuthContext(request, env) {
	const auth = request.headers.get("Authorization") || "";
	const m = auth.match(/^Bearer\s+(.+)$/i);
	if (!m) {
		return { error: "Missing or malformed Authorization header", status: 401 };
	}
	const apiKey = m[1].trim();

	const raw = await env.API_KEYS.get(apiKey, { type: "json" });
	if (!raw) {
		return { error: "Invalid API key", status: 401 };
	}
	if (raw.status !== "active") {
		return { error: `Key status: ${raw.status}`, status: 403 };
	}

	// Optional X-Tenant-Slug header
	const requestedTenant = request.headers.get("X-Tenant-Slug");
	let tenant_id = raw.tenant_id;
	if (requestedTenant && requestedTenant !== raw.tenant_id) {
		return { error: "API key not authorized for tenant: " + requestedTenant, status: 403 };
	}

	// Fire and forget last_used_at update
	env.API_KEYS.put(apiKey, JSON.stringify({ ...raw, last_used_at: new Date().toISOString() }))
		.catch(() => {});

	return {
		ctx: {
			tenant_id,
			user_id: raw.user_id,
			role: raw.role || "member",
			source: "http_gateway",
			api_key_id: raw.id,
		},
	};
}
