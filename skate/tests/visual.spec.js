// Screenshot baselines per project (desktop/phone × light/dark). Run with
// `npm run test:visual`; re-baseline deliberately with `npm run test:visual:update`
// after a change that is MEANT to move pixels (e.g. the CSS consolidation).
const { test, expect } = require('./fixtures');

test.describe('visual', () => {
    test('schedule', async ({ page, app }) => {
        await app.open();
        await expect(page).toHaveScreenshot('schedule.png', { mask: [page.locator('#weather-chip')] });
    });
    test('filters sheet', async ({ page, app }) => {
        await app.open();
        await page.click('#btn-filters');
        await expect(page.locator('#filters-modal')).toBeVisible();
        await expect(page).toHaveScreenshot('filters.png');
    });
    test('the map view', async ({ page, app, isMobile }) => {
        await app.open();
        await page.click('#btn-rinks');
        await expect(page.locator('#rinks-list .rink-row').first()).toBeVisible();
        await expect(page.locator('.leaflet-marker-icon').first()).toBeVisible();
        if (isMobile) {                                                           // the sheet has taken its height (beside the map it has none to take)…
            await expect(page.locator('#map-view')).toHaveAttribute('data-rows2', /\d+/);
            await page.waitForTimeout(350);                                        // …and has slid to it
        }
        // no mask: the tiles are blocked in tests and the pins are drawn by the page, so the map is the same every time
        // (a mask over the canvas would also cover the rink list, which lies over it on a phone)
        await expect(page).toHaveScreenshot('map.png');
    });
    test('settings', async ({ page, app }) => {
        await app.open();
        await page.click('#btn-more'); await page.click('#btn-settings');
        await expect(page.locator('#settings-modal')).toBeVisible();
        await expect(page).toHaveScreenshot('settings.png', { mask: [page.locator('#identity-line'), page.locator('#qr-code, #settings-qr')] });
    });
});
