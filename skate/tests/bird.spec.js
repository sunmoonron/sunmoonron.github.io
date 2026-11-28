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
    await expect(page.locator('#popover .popover-item')).toHaveText(['A tip', 'How cold is it?', 'A blue jay fact', 'Feed the bird', 'Sit still']);
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

// v3.21: a life of its own. Now and then it flies an arc and lands somewhere at the top, or does a small
// act where it sits; it sleeps at night, cheers a saved session, and "Sit still" stops all of it.
test.describe('its own little acts', () => {
    const run = (page, name) => page.evaluate(async (n) => { SkateBird.tempo = 0.12; const flown = []; const t = setInterval(() => { const f = document.querySelector('.jay-flyer'); if (f && !f.classList.contains('hidden')) flown.push(Math.round(f.getBoundingClientRect().left)); }, 15); const did = await SkateBird.act(n); clearInterval(t); return { did, span: flown.length ? Math.max(...flown) - Math.min(...flown) : 0 }; }, name);

    test('a lap and a visit: it leaves its perch, travels across the top, and is back home after', async ({ page, app }) => {
        await app.open();
        for (const name of ['lap', 'visit']) {
            const r = await run(page, name);
            expect(r.did).toBe(name);
            expect(r.span, `${name} went somewhere`).toBeGreaterThan(40);
            expect(await page.evaluate(() => SkateBird.atHome)).toBe(true);
            await expect(page.locator('.jay-flyer')).toBeHidden();
            await expect(page.locator('#jay')).not.toHaveClass(/\baway\b/);
        }
        // with room above the bar it can land on top of the switch: the flight then rises above the bar's own row
        await page.evaluate(() => { document.querySelector('.top-bar').style.paddingTop = '70px'; });
        const tops = await page.evaluate(async () => { SkateBird.tempo = 0.12; const ys = []; const t = setInterval(() => { const f = document.querySelector('.jay-flyer'); if (f && !f.classList.contains('hidden')) ys.push(f.getBoundingClientRect().top); }, 15); await SkateBird.act('visit'); clearInterval(t); return { min: Math.min(...ys), home: document.getElementById('jay').getBoundingClientRect().top }; });
        expect(tops.min).toBeLessThan(tops.home - 6);
        expect(tops.min).toBeGreaterThanOrEqual(-1);                                      // never off the top of the screen
        await app.noErrors();
    });

    test('the small acts run where it sits; a saved session gets a cheer', async ({ page, app }) => {
        await app.open();
        for (const name of ['hops', 'preen', 'look', 'sing', 'shiver']) expect((await run(page, name)).did).toBe(name);
        expect(await page.evaluate(() => SkateBird.atHome)).toBe(true);
        await page.locator('.program-item button[data-act="fav"]').first().click();
        await expect(page.locator('.jay-note').first()).toBeAttached();                     // its two notes (the hop itself is over in under half a second)
        await app.noErrors();
    });

    test('not while a sheet or a menu is open, nor while typing; Sit still stops everything and is remembered', async ({ page, app }) => {
        await app.open();
        await page.click('#btn-filters');
        expect((await run(page, 'hops')).did).toBe(false);
        await page.click('#btn-filters-close');
        await page.locator('#search-input').focus();
        expect((await run(page, 'hops')).did).toBe(false);
        await page.locator('#search-input').blur();
        await page.click('#jay');
        await page.locator('#popover .popover-item', { hasText: 'Sit still' }).click();
        await expect(page.locator('#jay')).toHaveClass(/\bstill\b/);
        expect(await page.evaluate(() => SkateSettings.get('birdStill'))).toBe(true);
        await page.locator('.jay-say').click();
        expect((await run(page, 'lap')).did).toBe(false);
        expect(await page.locator('#jay .jay-eye').evaluate(e => getComputedStyle(e).animationName)).toBe('none');
        await page.reload();
        await page.waitForSelector('.program-item');
        await expect(page.locator('#jay')).toHaveClass(/\bstill\b/);
        await page.click('#jay');
        await expect(page.locator('#popover .popover-item').last()).toHaveText('Fly around again');
        await app.noErrors();
    });

    test('asleep from 10 pm to 6 am (eyes shut, no acts) until a tap; with reduce motion it never acts', async ({ page, app }) => {
        await app.open();
        await page.evaluate(() => SkateBird.mood(23));
        await expect(page.locator('#jay')).toHaveClass(/\basleep\b/);
        await expect.poll(() => page.locator('#jay .jay-eye').evaluate(e => getComputedStyle(e).transform)).toMatch(/matrix\(1, 0, 0, 0\.12/);   // the lid closes in a few hundredths of a second
        await page.evaluate(() => SkateBird.mood(3));
        await expect(page.locator('#jay')).toHaveClass(/\basleep\b/);
        await page.evaluate(() => SkateBird.mood(13));
        await expect(page.locator('#jay')).not.toHaveClass(/\basleep\b/);
        await page.emulateMedia({ reducedMotion: 'reduce' });
        expect((await run(page, 'lap')).did).toBe(false);
        await app.noErrors();
    });
});

// v3.22: lifelike between acts. Its head darts and holds, it blinks, its crest lifts at a tap; the drawing
// carries the real bird's marks (the necklace, the white wing bar, barred wings and tail with white corners).
test.describe('lifelike', () => {
    test('the drawing has the blue jay\'s field marks, in parts that can move on their own', async ({ page, app }) => {
        await app.open();
        for (const part of ['.jay-crest', '.jay-collar', '.jay-bar-white', '.jay-tail .jay-bars', '.jay-wing .jay-bars', '.jay-tail .jay-white', '.jay-bill', '.jay-eye', '.jay-legs', '.jay-twig'])
            await expect(page.locator(`#jay svg ${part}`).first(), part).toBeAttached();
        expect(await page.locator('#jay svg .jay-tail .jay-bars').evaluateAll(els => els.reduce((n, e) => n + (e.getAttribute('d').match(/M/g) || []).length, 0))).toBeGreaterThanOrEqual(12);   // barred, not plain
    });

    test('a tap elsewhere: it looks that way (down and to the right) with its crest up, then settles; by itself it keeps moving', async ({ page, app }) => {
        await app.open();
        const v = (name) => page.locator('#jay').evaluate((b, n) => b.style.getPropertyValue(n), name);
        await page.mouse.click(300, 560);
        expect(parseFloat(await v('--jay-head'))).toBeGreaterThan(4);                         // beak down toward the tap
        expect(parseFloat(await v('--jay-crest'))).toBeGreaterThanOrEqual(10);                // crest UP: its tip is behind the pivot, so up is a positive turn (v3.24: it used to go down)
        await page.mouse.click(300, 2);                                                       // and up for something above it
        expect(parseFloat(await v('--jay-head'))).toBeLessThan(0);
        // left alone, the numbers keep changing: record every change for a few seconds
        await page.evaluate(() => { window.__moves = new Set(); new MutationObserver(() => window.__moves.add(document.getElementById('jay').getAttribute('style'))).observe(document.getElementById('jay'), { attributes: true, attributeFilter: ['style'] }); });
        await page.waitForTimeout(6000);
        expect(await page.evaluate(() => window.__moves.size)).toBeGreaterThanOrEqual(3);
        await app.noErrors();
    });

    test('Sit still, sleep and reduce motion stop the small movements too', async ({ page, app }) => {
        await app.open();
        await page.click('#jay');
        await page.locator('#popover .popover-item', { hasText: 'Sit still' }).click();
        await page.locator('.jay-say').click();
        await page.mouse.click(300, 560);
        expect(await page.locator('#jay').evaluate(b => b.style.getPropertyValue('--jay-head'))).toBe('');
        expect(await page.locator('#jay .jay-chest').evaluate(e => getComputedStyle(e).animationName)).toBe('none');
        await app.noErrors();
    });
});
