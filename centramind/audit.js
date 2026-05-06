/**
 * Append a row to fleet_events for every tool call (success or failure).
 * Non-blocking.
 */
export async function logToolCall({ env, ctx, tool, args, status, durationMs, errorMessage }) {
	const SUPABASE_URL = env.SUPABASE_URL;
	const KEY = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY;
	if (!SUPABASE_URL || !KEY) return;

	const body = {
		instance_name: "centramind-gateway",
		event_type: "mcp_tool_call",
		payload: {
			tool,
			tenant_id: ctx?.tenant_id ?? null,
			user_id: ctx?.user_id ?? null,
			role: ctx?.role ?? null,
			api_key_id: ctx?.api_key_id ?? null,
			status,
			duration_ms: durationMs,
			error_message: errorMessage ?? null,
			args_keys: args ? Object.keys(args) : [],
		},
	};

	try {
		await fetch(`${SUPABASE_URL}/rest/v1/fleet_events`, {
			method: "POST",
			headers: {
				apikey: KEY,
				Authorization: `Bearer ${KEY}`,
				"Content-Type": "application/json",
				Prefer: "return=minimal",
			},
			body: JSON.stringify(body),
		});
	} catch {
		// swallow
	}
}
