// v3.12: places with more than one name, seasonal rinks that are not open yet,
// and a City notice an arena has outlived.
const { test, expect, dayPlus, row } = require('./fixtures');

const card = (page, text) => page.locator('.program-item', { hasText: text });
const rinkRow = (page, text) => page.locator('#rinks-list .rink-row', { hasText: text });

test.describe('places', () => {
    test('another name finds the rink in both searches and shows beside its name; the City\'s second id still finds it', async ({ page, app }) => {
        const beta = app.data['rinks.json'].rinks.find(r => r.locationid === '200');
        beta.aka = ['Barbara Ann Scott Ice Trail', 'Skate Trail'];
        beta.alsoIds = ['999'];
        await app.open();
        await expect(card(page, 'Beta Park Rink').locator('.where-aka')).toHaveText('(Barbara Ann Scott Ice Trail)');
        await expect(card(page, 'Alpha Arena').first().locator('.where-aka')).toHaveCount(0);

        await page.fill('#search-input', 'barbara ann');
        await expect(page.locator('.program-item')).toHaveCount(1);
        await expect(card(page, 'Beta Park Rink')).toHaveCount(1);
        await page.click('#btn-rinks');                                         // the alias carries over to the map's search
        await expect(page.locator('#rinks-search')).toHaveValue('barbara ann');
        await expect(page.locator('#rinks-list .rink-row')).toHaveCount(1);
        await expect(rinkRow(page, 'Beta Park Rink').locator('.rink-aka')).toHaveText('(Barbara Ann Scott Ice Trail)');
        await expect(rinkRow(page, 'Beta Park Rink').locator('.rink-aka')).toHaveAttribute('title', 'Also known as Barbara Ann Scott Ice Trail, Skate Trail');
        await page.fill('#rinks-search', 'skate trail');                        // the second name is searchable too
        await expect(page.locator('#rinks-list .rink-row')).toHaveCount(1);
        await page.fill('#rinks-search', 'beta');
        await expect(page.locator('#rinks-list .rink-row')).toHaveCount(1);
        expect(await page.evaluate(() => [SkateGeo.rinkByLocation('999').name, SkateGeo.rinkByLocation('200').name, SkateGeo.rinkByLocation('100').name]))
            .toEqual(['Beta Park Rink', 'Beta Park Rink', 'Alpha Arena']);
        await app.noErrors();
    });

    test('a name with markup in it is shown as text', async ({ page, app }) => {
        app.data['rinks.json'].rinks.find(r => r.locationid === '200').aka = ['<img src=x onerror="window.__aka=1">', 7, null, ''];
        await app.open();
        await expect(card(page, 'Beta Park Rink').locator('.where-aka')).toContainText('<img src=x');
        await page.click('#btn-rinks');
        await expect(rinkRow(page, 'Beta Park Rink').locator('.rink-aka')).toContainText('<img src=x');
        expect(await page.evaluate(() => window.__aka)).toBeUndefined();
        await app.noErrors();
    });

    test('a seasonal rink that is not open says so, and its free skates wait for it', async ({ page, app }) => {
        const sat = new Date(dayPlus(0) + 'T12:00:00Z').getUTCDay();
        const ext = (o) => ({ address: '', postal: '', district: 'Toronto and East York', kinds: ['outdoor'], pads: 1, operator: 'External', source: 'external', paid: false, ...o });
        app.data['rinks.json'].rinks.push(
            ext({ locationid: 'ext-harbourfront', name: 'Harbourfront Centre Rink', externalSource: 'harbourfront', lat: 43.6394, lng: -79.382, seasonal: { state: 'pending', quote: 'The Rink will open for the season when cooler weather permits.' } }),
            ext({ locationid: 'ext-bentway', name: 'The Bentway Skate Trail', externalSource: 'bentway', lat: 43.6378, lng: -79.4063, seasonal: { state: 'pending', from: '2026-12-12', to: '2027-02-28' } }),
            ext({ locationid: 'ext-evergreen', name: 'Evergreen Brick Works', externalSource: 'evergreen', lat: 43.6843, lng: -79.3673, seasonal: { state: 'dormant' } }),
            ext({ locationid: 'ext-mattamy', name: 'Mattamy Athletic Centre', externalSource: 'mattamy', kinds: ['indoor'], lat: 43.6618, lng: -79.3803, seasonal: { state: 'ok' } }));
        app.data['lending.json'] = { generatedAt: app.NOW_ISO, checkedAt: app.NOW_ISO,
            van: { name: 'Skate Lending Library', by: 'City of Toronto', url: 'https://www.toronto.ca/x/', lends: 'skates', terms: '', status: 'soon', startsOn: dayPlus(27), stops: [] },
            also: [{ id: 'hf', place: 'Harbourfront Centre rink', address: '235 Queens Quay W, Toronto', what: 'Free skate rentals every Saturday, while quantities last', rink: 'ext-harbourfront', days: [sat], start: dayPlus(-1), end: dayPlus(90), url: 'https://harbourfrontcentre.com/program/skate/', checked: dayPlus(0) }] };
        await app.open();
        await expect(page.locator('.day-lend')).toHaveCount(0);                 // it is Saturday, but the rink is not open
        await page.click('#btn-rinks');
        await expect(rinkRow(page, 'Harbourfront Centre Rink').locator('.rink-season')).toHaveText('Not open yet');
        await expect(rinkRow(page, 'Harbourfront Centre Rink').locator('.rink-season')).toHaveAttribute('title', /will open for the season when cooler weather permits/);
        await expect(rinkRow(page, 'Harbourfront Centre Rink')).not.toContainText('Free skates');
        await expect(rinkRow(page, 'The Bentway Skate Trail').locator('.rink-season')).toHaveText('Opens Dec 12');
        await expect(rinkRow(page, 'Evergreen Brick Works').locator('.rink-season')).toHaveText('Out of season');
        await expect(rinkRow(page, 'Mattamy Athletic Centre').locator('.rink-season')).toHaveCount(0);
        await page.click('#btn-lending');
        await expect(page.locator('#lending-body .lend-shut')).toHaveText('The rink: not open yet.');
        await page.click('#btn-lending-close');
        await page.click('#btn-rinks-close');

        // the day it opens, the line is back by itself
        app.data['rinks.json'].rinks.find(r => r.locationid === 'ext-harbourfront').seasonal = { state: 'ok' };
        await page.reload();
        await page.waitForSelector('.program-item');
        await expect(page.locator('.day-lend').first()).toContainText('Free skates: Harbourfront Centre rink');
        await page.click('#btn-rinks');
        await expect(rinkRow(page, 'Harbourfront Centre Rink')).toContainText('Free skates to borrow');
        await expect(rinkRow(page, 'Harbourfront Centre Rink').locator('.rink-season')).toHaveCount(0);
        await app.noErrors();
    });

    test('a City notice an arena has outlived is a grey note, not a cancellation', async ({ page, app }) => {
        const T = dayPlus(0);
        app.data['rinks.json'].rinks.push({ locationid: '3488', name: 'George Bell Arena', address: '215 Ryding Ave', postal: 'M6N 1H6', district: 'Etobicoke York', lat: 43.6684, lng: -79.4774, kinds: ['indoor'], pads: 1, operator: 'Arena Board', source: 'city', externalSource: 'georgebell', website: 'https://georgebellarena.com/public-skating' });
        app.data['skating-programs.json'].programs.push(
            row({ id: 'gb1', loc: 3488, rink: 'George Bell Arena', activity: 'Public Skating: All Ages', date: T, start: '19:00', end: '20:00', source: 'georgebell', unverified: true, infoUrl: 'https://georgebellarena.com/public-skating', district: 'Etobicoke York' }));
        const notice = { LocationID: 3488, AssetID: 17335, AssetName: 'George Bell Arena - Indoor Ice Rink', Type: 'Indoor Ice Rink', DisplayAlertName: '', Category: 'Skate', Status: 0,
            Reason: 'Under Construction', Comments: 'George Bell Arena is closed as it <a href="https://www.toronto.ca/x/">undergoes improvements</a>.', PostedDate: '2025-11-05 16:26:36',
            Read: { v: 1, skating: 'off', about: 'building', starts: '2025-11-05', ends: null, timeFrom: null, timeTo: null, seasonal: false, by: 'claude-haiku-5-5' } };
        app.data['alerts.json'].alerts.push({ ...notice, Superseded: { on: '2026-10-10', by: 'georgebellarena.com' } });
        await app.open();
        const gb = card(page, 'George Bell Arena');
        await expect(gb).toHaveCount(1);
        await expect(gb).not.toHaveClass(/has-alert-closed/);
        await expect(gb).toHaveClass(/has-alert-note/);
        await expect(gb.locator('.alert-banner.note')).toContainText('The City\'s page still shows an old notice.');
        await expect(gb.locator('.alert-banner.note')).toContainText('“George Bell Arena is closed as it undergoes improvements.”, posted Wed, Nov 5, 2025.');
        await expect(gb.locator('.alert-banner.note')).toContainText('georgebellarena.com says the arena reopened on Sat, Oct 10 and lists this skate.');
        await page.click('#btn-rinks');
        await expect(rinkRow(page, 'George Bell Arena')).not.toHaveClass(/has-alert/);
        await page.click('#btn-rinks-close');

        // the same notice without the mark still cancels, as before
        app.data['alerts.json'].alerts = app.data['alerts.json'].alerts.filter(a => a.LocationID !== 3488).concat([notice]);
        await page.reload();
        await page.waitForSelector('.program-item');
        await expect(card(page, 'George Bell Arena')).toHaveClass(/has-alert-closed/);
        await app.noErrors();
    });

    test('natural ice: a plain list of the approved parks, marked as last winter\'s until the new one is posted, nearest first once a spot is set', async ({ page, app }) => {
        await app.open();
        await page.click('#btn-rinks');
        await page.click('#btn-natural');
        await expect(page.locator('#natural-modal')).toBeVisible();
        await expect(page.locator('#natural-body')).toContainText('could not be loaded');          // no file in this world yet
        await page.click('#btn-natural-close');
        await page.click('#btn-rinks-close');

        app.data['natural-ice.json'] = { generatedAt: app.NOW_ISO, checkedAt: app.NOW_ISO, url: 'https://www.toronto.ca/x/natural-ice-rinks/', season: '2025/2026', current: false,
            next: 'Approved rinks for 2026/27 will be available in late November/early December.',
            parks: [
                { id: '461', name: 'Wychwood Barns Park', address: '76 Wychwood Ave.', lat: 43.680, lng: -79.424 },
                { id: '137', name: 'Baird Park', address: '275 Keele St.', lat: 43.662, lng: -79.463 },
                { id: '594', name: 'Elizabeth Simcoe Park', address: '180 Sylvan Ave.', lat: 43.742, lng: -79.213 },      // Scarborough: beside the mocked spot
                { id: '999', name: '<img src=x onerror="window.__nat=1">', address: '<b>1 Nowhere</b>' },
                { id: 'abc', name: 'No id park', address: '2 Nowhere' }, { name: 'Nameless' }, null, 'junk'
            ] };
        await page.reload();
        await page.waitForSelector('.program-item');
        await page.click('#btn-rinks');
        await page.click('#btn-natural');
        const body = page.locator('#natural-body');
        await expect(body.locator('.lend-lead')).toContainText('4 parks');                            // the malformed entries are dropped
        await expect(body).toContainText('this list has no hours and no open or closed');
        await expect(body.locator('.nat-last')).toContainText('This is last winter\'s list (2025/2026).');
        await expect(body.locator('.nat-last')).toContainText('Approved rinks for 2026/27 will be available in late November/early December.');
        await expect(body.locator('.nat-list li .lend-where')).toHaveText([/^<img src=x/, /^Baird Park275 Keele St\.$/, /^Elizabeth Simcoe Park/, /^Wychwood Barns Park/]);   // A to Z, no spot yet
        expect(await page.evaluate(() => window.__nat)).toBeUndefined();
        await expect(body.locator('img, b')).toHaveCount(0);
        await expect(body.locator('.nat-list li').nth(1).locator('a').first()).toHaveAttribute('href', /google\.com\/maps\/search\/\?api=1&query=Baird%20Park%2C%20275%20Keele%20St\./);
        await expect(body.locator('.nat-list li').nth(1).locator('a').nth(1)).toHaveAttribute('href', 'https://www.toronto.ca/explore-enjoy/parks-recreation/places-spaces/parks-and-recreation-facilities/location/?id=137');
        await page.click('#btn-natural-close');

        // set a spot (the mocked geocoder answers in Scarborough): nearest first, with distances
        await page.fill('#rinks-search', 'M1J 3K4');
        await page.click('#btn-locator-search');
        await expect(page.locator('#locator-status')).toContainText('M1J');
        await page.click('#btn-natural');
        await expect(body.locator('.nat-list li .lend-where').first()).toContainText('Elizabeth Simcoe Park');
        await expect(body.locator('.nat-list li .lend-where').first()).toContainText(/\d(\.\d)? ?km/);
        await expect(body.locator('.nat-list li .lend-where').last()).toContainText('<img src=x');    // no coordinates: after the placed ones

        // once the City posts this winter's list, the note about last winter goes
        app.data['natural-ice.json'].season = '2026/2027';
        app.data['natural-ice.json'].current = true;
        await page.reload();
        await page.waitForSelector('.program-item');
        await page.click('#btn-rinks');
        await page.click('#btn-natural');
        await expect(body.locator('.nat-last')).toHaveCount(0);
        await expect(body).toContainText('Approved by the City for 2026/2027.');
        await app.noErrors();
    });

    test('free rentals on some days are not a rental price of $0', async ({ page, app }) => {
        const at = new Date(app.NOW_ISO).toISOString();
        app.data['venue-facts.json'].venues['200'] = { name: 'Beta Park Rink', url: 'https://example.org/beta', checkedAt: at, verified: true, factsVersion: 2,
            rentals: { available: 'yes', price: 0, unit: 'per session', quote: 'Every Saturday, enjoy FREE skate rentals', url: 'https://example.org/beta' } };
        await app.open();
        await page.click('#btn-rinks');
        const meta = rinkRow(page, 'Beta Park Rink').locator('.rink-meta');
        await expect(meta).toContainText('Skate rentals');
        await expect(meta).not.toContainText('$0');
        await expect(rinkRow(page, 'Larry Grossman Forest Hill Memorial Arena').locator('.rink-meta')).toContainText('Skate rentals $6 per pair');   // a real price still shows
        await app.noErrors();
    });

    test('an outdoor rink that posts its own hours carries a weather note, not "Unverified"', async ({ page, app }) => {
        app.data['skating-programs.json'].programs.push(
            row({ id: 'bw1', loc: null, rink: 'The Bentway Skate Trail', activity: 'Public Skating (Free)', date: dayPlus(0), start: '17:00', end: '21:00', source: 'bentway', unverified: true,
                  priceNote: 'Outdoor trail, weather permitting', infoUrl: 'https://thebentway.ca/event/winter-skating/' }));
        await app.open();
        const b = card(page, 'The Bentway Skate Trail');
        await expect(b.locator('.alert-banner.unverified')).toContainText('Outdoor ice. Hours read from thebentway.ca. It closes in warm, wet or very cold weather. Check before you go');
        await expect(b.locator('.alert-banner.unverified')).not.toContainText('Unverified');
        await expect(card(page, 'Larry Grossman Forest Hill Memorial Arena').locator('.alert-banner.unverified')).toContainText('Unverified.');
        await app.noErrors();
    });
});
