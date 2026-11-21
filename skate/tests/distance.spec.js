// v3.12: "Within N km" (a radius around your spot, with its own pill), the ▾
// beside Calendar that picks one of four calendars, and the day planner's
// by-distance view.
const { test, expect } = require('./fixtures');

const HOME = { lat: 43.654, lng: -79.380, label: 'Alpha St', ts: 1 };   // on top of Alpha Arena
const card = (page, text) => page.locator('.program-item', { hasText: text });
/** Give every session its rink's own coordinates (the fixture rows default to one downtown point). */
function placeSessions(app) {
    const rinks = app.data['rinks.json'].rinks;
    for (const p of app.data['skating-programs.json'].programs) {
        const r = rinks.find(x => String(x.locationid) === String(p.ExtLocationKey || p['Location ID']));
        if (r) { p.Lat = r.lat; p.Lng = r.lng; }
    }
}
const names = (page) => page.locator('.program-item .where-link').allTextContents();
const pickCalendar = async (page, label) => {
    await page.click('#btn-cal-type');
    await expect(page.locator('#popover .popover-title')).toHaveText('Which calendar');
    await page.locator('#popover .popover-item', { hasText: label }).click();
};

test.describe('within N km', () => {
    test.use({ settings: { userLoc: HOME } });

    test('a filter with its own pill: pick it in Filters, change it from the pill, clear it with the x; it survives a reload', async ({ page, app }) => {
        placeSessions(app);
        await app.open();
        await expect(page.locator('.program-item')).toHaveCount(7);
        await page.click('#btn-filters');
        await page.locator('#filters-body .fexpand, #filters-body .ftoggle').filter({ hasText: 'options' }).click();
        await expect(page.locator('#filters-body .fradius .fchip')).toHaveText(['Any', '2 km', '5 km', '10 km', '20 km']);
        await page.locator('#filters-body .fradius .fchip', { hasText: /^5 km$/ }).click();
        await page.click('#btn-filters-apply');
        const pill = page.locator('#active-filters .pill.radius');
        await expect(pill).toContainText('Within 5 km');
        await expect(page.locator('.program-item')).toHaveCount(2);            // Alpha (here) and Beta Park (3 km)
        expect((await names(page)).every(n => /Alpha Arena|Beta Park Rink/.test(n))).toBe(true);
        await expect(page.locator('#status-data')).toHaveText('2 sessions');

        await pill.click();
        await expect(page.locator('#popover .popover-title')).toHaveText('How far from your spot');
        await expect(page.locator('#popover .popover-item', { hasText: '✓' })).toHaveText(/Within 5 km/);
        await page.locator('#popover .popover-item', { hasText: 'Within 10 km' }).click();
        await expect(pill).toContainText('Within 10 km');
        await expect(page.locator('.program-item')).toHaveCount(4);            // plus Leaside and Forest Hill, 5 to 7 km out

        await page.reload();
        await page.waitForSelector('.program-item');
        await expect(page.locator('#active-filters .pill.radius')).toContainText('Within 10 km');
        await expect(page.locator('.program-item')).toHaveCount(4);

        await page.locator('#active-filters .pill.radius .pill-x').click();
        await expect(page.locator('#active-filters .pill.radius')).toHaveCount(0);
        await expect(page.locator('.program-item')).toHaveCount(7);
        await app.noErrors();
    });

    test('forgetting the spot drops the radius with it', async ({ page, app }) => {
        placeSessions(app);
        await app.open();
        await page.evaluate(() => SkateApp.Actions.setRadius(5));
        await expect(page.locator('#active-filters .pill.radius')).toHaveCount(1);
        await page.click('#btn-rinks');
        await page.click('#btn-clear-location');                               // "Forget this spot"
        await page.click('#btn-rinks-close');
        await expect(page.locator('#active-filters .pill.radius')).toHaveCount(0);
        await expect(page.locator('.program-item')).toHaveCount(7);
        expect(await page.evaluate(() => SkateSettings.get('radius'))).toBeNull();
        await app.noErrors();
    });

    test('by distance: bands from the nearest out, in time order; the chips above are the same filter', async ({ page, app }) => {
        placeSessions(app);
        await app.open();
        await pickCalendar(page, 'Day, by distance');
        await expect(page.locator('#view-seg')).toHaveAttribute('data-cal', 'distance');
        await expect(page.locator('#btn-cal')).toHaveClass(/active/);
        await expect(page.locator('.c2-by button.active')).toHaveText('By distance');
        const day = page.locator('.c2-day.by-distance');
        // nothing sits between 5 and 10 km today, so that band is simply absent
        await expect(day.locator('.c2-band .c2-part-head')).toHaveText([/^Within 2 km\s+1 session$/, /^2 to 5 km\s+1 session$/, /^10 to 20 km\s+3 sessions$/]);
        await expect(day.locator('.c2-band').first().locator('.c2-line-name')).toHaveText(['Alpha Arena']);
        await expect(day.locator('.c2-band').nth(2).locator('.c2-line-name')).toHaveText(['Warning Arena', 'Note Arena', 'Expired Arena']);   // 6, 7 and 8 pm: time order
        await expect(day.locator('.c2-band').nth(1).locator('.c2-line-meta')).toContainText(/3\.\d km/);

        const chips = page.locator('.c2-radius .c2-radius-chip');
        await expect(chips).toHaveText(['Any distance', '2 km', '5 km', '10 km', '20 km']);
        await expect(page.locator('.c2-radius .c2-radius-chip.active')).toHaveText('Any distance');
        await chips.filter({ hasText: /^5 km$/ }).click();
        await expect(page.locator('.c2-radius .c2-radius-chip.active')).toHaveText('5 km');
        await expect(day.locator('.c2-band')).toHaveCount(2);
        await expect(page.locator('#active-filters .pill.radius')).toContainText('Within 5 km');
        await chips.filter({ hasText: /^2 km$/ }).click();
        await expect(day.locator('.c2-band')).toHaveCount(1);
        await page.locator('.c2-radius .c2-radius-chip', { hasText: 'Any distance' }).click();
        await expect(day.locator('.c2-band')).toHaveCount(3);
        await expect(page.locator('#active-filters .pill.radius')).toHaveCount(0);

        // the planner's own switch reaches the other two views
        await page.locator('.c2-by button', { hasText: 'By rink' }).click();
        await expect(page.locator('.c2-day.by-rink')).toBeVisible();
        await expect(page.locator('#view-seg')).toHaveAttribute('data-cal', 'rink');
        await expect(page.locator('.c2-radius')).toHaveCount(0);
        await app.noErrors();
    });
});

test.describe('without a spot', () => {
    test('a radius asks for a starting point first, then applies by itself', async ({ page, app }) => {
        placeSessions(app);
        await app.open();
        await page.click('#btn-filters');
        await page.locator('#filters-body .fexpand, #filters-body .ftoggle').filter({ hasText: 'options' }).click();
        await page.locator('#filters-body .fradius .fchip', { hasText: /^5 km$/ }).click();
        await expect(page.locator('#rinks-modal')).toBeVisible();              // the place to set a spot
        await expect(page.locator('#filters-modal')).toBeHidden();
        await expect(page.locator('#active-filters .pill.radius')).toHaveCount(0);
        await page.fill('#rinks-search', 'M1J 3K4');
        await page.click('#btn-locator-search');                               // the mocked geocoder answers with a point beside Warning Arena
        await expect(page.locator('#locator-status')).toContainText('M1J');
        await page.click('#btn-rinks-close');
        await expect(page.locator('#active-filters .pill.radius')).toContainText('Within 5 km');
        await expect(page.locator('.program-item')).toHaveCount(1);
        await expect(card(page, 'Warning Arena')).toHaveCount(1);
        await app.noErrors();
    });

    test('by distance says what it needs and offers both ways to set a spot', async ({ page, app }) => {
        await app.open();
        await pickCalendar(page, 'Day, by distance');
        await expect(page.locator('.c2-need-spot')).toContainText('Distances need a starting point');
        await expect(page.locator('.c2-radius')).toHaveCount(0);
        await expect(page.locator('.c2-band')).toHaveCount(0);
        await page.locator('.c2-need-spot [data-cal2-place]').click();
        await expect(page.locator('#rinks-modal')).toBeVisible();
        await app.noErrors();
    });
});

test.describe('the calendar picker', () => {
    test('the ▾ beside Calendar picks one of four calendars; Calendar reopens the last one', async ({ page, app }) => {
        await app.open();
        await expect(page.locator('#view-seg')).toHaveAttribute('data-cal', 'week');
        await page.click('#btn-cal-type');
        await expect(page.locator('#popover .popover-item')).toHaveText([/Week grid/, /Day, by time of day/, /Day, by rink/, /Day, by distance/]);
        await expect(page.locator('#popover .popover-item', { hasText: '✓' })).toHaveCount(0);   // the list is showing: no calendar is on
        await page.locator('#popover .popover-item', { hasText: 'Day, by time of day' }).click();
        await expect(page.locator('#view-seg')).toHaveAttribute('data-cal', 'time');
        await expect(page.locator('#btn-cal')).toHaveClass(/active/);
        await expect(page.locator('.c2-day.by-time')).toBeVisible();
        expect(await page.evaluate(() => [SkateSettings.get('cal2'), SkateSettings.get('cal2By'), SkateSettings.get('calMode')])).toEqual([true, 'time', true]);

        await page.click('#btn-cal-type');
        await expect(page.locator('#popover .popover-item', { hasText: '✓' })).toHaveText(/Day, by time of day/);
        await page.locator('#popover .popover-item', { hasText: 'Day, by rink' }).click();
        await expect(page.locator('.c2-day.by-rink')).toBeVisible();

        await page.click('#btn-list');
        await expect(page.locator('.program-item').first()).toBeVisible();
        await page.click('#btn-cal');                                           // back to the calendar last used
        await expect(page.locator('.c2-day.by-rink')).toBeVisible();

        await pickCalendar(page, 'Week grid');
        await expect(page.locator('#view-seg')).toHaveAttribute('data-cal', 'week');
        await expect(page.locator('#calendar-view .cal-grid')).toBeVisible();
        await expect(page.locator('.c2-by')).toHaveCount(0);
        expect(await page.evaluate(() => SkateSettings.get('cal2'))).toBe(false);
        await app.noErrors();
    });

    test('each calendar has its own colour, on the button and in the menu', async ({ page, app }) => {
        await app.open();
        await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; }' });   // read settled colours, not a fade in progress
        const seen = new Set();
        for (const [label, id] of [['Week grid', 'week'], ['Day, by time of day', 'time'], ['Day, by rink', 'rink'], ['Day, by distance', 'distance']]) {
            await pickCalendar(page, label);
            await expect(page.locator('#view-seg')).toHaveAttribute('data-cal', id);
            seen.add(await page.evaluate(() => getComputedStyle(document.getElementById('btn-cal')).backgroundColor));
        }
        expect(seen.size).toBe(4);
        await page.click('#btn-cal-type');
        const dots = await page.evaluate(() => [...document.querySelectorAll('#popover .popover-item.cal-t')].map(b => getComputedStyle(b, '::before').backgroundColor));
        expect(new Set(dots).size).toBe(4);
        await page.keyboard.press('Escape');
        // the ▾ is a real target and the three buttons fit their box
        const fit = await page.evaluate(() => {
            const seg = document.getElementById('view-seg').getBoundingClientRect();
            const b = [...document.querySelectorAll('#view-seg button')].map(x => x.getBoundingClientRect());
            return { inside: b.every(r => r.left >= seg.left - 0.5 && r.right <= seg.right + 0.5), caret: Math.round(b[2].width), noOverlap: b[0].right <= b[1].left + 0.5 && b[1].right <= b[2].left + 0.5 };
        });
        expect(fit.inside).toBe(true);
        expect(fit.noOverlap).toBe(true);
        expect(fit.caret).toBeGreaterThanOrEqual(30);
        // on the narrowest phones the word Calendar is still whole, and nothing spills
        for (const width of [360, 320]) {
            await page.setViewportSize({ width, height: 640 });
            const narrow = await page.evaluate(() => {
                const cal = document.getElementById('btn-cal'), seg = document.getElementById('view-seg').getBoundingClientRect();
                return { clipped: cal.scrollWidth > cal.clientWidth + 1, inside: seg.right <= window.innerWidth + 0.5, caret: Math.round(document.getElementById('btn-cal-type').getBoundingClientRect().width), spill: document.documentElement.scrollWidth > window.innerWidth };
            });
            expect(narrow, `${width}px`).toEqual({ clipped: false, inside: true, caret: 28, spill: false });
        }
        await app.noErrors();
    });
});
