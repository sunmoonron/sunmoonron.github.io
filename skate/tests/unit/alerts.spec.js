// Alert logic, checked in plain Node (no browser): the app's classifier
// (skate/projects/js/alerts.js) and the pipeline's alert reader
// (fetch-skate-data.js), against alert-corpus.json.
//
// alert-corpus.json is every distinct alert the City's feed carried from
// 2026-07-16 to 2026-11-11 (96 of them). The 35 with real sentences carry a
// hand label (`gold`: what the alert means for skating, the day to judge it
// on, and its last day where the text fixes one) and the raw answer Claude
// Haiku 5.5 gave when the reader was first run (`haiku`). A new misread in
// the wild belongs here: add the alert, label it, and both readers are held
// to it from then on.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const corpus = require('./alert-corpus.json');
const labelled = corpus.filter(r => r.gold);

// alerts.js is a browser script: give it the two globals it looks up at call time
let RINK = null, TODAY = '2026-11-11';
global.window = { SkateTime: { todayKey: () => TODAY }, SkateGeo: { rinkByLocation: () => RINK } };
const SA = require('../../projects/js/alerts.js');
const H = SA._classifyHelpers;
const pipe = require('../../../fetch-skate-data.js');

/** The banner one alert alone gives a session at its rink on `day`. */
function verdict(alert, rink, day, { start = '12:00', end = '13:00', today = '2026-11-11' } = {}) {
    RINK = rink; TODAY = today;
    H.index([alert]);
    return SA.forProgram({ 'Location ID': alert.LocationID, 'Start Date': day, 'Start Time': start, 'End Time': end, Source: 'city' });
}
/** A banner as one of the reader's words, so it can be compared with a label. */
const meaning = (v) => !v ? 'none' : v.level === 'closed' ? 'off' : v.kind === 'pad' ? 'one_pad_off' : v.kind === 'reduced' ? 'reduced' : v.kind === 'building' ? 'on' : v.kind === 'alert' ? 'unknown' : v.kind;
const padsOf = (rec) => (rec.rink && rec.rink.pads) || 1;
const withReading = (rec) => {
    const v = pipe.verifyReading(rec.alert, rec.rink, rec.haiku, { by: 'claude-haiku-5-5' });
    return { ...rec.alert, Read: v.read };
};
const find = (needle) => corpus.find(r => String(r.alert.Comments).includes(needle));
const tag = (rec) => `#${rec.id} ${rec.alert.AssetName}`;

test.describe('word rules, the floor every alert can fall back to', () => {
    test('an alert that takes skating away is never read as less, on the day it applies', () => {
        for (const rec of labelled.filter(r => !r.gold.skating.includes('on'))) {
            expect(rec.gold.skating, tag(rec)).toContain(meaning(verdict({ ...rec.alert }, rec.rink, rec.gold.day)));
        }
    });
    test('a notice that leaves skating alone is never shown as a closure or a closed pad', () => {
        for (const rec of labelled.filter(r => r.gold.skating.includes('on'))) {
            expect(['on', 'unknown', 'none'], tag(rec)).toContain(meaning(verdict({ ...rec.alert }, rec.rink, rec.gold.day)));
        }
    });
    test('the last day of every alert whose words fix one', () => {
        const dated = labelled.filter(r => r.gold.ends);
        expect(dated.length).toBe(15);
        for (const rec of dated) expect(H.ruleReading(rec.alert, padsOf(rec)).ends, tag(rec)).toBe(rec.gold.ends);
    });
    test('a month and a year is not a day of that month', () => {
        expect(SA.dateWindows('From November 2025 to December 2027, the centre will undergo improvements.', '2026-10-09')).toEqual([]);
        expect(H.datesIn('The facility will be closed November 4,2026.', '2026-11-02')).toEqual({ starts: '2026-11-04', ends: '2026-11-04' });
    });
    test('reopening words end the alert the day before; "tomorrow" and "today" count from the posting day', () => {
        expect(H.datesIn('We anticipate re-opening on Monday, September 28,2026.', '2026-09-26').ends).toBe('2026-09-27');
        expect(H.datesIn('The ice rink will have a delayed opening of Friday October 16, 2026.', '2026-10-05').ends).toBe('2026-10-15');
        expect(H.datesIn('Central Arena remains closed. We anticipate re-opening tomorrow morning at 6am.', '2026-09-30').ends).toBe('2026-09-30');
        expect(H.datesIn('Leisure Skate is cancelled today due to a mechanical issue.', '2025-10-15')).toEqual({ starts: '2025-10-15', ends: '2025-10-15' });
        expect(H.datesIn('Closed until January 3 for the holidays.', '2026-12-28').ends).toBe('2027-01-03');
        expect(H.datesIn('Closed until further notice.', '2026-11-01')).toEqual({ starts: null, ends: null });
    });
});

test.describe('readings from the pipeline', () => {
    test('every recorded Haiku answer passes verification against its alert', () => {
        expect(labelled.length).toBe(35);
        for (const rec of labelled) {
            const v = pipe.verifyReading(rec.alert, rec.rink, rec.haiku, { by: 'claude-haiku-5-5' });
            expect(v.ok, `${tag(rec)}: ${v.why}`).toBe(true);
            expect(v.read.v).toBe(pipe.READER_VERSION);
        }
    });
    test('with the reading attached, the app shows what the label says for all 35', () => {
        for (const rec of labelled) {
            expect(rec.gold.skating, tag(rec)).toContain(meaning(verdict(withReading(rec), rec.rink, rec.gold.day)));
        }
    });
    test('the last day, wherever the alert takes skating away', () => {
        for (const rec of labelled.filter(r => r.gold.ends && !r.gold.skating.includes('on'))) {
            expect(H.readingFor(withReading(rec), padsOf(rec)).ends, tag(rec)).toBe(rec.gold.ends);
        }
    });
    test('an alert about part of the day only touches sessions in those hours', () => {
        const rec = find('Leisure Skate from 11:30am-1:30pm is cancelled today');
        const a = withReading(rec);
        expect([a.Read.timeFrom, a.Read.timeTo]).toEqual(['11:30', '13:30']);
        expect(verdict(a, rec.rink, '2025-10-15', { start: '12:00', end: '13:00' }).level).toBe('closed');
        const evening = verdict(a, rec.rink, '2025-10-15', { start: '19:00', end: '20:00' });
        expect([evening.level, evening.kind]).toEqual(['note', 'other-hours']);
        expect(verdict(a, rec.rink, '2025-10-16')).toMatchObject({ level: 'note', kind: 'ended' });
        expect(verdict(a, rec.rink, '2025-11-15')).toBeNull();
    });
    test('a reading of another version, or without a known answer, is ignored', () => {
        const rec = find('Arenas both are closed');
        expect(H.readingFor({ ...rec.alert, Read: { v: 99, skating: 'on' } }, 2).by).toBe('rules');
        expect(H.readingFor({ ...rec.alert, Read: { v: 1, skating: 'maybe' } }, 2).by).toBe('rules');
    });
    test('the City\'s closed flag on a rink asset is never read down to "skating as usual"', () => {
        const a = { LocationID: 1, AssetName: 'Test Arena - Indoor Ice Rink', Type: 'Indoor Ice Rink', Status: 0, Reason: 'Unplanned Closure', Comments: 'Please check back for updates on the arena.', PostedDate: '2026-11-10 09:00:00',
            Read: { v: 1, skating: 'on', about: 'other', starts: null, ends: null } };
        expect(verdict(a, { pads: 1, kinds: ['indoor'] }, '2026-11-11').level).toBe('closed');
        expect(pipe.verifyReading(a, { pads: 1, kinds: ['indoor'] }, { skating: 'on', about: 'other', starts: null, ends: null, time_from: null, time_to: null, seasonal: false, evidence: 'check back for updates' }).ok).toBe(false);
    });
});

test.describe('the two cards of 2026-11-11', () => {
    test('a washroom notice that names a room "Upper Ice Galaxy" is a grey building notice', () => {
        const rec = find('Upper Ice Galaxy');
        for (const a of [{ ...rec.alert }, withReading(rec)]) {
            const v = verdict(a, rec.rink, '2026-11-11');
            expect(v).toMatchObject({ level: 'note', kind: 'building', padOnly: false, lead: 'Building notice, skating not affected' });
            expect(v.text).toContain('Main Lobby Washrooms');
            RINK = rec.rink; TODAY = '2026-11-11'; H.index([a]);
            expect(SA.forLocation(a.LocationID)).toEqual([]);          // and it does not flag the rink in the list
        }
    });
    test('"Arenas both are closed till further notice" cancels for the week after it is posted; later it is Call to confirm, never silence', () => {
        const rec = find('Arenas both are closed');
        expect(rec.rink.pads).toBe(2);
        for (const a of [{ ...rec.alert }, withReading(rec)]) {
            for (const day of ['2026-11-10', '2026-11-11']) {
                expect(verdict(a, rec.rink, day), day).toMatchObject({ level: 'closed', lead: 'Likely cancelled, rink alert' });
            }
            // v3.18: weeks on, with no end named and the session still on the City's schedule, it is not our call
            const later = verdict(a, rec.rink, '2026-12-20');
            expect(later).toMatchObject({ level: 'warning', kind: 'unconfirmed', lead: 'Call to confirm' });
            expect(later.text).toContain('has not updated it since');
            expect(later.text).toContain('Call the rink');
        }
    });
});

test.describe('"closed for the season" notices', () => {
    const park = { name: 'Test Park', pads: 1, kinds: ['outdoor'] };
    const notice = (posted, over = {}) => ({ LocationID: 1, AssetID: 1, AssetName: 'Test Park - Outdoor Artificial Ice Rink', Type: 'Outdoor Artificial Ice Rink', Category: 'Skate',
        Status: 0, Reason: 'Closed for the Season', Comments: '', PostedDate: `${posted} 09:00:00`, ...over });

    test('a notice from last winter cancels that winter and only notes the next one', () => {
        const a = notice('2026-03-09');
        expect(verdict(a, park, '2026-03-20').level).toBe('closed');
        expect(verdict(a, park, '2026-11-28', { today: '2026-11-11' })).toMatchObject({ level: 'note', kind: 'season', lead: 'Closed-for-the-season notice still up' });
        expect(verdict(a, park, '2026-12-19', { today: '2026-11-11' }).level).toBe('note');
    });
    test('still posted on the day itself, it is a yellow warning, not a strike-through', () => {
        expect(verdict(notice('2026-03-09'), park, '2026-11-28', { today: '2026-11-28' })).toMatchObject({ level: 'warning', kind: 'season-today' });
    });
    test('re-stamped in the off-season (the City did this on 2026-09-16), it is still last season\'s notice', () => {
        for (const posted of ['2026-07-02', '2026-09-16', '2026-11-20']) expect(verdict(notice(posted), park, '2026-11-28').level, posted).toBe('note');
    });
    test('posted once the ice is in, it closes that season, and only that one', () => {
        const a = notice('2026-12-10', { Comments: 'Closed for the season due to a compressor failure.' });
        expect(verdict(a, park, '2027-01-15', { today: '2026-12-11' }).level).toBe('closed');
        expect(verdict(a, park, '2027-03-14', { today: '2026-12-11' }).level).toBe('closed');
        expect(verdict(a, park, '2027-11-27', { today: '2027-11-01' }).level).toBe('note');
    });
    test('"for the remainder of the season" is about the season in progress', () => {
        const rec = find('closed for the remainder of the season');
        expect(verdict({ ...rec.alert }, rec.rink, '2026-03-01').level).toBe('closed');
        expect(verdict(withReading(rec), rec.rink, '2026-03-01').level).toBe('closed');
        expect(verdict(withReading(rec), rec.rink, '2026-12-05').level).toBe('note');
    });
    test('the same holds every year, with nothing to update', () => {
        for (let y = 2026; y <= 2035; y++) {
            const a = notice(`${y}-03-15`);
            expect(verdict(a, park, `${y}-03-20`, { today: `${y}-03-16` }).level, `spring ${y}`).toBe('closed');
            expect(verdict(a, park, `${y}-11-28`, { today: `${y}-11-10` }).level, `fall ${y}`).toBe('note');
            expect(verdict(a, park, `${y + 1}-01-10`, { today: `${y}-11-10` }).level, `winter ${y}`).toBe('note');
        }
    });
    test('indoor ice has its own lull: a spring notice does not cancel the fall', () => {
        const a = notice('2026-04-20', { AssetName: 'Test Arena - Indoor Ice Rink', Type: 'Indoor Ice Rink' });
        const arena = { name: 'Test Arena', pads: 1, kinds: ['indoor'] };
        expect(verdict(a, arena, '2026-05-02', { today: '2026-04-21' }).level).toBe('closed');
        expect(verdict(a, arena, '2026-09-20', { today: '2026-09-01' }).level).toBe('note');
        expect(verdict(a, arena, '2026-09-20', { today: '2026-09-20' }).level).toBe('warning');   // still up on the day
    });
    test('an outdoor notice at a location with other ice never goes past a note', () => {
        const v = verdict(notice('2026-03-09'), { name: 'Test Centre', pads: 1, kinds: ['indoor'] }, '2026-11-28', { today: '2026-11-28' });
        expect(v).toMatchObject({ level: 'note', kind: 'season' });
    });
    test('the district\'s outdoor-rinks notice on an indoor arena says the arena is fine (Moss Park, 2026-11-17)', () => {
        // the City posts one "Toronto and East York Outdoor Rinks" notice on every location in the district
        const district = { LocationID: 3491, AssetID: 9, AssetName: 'Toronto and East York Outdoor Rinks', Type: 'outdoor rink', Status: 0,
            Reason: 'Closed for the Season', Comments: '', PostedDate: '2026-11-17 06:17:17' };
        const arena = { name: 'Moss Park Arena', pads: 1, kinds: ['indoor'] };
        const v = verdict(district, arena, '2026-11-19', { today: '2026-11-19' });
        expect(v).toMatchObject({ level: 'note', kind: 'season', lead: 'Only outdoor rinks are closed for the season' });
        expect(v.text).toMatch(/^The City's notice on Tue, Nov 17(, 2026)? is for Toronto and East York Outdoor Rinks\. Indoor skating here is not affected\.$/);
        expect(`${v.lead} ${v.text}`).not.toMatch(/still marked|before this season/i);
        // and in Rinks & map it does not flag the arena at all
        RINK = arena; TODAY = '2026-11-19';
        H.index([district]);
        expect(SA.forLocation('3491')).toEqual([]);
        // a place with both kinds of ice is told which one is closed
        const both = verdict(district, { name: 'Both Centre', pads: 2, kinds: ['indoor', 'outdoor'] }, '2026-11-26', { today: '2026-11-19' });
        expect(both).toMatchObject({ level: 'note', lead: 'Only the outdoor rink here is closed for the season' });
        expect(both.text).toMatch(/^Sessions on the indoor ice are not affected\. The City posted the notice on Tue, Nov 17(, 2026)?\.$/);
        // the outdoor rinks themselves still get the warning on the day
        expect(verdict(district, park, '2026-11-19', { today: '2026-11-19' })).toMatchObject({ level: 'warning', kind: 'season-today', lead: 'Still marked closed for the season' });
    });
    test('none of the 50-odd notices on file from last season strikes through opening day', () => {
        const old = corpus.filter(r => /season/i.test(`${r.alert.Reason} ${r.alert.Comments}`) && String(r.alert.PostedDate) < '2026-12-01');
        expect(old.length).toBeGreaterThan(45);
        for (const rec of old) {
            const v = verdict({ ...rec.alert }, rec.rink, '2026-11-28', { today: '2026-11-11' });
            expect(v && v.level, tag(rec)).toBe('note');
        }
    });
});

test.describe('where and when an alert applies', () => {
    const closed = (over = {}) => ({ LocationID: 1, AssetID: 1, AssetName: 'Test Arena - Indoor Ice Rink', Type: 'Indoor Ice Rink', Category: 'Skate', Status: 0,
        Reason: 'Unplanned Closure', Comments: 'The arena is closed until further notice.', PostedDate: '2026-10-01 09:00:00', ...over });

    test('one kind of ice closed at a place with both: closed while only that kind has ice, a warning in winter', () => {
        const both = { name: 'Two Rinks', pads: 3, kinds: ['indoor', 'outdoor'] };
        expect(verdict(closed(), both, '2026-10-02').level).toBe('closed');                                   // no outdoor ice in October (the day after the notice)
        const winter = verdict(closed(), both, '2027-01-10');
        expect(winter).toMatchObject({ level: 'warning', kind: 'part' });
        expect(winter.lead).toContain('indoor rink here is closed');
    });
    test('a location the rink list does not know is not hard-cancelled by one kind', () => {
        expect(verdict(closed(), null, '2026-10-10')).toMatchObject({ level: 'warning', lead: 'Service alert at this rink' });
    });
    test('one pad of several is a pad warning; the same words at a one-pad rink are a closure', () => {
        const a = closed({ Status: 2, Reason: 'Maintenance/Repairs', Comments: 'Rink 1 is currently closed due to mechanical issues. Please check back for any updates.' });
        expect(verdict(a, { pads: 2, kinds: ['indoor'] }, '2026-10-02')).toMatchObject({ level: 'warning', kind: 'pad', padOnly: true });
        expect(verdict(a, { pads: 1, kinds: ['indoor'] }, '2026-10-02').level).toBe('closed');
    });
    test('an alert for a later day says nothing before it, and ends by its own words', () => {
        const rec = find('the facility will be closed November 4,2026');
        expect(verdict({ ...rec.alert }, rec.rink, '2026-11-03')).toBeNull();
        expect(verdict({ ...rec.alert }, rec.rink, '2026-11-04').level).toBe('closed');
        expect(verdict({ ...rec.alert }, rec.rink, '2026-11-06').level).toBe('note');
        expect(verdict({ ...rec.alert }, rec.rink, '2026-11-20')).toBeNull();
    });
    test('reduced hours are a warning, not a cancellation', () => {
        const rec = find('public skating hours are reduced');
        expect(verdict({ ...rec.alert }, rec.rink, '2026-09-22')).toMatchObject({ level: 'warning', kind: 'reduced' });
    });
    test('an alert the rules cannot place is still shown, as a plain service alert', () => {
        const a = closed({ Status: 2, Reason: 'Technical Issues', Comments: 'Please note the building is experiencing cooler than normal temperatures.' });
        expect(verdict(a, { pads: 1, kinds: ['indoor'] }, '2026-10-02')).toMatchObject({ level: 'warning', kind: 'alert', lead: 'Service alert at this rink' });
    });
    test('age alone never silences an alert: "until further notice" from a year ago still shows, as Call to confirm (v3.18)', () => {
        const v = verdict(closed({ PostedDate: '2025-10-01 09:00:00' }), { pads: 1, kinds: ['indoor'] }, '2026-11-11');
        expect(v).toMatchObject({ level: 'warning', kind: 'unconfirmed', lead: 'Call to confirm' });
        expect(v.text).toContain('The arena is closed until further notice.');
    });
    test('a closure that names its end is taken at its word however old; one with no end is, for 48 hours', () => {
        const rink = { pads: 1, kinds: ['indoor'] };
        const dated = closed({ Comments: 'The arena is closed until December 15, 2026 for repairs.' });
        expect(verdict(dated, rink, '2026-12-01').level).toBe('closed');                                      // two months after posting, inside its own dates
        expect(verdict(dated, rink, '2026-12-17')).toMatchObject({ level: 'note', kind: 'ended' });           // past its own end: a heads-up, not a closure
        const open = closed();                                                                                 // posted Oct 1, 9:00 am
        expect(verdict(open, rink, '2026-10-02').level).toBe('closed');                                       // 27 hours on
        expect(verdict(open, rink, '2026-10-03', { start: '08:00', end: '09:00' }).level).toBe('closed');     // 47 hours on
        expect(verdict(open, rink, '2026-10-03', { start: '10:00', end: '11:00' }).kind).toBe('unconfirmed'); // 49 hours on
        expect(verdict(open, rink, '2026-10-20').kind).toBe('unconfirmed');
    });
});

test.describe('the pipeline\'s alert reader', () => {
    const rink = { name: 'Test Arena', pads: 2, kinds: ['indoor'] };
    const a = { LocationID: 9, AssetName: 'Test Arena - Indoor Ice Rink', Type: 'Indoor Ice Rink', Status: 2, Reason: 'Maintenance/Repairs',
        Comments: 'Rink 2 is closed from 1pm to 3pm today for board repairs and will reopen on Friday November 13, 2026. Rink 1 is open as usual.', PostedDate: '2026-11-10 09:00:00' };
    const answer = (over = {}) => ({ skating: 'one_pad_off', about: 'ice', starts: '2026-11-10', ends: '2026-11-12', time_from: null, time_to: null, seasonal: false, evidence: 'Rink 2 is closed', ...over });

    test('a good answer becomes a reading in the shape the app expects', () => {
        const v = pipe.verifyReading(a, rink, answer(), { by: 'claude-haiku-5-5' });
        expect(v).toMatchObject({ ok: true, quote: 'Rink 2 is closed' });
        expect(v.read).toEqual({ v: 1, skating: 'one_pad_off', about: 'ice', starts: '2026-11-10', ends: '2026-11-12', timeFrom: null, timeTo: null, seasonal: false, by: 'claude-haiku-5-5' });
    });
    test('evidence that is not a quote from the alert sinks the whole answer', () => {
        expect(pipe.verifyReading(a, rink, answer({ evidence: 'the whole arena is closed' }))).toMatchObject({ ok: false });
        expect(pipe.verifyReading(a, rink, answer({ evidence: '' })).ok).toBe(false);
        expect(pipe.verifyReading(a, rink, answer({ skating: 'shut' })).ok).toBe(false);
        expect(pipe.verifyReading(a, rink, null).ok).toBe(false);
    });
    test('a date or a time the words do not back is dropped, not guessed', () => {
        expect(pipe.verifyReading(a, rink, answer({ ends: '2026-12-25' })).read.ends).toBeNull();
        expect(pipe.verifyReading(a, rink, answer({ starts: '2026-11-01' })).read.starts).toBeNull();
        expect(pipe.verifyReading(a, rink, answer({ ends: 'next Friday' })).read.ends).toBeNull();
        expect(pipe.verifyReading(a, rink, answer({ time_from: '13:00', time_to: '15:00' })).read).toMatchObject({ timeFrom: '13:00', timeTo: '15:00' });
        expect(pipe.verifyReading(a, rink, answer({ time_from: '09:00', time_to: '15:00' })).read).toMatchObject({ timeFrom: null, timeTo: null });
    });
    test('one pad of one is the rink, and "seasonal" needs the word', () => {
        expect(pipe.verifyReading(a, { name: 'One Pad', pads: 1, kinds: ['indoor'] }, answer()).read.skating).toBe('off');
        expect(pipe.verifyReading(a, rink, answer({ seasonal: true })).read.seasonal).toBe(false);
    });
    test('a reader whose dates are not trusted hands the dates to the app\'s rules', () => {
        const v = pipe.verifyReading(a, rink, answer(), { by: 'qwen3.5:4b', trustDates: false });
        expect(v.read).toMatchObject({ skating: 'one_pad_off', starts: null, ends: null, dates: 'rules' });
        const R = H.readingFor({ ...a, Read: v.read }, 2);
        expect([R.skating, R.by, R.ends]).toEqual(['one_pad_off', 'qwen3.5:4b', '2026-11-12']);
    });
    test('one call per distinct notice: the key ignores which rink it is pasted on', () => {
        const other = { ...a, LocationID: 77, AssetName: 'Other Arena - Indoor Ice Rink' };
        expect(pipe.readerKey(a, true)).toBe(pipe.readerKey(other, true));
        expect(pipe.readerKey(a, true)).not.toBe(pipe.readerKey(a, false));
        expect(pipe.readerKey(a, true)).not.toBe(pipe.readerKey({ ...a, PostedDate: '2026-11-11 09:00:00' }, true));
        expect(pipe.readerKey(a, true)).not.toBe(pipe.readerKey({ ...a, Comments: a.Comments + ' Thank you.' }, true));
    });
    test('a bare status needs no model; sentences do', () => {
        expect(pipe.readerWants({ Comments: '' })).toBe(false);
        expect(pipe.readerWants({ Comments: 'Closed.' })).toBe(false);
        expect(pipe.readerWants(a)).toBe(true);
        expect(corpus.filter(r => pipe.readerWants(r.alert)).length).toBeLessThan(60);
    });
    test('keys are found in a credentials file of any layout, and never survive into a log line', () => {
        const fakeKey = 'sk-ant-usr-' + 'A1b2'.repeat(12), fakeWs = 'wrkspc_' + '01AbCdEf'.repeat(3), fakeOr = 'sk-or-v1-' + 'c0ffee'.repeat(10);
        const file = path.join(os.tmpdir(), `reader-creds-${process.pid}.txt`);
        fs.writeFileSync(file, `my key: ${fakeKey}\n${fakeWs}\nsomething else: ${fakeOr}\n`);
        const saved = { ...process.env };
        try {
            for (const k of Object.keys(process.env)) if (k.startsWith('ALERT_READER_')) delete process.env[k];
            delete process.env.OLLAMA_URL;
            delete process.env.CREDENTIALS_DIRECTORY;
            expect(pipe.readerTiers().map(t => t.name)).toEqual([]);
            process.env.ALERT_READER_CREDENTIALS = file;
            expect(pipe.readerCreds()).toEqual({ anthropicKey: fakeKey, anthropicWorkspace: fakeWs });
            expect(pipe.readerTiers().map(t => t.name)).toEqual(['anthropic']);            // one paid route; no second provider
            process.env.ALERT_READER_CREDENTIALS = file + '.missing';
            expect(pipe.readerTiers()).toEqual([]);
            // a systemd credential named "alert-reader" is found without any other setting; an empty one means no tier
            const credDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-cred-'));
            delete process.env.ALERT_READER_CREDENTIALS;
            process.env.CREDENTIALS_DIRECTORY = credDir;
            fs.writeFileSync(path.join(credDir, 'alert-reader'), '');
            expect(pipe.readerTiers()).toEqual([]);
            fs.writeFileSync(path.join(credDir, 'alert-reader'), `${fakeWs} ${fakeKey}`);
            expect(pipe.readerTiers().map(t => t.name)).toEqual(['anthropic']);
            fs.rmSync(credDir, { recursive: true });
            delete process.env.CREDENTIALS_DIRECTORY;
            // the local model is opt-in for alerts: a model URL alone does not make it a tier
            process.env.OLLAMA_URL = 'http://127.0.0.1:9';
            expect(pipe.readerTiers()).toEqual([]);
            process.env.ALERT_READER_LOCAL = '1';
            expect(pipe.readerTiers().map(t => t.name)).toEqual(['local']);
        } finally {
            process.env = saved;
            fs.unlinkSync(file);
        }
        const line = pipe.readerScrub(`HTTP 401 bad key ${fakeKey} in ${fakeWs} or ${fakeOr}`);
        expect(line).not.toContain(fakeKey.slice(0, 20));
        expect(line).not.toContain(fakeWs);
        expect(line).not.toContain(fakeOr.slice(0, 20));
    });
    test('errors are sorted into the ones that need a human and the ones that pass', () => {
        expect([401, 403, 402, 429, 500, 529, 400].map(s => pipe.readerErrorKind(s, ''))).toEqual(['auth', 'auth', 'billing', 'rate', 'server', 'server', 'request']);
        expect(pipe.readerErrorKind(400, 'Your credit balance is too low to access the Anthropic API')).toBe('billing');
    });
    test('the schema asks for every field and nothing else', () => {
        expect(pipe.READER_SCHEMA.additionalProperties).toBe(false);
        expect([...pipe.READER_SCHEMA.required].sort()).toEqual(Object.keys(pipe.READER_SCHEMA.properties).sort());
    });
});

test.describe('indoor or outdoor, for a rink the City\'s datasets do not list', () => {
    test('a park is outdoor until something says otherwise; evidence is remembered', () => {
        expect(pipe.inferKinds({ locationType: 'park' })).toEqual({ kinds: ['outdoor'], kindsSeen: [] });
        expect(pipe.inferKinds({ locationType: 'crc' })).toEqual({ kinds: ['indoor'], kindsSeen: [] });
        expect(pipe.inferKinds({ locationType: 'crc', feedKinds: ['outdoor'] })).toEqual({ kinds: ['outdoor'], kindsSeen: ['outdoor'] });   // North Toronto's outdoor rink
        expect(pipe.inferKinds({ locationType: 'park', lullSession: true })).toEqual({ kinds: ['indoor'], kindsSeen: ['indoor'] });        // skating in a park in early November
        expect(pipe.inferKinds({ locationType: 'crc', kindsSeen: ['outdoor'] }).kinds).toEqual(['outdoor']);                                   // the notice was lifted; we still know
        expect(pipe.inferKinds({ locationType: 'park', kindsSeen: ['outdoor'], lullSession: true }).kinds).toEqual(['indoor', 'outdoor']);
    });
    test('the lull is mid-April to mid-November', () => {
        expect(['2026-04-14', '2026-04-15', '2026-07-01', '2026-11-14', '2026-11-15', '2027-01-10'].map(pipe.inOutdoorLull)).toEqual([false, true, true, true, false, false]);
    });
});

// v3.26: opening day of the outdoor season (2026-11-28), gone through rink by rink against the City's own
// alerts page. Three things the app said that the City's words did not support, each pinned here.
test.describe('opening day, checked against the City rink by rink', () => {
    const at = (alerts, rink, title, day, start, today) => {
        RINK = rink; TODAY = today || day;
        H.index([].concat(alerts));
        const first = [].concat(alerts)[0];
        return SA.forProgram({ 'Location ID': first.LocationID, 'Course Title': title, 'Start Date': day, 'Start Time': start, 'End Time': '22:00', Source: 'city' });
    };
    const twoPads = { pads: 2, kinds: ['outdoor'] }, onePad = { pads: 1, kinds: ['outdoor'] };
    const greenwood = (extra = {}) => ({ LocationID: 70, AssetID: 14280, AssetName: 'Greenwood Park - Outdoor Artificial Ice Rink', Reason: 'Leisure Closed, Hockey Pad Open',
        Comments: 'Ice Maintenance in progress.', Status: 2, Category: 'Skate', Type: 'Outdoor Ice Rink', DisplayAlertName: '', PostedDate: '2026-11-28 07:27:32', ...extra });
    const modelRead = { v: 1, skating: 'one_pad_off', about: 'ice', starts: '2026-11-28', ends: null, timeFrom: null, timeTo: null, seasonal: false, by: 'claude-haiku-5-5' };

    test('which pad the words name', () => {
        const named = (Reason, Comments = '') => H.padNamed({ Reason, Comments });
        expect(named('Leisure Closed, Hockey Pad Open')).toEqual({ closed: 'leisure', open: 'hockey' });
        expect(named('Hockey Closed, Leisure Pad Open')).toEqual({ closed: 'hockey', open: 'leisure' });
        expect(named('Maintenance/Repairs', 'The hockey pad is closed for repairs. The leisure pad remains open.')).toEqual({ closed: 'hockey', open: 'leisure' });
        expect(named('Ice Conditions', 'Pleasure pad closed until further notice.')).toEqual({ closed: 'leisure', open: null });
        expect(named('Ice Conditions', 'Leisure pad closed. Hockey pad closed.')).toBeNull();                       // both: the whole rink
        expect(named('Maintenance/Repairs', 'Rink 2 is closed.')).toBeNull();                                       // a pad, but not said which kind
        expect(named('Technical Issues', 'Leisure Skate from 11:30am-1:30pm is cancelled today.')).toBeNull();      // a session, not a pad
        expect(named('Ice Conditions', 'The leisure pad is not closed.')).toBeNull();
        expect(H.padOfProgram({ 'Course Title': 'Shinny: Child with Caregiver' })).toBe('hockey');
        expect(H.padOfProgram({ 'Course Title': 'Pick Up Hockey: Adults' })).toBe('hockey');
        expect(H.padOfProgram({ 'Course Title': 'Ringette' })).toBe('hockey');
        expect(H.padOfProgram({ 'Course Title': 'Leisure Skate (Unsupervised)' })).toBe('leisure');
        expect(H.padOfProgram({ 'Course Title': 'Ice Breakdancing' })).toBe('leisure');
    });

    for (const [how, Read] of [['read by the model as "one pad off"', modelRead], ['read by the word rules alone', undefined]]) {
        test(`"Leisure Closed, Hockey Pad Open" (${how}): the Leisure Skate is off, the shinny is not`, () => {
            const a = greenwood(Read ? { Read } : {});
            const leisure = at(a, twoPads, 'Leisure Skate', '2026-11-28', '09:00');
            expect(leisure).toMatchObject({ level: 'closed', kind: 'pad-closed', lead: 'Likely cancelled: the leisure pad is closed', reason: 'Leisure Closed, Hockey Pad Open' });
            expect(leisure.text).toContain('Ice Maintenance in progress.');
            const shinny = at(a, twoPads, 'Shinny: Youth', '2026-11-28', '11:00');
            expect(shinny).toMatchObject({ level: 'note', kind: 'pad-other', lead: 'The leisure pad here is closed. The City says the hockey pad is open' });
            expect(shinny.text).toBe('The City\'s notice: “Leisure Closed, Hockey Pad Open. Ice Maintenance in progress.”');
        });
    }

    test('the other way round, and when the open pad is not mentioned', () => {
        const a = greenwood({ Reason: 'Hockey Closed, Leisure Pad Open' });
        expect(at(a, twoPads, 'Shinny (Women)', '2026-11-28', '09:00')).toMatchObject({ level: 'closed', kind: 'pad-closed', lead: 'Likely cancelled: the hockey pad is closed' });
        expect(at(a, twoPads, 'Leisure Skate', '2026-11-28', '09:00')).toMatchObject({ level: 'note', kind: 'pad-other', lead: 'The hockey pad here is closed. The City says the leisure pad is open' });
        const b = greenwood({ Reason: 'Ice Conditions', Comments: 'Hockey pad closed.' });
        expect(at(b, twoPads, 'Leisure Skate', '2026-11-28', '09:00')).toMatchObject({ level: 'note', kind: 'pad-other', lead: 'The hockey pad here is closed. This session is on the leisure pad' });
    });

    test('left up for more than 48 hours with no end, it is "Call to confirm" for that pad and still a note for the other', () => {
        const a = greenwood({ Read: modelRead });
        expect(at(a, twoPads, 'Leisure Skate', '2026-11-30', '12:00')).toMatchObject({ level: 'warning', kind: 'unconfirmed', lead: 'Call to confirm' });
        expect(at(a, twoPads, 'Leisure Skate', '2026-11-30', '07:00')).toMatchObject({ level: 'closed', kind: 'pad-closed' });      // 47.5 hours on
        expect(at(a, twoPads, 'Shinny: Adult', '2026-11-30', '19:00')).toMatchObject({ level: 'note', kind: 'pad-other' });
    });

    test('a pad is shut and nothing says which: the session "may be affected", never "likely runs"', () => {
        const a = { LocationID: 9, AssetName: 'Twin Arena - Indoor Ice Rink', Reason: 'Maintenance/Repairs', Comments: 'Rink 2 is closed for repairs.', Status: 2, Category: 'Skate', Type: 'Indoor Ice Rink', PostedDate: '2026-11-28 08:00:00' };
        const v = at(a, { pads: 2, kinds: ['indoor'] }, 'Leisure Skate', '2026-11-28', '13:00');
        expect(v).toMatchObject({ level: 'warning', kind: 'pad', padOnly: true, lead: 'One pad is closed here. This session may be affected' });
    });

    test('"Closed for the Season" posted this morning closes today; an old one is still only "marked closed"', () => {
        const fresh = { LocationID: 1860, AssetID: 1, AssetName: 'Sherbourne Common - Outdoor Artificial Ice Rink', Reason: 'Closed for the Season', Comments: '', Status: 0, Category: 'Skate', Type: 'Outdoor Ice Rink', PostedDate: '2026-11-28 07:34:10' };
        expect(at(fresh, onePad, 'Leisure Skate (Unsupervised)', '2026-11-28', '10:00')).toMatchObject({ level: 'closed', kind: 'closed', lead: 'Likely cancelled, rink alert' });
        expect(at(fresh, onePad, 'Leisure Skate (Unsupervised)', '2026-11-30', '07:00', '2026-11-28')).toMatchObject({ level: 'closed' });                 // inside 48 hours
        expect(at(fresh, onePad, 'Leisure Skate (Unsupervised)', '2026-11-30', '10:00', '2026-11-30')).toMatchObject({ level: 'warning', kind: 'season-today' });   // past them, on the day
        expect(at(fresh, onePad, 'Leisure Skate (Unsupervised)', '2026-12-05', '10:00', '2026-11-28')).toMatchObject({ level: 'note', kind: 'season' });            // next week: a grey note
        const old = { ...fresh, LocationID: 1089, AssetName: 'Nathan Phillips Square - Outdoor Artificial Ice Rink', Comments: 'Ice not safe for skating', PostedDate: '2026-05-19 11:08:00' };
        const v = at(old, onePad, 'Leisure Skate (Unsupervised)', '2026-11-28', '10:00');
        expect(v).toMatchObject({ level: 'warning', kind: 'season-today', lead: 'Still marked closed for the season' });
        expect(v.text).toBe('The City posted that notice on Tue, May 19 and has not lifted it. If the rink has not reopened yet, this session will not run.');
    });

    test('a rink still marked closed for the season says so first, whatever else is posted there', () => {
        const season = { LocationID: 2155, AssetID: 14072, AssetName: 'Albert Campbell Square - Outdoor Artificial Ice Rink', Reason: 'Closed for the Season', Comments: '', Status: 0, Category: 'Skate', Type: 'Outdoor Ice Rink', DisplayAlertName: '', PostedDate: '2026-03-23 05:41:18' };
        const washroom = { LocationID: 2155, AssetID: 12, AssetName: 'Albert Campbell Square Outdoor Rink Washroom', Reason: 'Maintenance/Repairs', Comments: 'Ice maintenance', Status: 2, Category: 'Outdoor Rink Washroom', Type: 'Washroom', DisplayAlertName: 'Washroom', PostedDate: '2026-11-28 07:38:20', Scope: 'asset' };
        const today = at([washroom, season], onePad, 'Leisure Skate', '2026-11-28', '10:00');
        expect(today).toMatchObject({ level: 'warning', kind: 'season-today', lead: 'Still marked closed for the season' });
        expect(today.text).toContain('has not lifted it');
        expect(today.text).toContain('Also posted here: Albert Campbell Square Outdoor Rink Washroom: Ice maintenance');
        // for a later day the season notice is only a grey note, so the other notice is what shows
        expect(at([washroom, season], onePad, 'Leisure Skate', '2026-12-03', '10:00', '2026-11-28')).toMatchObject({ level: 'warning', kind: 'alert' });
    });
});
