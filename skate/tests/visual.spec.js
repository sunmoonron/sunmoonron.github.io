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
    test('rinks sheet', async ({ page, app }) => {
        await app.open();
        await page.click('#btn-rinks');
        await expect(page.locator('#rinks-list .rink-row').first()).toBeVisible();
        await expect(page).toHaveScreenshot('rinks.png', { mask: [page.locator('#map-canvas')] });
    });
    test('settings', async ({ page, app }) => {
        await app.open();
        await page.click('#btn-settings');
        await expect(page.locator('#settings-modal')).toBeVisible();
        await expect(page).toHaveScreenshot('settings.png', { mask: [page.locator('#identity-line'), page.locator('#qr-code, #settings-qr')] });
    });
});
