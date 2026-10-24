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
        await page.fill('#locator-input', 'M1J 3K4');
        await page.click('#btn-locator-search');
        await expect(page.locator('#locator-status')).toContainText('M1J');
        await expect(page.locator('.you-pin .you-dot')).toBeVisible();   // the pin's root box is 0×0 by design
        await expect(page.locator('#rinks-list .rink-row').first()).toContainText('Warning Arena');   // the nearest
        await expect(page.locator('#rinks-list .rink-row').first().locator('.rink-meta')).toContainText(/\d(\.\d)? ?(km|m)/);
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
