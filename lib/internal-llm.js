/**
 * lib/internal-llm.js -- Shared internal chat completion helper.
 *
 * Single source of truth for the OpenAI + OpenRouter fallback dance.
 * Used by both the public /v1/chat/completions route and ad-commander copy-gen.
 */

const OPENAI_BASE = 'https://api.openai.com/v1';
const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

const OPENROUTER_MODELS = {
	'gpt-5.1':            'openai/gpt-5.1',
	'gpt-5.1-codex-mini': 'openai/gpt-5.4-mini',
	'gpt-5.4':            'openai/gpt-5.4',
};

/**
 * Non-streaming chat completion with OpenAI primary, OpenRouter fallback.
 *
 * @param {object} env - Worker env bindings (OPENAI_API_KEY, OPENROUTER_API_KEY)
 * @param {object} body - { model, messages, response_format?, max_completion_tokens?, max_tokens?, ... }
 * @returns {{ ok: true, data: object, provider: string, tokenUsage: object } | { ok: false, code: number, error: string }}
 */
export async function runInternalChatCompletion(env, body) {
	if (!env.OPENAI_API_KEY && !env.OPENROUTER_API_KEY) {
		return { ok: false, code: 503, error: 'No LLM upstream configured' };
	}

	let upstreamRes = null;
	let provider = 'openai';
	let lastErr = null;

	// Try OpenAI first
	if (env.OPENAI_API_KEY) {
		try {
			upstreamRes = await fetch(`${OPENAI_BASE}/chat/completions`, {
				method: 'POST',
				headers: {
					'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify(body),
			});
		} catch (e) {
			lastErr = `OpenAI network error: ${e.message || e}`;
			upstreamRes = null;
		}

		if (upstreamRes && !upstreamRes.ok) {
			const errBody = await upstreamRes.text().catch(() => '');
			try { lastErr = JSON.parse(errBody).error?.message; } catch { lastErr = `OpenAI ${upstreamRes.status}`; }
			// Fall through to OpenRouter on 5xx or 429
			if (upstreamRes.status >= 500 || upstreamRes.status === 429) {
				upstreamRes = null;
			} else {
				return { ok: false, code: upstreamRes.status, error: lastErr || 'OpenAI request failed' };
			}
		}
	}

	// Fallback to OpenRouter
	if (!upstreamRes && env.OPENROUTER_API_KEY) {
		provider = 'openrouter';
		const orModel = OPENROUTER_MODELS[body.model] || body.model;
		const orBody = { ...body, model: orModel };
		if (orBody.max_tokens && orBody.max_tokens < 16) orBody.max_tokens = 16;

		try {
			upstreamRes = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
				method: 'POST',
				headers: {
					'Authorization': `Bearer ${env.OPENROUTER_API_KEY}`,
					'Content-Type': 'application/json',
					'HTTP-Referer': 'https://api.eternium.ai',
					'X-Title': 'Eternium API',
				},
				body: JSON.stringify(orBody),
			});
		} catch (e) {
			lastErr = `OpenRouter network error: ${e.message || e}`;
			upstreamRes = null;
		}

		if (upstreamRes && !upstreamRes.ok) {
			const errBody = await upstreamRes.text().catch(() => '');
			try { lastErr = JSON.parse(errBody).error?.message; } catch { lastErr = `OpenRouter ${upstreamRes.status}`; }
			upstreamRes = null;
		}
	}

	if (!upstreamRes) {
		return { ok: false, code: 503, error: lastErr || 'All LLM providers unavailable' };
	}

	const data = await upstreamRes.json();
	const tokenUsage = {
		input: data.usage?.prompt_tokens || 0,
		output: data.usage?.completion_tokens || 0,
	};

	return { ok: true, data, provider, tokenUsage };
}
