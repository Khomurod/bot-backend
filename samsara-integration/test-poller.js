/**
 * test-poller.js
 * Manually fetches the first page of the Samsara API, verifies the endCursor, 
 * and ensures db.js correctly saves the cursor.
 */

require('dotenv').config();
const { getCursor, saveCursor } = require('./src/db');
const poller = require('./src/poller');

const API_KEY = process.env.SAMSARA_API_KEY;

if (!API_KEY) {
    console.error('ERROR: Provide Samsara API key in .env or as argument: node test-poller.js <API_KEY>');
    process.exit(1);
}

async function main() {
    console.log('[Test] --- Database test ---');
    await require('./src/db').init();
    let cursor = getCursor();
    console.log('[Test] Current cursor in DB:', cursor);

    console.log('\n[Test] --- Fetch test ---');
    const startTime = new Date(Date.now() - 3600000).toISOString(); // 1 hour ago
    const params = new URLSearchParams({
        startTime,
        includeDriver: 'true',
        limit: '1',
    });

    const url = `https://api.samsara.com/fleet/safety-events?${params}`;
    console.log(`[Test] Fetching safety events from: ${url}`);

    const apiRes = await fetch(url, {
        headers: {
            'Authorization': `Bearer ${API_KEY}`,
            'Accept': 'application/json',
        },
    });

    if (!apiRes.ok) {
        const body = await apiRes.text();
        console.error(`[Test] API error ${apiRes.status}: ${body}`);
        process.exit(1);
    }

    const json = await apiRes.json();
    const events = json.data || [];
    const nextCursor = json.pagination?.endCursor;

    console.log(`[Test] Found ${events.length} event(s).`);
    console.log(`[Test] Received endCursor: ${nextCursor}`);

    if (nextCursor) {
        await saveCursor(nextCursor);
        const savedCursor = getCursor();
        console.log(`[Test] Read cursor back from DB: ${savedCursor}`);
        if (savedCursor === nextCursor) {
            console.log('✅ Cursor persistence test passed!');
        } else {
            console.error('❌ Cursor persistence test failed! Cursor read from DB does not match what was saved.');
        }
    } else {
        console.warn('⚠️ No endCursor received from Samsara API. Cannot test cursor persistence fully.');
    }

    console.log('\n[Test] Done.');
}

main().catch(err => {
    console.error('[Test] Unexpected error:', err);
    process.exit(1);
});
