// Settings: theme, time format, the community sections on and off (code
// loads on demand, sockets close), privacy toggles, backup export / import.
const { test, expect } = require('./fixtures');

test.describe('settings', () => {
    test('theme follows the project seed and the toggle', async ({ page, app, theme }) => {
        await app.open();
        await expect(page.locator('body')).toHaveClass(theme === 'dark' ? /dark-mode/ : /^(?!.*dark-mode)/);
        await page.click('#btn-settings');
        await page.click(`#settings-theme [data-theme="${theme === 'dark' ? 'light' : 'dark'}"]`);
        await expect(page.locator('body')).toHaveClass(theme === 'dark' ? /^(?!.*dark-mode)/ : /dark-mode/);
        const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
        expect(bg).toMatch(/^rgb/);
        await app.noErrors();
    });

    test('24-hour time changes every clock on the page', async ({ page, app }) => {
        await app.open();
        await expect(page.locator('.program-time').first()).toContainText(/[AP]M/);
        await page.click('#btn-settings');
        await page.click('#settings-timefmt [data-fmt="24h"]');
        await page.click('#btn-settings-close');
        await expect(page.locator('.program-time').first()).not.toContainText(/[AP]M/);
        await expect(page.locator('.program-time').first()).toContainText(/\d{2}:\d{2}/);
        await app.noErrors();
    });

    test('Chats on loads the community code and connects; both off closes the sockets', async ({ page, app }) => {
        await app.open();
        await expect(page.locator('#chats-panel')).toBeHidden();
        await page.click('#btn-settings');
        await page.click('#settings-sections [data-vis="showChats"]');
        await page.click('#btn-settings-close');
        await page.waitForFunction(() => window.SkateChat && SkateChat.booted && SkateNostr.connectedCount() > 0, null, { timeout: 20000 });
        await app.view('chats');
        await expect(page.locator('#conversation-list .conv-item')).toHaveCount(5);
        await page.click('#btn-settings');
        await page.click('#settings-sections [data-vis="showChats"]');
        await page.click('#btn-settings-close');
        await page.waitForFunction(() => !SkateChat.booted && SkateNostr.stopped && SkateNostr.connectedCount() === 0);
        await expect(page.locator('#chats-panel')).toBeHidden();
        await expect(page.locator('#programs-panel')).toBeVisible();
        await app.noErrors();
    });

    test('privacy toggles flip and persist', async ({ page, app }) => {
        await app.open();
        await page.click('#btn-settings');
        const inv = page.locator('#settings-privacy [data-priv="invisible"]');
        await expect(inv).not.toHaveClass(/active/);
        await inv.click();
        await expect(inv).toHaveClass(/active/);
        await page.reload();
        await page.waitForSelector('.program-item');
        await page.click('#btn-settings');
        await expect(page.locator('#settings-privacy [data-priv="invisible"]')).toHaveClass(/active/);
        await app.noErrors();
    });

    // Headless Chromium answers "denied" to every notification request, so the
    // refusal path is the one we can pin down: the toggle must fall back to off
    // and say why, never claim notifications are on.
    test('Notify: when the browser refuses, the toggle stays off and says why', async ({ page, app }) => {
        await app.open();
        await page.click('#btn-settings');
        await page.click('#settings-privacy [data-priv="notifyDesktop"]');
        await expect(page.locator('.toast')).toContainText('blocked');
        await expect(page.locator('#settings-privacy [data-priv="notifyDesktop"]')).not.toHaveClass(/active/);
        expect(await page.evaluate(() => SkateSettings.get('notifyDesktop'))).toBe(false);
        await app.noErrors();
    });

    test('export makes a backup; import restores it on a fresh profile', async ({ page, app }) => {
        await app.open();
        await page.click('#btn-settings');
        await page.click('#settings-timefmt [data-fmt="24h"]');
        await page.click('#btn-export-bundle');
        await expect(page.locator('.toast')).toContainText('Backup copied', { timeout: 20000 });
        const json = await page.evaluate(() => navigator.clipboard.readText());
        const bundle = JSON.parse(json);
        expect(bundle.app).toBe('toronto-skating');
        expect(bundle.identity.sk).toMatch(/^[0-9a-f]{64}$/);
        expect(bundle.settings.timeFormat).toBe('24h');
        const pk = await page.evaluate(() => JSON.parse(localStorage.getItem('skate_identity_v1')).pk);
        // a fresh device: wipe, then import
        await page.evaluate(() => { localStorage.clear(); });
        await page.reload();
        await page.waitForSelector('.program-item');
        await expect(page.locator('.program-time').first()).toContainText(/[AP]M/);
        page.once('dialog', (d) => d.accept(json));
        await page.click('#btn-settings');
        await page.click('#btn-import-key');
        await page.waitForEvent('load');
        await page.waitForSelector('.program-item');
        await expect(page.locator('.program-time').first()).not.toContainText(/[AP]M/);
        expect(await page.evaluate(() => JSON.parse(localStorage.getItem('skate_identity_v1')).pk)).toBe(pk);
    });
});
