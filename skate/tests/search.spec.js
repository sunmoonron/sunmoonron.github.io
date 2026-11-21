// v3.12.1: the Rinks & map search (the best match first; rows and pins kept between
// letters, not rebuilt), and three iPhone habits (no zoom into a field, the page put
// back after a rotation or the keyboard, the rinks sheet with the phone held sideways).
const { test, expect } = require('./fixtures');

const rows = (page) => page.locator('#rinks-list .rink-row');
const pins = (page) => page.locator('.leaflet-marker-pane .leaflet-marker-icon:not(.you-pin-wrap)');
/** The rink names in the list, top to bottom (the name is the first text in each row's heading). */
const names = (page) => page.locator('#rinks-list .rink-row strong').evaluateAll(els => els.map(e => e.firstChild.textContent.trim()));
const rink = (id, name, extra = {}) => ({ locationid: id, name, address: '1 Test St', postal: 'M1A 1A1', district: 'Scarborough', lat: 43.75, lng: -79.25, kinds: ['indoor'], pads: 1, operator: '', source: 'city', ...extra });
// The shape of the real list: one rink named for the place, two with it somewhere in the
// name, one known by it, two that are merely there, one on a street called after it.
const SCARBOROUGH = [
    rink('601', 'Agincourt Recreation Centre', { address: '31 Glen Watford Dr', lat: 43.7880, lng: -79.2790 }),
    rink('602', 'Scarborough Village Recreation Centre', { address: '3600 Kingston Rd', lat: 43.7390, lng: -79.2160 }),
    rink('603', 'Centennial Recreation Centre - Scarborough', { address: '1967 Ellesmere Rd', lat: 43.7740, lng: -79.2370 }),
    rink('604', 'Albert Campbell Square', { aka: ['Scarborough Civic Centre Rink'], address: '150 Borough Dr', kinds: ['outdoor'], lat: 43.7730, lng: -79.2570 }),
    rink('605', 'Scarborough Arena Gardens', { address: '75 Birchmount Rd', lat: 43.6940, lng: -79.2600 }),
    rink('606', 'Eglinton Flats Rink', { district: 'Etobicoke York', address: '12 Scarborough Golf Club Rd', lat: 43.68, lng: -79.49 })
];
const openRinks = async (page, app) => {
    await app.open();
    await page.click('#btn-rinks');
    await expect(page.locator('.leaflet-marker-icon').first()).toBeVisible();
};

test.describe('rinks search: the best match first', () => {
    test('a rink with the word in its name comes before rinks that are only in that area', async ({ page, app }) => {
        app.data['rinks.json'].rinks.push(...SCARBOROUGH);
        await openRinks(page, app);
        await page.fill('#rinks-search', 'scarborough');
        await expect(rows(page)).toHaveCount(7);
        expect(await names(page)).toEqual([
            'Scarborough Arena Gardens', 'Scarborough Village Recreation Centre',     // the name starts with it (A to Z)
            'Centennial Recreation Centre - Scarborough',                             // the name holds it
            'Albert Campbell Square',                                                 // its other name holds it
            'Agincourt Recreation Centre', 'Warning Arena',                           // in that district
            'Eglinton Flats Rink'                                                     // only its street
        ]);
        await expect(pins(page)).toHaveCount(7);                                      // the map shows the same seven
        await app.noErrors();
    });

    test('every word counts, in any order; an exact name is first', async ({ page, app }) => {
        app.data['rinks.json'].rinks.push(...SCARBOROUGH, rink('607', 'Scarborough', { address: '9 Nowhere Rd' }));
        await openRinks(page, app);
        await page.fill('#rinks-search', 'arena scarborough');
        await expect(rows(page)).toHaveCount(2);
        expect(await names(page)).toEqual(['Scarborough Arena Gardens', 'Warning Arena']);   // both words in the name; then one in the name, one in the district
        await page.fill('#rinks-search', 'Scarborough');
        await expect(rows(page)).toHaveCount(8);
        expect((await names(page))[0]).toBe('Scarborough');                                    // the name is exactly that
        await app.noErrors();
    });

    test.describe('with a place to measure from', () => {
        test.use({ settings: { userLoc: { lat: 43.7880, lng: -79.2790, label: 'Agincourt', ts: 1 }, myRinks: ['300'] } });

        test('inside each kind of match the nearest comes first', async ({ page, app }) => {
            app.data['rinks.json'].rinks.push(...SCARBOROUGH);
            await openRinks(page, app);
            await page.fill('#rinks-search', 'scarborough');
            await expect(rows(page)).toHaveCount(7);
            expect(await names(page)).toEqual([
                'Scarborough Village Recreation Centre', 'Scarborough Arena Gardens',     // 7 km, then 10 km
                'Centennial Recreation Centre - Scarborough',
                'Albert Campbell Square',
                'Agincourt Recreation Centre', 'Warning Arena',                           // right here, then 5 km
                'Eglinton Flats Rink'
            ]);
            await app.noErrors();
        });

        test('browsing shows your rinks first; a search is one list, best match first', async ({ page, app }) => {
            app.data['rinks.json'].rinks.push(...SCARBOROUGH);
            await openRinks(page, app);
            await expect(page.locator('#rinks-list .rinks-head')).toHaveText(['Your rinks (1)', 'Other rinks']);
            expect((await names(page))[0]).toBe('Warning Arena');
            await page.fill('#rinks-search', 'scarborough');
            await expect(rows(page)).toHaveCount(7);
            await expect(page.locator('#rinks-list .rinks-head')).toHaveCount(0);
            expect((await names(page)).indexOf('Warning Arena')).toBe(5);                 // its place by match, starred or not
            await expect(rows(page).nth(5)).toHaveClass(/starred/);
            await page.click('#btn-rinks-search-clear');
            await expect(page.locator('#rinks-list .rinks-head')).toHaveText(['Your rinks (1)', 'Other rinks']);
            await app.noErrors();
        });
    });
});

test.describe('rinks search: typing is cheap', () => {
    test('rows, pins and the city picker are kept between letters, not rebuilt', async ({ page, app }) => {
        await openRinks(page, app);
        await expect(rows(page)).toHaveCount(7);
        await expect(pins(page)).toHaveCount(7);
        await page.evaluate(() => {
            document.querySelectorAll('#rinks-list .rink-row').forEach(r => { r.dataset.kept = '1'; });
            document.querySelectorAll('.leaflet-marker-pane .leaflet-marker-icon').forEach(m => { m.dataset.kept = '1'; });
            document.getElementById('rinks-city').dataset.kept = '1';
        });
        const search = page.locator('#rinks-search');
        await search.pressSequentially('a', { delay: 15 });                // every rink here has an "a": the list does not change
        await page.waitForTimeout(450);                                    // past the map's pause
        await expect(page.locator('#rinks-list .rink-row[data-kept="1"]')).toHaveCount(7);
        await expect(page.locator('#rinks-city[data-kept="1"]')).toHaveCount(1);
        await expect(page.locator('.leaflet-marker-pane .leaflet-marker-icon[data-kept="1"]:not(.you-pin-wrap)')).toHaveCount(7);

        await search.pressSequentially('lpha', { delay: 15 });             // "alpha": one rink left
        await expect(rows(page)).toHaveCount(1);
        await expect(page.locator('#rinks-list .rink-row[data-kept="1"]')).toHaveCount(1);     // the node it always was
        await expect(pins(page)).toHaveCount(1);
        await expect(page.locator('.leaflet-marker-pane .leaflet-marker-icon[data-kept="1"]:not(.you-pin-wrap)')).toHaveCount(1);   // and the pin that was already there

        await page.fill('#rinks-search', '');                              // back to everything: the same rows return
        await expect(rows(page)).toHaveCount(7);
        await expect(page.locator('#rinks-list .rink-row[data-kept="1"]')).toHaveCount(7);
        await expect(pins(page)).toHaveCount(7);
        await app.noErrors();
    });

    test('a row is rebuilt when what it says changes: starring a rink', async ({ page, app }) => {
        await openRinks(page, app);
        await page.evaluate(() => document.querySelectorAll('#rinks-list .rink-row').forEach(r => { r.dataset.kept = '1'; }));
        await page.locator('#rinks-list .rink-row', { hasText: 'Note Arena' }).locator('[data-loc-star]').click();
        await expect(page.locator('#rinks-list .rinks-head').first()).toHaveText('Your rinks (1)');
        const starred = page.locator('#rinks-list .rink-row', { hasText: 'Note Arena' });
        await expect(starred).toHaveClass(/starred/);
        await expect(starred.locator('[data-loc-star]')).toHaveText('★');
        await expect(page.locator('#rinks-list .rink-row[data-kept="1"]')).toHaveCount(6);     // that one row is new, the other six are not
        await app.noErrors();
    });

    test('a long list shows its first 80 and says so; typing narrows it', async ({ page, app }) => {
        for (let i = 1; i <= 130; i++) app.data['rinks.json'].rinks.push(rink(String(7000 + i), `Bulk Rink ${String(i).padStart(3, '0')}`, { district: 'North York', lat: 43.70 + i / 2000, lng: -79.40 }));
        await openRinks(page, app);
        await expect(rows(page)).toHaveCount(80);                          // filled in two steps, complete a moment later
        await expect(page.locator('#rinks-list .settings-hint')).toHaveText('The first 80 of 137. Type a name or an area to narrow it down.');
        await expect(pins(page)).toHaveCount(137);                         // the map is not cut short
        await page.fill('#rinks-search', 'bulk');
        await expect(page.locator('#rinks-list .settings-hint')).toHaveText('The best 80 of 130. Keep typing to narrow it down.');
        await expect(rows(page)).toHaveCount(80);
        await page.fill('#rinks-search', 'bulk rink 12');
        await expect(rows(page)).toHaveCount(12);                          // 120 to 129, and 012 and 112 (a word matches anywhere)
        await expect(page.locator('#rinks-list .settings-hint')).toHaveCount(0);
        const found = await names(page);
        expect(found[0]).toBe('Bulk Rink 120');                            // the names that start with what was typed come first
        expect(found.slice(10)).toEqual(['Bulk Rink 012', 'Bulk Rink 112']);
        await expect(page.locator('#rinks-list')).toHaveJSProperty('scrollTop', 0);
        await app.noErrors();
    });

    test('several letters inside one frame cost one pass over the list', async ({ page, app }) => {
        await openRinks(page, app);
        const passes = await page.evaluate(async () => {
            const input = document.getElementById('rinks-search');
            const real = SkateApp.Render.rinks;
            let n = 0;
            SkateApp.Render.rinks = function () { n++; return real.apply(this, arguments); };
            for (const text of ['w', 'wa', 'war', 'warn']) { input.value = text; input.dispatchEvent(new Event('input', { bubbles: true })); }
            await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
            SkateApp.Render.rinks = real;
            return n;
        });
        expect(passes).toBe(1);
        await expect(rows(page)).toHaveCount(1);
        await expect(rows(page).first()).toContainText('Warning Arena');
        await app.noErrors();
    });
});

test.describe('iPhone habits', () => {
    const SMALL = () => [...document.querySelectorAll('input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="color"]):not([type="hidden"]), select, textarea')]
        .map(e => ({ field: e.id || e.name || e.className || e.tagName, px: parseFloat(getComputedStyle(e).fontSize) })).filter(x => x.px < 16);

    test('on a touch screen no field is under 16px, upright or sideways, so iOS never zooms into one', async ({ page, app, isMobile }) => {
        test.skip(!isMobile, 'touch screens only: a mouse does not zoom into fields');
        await app.open();
        expect(await page.evaluate(SMALL)).toEqual([]);
        await page.click('#btn-rinks');
        await expect(rows(page).first()).toBeVisible();
        expect(await page.evaluate(SMALL)).toEqual([]);                     // the rink search (was 14px) and the city picker included
        expect(await page.locator('#rinks-search').evaluate(e => getComputedStyle(e).fontSize)).toBe('16px');
        await page.setViewportSize({ width: 844, height: 390 });            // sideways: wider than the old 767px rule reached
        expect(await page.evaluate(SMALL)).toEqual([]);
        expect(await page.evaluate(() => getComputedStyle(document.documentElement).touchAction)).toBe('manipulation');   // no double-tap zoom either
        await app.noErrors();
    });

    test('held sideways, the rinks sheet puts the map and the list side by side; upright again, one above the other', async ({ page, app }) => {
        await page.setViewportSize({ width: 844, height: 390 });
        await openRinks(page, app);
        const box = (sel) => page.locator(sel).boundingBox();
        let map = await box('#map-canvas'), list = await box('#rinks-list');
        expect(map.height).toBeGreaterThanOrEqual(150);                     // was 420px tall with 61px left for the list
        expect(list.height).toBeGreaterThanOrEqual(150);
        expect(map.y + map.height).toBeLessThanOrEqual(391);
        expect(list.y + list.height).toBeLessThanOrEqual(391);
        expect(list.x).toBeGreaterThanOrEqual(map.x + map.width - 1);       // beside the map, not under it
        await expect(page.locator('#rinks-search')).toBeInViewport();
        await expect(rows(page).first()).toBeInViewport();

        await page.setViewportSize({ width: 390, height: 844 });
        await expect.poll(async () => (await box('#rinks-list')).y).toBeGreaterThan(300);
        map = await box('#map-canvas'); list = await box('#rinks-list');
        expect(list.y).toBeGreaterThanOrEqual(map.y + map.height - 1);      // under the map again
        expect(Math.abs(list.x - map.x)).toBeLessThan(40);
        await app.noErrors();
    });

    test('a page left scrolled is put back; a field under the keyboard and a pinched-in page are left alone', async ({ page, app }) => {
        await app.open();
        // Give the shell something to scroll, the way iOS leaves it, then scroll it by hand.
        const shift = () => page.evaluate(() => {
            if (!document.getElementById('test-tall')) {
                const tall = document.createElement('div'); tall.id = 'test-tall'; tall.style.cssText = 'height:3000px';
                document.body.appendChild(tall);
                const inner = document.createElement('div'); inner.style.cssText = 'position:absolute;top:0;left:0;width:1px;height:3000px';
                document.querySelector('.main-content').appendChild(inner);
            }
            document.body.scrollTop = 60;
            document.querySelector('.main-content').scrollTop = 45;
        });
        const at = () => page.evaluate(() => [document.body.scrollTop, document.querySelector('.main-content').scrollTop]);
        await page.waitForTimeout(1400);                 // the page's own look-agains after loading are over: what follows is ours alone
        await shift();
        expect(await at()).toEqual([60, 45]);
        expect(await page.evaluate(() => SkateApp.settleViewport())).toBe(true);
        expect(await at()).toEqual([0, 0]);
        expect(await page.evaluate(() => SkateApp.settleViewport())).toBe(false);          // nothing to do the second time

        // the keyboard is up over a focused field: iOS scrolled on purpose
        await page.evaluate(() => Object.defineProperty(window.visualViewport, 'height', { configurable: true, get: () => window.innerHeight - 300 }));
        await page.focus('#search-input');
        await shift();
        expect(await page.evaluate(() => SkateApp.settleViewport())).toBe(false);
        expect(await at()).toEqual([60, 45]);

        // pinched in: the view is the reader's, typing or not
        await page.evaluate(() => { delete window.visualViewport.height; Object.defineProperty(window.visualViewport, 'scale', { configurable: true, get: () => 2 }); });
        expect(await page.evaluate(() => SkateApp.settleViewport())).toBe(false);
        expect(await at()).toEqual([60, 45]);
        await page.evaluate(() => { delete window.visualViewport.scale; });

        // the keyboard closes (the field loses focus): back to zero without being asked
        await page.evaluate(() => document.getElementById('search-input').blur());
        await expect.poll(at, { timeout: 3000 }).toEqual([0, 0]);

        // turning the phone: put back by itself, a moment after the event
        await shift();
        await page.evaluate(() => window.dispatchEvent(new Event('orientationchange')));
        await expect.poll(at, { timeout: 3000 }).toEqual([0, 0]);
        await app.noErrors();
    });
});
