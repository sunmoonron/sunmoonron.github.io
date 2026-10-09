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

    // The site's own relay (strfry on the Dell, behind Cloudflare) sits
    // alongside the public ones. Its write policy admits ONLY this app's
    // kinds, each gated by the same NIP-13 proof-of-work tiers the client
    // mines (moderation.js POW) — unmined events get an OK:false from it,
    // which is harmless: publish() resolves on the first relay that accepts.
    const RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net', 'wss://skate-relay.ronishbhatt.com'];
    const MAX_SEEN = 4000;

    const relays = new Map();      // url -> { ws, status, backoff, timer }
    const subs = new Map();        // subId -> { filters, onEvent, onEose, eoseCount }
    const pendingOks = new Map();  // eventId -> { resolve, oks, timer }
    const seen = new Set();        // event-id dedupe (LRU-ish)
    const statusCbs = [];
    let stopped = false;           // stop(): intentional close, no reconnects until start()

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
            if (!stopped) scheduleReconnect(url);
        };
        ws.onerror = () => { try { ws.close(); } catch {} };
    }

    function scheduleReconnect(url) {
        const entry = relays.get(url);
        if (!entry || entry.timer || stopped) return;
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
        stopped = false;
        RELAYS.forEach(connect);
    }

    /** Close every socket on purpose (community switched off); start() reopens them. */
    function stop() {
        stopped = true;
        relays.forEach((entry) => {
            if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
            entry.status = 'closed';
            try { entry.ws && entry.ws.close(); } catch {}
            entry.ws = null;
        });
        pendingOks.forEach(p => { clearTimeout(p.timer); p.resolve(false); });
        pendingOks.clear();
        emitStatus();
    }

    /** Drop a named subscription on every relay. */
    function unsub(subId) {
        if (!subs.delete(subId)) return;
        relays.forEach((entry) => {
            if (entry.status === 'open') { try { entry.ws.send(JSON.stringify(['CLOSE', subId])); } catch {} }
        });
    }

    /**
     * One-shot query (history paging): events flow to onEvent until the first
     * relay says EOSE or `timeoutMs` passes, then the subscription closes.
     * Resolves the number of events delivered.
     */
    let onceSeq = 0;
    function subOnce(filters, onEvent, timeoutMs = 8000) {
        return new Promise((resolve) => {
            const subId = `once-${++onceSeq}`;
            let n = 0, done = false;
            const finish = () => { if (done) return; done = true; clearTimeout(timer); unsub(subId); resolve(n); };
            const timer = setTimeout(finish, timeoutMs);
            sub(subId, filters, (ev) => { n++; onEvent(ev); }, finish);
        });
    }

    /**
     * Phones freeze sockets in the background and hand back a dead "open"
     * one: ask each open relay for one event and close any that stays silent
     * for 6 s, so the normal reconnect + subscription replay kicks in.
     */
    function checkAlive() {
        relays.forEach((entry, url) => {
            if (entry.status !== 'open' || entry.pingTimer) return;
            const subId = `alive-${Date.now().toString(36)}`;
            let answered = false;
            subs.set(subId, { filters: [{ kinds: [42], limit: 1 }], onEvent: () => {}, onEose: () => { answered = true; }, eoseCount: 0 });
            try { entry.ws.send(JSON.stringify(['REQ', subId, { kinds: [42], limit: 1 }])); } catch { answered = false; }
            entry.pingTimer = setTimeout(() => {
                entry.pingTimer = null;
                subs.delete(subId);
                if (answered) { try { entry.ws.send(JSON.stringify(['CLOSE', subId])); } catch {} return; }
                console.warn('[SkateNostr]', url, 'silent after resume, reconnecting');
                try { entry.ws.close(); } catch {}
            }, 6000);
        });
    }


    function onStatus(cb) { statusCbs.push(cb); cb({ connected: connectedCount(), total: RELAYS.length }); }

    return { start, stop, sub, unsub, subOnce, publish, onStatus, connectedCount, checkAlive, get stopped() { return stopped; } };
})();
if (typeof window !== 'undefined') window.SkateNostr = SkateNostr;

if (typeof module !== 'undefined') module.exports = SkateNostr;
