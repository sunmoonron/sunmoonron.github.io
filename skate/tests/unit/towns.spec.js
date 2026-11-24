// v3.14 pipeline: Aurora (the Town's skating page, tables per arena and season) and Newmarket
// (public skating and shinny PDFs, a day grid per arena), read from copies of the real pages
// as served on 2026-11-24 (unit/towns/). Plain Node.
const { test, expect } = require('@playwright/test');
const fs = require('fs'), path = require('path');
const P = require('../../../fetch-skate-data.js');
const { toRanges, dateRangeIn, datesIn, agesFromLabel, parseDayGridText, parseAuroraPage, EXTERNAL_SOURCES } = P;

const read = (f) => fs.readFileSync(path.join(__dirname, 'towns', f), 'utf8');
const brief = (r) => `${r.venue.split(' ')[0]} ${r.weekday.slice(0, 3)} ${r.start}-${r.end} ${r.activity}`;

test.describe('reading times, dates and ages', () => {
    test('times: the spellings these towns use', () => {
        expect(toRanges('9 to 9:50 a.m.')).toEqual([{ start: '09:00', end: '09:50' }]);
        expect(toRanges('12 to 12:50 p.m.')).toEqual([{ start: '12:00', end: '12:50' }]);
        expect(toRanges('12:30 to 1:20 p.m.')).toEqual([{ start: '12:30', end: '13:20' }]);
        expect(toRanges('1 p.m. to 2 p.m. – Parent/Child Stick & Puck')).toEqual([{ start: '13:00', end: '14:00' }]);
        expect(toRanges('2 p.m. to 3p.m.')).toEqual([{ start: '14:00', end: '15:00' }]);
        expect(toRanges('11 to 12:30 p.m.')).toEqual([{ start: '11:00', end: '12:30' }]);
        expect(toRanges('6 to 7:20 p.m. and 7:30 to 8:50 p.m.')).toEqual([{ start: '18:00', end: '19:20' }, { start: '19:30', end: '20:50' }]);
        expect(toRanges('2017 to 2019 Shinny')).toEqual([]);              // birth years, not times
        expect(toRanges('13 to 14 p.m.')).toEqual([]);
    });
    test('dates: a season, cancelled days with "&", ages from a label', () => {
        expect(dateRangeIn('Effective September 9 to December 19, 2026. Subject to change')).toEqual({ from: '2026-09-09', to: '2026-12-19' });
        expect(dateRangeIn('Winter 2027, January 2 to March 28, 2027')).toEqual({ from: '2027-01-02', to: '2027-03-28' });
        expect(dateRangeIn('November 30 to January 4, 2027')).toEqual({ from: '2026-11-30', to: '2027-01-04' });
        const winter = { from: '2027-01-02', to: '2027-03-28' };
        expect(datesIn('>Cancelled: January 8 & 29, February 5 & 26', winter)).toEqual(['2027-01-08', '2027-01-29', '2027-02-05', '2027-02-26']);
        expect(datesIn('Cancelled: December 28, January 4', { from: '2026-12-01', to: '2027-01-31' })).toEqual(['2026-12-28', '2027-01-04']);
        expect(agesFromLabel('Adult Skate 18+', 2026)).toEqual({ ageMin: 18, ageMax: null });
        expect(agesFromLabel('Parent & Tot Skate 6 yrs & under', 2026)).toEqual({ ageMin: null, ageMax: 6 });
        expect(agesFromLabel('Youth Shinny (16-17yrs)', 2026)).toEqual({ ageMin: 16, ageMax: 17 });
        expect(agesFromLabel('2017 to 2019 Shinny', 2026)).toEqual({ ageMin: 7, ageMax: 9 });
        expect(agesFromLabel('Public Skating', 2026)).toEqual({ ageMin: null, ageMax: null });
    });
});

test.describe('Newmarket: the day grids', () => {
    test('public skating: both arenas, their own dates, labels over several lines, two times in one cell', () => {
        const rules = parseDayGridText(read('newmarket-public.txt'), EXTERNAL_SOURCES.newmarket);
        expect(rules.map(brief)).toEqual([
            'Magna Mon 15:15-16:05 Public Skating', 'Magna Mon 09:00-09:50 Parent & Tot Skate', 'Magna Mon 12:00-12:50 Adult Skate 18+',
            'Magna Tue 09:00-09:50 Public Skating', 'Magna Tue 15:45-16:35 Adult Skate 18+',
            'Magna Wed 09:45-10:35 Parent & Tot Skate', 'Magna Wed 10:45-11:35 Adult Skate 18+',
            'Magna Thu 09:00-09:50 Public Skating', 'Magna Thu 13:45-14:35 Adult Skate 18+',
            'Magna Fri 09:00-09:50 Parent & Tot Skate', 'Magna Fri 12:00-12:50 Adult Skate 18+',
            'Magna Sun 18:00-19:20 Public Skating', 'Magna Sun 19:30-20:50 Public Skating',
            'Ray Tue 10:00-11:00 Figure Skating', 'Ray Thu 10:00-11:00 Adult Skate 18+'
        ]);
        expect(rules[0]).toMatchObject({ from: '2026-09-09', to: '2026-12-19' });
        expect(rules[13]).toMatchObject({ venue: 'Ray Twinney Recreation Complex', from: '2026-09-10', to: '2026-12-17' });
        expect(rules[1]).toMatchObject({ ageMin: null, ageMax: 6 });
        expect(rules[2]).toMatchObject({ ageMin: 18, ageMax: null });
    });
    test('shinny: all at the Magna Centre, "&" between two times, birth years as ages', () => {
        const rules = parseDayGridText(read('newmarket-shinny.txt'), EXTERNAL_SOURCES['newmarket-shinny']);
        expect(rules).toHaveLength(10);
        expect(rules.every(r => r.venue === 'Magna Centre' && r.from === '2026-09-09' && r.to === '2026-12-18')).toBe(true);
        expect(rules.filter(r => r.weekday === 'Wednesday' && r.activity === 'Adult Shinny 18+').map(r => `${r.start}-${r.end}`)).toEqual(['07:00-07:50', '12:30-13:20']);
        expect(rules.find(r => r.activity === '2017 to 2019 Shinny')).toMatchObject({ weekday: 'Monday', start: '16:15', ageMin: 7, ageMax: 9 });
        expect(rules.find(r => r.activity === '2015 to 2016 Shinny')).toMatchObject({ weekday: 'Friday', start: '16:45' });
        expect(rules.find(r => r.activity === '55+ Shinny')).toMatchObject({ weekday: 'Tuesday', ageMin: 55 });
    });
    test('the PDF addresses are found on the schedules page', () => {
        const page = '<a href="/media/file/denne-fall-2026-drop-schedule">x</a><a href="/media/file/public-skating-winter-2027-drop-schedule">Public</a><a href="/media/file/shinny-winter-2027-drop-schedule">Shinny</a>';
        expect(EXTERNAL_SOURCES.newmarket.discover.hops[0].exec(page)[1]).toBe('/media/file/public-skating-winter-2027-drop-schedule');
        expect(EXTERNAL_SOURCES['newmarket-shinny'].discover.hops[0].exec(page)[1]).toBe('/media/file/shinny-winter-2027-drop-schedule');
    });
    test('junk is nothing, quickly', () => {
        const t0 = Date.now();
        expect(parseDayGridText('', EXTERNAL_SOURCES.newmarket)).toEqual([]);
        expect(parseDayGridText('Effective September 9 to December 19, 2026\n' + ' Monday Tuesday Wednesday Thursday Friday Saturday Sunday\n' + '9 to 9:50 a.m. '.repeat(20000), EXTERNAL_SOURCES.newmarket)).toEqual([]);
        expect(Date.now() - t0).toBeLessThan(2000);
    });
});

test.describe('Aurora: the day tables', () => {
    const rules = parseAuroraPage(read('aurora.html'), EXTERNAL_SOURCES.aurora);
    const find = (venue, weekday, start, from) => rules.filter(r => r.venue.includes(venue) && r.weekday === weekday && r.start === start && r.from.startsWith(from));
    test('both arenas, fall and winter, skating and shinny', () => {
        expect(rules).toHaveLength(52);
        expect(new Set(rules.map(r => r.venue))).toEqual(new Set(['Aurora Family Leisure Complex', 'Aurora Recreation Complex']));
        expect(find('Family', 'Sunday', '13:00', '2026-09')).toEqual([expect.objectContaining({ activity: 'Parent/Child Stick & Puck', end: '14:00', to: '2026-12-20', price: null })]);
        expect(find('Recreation', 'Thursday', '07:30', '2027-01')).toEqual([expect.objectContaining({ activity: 'Men’s Shinny', end: '09:00', ageMin: 18, price: 7.23 })]);
        expect(find('Recreation', 'Tuesday', '10:30', '2026-09')[0]).toMatchObject({ activity: 'Senior Skate', ageMin: 55, price: 3.37 });
        expect(find('Family', 'Sunday', '14:00', '2027-01')[0]).toMatchObject({ activity: 'Family Shinny', ageMin: 6, ageMax: 10 });
        expect(find('Recreation', 'Monday', '15:30', '2026-09')[0]).toMatchObject({ activity: 'Youth Shinny (16-17yrs)', ageMin: 16, ageMax: 17 });
    });
    test('"Cancelled:" applies to every session marked ">" above it (a holiday Monday cancels all of Monday)', () => {
        const monday = rules.filter(r => r.venue.includes('Recreation') && r.weekday === 'Monday' && r.from === '2027-01-02');
        expect(monday.map(r => `${r.start} ${r.except.join(',')}`)).toEqual(['09:30 2027-02-15', '21:00 2027-02-15', '11:45 2027-02-15', '15:30 2027-02-15', '16:30 2027-02-15']);
        const friday = rules.filter(r => r.venue.includes('Recreation') && r.weekday === 'Friday' && r.from === '2027-01-02' && /shinny/i.test(r.activity));
        expect(friday.map(r => `${r.activity}: ${r.except.join(',')}`)).toEqual(['Ladies Shinny: 2027-01-08,2027-02-05,2027-02-26', 'Adult Shinny: 2027-01-08,2027-01-29,2027-02-05,2027-02-26']);
    });
    test('a dated row is that day only; "*FREE" makes it free', () => {
        expect(rules.find(r => r.from === '2027-02-15' && r.to === '2027-02-15')).toMatchObject({ venue: 'Aurora Family Leisure Complex', weekday: 'Monday', start: '10:00', end: '12:00', activity: 'Public Skate', price: 0 });
    });
    test('no tables, other headings, junk: nothing, quickly', () => {
        const t0 = Date.now();
        expect(parseAuroraPage('<h3>Outdoor Skating</h3><p>Rinks open when it is cold.</p>', EXTERNAL_SOURCES.aurora)).toEqual([]);
        expect(parseAuroraPage('<h3>Skating Drop-Ins – Fall 2026: September 8 to December 20, 2026</h3>' + '<tr><td>'.repeat(60000), EXTERNAL_SOURCES.aurora)).toEqual([]);
        expect(parseAuroraPage(null, EXTERNAL_SOURCES.aurora)).toEqual([]);
        expect(Date.now() - t0).toBeLessThan(2000);
    });
});
