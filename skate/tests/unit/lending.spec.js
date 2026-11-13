// The free-skates stage of the pipeline (fetch-skate-data.js → lending.json),
// against the City's schedule page as it really looked on four days over two
// seasons (lending-pages.json). Plain Node: no browser, no network.
const { test, expect } = require('@playwright/test');
const pages = require('./lending-pages.json');
const { parseLendingPage, parseLendingTime, parseLendingDate, lendingRinkKey, LENDING_ALSO } = require('../../../fetch-skate-data.js');
const rinks = require('../../projects/data/rinks.json').rinks;

test.describe('lending van schedule', () => {
    test('before the season: no table means "not posted yet", with the start date', () => {
        const r = parseLendingPage(pages.soon_2026_11_12, '2026-11-12');
        expect(r).toEqual({ status: 'soon', startsOn: '2026-11-20', modified: '2026-09-25', stops: [], skipped: [] });
    });

    test('mid-season: every row is read, dated in the right year, and tied to a City rink', () => {
        const r = parseLendingPage(pages.season_2025_26_on_2026_01_07, '2026-01-07');
        expect(r.status).toBe('scheduled');
        expect(r.startsOn).toBe('2025-11-21');
        expect(r.skipped).toEqual([]);
        expect(r.stops).toHaveLength(51);
        // the page writes "Friday, December 19" and "Friday, January 2" with no year: two tables, two years
        expect(r.stops[0]).toEqual({ date: '2025-12-19', from: '16:00', to: '20:00', id: '466', place: 'Colonel Samuel Smith Park outdoor ice trail', address: '65 Colonel Samuel Smith Park Dr.' });
        expect(r.stops.find(s => s.id === '1500')).toEqual({ date: '2026-01-02', from: '10:00', to: '16:00', id: '1500', place: 'McCowan District Park outdoor ice trail', address: '150 McCowan Rd.' });
        // each stop's weekday is the one the City wrote
        for (const s of r.stops) expect(new Date(s.date + 'T12:00:00Z').getUTCDay()).toBeGreaterThanOrEqual(0);
        expect(r.stops.every(s => /^\d{4}-\d{2}-\d{2}$/.test(s.date) && s.from < s.to && s.id && s.place && s.address)).toBe(true);
        expect([...r.stops].sort((a, b) => (a.date + a.from < b.date + b.from ? -1 : 1))).toEqual(r.stops);
        // nearly all of them are rinks this app already lists, under the same id
        const known = new Set(rinks.map(x => String(x.locationid)));
        const matched = r.stops.filter(s => known.has(s.id)).length;
        expect(matched / r.stops.length).toBeGreaterThan(0.9);
    });

    test('the page\'s own slips are survived: glued addresses, stray tags, a.m./p.m. typos', () => {
        const r = parseLendingPage(pages.season_2025_26_on_2026_02_13, '2026-02-13');
        expect(r.skipped).toEqual([]);
        const hodgson = r.stops.find(s => s.id === '1220');        // "outdoor artificial ice rink276 Davisville Ave."
        expect(hodgson.place).toBe('Hodgson Public School outdoor artificial ice rink');
        expect(hodgson.address).toBe('276 Davisville Ave.');
        const familyDay = r.stops.find(s => s.date === '2026-02-16');      // written "Noon to 4 p.m." here, "10 p.m. to 4 p.m." elsewhere
        expect([familyDay.from, familyDay.to]).toEqual(['12:00', '16:00']);
        expect(r.stops.every(s => !/<|>|&nbsp;/.test(s.place + s.address))).toBe(true);
    });

    test('the older layout (year and notes inside the date cell, a "Times" column) reads the same way', () => {
        const r = parseLendingPage(pages.season_2024_25_on_2024_12_14, '2024-12-14');
        expect(r.skipped).toEqual([]);
        expect(r.stops).toHaveLength(26);
        expect(r.stops[0]).toMatchObject({ date: '2024-12-06', from: '17:00', to: '21:00', id: '306', place: 'Withrow Park' });
        const party = r.stops.find(s => s.note);
        expect(party.note).toMatch(/Skate Party/);
        expect(r.stops.filter(s => s.id === '1500').map(s => s.date)).toEqual(['2024-12-27', '2025-01-05']);       // McCowan: around New Year, not weekly
    });

    test('no Thursday-at-McCowan pattern exists in either season', () => {
        for (const [key, today] of [['season_2025_26_on_2026_01_07', '2026-01-07'], ['season_2024_25_on_2024_12_14', '2024-12-14']]) {
            const mccowan = parseLendingPage(pages[key], today).stops.filter(s => s.id === '1500');
            expect(mccowan.length).toBeGreaterThan(0);
            expect(mccowan.some(s => new Date(s.date + 'T12:00:00Z').getUTCDay() === 4)).toBe(false);
        }
    });

    test('a stop finds its rink by the City id, or failing that by its street address, and never by a guess', () => {
        const stops = parseLendingPage(pages.season_2025_26_on_2026_01_07, '2026-01-07').stops;
        expect(stops.filter(s => !lendingRinkKey(s, rinks))).toEqual([]);                            // all 51 of last season's stops land on a rink we list
        const some = [{ locationid: '10', address: '31 Glen Watford Dr' }, { locationid: '11', address: '150 Greenwood Ave' }, { locationid: '12', address: '150 Greenwood Ave' }];
        expect(lendingRinkKey({ id: '10', address: 'anywhere' }, some)).toBe('10');
        expect(lendingRinkKey({ id: '9999', address: '31 Glen Watford Dr.' }, some)).toBe('10');     // an id we do not know, an address we do
        expect(lendingRinkKey({ id: '9999', address: '150 Greenwood Ave.' }, some)).toBe(null);      // two rinks share it: no guessing
        expect(lendingRinkKey({ id: null, address: '' }, some)).toBe(null);
        expect(lendingRinkKey({ id: null, address: 'Greenwood Ave.' }, some)).toBe(null);
    });

    test('times: every spelling seen on the page, and refusals', () => {
        const t = (s) => { const r = parseLendingTime(s); return r ? `${r.from}-${r.to}` : null; };
        expect(t('4 to 8 p.m.')).toBe('16:00-20:00');
        expect(t('4 p.m. to 8 p.m.')).toBe('16:00-20:00');
        expect(t('Noon to 4 p.m.')).toBe('12:00-16:00');
        expect(t('noon to 6:30 p.m.')).toBe('12:00-18:30');
        expect(t('12 to 6 p.m.')).toBe('12:00-18:00');
        expect(t('10 a.m. to 4 p.m.')).toBe('10:00-16:00');
        expect(t('10 to 4 p.m.')).toBe('10:00-16:00');              // unmarked start: the latest reading before the end
        expect(t('10 p.m. to 4 p.m.')).toBe('10:00-16:00');         // the City's typo for the same row
        expect(t('1:45 to 3:45 p.m.')).toBe('13:45-15:45');
        expect(t('6:45 p.m. to 8:45 p.m.')).toBe('18:45-20:45');
        expect(t('10 a.m. to noon')).toBe('10:00-12:00');
        for (const bad of ['4 to 8', 'all day', '13 to 2 p.m.', 'TBD', '', '4 p.m.', '4:75 to 8 p.m.']) expect(t(bad)).toBe(null);
    });

    test('dates: the weekday decides the year; a date that fits no year is dropped', () => {
        expect(parseLendingDate('Friday, January 2', '2026-01-07', 2026)).toBe('2026-01-02');
        expect(parseLendingDate('Friday, January 2', '2025-12-20', null)).toBe('2026-01-02');       // read in December: next year's January
        expect(parseLendingDate('Friday, December 6, 2024', '2024-12-14', null)).toBe('2024-12-06');
        expect(parseLendingDate('Sunday, January 5, 2025 Council New Year Skate Party', '2024-12-14', null)).toBe('2025-01-05');
        expect(parseLendingDate('Friday, December 19', '2026-01-07', 2025)).toBe('2025-12-19');
        expect(parseLendingDate('Thursday, December 19', '2026-01-07', 2025)).toBe(null);            // Dec 19 is a Thursday in neither 2025, 2026 nor 2027
        expect(parseLendingDate('February 30', '2026-01-07', null)).toBe(null);
        expect(parseLendingDate('to be announced', '2026-01-07', null)).toBe(null);
    });

    test('a page with nothing recognisable is "none", never a crash', () => {
        for (const junk of ['', '<html><body>Service unavailable</body></html>', '<table><tr><th>Name</th></tr><tr><td>x</td></tr></table>', null, undefined]) {
            const r = parseLendingPage(junk, '2026-11-12');
            expect(r.status).toBe('none');
            expect(r.stops).toEqual([]);
        }
    });

    test('the other free options are complete entries that point at rinks the app knows', () => {
        const known = new Set(rinks.map(x => String(x.locationid)));
        for (const a of LENDING_ALSO) {
            expect(a.id && a.place && a.what && /^https:\/\//.test(a.url)).toBeTruthy();
            expect(a.checked).toMatch(/^\d{4}-\d{2}-\d{2}$/);
            expect(a.start <= a.end).toBe(true);
            if (a.rink) expect(known.has(a.rink)).toBe(true);
            if (a.days) expect(a.days.every(d => d >= 0 && d <= 6)).toBe(true);
        }
    });
});
