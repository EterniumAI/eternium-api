/**
 * Eternium API — Safe Deploy Script
 * Runs tests before and after deploy to catch regressions.
 *
 * Usage: npm run deploy
 */

const { execSync } = require('child_process');

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const CYAN = '\x1b[36m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

function run(cmd, label) {
    console.log(`\n${CYAN}${BOLD}>> ${label}${RESET}\n`);
    try {
        execSync(cmd, { stdio: 'inherit' });
        return true;
    } catch {
        return false;
    }
}

async function main() {
    console.log(`\n${'='.repeat(50)}`);
    console.log(`${BOLD}  Eternium API — Safe Deploy${RESET}`);
    console.log(`${'='.repeat(50)}`);

    // Step 1: Pre-deploy tests
    if (!run('node tests/api-tests.js', 'Pre-deploy tests')) {
        console.log(`\n${RED}${BOLD}ABORTED${RESET}: Pre-deploy tests failed. Fix issues before deploying.\n`);
        process.exit(1);
    }

    // Step 2: Deploy
    if (!run('npx wrangler deploy', 'Deploying to Cloudflare')) {
        console.log(`\n${RED}${BOLD}DEPLOY FAILED${RESET}: wrangler deploy returned an error.\n`);
        process.exit(1);
    }

    // Step 3: Wait for propagation
    console.log(`\n${CYAN}>> Waiting 3s for edge propagation...${RESET}`);
    await new Promise(r => setTimeout(r, 3000));

    // Step 4: Post-deploy smoke tests
    if (!run('node tests/api-tests.js', 'Post-deploy smoke tests')) {
        console.log(`\n${RED}${BOLD}WARNING${RESET}: Post-deploy smoke tests FAILED.`);
        console.log(`  The deploy succeeded but something may be broken.`);
        console.log(`  Investigate immediately at https://api.eternium.ai/health\n`);
        process.exit(1);
    }

    console.log(`\n${'='.repeat(50)}`);
    console.log(`  ${GREEN}${BOLD}DEPLOY COMPLETE${RESET} — All tests passing.`);
    console.log(`${'='.repeat(50)}\n`);
}

main();
