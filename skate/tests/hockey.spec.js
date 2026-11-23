// v3.12.2: Hockey splits by kind (Pickup / shinny, Stick & puck), read from each session's
// title, and the kind combines with the age groups. Filters sheet, pill, pill menu,
// reload, clearing; every project (desktop and phone, light and dark).
const { test, expect, row, dayPlus } = require('./fixtures');

const HOCKEY = [
    { activity: 'Stick & Puck' },
    { activity: 'Drop-In Stick & Puck (16+)', ageMin: 16 },
    { activity: 'Stick and Puck: Youth', ageMin: 13, ageMax: 17 },
    { activity: 'Pick Up Hockey: Adults', ageMin: 18 },
    { activity: 'Shinny: Youth', ageMin: 13, ageMax: 17 },
    { activity: 'Drop-in Stick & Ring' }                                   // ringette's own drill, not hockey
];
function addHockey(app) {
    const programs = app.data['skating-programs.json'].programs;
    HOCKEY.forEach((o, i) => programs.push(row({ id: `h${i}`, loc: 300, rink: 'Warning Arena', district: 'Scarborough', date: dayPlus(1), start: `${String(8 + i).padStart(2, '0')}:00`, end: `${String(8 + i).padStart(2, '0')}:50`, ...o })));
}
/** The hockey-ish titles the list would show right now (the app's own filtered set). */
const shown = (page) => page.evaluate(() => SkateApp.S.filtered.map(p => p.Activity).filter(a => /shinny|hockey|stick|puck/i.test(a)).sort());
const pill = (page) => page.locator('#active-filters .pill.type[data-pill="type:hockey"]');

test.describe('hockey by kind', () => {
    test('a kind picked in Filters narrows hockey, the ages still apply, and it is remembered', async ({ page, app }) => {
        addHockey(app);
        await app.open();
        await page.click('#btn-filters');
        await expect(page.locator('#filters-modal')).toBeVisible();
        const expand = page.locator('.fexpand[data-expand="hockey"]');
        await expect(expand).toContainText('Kinds & ages');
        await expand.click();
        await expect(page.locator('#filters-body .fsubs-head')).toHaveText(['Kind', 'Ages']);
        await expect(page.locator('input[data-kind="pickup"]')).not.toBeChecked();             // Hockey is off in the suite's defaults
        await page.locator('input[data-kind="stickpuck"]').check();                             // the first kind turns Hockey on with just it
        await expect(page.locator('input[data-type="hockey"]').first()).toBeChecked();
        await expect(page.locator('input[data-kind="stickpuck"]')).toBeChecked();
        await expect(page.locator('input[data-kind="pickup"]')).not.toBeChecked();
        expect(await shown(page)).toEqual(['Drop-In Stick & Puck (16+)', 'Drop-in Stick & Ring', 'Stick & Puck', 'Stick and Puck: Youth']);   // Stick & Ring is ringette, which is on

        // ages on top: only Youth
        const ages = await page.locator('input[data-type="hockey"][data-sub]').evaluateAll(els => els.map(e => e.dataset.sub));
        for (const id of ages.filter(a => a !== 'youth')) await page.locator(`input[data-type="hockey"][data-sub="${id}"]`).uncheck();
        expect(await shown(page)).toEqual(['Drop-in Stick & Ring', 'Stick and Puck: Youth']);
        await page.keyboard.press('Escape');
        await expect(pill(page)).toContainText('Hockey: Stick & puck, Youth');

        // remembered across a reload
        await app.open();
        await expect(pill(page)).toContainText('Hockey: Stick & puck, Youth');
        expect(await shown(page)).toEqual(['Drop-in Stick & Ring', 'Stick and Puck: Youth']);
        await app.noErrors();
    });

    test('the Hockey pill menu: kinds above the ages; a tap narrows, Every kind brings them all back', async ({ page, app }) => {
        addHockey(app);
        await page.addInitScript(() => {
            const s = JSON.parse(localStorage.getItem('skate_settings_v1') || '{}');
            s.typeSel = { ...(s.typeSel || {}), hockey: 'all' };
            localStorage.setItem('skate_settings_v1', JSON.stringify(s));
        });
        await app.open();
        await expect(pill(page)).toHaveText(/^Hockey/);
        await pill(page).click();
        const items = page.locator('.popover .popover-item');
        await expect(page.locator('.popover .popover-title')).toHaveText('Hockey: kind and age');
        const texts = (await items.allTextContents()).map(t => t.replace(/[ \s]+/g, ' ').trim());
        expect(texts.slice(0, 4).map(t => t.replace(/ · \d+$/, ''))).toEqual(['✓ Every kind', '✓ Pickup (shinny)', '✓ Stick & puck', '✓ Every age group']);
        await expect(items.nth(3)).toHaveClass(/popover-sep/);
        await items.filter({ hasText: 'Pickup (shinny)' }).click();          // from every kind, a tap on one leaves the others
        await expect(pill(page)).toContainText('Hockey: Stick & puck');
        expect(await shown(page)).not.toContain('Pick Up Hockey: Adults');
        await expect(page.locator('.popover .popover-item', { hasText: 'Pickup (shinny)' })).not.toContainText('✓');   // the menu stays open and follows
        await page.locator('.popover .popover-item', { hasText: 'Every kind' }).click();
        await expect(pill(page)).toHaveText(/^Hockey\s*▾?\s*✕?$/);
        expect(await shown(page)).toEqual(expect.arrayContaining(['Pick Up Hockey: Adults', 'Shinny: Youth', 'Stick & Puck']));
        await app.noErrors();
    });

    test('turning Hockey off forgets the kind; Clear brings every kind back; nothing overflows on a phone', async ({ page, app }) => {
        addHockey(app);
        await app.open();
        await page.click('#btn-filters');
        await page.locator('.fexpand[data-expand="hockey"]').click();
        await page.locator('input[data-kind="pickup"]').check();
        await expect(page.locator('input[data-kind="stickpuck"]')).not.toBeChecked();
        // the sheet fits: no sideways scroll in it or on the page
        expect(await page.evaluate(() => { const b = document.getElementById('filters-body'); return [b.scrollWidth <= b.clientWidth + 1, document.documentElement.scrollWidth <= innerWidth + 1]; })).toEqual([true, true]);
        await page.locator('#filters-body input[data-type="hockey"]:not([data-sub])').first().uncheck();   // Hockey off
        expect(await page.evaluate(() => [SkateApp.S.kinds, JSON.parse(localStorage.getItem('skate_settings_v1')).hockeyKinds])).toEqual([null, null]);
        await page.locator('#filters-body input[data-type="hockey"]:not([data-sub])').first().check();     // on again: every kind
        await expect(page.locator('input[data-kind="pickup"]')).toBeChecked();
        await expect(page.locator('input[data-kind="stickpuck"]')).toBeChecked();
        await page.locator('input[data-kind="stickpuck"]').uncheck();
        await page.keyboard.press('Escape');
        await expect(pill(page)).toContainText('Hockey: Pickup');
        await page.evaluate(() => SkateApp.Actions.resetFilters());
        expect(await page.evaluate(() => SkateApp.S.kinds)).toBeNull();
        await expect(pill(page)).toHaveCount(0);
        await app.noErrors();
    });

    test('a stored kind that is not a kind, or not a list, is ignored', async ({ page, app }) => {
        addHockey(app);
        await page.addInitScript(() => {
            if (sessionStorage.getItem('seeded')) return;              // the first load only
            sessionStorage.setItem('seeded', '1');
            const s = JSON.parse(localStorage.getItem('skate_settings_v1') || '{}');
            s.typeSel = { ...(s.typeSel || {}), hockey: 'all' };
            s.hockeyKinds = ['<img src=x onerror=alert(1)>', 'stickpuck', 'stickpuck'];
            localStorage.setItem('skate_settings_v1', JSON.stringify(s));
        });
        await app.open();
        expect(await page.evaluate(() => SkateApp.S.kinds)).toEqual(['stickpuck']);
        await expect(pill(page)).toContainText('Hockey: Stick & puck');
        await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('skate_settings_v1')); s.hockeyKinds = 'stickpuck'; localStorage.setItem('skate_settings_v1', JSON.stringify(s)); });
        await app.open();
        expect(await page.evaluate(() => SkateApp.S.kinds)).toBeNull();
        await app.noErrors();
    });
});
