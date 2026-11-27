// v3.20: the blue jay. A small drawn bird perched beside the title: a tap offers a tip, the temperature
// in its own words, a blue jay fact and a feed; what it says shows in a bubble. In the guide it leaves
// its perch for the guide's card and flies home when the guide ends or is skipped. With "reduce motion"
// on it never flies.
const { test, expect } = require('./fixtures');

test('it perches left of the title; a tap offers four things; what it says shows in a bubble that a tap puts away', async ({ page, app }) => {
    await app.open();
    const jay = page.locator('#jay');
    await expect(jay.locator('svg')).toBeVisible();
    await expect(jay).toHaveAttribute('aria-label', /blue jay/i);
    const [j, h] = [await jay.boundingBox(), await page.locator('.top-bar h1').boundingBox()];
    expect(j.x + j.width).toBeLessThanOrEqual(h.x + 2);
    expect(j.width).toBeGreaterThanOrEqual(24);                                         // a fair tap target
    await jay.click();
    await expect(page.locator('#popover .popover-title')).toHaveText('The blue jay');
    await expect(page.locator('#popover .popover-item')).toHaveText(['A tip', 'How cold is it?', 'A blue jay fact', 'Feed the bird']);
    await page.locator('#popover .popover-item', { hasText: 'A blue jay fact' }).click();
    const say = page.locator('.jay-say');
    await expect(say).toBeVisible();
    await expect(say).toHaveAttribute('role', 'status');
    expect((await say.textContent()).length).toBeGreaterThan(20);
    await say.click();
    await expect(say).toBeHidden();
    await jay.click();
    await page.locator('#popover .popover-item', { hasText: 'Feed the bird' }).click();
    await expect(say).toContainText(/seed|peanut|crunch|full/i);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await app.noErrors();
});

test('the temperature: its own words when the weather is known, and no invented number when it is not', async ({ page, app }) => {
    await app.open();
    const line = (w) => page.evaluate((cur) => { const keep = window.SkateWeather; window.SkateWeather = { current: cur }; try { return SkateBird.weatherLine(); } finally { window.SkateWeather = keep; } }, w);
    expect(await line(null)).toContain('cannot see the sky');
    expect(await line({ temp: -12.4, feels: -19, label: 'Toronto' })).toBe('-12° in Toronto, feels like -19°. That is cold even for me. Cover your face!');
    expect(await line({ temp: -3, feels: -8, label: 'My location' })).toBe('-3°, feels like -8°. Mittens and a hat.');
    expect(await line({ temp: 1, feels: 1, label: 'Toronto' })).toBe('1° in Toronto. Good ice weather.');
    expect(await line({ temp: 6, feels: 4, label: 'Toronto' })).toContain('Outdoor ice goes soft');
    expect(await line({ temp: 14, feels: 14, label: 'Toronto' })).toContain('Too warm for outdoor ice');
    expect(await line({ temp: '<img>', feels: 2, label: 'x' })).toContain('cannot see the sky');
});

test('in the guide it leaves its perch for the card, and flies home when the guide is skipped', async ({ page, app }) => {
    await app.open();
    await page.evaluate(() => SkateTour.start());
    const flyer = page.locator('.jay-flyer');
    await expect(flyer).toBeVisible();
    await expect(page.locator('#jay')).toHaveClass(/\baway\b/);
    // it stands on the card's top edge
    await expect.poll(async () => {
        const [f, c] = await page.evaluate(() => [document.querySelector('.jay-flyer').getBoundingClientRect(), document.querySelector('.tour-card').getBoundingClientRect()].map(r => ({ top: r.top, bottom: r.bottom, left: r.left, right: r.right })));
        return Math.abs(f.bottom - 5 - c.top) < 4 && f.right <= c.right;
    }).toBe(true);
    await page.locator('.tour-skip').click();
    await expect(flyer).toBeHidden();
    await expect(page.locator('#jay')).not.toHaveClass(/\baway\b/);
    expect(await page.evaluate(() => SkateBird.atHome)).toBe(true);
    await app.noErrors();
});

test('with "reduce motion" on, the bird stays on its perch through the guide', async ({ page, app }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await app.open();
    await page.evaluate(() => SkateTour.start());
    await expect(page.locator('.tour-card')).toBeVisible();
    await page.waitForTimeout(400);
    await expect(page.locator('.jay-flyer:not(.hidden)')).toHaveCount(0);
    await expect(page.locator('#jay')).not.toHaveClass(/\baway\b/);
    await page.locator('.tour-skip').click();
    await app.noErrors();
});
