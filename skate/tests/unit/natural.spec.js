// The natural ice stage of the pipeline (fetch-skate-data.js → natural-ice.json) against
// the City's page as served on 2026-11-21 (natural-ice-page.html: the accordion with the
// approved-locations table, verbatim). Plain Node: no browser, no network.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { parseNaturalIcePage, winterOf } = require('../../../fetch-skate-data.js');
const page = fs.readFileSync(path.join(__dirname, 'natural-ice-page.html'), 'utf8');

test.describe('natural ice: the City\'s approved parks', () => {
    test('a winter runs from July to June', () => {
        expect(winterOf('2026-06-30')).toBe('2025/2026');
        expect(winterOf('2026-07-01')).toBe('2026/2027');
        expect(winterOf('2027-01-15')).toBe('2026/2027');
    });

    test('in November the page still holds last winter\'s list, and says when the new one comes', () => {
        const r = parseNaturalIcePage(page, '2026-11-21');
        expect(r.season).toBe('2025/2026');
        expect(r.current).toBe(false);
        expect(r.next).toBe('Approved rinks for 2026/27 will be available in late November/early December.');
        expect(r.parks).toHaveLength(48);
    });

    test('the same list read last January was the current one', () => {
        expect(parseNaturalIcePage(page, '2026-01-15').current).toBe(true);
        expect(parseNaturalIcePage(page, '2026-06-30').current).toBe(true);
        expect(parseNaturalIcePage(page, '2026-07-01').current).toBe(false);
    });

    test('every row: the City\'s location id, the park, its address', () => {
        const { parks } = parseNaturalIcePage(page, '2026-11-21');
        expect(parks[0]).toEqual({ id: '137', name: 'Baird Park', address: '275 Keele St.' });
        expect(parks[47]).toEqual({ id: '461', name: 'Wychwood Barns Park', address: '76 Wychwood Ave.' });
        const by = Object.fromEntries(parks.map(p => [p.id, p]));
        expect(by['290']).toEqual({ id: '290', name: 'Beresford Park', address: '400 Beresford Ave.' });           // name and address inside <span>
        expect(by['2039']).toEqual({ id: '2039', name: 'Ward’s Island', address: '1 Centre Island Park' });        // "&amp;title=…" after the id
        // five rows link to a web-archive copy of the location page: the id is read from there all the same
        for (const [id, name] of [['86', 'Dovercourt Park'], ['75', 'Hideaway Park'], ['334', 'Lessard Park'], ['2478', 'Merrill Park'], ['257', 'Vine Avenue Playground']]) expect(by[id].name).toBe(name);
        expect(new Set(parks.map(p => p.id)).size).toBe(48);
        expect(parks.every(p => /^\d{1,6}$/.test(p.id) && p.name && p.address && !/[<>]/.test(p.name + p.address))).toBe(true);
        expect(parks.map(p => p.name)).toEqual([...parks.map(p => p.name)].sort((a, b) => a.localeCompare(b)));     // the City lists them A to Z
    });

    test('a page without the list, with an odd season or with a stub of a table is refused, not guessed at', () => {
        expect(() => parseNaturalIcePage('', '2026-11-21')).toThrow('no approved-locations table');
        expect(() => parseNaturalIcePage('<html><body>Not Found</body></html>', '2026-11-21')).toThrow('no approved-locations table');
        expect(() => parseNaturalIcePage(page.replace('2025/2026 Approved Locations', '2025/2028 Approved Locations'), '2026-11-21')).toThrow('odd season');
        const stub = page.replace(/<tbody>[\s\S]*<\/tbody>/, '<tbody><tr><td><a href="?id=1">One Park</a></td><td>1 One St.</td></tr></tbody>');
        expect(() => parseNaturalIcePage(stub, '2026-11-21')).toThrow('only 1 parks read');
        // a commented-out table is not a table
        expect(() => parseNaturalIcePage(page.replace('<table', '<!-- <table').replace('</table>', '</table> -->'), '2026-11-21')).toThrow('no approved-locations table');
    });

    test('next winter\'s page reads the same way, and is then the current list', () => {
        const next = page.replace(/2025\/2026/g, '2026/2027').replace('20252026', '20262027');
        const r = parseNaturalIcePage(next, '2026-12-20');
        expect(r).toMatchObject({ season: '2026/2027', current: true });
        expect(r.parks).toHaveLength(48);
        // a two-digit second year is the same winter
        expect(parseNaturalIcePage(page.replace('2025/2026 Approved Locations', '2025/26 Approved Locations'), '2026-01-15').season).toBe('2025/2026');
    });
});
