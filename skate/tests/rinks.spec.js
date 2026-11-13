// Rinks & map: the sheet, counts that agree, the city picker, tapping a row,
// a postal code, the You marker.
const { test, expect } = require('./fixtures');

const titleCount = (page) => page.locator('#rinks-title').innerText().then(t => +(t.match(/\((\d+)\)/) || [])[1]);
const listCount = (page) => page.locator('#rinks-scope span').first().innerText().then(t => +(t.match(/^(\d+)/) || [])[1]);

test.describe('rinks & map', () => {
    test('opens with pins and rows, counts agree, kind and city filters agree', async ({ page, app }) => {
        await app.open();
        await page.click('#btn-rinks');
        await expect(page.locator('#rinks-modal')).toBeVisible();
        await expect(page.locator('#rinks-list .rink-row').first()).toBeVisible();
        await expect(page.locator('.leaflet-marker-icon').first()).toBeVisible();
        expect(await titleCount(page)).toBe(7);                 // the Toronto rinks
        expect(await listCount(page)).toBe(7);
        await page.click('#map-filter-seg [data-mapfilter="indoor"]');
        expect(await titleCount(page)).toBe(6);
        expect(await listCount(page)).toBe(6);
        await page.selectOption('#rinks-city', 'all');
        expect(await titleCount(page)).toBe(7);                 // + Mississauga's indoor rink
        expect(await listCount(page)).toBe(7);
        await expect(page.locator('#rinks-list .rink-row', { hasText: 'Paul Coffey' })).toHaveCount(1);
        await page.click('#map-filter-seg [data-mapfilter="all"]');
        expect(await titleCount(page)).toBe(8);
        await page.selectOption('#rinks-city', 'Toronto');
        expect(await listCount(page)).toBe(7);
        await app.noErrors();
    });

    test('a rink row shows alerts, sessions and facts; tapping it opens its pin', async ({ page, app }) => {
        await app.open();
        await page.click('#btn-rinks');
        const alpha = page.locator('#rinks-list .rink-row', { hasText: 'Alpha Arena' });
        await expect(alpha.locator('.rink-alert')).toBeVisible();
        await expect(page.locator('#rinks-list .rink-row', { hasText: 'Expired Arena' }).locator('.rink-alert')).toHaveCount(0);
        await expect(page.locator('#rinks-list .rink-row', { hasText: 'Grossman' }).locator('.rink-meta')).toContainText('Skate rentals $6');
        await expect(page.locator('#rinks-list .rink-row', { hasText: 'Leaside' }).locator('.rink-meta')).toContainText('Helmets required for ages 12 and under');
        await page.locator('#rinks-list .rink-row', { hasText: 'Beta Park Rink' }).locator('.rink-meta').click();
        await expect(page.locator('.leaflet-popup-content')).toContainText('Beta Park Rink');
        await app.noErrors();
    });

    test('a postal code sets the distances and drops the You marker', async ({ page, app }) => {
        await app.open();
        await page.click('#btn-rinks');
        await page.fill('#rinks-search', 'M1J 3K4');
        await expect(page.locator('#btn-locator-search')).toContainText('Measure distances from “M1J 3K4”');
        await page.click('#btn-locator-search');
        await expect(page.locator('#locator-status')).toContainText('M1J');
        await expect(page.locator('#rinks-search')).toHaveValue('');              // it was a place, not a rink filter
        await expect(page.locator('#btn-clear-location')).toBeVisible();          // "Forget this spot", in the status line
        await expect(page.locator('.you-pin .you-dot')).toBeVisible();   // the pin's root box is 0×0 by design
        await expect(page.locator('#rinks-list .rink-row').first()).toContainText('Warning Arena');   // the nearest
        await expect(page.locator('#rinks-list .rink-row').first().locator('.rink-meta')).toContainText(/\d(\.\d)? ?(km|m)/);
        await app.noErrors();
    });

    test('one search box: typing an area, an address or a postal code filters the list and the map together', async ({ page, app }) => {
        await app.open();
        await page.click('#btn-rinks');
        await expect(page.locator('.leaflet-marker-icon').first()).toBeVisible();
        const pins = () => page.locator('.leaflet-marker-pane .leaflet-marker-icon:not(.you-pin-wrap)');
        const rows = page.locator('#rinks-list .rink-row');
        await expect(rows).toHaveCount(7);
        await expect(page.locator('#btn-rinks-search-clear')).toBeHidden();       // nothing typed: no ✕ to look at

        await page.fill('#rinks-search', 'scarborough');                          // the district, not in any rink's name
        await expect(rows).toHaveCount(1);
        await expect(rows.first()).toContainText('Warning Arena');
        await expect(pins()).toHaveCount(1);                                      // the map follows
        expect(await titleCount(page)).toBe(1);
        expect(await listCount(page)).toBe(1);
        await expect(page.locator('#btn-rinks-search-clear')).toBeVisible();

        await page.fill('#rinks-search', 'ARENA  alpha');                         // every word, any order, any case
        await expect(rows).toHaveCount(1);
        await expect(rows.first()).toContainText('Alpha Arena');
        await page.fill('#rinks-search', 'delta dr');                             // a street address
        await expect(rows.first()).toContainText('Note Arena');
        await page.fill('#rinks-search', 'm9w');                                  // a postal prefix, lower case
        await expect(rows).toHaveCount(1);
        await expect(rows.first()).toContainText('Expired Arena');
        await page.fill('#rinks-search', 'm9w5e5');                               // typed without the space
        await expect(rows.first()).toContainText('Expired Arena');

        await page.fill('#rinks-search', 'nowhere at all');
        await expect(rows).toHaveCount(0);
        await expect(page.locator('#rinks-list')).toContainText('No rink matches that');
        await expect(pins()).toHaveCount(0);

        await page.click('#btn-rinks-search-clear');                              // the ✕ brings everything back
        await expect(rows).toHaveCount(7);
        await expect(pins()).toHaveCount(7);
        await expect(page.locator('#btn-locator-search')).toBeHidden();
        await page.fill('#rinks-search', 'beta');
        await page.locator('#rinks-search').press('Escape');                      // so does Escape, without closing the sheet
        await expect(page.locator('#rinks-search')).toHaveValue('');
        await expect(page.locator('#rinks-modal')).toBeVisible();
        await app.noErrors();
    });

    test('the search box stays inside the sheet at phone width and its buttons are tappable', async ({ page, app }) => {
        await app.open();
        await page.click('#btn-rinks');
        await page.fill('#rinks-search', 'scarborough town centre, a long thing to type');
        const box = await page.locator('#rinks-search').boundingBox();
        const near = await page.locator('#btn-share-location').boundingBox();
        const sheet = await page.locator('#rinks-modal .modal').boundingBox();
        expect(box.height).toBeGreaterThanOrEqual(38);
        expect(near.height).toBeGreaterThanOrEqual(38);
        expect(box.x).toBeGreaterThanOrEqual(sheet.x);
        expect(near.x + near.width).toBeLessThanOrEqual(sheet.x + sheet.width + 1);
        const from = await page.locator('#btn-locator-search').boundingBox();     // long text is cut with an ellipsis, not wrapped off screen
        expect(from.x + from.width).toBeLessThanOrEqual(sheet.x + sheet.width + 1);
        expect(from.height).toBeLessThan(60);
        await app.noErrors();
    });

    test('Show sessions from a rink turns into a green pill', async ({ page, app }) => {
        await app.open();
        await page.click('#btn-rinks');
        await page.locator('#rinks-list .rink-row', { hasText: 'Beta Park Rink' }).locator('[data-loc-filter]').click();
        await expect(page.locator('#rinks-modal')).toBeHidden();
        await expect(page.locator('#active-filters .pill.rink')).toContainText('Beta Park Rink');
        await expect(page.locator('.program-item')).toHaveCount(1);
        await page.click('#active-filters .pill.rink');
        expect(await page.locator('.program-item').count()).toBeGreaterThan(1);
        await app.noErrors();
    });
});
