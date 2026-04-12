/**
 * Eternium API — Auth unit tests
 * Tests JWT verification logic (HS256 + RS256) without importing the CF Worker module.
 * Runs in Node.js 22 using the built-in webcrypto API.
 *
 * Usage:
 *   node tests/auth.test.js
 */

'use strict';

const { webcrypto } = require('crypto');
const crypto = webcrypto;

// ── Colors ─────────────────────────────────────────────────────
const GREEN  = '\x1b[32m';
const RED    = '\x1b[31m';
const YELLOW = '\x1b[33m';
const RESET  = '\x1b[0m';
const BOLD   = '\x1b[1m';

let passed = 0, failed = 0;

function ok(label, cond) {
  if (cond) {
    console.log(`  ${GREEN}✓${RESET} ${label}`);
    passed++;
  } else {
    console.log(`  ${RED}✗${RESET} ${label}`);
    failed++;
  }
}

// ── JWT helpers (mirrors auth.js logic exactly) ────────────────

function base64UrlDecode(str) {
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('binary');
}

function base64UrlEncode(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function jsonToB64(obj) {
  return base64UrlEncode(Buffer.from(JSON.stringify(obj)));
}

async function signHS256(payload, secret) {
  const header  = jsonToB64({ alg: 'HS256', typ: 'JWT' });
  const body    = jsonToB64(payload);
  const key = await crypto.subtle.importKey(
    'raw', Buffer.from(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, Buffer.from(`${header}.${body}`));
  return `${header}.${body}.${base64UrlEncode(sig)}`;
}

async function verifyHS256(token, secret, expectedIssuer) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, body, sig] = parts;
    const key = await crypto.subtle.importKey(
      'raw', Buffer.from(secret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
    );
    const sigBytes = Uint8Array.from(base64UrlDecode(sig), c => c.charCodeAt(0));
    const valid = await crypto.subtle.verify('HMAC', key, sigBytes, Buffer.from(`${header}.${body}`));
    if (!valid) return null;
    const payload = JSON.parse(base64UrlDecode(body));
    if (payload.exp !== undefined && payload.exp !== null && payload.exp < Math.floor(Date.now() / 1000)) return null;
    if (!payload.email) return null;
    if (expectedIssuer && payload.iss !== expectedIssuer) return null;
    return payload;
  } catch { return null; }
}

async function generateRS256KeyPair() {
  return crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify']
  );
}

async function signRS256(payload, privateKey, kid = 'test-kid') {
  const header = jsonToB64({ alg: 'RS256', typ: 'JWT', kid });
  const body   = jsonToB64(payload);
  const sig    = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, Buffer.from(`${header}.${body}`));
  return `${header}.${body}.${base64UrlEncode(sig)}`;
}

async function verifyRS256(token, jwks, issuer) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [headerB64, bodyB64, sigB64] = parts;
    const header  = JSON.parse(base64UrlDecode(headerB64));
    const payload = JSON.parse(base64UrlDecode(bodyB64));
    if (header.alg !== 'RS256') return null;
    if (payload.exp !== undefined && payload.exp !== null && payload.exp < Math.floor(Date.now() / 1000)) return null;
    if (!payload.email) return null;
    if (issuer && payload.iss !== issuer) return null;
    const keys = Array.isArray(jwks.keys) ? jwks.keys : jwks;
    const jwk  = header.kid ? (keys.find(k => k.kid === header.kid) || keys[0]) : keys[0];
    if (!jwk) return null;
    const cryptoKey = await crypto.subtle.importKey(
      'jwk', jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']
    );
    const sigBytes = Uint8Array.from(base64UrlDecode(sigB64), c => c.charCodeAt(0));
    const data = Buffer.from(`${headerB64}.${bodyB64}`);
    const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', cryptoKey, sigBytes, data);
    return valid ? payload : null;
  } catch { return null; }
}

// ── Tests ───────────────────────────────────────────────────────

async function testHS256() {
  console.log(`\n${BOLD}HS256 (HMAC) verification${RESET}`);

  const SECRET  = 'test-supabase-secret-for-unit-tests';
  const ISSUER  = 'https://wmahfjguvqvefgjpbcdc.supabase.co/auth/v1';
  const payload = { email: 'ty@eternium.ai', sub: 'uuid-123', iss: ISSUER, exp: Math.floor(Date.now() / 1000) + 3600 };

  const validToken = await signHS256(payload, SECRET);

  // 1. Valid token should verify
  const result = await verifyHS256(validToken, SECRET, ISSUER);
  ok('valid HS256 token returns payload', result !== null && result.email === payload.email);

  // 2. Wrong secret should fail
  const badSecretResult = await verifyHS256(validToken, 'wrong-secret', ISSUER);
  ok('wrong secret returns null', badSecretResult === null);

  // 3. Tampered payload should fail
  const [h, , s] = validToken.split('.');
  const tamperedBody = jsonToB64({ ...payload, email: 'attacker@evil.com' });
  const tampered = `${h}.${tamperedBody}.${s}`;
  const tamperedResult = await verifyHS256(tampered, SECRET, ISSUER);
  ok('tampered payload returns null', tamperedResult === null);

  // 4. Expired token should fail
  const expiredPayload = { ...payload, exp: Math.floor(Date.now() / 1000) - 1 };
  const expiredToken = await signHS256(expiredPayload, SECRET);
  const expiredResult = await verifyHS256(expiredToken, SECRET, ISSUER);
  ok('expired token returns null', expiredResult === null);

  // 5. Wrong issuer should fail
  const wrongIssuerResult = await verifyHS256(validToken, SECRET, 'https://other.supabase.co/auth/v1');
  ok('wrong issuer returns null', wrongIssuerResult === null);

  // 6. Missing email should fail
  const noEmailPayload = { sub: 'uuid-123', iss: ISSUER, exp: Math.floor(Date.now() / 1000) + 3600 };
  const noEmailToken = await signHS256(noEmailPayload, SECRET);
  const noEmailResult = await verifyHS256(noEmailToken, SECRET, ISSUER);
  ok('token without email returns null', noEmailResult === null);

  // 7. Malformed token should fail
  const malformedResult = await verifyHS256('not.a.token.at.all', SECRET, ISSUER);
  ok('malformed token (4 parts) returns null', malformedResult === null);
}

async function testRS256() {
  console.log(`\n${BOLD}RS256 (JWKS) verification${RESET}`);

  const ISSUER  = 'https://wmahfjguvqvefgjpbcdc.supabase.co/auth/v1';
  const KID     = 'test-rsa-key-1';

  // Generate a real RSA key pair for testing
  const { privateKey, publicKey } = await generateRS256KeyPair();
  const publicJwk = await crypto.subtle.exportKey('jwk', publicKey);
  publicJwk.kid = KID;
  const jwks = { keys: [{ ...publicJwk, use: 'sig' }] };

  const payload = { email: 'ty@eternium.ai', sub: 'uuid-456', iss: ISSUER, exp: Math.floor(Date.now() / 1000) + 3600 };
  const validToken = await signRS256(payload, privateKey, KID);

  // 1. Valid RS256 token should verify against matching JWKS
  const result = await verifyRS256(validToken, jwks, ISSUER);
  ok('valid RS256 token verifies against JWKS', result !== null && result.email === payload.email);

  // 2. Token signed by different key should fail
  const { privateKey: otherPrivKey } = await generateRS256KeyPair();
  const wrongKeyToken = await signRS256(payload, otherPrivKey, KID);
  const wrongKeyResult = await verifyRS256(wrongKeyToken, jwks, ISSUER);
  ok('token signed by wrong key returns null', wrongKeyResult === null);

  // 3. Expired RS256 token should fail
  const expiredPayload = { ...payload, exp: Math.floor(Date.now() / 1000) - 1 };
  const expiredToken = await signRS256(expiredPayload, privateKey, KID);
  const expiredResult = await verifyRS256(expiredToken, jwks, ISSUER);
  ok('expired RS256 token returns null', expiredResult === null);

  // 4. Wrong issuer should fail
  const wrongIssuerResult = await verifyRS256(validToken, jwks, 'https://other.supabase.co/auth/v1');
  ok('RS256 with wrong issuer returns null', wrongIssuerResult === null);

  // 5. Empty JWKS should fail
  const emptyJwksResult = await verifyRS256(validToken, { keys: [] }, ISSUER);
  ok('empty JWKS returns null', emptyJwksResult === null);

  // 6. HS256 token should be rejected by RS256 verifier
  const SECRET = 'test-secret';
  const hsPayload = { ...payload, exp: Math.floor(Date.now() / 1000) + 3600 };
  const hsToken = await signHS256(hsPayload, SECRET);
  const hsAsRsResult = await verifyRS256(hsToken, jwks, ISSUER);
  ok('HS256 token rejected by RS256 verifier', hsAsRsResult === null);

  // 7. kid lookup: token with unknown kid falls back to first key
  const fallbackToken = await signRS256(payload, privateKey, 'unknown-kid');
  const fallbackResult = await verifyRS256(fallbackToken, jwks, ISSUER);
  ok('unknown kid falls back to first JWKS key and verifies', fallbackResult !== null);
}

async function testJwksCacheBehavior() {
  console.log(`\n${BOLD}JWKS cache behaviour${RESET}`);

  // The actual fetchJwks function is in the CF Worker module and can't be imported.
  // We verify the cache contract via the module-level description:
  // - JWKS_CACHE_MS = 3_600_000 (1 hour)
  // - Map keyed by issuer, value is { keys, fetchedAt }
  // - Stale check: Date.now() - fetchedAt >= JWKS_CACHE_MS => re-fetch

  const JWKS_CACHE_MS = 3_600_000;
  const cache = new Map();

  function isCacheHit(issuer) {
    const c = cache.get(issuer);
    return c && Date.now() - c.fetchedAt < JWKS_CACHE_MS;
  }

  ok('empty cache is a miss', !isCacheHit('https://example.supabase.co/auth/v1'));

  cache.set('https://example.supabase.co/auth/v1', { keys: [{}], fetchedAt: Date.now() });
  ok('fresh cache entry is a hit', isCacheHit('https://example.supabase.co/auth/v1'));

  cache.set('https://stale.supabase.co/auth/v1', { keys: [{}], fetchedAt: Date.now() - JWKS_CACHE_MS - 1 });
  ok('stale cache entry (> 1 hour) is a miss', !isCacheHit('https://stale.supabase.co/auth/v1'));
}

// ── Runner ──────────────────────────────────────────────────────

async function main() {
  console.log(`${BOLD}Eternium API — auth unit tests${RESET}`);

  await testHS256();
  await testRS256();
  await testJwksCacheBehavior();

  console.log(`\n${BOLD}Results:${RESET} ${GREEN}${passed} passed${RESET}  ${failed > 0 ? RED : ''}${failed} failed${RESET}\n`);
  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
