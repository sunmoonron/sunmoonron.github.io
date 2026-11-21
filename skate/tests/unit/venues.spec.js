// The seasonal venue readers (skate-venues.js) against each venue's own page as it really looked: small excerpts
// cut from copies saved on 2026-11-21 and from web-archive copies of the same pages in and out of season
// (skate/tests/unit/venues/). Inside an excerpt nothing was changed; a "<!-- [cut] -->" line marks markup that was
// left out between two excerpts. Plain Node: no browser, no network.
//
//   harbourfront-2026-11-21 · -2026-01-18 · -2026-07-17   harbourfrontcentre.com/program/skate/: page header and Rink Hours
//   bentway-2026-11-21.json                               thebentway.ca/wp-json/wp/v2/event?slug=winter-skating, cut to the
//                                                         fields the reader uses, its text ending after the hours
//   bentway-2024-09-18.html                               thebentway.ca/event/winter-skating/ off season: the 2023/24 hours text
//   evergreen-2026-11-21 · -2025-12-09 · -2026-07-16      evergreen.ca/evergreen-brick-work/activities/free-public-skate/: banner and dates
//   mattamy-2026-11-21 · -2025-12-04                      mattamyathleticcentre.ca/venue-info/community-skates, and the top of the staff list
//   mississauga-2026-11-21 · -2026-01-15                  mississauga.ca/…/celebration-square/venue-info/: hours block (Square and Ice rink
//                                                         rows), the rink's accordion and the fountain's
//   brampton-outdoor-2026-11-21 · -2026-01-13             brampton.ca/…/Pages/Outdoor-Skating.aspx: the notices above the table, and the table
//   brampton-gore-meadows-2026-11-21                      brampton.ca/…/outdoor-skating-Gore-Meadows-Covered-Outdoor-Skating-Rink.aspx: intro, heading, table
//   georgebell-2026-11-21 · -2025-04-26                   georgebellarena.com/public-skating: the hours block(s)
//   mccormick-2026-11-21 · -2025-26                       mccormickarena.com/page2.html: schedule header and program cards
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const V = require('../../../skate-venues.js');
const { READERS } = V;

const TODAY = '2026-11-21';
const ZERO_WIDTH = String.fromCharCode(0x200b);                    // the pages are full of zero-width spaces; none may reach a reading
const LONG_MS = 180000;                                             // for the few tests that read thousands of pages: seconds of work, minutes on a saturated machine
const fixture = (name) => fs.readFileSync(path.join(__dirname, 'venues', name), 'utf8');
const read = (reader, name, today, daysAhead = 21) => READERS[reader](fixture(name), { today, daysAhead });
const weekday = (date) => new Date(`${date}T12:00:00Z`).getUTCDay();                // 0 = Sunday … 6 = Saturday
const plusDays = (date, n) => new Date(Date.parse(`${date}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const times = (s) => `${s.start}-${s.end}`;
const on = (r, date) => r.sessions.filter((s) => s.date === date);
/** The same page with one piece of its text changed; fails loudly when the piece is not there, so no test passes by accident. */
function swap(text, from, to) {
    const out = text.replace(from, to);
    if (out === text) throw new Error(`nothing to swap: ${String(from).slice(0, 80)}`);
    return out;
}

/** Everything the contract promises about any reading, whatever the page: the list of what is wrong with this one (empty when nothing is). */
function problems(r, today, daysAhead) {
    const wrong = [];
    const need = (ok, what) => { if (!ok) wrong.push(what); };
    const clock = /^([01]\d|2[0-3]):[0-5]\d$/, day = /^\d{4}-\d{2}-\d{2}$/;
    need(['open', 'pending', 'closed', 'unknown'].includes(r.state), `state ${r.state}`);
    need(Object.keys(r).every((k) => ['state', 'note', 'quote', 'season', 'sessions', 'venues'].includes(k)), `keys ${Object.keys(r)}`);
    need(typeof r.note === 'string' && r.note.length > 0 && r.note.length <= 200, `note ${r.note}`);
    need(r.quote === undefined || (typeof r.quote === 'string' && r.quote.length > 0 && r.quote.length <= 160), `quote ${r.quote}`);
    need(!r.season || (Object.keys(r.season).length > 0 && Object.entries(r.season).every(([k, d]) => ['from', 'to'].includes(k) && day.test(d))), `season ${JSON.stringify(r.season)}`);
    need(Array.isArray(r.sessions), 'sessions is not a list');
    need(r.state !== 'unknown' || r.sessions.length === 0, 'unknown with sessions');
    const last = plusDays(today, daysAhead);
    let before = '';
    for (const s of r.sessions || []) {
        const where = JSON.stringify(s);
        need(Object.keys(s).every((k) => ['date', 'start', 'end', 'activity', 'venue', 'note'].includes(k)), `keys of ${where}`);
        need(day.test(s.date) && s.date >= today && s.date <= last, `outside the window: ${where}`);
        need(clock.test(s.start) && clock.test(s.end) && s.start < s.end, `times of ${where}`);
        need(['activity', 'venue', 'note'].every((k) => s[k] === undefined || (typeof s[k] === 'string' && s[k].length > 0)), `texts of ${where}`);
        need(`${s.date} ${s.start}` >= before, `out of order: ${where}`);
        before = `${s.date} ${s.start}`;
    }
    return wrong;
}
const expectWellFormed = (r, today, daysAhead) => expect(problems(r, today, daysAhead)).toEqual([]);

/* ---------------------------------------------------------------- Harbourfront Centre ---------------------------------------------------------------- */

test.describe('harbourfront', () => {
    test('today: not open yet, and the hours table that is already on the page produces nothing', () => {
        const r = read('harbourfront', 'harbourfront-2026-11-21.html', TODAY);
        expect(r.state).toBe('pending');
        expect(r.quote).toBe('The Rink will open for the season when cooler weather permits. Keep an eye on this page and we’ll let you know!');
        expect(r.season).toBeUndefined();                           // the header says only "Winter 2026/27"
        expect(r.sessions).toEqual([]);
        expect(fixture('harbourfront-2026-11-21.html')).toContain('<table class="rink-hours-table');
    });

    test('the commented-out status lines are never read', () => {
        const page = fixture('harbourfront-2026-11-21.html');
        expect(page).toContain('<!-- <div id="header-tix"');
        expect(page).toContain('The rink opens November 20');       // a superseded opening date, inside a comment
        expect(page).toContain('<strong>Free admission every day</strong>');        // the "open" wording, inside a comment
        expect(page).toContain('<!-- <p>The skating rink is closed for the season.');   // and a "closed" one beside the hours table
        const r = READERS.harbourfront(page, { today: TODAY, daysAhead: 21 });
        expect(JSON.stringify(r)).not.toMatch(/November 20|Free admission|closed for the season/);
        // take the one visible line away and nothing is left to read: the comments do not stand in for it
        const blind = swap(page, /<div id="header-tix"[^>]*><strong>The Rink will open[\s\S]*?<\/div>/, '');
        const none = READERS.harbourfront(blind, { today: TODAY, daysAhead: 21 });
        expect(none.state).toBe('unknown');
        expect(none.sessions).toEqual([]);
    });

    test('in season: open, one session a day with that weekday\'s hours', () => {
        const r = read('harbourfront', 'harbourfront-2026-01-18.html', '2026-01-18', 6);
        expect(r.state).toBe('open');
        expect(r.quote).toBe('Free admission every day!');
        expect(r.season).toEqual({ from: '2025-11-28', to: '2026-03-01' });
        expect(r.sessions).toEqual([
            { date: '2026-01-18', start: '10:00', end: '22:00' },       // Sunday
            { date: '2026-01-19', start: '10:00', end: '22:00' },
            { date: '2026-01-20', start: '10:00', end: '22:00' },
            { date: '2026-01-21', start: '10:00', end: '22:00' },
            { date: '2026-01-22', start: '10:00', end: '22:00' },
            { date: '2026-01-23', start: '10:00', end: '23:00' },       // Friday
            { date: '2026-01-24', start: '10:00', end: '23:00' }        // Saturday
        ]);
        const month = read('harbourfront', 'harbourfront-2026-01-18.html', '2026-01-18', 21);
        expect(month.sessions).toHaveLength(22);
        for (const s of month.sessions) expect(s.end).toBe([5, 6].includes(weekday(s.date)) ? '23:00' : '22:00');
    });

    test('the season the page gives bounds everything: nothing after its last day, pending before its first', () => {
        const late = read('harbourfront', 'harbourfront-2026-01-18.html', '2026-02-25', 21);
        expect(late.state).toBe('open');
        expect(late.sessions.map((s) => s.date)).toEqual(['2026-02-25', '2026-02-26', '2026-02-27', '2026-02-28', '2026-03-01']);
        const after = read('harbourfront', 'harbourfront-2026-01-18.html', '2026-03-02');
        expect([after.state, after.sessions.length]).toEqual(['closed', 0]);
        const before = read('harbourfront', 'harbourfront-2026-01-18.html', '2025-11-20');
        expect([before.state, before.sessions.length]).toEqual(['pending', 0]);
    });

    test('off season: closed, no sessions', () => {
        const r = read('harbourfront', 'harbourfront-2026-07-17.html', '2026-07-17');
        expect(r.state).toBe('closed');
        expect(r.quote).toBe('The rink is closed for the season. Thanks for joining us!');
        expect(r.sessions).toEqual([]);
    });

    test('only a positive statement opens the rink; "open" without readable hours is unknown', () => {
        const open = fixture('harbourfront-2026-01-18.html');
        const says = (line) => READERS.harbourfront(swap(open, '<strong>Free admission every day!</strong>', `<strong>${line}</strong>`), { today: '2026-01-18', daysAhead: 6 });
        for (const line of ['The rink reopens Friday.', 'The rink is closed today due to weather.', 'Opening day is November 27!']) {
            expect([line, says(line).state, says(line).sessions.length]).toEqual([line, 'pending', 0]);
        }
        expect([says('Skate rentals available').state, says('Skate rentals available').sessions.length]).toEqual(['unknown', 0]);
        expect(says('The rink is now open!').state).toBe('open');
        const noTable = READERS.harbourfront(swap(open, /<table class="rink-hours-table[\s\S]*?<\/table>/, ''), { today: '2026-01-18', daysAhead: 6 });
        expect([noTable.state, noTable.sessions.length]).toEqual(['unknown', 0]);
        const badRow = READERS.harbourfront(swap(open, '>10:00am – 11:00pm</td>', '>TBA</td>'), { today: '2026-01-18', daysAhead: 6 });
        expect([badRow.state, badRow.sessions.length]).toEqual(['unknown', 0]);
        // an "open" page with no season dates, read in July: a stale page, not a rink
        const july = READERS.harbourfront(swap(open, /Fri, Nov 28, 2025 <span[^>]*>&#8593;<\/span> Sun, Mar 1, 2026/, 'Winter'), { today: '2026-07-10', daysAhead: 6 });
        expect([july.state, july.sessions.length]).toEqual(['unknown', 0]);
    });
});

/* ---------------------------------------------------------------- The Bentway ---------------------------------------------------------------- */

test.describe('bentway', () => {
    const body = () => fixture('bentway-2026-11-21.json');
    const withText = (change) => { const data = JSON.parse(body()); data[0].content.rendered = change(data[0].content.rendered); return JSON.stringify(data); };
    /** The archive has the 2023/24 page, not its JSON: the test wraps the page's own hours text in the event envelope. */
    const season2324 = () => JSON.stringify([{ slug: 'winter-skating', acf: { start_date: 'December 16, 2023', end_date: 'February 19, 2024' }, content: { rendered: fixture('bentway-2024-09-18.html') } }]);

    test('today: pending, with the season from the event and the first day at the edge of the window', () => {
        const r = READERS.bentway(body(), { today: TODAY, daysAhead: 21 });
        expect(r.state).toBe('pending');
        expect(r.season).toEqual({ from: '2026-12-12', to: '2027-02-28' });
        expect(r.quote).toBe('From December 12, 2026 through February 28, 2027, lace up and cruise The Bentway’s 220m figure-eight trail.');
        expect(r.sessions).toEqual([{ date: '2026-12-12', start: '12:00', end: '21:00' }]);
        expect(READERS.bentway(body(), { today: TODAY, daysAhead: 20 }).sessions).toEqual([]);
        // the API answers ?slug= with an array; a single object reads the same
        expect(READERS.bentway(JSON.stringify(JSON.parse(body())[0]), { today: TODAY, daysAhead: 21 })).toEqual(r);
    });

    test('in season: "Daily" over the holidays, then weekday evenings and weekend afternoons', () => {
        const r = READERS.bentway(body(), { today: '2026-12-20', daysAhead: 21 });
        expect(r.state).toBe('open');
        expect(r.sessions).toHaveLength(22);
        for (const s of r.sessions) {
            const weekend = [0, 6].includes(weekday(s.date));
            expect([s.date, times(s)]).toEqual([s.date, s.date <= '2027-01-03' || weekend ? '12:00-21:00' : '17:00-21:00']);
        }
        expect(on(r, '2027-01-04')).toEqual([{ date: '2027-01-04', start: '17:00', end: '21:00' }]);         // a Monday
        expect(on(r, '2026-12-27')[0].note).toBe('Polar Bear Skate: Event at 12:00pm, trail open until 9:00pm');
        const end = READERS.bentway(body(), { today: '2027-02-27', daysAhead: 10 });
        expect(end.sessions.map((s) => s.date)).toEqual(['2027-02-27', '2027-02-28']);
    });

    test('a dated row replaces the weekday hours on its date; nobody guesses the holidays', () => {
        const r = READERS.bentway(body(), { today: '2027-01-11', daysAhead: 6 });
        expect(r.sessions.map((s) => `${s.date} ${times(s)}`)).toEqual([
            '2027-01-11 17:00-21:00', '2027-01-12 17:00-21:00', '2027-01-13 17:00-21:00', '2027-01-14 17:00-21:00',
            '2027-01-15 12:00-21:00',                                    // "Friday, January 15, TDSB PA Day"
            '2027-01-16 12:00-21:00', '2027-01-17 12:00-21:00'
        ]);
        expect(weekday('2027-01-15')).toBe(5);
        expect(on(r, '2027-01-15')[0].note).toBe('TDSB PA Day');
        const feb = READERS.bentway(body(), { today: '2027-02-15', daysAhead: 1 });
        expect(feb.sessions).toEqual([
            { date: '2027-02-15', start: '12:00', end: '21:00', note: 'Family Day' },       // a Monday, by its own row
            { date: '2027-02-16', start: '17:00', end: '21:00' }
        ]);
        // the same row under the wrong weekday is a row left over from another year: that date is dropped, not guessed
        const stale = READERS.bentway(withText((t) => swap(t, 'Friday, January 15, TDSB PA Day', 'Thursday, January 15, TDSB PA Day')), { today: '2027-01-14', daysAhead: 2 });
        expect(stale.sessions.map((s) => s.date)).toEqual(['2027-01-14', '2027-01-16']);
    });

    test('the row about rentals never becomes a session', () => {
        expect(JSON.parse(body())[0].content.rendered).toContain('<td>Monday to Wednesday</td><td>Skate Rentals and Concessions');
        const week = (text) => READERS.bentway(text, { today: '2027-01-18', daysAhead: 6 }).sessions.map((s) => `${s.date} ${times(s)}`);
        const expected = ['2027-01-18 17:00-21:00', '2027-01-19 17:00-21:00', '2027-01-20 17:00-21:00', '2027-01-21 17:00-21:00', '2027-01-22 17:00-21:00', '2027-01-23 12:00-21:00', '2027-01-24 12:00-21:00'];
        expect(week(body())).toEqual(expected);
        // even if that row carried a time of its own
        const timed = withText((t) => swap(t, 'Skate Rentals and Concessions <strong><em>not available</em></strong>.', 'Skate Rentals 5:00pm &#8211; 8:00pm'));
        expect(week(timed)).toEqual(expected);
    });

    test('after the season: closed, no sessions, whatever the text still says', () => {
        const r = READERS.bentway(body(), { today: '2027-03-01', daysAhead: 21 });
        expect([r.state, r.sessions.length]).toEqual(['closed', 0]);
        expect(JSON.parse(body())[0].content.rendered).toContain('The Skate Trail opens December 12!');
    });

    test('the 2023/24 page: closed when read off season, and its older layout reads the same way in season', () => {
        const off = READERS.bentway(season2324(), { today: '2024-09-18', daysAhead: 21 });
        expect([off.state, off.sessions.length]).toEqual(['closed', 0]);
        expect(off.season).toEqual({ from: '2023-12-16', to: '2024-02-19' });
        const newYear = READERS.bentway(season2324(), { today: '2023-12-30', daysAhead: 3 });
        expect(newYear.state).toBe('open');
        expect(newYear.sessions).toEqual([
            { date: '2023-12-30', start: '12:00', end: '21:00' },
            { date: '2023-12-31', start: '12:00', end: '21:00', note: 'Polar Bear Skate' },      // "December 31, Polar Bear Skate | 12:00pm – 9:00pm (event at 1:00pm)"
            { date: '2024-01-01', start: '12:00', end: '21:00' },
            { date: '2024-01-02', start: '12:00', end: '21:00' }
        ]);
        const january = READERS.bentway(season2324(), { today: '2024-01-15', daysAhead: 6 });
        expect(january.sessions.map(times)).toEqual(['17:00-21:00', '17:00-21:00', '17:00-21:00', '17:00-21:00', '12:00-21:00', '12:00-21:00', '12:00-21:00']);
        expect(on(january, '2024-01-19')[0].note).toBe('TDSB PA Day');
        const last = READERS.bentway(season2324(), { today: '2024-02-15', daysAhead: 10 });
        expect(last.sessions.map((s) => s.date)).toEqual(['2024-02-15', '2024-02-16', '2024-02-17', '2024-02-18', '2024-02-19']);
    });

    test('dates without hours: pending is fine, "in season" is not', () => {
        const bare = (() => { const data = JSON.parse(body()); delete data[0].content; return JSON.stringify(data); })();
        const early = READERS.bentway(bare, { today: TODAY, daysAhead: 30 });
        expect([early.state, early.sessions.length]).toEqual(['pending', 0]);
        const mid = READERS.bentway(bare, { today: '2027-01-10', daysAhead: 7 });
        expect([mid.state, mid.sessions.length]).toEqual(['unknown', 0]);
        for (const junk of ['[]', '{}', 'null', '[{"slug":"winter-skating","acf":{}}]', '[{"slug":"winter-skating","acf":{"start_date":"soon","end_date":"later"}}]', '[{"slug":"adire-on-ice","acf":{"start_date":"December 12, 2026","end_date":"February 28, 2027"}}]']) {
            const r = READERS.bentway(junk, { today: TODAY, daysAhead: 30 });
            expect([junk, r.state, r.sessions.length]).toEqual([junk, 'unknown', 0]);
        }
    });
});

/* ---------------------------------------------------------------- Evergreen Brick Works ---------------------------------------------------------------- */

test.describe('evergreen', () => {
    test('today: reopens December 19, so nothing in the next three weeks', () => {
        const r = read('evergreen', 'evergreen-2026-11-21.html', TODAY);
        expect(r.state).toBe('pending');
        expect(r.quote).toBe('Our public skating will reopen December 19, weather permitting.');
        expect(r.season).toEqual({ from: '2026-12-19', to: '2027-02-28' });
        expect(r.sessions).toEqual([]);
    });

    test('today, looking further ahead: dates take this season\'s years, overrides and remarks are read', () => {
        const five = read('evergreen', 'evergreen-2026-11-21.html', TODAY, 35);
        expect(five.state).toBe('pending');
        expect(five.sessions).toEqual([
            { date: '2026-12-19', start: '10:00', end: '17:00' },
            { date: '2026-12-20', start: '11:00', end: '17:00' },                                   // "Dec 20 (11am – 5pm)"
            { date: '2026-12-21', start: '10:00', end: '17:00' },
            { date: '2026-12-22', start: '10:00', end: '17:00' },
            { date: '2026-12-23', start: '10:00', end: '17:00' },
            { date: '2026-12-24', start: '10:00', end: '17:00' },
            { date: '2026-12-26', start: '10:00', end: '17:00', note: 'Free rentals available!' }    // "Dec 26 (Free rentals available!)"
        ]);
        const all = read('evergreen', 'evergreen-2026-11-21.html', TODAY, 100);
        expect(all.sessions).toHaveLength(38);
        expect(on(all, '2026-12-25')).toEqual([]);                  // not on the page
        expect(on(all, '2027-01-08')).toEqual([{ date: '2027-01-08', start: '16:00', end: '20:00' }]);                                         // Friday group
        expect(on(all, '2027-01-15')).toEqual([{ date: '2027-01-15', start: '10:00', end: '20:00', note: 'Free rentals available!' }]);       // "Jan 15 (10am – 8pm - Free rentals available!)"
        expect(on(all, '2027-02-15')).toEqual([{ date: '2027-02-15', start: '10:00', end: '17:00', note: 'Family Day - Free rentals available!' }]);
        const friday = all.sessions.filter((s) => s.end === '20:00');
        expect(friday).toHaveLength(8);
        expect(friday.every((s) => weekday(s.date) === 5)).toBe(true);
        const january = all.sessions.filter((s) => s.date >= '2027-01-01' && s.end === '17:00' && s.date !== '2027-02-15');
        expect(january.every((s) => [0, 6].includes(weekday(s.date)))).toBe(true);                 // the weekend group lands on weekends in 2027
    });

    test('in season (December 2025): open, every date on the weekday the page prints, weekend hours by day', () => {
        const r = read('evergreen', 'evergreen-2025-12-09.html', '2025-12-20');
        expect(r.state).toBe('open');
        expect(r.season).toEqual({ from: '2025-12-14', to: '2026-02-22' });
        expect(r.sessions.map((s) => `${s.date} ${times(s)}`)).toEqual([
            '2025-12-20 10:00-17:00', '2025-12-21 11:00-17:00', '2025-12-22 10:00-17:00',
            '2025-12-23 10:00-17:00',                                // written "TuesdayDec 23" on the page
            '2025-12-26 10:00-17:00', '2025-12-27 10:00-17:00', '2025-12-28 10:00-17:00', '2025-12-29 10:00-17:00', '2025-12-30 10:00-17:00',
            '2026-01-02 10:00-17:00',                                // "Friday Jan 2": next year
            '2026-01-03 13:00-18:00',                                // "Saturdays 1:00 pm – 6:00 pm"
            '2026-01-04 13:00-17:00',                                // "Sundays 1:00 pm – 5:00 pm"
            '2026-01-10 13:00-18:00'
        ]);
        expect(fixture('evergreen-2025-12-09.html')).toContain('<span>TuesdayDec 23 </span>');
        expect([weekday('2025-12-23'), weekday('2026-01-02'), weekday('2026-01-03'), weekday('2026-01-04')]).toEqual([2, 5, 6, 0]);
        // read before its first date, the same page is pending and already carries the dates in the window
        const early = read('evergreen', 'evergreen-2025-12-09.html', '2025-12-09');
        expect(early.state).toBe('pending');
        expect(early.sessions).toHaveLength(10);
        expect(early.sessions[0]).toEqual({ date: '2025-12-14', start: '11:00', end: '17:00' });
    });

    test('off season: "closed for this season" shuts the page although last season\'s dates are still listed', () => {
        expect(fixture('evergreen-2026-07-16.html')).toContain('<span>Saturday Dec 20  </span>');
        for (const today of ['2026-07-16', '2026-10-30', '2025-12-20']) {       // the last one is a day those dates would be valid on
            const r = read('evergreen', 'evergreen-2026-07-16.html', today, 120);
            expect([today, r.state, r.sessions.length]).toEqual([today, 'closed', 0]);
            expect(r.quote).toBe('Our Public Skating has closed for this season.');
        }
    });

    test('last season\'s lists without that banner are caught by their weekdays', () => {
        // weekday names printed: every one of them is wrong a year later
        const named = read('evergreen', 'evergreen-2025-12-09.html', '2026-11-21', 120);
        expect([named.state, named.sessions.length]).toEqual(['pending', 0]);
        // no weekday names: the "Weekend" and "Friday" groups no longer land on weekends and Fridays, so the undated holiday list goes too
        const unnamed = read('evergreen', 'evergreen-2026-11-21.html', '2027-11-20', 120);
        expect([unnamed.state, unnamed.sessions.length]).toEqual(['pending', 0]);
        // and after the last listed date the season is simply over
        const done = read('evergreen', 'evergreen-2026-11-21.html', '2027-03-05', 120);
        expect([done.state, done.sessions.length]).toEqual(['closed', 0]);
    });

    test('a cancelled date is not a session, a later reopening date holds everything before it, a closure notice stops the reader', () => {
        const page = fixture('evergreen-2026-11-21.html');
        const cancelled = READERS.evergreen(swap(page, '<span>Dec 24  </span>', '<span>Dec 24 (Cancelled)</span>'), { today: TODAY, daysAhead: 35 });
        expect(cancelled.sessions.map((s) => s.date)).toEqual(['2026-12-19', '2026-12-20', '2026-12-21', '2026-12-22', '2026-12-23', '2026-12-26']);
        const delayed = READERS.evergreen(swap(page, 'will reopen December 19', 'will reopen December 22'), { today: TODAY, daysAhead: 35 });
        expect(delayed.sessions.map((s) => s.date)).toEqual(['2026-12-22', '2026-12-23', '2026-12-24', '2026-12-26']);
        expect(delayed.season.from).toBe('2026-12-22');
        const banner = 'Public Skating at Evergreen Brick Works opens this December!';
        const notice = READERS.evergreen(swap(page, banner, 'Public Skating is closed today due to warm weather.'), { today: '2026-12-21', daysAhead: 7 });
        expect([notice.state, notice.sessions.length, notice.quote]).toEqual(['unknown', 0, 'Public Skating is closed today due to warm weather.']);
        // a notice that names its date takes that date out and leaves the rest
        const dated = READERS.evergreen(swap(page, banner, 'Public Skating is cancelled on December 22 due to warm weather.'), { today: '2026-12-21', daysAhead: 3 });
        expect([dated.state, dated.sessions.map((s) => s.date)]).toEqual(['open', ['2026-12-21', '2026-12-23', '2026-12-24']]);
    });
});

/* ---------------------------------------------------------------- Mattamy Athletic Centre ---------------------------------------------------------------- */

test.describe('mattamy', () => {
    test('today: four community skates listed, none within three weeks', () => {
        const r = read('mattamy', 'mattamy-2026-11-21.html', TODAY);
        expect(r.state).toBe('open');
        expect(r.quote).toBe('Saturday December 26th, 2026 11am - 1pm');
        expect(r.sessions).toEqual([]);
        const far = read('mattamy', 'mattamy-2026-11-21.html', TODAY, 150);
        expect(far.sessions).toEqual([
            { date: '2026-12-26', start: '11:00', end: '13:00' },
            { date: '2027-01-01', start: '11:00', end: '13:00' },
            { date: '2027-02-15', start: '11:00', end: '13:00' },       // "Monday February 15th, 2027: 11am - 1pm"
            { date: '2027-03-28', start: '11:00', end: '13:00' }
        ]);
        expect(far.sessions.map((s) => weekday(s.date))).toEqual([6, 5, 1, 0]);     // Saturday, Friday, Monday, Sunday, as printed
    });

    test('the students, faculty and staff list below the rule is never read', () => {
        const page = fixture('mattamy-2026-11-21.html');
        expect(page).toContain('<hr />\n<h3>TMU STUDENT, FACULTY, AND STAFF FREE SKATE SCHEDULE');
        expect(page).toContain('<p>- Wednesday September 23rd, 2026: 1pm - 2:30pm</p>');
        const r = READERS.mattamy(page, { today: '2026-09-01', daysAhead: 90 });      // a window that holds only staff dates
        expect([r.state, r.sessions.length]).toEqual(['open', 0]);
        const old = read('mattamy', 'mattamy-2025-12-04.html', '2025-09-01', 60);
        expect([old.state, old.sessions.length]).toEqual(['open', 0]);
    });

    test('December 2025: the list layout and "from 11AM-1PM" read the same way', () => {
        const r = read('mattamy', 'mattamy-2025-12-04.html', '2025-12-04', 90);
        expect(r.state).toBe('open');
        expect(r.sessions).toEqual([
            { date: '2025-12-26', start: '11:00', end: '13:00' },       // "Friday December 26th 2025 from 11AM-1PM"
            { date: '2026-01-01', start: '11:00', end: '13:00' },       // "Thursday, January 1st 2026 from 11AM-1PM"
            { date: '2026-02-16', start: '14:00', end: '16:00' }        // "Monday, February 16th 2026 from 2PM - 4PM"
        ]);
        expect(r.sessions.map((s) => weekday(s.date))).toEqual([5, 4, 1]);
    });

    test('every date past is closed; a line needs its year, its time and the right weekday', () => {
        const page = fixture('mattamy-2026-11-21.html');
        const past = READERS.mattamy(page, { today: '2027-04-01', daysAhead: 90 });
        expect([past.state, past.sessions.length]).toEqual(['closed', 0]);
        const dates = (text) => READERS.mattamy(text, { today: TODAY, daysAhead: 150 }).sessions.map((s) => s.date);
        expect(dates(swap(page, 'Saturday December 26th, 2026', 'Sunday December 26th, 2026'))).toEqual(['2027-01-01', '2027-02-15', '2027-03-28']);
        expect(dates(swap(page, 'Friday January 1st, 2027 11am', 'Friday January 1st 11am'))).toEqual(['2026-12-26', '2027-02-15', '2027-03-28']);
        expect(dates(swap(page, '2027: 11am - 1pm', '2027: time to be announced'))).toEqual(['2026-12-26', '2027-01-01', '2027-03-28']);
        expect(dates(swap(page, 'Sunday March 28th, 2027 11am - 1pm', 'Sunday March 28th, 2027 11am - 1pm (CANCELLED)'))).toEqual(['2026-12-26', '2027-01-01', '2027-02-15']);
        const none = READERS.mattamy(page.replace(/<p>(?:Saturday|Friday|Monday|Sunday) [^<]*<\/p>/g, ''), { today: TODAY, daysAhead: 150 });
        expect([none.state, none.sessions.length]).toEqual(['unknown', 0]);
    });
});

/* ---------------------------------------------------------------- Mississauga Celebration Square ---------------------------------------------------------------- */

test.describe('mississaugaSquare', () => {
    test('today: closed for the season and due to reopen, whatever the Square and the fountain say', () => {
        const page = fixture('mississauga-2026-11-21.html');
        expect(page).toContain('8:00 am - 11:00 pm');               // the Square's own row, above the rink's
        expect(page).toContain('fountain is open for the season');   // the fountain's accordion
        const r = READERS.mississaugaSquare(page, { today: TODAY, daysAhead: 21 });
        expect(r.state).toBe('pending');
        expect(r.quote).toBe('Celebration Square’s ice rink is closed for the season and will reopen by winter 2026 (weather-dependant).');
        expect(r.sessions).toEqual([]);
        const final = READERS.mississaugaSquare(swap(page, ' and will reopen by winter 2026 (weather-dependant)', ''), { today: TODAY, daysAhead: 21 });
        expect([final.state, final.sessions.length]).toEqual(['closed', 0]);
    });

    test('in season: the rink\'s own hours, not the Square\'s; the fountain being closed for the season changes nothing', () => {
        const page = fixture('mississauga-2026-01-15.html');
        expect(page).toContain('The Fountain (closed for the season)');
        expect(page).toContain('fountain is closed for the season and will reopen by spring 2026');
        const r = READERS.mississaugaSquare(page, { today: '2026-01-15', daysAhead: 6 });
        expect(r.state).toBe('open');
        expect(r.quote).toBe('Open Daily: 10 a.m.-10 p.m.');
        expect(r.sessions).toEqual(['2026-01-15', '2026-01-16', '2026-01-17', '2026-01-18', '2026-01-19', '2026-01-20', '2026-01-21'].map((date) => ({ date, start: '10:00', end: '22:00' })));
        expect(read('mississaugaSquare', 'mississauga-2026-01-15.html', '2026-01-15', 21).sessions).toHaveLength(22);
    });

    test('the dated holiday lines replace the weekly hours on their dates', () => {
        const r = read('mississaugaSquare', 'mississauga-2026-01-15.html', '2025-12-23', 10);
        expect(r.sessions.map((s) => `${s.date} ${times(s)}`)).toEqual([
            '2025-12-23 10:00-22:00',
            '2025-12-24 10:00-18:00',                                // "Christmas Eve (December 24): 10 a.m.-6 p.m."
            '2025-12-25 12:00-18:00',                                // "Christmas Day (December 25): Noon-6 p.m."
            '2025-12-26 10:00-22:00', '2025-12-27 10:00-22:00', '2025-12-28 10:00-22:00', '2025-12-29 10:00-22:00', '2025-12-30 10:00-22:00',
            '2025-12-31 10:00-23:00',                                // "New Year’s Eve (December 31): 10 a.m.-11 p.m."
            '2026-01-01 12:00-20:00',                                // "New Year’s Day (January 1): Noon-8 p.m."
            '2026-01-02 10:00-22:00'
        ]);
        expect(on(r, '2025-12-24')[0].note).toBe('Christmas Eve');
    });

    test('a closure with a date removes that date; hours shown in July are a stale page', () => {
        const page = fixture('mississauga-2026-01-15.html');
        const works = READERS.mississaugaSquare(swap(page, 'Skate schedule is subject to change.', 'The rink will be closed on January 20 for maintenance.'), { today: '2026-01-18', daysAhead: 4 });
        expect(works.sessions.map((s) => s.date)).toEqual(['2026-01-18', '2026-01-19', '2026-01-21', '2026-01-22']);
        const closedDay = READERS.mississaugaSquare(swap(page, 'Christmas Day (December 25): Noon-6 p.m.', 'Christmas Day (December 25): Closed'), { today: '2025-12-24', daysAhead: 2 });
        expect([closedDay.state, closedDay.sessions.map((s) => s.date)]).toEqual(['open', ['2025-12-24', '2025-12-26']]);
        // closed with no date is about now, whatever hours the table still shows
        const thaw = READERS.mississaugaSquare(swap(page, 'Skate schedule is subject to change.', 'The ice rink is temporarily closed due to mild weather.'), { today: '2026-01-18', daysAhead: 4 });
        expect([thaw.state, thaw.sessions.length, thaw.quote]).toEqual(['pending', 0, 'The ice rink is temporarily closed due to mild weather.']);
        const july = READERS.mississaugaSquare(page, { today: '2026-07-01', daysAhead: 7 });
        expect([july.state, july.sessions.length]).toEqual(['unknown', 0]);
    });
});

/* ---------------------------------------------------------------- Brampton: outdoor rinks ---------------------------------------------------------------- */

test.describe('bramptonOutdoor', () => {
    test('today: one rink open (it has its own schedule), every row of the table reported', () => {
        const r = read('bramptonOutdoor', 'brampton-outdoor-2026-11-21.html', TODAY);
        expect(r.state).toBe('open');
        expect(r.quote).toBe('Outdoor skating rinks are opening for the season soon! Check operational status below before visiting.');
        expect(r.note).toContain('1 of 16');
        expect(r.sessions).toEqual([]);                              // the open row links to "View schedule": the Gore Meadows reader covers it
        expect(r.venues).toHaveLength(16);
        expect(r.venues.filter((v) => v.open).map((v) => v.name)).toEqual(['Gore Meadows Covered Outdoor Skating Rink']);
        expect(r.venues[0]).toEqual({ name: 'Amore Italian Park', address: '70 Halliford Pl.', hours: 'Shinny Hockey: 9 a.m. to 12 p.m. | 3 to 7 p.m.; Public Skating: 12 to 3 p.m. | 7 to 10 p.m.', status: 'Closed', reason: 'Closed for the season', open: false });
        expect(r.venues.find((v) => /^Gore Meadows/.test(v.name))).toEqual({ name: 'Gore Meadows Covered Outdoor Skating Rink', address: '10150 The Gore Road', hours: '8 a.m. to 10 p.m.', status: 'Open', reason: '', open: true });
        expect(r.venues.find((v) => /^Sandalwood/.test(v.name))).toMatchObject({ status: 'Rink 1 - Closed; Rink 2 - Closed', reason: 'Closed for the season', open: false });
        expect(r.venues.find((v) => v.name === 'Bovaird House').hours).toBe('Hours and schedule TBD');
        expect(r.venues.every((v) => v.name && v.address && !/[<>]|&#?\w+;/.test(v.name + v.address + v.hours + v.status + v.reason) && !(v.name + v.address + v.hours + v.status + v.reason).includes(ZERO_WIDTH))).toBe(true);
    });

    test('the hidden weather advisory is ignored', () => {
        const page = fixture('brampton-outdoor-2026-11-21.html');
        expect(page).toContain('<div class="ms-hide ">');
        expect(page).toContain('is cancelled due to inclement weather conditions');
        const r = READERS.bramptonOutdoor(page, { today: TODAY, daysAhead: 21 });
        expect(JSON.stringify(r)).not.toMatch(/Advisory|cancelled|March 5/);
        // with no rink open the state comes from the visible SEASON UPDATE, never from words inside the hidden block
        const shut = swap(page, '<td>Open<br/></td>', '<td>Closed</td>');
        const planted = swap(shut, 'The Youth Hockey Development program scheduled for tonight is cancelled due to inclement weather conditions.', 'SEASON UPDATE: All outdoor rinks are closed for the season.');
        for (const text of [shut, planted]) {
            const none = READERS.bramptonOutdoor(text, { today: TODAY, daysAhead: 21 });
            expect([none.state, none.sessions.length, none.quote]).toEqual(['pending', 0, 'Outdoor skating rinks are opening for the season soon! Check operational status below before visiting.']);
            expect(none.venues.filter((v) => v.open)).toEqual([]);
        }
        expect(fixture('brampton-outdoor-2026-01-13.html')).toContain('PROGRAM CANCELLATION:');      // the January page hides a template notice the same way
        expect(JSON.stringify(read('bramptonOutdoor', 'brampton-outdoor-2026-01-13.html', '2026-01-13', 0))).not.toMatch(/CANCELLATION|cancelled/);
    });

    test('in season: sessions only for rows that are plainly open, split hours as separate activities', () => {
        const r = read('bramptonOutdoor', 'brampton-outdoor-2026-01-13.html', '2026-01-13', 0);
        expect(r.state).toBe('open');
        expect(r.note).toContain('11 of 12');
        expect(r.venues).toHaveLength(12);
        expect(r.sessions).toHaveLength(27);
        const at = (venue) => r.sessions.filter((s) => s.venue === venue).map((s) => `${times(s)} ${s.activity}`);
        expect(at('Boreham Park')).toEqual(['09:00-22:00 Public Skating']);                                                    // "9 AM - 10 PM"
        expect(at('Amore Italian Park')).toEqual(['09:00-12:00 Shinny Hockey', '12:00-15:00 Public Skating', '15:00-19:00 Shinny Hockey', '19:00-22:00 Public Skating']);
        expect(at('Peel Village Park')).toEqual(['09:00-12:00 Shinny Hockey', '12:00-15:00 Public Skating', '15:00-19:00 Shinny Hockey', '19:00-21:00 Public Skating']);
        // "10 AM - 10 PM" above the split lines is the rink's day, not a fourth session; "10 - 2 PM" starts in the morning
        expect(at('Flower City Community Campus Outdoor Skating Rink')).toEqual(['10:00-14:00 Shinny Hockey', '14:00-18:00 Public Skating', '18:00-22:00 Shinny Hockey']);
        expect(at('Chinguacousy Park Skating Recreational Trail')).toEqual(['10:00-22:00 Public Skating']);                     // its name is printed over two lines
        expect(at('Major William Sharpe Park')).toEqual([]);                                                                    // Closed: "Ice conditions"
        expect(r.venues.find((v) => v.name === 'Major William Sharpe Park')).toMatchObject({ status: 'Closed', reason: 'Ice conditions', open: false });
        expect(at('Gore Meadows Covered Outdoor Skating Rink')).toEqual([]);                                                    // open, but "Winter Schedule" is a link to its own
        expect(new Set(r.sessions.map((s) => s.venue)).size).toBe(10);
        expect(read('bramptonOutdoor', 'brampton-outdoor-2026-01-13.html', '2026-01-13', 2).sessions).toHaveLength(81);
    });

    test('a table that reads "Open" in July is a stale page; the rows are still reported', () => {
        const r = read('bramptonOutdoor', 'brampton-outdoor-2026-01-13.html', '2026-07-13', 7);
        expect([r.state, r.sessions.length, r.venues.length]).toEqual(['unknown', 0, 12]);
    });
});

/* ---------------------------------------------------------------- Brampton: Gore Meadows ---------------------------------------------------------------- */

test.describe('bramptonGoreMeadows', () => {
    const ACTIVITIES = ['Public Skate', 'Shinny Drop-In – Ages 17 and Under', 'Shinny Drop-In – Ages 18+'];

    test('today: inside the posted range, public skates and shinny drop-ins only', () => {
        const r = read('bramptonGoreMeadows', 'brampton-gore-meadows-2026-11-21.html', TODAY);
        expect(r.state).toBe('open');
        expect(r.quote).toBe('Schedule for November 16 to December 20, 2026');
        expect(r.season).toEqual({ from: '2026-11-16', to: '2026-12-20' });
        expect(r.sessions).toHaveLength(105);
        expect([...new Set(r.sessions.map((s) => s.activity))].sort()).toEqual(ACTIVITIES);      // no Learn to Skate, no Youth Hockey Development Program, no Shoot Around
        expect(on(r, '2026-11-21').map((s) => `${times(s)} ${s.activity}`)).toEqual([           // a Saturday
            '08:00-09:50 Shinny Drop-In – Ages 18+', '10:00-11:50 Public Skate', '12:00-13:50 Shinny Drop-In – Ages 17 and Under',
            '15:00-16:50 Shinny Drop-In – Ages 17 and Under', '17:00-19:50 Public Skate', '20:00-21:50 Shinny Drop-In – Ages 18+'
        ]);
        expect(on(r, '2026-11-27').map((s) => `${times(s)} ${s.activity}`)).toEqual([           // a Friday: the 4 to 7:50 p.m. development program is not read
            '08:00-09:50 Shinny Drop-In – Ages 18+', '10:00-15:50 Public Skate', '20:00-21:50 Shinny Drop-In – Ages 18+'
        ]);
        expect(on(r, '2026-11-24').map((s) => `${times(s)} ${s.activity}`)).toEqual([           // a Tuesday: 5 to 7 p.m. is Learn to Skate
            '14:00-15:50 Public Skate', '16:00-16:50 Shinny Drop-In – Ages 17 and Under', '19:00-19:50 Public Skate', '20:00-21:50 Shinny Drop-In – Ages 18+'
        ]);
        expect([weekday('2026-11-21'), weekday('2026-11-27'), weekday('2026-11-24')]).toEqual([6, 5, 2]);
        const perDay = [5, 5, 4, 5, 5, 3, 6];                        // Sunday … Saturday
        for (const date of new Set(r.sessions.map((s) => s.date))) expect([date, on(r, date).length]).toEqual([date, perDay[weekday(date)]]);
    });

    test('read after its end date the schedule yields nothing; near the end it stops on the last day', () => {
        const after = read('bramptonGoreMeadows', 'brampton-gore-meadows-2026-11-21.html', '2026-12-21');
        expect([after.state, after.sessions.length]).toEqual(['pending', 0]);
        expect(after.note).toContain('ended on December 20, 2026');
        const edge = read('bramptonGoreMeadows', 'brampton-gore-meadows-2026-11-21.html', '2026-12-18');
        expect(edge.state).toBe('open');
        expect([...new Set(edge.sessions.map((s) => s.date))]).toEqual(['2026-12-18', '2026-12-19', '2026-12-20']);
        expect(edge.sessions).toHaveLength(14);
    });

    test('read before its start it is pending, and carries only the dates inside the range', () => {
        const r = read('bramptonGoreMeadows', 'brampton-gore-meadows-2026-11-21.html', '2026-11-10', 7);
        expect(r.state).toBe('pending');
        expect([...new Set(r.sessions.map((s) => s.date))]).toEqual(['2026-11-16', '2026-11-17']);
        expect(r.sessions).toHaveLength(9);
    });

    test('a range that crosses New Year, a dated closure beside the table, a page without the heading', () => {
        const page = fixture('brampton-gore-meadows-2026-11-21.html');
        const winter = READERS.bramptonGoreMeadows(swap(page, 'Schedule for November 16&#160;to December 20,&#160;2026', 'Schedule for December 21&#160;to January 3,&#160;2027'), { today: '2026-12-30', daysAhead: 10 });
        expect(winter.season).toEqual({ from: '2026-12-21', to: '2027-01-03' });
        expect([...new Set(winter.sessions.map((s) => s.date))]).toEqual(['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02', '2027-01-03']);
        const closures = READERS.bramptonGoreMeadows(swap(page, 'weather and ice conditions permitting.', 'weather and ice conditions permitting. The rink is closed on November 26 and December 1.'), { today: '2026-11-25', daysAhead: 7 });
        expect([...new Set(closures.sessions.map((s) => s.date))]).toEqual(['2026-11-25', '2026-11-27', '2026-11-28', '2026-11-29', '2026-11-30', '2026-12-02']);
        const noHeading = READERS.bramptonGoreMeadows(swap(page, 'Schedule for November 16&#160;to December 20,&#160;2026', 'Schedule'), { today: TODAY, daysAhead: 21 });
        expect([noHeading.state, noHeading.sessions.length]).toEqual(['unknown', 0]);
    });

    test('two schedules on one page (this one and the next): each is read inside its own range', () => {
        const page = fixture('brampton-gore-meadows-2026-11-21.html');
        const next = swap(page, 'Schedule for November 16&#160;to December 20,&#160;2026', 'Schedule for December 21&#160;to January 3,&#160;2027');
        const both = `${page}\n${next.slice(next.indexOf('<h4>'))}`;
        const across = READERS.bramptonGoreMeadows(both, { today: '2026-12-18', daysAhead: 21 });
        expect(across.state).toBe('open');
        expect(across.season).toEqual({ from: '2026-11-16', to: '2026-12-20' });
        const dates = [...new Set(across.sessions.map((s) => s.date))];
        expect([dates[0], dates[dates.length - 1], dates.length]).toEqual(['2026-12-18', '2027-01-03', 17]);
        expect(on(across, '2026-12-21')).toHaveLength(5);            // a Monday, once: the two tables do not double up
        const later = READERS.bramptonGoreMeadows(both, { today: '2026-12-25', daysAhead: 3 });
        expect([later.state, later.season]).toEqual(['open', { from: '2026-12-21', to: '2027-01-03' }]);
        const done = READERS.bramptonGoreMeadows(both, { today: '2027-01-04', daysAhead: 21 });
        expect([done.state, done.sessions.length]).toEqual(['pending', 0]);
    });
});

/* ---------------------------------------------------------------- George Bell Arena ---------------------------------------------------------------- */

test.describe('georgeBell', () => {
    const STAR = 'Some weeks this starts at 6 pm. Check the arena\'s Instagram.';

    test('today: weekly sessions by label, the starred Saturday with its footnote', () => {
        const r = read('georgeBell', 'georgebell-2026-11-21.html', TODAY);
        expect(r.state).toBe('open');
        expect(r.quote).toBe('We host weekly FREE public skating:');
        expect(r.sessions).toHaveLength(13);
        expect(r.sessions.slice(0, 5)).toEqual([
            { date: '2026-11-21', start: '19:00', end: '20:00', activity: 'Public Skating: All Ages', note: STAR },     // "- Saturdays: 7pm-8pm* (All Ages)"
            { date: '2026-11-24', start: '15:00', end: '16:00', activity: 'Public Skating: Adults' },                   // "- Tuesdays: 3pm-4pm (Adult)"
            { date: '2026-11-26', start: '15:00', end: '16:00', activity: 'Public Skating: Adults' },                   // "- Thursdays: 3pm-4pm (Adult), 4pm-5pm (All Ages)"
            { date: '2026-11-26', start: '16:00', end: '17:00', activity: 'Public Skating: All Ages' },
            { date: '2026-11-28', start: '19:00', end: '20:00', activity: 'Public Skating: All Ages', note: STAR }
        ]);
        for (const s of r.sessions) {
            expect([2, 4, 6]).toContain(weekday(s.date));
            expect(Boolean(s.note)).toBe(weekday(s.date) === 6);
            if (weekday(s.date) === 2) expect(s.activity).toBe('Public Skating: Adults');
        }
    });

    test('the older layout: unlabelled times under the season\'s own dates, closed once those dates are past', () => {
        const r = read('georgeBell', 'georgebell-2025-04-26.html', '2025-01-15');
        expect(r.state).toBe('open');
        expect(r.season).toEqual({ from: '2024-09-03', to: '2025-03-27' });
        expect(r.sessions).toEqual([
            { date: '2025-01-16', start: '16:00', end: '18:00', activity: 'Public Skating' },       // "Thursdays 4-6PM"
            { date: '2025-01-21', start: '15:00', end: '16:00', activity: 'Public Skating' },       // "Tuesdays - 3-4PM"
            { date: '2025-01-23', start: '16:00', end: '18:00', activity: 'Public Skating' },
            { date: '2025-01-28', start: '15:00', end: '16:00', activity: 'Public Skating' },
            { date: '2025-01-30', start: '16:00', end: '18:00', activity: 'Public Skating' },
            { date: '2025-02-04', start: '15:00', end: '16:00', activity: 'Public Skating' }
        ]);
        expect(r.sessions.map((s) => weekday(s.date))).toEqual([4, 2, 4, 2, 4, 2]);
        const end = read('georgeBell', 'georgebell-2025-04-26.html', '2025-03-20');
        expect(end.sessions.map((s) => s.date)).toEqual(['2025-03-20', '2025-03-25', '2025-03-27']);
        const off = read('georgeBell', 'georgebell-2025-04-26.html', '2025-04-26');
        expect([off.state, off.sessions.length, off.quote]).toEqual(['closed', 0, 'September 3rd 2024 - March 27th 2025']);
    });

    test('a line that calls skating off either names its dates or stops the reader', () => {
        const page = fixture('georgebell-2026-11-21.html');
        const lockers = 'Day-use lockers are available across from the Women\'s washrooms.';
        const dated = READERS.georgeBell(swap(page, lockers, 'No public skating on December 1 and December 3.'), { today: TODAY, daysAhead: 21 });
        expect(dated.state).toBe('open');
        expect(dated.sessions).toHaveLength(10);
        expect(dated.sessions.some((s) => ['2026-12-01', '2026-12-03'].includes(s.date))).toBe(false);
        const undated = READERS.georgeBell(swap(page, lockers, 'Public skating is cancelled until further notice.'), { today: TODAY, daysAhead: 21 });
        expect([undated.state, undated.sessions.length, undated.quote]).toEqual(['unknown', 0, 'Public skating is cancelled until further notice.']);
        const noTimes = READERS.georgeBell(page.replace(/\d+pm-\d+pm/g, 'TBA'), { today: TODAY, daysAhead: 21 });
        expect([noTimes.state, noTimes.sessions.length]).toEqual(['unknown', 0]);
    });
});

/* ---------------------------------------------------------------- McCormick Arena ---------------------------------------------------------------- */

test.describe('mccormick', () => {
    test('today: the schedule has ended, every card says so', () => {
        const r = read('mccormick', 'mccormick-2026-11-21.html', TODAY);
        expect(r.state).toBe('closed');
        expect(r.quote).toBe('This schedule ended on April 30th, 2026.');
        expect(r.season).toEqual({ to: '2026-04-30' });
        expect(r.sessions).toEqual([]);
    });

    test('in season: the three free public skating cards, each on its own weekdays', () => {
        const r = read('mccormick', 'mccormick-2025-26.html', '2026-01-21');
        expect(r.state).toBe('open');
        expect(r.season).toEqual({ from: '2025-09-08', to: '2026-04-30' });
        expect(r.quote).toBe('This schedule STARTS on SEPTEMBER 8th, 2025. (ends on April 30th, 2026)');
        expect(r.sessions).toHaveLength(16);
        expect(r.sessions.slice(0, 5)).toEqual([
            { date: '2026-01-21', start: '14:00', end: '15:00', activity: 'Adult Skating' },            // "Wednesday: 2pm to 3pm"
            { date: '2026-01-23', start: '16:00', end: '17:30', activity: 'Public skating' },           // "Friday: 4pm to 5:30pm"
            { date: '2026-01-24', start: '10:30', end: '12:00', activity: 'Public skating' },           // "Saturday: 10:30am to 12noon"
            { date: '2026-01-25', start: '12:30', end: '14:00', activity: 'Parent & Tot skating' },     // "Sunday: 12:30pm to 2pm"
            { date: '2026-01-27', start: '16:00', end: '17:30', activity: 'Public skating' }            // "Tuesday: 4pm to 5:30pm"
        ]);
        const days = { 'Public skating': [2, 5, 6], 'Parent & Tot skating': [0], 'Adult Skating': [3] };
        for (const s of r.sessions) expect(days[s.activity]).toContain(weekday(s.date));
        expect(r.sessions.some((s) => /ticket|shinny|hockey/i.test(s.activity))).toBe(false);          // the $10 cards are not public skating
        expect(fixture('mccormick-2025-26.html')).toContain('Ticket-Ice (cost = $10)');
    });

    test('the days the header lists as closed are skipped, and nothing runs past the season\'s end', () => {
        const holidays = read('mccormick', 'mccormick-2025-26.html', '2025-12-20');
        expect(holidays.sessions.map((s) => s.date)).toEqual(['2025-12-20', '2025-12-21', '2025-12-23', '2025-12-27', '2025-12-28', '2025-12-30', '2026-01-02', '2026-01-03', '2026-01-04', '2026-01-06', '2026-01-07', '2026-01-09', '2026-01-10']);
        // "DEC 24-25-26-31, JAN 1": Wednesday the 24th and 31st (adult skating) and Friday the 26th (public skating) are gone
        expect([weekday('2025-12-24'), weekday('2025-12-26'), weekday('2025-12-31')]).toEqual([3, 5, 3]);
        const easter = read('mccormick', 'mccormick-2025-26.html', '2026-04-01', 6);                   // "APR 3-4-5"
        expect(easter.sessions).toEqual([
            { date: '2026-04-01', start: '14:00', end: '15:00', activity: 'Adult Skating' },
            { date: '2026-04-07', start: '16:00', end: '17:30', activity: 'Public skating' }
        ]);
        const thanksgiving = read('mccormick', 'mccormick-2025-26.html', '2025-10-10', 4);             // "OCT 11-12-13"
        expect(thanksgiving.sessions.map((s) => s.date)).toEqual(['2025-10-10', '2025-10-14']);
        const end = read('mccormick', 'mccormick-2025-26.html', '2026-04-25');
        expect(end.sessions.map((s) => s.date)).toEqual(['2026-04-25', '2026-04-26', '2026-04-28', '2026-04-29']);
        const after = read('mccormick', 'mccormick-2025-26.html', '2026-05-01');
        expect([after.state, after.sessions.length]).toEqual(['closed', 0]);
    });

    test('before the season it is pending; a card does not start before its own date; no end date, no sessions', () => {
        const page = fixture('mccormick-2025-26.html');
        const early = READERS.mccormick(page, { today: '2025-09-01', daysAhead: 13 });
        expect(early.state).toBe('pending');
        expect(early.sessions.map((s) => `${s.date} ${s.activity}`)).toEqual(['2025-09-09 Public skating', '2025-09-10 Adult Skating', '2025-09-12 Public skating', '2025-09-13 Public skating', '2025-09-14 Parent & Tot skating']);
        const lateCard = READERS.mccormick(swap(page, 'Starts Sep 14, 2025', 'Starts Sep 28, 2025'), { today: '2025-09-08', daysAhead: 21 });
        expect(lateCard.sessions.filter((s) => s.activity === 'Parent & Tot skating').map((s) => s.date)).toEqual(['2025-09-28']);
        const open = READERS.mccormick(swap(page, '(ends on April 30th, 2026)', ''), { today: '2026-01-21', daysAhead: 21 });
        expect([open.state, open.sessions.length]).toEqual(['unknown', 0]);
        const works = READERS.mccormick(swap(page, '(CLOSED ON OCT 11-12-13, DEC 24-25-26-31, JAN 1, FEB 16, APR 3-4-5)', 'ARENA CLOSED FOR RENOVATIONS'), { today: '2026-01-21', daysAhead: 21 });
        expect([works.state, works.sessions.length, works.quote]).toEqual(['unknown', 0, 'ARENA CLOSED FOR RENOVATIONS']);
    });
});

/* ---------------------------------------------------------------- every reader ---------------------------------------------------------------- */

const OWN = {
    harbourfront: ['harbourfront-2026-11-21.html', 'harbourfront-2026-01-18.html', 'harbourfront-2026-07-17.html'],
    bentway: ['bentway-2026-11-21.json'],
    evergreen: ['evergreen-2026-11-21.html', 'evergreen-2025-12-09.html', 'evergreen-2026-07-16.html'],
    mattamy: ['mattamy-2026-11-21.html', 'mattamy-2025-12-04.html'],
    mississaugaSquare: ['mississauga-2026-11-21.html', 'mississauga-2026-01-15.html'],
    bramptonOutdoor: ['brampton-outdoor-2026-11-21.html', 'brampton-outdoor-2026-01-13.html'],
    bramptonGoreMeadows: ['brampton-gore-meadows-2026-11-21.html'],
    georgeBell: ['georgebell-2026-11-21.html', 'georgebell-2025-04-26.html'],
    mccormick: ['mccormick-2026-11-21.html', 'mccormick-2025-26.html']
};
const EVERY_FIXTURE = [...Object.values(OWN).flat(), 'bentway-2024-09-18.html'];
const DAYS = ['2025-01-15', '2025-04-26', '2025-12-09', '2025-12-20', '2025-12-31', '2026-01-13', '2026-01-18', '2026-02-25', '2026-07-16', '2026-11-10', TODAY, '2026-12-12', '2026-12-21', '2027-01-10', '2027-02-28', '2027-03-05', '2027-11-20'];

test.describe('every reader', () => {
    test('there are nine, and the fixtures are small excerpts', () => {
        expect(Object.keys(READERS).sort()).toEqual(Object.keys(OWN).sort());
        const folder = fs.readdirSync(path.join(__dirname, 'venues'));
        expect(EVERY_FIXTURE.filter((name) => !folder.includes(name))).toEqual([]);
        // excerpts, not pages: this is a public repository and these are other people's sites
        for (const name of folder) expect([name, fs.statSync(path.join(__dirname, 'venues', name)).size < 15000]).toEqual([name, true]);
    });

    test('an empty page, an error page and another venue\'s page are all "unknown", with no sessions', () => {
        test.setTimeout(LONG_MS);
        for (const [reader, own] of Object.entries(OWN)) {
            const others = EVERY_FIXTURE.filter((name) => !own.includes(name)).map(fixture);
            for (const body of ['', '   \n', '<html><body>Not Found</body></html>', '<html><head><title>503 Service Unavailable</title></head><body><h1>Service Unavailable</h1></body></html>', '{"code":"rest_no_route","message":"No route was found","data":{"status":404}}', ...others]) {
                for (const today of ['2026-01-15', TODAY]) {
                    const r = READERS[reader](body, { today, daysAhead: 21 });
                    expect([reader, body.slice(0, 60), r.state, r.sessions.length]).toEqual([reader, body.slice(0, 60), 'unknown', 0]);
                    expectWellFormed(r, today, 21);
                }
            }
        }
    });

    test('nothing throws: not on a missing body, not on a bad date, not on an odd window', () => {
        const page = fixture('georgebell-2026-11-21.html');
        for (const reader of Object.keys(READERS)) {
            for (const body of [null, undefined, 42, {}, [], '<', '<!--', '<div id="header-tix">', '[{"acf":', '<table><tr><td>']) {
                const r = READERS[reader](body, { today: TODAY, daysAhead: 21 });
                expect([reader, r.state, r.sessions]).toEqual([reader, 'unknown', []]);
            }
        }
        for (const ctx of [null, undefined, {}, { today: 'tomorrow', daysAhead: 3 }, { today: '2026-02-30', daysAhead: 3 }, { today: '2026-1-5', daysAhead: 3 }]) {
            expect(READERS.georgeBell(page, ctx)).toEqual({ state: 'unknown', note: 'The reader was called without a valid date.', sessions: [] });
        }
        // a window that is not a whole number of days ahead: only today, or rounded down, and never past a year
        const count = (daysAhead) => READERS.georgeBell(page, { today: TODAY, daysAhead }).sessions.length;
        expect([count(undefined), count(NaN), count(-5), count(0), count('7'), count(7.9)]).toEqual([1, 1, 1, 1, 5, 5]);
        const far = READERS.georgeBell(page, { today: TODAY, daysAhead: 1e9 }).sessions;
        expect(far[far.length - 1].date <= plusDays(TODAY, 366)).toBe(true);
    });

    test('no session ever falls outside [today, today + daysAhead]; daysAhead 0 is today alone', () => {
        test.setTimeout(LONG_MS);
        const wrong = [];
        let sessions = 0;
        for (const [reader, own] of Object.entries(OWN)) {
            for (const name of own) {
                const body = fixture(name);
                for (const today of DAYS) {
                    for (const daysAhead of [0, 1, 21, 150]) {
                        const r = READERS[reader](body, { today, daysAhead });
                        wrong.push(...problems(r, today, daysAhead).map((p) => `${name} ${today} +${daysAhead}: ${p}`));
                        if (daysAhead === 0 && !r.sessions.every((s) => s.date === today)) wrong.push(`${name} ${today} +0: a session on another day`);
                        sessions += r.sessions.length;
                    }
                    // a longer window only adds sessions: the first three weeks of it are the same sessions
                    const short = READERS[reader](body, { today, daysAhead: 21 }).sessions;
                    const long = READERS[reader](body, { today, daysAhead: 150 }).sessions.filter((s) => s.date <= plusDays(today, 21));
                    if (JSON.stringify(long) !== JSON.stringify(short)) wrong.push(`${name} ${today}: the window changes what is read`);
                }
            }
        }
        expect(wrong).toEqual([]);
        expect(sessions).toBeGreaterThan(5000);                     // the loop really did read sessions
    });

    test('the same input gives the same reading, in any time zone', () => {
        test.setTimeout(LONG_MS);
        // Each zone gets a Node process of its own, started with TZ already set: changing TZ inside a running
        // process does not always reach its clock (it did not, in a worker that had run other tests first).
        const { spawnSync } = require('child_process');
        const script = `
            const fs = require('fs'), path = require('path'), crypto = require('crypto');
            const { READERS } = require(process.env.V_MODULE);
            const own = JSON.parse(process.env.V_OWN), days = JSON.parse(process.env.V_DAYS);
            const all = JSON.stringify(Object.entries(own).flatMap(([reader, names]) => names.flatMap((name) => {
                const body = fs.readFileSync(path.join(process.env.V_DIR, name), 'utf8');
                return days.map((today) => READERS[reader](body, { today, daysAhead: 30 }));
            })));
            console.log(JSON.stringify({ offset: new Date(2026, 0, 15, 12).getTimezoneOffset(), sha: crypto.createHash('sha256').update(all).digest('hex'), length: all.length }));`;
        const read = (TZ) => {
            const r = spawnSync(process.execPath, ['-e', script], {
                encoding: 'utf8', timeout: 120000,
                env: { ...process.env, TZ, V_MODULE: require.resolve('../../../skate-venues.js'), V_DIR: path.join(__dirname, 'venues'), V_OWN: JSON.stringify(OWN), V_DAYS: JSON.stringify(DAYS) }
            });
            expect(r.status, `${TZ}: ${r.error ? r.error.message : r.stderr.slice(0, 300)}`).toBe(0);
            return JSON.parse(r.stdout);
        };
        const east = read('Pacific/Kiritimati'), west = read('Pacific/Pago_Pago'), home = read('America/Toronto');   // UTC+14, UTC−11, and where the rinks are
        expect([east.offset, west.offset, home.offset]).toEqual([-840, 660, 300]);                                  // the zones really differed under the readers
        expect(east.length).toBeGreaterThan(10000);                                                                  // and they really read something
        expect(west.sha).toBe(east.sha);
        expect(home.sha).toBe(east.sha);
    });
});

/* ---------------------------------------------------------------- pages built to waste time ---------------------------------------------------------------- */

// Tags that are never closed, attributes that never end, ten thousand copies of the very element a reader looks for.
// A reader that re-reads the rest of the page for each of them takes minutes, and a reader runs synchronously, so
// nothing in this process could stop it: the pages are read in a worker thread, which is terminated at the first reading
// that burns SLOW_MS of processor time, or that has not come back after HANG_MS on the clock. The test then fails with
// the name of that reading, having cost at most HANG_MS more than a clean run, instead of hanging the suite.
// (Processor time, not the clock, is what "slow" is measured in: a clean reading takes under 0.1 s of it however busy
// the machine is, where the same reading has been seen to take 0.4 s on the clock next to a browser suite.)
const { Worker } = require('worker_threads');
const HANG_MS = 15000;
const SLOW_MS = 1000;

/**
 * { unit, times, before, only, readable }: `unit` repeated `times` after `before`. Junk goes to every reader and must be
 * "unknown"; a pile of one reader's own containers goes to that reader (`only`). `readable` marks a page its reader
 * may make something of (well formed but absurdly long, or its own container with junk inside): there the state is
 * the reader's business, and only the time and the window are checked.
 */
const HOSTILE = [
    // junk, for every reader
    ['a', 200000], [' ', 200000], ['<', 100000], ['>', 100000], ['<div>', 50000], ['12 ', 60000], ['10 a.m. - ', 20000], ['<!--', 40000],
    ['<div class="x" ', 40000], ['<div class="', 40000], ['<table><tr><td>', 20000], ['<div class="collapse_wrap"><h4 class="title-h4">', 8000], ['<h4>Schedule for ', 20000],
    ['<a ', 50000], ['<p>', 50000], ['<tr>', 50000], ['<h3>', 50000], ['<script>', 30000], ['<a href="', 30000], ['&#', 80000], ['[', 50000], ['December 24 to January 1 ', 15000]
].map(([unit, times]) => ({ unit, times, before: '', only: null, readable: false })).concat([
    // thousands of the element a reader looks for, never closed
    ['harbourfront', '<div id="header-tix">', 8000],
    ['harbourfront', '<div id="hours">', 8000, '<div id="header-tix">Free admission every day!</div>'],
    ['harbourfront', '<table class="rink-hours-table">', 6000, '<div id="header-tix">Free admission every day!</div><div id="hours">'],
    ['evergreen', '<div class="info_banner">Public Skating ', 8000],
    ['evergreen', '<div class="top_container"><div class="txt">skating ', 6000],
    ['mattamy', '<h3>COMMUNITY SKATES', 8000],
    ['mississaugaSquare', '<div class="col space-name">Ice rink', 6000],
    ['mississaugaSquare', '<div class="row"><div class="col space-name">Ice rink</div>', 6000],
    ['mississaugaSquare', '<button class="accordion-title">Ice rink', 5000, '<div class="col space-name">Ice rink</div>'],
    ['bramptonOutdoor', '<div class="ms-hide">', 8000],
    ['bramptonOutdoor', '<table><tr><th>Rink<th>Status', 4000],
    ['bramptonOutdoor', '<a>', 30000, '<table><tr><th>Rink</th><th>Hours</th><th>Status</th></tr><tr><td>Park'],
    ['georgeBell', '<div data-aid="FAQ_SECTION_DESCRIPTION_RENDERED">', 4000],
    ['mccormick', '<div class="section-text">SCHEDULE ', 5000],
    ['mccormick', '<h4 class="card-title">Public skating', 5000, '<div class="section-text">SCHEDULE</div>']
].map(([only, unit, times, before = '']) => ({ unit, times, before, only, readable: false }))).concat([
    // the page each reader expects, thousands of rows long
    ['harbourfront', '<tr><td>Monday<td>10:00am – 10:00pm', 15000, '<div id="header-tix">Free admission every day!</div><div id="hours"><table class="rink-hours-table">'],
    ['evergreen', '<tr><td><span>Dec 19</span>', 30000, '<div class="collapse_wrap"><h4 class="title-h4">Public Skate</h4><div class="txt">From 10am – 5pm</div><table>'],
    ['mattamy', '<p>Saturday December 26th, 2026 11am - 1pm</p>', 20000, '<h3>COMMUNITY SKATES</h3>'],
    ['bramptonOutdoor', '<tr><td>Park<br><a>1 St</a><td>9 a.m. to 12 p.m. | 3 to 7 p.m.<td>Open<td>-', 9000, '<table><tr><th>Rink</th><th>Hours</th><th>Open/Close Status</th></tr>'],
    ['bramptonOutdoor', '9 a.m. to 12 p.m. | ', 8000, '<table><tr><th>Rink</th><th>Hours</th><th>Status</th></tr><tr><td>Park</td><td>Open</td><td>'],
    ['bramptonGoreMeadows', '<tr><th>Mondays<td>Public Skate<td>10 a.m. to 3:50 p.m.', 15000, '<h4>Schedule for January 4 to February 28, 2027</h4><table><tr><th>Day<th>Program<th>Time'],
    ['georgeBell', '<p>- Tuesdays: 3pm-4pm (Adult)</p>', 20000, '<div data-aid="FAQ_SECTION_DESCRIPTION_RENDERED">'],
    ['mccormick', 'Tuesday: 4pm to 5:30pm<br>', 20000, '<div class="section-text">This schedule STARTS on SEPTEMBER 8th, 2026. (ends on April 30th, 2027)</div><h4 class="card-title">Public skating (cost = free)</h4><p class="mbr-text">'],
    ['bentway', '<p>January 4 to February 28</p><table><tr><td>Daily</td><td>12:00pm – 9:00pm</td></tr></table>', 6000]
].map(([only, unit, times, before = '']) => ({ unit, times, before, only, readable: true }))).concat(Object.entries({
    // the element a reader looks for, once, with junk where its content should be
    harbourfront: '<div id="header-tix">Free admission every day!</div><div id="hours"><table class="rink-hours-table">',
    evergreen: '<div class="info_banner">Public Skating</div><div class="collapse_wrap"><h4 class="title-h4">Public Skate</h4><div class="txt">From 10am – 5pm</div><table>',
    mattamy: '<h3>COMMUNITY SKATES</h3>',
    mississaugaSquare: '<div class="row"><div class="col space-name">Ice rink</div><table class="hours-table-extended">',
    bramptonOutdoor: '<table><tr><th>Rink</th><th>Hours</th><th>Open/Close Status</th></tr><tr><td>',
    bramptonGoreMeadows: '<h4>Schedule for January 4 to February 28, 2027</h4><table><tr><th>Day</th><th>Program</th><th>Time</th></tr><tr><th>',
    georgeBell: '<div data-aid="FAQ_SECTION_DESCRIPTION_RENDERED">',
    mccormick: '<div class="section-text">SCHEDULE<br>This schedule STARTS on SEPTEMBER 8th, 2026. (ends on April 30th, 2027)</div><h4 class="card-title">Public skating',
    bentway: '<p>January 4 to February 28</p><table><tr><td>'
}).flatMap(([only, before]) => [['<', 100000], ['<p', 60000], ['<tr>', 50000], ['<td>', 50000], ['<a ', 50000], ['<br>', 60000]].map(([unit, times]) => ({ unit, times, before, only, readable: true }))));

/** The helpers on their own, each on [repeated text, times]: every one must stay linear whatever the readers do around it. */
const HOSTILE_TEXT = [['<', 100000], ['>', 100000], ['<div>', 50000], ['<div class="x" ', 40000], ['<p', 60000], ['<p>', 50000], ['<tr>', 50000], ['<td>', 50000], ['<!--', 40000], ['<script>', 30000],
    ['12 ', 60000], ['10 a.m. - ', 20000], ['&#', 80000], ['December 24 to January 1 ', 15000], ['Monday to Friday ', 20000], ['open on in this next ', 20000], ['. A', 60000]];
const HELPERS = ['visibleHtml', 'plain', 'lines', 'elements', 'strip', 'tableRows', 'decodeEntities', 'timeRanges', 'daySet', 'fullDates', 'closureDates', 'rinkWording'];

/** Every reader on every hostile page, in a worker: { readings: [{ what, ms (of processor time), state, sessions, readable }], stuck: the reading that never came back }. */
function readHostilePages() {
    const inWorker = `
        const { parentPort, workerData } = require('worker_threads');
        const { READERS } = require(workerData.module);
        const ctx = { today: '2027-01-10', daysAhead: 21 };
        for (const { unit, times, before, only, readable } of workerData.pages) {
            const page = before + unit.repeat(times);
            // the Bentway reads JSON, so it also gets the page as the text of an event that is in season
            const event = JSON.stringify([{ slug: 'winter-skating', acf: { start_date: 'December 12, 2026', end_date: 'February 28, 2027' }, content: { rendered: page } }]);
            for (const reader of Object.keys(READERS).filter((name) => !only || name === only)) {
                for (const body of reader === 'bentway' ? [page, event] : [page]) {
                    const what = reader + (body === event ? ' (as event text)' : '') + ' on ' + JSON.stringify(before.slice(0, 40) + unit) + ' x ' + times;
                    parentPort.postMessage({ begin: what });
                    const from = process.cpuUsage();
                    const r = READERS[reader](body, ctx);
                    const used = process.cpuUsage(from);
                    const inside = r.sessions.every((s) => s.date >= ctx.today && s.date <= '2027-01-31' && s.start < s.end);
                    parentPort.postMessage({ what, ms: (used.user + used.system) / 1000, state: r.state, sessions: r.sessions.length, inside, readable });
                }
            }
        }
        // then each helper by itself, on text alone
        const V = require(workerData.module);
        const run = {
            elements: (s) => V.elements(s, /^(?:div|p|table|tr|td|a)$/, null, 50), strip: (s) => V.strip(s, (tag, attrs) => attrs.includes('x')),
            closureDates: (s) => V.closureDates(s, (month, day) => V.inSeason(month, day, ctx.today))
        };
        for (const [unit, times] of workerData.text) {
            const text = unit.repeat(times);
            for (const helper of workerData.helpers) {
                const what = helper + '() on ' + JSON.stringify(unit) + ' x ' + times;
                parentPort.postMessage({ begin: what });
                const from = process.cpuUsage();
                (run[helper] || V[helper])(text);
                const used = process.cpuUsage(from);
                parentPort.postMessage({ what, ms: (used.user + used.system) / 1000, helper: true });
            }
        }
        parentPort.postMessage({ done: true });
        setInterval(() => {}, 60000);                               // stay alive: the test ends this worker once it has every reading`;
    return new Promise((resolve) => {
        const readings = [];
        let current = 'starting the worker', watchdog = null;
        const worker = new Worker(inWorker, { eval: true, workerData: { module: require.resolve('../../../skate-venues.js'), pages: HOSTILE, text: HOSTILE_TEXT, helpers: HELPERS } });
        const finish = (stuck) => { clearTimeout(watchdog); worker.removeAllListeners(); worker.terminate().then(() => resolve({ readings, stuck })); };
        worker.on('message', (msg) => {
            if (msg.done) return finish(null);
            clearTimeout(watchdog);
            if (msg.begin) { current = msg.begin; watchdog = setTimeout(() => finish(current), HANG_MS); return; }
            readings.push(msg);
            if (msg.ms >= SLOW_MS) finish(null);                    // one slow reading is enough to fail: do not sit through the rest
        });
        worker.on('error', (e) => finish(`${current} (worker error: ${e.message})`));
        worker.on('exit', () => finish(`${current} (the worker stopped)`));
    });
}

test.describe('pages built to waste time', () => {
    test('every reader answers quickly, and "unknown" to junk; a runaway reader would be stopped, not waited for', async () => {
        test.setTimeout(LONG_MS);
        const { readings, stuck } = await readHostilePages();
        expect(stuck).toBe(null);
        expect(readings.filter((r) => r.ms >= SLOW_MS).map((r) => `${r.what}: ${Math.round(r.ms)} ms`)).toEqual([]);
        const pages = readings.filter((r) => !r.helper), helpers = readings.filter((r) => r.helper);
        const expected = HOSTILE.reduce((n, page) => n + (!page.only ? Object.keys(READERS).length + 1 : page.only === 'bentway' ? 2 : 1), 0);     // the Bentway reads each page twice
        expect(pages).toHaveLength(expected);
        expect(helpers).toHaveLength(HOSTILE_TEXT.length * HELPERS.length);
        expect(pages.filter((r) => !r.readable && (r.state !== 'unknown' || r.sessions)).map((r) => `${r.what}: ${r.state}`)).toEqual([]);
        // a page its reader can make something of may be read or refused, and either way stays inside its window
        expect(pages.filter((r) => !r.inside || r.sessions > 5000).map((r) => r.what)).toEqual([]);
        expect(pages.filter((r) => r.readable && r.state !== 'unknown').length).toBeGreaterThan(0);
    });

    test('the limits themselves: a page past them is refused, not read', () => {
        const ctx = { today: TODAY, daysAhead: 21 };
        const real = fixture('georgebell-2026-11-21.html');
        expect(READERS.georgeBell(real + ' '.repeat(3000001), ctx)).toEqual({ state: 'unknown', note: 'The page is far larger than any page this reader knows.', sessions: [] });
        expect(READERS.georgeBell(real + '<i></i>'.repeat(30001), ctx)).toEqual({ state: 'unknown', note: 'The page holds far more markup than any page this reader knows.', sessions: [] });
        expect(READERS.georgeBell(real + '<i></i>'.repeat(20000), ctx).sessions).toHaveLength(13);      // 40,000 tags of padding: still the page it is
    });
});

/* ---------------------------------------------------------------- the helpers ---------------------------------------------------------------- */

test.describe('helpers', () => {
    test('times: every spelling these pages use, and refusals', () => {
        const t = (text) => V.timeRanges(text).map((r) => `${r.start}-${r.end}`).join(' ') || null;
        expect(t('10:00am – 10:00pm')).toBe('10:00-22:00');                             // Harbourfront
        expect(t('12:00pm – 9:00pm (event at 1:00pm)')).toBe('12:00-21:00');            // The Bentway
        expect(t('From 10:00 am – 5:00 pm')).toBe('10:00-17:00');                       // Evergreen
        expect(t('10am – 8pm - Free rentals available!')).toBe('10:00-20:00');
        expect(t('from 11AM-1PM')).toBe('11:00-13:00');                                 // Mattamy
        expect(t('10:00 am - 10:00 pm')).toBe('10:00-22:00');                           // Mississauga
        expect(t('Noon-6 p.m.')).toBe('12:00-18:00');
        expect(t('10 a.m.-11 p.m.')).toBe('10:00-23:00');
        expect(t('9 a.m. to 12 p.m. | 3 to 7 p.m.')).toBe('09:00-12:00 15:00-19:00');   // Brampton: a bare start shares the end's half of the day
        expect(t('12 to 3 p.m. | 7 to 10 p.m.')).toBe('12:00-15:00 19:00-22:00');
        expect(t('10 - 2 PM | 6 - 10 PM')).toBe('10:00-14:00 18:00-22:00');             // unless that would start after the end
        expect(t('8 to 9:50 a.m.')).toBe('08:00-09:50');                                // Gore Meadows
        expect(t('12 to 1:50 p.m.')).toBe('12:00-13:50');
        expect(t('3pm-4pm (Adult), 4pm-5pm (All Ages)')).toBe('15:00-16:00 16:00-17:00');   // George Bell
        expect(t('7pm-8pm* (All Ages)')).toBe('19:00-20:00');
        expect(t('3-4PM')).toBe('15:00-16:00');
        expect(t('10:30am to 12noon')).toBe('10:30-12:00');                             // McCormick
        expect(t('12noon to 1:30pm')).toBe('12:00-13:30');
        expect(t('Feb 15 – 10 – 5 PM')).toBe('10:00-17:00');                            // a date glued in front of a range
        expect(t('8 p.m. to midnight')).toBe('20:00-23:59');
        for (const bad of ['Closed', '4 to 8', '13:00 - 15:00', '4:75 to 8 p.m.', '10 p.m. to 4 p.m.', '11 p.m. to 1 a.m.', 'Ages 11-14', 'OCT 11-12-13, DEC 24-25-26-31', '905-615-3200 ext. R-I-N-K (7465)', 'Schedule for November 16 to December 20, 2026', 'afternoon-6 p.m.', 'Event at 12:00pm, trail open until 9:00pm', '']) {
            expect([bad, t(bad)]).toEqual([bad, null]);
        }
        expect(V.timeRange('nothing here')).toBe(null);
        expect([V.clockTime('9:00pm'), V.clockTime('12noon'), V.clockTime('9')]).toEqual(['21:00', '12:00', null]);
    });

    test('weekday labels and dates', () => {
        const days = (text) => [...V.daySet(text)].sort();
        expect(days('Daily')).toEqual([0, 1, 2, 3, 4, 5, 6]);
        expect(days('Monday to Friday')).toEqual([1, 2, 3, 4, 5]);
        expect(days('Saturday, Sunday, Holidays')).toEqual([0, 6]);                     // "Holidays" names no weekday
        expect(days('Weekend Public Skate')).toEqual([0, 6]);
        expect(days('Friday Public Skate')).toEqual([5]);
        expect(days('Holiday Public Skate')).toEqual([]);
        expect(days('Mondays')).toEqual([1]);
        expect(V.fullDates('Fri, Nov 28, 2025 ↑ Sun, Mar 1, 2026')).toEqual(['2025-11-28', '2026-03-01']);
        expect(V.fullDates('This schedule STARTS on SEPTEMBER 8th, 2025.')).toEqual(['2025-09-08']);
        expect(V.fullDates('September 3rd 2024 - March 27th 2025')).toEqual(['2024-09-03', '2025-03-27']);
        expect(V.fullDates('February 30, 2026, Winter 2026/27, May 2026')).toEqual([]);
        expect([V.ymd(2027, 2, 28), V.ymd(2027, 2, 29), V.ymd(2028, 2, 29)]).toEqual(['2027-02-28', null, '2028-02-29']);
        expect([V.addDays('2026-12-31', 1), V.addDays('2028-02-28', 2), V.addDays('2026-03-08', -8)]).toEqual(['2027-01-01', '2028-03-01', '2026-02-28']);
        expect([V.weekdayOf('2026-11-21'), V.weekdayOf('2027-01-01')]).toEqual([6, 5]);
        expect([V.seasonYear('2026-11-21'), V.seasonYear('2027-02-01'), V.seasonYear('2027-07-01')]).toEqual([2026, 2026, 2027]);
        expect([V.inSeason(12, 19, '2026-11-21'), V.inSeason(1, 2, '2026-11-21'), V.inSeason(2, 29, '2026-11-21')]).toEqual(['2026-12-19', '2027-01-02', null]);
        const season = { from: '2025-09-08', to: '2026-04-30' };
        const closed = (text) => [...V.closureDates(text, (month, day) => V.inSpan(month, day, season))];
        expect(closed('(CLOSED ON OCT 11-12-13, DEC 24-25-26-31, JAN 1, FEB 16, APR 3-4-5)')).toEqual(['2025-10-11', '2025-10-12', '2025-10-13', '2025-12-24', '2025-12-25', '2025-12-26', '2025-12-31', '2026-01-01', '2026-02-16', '2026-04-03', '2026-04-04', '2026-04-05']);
        expect(closed('closed from December 30 to January 2')).toEqual(['2025-12-30', '2025-12-31', '2026-01-01', '2026-01-02']);
        expect(closed('DEC 24-27')).toEqual(['2025-12-24', '2025-12-25', '2025-12-26', '2025-12-27']);         // two numbers far apart: the cautious reading
        expect(closed('Arena closed for renovations')).toEqual([]);
    });

    test('markup: comments, scripts and hidden characters never reach the text', () => {
        expect(V.visibleHtml('a<!-- <div id="x">old</div> -->b<script>var s = "<!--";</script>c<!-->d<style>p{}</style>e<!-- never closed')).toBe('a b c d e ');
        expect(V.plain('<td>Skate Rentals and Concessions <strong><em>not available</em></strong>.</td>')).toBe('Skate Rentals and Concessions not available.');
        expect(V.plain(`a&nbsp;b &amp;nbsp; &#8211; &#x2019; &bogus; ${ZERO_WIDTH}x${ZERO_WIDTH}<br/>y`)).toBe('a b &nbsp; – ’ &bogus; x y');
        expect(V.lines('<p>one<br>two</p><div>three</div><p>&nbsp;</p>')).toEqual(['one', 'two', 'three']);
        // a "<" that meets another "<" before any ">" is text, not the start of a tag that swallows the page
        expect(V.plain('3 < 4 and 5 > 2, <b>bold</b>')).toBe('3 < 4 and 5 > 2, bold');
        expect(V.plain('<div class="a" <p>kept</p>')).toBe('<div class="a" kept');
        expect(V.plain('<<<<<<p>still read</p>')).toBe('<<<<< still read');
        expect(['Free admission every day!', 'The Rink will open for the season when cooler weather permits.', 'The rink opens November 20 (weather permitting)', 'The rink is closed for the season.', 'Closed today due to rain', 'Skate rentals available'].map(V.rinkWording))
            .toEqual(['open', 'later', 'later', 'closed', 'shut', null]);
    });
});
