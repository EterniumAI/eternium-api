/**
 * lib/affiliate.js — Affiliate program stubs
 *
 * Referral attribution, commission calculation, and payout management
 * for the Eternium API affiliate program.
 *
 * Commission model:
 *   - 10% of each credit purchase made by a referred user
 *   - 12-month window from first_payment_at on the affiliate_referrals row
 *   - Default commission_rate_pct = 10; adjustable per affiliate via admin
 *
 * Referral code format: {base36(userId[0..7]).toUpperCase()}-{random4}
 *   Example: TY1A2B3C-X9KZ
 *
 * Attribution: first-touch, set at signup. No re-attribution.
 *
 * Supabase tables required (see migrations/028_billing_and_affiliate.sql):
 *   affiliate_accounts, affiliate_referrals, affiliate_commissions
 *
 * Usage:
 *   import { generateReferralCode, attributeSignup, calculateCommission, getAffiliateStats } from './lib/affiliate.js';
 */

// ── Referral code generation ─────────────────────────────────────────────────

/**
 * Generate a unique referral code for a user and persist it.
 *
 * Creates an affiliate_accounts row if one doesn't exist. Returns the
 * code whether freshly generated or already on file.
 *
 * Code format: {base36(userId[0..7])}-{4 random uppercase alphanumeric chars}
 *
 * @param {string} userId  Eternium user identifier (email is also acceptable)
 * @param {object} env     CF Worker env (needs SUPABASE_URL, SUPABASE_SERVICE_KEY)
 * @returns {Promise<{
 *   referral_code: string,
 *   referral_url: string,
 *   commission_rate_pct: number,
 *   created_at: string,
 * }>}
 */
export async function generateReferralCode(userId, env) {
	throw new Error('not yet implemented');
}

// ── Signup attribution ───────────────────────────────────────────────────────

/**
 * Record that a new user signed up via a referral code.
 *
 * Called from handleProvisionKey() when a referral_code is present in the
 * request body. Idempotent — safe to call more than once for the same newUserId.
 *
 * Resolves the referral_code to a referrer_user_id, then inserts a row into
 * affiliate_referrals. Does not grant commission here — commission is granted
 * on first payment (see payment_intent.succeeded webhook handler).
 *
 * @param {string} referralCode  Code from the signup query param (?ref=...)
 * @param {string} newUserId     Eternium user identifier of the newly signed-up user
 * @param {object} env           CF Worker env
 * @returns {Promise<{
 *   attributed: boolean,
 *   referrer_user_id: string|null,
 *   message: string,
 * }>}
 */
export async function attributeSignup(referralCode, newUserId, env) {
	throw new Error('not yet implemented');
}

// ── Commission calculation ───────────────────────────────────────────────────

/**
 * Calculate and record a commission event after a referred user makes a payment.
 *
 * Called from the payment_intent.succeeded webhook handler when the paying user
 * has an affiliate_referrals row whose commission window is still open.
 *
 * Inserts a row into affiliate_commissions with status='pending'. Payout is
 * handled separately (manual MVP; Stripe Connect in a future wave).
 *
 * @param {string} referredUserId       The user who made the purchase
 * @param {string} sourceTransactionId  billing_transactions.id for this purchase
 * @param {number} purchaseAmountUsd    The gross amount of the purchase in USD
 * @param {object} env                  CF Worker env
 * @returns {Promise<{
 *   commission_id: string|null,
 *   commission_amount_usd: number,
 *   referrer_user_id: string|null,
 *   skipped: boolean,
 *   reason?: string,
 * }>}
 */
export async function calculateCommission(referredUserId, sourceTransactionId, purchaseAmountUsd, env) {
	throw new Error('not yet implemented');
}

// ── Affiliate stats ──────────────────────────────────────────────────────────

/**
 * Return aggregated affiliate stats for a user's dashboard.
 *
 * @param {string} userId  Eternium user identifier of the affiliate
 * @param {object} env     CF Worker env
 * @returns {Promise<{
 *   referral_code: string,
 *   referral_url: string,
 *   total_referrals: number,
 *   converting_referrals: number,
 *   total_commission_earned_usd: number,
 *   pending_commission_usd: number,
 *   paid_commission_usd: number,
 *   commission_rate_pct: number,
 *   recent_referrals: Array<{
 *     referred_user_id: string,
 *     attributed_at: string,
 *     first_payment_at: string|null,
 *     commission_earned_usd: number,
 *   }>,
 * }>}
 */
export async function getAffiliateStats(userId, env) {
	throw new Error('not yet implemented');
}

// ── Admin helpers ────────────────────────────────────────────────────────────

/**
 * Return aggregated affiliate overview for the admin panel.
 *
 * @param {object} env  CF Worker env
 * @returns {Promise<{
 *   total_affiliates: number,
 *   total_referrals: number,
 *   total_converting: number,
 *   total_commissions_pending_usd: number,
 *   total_commissions_paid_usd: number,
 *   affiliates: Array<{
 *     user_id: string,
 *     referral_code: string,
 *     referrals: number,
 *     commissions_earned_usd: number,
 *     commissions_pending_usd: number,
 *   }>,
 * }>}
 */
export async function getAdminAffiliateOverview(env) {
	throw new Error('not yet implemented');
}
