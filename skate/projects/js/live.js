/**
 * SkateLive — live per-session data straight from venue registration
 * systems. Unlike toronto.ca (no CORS → CI snapshots), DaySmart's API
 * sends permissive CORS headers, so "spots left" can be fetched by the
 * BROWSER and be genuinely current — no waiting for the next pipeline run.
 *
 * Data shape per event id: { open, capacity, status } from the
 * event-summaries include (open_slots / composite_capacity /
 * registration_status). Program records carry ExternalId (the venue's
 * event id, written by fetch-skate-data.js) to join on.
 *
 * Fetch discipline: one batched request per source, TTL-throttled to
 * every 5 minutes, only for sessions that haven't ended, capped at 60
 * ids. Failures are silent — the badge simply doesn't render.
 */
window.SkateLive = (() => {
    'use strict';

    const API = 'https://api.daysmartrecreation.com/v1/events';
    // Mirrors EXTERNAL_SOURCES in fetch-skate-data.js (client side only
    // needs to know which Source keys are DaySmart companies).
    const SOURCES = { 'canlan-york': { company: 'canlan' } };

    const TTL_MS = 5 * 60000;

    let byId = {};          // ExternalId(string) → { open, capacity, status }
    let fetchedAt = 0;
    let inFlight = null;
    const listeners = [];

    function onUpdate(cb) { listeners.push(cb); }

    /**
     * Refresh live data for the given programs (TTL-throttled unless
     * `force`). Safe to call often — the ticker and renders do.
     */
    function load(programs, force = false) {
        const now = Date.now();
        if (inFlight) return inFlight;
        if (!force && now - fetchedAt < TTL_MS) return Promise.resolve();

        const bySource = {};
        (programs || []).forEach(p => {
            if (!p.ExternalId || !SOURCES[p.Source]) return;
            const st = window.SkateTime ? window.SkateTime.status(p, now) : { phase: 'upcoming' };
            if (st.phase === 'ended') return;
            (bySource[p.Source] ||= []).push(String(p.ExternalId));
        });
        if (!Object.keys(bySource).length) return Promise.resolve();

        inFlight = (async () => {
            const jobs = Object.entries(bySource).map(async ([key, ids]) => {
                const cfg = SOURCES[key];
                const batch = ids.slice(0, 60);
                const url = `${API}?cache%5Bsave%5D=false&filter%5Bid__in%5D=${batch.join(',')}` +
                    `&include=summary&page%5Bsize%5D=${batch.length}&company=${cfg.company}`;
                const res = await fetch(url, { headers: { Accept: 'application/vnd.api+json' } });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const json = await res.json();
                (json.included || []).forEach(inc => {
                    if (inc.type !== 'event-summaries') return;
                    const a = inc.attributes || {};
                    byId[String(inc.id)] = {
                        open: a.open_slots ?? a.remaining_registration_slots ?? null,
                        capacity: a.composite_capacity ?? null,
                        status: a.registration_status || null
                    };
                });
            });
            try {
                await Promise.all(jobs);
                fetchedAt = Date.now();
                listeners.forEach(cb => { try { cb(); } catch {} });
            } catch (e) {
                console.warn('[SkateLive] live spots fetch failed:', e.message);
            } finally {
                inFlight = null;
            }
        })();
        return inFlight;
    }

    /** Live registration info for a program, or null if none fetched. */
    function forProgram(p) {
        if (!p || p.ExternalId == null) return null;
        return byId[String(p.ExternalId)] || null;
    }

    return { load, forProgram, onUpdate, get fetchedAt() { return fetchedAt; } };
})();

if (typeof module !== 'undefined') module.exports = window.SkateLive;
