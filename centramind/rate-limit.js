/**
 * Sliding-window rate limit, KV-backed. Default: 60 req/min per API key.
 */
const WINDOW_MS = 60_000;
const DEFAULT_LIMIT = 60;

export async function checkRateLimit({ env, apiKeyId, limit = DEFAULT_LIMIT }) {
	const now = Date.now();
	const bucketKey = `ratelimit:${apiKeyId}:${Math.floor(now / WINDOW_MS)}`;

	const current = parseInt((await env.CACHE.get(bucketKey)) || "0", 10);
	if (current >= limit) {
		return { ok: false, limit, current };
	}

	await env.CACHE.put(bucketKey, String(current + 1), { expirationTtl: 120 });
	return { ok: true, limit, current: current + 1 };
}
