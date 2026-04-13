/**
 * lib/telegram.js -- Telegram notification helper
 *
 * Sends messages to Ty via @SovereignDigitalBot.
 *
 * Secrets required (set via `wrangler secret put`):
 *   TELEGRAM_BOT_TOKEN   -- Bot API token from @BotFather
 *   TELEGRAM_CHAT_ID     -- Ty's chat ID (numeric)
 */

const TELEGRAM_API = 'https://api.telegram.org';

/**
 * Send a text message to the configured Telegram chat.
 *
 * @param {object} env         CF Worker env
 * @param {string} text        Message body (Markdown supported)
 * @param {object} [opts]      Extra sendMessage params (parse_mode, etc.)
 * @returns {Promise<boolean>} true if sent successfully
 */
export async function sendTelegram(env, text, opts = {}) {
	const token = env.TELEGRAM_BOT_TOKEN;
	const chatId = env.TELEGRAM_CHAT_ID;

	if (!token || !chatId) {
		console.log('[Telegram] Bot token or chat ID not configured, skipping notification');
		return false;
	}

	try {
		const res = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				chat_id: chatId,
				text,
				parse_mode: 'Markdown',
				disable_web_page_preview: true,
				...opts,
			}),
		});

		if (!res.ok) {
			const err = await res.text().catch(() => res.status);
			console.log(`[Telegram] Send failed: ${err}`);
			return false;
		}
		return true;
	} catch (err) {
		console.log(`[Telegram] Send error: ${err.message}`);
		return false;
	}
}

/**
 * Format and send a Stripe transaction notification.
 *
 * @param {object} env
 * @param {object} txn  Transaction details
 * @param {number} txn.amount_cents
 * @param {string} txn.currency
 * @param {string} txn.type       e.g. 'purchase', 'subscription', 'renewal'
 * @param {string} txn.email
 * @param {string} txn.description
 * @param {string} txn.source     e.g. 'Stripe'
 */
export async function notifyTransaction(env, txn) {
	const amount = (txn.amount_cents / 100).toFixed(2);
	const currency = (txn.currency || 'usd').toUpperCase();
	const ts = new Date().toLocaleString('en-US', {
		timeZone: 'America/New_York',
		month: 'short',
		day: 'numeric',
		hour: 'numeric',
		minute: '2-digit',
	});

	const msg = [
		'\u{1F4B0} *New Transaction*',
		'',
		`Amount: $${amount} ${currency}`,
		`Source: ${txn.source || 'Stripe'}`,
		`Type: ${txn.type || 'payment'}`,
		`Customer: ${txn.email || 'unknown'}`,
		`Product: ${txn.description || '--'}`,
		`Time: ${ts}`,
	].join('\n');

	return sendTelegram(env, msg);
}
