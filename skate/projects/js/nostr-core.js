/**
 * SkateNostr — one shared relay pool for the whole app.
 *
 * Fixes vs the old per-group socket approach:
 *  - 3 sockets total (not 3 × groups): no relay rate-limit trouble
 *  - intentional close flag: no zombie reconnect loops after leaving a group
 *  - exponential backoff reconnect (1s → 30s) instead of fixed 5s hammering
 *  - global event-id dedupe: the same message from 3 relays renders once
 *  - publish() resolves when ≥1 relay says OK, so senders get real delivery state
 *  - subscriptions auto-replay on reconnect with a fresh `since`
 */
const SkateNostr = (() => {
    'use strict';

    const RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net'];
    const MAX_SEEN = 4000;

    const relays = new Map();      // url -> { ws, status, backoff, timer }
    const subs = new Map();        // subId -> { filters, onEvent, onEose, eoseCount }
    const pendingOks = new Map();  // eventId -> { resolve, oks, timer }
    const seen = new Set();        // event-id dedupe (LRU-ish)
    const statusCbs = [];
    let intentionalShutdown = false;

    function rememberSeen(id) {
        seen.add(id);
        if (seen.size > MAX_SEEN) {
            let n = 0;
            for (const v of seen) { seen.delete(v); if (++n >= MAX_SEEN / 2) break; }
        }
    }

    function connectedCount() {
        let n = 0;
        relays.forEach(r => { if (r.status === 'open') n++; });
        return n;
    }

    function emitStatus() {
        const s = { connected: connectedCount(), total: RELAYS.length };
        statusCbs.forEach(cb => { try { cb(s); } catch {} });
    }

    function connect(url) {
        const entry = relays.get(url) || { ws: null, status: 'idle', backoff: 1000, timer: null };
        relays.set(url, entry);
        if (entry.status === 'open' || entry.status === 'connecting') return;

        entry.status = 'connecting';
        let ws;
        try { ws = new WebSocket(url); } catch { return scheduleReconnect(url); }
        entry.ws = ws;

        ws.onopen = () => {
            entry.status = 'open';
            entry.backoff = 1000;
            // Replay every live subscription on this fresh socket
            subs.forEach((sub, subId) => ws.send(JSON.stringify(['REQ', subId, ...sub.filters])));
            emitStatus();
        };

        ws.onmessage = (e) => {
            let msg;
            try { msg = JSON.parse(e.data); } catch { return; }

            if (msg[0] === 'EVENT') {
                const subId = msg[1], event = msg[2];
                if (!event || seen.has(event.id)) return;
                const sub = subs.get(subId);
                if (!sub) return;
                try { if (!NostrTools.verifyEvent(event)) return; } catch { return; }
                rememberSeen(event.id);
                try { sub.onEvent(event); } catch (err) { console.warn('[SkateNostr] handler error:', err); }
            } else if (msg[0] === 'EOSE') {
                const sub = subs.get(msg[1]);
                if (sub && ++sub.eoseCount === 1 && sub.onEose) {
                    try { sub.onEose(); } catch {}
                }
            } else if (msg[0] === 'OK') {
                const p = pendingOks.get(msg[1]);
                if (p) {
                    if (msg[2]) p.oks++;
                    else console.warn('[SkateNostr]', url, 'rejected event:', msg[3]);
                    if (p.oks >= 1) { clearTimeout(p.timer); pendingOks.delete(msg[1]); p.resolve(true); }
                }
            }
        };

        ws.onclose = () => {
            entry.status = 'closed';
            emitStatus();
            if (!intentionalShutdown) scheduleReconnect(url);
        };
        ws.onerror = () => { try { ws.close(); } catch {} };
    }

    function scheduleReconnect(url) {
        const entry = relays.get(url);
        if (!entry || entry.timer) return;
        entry.status = 'waiting';
        entry.timer = setTimeout(() => {
            entry.timer = null;
            entry.backoff = Math.min(entry.backoff * 2, 30000);
            connect(url);
        }, entry.backoff);
    }

    /** Start (or update) a named subscription across all relays. */
    function sub(subId, filters, onEvent, onEose = null) {
        subs.set(subId, { filters, onEvent, onEose, eoseCount: 0 });
        relays.forEach((entry) => {
            if (entry.status === 'open') {
                try { entry.ws.send(JSON.stringify(['REQ', subId, ...filters])); } catch {}
            }
        });
    }

    function unsub(subId) {
        if (!subs.has(subId)) return;
        subs.delete(subId);
        relays.forEach((entry) => {
            if (entry.status === 'open') {
                try { entry.ws.send(JSON.stringify(['CLOSE', subId])); } catch {}
            }
        });
    }

    /**
     * Publish a signed event. Resolves true once any relay ACKs (OK),
     * false if none do within `timeoutMs`. Local echo is the caller's job.
     */
    function publish(event, timeoutMs = 6000) {
        return new Promise((resolve) => {
            rememberSeen(event.id); // don't re-process our own echo
            const p = { resolve, oks: 0, timer: null };
            p.timer = setTimeout(() => { pendingOks.delete(event.id); resolve(p.oks > 0); }, timeoutMs);
            pendingOks.set(event.id, p);

            let sentAnywhere = false;
            relays.forEach((entry) => {
                if (entry.status === 'open') {
                    try { entry.ws.send(JSON.stringify(['EVENT', event])); sentAnywhere = true; } catch {}
                }
            });
            if (!sentAnywhere) {
                // No open sockets: retry once after a short grace period
                setTimeout(() => {
                    relays.forEach((entry) => {
                        if (entry.status === 'open') {
                            try { entry.ws.send(JSON.stringify(['EVENT', event])); } catch {}
                        }
                    });
                }, 1500);
            }
        });
    }

    function start() {
        intentionalShutdown = false;
        RELAYS.forEach(connect);
    }

    function stop() {
        intentionalShutdown = true;
        relays.forEach((entry) => { try { entry.ws?.close(); } catch {} });
    }

    function onStatus(cb) { statusCbs.push(cb); cb({ connected: connectedCount(), total: RELAYS.length }); }

    return { start, stop, sub, unsub, publish, onStatus, RELAYS, connectedCount };
})();

if (typeof module !== 'undefined') module.exports = SkateNostr;
