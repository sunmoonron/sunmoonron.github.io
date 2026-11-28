// The Map view (v3.23): one switch for List | Calendar | Map, counts that follow the filters, the
// question on the first look, the distance chips and the ring, and the rink list as a sheet on phones.
const { test, expect } = require('./fixtures');

const row = (page, name) => page.locator('#rinks-list .rink-row', { hasText: name });
const pin = (page, name) => page.locator(`.leaflet-marker-pane .leaflet-marker-icon[title="${name}"] .rink-pin`);
const openMap = async (page, app) => {
    await app.open();
    await page.click('#btn-rinks');
    await expect(page.locator('.leaflet-marker-icon').first()).toBeVisible();
};

test.describe('the map is a view', () => {
    test('List, Calendar and Map are one switch, and the map sits under the list\'s own pills', async ({ page, app }) => {
        await app.open();
        await expect(page.locator('#view-seg button')).toHaveText(['List', 'Calendar', '▾', 'Map']);
        await page.click('#btn-rinks');
        await expect(page.locator('#map-view')).toBeVisible();
        for (const [id, on] of [['btn-list', 'false'], ['btn-cal', 'false'], ['btn-rinks', 'true']]) await expect(page.locator(`#${id}`)).toHaveAttribute('aria-pressed', on);
        await expect(page.locator('#active-filters .pill.city')).toBeVisible();          // the same pills…
        await expect(page.locator('#active-filters .pill.ice')).toBeVisible();
        await expect(page.locator('#btn-filters')).toBeVisible();                        // …and the same Filters
        await expect(page.locator('#db-when')).toHaveText('Any day');                    // the map counts every day coming up, and says so
        await expect(page.locator('#program-list')).toBeHidden();
        // the pills stay on one line over the map
        const pills = await page.locator('#active-filters .pill').evaluateAll(els => els.map(e => Math.round(e.getBoundingClientRect().top)));
        expect(new Set(pills).size).toBe(1);

        await page.click('#btn-cal');                                                    // Calendar and List are also the way out
        await expect(page.locator('#map-view')).toBeHidden();
        await expect(page.locator('#calendar-wrap')).toBeVisible();
        await expect(page.locator('#btn-cal')).toHaveAttribute('aria-pressed', 'true');
        await page.click('#btn-rinks');
        await expect(page.locator('#calendar-wrap')).toBeHidden();
        await page.click('#btn-list');
        await expect(page.locator('#program-list')).toBeVisible();
        await expect(page.locator('#search-input')).toBeVisible();
        await expect(page.locator('#rinks-search')).toBeHidden();
        await app.noErrors();
    });

    test('counts follow the filters: a rink with nothing for the day reads "None match" and its pin is hollow', async ({ page, app }) => {
        await openMap(page, app);
        const alpha = row(page, 'Alpha Arena').locator('.rink-sessions');
        await expect(alpha).toHaveText('1 session');                                     // its hockey is off by default, as on the list
        await expect(pin(page, 'Alpha Arena')).toHaveClass(/\bindoor\b/);
        await expect(pin(page, 'Alpha Arena')).not.toHaveClass(/\boff\b/);
        await expect(pin(page, 'Beta Park Rink')).toHaveClass(/\boutdoor\b/);            // a pin is the colour of its ice

        await page.click('#db-when');                                                    // the day bar is the list's own
        await page.locator('#popover .popover-item', { hasText: 'Tomorrow' }).click();
        await expect(page.locator('#db-when')).toHaveText('Tomorrow');
        await expect(alpha).toHaveText('None match');
        await expect(alpha).toBeDisabled();
        await expect(alpha).toHaveAttribute('title', 'None of the 2 sessions coming up here match your filters');
        await expect(pin(page, 'Alpha Arena')).toHaveClass(/\boff\b/);
        await expect(row(page, 'Leaside').locator('.rink-sessions')).toHaveText('1 session');
        await expect(pin(page, 'Leaside Memorial Community Gardens')).not.toHaveClass(/\boff\b/);
        await expect(page.locator('#rinks-count')).toHaveText('7 rinks');                // nothing is hidden for having no match

        await row(page, 'Alpha Arena').locator('.rink-meta').click();                    // its pin says the same
        await expect(page.locator('.leaflet-popup-content')).toContainText('none of the 2 sessions coming up here match your filters');
        await expect(page.locator('.leaflet-popup-content [data-map-sessions]')).toHaveCount(0);

        // a rink's sessions: out of the map, to the list, with that rink as a pill
        await row(page, 'Leaside').locator('.rink-sessions').click();
        await expect(page.locator('#map-view')).toBeHidden();
        await expect(page.locator('.program-item')).toHaveCount(1);
        await expect(page.locator('#active-filters .pill.rink')).toContainText('Leaside');
        await app.noErrors();
    });

    test('a pin tapped brings its rink to the top of the list', async ({ page, app }) => {
        await openMap(page, app);
        await page.locator('.leaflet-marker-pane .leaflet-marker-icon[title="Note Arena"]').dispatchEvent('click');
        await expect(row(page, 'Note Arena')).toHaveClass(/focused/);
        await expect(row(page, 'Note Arena')).toBeInViewport();
        await expect(page.locator('.leaflet-popup-content')).toContainText('Note Arena');
        await app.noErrors();
    });
});

test.describe('the distance on the map', () => {
    test('chips on the list set the same filter as the pill, and draw a ring around the spot', async ({ page, app }) => {
        await openMap(page, app);
        await page.fill('#rinks-search', 'M1J 3K4');
        await page.click('#btn-locator-search');                                         // the mocked geocoder answers with a point beside Warning Arena
        await expect(page.locator('#locator-status')).toContainText('M1J');
        await expect(page.locator('.radius-ring')).toHaveCount(0);                       // a spot alone is no filter
        await expect(page.locator('#rinks-count')).toHaveText('7 rinks');
        await expect(page.locator('#map-radius .fchip.active')).toHaveText('Any');

        await page.locator('#map-radius .fchip', { hasText: /^2$/ }).click();
        await expect(page.locator('#rinks-count')).toHaveText('1 rink');
        await expect(page.locator('#rinks-list .rink-row')).toHaveCount(1);
        await expect(row(page, 'Warning Arena')).toHaveCount(1);
        await expect(page.locator('.leaflet-marker-pane .leaflet-marker-icon:not(.you-pin-wrap)')).toHaveCount(1);
        await expect(page.locator('.radius-ring')).toHaveCount(1);
        await expect(page.locator('#active-filters .pill.radius')).toContainText('Within 2 km');   // the list's pill, the same filter
        await expect(page.locator('#map-radius .fchip.active')).toHaveText('2');

        await page.fill('#rinks-search', 'alpha');                                        // a name looks past the distance
        await expect(row(page, 'Alpha Arena')).toHaveCount(1);
        await expect(page.locator('#map-radius')).toHaveClass(/paused/);
        await page.click('#btn-rinks-search-clear');
        await expect(page.locator('#rinks-list .rink-row')).toHaveCount(1);

        await page.click('#active-filters .pill.radius .pill-x');                         // cleared from the pill: the chips and the ring follow
        await expect(page.locator('#map-radius .fchip.active')).toHaveText('Any');
        await expect(page.locator('.radius-ring')).toHaveCount(0);
        await expect(page.locator('#rinks-count')).toHaveText('7 rinks');
        await app.noErrors();
    });
});

test.describe('the first look at the map', () => {
    test.use({ settings: { mapAsked: false } });

    test('asks once where from; an address answers it with a 5 km ring', async ({ page, app }) => {
        await openMap(page, app);
        const ask = page.locator('#map-ask');
        await expect(ask).toBeVisible();
        await expect(page.locator('#map-ask-title')).toHaveText('Find rinks near you');
        await expect(page.locator('#rinks-count')).toHaveText('7 rinks');                 // every rink is already there behind the question
        await page.click('#btn-ask-go');                                                  // nothing typed
        await expect(page.locator('#map-ask-err')).toHaveText('Type an address, an intersection or a postal code.');
        await page.fill('#map-ask-input', 'M1J 3K4');
        await page.locator('#map-ask-input').press('Enter');
        await expect(ask).toBeHidden();
        await expect(page.locator('#locator-status')).toContainText('M1J');
        await expect(page.locator('#active-filters .pill.radius')).toContainText('Within 5 km');
        await expect(page.locator('#map-radius .fchip.active')).toHaveText('5');
        await expect(page.locator('.radius-ring')).toHaveCount(1);
        await expect(page.locator('#rinks-count')).toHaveText('1 rink');
        await expect(page.locator('#rinks-list .rink-row').first()).toContainText('Warning Arena');
        expect(await page.evaluate(() => SkateSettings.get('mapAsked'))).toBe(true);

        await page.click('#btn-clear-location');                                          // forgetting the spot does not bring the question back
        await expect(page.locator('#active-filters .pill.radius')).toHaveCount(0);
        await expect(page.locator('#rinks-count')).toHaveText('7 rinks');
        await expect(ask).toBeHidden();
        await app.noErrors();
    });

    test('"Not now" shows every rink and puts the question away for good', async ({ page, app }) => {
        await openMap(page, app);
        await page.click('#btn-ask-skip');
        await expect(page.locator('#map-ask')).toBeHidden();
        await expect(page.locator('#rinks-list .rink-row')).toHaveCount(7);
        await expect(page.locator('#active-filters .pill.radius')).toHaveCount(0);
        await page.click('#btn-list');
        await page.click('#btn-rinks');
        await expect(page.locator('#map-ask')).toBeHidden();
        await page.reload();
        await page.waitForSelector('.program-item');
        await page.click('#btn-rinks');
        await expect(page.locator('#rinks-list .rink-row').first()).toBeVisible();
        await expect(page.locator('#map-ask')).toBeHidden();
        await app.noErrors();
    });

    test('Use my location: a refusal is said on the card, a yes draws the ring', async ({ page, app, context }) => {
        await openMap(page, app);
        await page.click('#btn-ask-locate');                                              // no permission in this browser
        await expect(page.locator('#map-ask-err')).toBeVisible();
        await expect(page.locator('#map-ask')).toBeVisible();
        await expect(page.locator('#btn-ask-locate')).toHaveText('Use my location');
        await expect(page.locator('#active-filters .pill.radius')).toHaveCount(0);
        expect(await page.evaluate(() => SkateSettings.get('radius'))).toBeFalsy();

        await context.grantPermissions(['geolocation']);
        await context.setGeolocation({ latitude: 43.6541, longitude: -79.3801 });         // beside Alpha Arena
        await page.click('#btn-ask-locate');
        await expect(page.locator('#map-ask')).toBeHidden();
        await expect(page.locator('#active-filters .pill.radius')).toContainText('Within 5 km');
        await expect(page.locator('.radius-ring')).toHaveCount(1);
        await expect(page.locator('.you-pin .you-dot')).toBeVisible();
        await expect(page.locator('#rinks-list .rink-row').first()).toContainText('Alpha Arena');   // nearest first
        await app.noErrors();
    });
});

test.describe('the rink list over the map', () => {
    test('on a phone it is a sheet: two rinks at a glance, pulled up by its grip, out of the way for the map', async ({ page, app, isMobile }) => {
        test.skip(!isMobile, 'beside the map on a wide screen');
        await openMap(page, app);
        const view = page.locator('#map-view'), sheet = page.locator('#map-sheet'), grip = page.locator('#sheet-grip');
        const box = (l) => l.boundingBox();
        // the sheet slides to its height: wait until it is the height it was told to be
        const settled = () => expect.poll(async () => Math.abs((await box(sheet)).height - await view.evaluate(v => parseFloat(getComputedStyle(v).getPropertyValue('--sheet-h'))))).toBeLessThan(1.5);
        await expect(view).toHaveAttribute('data-stop', 'peek');
        await expect(view).toHaveAttribute('data-rows2', /\d+/);                          // the peek has been sized to its first two rows
        await settled();
        const stage = await box(view);
        let s = await box(sheet);
        expect(s.y).toBeGreaterThan(stage.y + stage.height * 0.38);                       // the map keeps the upper part
        expect(Math.abs((s.y + s.height) - (stage.y + stage.height))).toBeLessThan(3);
        await expect(page.locator('#rinks-list .rink-row').nth(0)).toBeInViewport();
        await expect(page.locator('#rinks-list .rink-row').nth(1)).toBeInViewport();      // the report was "only one rink shows"
        // the map's credit line stays readable above the sheet
        const credit = await box(page.locator('.leaflet-control-attribution'));
        expect(credit.y + credit.height).toBeLessThanOrEqual(s.y + 1);

        await grip.click();                                                               // a tap on the grip: all the way up
        await expect(view).toHaveAttribute('data-stop', 'full');
        await expect(grip).toHaveAttribute('aria-expanded', 'true');
        await settled();
        expect((await box(sheet)).height).toBeGreaterThan(stage.height - 20);
        await page.locator('#rinks-list .rink-row', { hasText: 'Beta Park Rink' }).locator('.rink-meta').click();   // a rink picked: the map comes back
        await expect(view).toHaveAttribute('data-stop', 'peek');
        await expect(page.locator('.leaflet-popup-content')).toContainText('Beta Park Rink');
        await settled();
        const pop = await box(page.locator('.leaflet-popup-content-wrapper'));
        s = await box(sheet);
        expect(pop.y + pop.height).toBeLessThanOrEqual(s.y + 2);                          // the popup opens clear of the list

        // dragged by the grip: up to the top, then down to a strip that leaves the map nearly everything
        const g = await box(grip);
        await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
        await page.mouse.down();
        await page.mouse.move(g.x + g.width / 2, stage.y + 20, { steps: 6 });
        await page.mouse.up();
        await expect(view).toHaveAttribute('data-stop', 'full');
        await settled();
        const g2 = await box(grip);
        await page.mouse.move(g2.x + g2.width / 2, g2.y + g2.height / 2);
        await page.mouse.down();
        await page.mouse.move(g2.x + g2.width / 2, stage.y + stage.height - 10, { steps: 8 });
        await page.mouse.up();
        await expect(view).toHaveAttribute('data-stop', 'min');
        await settled();
        expect((await box(sheet)).height).toBeLessThan(70);
        await expect(page.locator('#rinks-count')).toBeInViewport();                      // the strip still says how many
        await grip.press('ArrowUp');                                                      // and the keyboard can do it too
        await expect(view).toHaveAttribute('data-stop', 'peek');
        await app.noErrors();
    });

    test('a finger on the list pulls the sheet up, a finger on its header pulls it down, and a tap on a rink is still a tap', async ({ page, app, isMobile, context }) => {
        test.skip(!isMobile, 'beside the map on a wide screen');
        await openMap(page, app);
        const view = page.locator('#map-view'), sheet = page.locator('#map-sheet');
        const settled = () => expect.poll(async () => Math.abs((await sheet.boundingBox()).height - await view.evaluate(v => parseFloat(getComputedStyle(v).getPropertyValue('--sheet-h'))))).toBeLessThan(1.5);
        await expect(view).toHaveAttribute('data-rows2', /\d+/);
        await settled();
        // real touches, through the browser's own input pipeline (they obey touch-action, unlike synthetic events)
        const cdp = await context.newCDPSession(page);
        const swipe = async (x, y0, y1) => {
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: y0 }] });
            for (let i = 1; i <= 8; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y0 + (y1 - y0) * i / 8 }] });
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        };
        const second = await page.locator('#rinks-list .rink-row').nth(1).boundingBox();
        await swipe(second.x + 60, second.y + 10, second.y - 220);                        // up, starting on a rink
        await expect(view).toHaveAttribute('data-stop', 'full');
        await settled();
        await expect(page.locator('.leaflet-popup-content')).toHaveCount(0);               // the swipe did not also tap that rink
        const head = await page.locator('#rinks-count').boundingBox();
        await swipe(head.x + 10, head.y + 8, head.y + 260);                               // down, by the header
        await expect(view).not.toHaveAttribute('data-stop', 'full');
        await settled();
        await page.locator('#sheet-grip').press('ArrowDown');                             // wherever the swipe let go: down to the strip,
        await page.locator('#sheet-grip').press('ArrowDown');
        await page.locator('#sheet-grip').press('ArrowUp');                               // and one step up is the peek
        await expect(view).toHaveAttribute('data-stop', 'peek');
        await settled();
        const first = await page.locator('#rinks-list .rink-row').first().locator('.rink-meta').boundingBox();
        await page.touchscreen.tap(first.x + 20, first.y + 6);                            // a tap, at the peek
        await expect(page.locator('.leaflet-popup-content')).toBeVisible();
        await app.noErrors();
    });

    test('on a wide screen it is a column beside the map, with nothing to drag', async ({ page, app, isMobile }) => {
        test.skip(isMobile, 'a sheet over the map on a phone');
        await openMap(page, app);
        await expect(page.locator('#map-view')).toHaveClass(/\bwide\b/);
        await expect(page.locator('#sheet-grip')).toBeHidden();
        const map = await page.locator('#map-canvas').boundingBox(), list = await page.locator('#map-sheet').boundingBox();
        expect(list.x).toBeGreaterThanOrEqual(map.x + map.width - 1);
        expect(map.width).toBeGreaterThan(list.width);
        expect(map.height).toBeGreaterThan(300);
        await app.noErrors();
    });
});

// v3.24: with the question put away, nothing said that the box at the top takes an address. The blue jay says it, once.
test.describe('the blue jay points at the address box', () => {
    const TIP = 'Type your address or postal code here to see what is near you.';
    const say = (page) => page.locator('.jay-say');

    test.describe('on the first look', () => {
        test.use({ settings: { mapAsked: false, mapTipDone: false } });

        test('"Not now": it lands on the box and says where an address goes, above the box; a tap sends it home; never again', async ({ page, app }) => {
            await openMap(page, app);
            await expect(page.locator('#rinks-search')).toHaveAttribute('placeholder', 'Your address, or a rink');
            await page.waitForTimeout(1800);
            await expect(say(page)).toBeHidden();                                     // not while the question is up
            await expect(page.locator('#jay')).not.toHaveClass(/away/);
            // v3.25: it gets there by a swoop to be seen. Where the flying bird is, and whether its line is up, 25 times a second:
            await page.evaluate(() => {
                window.__track = [];
                window.__tracker = setInterval(() => {
                    const f = document.querySelector('.jay-flyer'), s = document.querySelector('.jay-say');
                    if (!f || f.classList.contains('hidden')) return;
                    const r = f.getBoundingClientRect();
                    window.__track.push([Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2), s && !s.classList.contains('hidden') ? 1 : 0]);
                }, 40);
            });
            await page.click('#btn-ask-skip');
            await expect(say(page)).toBeVisible();
            {
                const track = await page.evaluate(() => { clearInterval(window.__tracker); return window.__track; });
                const box = await page.locator('.search-row .rinks-search-box').boundingBox();
                const stage = await page.locator('#map-stage').boundingBox();
                const low = track.reduce((a, b) => (b[1] > a[1] ? b : a));
                expect(low[1]).toBeGreaterThan(stage.y + 30);                         // south: down over the map…
                expect(low[1]).toBeGreaterThan(box.y + box.height + 100);
                expect(low[0]).toBeGreaterThan(box.x + 100);                          // …out toward its middle, not straight down the edge
                expect(low[2]).toBe(0);                                               // the line is not up yet
                const after = track.slice(track.indexOf(low));
                expect(Math.min(...after.map(p => p[1]))).toBeLessThan(box.y + 4);    // north again, up to the box
                expect(track.filter(p => p[2] === 1).every(p => p[1] < box.y + 4)).toBe(true);   // it speaks only once it has landed
            }
            await expect(say(page)).toHaveText(TIP);
            const box = await page.locator('.search-row .rinks-search-box').boundingBox();
            const line = await say(page).boundingBox();
            expect(line.y + line.height).toBeLessThanOrEqual(box.y);                  // above the box, never over it
            expect(line.x + line.width).toBeLessThanOrEqual(page.viewportSize().width);
            const onTop = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.id, [box.x + box.width / 2, box.y + box.height / 2]);
            expect(onTop).toBe('rinks-search');
            await expect(page.locator('.search-row .rinks-search-box')).toHaveClass(/jay-points/);
            // the bird itself stands on the box's top edge, at its left end, and its perch by the title is empty
            const bird = await page.locator('.jay-flyer').boundingBox();
            expect(Math.abs(bird.x - box.x)).toBeLessThan(12);
            expect(bird.y + bird.height).toBeGreaterThan(box.y);
            expect(bird.y + bird.height).toBeLessThan(box.y + 14);
            await expect(page.locator('#jay')).toHaveClass(/away/);
            expect(await page.evaluate(() => SkateSettings.get('mapTipDone'))).toBe(true);

            await page.click('#rinks-search');                                        // a tap: the line goes, the bird flies home
            await expect(say(page)).toBeHidden();
            await expect(page.locator('.search-row .rinks-search-box')).not.toHaveClass(/jay-points/);
            await expect(page.locator('#jay')).not.toHaveClass(/away/);
            await expect(page.locator('#rinks-search')).toBeFocused();

            await page.click('#btn-list');                                            // once only
            await page.click('#btn-rinks');
            await page.waitForTimeout(1900);
            await expect(say(page)).toBeHidden();
            await expect(page.locator('#jay')).not.toHaveClass(/away/);               // it has not set off again either
            await app.noErrors();
        });

        test('once a spot is set there is nothing to point out', async ({ page, app }) => {
            await openMap(page, app);
            await page.fill('#map-ask-input', 'M1J 3K4');
            await page.locator('#map-ask-input').press('Enter');
            await expect(page.locator('#locator-status')).toContainText('M1J');
            await page.waitForTimeout(1900);
            await expect(say(page)).toBeHidden();
            await expect(page.locator('#jay')).not.toHaveClass(/away/);
            expect(await page.evaluate(() => SkateSettings.get('mapTipDone'))).toBeFalsy();
            await app.noErrors();
        });
    });

    test.describe('for someone who put the question away before', () => {
        test.use({ settings: { mapAsked: true, mapTipDone: false } });

        test('the next time the map opens it says it; with reduce motion only the line and the ring show', async ({ page, app }) => {
            await page.emulateMedia({ reducedMotion: 'reduce' });
            await openMap(page, app);
            await expect(say(page)).toBeVisible();
            await expect(say(page)).toHaveText(TIP);
            await expect(page.locator('#jay')).not.toHaveClass(/away/);               // it stays on its perch
            await expect(page.locator('.search-row .rinks-search-box')).toHaveClass(/jay-points/);
            const box = await page.locator('.search-row .rinks-search-box').boundingBox(), line = await say(page).boundingBox();
            expect(line.y + line.height).toBeLessThanOrEqual(box.y);
            await page.keyboard.press('Tab');                                         // a key ends it too
            await expect(say(page)).toBeHidden();
            await app.noErrors();
        });

        test('leaving the map takes the line with it', async ({ page, app }) => {
            await openMap(page, app);
            await expect(say(page)).toBeVisible();
            await page.evaluate(() => SkateApp.Actions.closeRinks());
            await expect(say(page)).toBeHidden();
            await expect(page.locator('#jay')).not.toHaveClass(/away/);
            await app.noErrors();
        });

        test('a tap while it is still flying sends it home, and the tip is kept for the next time', async ({ page, app }) => {
            await openMap(page, app);
            await expect(page.locator('#jay')).toHaveClass(/away/);                   // it has set off
            await page.waitForTimeout(500);                                           // somewhere over the map
            await page.mouse.click(5, 300);
            await expect(page.locator('.search-row .rinks-search-box')).not.toHaveClass(/jay-points/);
            await expect(page.locator('#jay')).not.toHaveClass(/away/);               // back on its perch
            await expect(say(page)).toBeHidden();
            expect(await page.evaluate(() => SkateSettings.get('mapTipDone'))).toBeFalsy();   // nobody read it
            await page.click('#btn-list');
            await page.click('#btn-rinks');
            await expect(say(page)).toBeVisible();                                    // so it says it now
            expect(await page.evaluate(() => SkateSettings.get('mapTipDone'))).toBe(true);
            await app.noErrors();
        });
    });
});
