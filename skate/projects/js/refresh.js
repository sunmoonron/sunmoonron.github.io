/**
 * SkateRefresh — lets any visitor request a city-data refresh, from a static page.
 *
 * How: publishes a tiny Nostr note tagged #toronto-skate-refresh, signed by a
 * throwaway key generated on the spot (and immediately forgotten). A GitHub
 * Action polls the relays every ~30 min, sees the note, refetches the City of
 * Toronto data, commits, and GitHub Pages redeploys.
 *
 * Why this works on a static page: WebSockets aren't subject to CORS, so the
 * browser can talk to relays freely. No secrets live in this file — the note
 * is just a doorbell, the actual data always comes from the city via CI.
 *
 * Requires: nostr.bundle.js (already loaded for chat) exposing NostrTools.
 */
const SkateRefresh = (() => {
    'use strict';

    const RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.nostr.band']; // same as chat.js
    const TAG = 'toronto-skate-refresh';       // must match scripts/check-refresh-request.js
    const CONFIRM_UNDER_DAYS = 7;              // "refreshed less than a week ago, are u sure :O"
    const META_URL = 'projects/data/meta.json';

    async function dataAgeDays() {
        try {
            const res = await fetch(`${META_URL}?t=${Date.now()}`, { cache: 'no-store' });
            if (!res.ok) return null;
            const meta = await res.json();
            return (Date.now() - new Date(meta.lastUpdated).getTime()) / 86400000;
        } catch {
            return null; // meta.json not deployed yet — skip the confirm gate
        }
    }

    function publishToRelay(url, ev) {
        return new Promise((resolve) => {
            let settled = false;
            const finish = (ok) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                try { ws.close(); } catch {}
                resolve(ok);
            };

            let ws;
            try { ws = new WebSocket(url); } catch { return resolve(false); }
            const timer = setTimeout(() => finish(false), 4000);

            ws.onopen = () => ws.send(JSON.stringify(['EVENT', ev]));
            ws.onmessage = (e) => {
                try {
                    const msg = JSON.parse(e.data);
                    if (msg[0] === 'OK' && msg[1] === ev.id) finish(!!msg[2]);
                } catch { /* ignore */ }
            };
            ws.onerror = () => finish(false);
        });
    }

    function toast(msg, type) {
        if (window.SkateChat?.Notify?.toast) SkateChat.Notify.toast(msg, type, 4000);
        else alert(msg);
    }

    /**
     * Main entry point — wire this to the 🔄 button.
     * Confirms if the data is fresh, then rings the doorbell on the relays.
     */
    async function requestCityRefresh() {
        const age = await dataAgeDays();

        if (age !== null && age < CONFIRM_UNDER_DAYS) {
            const label = age < 1 ? 'today' : `${Math.floor(age)} day${Math.floor(age) === 1 ? '' : 's'} ago`;
            if (!confirm(`Schedule data was refreshed ${label} — still request a fresh pull from the city? :O`)) {
                return false;
            }
        }

        // Throwaway identity: generated, used once, garbage-collected. No accounts.
        const sk = NostrTools.generateSecretKey();
        const ev = NostrTools.finalizeEvent({
            kind: 1,
            created_at: Math.floor(Date.now() / 1000),
            tags: [['t', TAG]],
            content: '🛼 data refresh requested from the Toronto Skating site'
        }, sk);

        const results = await Promise.all(RELAYS.map((r) => publishToRelay(r, ev)));
        const accepted = results.filter(Boolean).length;

        if (accepted > 0) {
            toast(`Refresh queued (${accepted}/${RELAYS.length} relays) — fresh data lands within ~30–45 min ⛸️`, 'success');
            return true;
        }
        toast('Could not reach any relay — try again in a minute', 'error');
        return false;
    }

    return { requestCityRefresh, dataAgeDays };
})();
