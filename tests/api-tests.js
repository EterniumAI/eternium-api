/**
 * Eternium API — Automated Test Suite
 * Pure Node.js, zero dependencies. Runs against live API.
 *
 * Usage:
 *   ETERNIUM_TEST_KEY=etrn_... node tests/api-tests.js
 *   API_BASE=http://localhost:8787 node tests/api-tests.js
 */

const API_BASE = process.env.API_BASE || 'https://api.eternium.ai';
const TEST_KEY = process.env.ETERNIUM_TEST_KEY || '';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';

let passed = 0;
let failed = 0;
let skipped = 0;

async function fetchApi(path, opts = {}) {
    const url = `${API_BASE}${path}`;
    const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(10000) });
    let body;
    try { body = await res.json(); } catch { body = null; }
    return { status: res.status, body };
}

function assert(condition, msg) {
    if (!condition) throw new Error(msg);
}

async function runTest(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`  ${GREEN}PASS${RESET}  ${name}`);
    } catch (err) {
        failed++;
        console.log(`  ${RED}FAIL${RESET}  ${name}`);
        console.log(`        ${DIM}${err.message}${RESET}`);
    }
}

function skipTest(name) {
    skipped++;
    console.log(`  ${YELLOW}SKIP${RESET}  ${name}`);
}

// ── Test Groups ────────────────────────────────────────────────

async function publicEndpoints() {
    console.log(`\n${BOLD}[Public Endpoints]${RESET}`);

    await runTest('GET /health returns 200 with operational status', async () => {
        const { status, body } = await fetchApi('/health');
        assert(status === 200, `Expected 200, got ${status}`);
        assert(body.status === 'operational', `Expected operational, got ${body.status}`);
        assert(body.models > 0, 'Expected models count > 0');
    });

    await runTest('GET /v1/models returns model list', async () => {
        const { status, body } = await fetchApi('/v1/models');
        assert(status === 200, `Expected 200, got ${status}`);
        assert(Array.isArray(body.models), 'Expected models array');
        assert(body.models.length > 0, 'Expected at least 1 model');
        assert(body.models[0].id, 'Expected model to have id');
        assert(body.models[0].type, 'Expected model to have type');
    });

    await runTest('GET /v1/tiers returns tier definitions', async () => {
        const { status, body } = await fetchApi('/v1/tiers');
        assert(status === 200, `Expected 200, got ${status}`);
        assert(body.tiers, 'Expected tiers object');
        assert(body.tiers.free, 'Expected free tier');
        assert(body.tiers.free.monthlyCredits > 0, 'Expected free tier to have credits');
    });

    await runTest('GET /v1/pipelines returns pipeline list', async () => {
        const { status, body } = await fetchApi('/v1/pipelines');
        assert(status === 200, `Expected 200, got ${status}`);
        assert(Array.isArray(body.pipelines), 'Expected pipelines array');
        assert(body.pipelines.length > 0, 'Expected at least 1 pipeline');
    });

    await runTest('GET /v1/docs returns API documentation', async () => {
        const { status, body } = await fetchApi('/v1/docs');
        assert(status === 200, `Expected 200, got ${status}`);
        assert(body.name, 'Expected name field');
        assert(body.endpoints, 'Expected endpoints field');
        assert(body.authentication, 'Expected authentication field');
    });
}

async function authValidation() {
    console.log(`\n${BOLD}[Auth Validation]${RESET}`);

    if (!TEST_KEY) {
        console.log(`  ${YELLOW}WARNING${RESET} ETERNIUM_TEST_KEY not set -- skipping auth tests`);
        for (let i = 0; i < 4; i++) skipTest('(requires ETERNIUM_TEST_KEY)');
        return;
    }

    await runTest('GET /v1/usage rejects missing API key', async () => {
        const { body } = await fetchApi('/v1/usage');
        assert(body.error, 'Expected error response');
        assert(body.error.includes('API key required'), `Expected "API key required", got "${body.error}"`);
    });

    await runTest('GET /v1/usage rejects invalid API key', async () => {
        const { body } = await fetchApi('/v1/usage', {
            headers: { 'X-API-Key': 'etrn_invalid_000000000000' },
        });
        assert(body.error, 'Expected error response');
        assert(body.error.includes('Invalid API key'), `Expected "Invalid API key", got "${body.error}"`);
    });

    await runTest('GET /v1/usage works with X-API-Key header', async () => {
        const { status, body } = await fetchApi('/v1/usage', {
            headers: { 'X-API-Key': TEST_KEY },
        });
        assert(status === 200, `Expected 200, got ${status}`);
        assert(body.email, 'Expected email in response');
        assert(body.name !== undefined, 'Expected name in response');
        assert(body.tier, 'Expected tier in response');
        assert(body.spent !== undefined, 'Expected spent in response');
        assert(body.remaining !== undefined, 'Expected remaining in response');
    });

    await runTest('GET /v1/usage works with Authorization Bearer header', async () => {
        const { status, body } = await fetchApi('/v1/usage', {
            headers: { 'Authorization': `Bearer ${TEST_KEY}` },
        });
        assert(status === 200, `Expected 200, got ${status}`);
        assert(body.email, 'Expected email in response');
    });
}

async function errorHandling() {
    console.log(`\n${BOLD}[Error Handling]${RESET}`);

    if (!TEST_KEY) {
        console.log(`  ${YELLOW}WARNING${RESET} ETERNIUM_TEST_KEY not set -- skipping error tests`);
        for (let i = 0; i < 6; i++) skipTest('(requires ETERNIUM_TEST_KEY)');
        return;
    }

    const authHeaders = { 'X-API-Key': TEST_KEY, 'Content-Type': 'application/json' };

    await runTest('POST /v1/generate rejects missing model', async () => {
        const { body } = await fetchApi('/v1/generate', {
            method: 'POST', headers: authHeaders,
            body: JSON.stringify({ prompt: 'test' }),
        });
        assert(body.error, 'Expected error response');
        assert(body.error.toLowerCase().includes('model') || body.error.toLowerCase().includes('available'),
            `Expected model-related error, got "${body.error}"`);
    });

    await runTest('POST /v1/generate rejects invalid model', async () => {
        const { body } = await fetchApi('/v1/generate', {
            method: 'POST', headers: authHeaders,
            body: JSON.stringify({ model: 'nonexistent-xyz', prompt: 'test' }),
        });
        assert(body.error, 'Expected error response');
    });

    await runTest('POST /v1/generate rejects missing prompt', async () => {
        const { body } = await fetchApi('/v1/generate', {
            method: 'POST', headers: authHeaders,
            body: JSON.stringify({ model: 'nano-banana-2' }),
        });
        assert(body.error, 'Expected error response');
        assert(body.error.toLowerCase().includes('prompt'), `Expected prompt-related error, got "${body.error}"`);
    });

    await runTest('POST /v1/pipelines/run rejects invalid pipeline', async () => {
        const { body } = await fetchApi('/v1/pipelines/run', {
            method: 'POST', headers: authHeaders,
            body: JSON.stringify({ pipeline: 'nonexistent', prompt: 'test' }),
        });
        assert(body.error, 'Expected error response');
        assert(body.error.toLowerCase().includes('pipeline'), `Expected pipeline-related error, got "${body.error}"`);
    });

    await runTest('POST /v1/chat/completions rejects invalid model', async () => {
        const { body } = await fetchApi('/v1/chat/completions', {
            method: 'POST', headers: authHeaders,
            body: JSON.stringify({ model: 'fake-model', messages: [{ role: 'user', content: 'hi' }] }),
        });
        assert(body.error, 'Expected error response');
        assert(typeof body.error === 'string' && body.error.toLowerCase().includes('model'),
            `Expected model-related error, got "${JSON.stringify(body.error)}"`);
    });

    await runTest('POST /v1/generate rejects invalid JSON body', async () => {
        const { body } = await fetchApi('/v1/generate', {
            method: 'POST',
            headers: { 'X-API-Key': TEST_KEY, 'Content-Type': 'application/json' },
            body: 'not valid json',
        });
        assert(body.error, 'Expected error response');
        assert(body.error.includes('Invalid JSON'), `Expected "Invalid JSON", got "${body.error}"`);
    });
}

async function securityTests() {
    console.log(`\n${BOLD}[Security]${RESET}`);

    if (!TEST_KEY) {
        console.log(`  ${YELLOW}WARNING${RESET} ETERNIUM_TEST_KEY not set -- skipping security tests`);
        for (let i = 0; i < 2; i++) skipTest('(requires ETERNIUM_TEST_KEY)');
        return;
    }

    await runTest('GET /admin/overview blocks non-admin key', async () => {
        const { body } = await fetchApi('/admin/overview', {
            headers: { 'X-API-Key': TEST_KEY },
        });
        assert(body.error, 'Expected error response');
        assert(body.error.includes('Admin access required'), `Expected "Admin access required", got "${body.error}"`);
    });

    await runTest('POST /auth/regenerate-key rejects API key as bearer', async () => {
        const { body } = await fetchApi('/auth/regenerate-key', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${TEST_KEY}`, 'Content-Type': 'application/json' },
        });
        assert(body.error, 'Expected error response');
        assert(body.error.includes('Not authenticated'), `Expected "Not authenticated", got "${body.error}"`);
    });
}

// ── Runner ─────────────────────────────────────────────────────

async function main() {
    console.log(`\n${'='.repeat(50)}`);
    console.log(`${BOLD}  Eternium API Test Suite${RESET}`);
    console.log(`  Target: ${API_BASE}`);
    console.log(`  Key:    ${TEST_KEY ? TEST_KEY.slice(0, 8) + '...' + TEST_KEY.slice(-4) : '(not set)'}`);
    console.log(`${'='.repeat(50)}`);

    await publicEndpoints();
    await authValidation();
    await errorHandling();
    await securityTests();

    console.log(`\n${'='.repeat(50)}`);
    const total = passed + failed;
    if (failed > 0) {
        console.log(`  ${RED}${BOLD}FAILED${RESET}: ${passed}/${total} passed, ${RED}${failed} failed${RESET}${skipped ? `, ${skipped} skipped` : ''}`);
    } else {
        console.log(`  ${GREEN}${BOLD}ALL PASSED${RESET}: ${passed}/${total}${skipped ? ` (${skipped} skipped)` : ''}`);
    }
    console.log(`${'='.repeat(50)}\n`);

    process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
    console.error(`${RED}Fatal error: ${err.message}${RESET}`);
    process.exit(1);
});
