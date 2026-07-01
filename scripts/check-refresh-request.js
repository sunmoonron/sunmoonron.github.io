#!/usr/bin/env node
/**
 * check-refresh-request.js
 *
 * Asks the Nostr relays: "has anyone tapped the 🔄 button since the data
 * was last updated?" Writes `refresh=true|false` to $GITHUB_OUTPUT.
 *
 * Zero dependencies — uses Node 22's built-in WebSocket client.
 *
 * Trust model: the request events are unauthenticated on purpose (visitors
 * publish them from throwaway keys). We only use their EXISTENCE + timestamp,
 * never their content — and the data itself always comes straight from the
 * City of Toronto API, so the worst a spammer can do is refresh real data
 * slightly early, bounded by MIN_AGE_HOURS.
 */

const fs = require('fs');
const path = require('path');

const RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.nostr.band'];
const TAG = 'toronto-skate-refresh';
const MIN_AGE_HOURS = Number(process.env.MIN_AGE_HOURS || 12);
const RELAY_TIMEOUT_MS = 8000;

if (typeof WebSocket === 'undefined') {
    console.error('❌ Needs Node >= 22 (built-in WebSocket). Set node-version: 22 in the workflow.');
    process.exit(1);
}

function readLastUpdated() {
    const dataDir = path.join(__dirname, '..', 'skate', 'projects', 'data');
    // Prefer the tiny meta.json; fall back to the big file's metadata
    for (const file of ['meta.json', 'skating-programs.json']) {
        try {
            const parsed = JSON.parse(fs.readFileSync(path.join(dataDir, file), 'utf8'));
            const ts = parsed.lastUpdated || parsed.metadata?.lastUpdated;
            if (ts) return Math.floor(new Date(ts).getTime() / 1000);
        } catch { /* try next */ }
    }
    return 0; // no data yet — any recent request counts
}

function queryRelay(url, filter) {
    return new Promise((resolve) => {
        let settled = false;
        const finish = (hit) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try { ws.close(); } catch {}
            resolve(hit);
        };

        let ws;
        try { ws = new WebSocket(url); } catch { return resolve(null); }
        const timer = setTimeout(() => finish(null), RELAY_TIMEOUT_MS);

        ws.onopen = () => ws.send(JSON.stringify(['REQ', 'skate-refresh-check', filter]));
        ws.onmessage = (e) => {
            try {
                const msg = JSON.parse(e.data);
                if (msg[0] === 'EVENT' && msg[2]) {
                    // Existence + timestamp only — content is untrusted, don't use it
                    finish({ id: msg[2].id, created_at: msg[2].created_at, relay: url });
                } else if (msg[0] === 'EOSE') {
                    finish(null);
                }
            } catch { /* ignore malformed frames */ }
        };
        ws.onerror = () => finish(null);
        ws.onclose = () => finish(null);
    });
}

function setOutput(value) {
    const line = `refresh=${value}\n`;
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, line);
    console.log(`\n➡️  refresh=${value}`);
}

async function main() {
    const lastUpdated = readLastUpdated();
    const ageHours = lastUpdated ? (Date.now() / 1000 - lastUpdated) / 3600 : Infinity;
    console.log(`📅 Data last updated: ${lastUpdated ? new Date(lastUpdated * 1000).toISOString() : 'never'} (${ageHours === Infinity ? '∞' : ageHours.toFixed(1)}h ago)`);

    // Hard floor — makes spam pointless
    if (ageHours < MIN_AGE_HOURS) {
        console.log(`🧊 Data younger than ${MIN_AGE_HOURS}h — ignoring any requests.`);
        return setOutput(false);
    }

    // Only care about requests newer than the data (bounded to the last 7 days)
    const since = Math.max(lastUpdated, Math.floor(Date.now() / 1000) - 7 * 86400);
    const filter = { kinds: [1], '#t': [TAG], since, limit: 10 };

    console.log(`🔍 Querying ${RELAYS.length} relays for #${TAG} since ${new Date(since * 1000).toISOString()}...`);
    const results = await Promise.all(RELAYS.map((r) => queryRelay(r, filter)));
    const hit = results.find(Boolean);

    if (hit) {
        console.log(`🛼 Refresh request found: ${hit.id.slice(0, 12)}… at ${new Date(hit.created_at * 1000).toISOString()} via ${hit.relay}`);
        return setOutput(true);
    }

    console.log('😴 No refresh requests — going back to sleep.');
    setOutput(false);
}

main().catch((err) => {
    console.error('❌', err.message);
    setOutput(false); // fail quiet — the weekly cron is the safety net
});
