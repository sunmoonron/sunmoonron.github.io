/**
 * Shared test setup for the /skate smoke suite.
 *
 *  - NOW is frozen (Saturday 2026-10-24, 1:00 pm Toronto) so "today",
 *    "On now" and "Starts in" never drift.
 *  - Every data JSON the app fetches (from either origin) is answered from
 *    the synthetic set built in buildData(); no network, no City feeds.
 *  - Weather, map tiles and geocoders are mocked or aborted; relays are a
 *    mocked WebSocket that says EOSE to every REQ and OK to every EVENT.
 *  - Settings are seeded once per context so the tour, hints and first-run
 *    defaults never get in the way; `theme` comes from the project.
 *  - Console errors and page errors are collected; a test fails if any
 *    remain at the end (network aborts we caused are filtered out).
 */
const base = require('@playwright/test');

const NOW_ISO = '2026-10-24T13:00:00-04:00';
const TZ = 'America/Toronto';

const ymd = (d) => d.toLocaleDateString('en-CA', { timeZone: TZ });
const dayPlus = (n) => { const d = new Date(NOW_ISO); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };
const weekdayOf = (date) => new Date(`${date}T12:00:00-04:00`).toLocaleDateString('en-US', { weekday: 'long', timeZone: TZ });
const stamp = (n, time = '09:00:00') => `${dayPlus(n)} ${time}`;

function row(o) {
    const date = o.date;
    return {
        _id: o.id, 'Location ID': o.loc ?? null, 'Course Title': o.activity, Activity: o.activity,
        Section: 'Skating - Drop-In', Category: 'Skating - Drop-In',
        LocationName: o.rink, LocationType: 'arena', Address: o.address || '', District: o.district || 'Toronto and East York', PostalCode: o.postal || '',
        Accessibility: '', TTCInfo: '', Intersection: '',
        'Age Min': o.ageMin ?? null, 'Age Max': o.ageMax ?? null,
        'Start Time': o.start, 'End Time': o.end, 'Day of Week': weekdayOf(date),
        'Start Date': date, 'End Date': date, 'First Date': date, 'Last Date': date,
        Source: o.source || 'city', ExternalId: o.externalId != null ? String(o.externalId) : null,
        ...(o.extKey ? { ExtLocationKey: o.extKey } : {}),
        Paid: !!o.paid, Price: o.paid ? (o.price ?? null) : 0, PriceNote: o.priceNote || '',
        RegistrationUrl: o.registrationUrl || '', InfoUrl: o.infoUrl || '', Unverified: !!o.unverified,
        Lat: o.lat ?? 43.65, Lng: o.lng ?? -79.38
    };
}

const RINKS = [
    { locationid: '100', name: 'Alpha Arena', address: '1 Alpha St', postal: 'M5A 1A1', district: 'Toronto and East York', lat: 43.654, lng: -79.380, kinds: ['indoor'], pads: 1, operator: '', source: 'city' },
    { locationid: '200', name: 'Beta Park Rink', address: '2 Beta Ave', postal: 'M4M 2B2', district: 'Toronto and East York', lat: 43.660, lng: -79.340, kinds: ['outdoor'], pads: 1, operator: '', source: 'city' },
    { locationid: '300', name: 'Warning Arena', address: '3 Gamma Rd', postal: 'M1J 3K4', district: 'Scarborough', lat: 43.760, lng: -79.230, kinds: ['indoor'], pads: 1, operator: '', source: 'city' },
    { locationid: '400', name: 'Note Arena', address: '4 Delta Dr', postal: 'M2N 4D4', district: 'North York', lat: 43.770, lng: -79.410, kinds: ['indoor'], pads: 1, operator: '', source: 'city' },
    { locationid: '500', name: 'Expired Arena', address: '5 Epsilon Cres', postal: 'M9W 5E5', district: 'Etobicoke York', lat: 43.700, lng: -79.550, kinds: ['indoor'], pads: 1, operator: '', source: 'city' },
    { locationid: '789', name: 'Leaside Memorial Community Gardens', address: '1073 Millwood Rd', postal: 'M4G 1X6', district: 'Toronto and East York', lat: 43.7017, lng: -79.3612, kinds: ['indoor'], pads: 2, operator: 'Arena Board', source: 'city', website: 'https://leasidegardens.com/arenas/public-skate-times/' },
    { locationid: '3489', name: 'Larry Grossman Forest Hill Memorial Arena', address: '340 Chaplin Cres', postal: 'M5P 1A9', district: 'Toronto and East York', lat: 43.7043, lng: -79.4202, kinds: ['indoor'], pads: 2, operator: 'Arena Board', source: 'city', website: 'https://larrygrossmanforesthillarena.com/' },
    { locationid: 'ext-mississauga-paul-coffey-arena', name: 'Paul Coffey Arena', address: '3430 Derry Rd E', postal: 'L4T 1A9', district: 'Mississauga', lat: 43.70, lng: -79.65, kinds: ['indoor'], pads: 2, operator: '', source: 'external', externalSource: 'mississauga', website: 'https://www.mississauga.ca/recreation-and-sports/sports-and-activities/skating-and-hockey/' }
];

/** The synthetic schedule, alerts and side files around NOW. */
function buildData() {
    const T = dayPlus(0), T1 = dayPlus(1), T3 = dayPlus(3);
    const programs = [
        row({ id: 'c1', loc: 100, rink: 'Alpha Arena', activity: 'Leisure Skate', date: T, start: '10:00', end: '11:00' }),                    // ended
        row({ id: 'c2', loc: 200, rink: 'Beta Park Rink', activity: 'Leisure Skate', date: T, start: '12:30', end: '14:00' }),                 // on now
        row({ id: 'c3', loc: 100, rink: 'Alpha Arena', activity: 'Leisure Skate', date: T, start: '15:00', end: '16:30' }),                    // closed alert
        row({ id: 'c4', loc: 100, rink: 'Alpha Arena', activity: 'Shinny: Adult', date: T, start: '17:00', end: '18:00', ageMin: 18 }),      // hockey, off by default
        row({ id: 'c5', loc: 300, rink: 'Warning Arena', activity: 'Figure Skating', date: T, start: '18:00', end: '19:00' }),              // warning alert
        row({ id: 'c6', loc: 400, rink: 'Note Arena', activity: 'Leisure Skate', date: T, start: '19:00', end: '20:00' }),                   // ended alert → note
        row({ id: 'c7', loc: 500, rink: 'Expired Arena', activity: 'Leisure Skate', date: T, start: '20:00', end: '21:00' }),                // long-ended alert → nothing
        row({ id: 'p1', loc: 789, rink: 'Leaside Memorial Community Gardens', activity: 'Figure Skating Ticket Ice · Rink B', date: T1, start: '11:15', end: '12:15', ageMin: 18,
              source: 'leaside-pickuphub', externalId: 62939, paid: true, price: 11.5, priceNote: 'HST included · register on PickupHub', registrationUrl: 'https://pickuphub.net/game/62939', infoUrl: 'https://pickuphub.net/leaside-gardens', lat: 43.7017, lng: -79.3612 }),
        row({ id: 'g1', loc: 3489, rink: 'Larry Grossman Forest Hill Memorial Arena', activity: 'Pleasure Skate', date: T1, start: '14:00', end: '15:50',
              source: 'grossman', paid: true, price: 3, priceNote: '$3 per person, pay at the door', unverified: true, infoUrl: 'https://larrygrossmanforesthillarena.com/recreational-skating-hours/', registrationUrl: 'https://larrygrossmanforesthillarena.com/recreational-skating-hours/', lat: 43.7043, lng: -79.4202 }),
        row({ id: 'c8', loc: 100, rink: 'Alpha Arena', activity: 'Leisure Skate: Adult', date: T3, start: '09:00', end: '10:00', ageMin: 18 }),   // live-check: missing
        row({ id: 'm1', loc: null, extKey: 'ext-mississauga-paul-coffey-arena', rink: 'Paul Coffey Arena', activity: 'Public Skate', date: T1, start: '10:00', end: '11:00',
              source: 'mississauga', paid: true, price: 4.5, district: 'Mississauga', address: '3430 Derry Rd E', postal: 'L4T 1A9', lat: 43.70, lng: -79.65 })
    ];
    const alerts = [
        { LocationID: 100, AssetID: '1', AssetName: 'Alpha Arena - Indoor Ice Rink', Type: 'Indoor Ice Rink', DisplayAlertName: 'Skate', Category: 'ALPHA ARENA', Status: 0,
          Reason: 'Technical Issues', Comments: 'The ice rink is closed until further notice due to a compressor failure.', PostedDate: stamp(-1) },
        { LocationID: '300', AssetID: '3', AssetName: 'Warning Arena', Type: 'Centre', DisplayAlertName: 'Centre', Category: 'WARNING ARENA', Status: '2', Scope: 'facility',
          Reason: 'Maintenance/Repairs', Comments: 'The parking lot is being resurfaced this week; expect delays getting in.', PostedDate: stamp(-1) },
        { LocationID: '400', AssetID: '4', AssetName: 'Note Arena', Type: 'Centre', DisplayAlertName: 'Centre', Category: 'NOTE ARENA', Status: '2', Scope: 'facility',
          Reason: 'Technical Issues', Comments: 'Leisure Skate is cancelled today due to a mechanical issue.', PostedDate: stamp(-2) },
        { LocationID: '500', AssetID: '5', AssetName: 'Expired Arena', Type: 'Centre', DisplayAlertName: 'Centre', Category: 'EXPIRED ARENA', Status: '2', Scope: 'facility',
          Reason: 'Technical Issues', Comments: 'Leisure Skate is cancelled today due to a mechanical issue.', PostedDate: stamp(-20) }
    ];
    const checkedAt = new Date(NOW_ISO).toISOString();
    return {
        'skating-programs.json': { metadata: { lastUpdated: checkedAt, source: 'test', counts: { total: programs.length } }, programs },
        'meta.json': { lastUpdated: checkedAt, counts: { total: programs.length, duplicatesRemoved: 0 } },
        'rinks.json': { generatedAt: checkedAt, rinks: RINKS },
        'alerts.json': { fetchedAt: checkedAt, checkedAt, source: 'test', alerts },
        'live-check.json': { checkedAt, flags: { [`100|${T3}|09:00|leisureskateadult`]: { s: 'missing', t: 'Leisure Skate: Adult' } }, extra: [] },   // key: loc|date|start|title stripped to [a-z0-9]
        'venue-facts.json': { generatedAt: checkedAt, venues: {
            '789':  { name: 'Leaside Memorial Community Gardens', url: 'https://leasidegardens.com/arenas/public-skate-times/', checkedAt, verified: true, factsVersion: 2,
                      helmets: { rule: 'required under age', maxAge: 12, quote: 'Helmets are mandatory for children 12 and under.', url: 'https://leasidegardens.com/arenas/public-skate-times/' } },
            '3489': { name: 'Larry Grossman Forest Hill Memorial Arena', url: 'https://larrygrossmanforesthillarena.com/', checkedAt, verified: true, factsVersion: 2,
                      rentals: { available: 'yes', price: 6, unit: 'per pair', quote: 'We also offer skate rentals at a cost of $6.00 per pair.', url: 'https://larrygrossmanforesthillarena.com/recreational-skating-hours/' },
                      admission: { price: 3, unit: 'per person', quote: 'Enjoy a calm & controlled daily pleasure skate for only $3.00 per person.', url: 'https://larrygrossmanforesthillarena.com/' } }
        } },
        'live-spots.json': { checkedAt, byId: { '62939': { open: 20, capacity: 22, status: 'open', endsAt: `${T1}T12:15:00-04:00`, at: checkedAt } } }
    };
}

const DEFAULT_SETTINGS = {
    setupDone: true, tourDone: true, heartHintDone: true, installSeen: true, lastSeenVersion: '3.9',
    showGuides: false, showChats: false, timeFormat: '12h', freeOnly: false, rinkScope: 'all', myRinks: [], sort: 'time',
    cities: ['Toronto'], typeSel: { leisure: 'all', figure: 'all', other: 'all', adapted: 'all', ringette: 'all', speed: 'all' },
    invisible: false, dmsAllowed: true, notifyDesktop: false
};

/** Every relay becomes a polite mock: EOSE for each REQ, OK for each EVENT. */
async function mockRelays(context) {
    await context.routeWebSocket(/^wss:\/\//, (ws) => {
        ws.onMessage((raw) => {
            let m;
            try { m = JSON.parse(raw); } catch { return; }
            if (m[0] === 'REQ') ws.send(JSON.stringify(['EOSE', m[1]]));
            else if (m[0] === 'EVENT' && m[1] && m[1].id) ws.send(JSON.stringify(['OK', m[1].id, true, '']));
        });
    });
}

const test = base.test.extend({
    theme: ['light', { option: true }],
    /** Settings merged over the suite defaults, seeded before the first load. */
    settings: [{}, { option: true }],
    /** Everything a test needs: the mocked world, the seeded settings and an errors list. */
    app: async ({ page, context, theme, settings }, use) => {
        const data = buildData();
        const errors = [];
        page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
        page.on('console', (m) => {
            if (m.type() !== 'error') return;
            const t = m.text();
            if (/net::ERR_|Failed to load resource|open-meteo|tile\.openstreetmap/.test(t)) return;   // aborted on purpose
            errors.push(`console: ${t}`);
        });
        await context.route('**/projects/data/**', (route) => {
            const name = new URL(route.request().url()).pathname.split('/').pop();
            const body = data[name];
            if (!body) return route.fulfill({ status: 404, body: 'no such fixture' });
            return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*', 'cache-control': 'no-cache' }, body: JSON.stringify(body) });
        });
        await context.route('https://api.open-meteo.com/**', (route) => route.abort());
        await context.route('https://tile.openstreetmap.org/**', (route) => route.abort());
        await context.route('https://nominatim.openstreetmap.org/**', (route) => route.fulfill({
            status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
            body: JSON.stringify([{ lat: '43.7612', lon: '-79.2298', display_name: 'M1J, Scarborough, Toronto, Ontario, Canada' }])
        }));
        await context.route('https://photon.komoot.io/**', (route) => route.fulfill({
            status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
            body: JSON.stringify({ features: [{ geometry: { coordinates: [-79.2298, 43.7612] }, properties: { name: 'M1J', city: 'Toronto' } }] })
        }));
        await context.route(/skate-data\.ronishbhatt\.com\/(?!projects\/data\/)/, (route) => route.abort());
        await mockRelays(context);
        const seeded = { ...DEFAULT_SETTINGS, theme, ...settings };
        await context.addInitScript((s) => {
            if (!localStorage.getItem('skate_settings_v1')) localStorage.setItem('skate_settings_v1', JSON.stringify(s));
        }, seeded);
        await page.clock.setFixedTime(new Date(NOW_ISO));
        const api = {
            data, errors, NOW_ISO, dayPlus,
            async open(path = '/skate/') {
                await page.goto(path);
                await page.waitForSelector('.program-item, #program-list .loading', { timeout: 20000 });
                await page.waitForFunction(() => /\d+ sessions?/.test(document.getElementById('status-data')?.textContent || ''), null, { timeout: 20000 });
            },
            async noErrors() { base.expect(errors, 'console / page errors').toEqual([]); },
            /** Bring a section on screen: a tab on phones / narrow windows, already a column at ≥ 1100 px. */
            async view(name) {
                const tab = page.locator(`.view-tab[data-view="${name}"]`);
                if (await tab.isVisible()) await tab.click();
                await base.expect(page.locator(`#${name}-panel`)).toBeVisible();
            }
        };
        await use(api);
    }
});

module.exports = { test, expect: base.expect, NOW_ISO, dayPlus, buildData, RINKS, DEFAULT_SETTINGS };
