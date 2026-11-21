// v3.12.1 pipeline: a failed read is looked at before it is believed. The home server
// is on Wi-Fi that drops for a few seconds several times a day; a run in the middle of
// its sources then "failed" every remaining one in a second. These tests pin what
// happens instead: wait out our own outage, try a second time, and let the last read
// stand when it was this machine that could not get out. Plain Node, no network.
const { test, expect } = require('@playwright/test');
const P = require('../../../fetch-skate-data.js');
const { fetchExternalSources, networkUp, waitForNetwork, settleNetwork, errorText, neverAnswered, sourceSite, keptResult, readSource, sourceMeta } = P;

const NOW = Date.parse('2026-11-21T15:00:00Z');
const quiet = async (fn) => { const { log, warn } = console; console.log = console.warn = () => {}; try { return await fn(); } finally { console.log = log; console.warn = warn; } };
const iso = (ms) => new Date(ms).toISOString();
const ok = (n = 3) => ({ ok: true, state: 'ok', at: iso(NOW), okAt: iso(NOW), records: Array.from({ length: n }, (_, i) => ({ id: i })) });
const failed = (error = 'Timeout for https://example.org/skate', unanswered = true, records = [{ id: 'old' }]) => ({ ok: false, state: 'failed', at: iso(NOW), okAt: iso(NOW - 1800000), error, unanswered, records });
/** A clock the fake sleep moves, so nothing here really waits. */
const clock = (start = NOW) => { let t = start; return { now: () => t, sleep: async (ms) => { t += ms; }, add: (ms) => { t += ms; } }; };
const was = (minutesAgo = 30, extra = {}) => ({ ok: true, state: 'ok', count: 9, at: iso(NOW - minutesAgo * 60000), okAt: iso(NOW - minutesAgo * 60000), ...extra });

test.describe('can this machine get out', () => {
    test('needs a route by address and a working name lookup', async () => {
        const yes = async () => true, no = async () => false;
        expect(await networkUp({ connect: yes, lookup: async () => ({ address: '1.2.3.4' }) })).toBe(true);
        expect(await networkUp({ connect: no, lookup: async () => ({ address: '1.2.3.4' }) })).toBe(false);
        expect(await networkUp({ connect: yes, lookup: async () => { throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }); } })).toBe(false);
    });
    test('one reachable address and one name that resolves are enough', async () => {
        const connect = async (host) => host === '9.9.9.9';
        const lookup = async (name) => { if (name !== 'github.com') throw new Error('no'); return { address: '1.2.3.4' }; };
        expect(await networkUp({ connect, lookup })).toBe(true);
    });
    test('a lookup that throws at once, not as a promise, is still only a "no"', async () => {
        expect(await networkUp({ connect: async () => true, lookup: () => { throw new Error('sync'); } })).toBe(false);
    });
});

test.describe('waiting for the network', () => {
    test('returns as soon as it is back, and spends that time from the run\'s allowance', async () => {
        const c = clock(); let checks = 0;
        const budget = { leftMs: 300000 };
        const back = await quiet(() => waitForNetwork({ up: async () => ++checks >= 3, sleep: c.sleep, now: c.now, budget }));
        expect(back).toBe(true);
        expect(checks).toBe(3);
        expect(c.now() - NOW).toBe(15000);          // three checks, five seconds apart
        expect(budget.leftMs).toBe(285000);
    });
    test('gives up after two minutes', async () => {
        const c = clock(); const budget = { leftMs: 300000 };
        expect(await quiet(() => waitForNetwork({ up: async () => false, sleep: c.sleep, now: c.now, budget }))).toBe(false);
        expect(c.now() - NOW).toBe(120000);
        expect(budget.leftMs).toBe(180000);
    });
    test('a run never waits longer than its allowance in total', async () => {
        const c = clock(); const budget = { leftMs: 20000 };
        expect(await quiet(() => waitForNetwork({ up: async () => false, sleep: c.sleep, now: c.now, budget }))).toBe(false);
        expect(c.now() - NOW).toBe(20000);
        expect(budget.leftMs).toBe(0);
        const before = c.now();
        expect(await quiet(() => waitForNetwork({ up: async () => true, sleep: c.sleep, now: c.now, budget }))).toBe(false);   // nothing left: no waiting at all
        expect(c.now()).toBe(before);
    });
    test('before a stage: online goes straight on, offline waits', async () => {
        let waited = 0;
        expect(await quiet(() => settleNetwork('a stage', { up: async () => true, wait: async () => { waited++; return true; } }))).toBe(true);
        expect(waited).toBe(0);
        expect(await quiet(() => settleNetwork('a stage', { up: async () => false, wait: async () => { waited++; return false; } }))).toBe(false);
        expect(waited).toBe(1);
    });
});

test.describe('every source, one after the other', () => {
    const sources = { a: { url: 'https://a.example/skate' }, b: { url: 'https://b.example/skate' }, c: { url: 'https://c.example/skate' } };

    test('all fine: each is read once, the network is never asked about', async () => {
        const reads = []; let asked = 0;
        const out = await quiet(() => fetchExternalSources({ sources, prev: {}, today: '2026-11-21', read: async (k) => { reads.push(k); return ok(); }, up: async () => { asked++; return true; }, wait: async () => true, ...clock() }));
        expect(reads).toEqual(['a', 'b', 'c']);
        expect(asked).toBe(0);
        expect(Object.values(out).every(r => r.state === 'ok')).toBe(true);
    });

    test('the network drops mid-run and comes back: the source is read again, nothing is marked failed', async () => {
        const reads = []; let online = true, waits = 0;
        const read = async (k) => {
            reads.push(k);
            if (k === 'b' && reads.filter(x => x === 'b').length === 1) { online = false; return failed('getaddrinfo ENOTFOUND b.example'); }
            return online ? ok() : failed('getaddrinfo ENOTFOUND ' + k + '.example');
        };
        const out = await quiet(() => fetchExternalSources({ sources, prev: { b: was() }, today: '2026-11-21', read, up: async () => online, wait: async () => { waits++; online = true; return true; }, ...clock() }));
        expect(reads).toEqual(['a', 'b', 'b', 'c']);      // b twice, c once: after the wait the run carries on as usual
        expect(waits).toBe(1);
        expect(out.a.state).toBe('ok'); expect(out.b.state).toBe('ok'); expect(out.c.state).toBe('ok');
        expect(out.b.kept).toBeUndefined();
    });

    test('one slow answer while the network is fine: a second try at the end, half a minute later at the earliest', async () => {
        const reads = []; const c = clock(); const readAt = {};
        const read = async (k) => { reads.push(k); (readAt[k] = readAt[k] || []).push(c.now()); c.add(2000); return (k === 'c' && readAt.c.length === 1) ? failed() : ok(); };
        const out = await quiet(() => fetchExternalSources({ sources, prev: {}, today: '2026-11-21', read, up: async () => true, wait: async () => true, sleep: c.sleep, now: c.now }));
        expect(reads).toEqual(['a', 'b', 'c', 'c']);
        expect(readAt.c[1] - readAt.c[0]).toBeGreaterThanOrEqual(30000);
        expect(out.c.state).toBe('ok');
    });

    test('an early source that failed is not made to wait again at the end when enough time has passed', async () => {
        const c = clock(); let slept = 0; const n = {};
        const read = async (k) => { n[k] = (n[k] || 0) + 1; c.add(20000); return (k === 'a' && n.a === 1) ? failed() : ok(); };
        await quiet(() => fetchExternalSources({ sources, prev: {}, today: '2026-11-21', read, up: async () => true, wait: async () => true, sleep: async (ms) => { slept += ms; c.add(ms); }, now: c.now }));
        expect(n.a).toBe(2);
        expect(slept).toBe(0);                            // b and c took 40 s between them
    });

    test('failing twice with the network fine is a real failure, with the second try\'s words', async () => {
        const n = {};
        const read = async (k) => { n[k] = (n[k] || 0) + 1; return k === 'b' ? failed(`HTTP 50${n.b} for https://b.example/skate`, false) : ok(); };
        const out = await quiet(() => fetchExternalSources({ sources, prev: { b: was() }, today: '2026-11-21', read, up: async () => true, wait: async () => true, ...clock() }));
        expect(n.b).toBe(2);
        expect(out.b.state).toBe('failed');
        expect(out.b.error).toBe('HTTP 502 for https://b.example/skate');
        expect(out.b.kept).toBeUndefined();
        expect(sourceMeta(out.b)).toMatchObject({ ok: false, state: 'failed', count: 1 });
    });

    test('offline and it does not come back: what the last read said stands, rows and all', async () => {
        const reads = [];
        const read = async (k) => { reads.push(k); return k === 'a' ? ok() : failed('getaddrinfo ENOTFOUND ' + k + '.example', true, [{ id: 'kept-row' }]); };
        const prev = { b: was(30, { note: 'Opens when it is cold enough.' }), c: was(20, { ok: true, state: 'pending', season: { from: '2026-12-05' } }) };
        const out = await quiet(() => fetchExternalSources({ sources, prev, today: '2026-11-21', read, up: async () => reads.length < 2, wait: async () => false, ...clock() }));
        expect(reads).toEqual(['a', 'b', 'c']);           // no second try for a source this machine could not reach
        expect(out.b).toMatchObject({ kept: true, ok: true, state: 'ok', at: prev.b.at, okAt: prev.b.okAt, note: 'Opens when it is cold enough.', records: [{ id: 'kept-row' }] });
        expect(out.c).toMatchObject({ kept: true, state: 'pending', season: { from: '2026-12-05' } });
        expect(out.b.error).toBeUndefined();
        expect(sourceMeta(out.b)).toEqual({ ok: true, state: 'ok', count: 1, at: prev.b.at, okAt: prev.b.okAt, note: 'Opens when it is cold enough.' });
    });

    test('a last read stands in for three hours, no longer; a source never read shows as failed', async () => {
        const read = async (k) => failed('getaddrinfo ENOTFOUND ' + k + '.example');
        const prev = { a: was(179), b: was(181) };                      // c: never read
        const out = await quiet(() => fetchExternalSources({ sources, prev, today: '2026-11-21', read, up: async () => false, wait: async () => false, ...clock() }));
        expect(out.a.kept).toBe(true);
        expect(out.b.state).toBe('failed'); expect(out.b.kept).toBeUndefined();
        expect(out.c.state).toBe('failed');
    });

    test('a source that was already failing stays failed, with its own earlier error', async () => {
        const prev = { a: { ok: false, state: 'failed', count: 2, at: iso(NOW - 1800000), okAt: iso(NOW - 7200000), error: 'HTTP 503 for https://a.example/skate' } };
        const out = await quiet(() => fetchExternalSources({ sources: { a: sources.a }, prev, today: '2026-11-21', read: async () => failed('getaddrinfo ENOTFOUND a.example'), up: async () => false, wait: async () => false, ...clock() }));
        expect(out.a).toMatchObject({ kept: true, ok: false, state: 'failed', error: 'HTTP 503 for https://a.example/skate', at: prev.a.at });
    });

    test('several unrelated sites that never answer, although the network looks fine, is this machine too', async () => {
        const many = { a: { url: 'https://a.example/x' }, b: { url: 'https://www.b-rink.ca/x' }, c: { url: 'https://c.org/x' }, d: { url: 'https://skate.d.net/x' }, e: { url: 'https://e.example/x' } };
        const err = { a: 'getaddrinfo ENOTFOUND a.example', b: 'Timeout for https://www.b-rink.ca/x', c: 'read ETIMEDOUT', d: 'getaddrinfo EAI_AGAIN skate.d.net' };
        const read = async (k) => (k === 'e' ? ok() : failed(err[k]));
        const prev = { a: was(), b: was(), c: was(), d: was() };
        const out = await quiet(() => fetchExternalSources({ sources: many, prev, today: '2026-11-21', read, up: async () => true, wait: async () => true, ...clock() }));
        expect(['a', 'b', 'c', 'd'].map(k => out[k].kept)).toEqual([true, true, true, true]);
        expect(['a', 'b', 'c', 'd'].map(k => out[k].state)).toEqual(['ok', 'ok', 'ok', 'ok']);
        expect(out.e.state).toBe('ok');
    });

    test('one booking service being down for five cities is their outage, not ours', async () => {
        const cities = {};
        ['vaughan', 'brampton', 'oakville', 'burlington', 'markham'].forEach(c => { cities[c] = { url: `https://${c}.perfectmind.com/x` }; });
        const prev = Object.fromEntries(Object.keys(cities).map(k => [k, was()]));
        const out = await quiet(() => fetchExternalSources({ sources: cities, prev, today: '2026-11-21', read: async (k) => failed(`Timeout for POST https://${k}.perfectmind.com/x`), up: async () => true, wait: async () => true, ...clock() }));
        expect(Object.values(out).map(r => r.state)).toEqual(['failed', 'failed', 'failed', 'failed', 'failed']);
        expect(Object.values(out).some(r => r.kept)).toBe(false);
    });

    test('sites that answered with an error are never taken for our own outage', async () => {
        const many = { a: { url: 'https://a.example/x' }, b: { url: 'https://b.example/x' }, c: { url: 'https://c.example/x' }, d: { url: 'https://d.example/x' } };
        const prev = Object.fromEntries(Object.keys(many).map(k => [k, was()]));
        const out = await quiet(() => fetchExternalSources({ sources: many, prev, today: '2026-11-21', read: async (k) => failed(`HTTP 500 for https://${k}.example/x`, false), up: async () => true, wait: async () => true, ...clock() }));
        expect(Object.values(out).map(r => r.state)).toEqual(['failed', 'failed', 'failed', 'failed']);
    });

    test('three silent sources are not enough to blame this machine', async () => {
        const few = { a: { url: 'https://a.example/x' }, b: { url: 'https://b.example/x' }, c: { url: 'https://c.example/x' } };
        const prev = Object.fromEntries(Object.keys(few).map(k => [k, was()]));
        const out = await quiet(() => fetchExternalSources({ sources: few, prev, today: '2026-11-21', read: async (k) => failed(`Timeout for https://${k}.example/x`), up: async () => true, wait: async () => true, ...clock() }));
        expect(Object.values(out).map(r => r.state)).toEqual(['failed', 'failed', 'failed']);
    });
});

test.describe('reading an error', () => {
    test('Node\'s "tried every address" error has no message: its code and inner errors are used', () => {
        const inner = [Object.assign(new Error('connect ETIMEDOUT 142.1.2.3:443'), { code: 'ETIMEDOUT' }), Object.assign(new Error('connect ENETUNREACH 2606::1:443'), { code: 'ENETUNREACH' })];
        const e = Object.assign(new AggregateError(inner, ''), { code: 'ETIMEDOUT' });
        expect(errorText(e)).toBe('ETIMEDOUT: connect ETIMEDOUT 142.1.2.3:443: connect ENETUNREACH 2606::1:443');
        expect(neverAnswered(e)).toBe(true);
        expect(errorText(new Error('HTTP 503 for https://x'))).toBe('HTTP 503 for https://x');
        expect(errorText(null)).toBe('unknown error');
        expect(errorText('plain words')).toBe('plain words');
    });
    test('no answer at all is told apart from an answer that was no use', () => {
        const coded = (code) => Object.assign(new Error(code), { code });
        for (const c of ['ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED']) expect(neverAnswered(coded(c)), c).toBe(true);
        expect(neverAnswered(new Error('Timeout for POST https://x/y'))).toBe(true);
        expect(neverAnswered(new Error('HTTP 500 for https://x/y'))).toBe(false);
        expect(neverAnswered(Object.assign(new Error('nothing posted'), { code: 'EMPTY' }))).toBe(false);
        expect(neverAnswered(new Error('the public skating heading was not found'))).toBe(false);
        expect(neverAnswered(null)).toBe(false);
    });
    test('a source\'s site is its last two name parts, from the error when it names one', () => {
        expect(sourceSite({}, 'getaddrinfo ENOTFOUND vaughan.perfectmind.com')).toBe('perfectmind.com');
        expect(sourceSite({}, 'Timeout for POST https://anc.ca.apm.activecommunities.com/richmondhill/rest')).toBe('activecommunities.com');
        expect(sourceSite({ label: 'x', url: 'https://www.townofws.ca/skating' }, 'read ETIMEDOUT')).toBe('townofws.ca');
        expect(sourceSite({ label: 'no url here' }, 'read ETIMEDOUT')).toBe('');
    });
    test('a failed read says whether the site ever answered', async () => {
        const cfg = { kind: 'x' };
        const silent = await quiet(() => readSource('s', cfg, {}, '2026-11-21', { fetcher: async () => { throw Object.assign(new Error('getaddrinfo ENOTFOUND s.example'), { code: 'ENOTFOUND' }); }, salvage: () => [], nowMs: NOW }));
        expect(silent).toMatchObject({ state: 'failed', unanswered: true, error: 'getaddrinfo ENOTFOUND s.example' });
        const answered = await quiet(() => readSource('s', cfg, {}, '2026-11-21', { fetcher: async () => { throw new Error('HTTP 500 for https://s.example'); }, salvage: () => [], nowMs: NOW }));
        expect(answered).toMatchObject({ state: 'failed', unanswered: false });
        const nameless = await quiet(() => readSource('s', cfg, {}, '2026-11-21', { fetcher: async () => { throw Object.assign(new AggregateError([Object.assign(new Error('connect ETIMEDOUT 1.2.3.4:443'), { code: 'ETIMEDOUT' })], ''), { code: 'ETIMEDOUT' }); }, salvage: () => [], nowMs: NOW }));
        expect(nameless.error).toBe('ETIMEDOUT: connect ETIMEDOUT 1.2.3.4:443');       // was an empty message ("pickering failed:")
        expect(sourceMeta(nameless).unanswered).toBeUndefined();                        // the app's file does not carry it
    });
    test('a kept record carries what the last read recorded and nothing from the failed try', () => {
        const k = keptResult({ ok: true, state: 'closed', count: 0, at: '2026-11-21T14:30:00.000Z', okAt: '2026-11-21T14:30:00.000Z', quote: 'Closed for the season.', season: { from: '2026-12-01', to: '2027-03-01' } }, failed('getaddrinfo ENOTFOUND x', true, []));
        expect(k).toEqual({ records: [], kept: true, ok: true, state: 'closed', at: '2026-11-21T14:30:00.000Z', okAt: '2026-11-21T14:30:00.000Z', quote: 'Closed for the season.', season: { from: '2026-12-01', to: '2027-03-01' } });
        expect(keptResult({ ok: true, count: 4, at: '2026-11-21T14:30:00.000Z' }, failed()).state).toBe('ok');      // a file from before states existed
    });
});
