// v3.12.3 pipeline: a month posted as a picture (Ford Performance Centre). Finding the picture,
// believing a reading only when every date sits on its weekday, one model call per picture,
// and what the status page is told. Plain Node: the model and the network are stubs.
const { test, expect } = require('@playwright/test');
const fs = require('fs'), os = require('os'), path = require('path');
const { calendarPictures, checkCalendarReading, fetchCalendarImage, readSource, EXTERNAL_SOURCES } = require('../../../fetch-skate-data.js');

const PAGE = fs.readFileSync(path.join(__dirname, 'venues', 'fpc-programs.html'), 'utf8');
const PIC = 'https://www.lakeshorearena.ca/wp-content/uploads/2026/11/November-1.png';
const cfg = EXTERNAL_SOURCES.fordperformance;
const NOV = {          // what the model answered for the real picture on 2026-11-23
    heading: 'November 2026', month: 11, year: 2026,
    events: [7, 14, 21, 28].map(day => ({ day, weekday: 'Saturday', title: 'Free Community Skate Courtesy of Ford', start: '17:15', end: '19:15' })),
    notes: ['Program Fees', 'Public Skating - No Charge Courtesy of Ford Motor Company', 'Children 6 & Under - CSA Approved Helmets Required']
};
const quiet = async (fn) => { const { log, warn } = console; console.log = console.warn = () => {}; try { return await fn(); } finally { console.log = log; console.warn = warn; } };
const tmpStore = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cal-')), 'calendar-readings.json');
/** Stubs: the page, the picture's bytes, and a model that counts its calls. */
function world({ page = PAGE, bytes = Buffer.from('picture-november'), answer = NOV } = {}) {
    const w = { calls: 0 };
    w.deps = {
        get: async () => page,
        getBuf: async () => bytes,
        read: async () => { w.calls++; if (answer instanceof Error) throw answer; return JSON.parse(JSON.stringify(answer)); },
        store: tmpStore()
    };
    return w;
}

test.describe('finding the calendar picture', () => {
    test('on the real page: the full-size picture, not its smaller copies or the partners\' logos', () => {
        expect(calendarPictures(PAGE, cfg.url)).toEqual([PIC]);
    });
    test('relative links, other months, several pictures; at most four', () => {
        const html = '<a href="/wp-content/uploads/2026/12/December-2026.jpg">Dec</a><img src="cal/schedule_jan.webp"><img src="/logo-Mayor.png"><a href="/files/Sept.png">x</a>'
            + Array.from({ length: 6 }, (_, i) => `<img src="/x/march-${i}.png">`).join('');
        expect(calendarPictures(html, 'https://arena.example/programs/')).toEqual([
            'https://arena.example/wp-content/uploads/2026/12/December-2026.jpg', 'https://arena.example/files/Sept.png',
            'https://arena.example/programs/cal/schedule_jan.webp', 'https://arena.example/x/march-0.png']);
    });
    test('nothing on a page without one, nothing from junk, quickly', () => {
        expect(calendarPictures('<p>No calendar this month.</p>', cfg.url)).toEqual([]);
        expect(calendarPictures(null, cfg.url)).toEqual([]);
        const t0 = Date.now();
        expect(calendarPictures('<a href="'.repeat(200000), cfg.url)).toEqual([]);
        expect(calendarPictures('x'.repeat(3000001), cfg.url)).toEqual([]);
        expect(Date.now() - t0).toBeLessThan(1500);
    });
});

test.describe('believing a reading', () => {
    test('the real November picture: four Saturdays, 5:15 to 7:15 pm', () => {
        const r = checkCalendarReading(NOV);
        expect(r.ok).toBe(true);
        expect(r.events.map(e => `${e.date} ${e.start}-${e.end}`)).toEqual(['2026-11-07 17:15-19:15', '2026-11-14 17:15-19:15', '2026-11-21 17:15-19:15', '2026-11-28 17:15-19:15']);
        expect(r.notes).toContain('Children 6 & Under - CSA Approved Helmets Required');
    });
    test('a misread month: the dates no longer sit on their weekday, so nothing is believed', () => {
        expect(checkCalendarReading({ ...NOV, heading: 'December 2026', month: 12 })).toEqual({ ok: false, why: 'December 7, 2026 is a Monday, but it was read under Saturday' });
        expect(checkCalendarReading({ ...NOV, month: 12 }).why).toBe('the heading says November, not December');
        expect(checkCalendarReading({ ...NOV, year: 2027 }).why).toBe('the heading says 2026, not 2027');
        expect(checkCalendarReading({ ...NOV, events: [...NOV.events, { day: 31, weekday: 'Monday', title: 'x', start: '10:00', end: '11:00' }] }).why).toBe('day 31 is not in November');
        expect(checkCalendarReading({ ...NOV, month: 0 }).ok).toBe(false);
        expect(checkCalendarReading(null).ok).toBe(false);
    });
    test('an event with a time that cannot be read is left out, the rest kept', () => {
        const r = checkCalendarReading({ ...NOV, events: [...NOV.events, { day: 7, weekday: 'Saturday', title: 'Stick & Puck', start: '7pm', end: '8:00' }, { day: 14, weekday: 'Saturday', title: '', start: '10:00', end: '11:00' }, { day: 21, weekday: 'Saturday', title: 'Shinny', start: '12:00', end: '11:00' }] });
        expect(r.ok).toBe(true);
        expect(r.events).toHaveLength(4);
    });
});

test.describe('the source', () => {
    test('read once, listed from today on, free; the next run uses the stored reading', async () => {
        const w = world();
        const out = await quiet(() => fetchCalendarImage('fordperformance', cfg, { ...w.deps, today: '2026-11-23' }));
        expect(w.calls).toBe(1);
        expect(out.state).toBe('ok');
        expect(out.note).toBe('Read from its November 2026 calendar picture.');
        expect(out.records.map(r => `${r['Start Date']} ${r['Start Time']}-${r['End Time']} ${r.Activity}`)).toEqual(['2026-11-28 17:15-19:15 Community Skate (Free)']);
        expect(out.records[0]).toMatchObject({ LocationName: 'Ford Performance Centre', Paid: false, Price: 0, Unverified: true });
        const stored = JSON.parse(fs.readFileSync(w.deps.store, 'utf8')).pictures;
        expect(Object.values(stored)).toEqual([expect.objectContaining({ ok: true, url: PIC, month: 11, year: 2026 })]);
        const again = await quiet(() => fetchCalendarImage('fordperformance', cfg, { ...w.deps, today: '2026-11-23' }));
        expect(w.calls).toBe(1);                                        // same bytes: not read again
        expect(again.records).toHaveLength(1);
    });
    test('only the free community skates are listed; the other events on a picture are left out', async () => {
        const w = world({ answer: { ...NOV, events: [...NOV.events, { day: 28, weekday: 'Saturday', title: 'Stick & Puck', start: '12:00', end: '13:00' }, { day: 29, weekday: 'Sunday', title: 'Adult Shinny 18+', start: '21:00', end: '22:30' }] } });
        const out = await quiet(() => fetchCalendarImage('fordperformance', cfg, { ...w.deps, today: '2026-11-23' }));
        expect(out.records.map(r => r.Activity)).toEqual(['Community Skate (Free)']);
    });
    test('December with only November\'s picture up: not open yet, in words', async () => {
        const w = world();
        const out = await quiet(() => fetchCalendarImage('fordperformance', cfg, { ...w.deps, today: '2026-12-02' }));
        expect(out).toEqual({ records: [], state: 'pending', note: 'Its page still shows the November 2026 calendar; the next one is not up yet.' });
    });
    test('a page with no picture is "not posted", not a failure', async () => {
        const w = world({ page: '<h2>MONTHLY DROP-IN CALENDAR</h2><p>Coming soon.</p>' });
        expect(await quiet(() => fetchCalendarImage('fordperformance', cfg, { ...w.deps, today: '2026-11-23' }))).toEqual({ records: [], state: 'pending', note: 'Its page has no calendar picture right now.' });
        expect(w.calls).toBe(0);
    });
    test('a misread is stored, not retried on every run, and tried again after a day', async () => {
        const w = world({ answer: { ...NOV, heading: 'December 2026', month: 12 } });
        const now = Date.parse('2026-11-23T15:00:00Z');
        await expect(quiet(() => fetchCalendarImage('fordperformance', cfg, { ...w.deps, today: '2026-11-23', nowMs: now }))).rejects.toThrow('December 7, 2026 is a Monday');
        await expect(quiet(() => fetchCalendarImage('fordperformance', cfg, { ...w.deps, today: '2026-11-23', nowMs: now + 3600000 }))).rejects.toThrow('is a Monday');
        expect(w.calls).toBe(1);
        await expect(quiet(() => fetchCalendarImage('fordperformance', cfg, { ...w.deps, today: '2026-11-24', nowMs: now + 25 * 3600000 }))).rejects.toThrow('is a Monday');
        expect(w.calls).toBe(2);
    });
    test('no key and no stored reading: a failure the status page can word', async () => {
        const w = world({ answer: new Error('no reader key on this machine (calendar pictures are read on the home server)') });
        const res = await quiet(() => readSource('fordperformance', cfg, {}, '2026-11-23', { fetcher: (k, c) => fetchCalendarImage(k, c, { ...w.deps, today: '2026-11-23' }), salvage: () => [] }));
        expect(res).toMatchObject({ ok: false, state: 'failed', records: [] });
        expect(res.error).toBe('November-1.png: no reader key on this machine (calendar pictures are read on the home server)');
    });
});
