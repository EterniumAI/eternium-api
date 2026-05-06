import { TOOL_REGISTRY, isKnownTool } from "./registry.js";
import { resolveAuthContext } from "./auth.js";
import { logToolCall } from "./audit.js";
import { checkRateLimit } from "./rate-limit.js";
import { createClient } from "@supabase/supabase-js";

let dbCache;
function getDb(env) {
	if (!dbCache) {
		dbCache = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY, {
			auth: { persistSession: false, autoRefreshToken: false },
		});
	}
	return dbCache;
}

function jsonResponse(body, init = {}) {
	return new Response(JSON.stringify(body), {
		...init,
		headers: { "Content-Type": "application/json", ...(init.headers || {}) },
	});
}

export async function handleCentramindToolRequest(request, env, toolName) {
	const startedAt = Date.now();

	// 1. Method check
	if (request.method !== "POST") {
		return jsonResponse({ error: "Method not allowed; use POST" }, { status: 405 });
	}

	// 2. Tool exists?
	if (!isKnownTool(toolName)) {
		return jsonResponse({ error: `Unknown tool: ${toolName}` }, { status: 404 });
	}

	// 3. Auth
	const authResult = await resolveAuthContext(request, env);
	if (authResult.error) {
		return jsonResponse({ error: authResult.error }, { status: authResult.status });
	}
	const ctx = authResult.ctx;

	// 4. Rate limit
	const rl = await checkRateLimit({ env, apiKeyId: ctx.api_key_id });
	if (!rl.ok) {
		return jsonResponse(
			{ error: "Rate limit exceeded", limit: rl.limit, current: rl.current },
			{ status: 429 }
		);
	}

	// 5. Parse body
	let body;
	try {
		body = await request.json();
	} catch {
		return jsonResponse({ error: "Invalid JSON body" }, { status: 400 });
	}
	const args = body.args ?? body;

	// 6. Validate via zod schema
	const entry = TOOL_REGISTRY[toolName];
	let parsedArgs;
	try {
		parsedArgs = entry.schema.parse(args);
	} catch (zErr) {
		await logToolCall({
			env, ctx, tool: toolName, args,
			status: "validation_error",
			durationMs: Date.now() - startedAt,
			errorMessage: zErr.message,
		});
		return jsonResponse(
			{ error: "Validation error", details: zErr.errors || zErr.message },
			{ status: 400 }
		);
	}

	// 7. Invoke
	const db = getDb(env);
	let result, errorMessage = null, status = "success";
	try {
		result = await entry.fn(db, parsedArgs, ctx);
	} catch (err) {
		errorMessage = err?.message || String(err);
		status = err?.code || "error";
	}

	const durationMs = Date.now() - startedAt;

	// 8. Audit log (fire and forget)
	logToolCall({ env, ctx, tool: toolName, args: parsedArgs, status, durationMs, errorMessage });

	// 9. Response
	if (errorMessage) {
		const httpStatus = status === "not_found" ? 404 : status === "forbidden" ? 403 : status === "validation_error" ? 400 : 500;
		return jsonResponse({ error: errorMessage, code: status }, { status: httpStatus });
	}
	return jsonResponse({ result, ctx: { tenant_id: ctx.tenant_id, role: ctx.role } });
}
