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

    test('a filter that needs a spot asks on the map, with no toast over the search box', async ({ page, app, isMobile }) => {
        await app.open();
        await page.evaluate(() => SkateApp.Actions.setRadius(5));
        await expect(page.locator('#map-view')).toBeVisible();
        await expect(page.locator('#map-ask')).toBeVisible();
        await expect(page.locator('#map-ask-title')).toHaveText('Where from?');
        await expect(page.locator('#map-ask-text')).toHaveText('Within 5 km needs a starting point. The filter applies as soon as it is set.');
        await expect(page.locator('#toast-container .toast')).toHaveCount(0);
        await expect(page.locator('#map-radius .fchip.wanted')).toHaveText('5');         // the distance that is waiting for a spot
        if (!isMobile) await expect(page.locator('#map-ask-input')).toBeFocused();
        // the search box is not covered by anything
        const box = await page.locator('#rinks-search').boundingBox();
        const onTop = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.id, [box.x + box.width / 2, box.y + box.height / 2]);
        expect(onTop).toBe('rinks-search');
        // typing a rink's name keeps the question; a spot answers it
        await page.fill('#rinks-search', 'alpha');
        await expect(page.locator('#map-ask')).toBeVisible();
        await page.fill('#rinks-search', 'M1J 3K4');
        await page.locator('#rinks-search').press('Enter');
        await expect(page.locator('#locator-status')).toContainText('M1J');
        await expect(page.locator('#map-ask')).toBeHidden();
        await expect(page.locator('#active-filters .pill.radius')).toContainText('Within 5 km');
        await app.noErrors();
    });

    test('the next time the map opens by itself, the question is gone', async ({ page, app }) => {
        await app.open();
        await page.evaluate(() => SkateApp.Actions.setRadius(5));
        await expect(page.locator('#map-ask')).toBeVisible();
        await page.click('#btn-list');
        await page.click('#btn-rinks');
        await expect(page.locator('#rinks-list .rink-row').first()).toBeVisible();
        await expect(page.locator('#map-ask')).toBeHidden();
        await app.noErrors();
    });
});
