// v3.12 pipeline plumbing (fetch-skate-data.js): seasons, per-source states for the
// status page, venue sessions → records, hand-entered hours, the rinks the City lists
// twice, other names, and a City notice a reopened arena has outlived. Plain Node.
const { test, expect } = require('@playwright/test');
const P = require('../../../fetch-skate-data.js');
const { seasonPhase, readSource, sourceMeta, venueRecords, manualRecords, fetchManual, sitemapLastmod, runReader, fetchVenue, stripHtml, foldTwinRinks, markSuperseded, sentenceFrom, rinkSeasonal, EXTERNAL_SOURCES, RINK_AKA } = P;

const NOW = Date.parse('2026-11-21T15:00:00Z');
const quiet = async (fn) => { const { log, warn } = console; console.log = console.warn = () => {}; try { return await fn(); } finally { console.log = log; console.warn = warn; } };

test.describe('seasons', () => {
    const winter = { season: { from: '12-01', to: '03-15', lead: 45 } };
    test('a year-round source has no season', () => {
        expect(seasonPhase({}, '2026-07-04')).toBeNull();
    });
    test('in season on both sides of New Year, with the bounds included', () => {
        for (const d of ['2026-12-01', '2026-12-31', '2027-01-01', '2027-03-15']) expect(seasonPhase(winter, d)).toEqual({ phase: 'in' });
    });
    test('the lead-in starts exactly `lead` days before opening; before that the source sleeps', () => {
        expect(seasonPhase(winter, '2026-10-17')).toEqual({ phase: 'lead', opens: '2026-12-01' });
        expect(seasonPhase(winter, '2026-11-30')).toEqual({ phase: 'lead', opens: '2026-12-01' });
        expect(seasonPhase(winter, '2026-10-16')).toEqual({ phase: 'out', opens: '2026-12-01', resumes: '2026-10-17' });
        expect(seasonPhase(winter, '2027-03-16')).toEqual({ phase: 'out', opens: '2027-12-01', resumes: '2027-10-17' });
    });
    test('a season inside one year (no wrap)', () => {
        const s = { season: { from: '06-01', to: '08-31', lead: 10 } };
        expect(seasonPhase(s, '2026-07-04')).toEqual({ phase: 'in' });
        expect(seasonPhase(s, '2026-05-25')).toEqual({ phase: 'lead', opens: '2026-06-01' });
        expect(seasonPhase(s, '2026-09-01')).toEqual({ phase: 'out', opens: '2027-06-01', resumes: '2027-05-22' });
    });
    test('every configured season is well formed, and every seasonal rink sleeps in July', () => {
        const seasonal = Object.entries(EXTERNAL_SOURCES).filter(([, c]) => c.season);
        expect(seasonal.map(([k]) => k)).toEqual(expect.arrayContaining(['grossman', 'harbourfront', 'bentway', 'evergreen', 'mattamy', 'yzd', 'mississauga-square', 'brampton-outdoor']));
        for (const [key, cfg] of seasonal) {
            expect(cfg.season.from, key).toMatch(/^\d{2}-\d{2}$/);
            expect(cfg.season.to, key).toMatch(/^\d{2}-\d{2}$/);
            expect(seasonPhase(cfg, '2026-07-04').phase, key).toBe('out');
            expect(seasonPhase(cfg, '2027-01-15').phase, key).toBe('in');
        }
    });
});

test.describe('one source, one run', () => {
    const cfg = { kind: 'scrape' };
    const seasonal = { kind: 'venue', season: { from: '12-01', to: '03-15', lead: 45 } };
    const rec = (d) => ({ 'Start Date': d });

    test('a good read: ok, stamped, records kept; an array and an object both work', async () => {
        const a = await quiet(() => readSource('x', cfg, {}, '2026-11-21', { fetcher: async () => [rec('2026-11-22')], nowMs: NOW }));
        expect(a).toEqual({ at: '2026-11-21T15:00:00.000Z', okAt: '2026-11-21T15:00:00.000Z', ok: true, state: 'ok', records: [rec('2026-11-22')] });
        const b = await quiet(() => readSource('x', seasonal, {}, '2026-12-20', { fetcher: async () => ({ records: [], state: 'pending', quote: 'Opens soon.', note: 'Not open yet.', season: { from: '2026-12-26' }, venues: [] }), nowMs: NOW }));
        expect(b).toMatchObject({ ok: true, state: 'pending', quote: 'Opens soon.', note: 'Not open yet.', season: { from: '2026-12-26' } });
        expect(b.venues).toBeUndefined();   // an empty list is not carried
        expect(sourceMeta(b)).toEqual({ ok: true, state: 'pending', count: 0, at: b.at, okAt: b.okAt, note: 'Not open yet.', quote: 'Opens soon.', season: { from: '2026-12-26' } });
    });

    test('out of season: nothing is fetched, nothing fails', async () => {
        let called = 0;
        const r = await quiet(() => readSource('x', seasonal, { okAt: '2026-03-10T00:00:00.000Z' }, '2026-07-04', { fetcher: async () => { called++; return []; }, nowMs: NOW }));
        expect(called).toBe(0);
        expect(r).toEqual({ at: '2026-11-21T15:00:00.000Z', okAt: '2026-03-10T00:00:00.000Z', ok: true, state: 'dormant', records: [], opens: '2026-12-01', resumes: '2026-10-17' });
        expect(sourceMeta(r)).toMatchObject({ ok: true, state: 'dormant', count: 0, resumes: '2026-10-17' });
    });

    test('before the season an empty page is "not posted yet"; in season it is a failure', async () => {
        const empty = async () => { const e = new Error('no schedule rules parsed from page'); e.code = 'EMPTY'; throw e; };
        const lead = await quiet(() => readSource('x', { kind: 'scrape', season: seasonal.season }, {}, '2026-11-01', { fetcher: empty, salvage: () => [], nowMs: NOW }));
        expect(lead).toMatchObject({ ok: true, state: 'pending', records: [], note: 'Nothing is posted for the new season yet.' });
        const inSeason = await quiet(() => readSource('x', { kind: 'scrape', season: seasonal.season }, {}, '2026-12-20', { fetcher: empty, salvage: () => [rec('2026-12-21')], nowMs: NOW }));
        expect(inSeason).toMatchObject({ ok: false, state: 'failed', error: 'no schedule rules parsed from page', records: [rec('2026-12-21')] });
        // a network error in the lead-in is still a failure
        const net = await quiet(() => readSource('x', { kind: 'scrape', season: seasonal.season }, {}, '2026-11-01', { fetcher: async () => { throw new Error('HTTP 503'); }, salvage: () => [], nowMs: NOW }));
        expect(net).toMatchObject({ ok: false, state: 'failed', error: 'HTTP 503' });
    });

    test('a failed read keeps the last good time; a booking feed keeps its sessions, a rink that posts its own hours only for two days', async () => {
        const boom = async () => { throw new Error('HTTP 500 for https://example.test/' + 'x'.repeat(400)); };
        const kept = [rec('2026-11-25')];
        const feed = await quiet(() => readSource('x', { kind: 'perfectmind' }, { okAt: '2026-11-01T00:00:00.000Z' }, '2026-11-21', { fetcher: boom, salvage: () => kept, nowMs: NOW }));
        expect(feed).toMatchObject({ ok: false, state: 'failed', okAt: '2026-11-01T00:00:00.000Z', records: kept });
        expect(feed.error.length).toBeLessThanOrEqual(200);
        const recent = await quiet(() => readSource('x', { kind: 'venue' }, { okAt: '2026-11-20T15:00:00.000Z' }, '2026-11-21', { fetcher: boom, salvage: () => kept, nowMs: NOW }));
        expect(recent.records).toEqual(kept);                    // read fine yesterday: still shown
        const old = await quiet(() => readSource('x', { kind: 'venue' }, { okAt: '2026-11-18T15:00:00.000Z' }, '2026-11-21', { fetcher: boom, salvage: () => kept, nowMs: NOW }));
        expect(old.records).toEqual([]);                         // three days blind: a rink can have closed since
        const never = await quiet(() => readSource('x', { kind: 'manual' }, {}, '2026-11-21', { fetcher: boom, salvage: () => kept, nowMs: NOW }));
        expect(never.records).toEqual([]);
        expect(sourceMeta(old)).toEqual({ ok: false, state: 'failed', count: 0, at: old.at, okAt: '2026-11-18T15:00:00.000Z', error: old.error });
    });

    test('an unknown kind fails cleanly', async () => {
        const r = await quiet(() => readSource('x', { kind: 'nope' }, {}, '2026-11-21', { salvage: () => [], nowMs: NOW }));
        expect(r).toMatchObject({ ok: false, state: 'failed', error: "unknown source kind 'nope'" });
    });
});

test.describe('venue sessions → records', () => {
    const cfg = { activity: 'Public Skating (Free)', locationName: 'The Bentway Skate Trail', address: '250 Fort York Blvd', district: 'Toronto and East York', postalCode: 'M5V 3K9', lat: 43.63, lng: -79.4, paid: false, unverified: true, priceNote: 'Outdoor trail, weather permitting', infoUrl: 'https://thebentway.ca/event/winter-skating/' };
    test('a session becomes a full record; a note leads the price note', () => {
        const { records, unknown } = venueRecords('bentway', cfg, [{ date: '2026-12-12', start: '12:00', end: '21:00', note: 'Free skate rentals this day.' }]);
        expect(unknown).toEqual([]);
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({
            Activity: 'Public Skating (Free)', LocationName: 'The Bentway Skate Trail', 'Location ID': null, Source: 'bentway',
            'Start Date': '2026-12-12', 'Day of Week': 'Saturday', 'Start Time': '12:00', 'End Time': '21:00',
            Paid: false, Price: 0, Unverified: true, ExternalId: null, Lat: 43.63, Lng: -79.4,
            PriceNote: 'Free skate rentals this day. Outdoor trail, weather permitting', InfoUrl: 'https://thebentway.ca/event/winter-skating/'
        });
    });
    test('bad dates and times, backwards ranges and repeats are dropped; ids stay unique', () => {
        const { records } = venueRecords('bentway', cfg, [
            { date: '2026-12-12', start: '12:00', end: '21:00' }, { date: '2026-12-12', start: '12:00', end: '21:00' },
            { date: '2026-12-12', start: '12:00', end: '21:00', activity: 'DJ Skate Night' },
            { date: '2026-12-13', start: '21:00', end: '12:00' }, { date: '12-14', start: '12:00', end: '21:00' }, { date: '2026-12-15', start: '12pm', end: '21:00' }, null
        ]);
        expect(records.map(r => r.Activity)).toEqual(['Public Skating (Free)', 'DJ Skate Night']);
        expect(new Set(records.map(r => r._id)).size).toBe(2);
    });
    test('ages written into a program\'s name become its age bounds', () => {
        const { records } = venueRecords('bentway', cfg, [
            { date: '2026-12-12', start: '08:00', end: '09:50', activity: 'Shinny Drop-In – Ages 18+' },
            { date: '2026-12-12', start: '12:00', end: '13:50', activity: 'Shinny Drop-In – Ages 17 and Under' },
            { date: '2026-12-12', start: '14:00', end: '15:00', activity: 'Public Skate' },
            { date: '2026-12-12', start: '16:00', end: '17:00', activity: 'Adults Skate', ageMin: 19 }
        ]);
        expect(records.map(r => [r['Age Min'], r['Age Max']])).toEqual([[18, null], [null, 17], [null, null], [19, null]]);
    });
    test('a multi-rink page: each row lands on its configured rink; a rink the config does not know is named, not guessed', () => {
        const b = EXTERNAL_SOURCES['brampton-outdoor'];
        const { records, unknown } = venueRecords('brampton-outdoor', b, [
            { date: '2026-12-12', start: '10:00', end: '22:00', venue: 'Chinguacousy Park Skating Recreational Trail' },
            { date: '2026-12-12', start: '10:00', end: '22:00', venue: 'Gage Park Outdoor Skating Recreational Trail' },
            { date: '2026-12-12', start: '12:00', end: '15:00', venue: 'Duggan Park Outdoor Skating Rink' },
            { date: '2026-12-12', start: '09:00', end: '12:00', venue: 'Duggan Park Outdoor Skating Rink', activity: 'Shinny Hockey' },
            { date: '2026-12-12', start: '10:00', end: '22:00', venue: 'Brand New Park Rink' }
        ]);
        expect(unknown).toEqual(['Brand New Park Rink']);
        expect(records.map(r => `${r.LocationName}|${r.Activity}|${r.ExtLocationKey}`)).toEqual([
            'Duggan Park Rink|Shinny Hockey|ext-brampton-outdoor-duggan-park-rink',
            'Chinguacousy Park Skating Trail|Public Skating|ext-brampton-outdoor-chinguacousy-park-skating-trail',
            'Gage Park Skating Trail|Public Skating|ext-brampton-outdoor-gage-park-skating-trail',
            'Duggan Park Rink|Public Skating|ext-brampton-outdoor-duggan-park-rink'
        ]);
        expect(records.every(r => r.District === 'Brampton' && typeof r.Lat === 'number' && typeof r.Lng === 'number')).toBe(true);
        expect(new Set(records.map(r => r._id)).size).toBe(4);
    });
    test('every Brampton row of the page as it reads today finds exactly one configured rink', () => {
        const names = ['Amore Italian Park', 'Boreham Park', 'Bovaird House', 'Carabram Park', 'Chinguacousy Park Skating Recreational Trail', 'Duggan Park Outdoor Skating Rink',
            'Flower City Community Campus Outdoor Skating Rink', 'Gage Park Outdoor Skating Recreational Trail', 'Gore Meadows Covered Outdoor Skating Rink', 'Peel Village Park',
            'Major William Sharpe Park', 'Monkton Circle Park Outdoor Skating Rink', 'Mount Pleasant Outdoor Skating Rink', 'Sandalwood Park NHL-sized Skating Rinks',
            'Sesquicentennial Park Outdoor Skating Rink', 'Treleaven Park'];
        const list = EXTERNAL_SOURCES['brampton-outdoor'].venueList;
        const hits = names.map(n => list.filter(v => v.match.test(n)));
        expect(hits.every(h => h.length === 1)).toBe(true);
        expect(new Set(hits.map(h => h[0].name)).size).toBe(16);
        expect(list).toHaveLength(16);
    });
});

test.describe('hours entered by hand (Coca-Cola Coliseum)', () => {
    const cfg = EXTERNAL_SOURCES.coliseum;
    test('the two December evenings, free, indoor, and nothing else', () => {
        const r = manualRecords('coliseum', cfg, '2026-11-27');
        expect(r.map(x => `${x['Start Date']} ${x['Start Time']}-${x['End Time']} ${x.Paid ? 'paid' : 'free'}`)).toEqual(['2026-12-11 18:00-20:30 free', '2026-12-18 18:00-20:30 free']);
        expect(r[0].LocationName).toBe('Coca-Cola Coliseum');
        expect(cfg.kinds).toEqual(['indoor']);
        expect(manualRecords('coliseum', cfg, '2026-12-19')).toEqual([]);                    // over after the 18th
    });
    test('its page no longer naming those dates lists nothing; the page as read on Nov 27 passes', async () => {
        const gone = await fetchManual('coliseum', cfg, { get: async () => '<p>January 9 &amp; 16</p>', today: '2026-11-27' });
        expect([gone.state, gone.records.length]).toEqual(['changed', 0]);
        const ok = await fetchManual('coliseum', cfg, { get: async () => '<p>🗓️ December 11 &amp; 18<br>🕒 6:o0PM – 8:30PM</p>', today: '2026-11-27' });
        expect([ok.state, ok.records.length]).toEqual(['pending', 2]);
    });
});

test.describe('hours entered by hand (YZD)', () => {
    const cfg = EXTERNAL_SOURCES.yzd;
    const day = (records, d) => records.filter(r => r['Start Date'] === d).map(r => `${r['Start Time']}-${r['End Time']}`);
    test('opening weeks: afternoons, Friday evenings (Christmas Day too: the page names no closure)', () => {
        const r = manualRecords('yzd', { ...cfg, daysAhead: 20 }, '2026-12-15');
        expect(r[0]['Start Date']).toBe('2026-12-19');            // nothing before opening day
        expect(day(r, '2026-12-19')).toEqual(['12:00-17:00']);    // Saturday
        expect(day(r, '2026-12-21')).toEqual(['12:00-17:00']);    // Monday
        expect(day(r, '2026-12-25')).toEqual(['18:00-22:00']);    // a Friday; the page lists no closure that day
        expect(day(r, '2027-01-01')).toEqual(['18:00-22:00']);    // Friday
        expect(day(r, '2027-01-05')).toEqual([]);                 // the holiday closure, Jan 4 to 7
        expect(day(r, '2027-01-03')).toEqual(['12:00-17:00']);
        expect(day(r, '2027-01-04')).toEqual([]);                 // the January break
    });
    test('from January 8: Friday evenings and weekend afternoons only, to February 15', () => {
        const r = manualRecords('yzd', { ...cfg, daysAhead: 60 }, '2027-01-04');
        expect(r[0]['Start Date']).toBe('2027-01-08');
        expect(day(r, '2027-01-08')).toEqual(['18:00-22:00']);
        expect(day(r, '2027-01-09')).toEqual(['12:00-17:00']);
        expect(day(r, '2027-01-11')).toEqual([]);                 // a Monday
        expect(day(r, '2027-02-14')).toEqual(['12:00-17:00']);
        expect(day(r, '2027-02-15')).toEqual([]);                 // Family Day: the page gives no hours, so none are listed
        expect(r[r.length - 1]['Start Date']).toBe('2027-02-14');
        expect(r.every(x => x.LocationName === 'YZD Hangar Skate' && x.Paid === false && x.Unverified === true)).toBe(true);
    });

    // v3.12.1: the hours cannot be read, but the site's page list says when the page was last edited
    const PAGE = '<html><head><title>Hangar Skate | YZD</title></head><body></body></html>';
    const url = (loc, lastmod) => `<url><loc>${loc}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ''}</url>`;
    const sitemap = (mine, others = []) => `<?xml version="1.0" encoding="UTF-8"?><urlset>${url('https://www.yzd.ca/about', '2026-01-05T10:00:00Z')}${mine == null ? '' : url('https://www.yzd.ca/event/hangar-skate', mine)}${others.map((t, i) => url(`https://www.yzd.ca/news/n${i}`, t)).join('')}</urlset>`;
    const site = (map) => async (u) => { if (u === cfg.watch.sitemap) { if (map instanceof Error) throw map; return map; } return PAGE; };
    const run = (map, today = '2026-11-28') => quiet(() => fetchManual('yzd', cfg, { get: site(map), today }));

    test('its sitemap is where the site says it is, and the edit seen at entry is a real moment', () => {
        expect(cfg.watch.sitemap).toBe('https://www.yzd.ca/sitemap.xml');
        expect(Number.isFinite(Date.parse(cfg.watch.seen))).toBe(true);
        expect(cfg.watch.seen.slice(0, 10) <= cfg.enteredOn).toBe(true);      // seen when the hours were typed in, not after
    });
    test('the page not edited since the hours were entered: nothing to say', async () => {
        const r = await run(sitemap(cfg.watch.seen));
        expect(r).toMatchObject({ state: 'pending', manual: '2026-11-23', season: cfg.dates });
        expect(r.edited).toBeUndefined(); expect(r.note).toBeUndefined();
    });
    test('the page edited afterwards: the sessions stay, and the day of the edit is recorded (Toronto time)', async () => {
        const r = await run(sitemap('2026-12-02T03:10:00Z'), '2026-12-20');
        expect(r.edited).toBe('2026-12-01');                                  // 10:10 pm on Dec 1 in Toronto
        expect(r.state).toBe('ok');
        expect(r.records.length).toBeGreaterThan(0);
        const meta = sourceMeta({ ...r, ok: true, at: 'x' });
        expect(meta.edited).toBe('2026-12-01');
    });
    test('the same moment on many pages is the site being republished, not this page being edited', async () => {
        const t = '2026-12-02T15:00:00Z';
        const r = await run(sitemap(t, [t, '2026-12-02T15:00:01Z', t, '2026-12-02T14:59:59Z']));
        expect(r.edited).toBeUndefined();
        expect(r.note).toBe('Its whole site was republished on Dec 2, after these hours were entered.');
        const three = await run(sitemap(t, [t, t, t]));                       // three others: still read as an edit
        expect(three.edited).toBe('2026-12-02');
    });
    test('a page list that cannot be read, or no longer lists the page, never fails the source', async () => {
        for (const map of [new Error('HTTP 503 for https://www.yzd.ca/sitemap.xml'), sitemap(null), sitemap(''), 'not xml at all', '']) {
            const r = await run(map);
            expect(r.state).toBe('pending');
            expect(r.edited).toBeUndefined();
        }
    });
    test('the page gone or about something else still hides the hours, as before', async () => {
        const r = await quiet(() => fetchManual('yzd', cfg, { get: async () => '<title>Page not found | YZD</title>', today: '2026-12-20' }));
        expect(r).toMatchObject({ state: 'changed', records: [], manual: '2026-11-23' });
    });
    test('after the last entered day it is closed; when the next winter comes its hours are "not entered yet"', async () => {
        expect((await run(sitemap(cfg.watch.seen), '2027-02-20')).state).toBe('closed');
        const next = await run(sitemap(cfg.watch.seen), '2027-11-05');
        expect(next).toEqual({ records: [], state: 'pending', note: 'This winter\'s hours have not been entered yet. They are typed in by hand once its site posts them.' });
        const posted = await run(sitemap('2027-11-02T15:00:00Z'), '2027-11-05');      // and the page has been edited: time to enter them
        expect(posted).toMatchObject({ state: 'pending', edited: '2027-11-02', records: [] });
    });
    test('the page list reader: exact page, trailing slash and case, no time, hostile input', () => {
        const map = sitemap('2026-11-20T16:31:10Z', ['2026-11-20T16:31:11Z', '2026-11-10T00:00:00Z']);
        expect(sitemapLastmod(map, 'https://www.yzd.ca/event/hangar-skate')).toEqual({ at: Date.parse('2026-11-20T16:31:10Z'), shared: 1 });
        expect(sitemapLastmod(map, 'https://www.YZD.ca/event/hangar-skate/')).toEqual({ at: Date.parse('2026-11-20T16:31:10Z'), shared: 1 });
        expect(sitemapLastmod(map, 'https://www.yzd.ca/event/hangar-skate-recap')).toBeNull();     // a longer address is another page
        expect(sitemapLastmod(sitemap(''), cfg.watch.url)).toEqual({ at: null, shared: 0 });
        expect(sitemapLastmod(sitemap('not a date'), cfg.watch.url)).toEqual({ at: null, shared: 0 });
        expect(sitemapLastmod(null, cfg.watch.url)).toBeNull();
        const t0 = Date.now();
        expect(sitemapLastmod('<url>'.repeat(200000), cfg.watch.url)).toBeNull();                  // no closing tag: one pass, then stop
        expect(sitemapLastmod('<url><loc>'.repeat(100000) + '</url>', cfg.watch.url)).toBeNull();
        expect(sitemapLastmod('x'.repeat(3000001), cfg.watch.url)).toBeNull();                     // past the size limit: not read
        expect(Date.now() - t0).toBeLessThan(1500);
    });
});

test.describe('rinks the City lists twice', () => {
    const park = (id, name, extra = {}) => ({ locationid: id, name, address: '', postal: '', district: 'Etobicoke York', lat: 43.64, lng: -79.566, kinds: ['outdoor'], pads: 1, operator: 'City of Toronto', source: 'city', fromPrograms: true, ...extra });
    const asset = (id, name, extra = {}) => ({ locationid: id, name, address: '', postal: 'M9C 1E6', district: 'Etobicoke York', lat: 43.641, lng: -79.5665, kinds: ['outdoor'], pads: 2, padsBy: { outdoor: 2 }, operator: '', source: 'city', ...extra });
    const sessions = (id, n = 3) => Array.from({ length: n }, () => ({ 'Location ID': Number(id), Source: 'city' }));

    test('same name, same ice, a short walk apart: one rink, with the pad\'s own coordinates and the park\'s id', () => {
        const out = quietSync(() => foldTwinRinks([asset('817', 'Queensway Park'), park('861', 'Queensway Park')], sessions('861')));
        expect(out).toHaveLength(1);
        expect(out[0]).toMatchObject({ locationid: '861', name: 'Queensway Park', alsoIds: ['817'], pads: 2, lat: 43.641, lng: -79.5665, postal: 'M9C 1E6', kinds: ['outdoor'] });
        expect(out[0].aka).toBeUndefined();
        expect(out[0].padsBy).toBeUndefined();
    });
    test('different names need the table (West Mall Rink is Dennis Flynn Park); the old name becomes an alias', () => {
        const out = quietSync(() => foldTwinRinks([asset('808', 'West Mall Rink'), park('2642', 'Dennis Flynn Park'), asset('900', 'Somewhere Else Rink', { lat: 43.7, lng: -79.3 })], sessions('2642')));
        expect(out.map(r => r.locationid).sort()).toEqual(['2642', '900']);
        expect(out.find(r => r.locationid === '2642')).toMatchObject({ alsoIds: ['808'], aka: ['West Mall Rink'], pads: 2 });
    });
    test('never folded: an asset with sessions of its own, another kind of ice, the same name far away', () => {
        const a = quietSync(() => foldTwinRinks([asset('817', 'Queensway Park'), park('861', 'Queensway Park')], [...sessions('861'), ...sessions('817', 1)]));
        expect(a).toHaveLength(2);
        const b = quietSync(() => foldTwinRinks([asset('913', 'Centennial Park', { kinds: ['indoor'] }), park('798', 'Centennial Park')], sessions('798')));
        expect(b).toHaveLength(2);
        const c = quietSync(() => foldTwinRinks([asset('817', 'Queensway Park', { lat: 43.70, lng: -79.40 }), park('861', 'Queensway Park')], sessions('861')));
        expect(c).toHaveLength(2);
    });
    test('the outdoor pads filed under North Toronto Memorial Arena belong to the community centre next door', () => {
        const arena = { locationid: '3492', name: 'North Toronto Memorial Arena', kinds: ['indoor', 'outdoor'], pads: 3, padsBy: { indoor: 1, outdoor: 2 }, lat: 43.707, lng: -79.4046, source: 'city', operator: 'Arena Board' };
        const centre = park('189', 'North Toronto Memorial Community Centre', { lat: 43.7059, lng: -79.4051 });
        const out = quietSync(() => foldTwinRinks([arena, centre], sessions('189')));
        expect(out.find(r => r.locationid === '3492')).toMatchObject({ kinds: ['indoor'], pads: 1 });
        expect(out.find(r => r.locationid === '189')).toMatchObject({ kinds: ['outdoor'], pads: 2, aka: ['Eglinton Park Rink'] });
    });
    test('other names and the spelling fix are applied; a name is never its own alias', () => {
        const out = quietSync(() => foldTwinRinks([
            asset('223', 'College Park', { pads: 1 }), asset('196', 'Christy Pits Park', { pads: 1 }),
            { locationid: 'ext-mattamy', name: 'Mattamy Athletic Centre', kinds: ['indoor'], pads: 1, source: 'external' },
            asset('87', 'Dufferin Rink', { pads: 1 })
        ], [...sessions('223'), ...sessions('196'), ...sessions('87')]));
        const by = Object.fromEntries(out.map(r => [r.locationid, r]));
        expect(by['223'].aka).toEqual(['Barbara Ann Scott Ice Trail', 'Barbara Ann Scott Skate Trail']);
        expect(by['196']).toMatchObject({ name: 'Christie Pits Park', aka: ['Sid Smith Rink', 'Christie Pits'] });
        expect(by['ext-mattamy'].aka).toEqual(['Maple Leaf Gardens']);
        expect(by['87'].aka).toBeUndefined();                    // "Dufferin Rink" is already its name here
    });
    test('against the published rink list: the eleven doubles go, nothing else does, every alias lands on a rink', () => {
        const rinks = JSON.parse(JSON.stringify(require('../../projects/data/rinks.json').rinks));
        const programs = require('../../projects/data/skating-programs.json').programs;
        if (rinks.some(r => r.alsoIds)) test.skip(true, 'the published list is already folded');
        const before = new Map(rinks.map(r => [String(r.locationid), r.name]));
        const out = quietSync(() => foldTwinRinks(rinks, programs));
        const gone = [...before.keys()].filter(id => !out.some(r => String(r.locationid) === id)).sort();
        expect(gone).toEqual(['1068', '804', '805', '807', '808', '809', '814', '816', '817', '818', '819']);
        for (const id of gone) expect(out.filter(r => (r.alsoIds || []).includes(id))).toHaveLength(1);
        expect(out.find(r => String(r.locationid) === '514')).toMatchObject({ name: 'Earlscourt Park', aka: ['Giovanni Caboto Rink', 'J.J.P. Rink'], alsoIds: ['1068'] });
        const ids = new Set(out.map(r => String(r.locationid)));
        const missing = Object.keys(RINK_AKA).filter(id => !id.startsWith('ext-') && !ids.has(id));
        expect(missing).toEqual([]);
    });
});
function quietSync(fn) { const { log, warn } = console; console.log = console.warn = () => {}; try { return fn(); } finally { console.log = log; console.warn = warn; } }

test.describe('a City notice a reopened arena has outlived', () => {
    const reopened = { '3488': { on: '2026-10-10', notice: /construction|improvements/i, by: 'georgebellarena.com' } };
    const notice = (extra = {}) => ({ LocationID: 3488, Reason: 'Under Construction', Comments: 'George Bell Arena is closed as it undergoes improvements.', PostedDate: '2025-11-05 16:26:36', ...extra });
    test('posted before the reopening and about construction: marked', () => {
        const a = [notice()];
        expect(markSuperseded(a, reopened)).toBe(1);
        expect(a[0].Superseded).toEqual({ on: '2026-10-10', by: 'georgebellarena.com' });
    });
    test('not marked: a newer notice, another reason, another arena, an undated notice; a stale mark is cleared', () => {
        const a = [
            notice({ PostedDate: '2026-11-20 08:00:00' }),
            notice({ Reason: 'Unplanned Closure', Comments: 'Ice plant failure.' }),
            notice({ LocationID: 3490 }),
            notice({ PostedDate: '' }),
            notice({ Superseded: { on: 'x', by: 'y' }, PostedDate: '2026-11-20 08:00:00' })
        ];
        expect(markSuperseded(a, reopened)).toBe(0);
        expect(a.every(x => !('Superseded' in x))).toBe(true);
        expect(markSuperseded([notice()], {})).toBe(0);
    });
    test('the config says which notice George Bell has outlived', () => {
        const g = EXTERNAL_SOURCES.georgebell;
        expect(g.locationId).toBe(3488);
        expect(g.reopened.on).toBe('2026-10-10');
        expect(g.reopened.notice.test('Under Construction George Bell Arena is closed as it undergoes improvements.')).toBe(true);
    });
});

test.describe('a page reader runs on its own thread, with a time limit', () => {
    const modulePath = require('path').join(__dirname, 'slow-reader.js');
    const ctx = { today: '2026-11-21', daysAhead: 14 };
    test('a reader that answers: its reading comes back whole', async () => {
        expect(await runReader('fine', 'hello', ctx, { modulePath })).toEqual({ state: 'open', note: 'read 5 characters for 2026-11-21', sessions: [{ date: '2026-11-21', start: '10:00', end: '11:00' }] });
    });
    test('a reader that never returns, or a pattern that crawls, is stopped and reported; the caller is not held up', async () => {
        for (const [name, body] of [['spin', 'x'], ['crawl', 'a'.repeat(40) + '!']]) {
            const t0 = Date.now();
            const err = await runReader(name, body, ctx, { ms: 400, modulePath }).catch(e => e);
            expect(err).toBeInstanceOf(Error);
            expect(err.code, name).toBe('SLOW');
            expect(err.message).toContain(`'${name}' ran past 0.4 s`);
            expect(Date.now() - t0, name).toBeLessThan(3000);
        }
    });
    test('a reader that throws, a name that does not exist and a page too large all fail cleanly', async () => {
        expect((await runReader('broken', 'x', ctx, { modulePath }).catch(e => e)).message).toContain('boom');
        expect((await runReader('nope', 'x', ctx, { modulePath }).catch(e => e)).message).toContain("no reader 'nope'");
        expect((await runReader('fine', 'x'.repeat(2 * 1024 * 1024 + 1), ctx, { modulePath }).catch(e => e)).message).toContain('page too large');
        expect((await runReader('fine', 'x'.repeat(2 * 1024 * 1024), ctx, { modulePath })).state).toBe('open');
        expect((await runReader('fine', null, ctx, { modulePath }).catch(e => e)).message).toContain('page too large');
    });
    test('the real readers are reachable the same way', async () => {
        const r = await runReader('harbourfront', '<html><body>Not Found</body></html>', ctx);
        expect(r.state).toBe('unknown');
        expect(r.sessions).toEqual([]);
    });
});

test.describe('a venue page is tried twice before it counts as failed', () => {
    const cfg = { kind: 'venue', reader: 'x', url: 'https://example.test/rink', daysAhead: 7, retryMs: 5, activity: 'Public Skating (Free)', locationName: 'Test Rink', address: '1 Test St', district: 'Toronto and East York', lat: 43.65, lng: -79.38, paid: false, unverified: true, infoUrl: 'https://example.test/rink' };
    const good = { state: 'open', note: 'The page says the rink is open.', quote: 'Open daily.', sessions: [{ date: '2026-12-01', start: '10:00', end: '22:00' }] };
    const junk = { state: 'unknown', note: 'The status line was not found.', sessions: [] };
    const run = (answers, readerOverride) => {
        const calls = { get: 0, read: 0 };
        const get = async () => { calls.get++; const a = answers[Math.min(calls.get, answers.length) - 1]; if (a instanceof Error) throw a; return 'page ' + calls.get; };
        const reader = readerOverride || (async () => { calls.read++; return answers[Math.min(calls.read, answers.length) - 1]; });
        return quiet(() => fetchVenue('test', cfg, { get, reader, today: '2026-11-30' }).then(r => ({ r, calls }), e => ({ e, calls })));
    };
    test('one bad answer, then the real page: read, and nothing is reported', async () => {
        const { r, calls } = await run([junk, good]);
        expect(calls).toEqual({ get: 2, read: 2 });
        expect(r).toMatchObject({ state: 'ok', quote: 'Open daily.' });
        expect(r.records.map(x => `${x.LocationName} ${x['Start Date']} ${x['Start Time']}-${x['End Time']}`)).toEqual(['Test Rink 2026-12-01 10:00-22:00']);
    });
    test('a page that does not arrive the first time is fetched again', async () => {
        const calls = { get: 0 };
        const get = async () => { if (++calls.get === 1) throw new Error('HTTP 503 for https://example.test/rink'); return 'page'; };
        const r = await quiet(() => fetchVenue('test', cfg, { get, reader: async () => good, today: '2026-11-30' }));
        expect(calls.get).toBe(2);
        expect(r.state).toBe('ok');
    });
    test('bad twice: the source fails, and says what the reader could not find', async () => {
        const { e, calls } = await run([junk, junk]);
        expect(calls).toEqual({ get: 2, read: 2 });
        expect(e.code).toBe('LAYOUT');
        expect(e.message).toBe('page not understood: The status line was not found.');
    });
    test('a reader that ran out of time is not asked twice', async () => {
        let n = 0;
        const { e } = await run([good], async () => { n++; throw Object.assign(new Error("the page reader 'x' ran past 15 s and was stopped"), { code: 'SLOW' }); });
        expect(n).toBe(1);
        expect(e.code).toBe('SLOW');
    });
    test('not open yet and closed pass through as states, not as failures', async () => {
        for (const state of ['pending', 'closed']) {
            const { r, calls } = await run([{ state, note: 'n', quote: 'q', sessions: [] }]);
            expect(calls.get).toBe(1);
            expect(r).toMatchObject({ state, records: [], quote: 'q' });
        }
    });
});

test.describe('what a seasonal rink says in the rink list', () => {
    const seasonal = { season: { from: '11-01', to: '03-31', lead: 30 } };
    test('a year-round source says nothing; a seasonal one carries its state, dates and the page\'s words', () => {
        expect(rinkSeasonal({}, { state: 'ok' })).toBeNull();
        expect(rinkSeasonal(seasonal, null)).toBeNull();
        expect(rinkSeasonal(seasonal, { state: 'pending', season: { from: '2026-12-12', to: '2027-02-28' }, quote: 'Opens December 12.' }))
            .toEqual({ state: 'pending', from: '2026-12-12', to: '2027-02-28', quote: 'Opens December 12.' });
        expect(rinkSeasonal(seasonal, { state: 'dormant', opens: '2026-11-01' })).toEqual({ state: 'dormant', opens: '2026-11-01' });
    });
    test('on a multi-rink page each rink follows its own row: open, not open yet, out for the season, shut for now', () => {
        const venues = [
            { key: 'a', name: 'A', open: true, status: 'Open', reason: '' },
            { key: 'b', name: 'B', open: false, status: 'Closed', reason: 'Closed for the season' },
            { key: 'c', name: 'C', open: false, status: 'Closed', reason: 'Ice conditions' },
            { key: 'd', name: 'D', status: 'Rink 1 - Open; Rink 2 - Open', open: true, reason: '-' }
        ];
        const before = { state: 'ok', quote: 'Outdoor skating rinks are opening for the season soon! Check operational status below before visiting.', venues };
        expect(rinkSeasonal(seasonal, before, 'a')).toMatchObject({ state: 'ok', quote: 'Open' });
        expect(rinkSeasonal(seasonal, before, 'b')).toMatchObject({ state: 'pending', quote: 'Closed: Closed for the season' });   // "opening soon": not open yet
        expect(rinkSeasonal(seasonal, before, 'c')).toMatchObject({ state: 'shut', quote: 'Closed: Ice conditions' });
        expect(rinkSeasonal(seasonal, before, 'd')).toMatchObject({ state: 'ok', quote: 'Rink 1 - Open; Rink 2 - Open' });
        const spring = { state: 'ok', quote: 'Most outdoor rinks have closed. Check the table.', venues };
        expect(rinkSeasonal(seasonal, spring, 'b')).toMatchObject({ state: 'closed' });
        expect(rinkSeasonal(seasonal, before, 'zzz')).toMatchObject({ state: 'ok' });               // no row for it: the page's own state
    });
});

test('page text never includes what is commented out', () => {
    const html = '<div><!-- <div id="header-tix">Free admission every day!</div> --><div id="header-tix"><strong>The Rink will open when cooler weather permits.</strong></div><!-- Tuesdays: 3pm-4pm --><p>Thursdays: 4pm&ndash;5pm</p></div>';
    expect(stripHtml(html)).toBe('The Rink will open when cooler weather permits. Thursdays: 4pm–5pm');
    expect(stripHtml('<p>kept</p><!-- a comment that never closes: nothing before it is lost')).toContain('kept');
});

test('a quoted sentence starts where the match does and stops at its full stop', () => {
    const text = 'COMMUNITY NEWS Pleasure Skating Ted Reeve does not offer Pleasure Skating times. Looking for skaters';
    expect(sentenceFrom(text, text.indexOf('Ted Reeve does'))).toBe('Ted Reeve does not offer Pleasure Skating times.');
    expect(sentenceFrom('x'.repeat(400), 0).length).toBe(160);
});

test('Canlan: stick & puck, shinny and holiday skates are kept; lessons, training and goalie sign-ups are not', () => {
    const { CANLAN_PROGRAMS, EXTERNAL_SOURCES: X } = P;
    const pick = (label) => CANLAN_PROGRAMS.find(r => r.match.test(label));
    for (const label of ['Stick & Puck', 'Stick & Puck (1.5 hrs)', 'Family Stick & Puck', 'Junior Stick & Puck', 'Shinny', 'Daytime ADULT Shinny', 'Holiday Skate!', 'Public Skating', 'Senior Skate']) expect(pick(label) && !pick(label).skip, label).toBe(true);
    for (const label of ['Stick & Puck Instruction', 'Stick & Puck (TRAINING)', 'Shinny (Goalie Signup)', 'GOALIES only']) expect(pick(label).skip, label).toBe(true);
    expect(['canlan-york', 'canlan-etobicoke', 'canlan-scarborough', 'canlan-oakville', 'canlan-oshawa'].every(k => X[k].programs === CANLAN_PROGRAMS)).toBe(true);
});

test('the City listing one session twice with two end times: the newer listing is kept', () => {
    const { dedupePrograms } = P;
    const base = { Source: 'city', 'Location ID': 77, 'Start Date': '2026-12-31', 'Start Time': '13:15', Activity: 'Shinny: Youth', 'Age Min': 13, 'Age Max': 18, Paid: false, Price: 0 };
    const out = dedupePrograms([{ ...base, _id: 1, Course_ID: 182362, 'End Time': '15:45' }, { ...base, _id: 2, Course_ID: 199067, 'End Time': '14:45' }, { ...base, _id: 3, Course_ID: 5, 'Start Time': '16:00', 'End Time': '17:00' }]);
    expect(out.map(p => p._id)).toEqual([2, 3]);
    const ext = dedupePrograms([{ ...base, Source: 'canlan-york', _id: 4, 'End Time': '15:45' }, { ...base, Source: 'canlan-york', _id: 5, 'End Time': '14:45' }]);
    expect(ext).toHaveLength(2);                                                   // only the City's own listings are folded
});

