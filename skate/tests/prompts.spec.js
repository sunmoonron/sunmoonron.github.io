// v3.12.2: three things that got in the way. The Update bar said a newer version was ready
// on every return to the tab (a script the app loads later was counted as new); the install
// card's main button was white on white in light mode; a toast asking for a spot covered the
// Rinks & map search box.
const { test, expect } = require('./fixtures');

/** WCAG contrast ratio of an element's text against the first solid background behind it. */
const contrastOf = (locator) => locator.evaluate((el) => {
    const rgb = (s) => (s.match(/[\d.]+/g) || []).map(Number);
    const lum = ([r, g, b]) => [r, g, b].map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i], 0);
    let bg = null;
    for (let n = el; n && !bg; n = n.parentElement) { const c = rgb(getComputedStyle(n).backgroundColor); if (c.length >= 3 && (c.length < 4 || c[3] > 0.9)) bg = c; }
    const fg = rgb(getComputedStyle(el).color), a = lum(fg), b = lum(bg || [255, 255, 255]);
    return Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100;
});

test.describe('prompts that got in the way', () => {
    test('a script the app loads later (the members\' entrance) is not a newer version', async ({ page, app }) => {
        await app.open();
        await page.evaluate(() => SkateApp.Actions.openGate({ quiet: true }));
        await expect(page.locator('script[src*="projects/js/gate.js"]')).toHaveCount(1);
        expect(await page.evaluate(() => SkateApp.Actions.checkForUpdate({ force: true }))).toBeNull();
        await expect(page.locator('#update-bar')).toBeHidden();
        // a real new release still shows the bar
        await page.route('**/skate/?fresh=*', async (route) => {
            const res = await route.fetch();
            route.fulfill({ response: res, body: (await res.text()).replace(/app\.js\?v=\d+/, 'app.js?v=99999') });
        });
        const upd = await page.evaluate(() => SkateApp.Actions.checkForUpdate({ force: true }));
        expect(upd && upd.signature).toContain('app.js?v=99999');
        await expect(page.locator('#update-bar')).toBeVisible();
        await app.noErrors();
    });

    test.describe('the install card', () => {
        test.use({ settings: { installSeen: false } });
        test('both its buttons are readable', async ({ page, app, isMobile }) => {
            test.skip(!isMobile, 'the card only shows in a phone browser');
            await app.open();
            const how = page.locator('#install-hint [data-install="how"]'), later = page.locator('#install-hint [data-install="later"]');
            await expect(how).toBeVisible();
            expect(await contrastOf(how)).toBeGreaterThanOrEqual(4.5);          // was 1.0 (white on white) in light mode
            expect(await contrastOf(later)).toBeGreaterThanOrEqual(4.5);
            await app.noErrors();
        });
    });

    test('a filter that needs a spot asks inside Rinks & map, with no toast over the search box', async ({ page, app, isMobile }) => {
        await app.open();
        await page.evaluate(() => SkateApp.Actions.setRadius(5));
        await expect(page.locator('#rinks-modal')).toBeVisible();
        const status = page.locator('#locator-status');
        await expect(status).toHaveText('Within 5 km needs a starting point. Type a place or a postal code, or tap Near me: the filter applies as soon as it is set.');
        await expect(status).toHaveClass(/ask/);
        await expect(page.locator('#toast-container .toast')).toHaveCount(0);
        if (!isMobile) await expect(page.locator('#rinks-search')).toBeFocused();
        // the search box is not covered by anything
        const box = await page.locator('#rinks-search').boundingBox();
        const onTop = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.id, [box.x + box.width / 2, box.y + box.height / 2]);
        expect(onTop).toBe('rinks-search');
        // typing keeps the question; a spot replaces it
        await page.fill('#rinks-search', 'alpha');
        await expect(status).toHaveClass(/ask/);
        await page.fill('#rinks-search', 'M1J 3K4');
        await page.locator('#rinks-search').press('Enter');
        await expect(status).toContainText('M1J');
        await expect(status).not.toHaveClass(/ask/);
        await app.noErrors();
    });

    test('the next time the sheet opens by itself, the question is gone', async ({ page, app }) => {
        await app.open();
        await page.evaluate(() => SkateApp.Actions.setRadius(5));
        await expect(page.locator('#locator-status')).toHaveClass(/ask/);
        await page.click('#btn-rinks-close');
        await page.click('#btn-rinks');
        await expect(page.locator('#locator-status')).not.toHaveClass(/ask/);
        await expect(page.locator('#locator-status')).toContainText('Type a rink, an area or your postal code');
        await app.noErrors();
    });
});
