// v3.13: what and who. Shinny and Stick & puck are kinds of skating of their own (nothing
// nested); "Who's skating" is one row of age groups for every kind, and a session open to
// all ages counts for everyone. Every number in Filters counts what it would show with the
// other filters as they are (cities, Free only, the day, search…). Earlier picks carry over.
const { test, expect, row, dayPlus } = require('./fixtures');

// Beside the suite's own "Shinny: Adult" (today, Toronto). Mississauga rows come from its own source.
const ROWS = [
    { activity: 'Stick & Puck' },                                                       // Toronto, all ages, free
    { activity: 'Stick & Puck', source: 'canlan-york', paid: true, price: 12 },          // Toronto, all ages, paid
    { activity: 'Stick and Puck: Youth', ageMin: 13, ageMax: 17 },                       // Toronto, youth
    { activity: 'Drop-In Stick & Puck (16+)', ageMin: 16, source: 'mississauga' },       // Mississauga, adult
    { activity: 'Pick Up Hockey: Adults', ageMin: 18 },                                  // Toronto, adult
    { activity: 'Shinny: Youth', ageMin: 13, ageMax: 17 },                               // Toronto, youth
    { activity: 'Drop-in Stick & Ring' }                                                 // ringette, not hockey
];
function addRows(app) {
    const programs = app.data['skating-programs.json'].programs;
    ROWS.forEach((o, i) => programs.push(row({ id: `k${i}`, loc: 300, rink: 'Warning Arena', district: 'Scarborough', date: dayPlus(1), start: `${String(8 + i).padStart(2, '0')}:00`, end: `${String(8 + i).padStart(2, '0')}:50`, ...o })));
}
/** Saved settings for the first load only (later loads keep what the app saved). */
const seed = (page, patch) => page.addInitScript((p) => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    const s = JSON.parse(localStorage.getItem('skate_settings_v1') || '{}');
    Object.entries(p).forEach(([k, v]) => { if (v === null) delete s[k]; else s[k] = v; });
    localStorage.setItem('skate_settings_v1', JSON.stringify(s));
}, patch);
const hockeyOnly = { typeSel: { hockey: 'all', stickpuck: 'all' }, cities: ['Toronto'] };
const shown = (page) => page.evaluate(() => SkateApp.S.filtered.map(p => p.Activity).filter(a => /shinny|hockey|stick|puck/i.test(a)).sort());
const kindCount = (page, id) => page.locator(`#filters-body .fcat.type-${id} .fcount`);
const whoChips = (page) => page.locator('#filters-body .fwho .fchip');
const cityChip = (page, c) => page.locator(`#filters-body .fchip[data-city="${c}"]`);
async function openFilters(page) { await page.click('#btn-filters'); await expect(page.locator('#filters-modal')).toBeVisible(); }

test.describe('what and who', () => {
    test('Shinny and Stick & puck are kinds of their own: tick one, nothing to open', async ({ page, app }) => {
        addRows(app);
        await app.open();
        await openFilters(page);
        await expect(page.locator('#filters-body .fcat.type-hockey .fcheck-label')).toHaveText('Shinny (pickup)');
        await expect(page.locator('#filters-body .fcat.type-stickpuck .fcheck-label')).toHaveText('Stick & puck');
        await expect(page.locator('#filters-body .fcat.type-stickpuck .fexpand, #filters-body .fcat.type-hockey .fexpand')).toHaveCount(0);
        await expect(kindCount(page, 'stickpuck')).toHaveText('3');                 // Toronto: two all-ages (one paid), one youth
        await expect(kindCount(page, 'hockey')).toHaveText('3');
        await page.locator('input[data-type="stickpuck"]').check();
        expect(await shown(page)).toEqual(['Drop-in Stick & Ring', 'Stick & Puck', 'Stick & Puck', 'Stick and Puck: Youth']);   // Stick & Ring is ringette, which is on
        await page.keyboard.press('Escape');
        await expect(page.locator('#active-filters [data-pill="type:stickpuck"]')).toContainText('Stick & puck');
        await app.noErrors();
    });

    test('Who\'s skating: one row for every kind; all-ages sessions count for everyone; empty groups are not offered', async ({ page, app }) => {
        addRows(app);
        await seed(page, hockeyOnly);
        await app.open();
        await openFilters(page);
        await expect(page.locator('#filters-body h4', { hasText: 'Who\'s skating' })).toBeVisible();
        await expect(whoChips(page)).toHaveText([/^Everyone\s*6$/, /^Youth\s*4$/, /^Adult\s*4$/]);       // no child, older or women's hockey here
        await whoChips(page).filter({ hasText: 'Youth' }).click();
        expect(await shown(page)).toEqual(['Shinny: Youth', 'Stick & Puck', 'Stick & Puck', 'Stick and Puck: Youth']);
        await expect(kindCount(page, 'stickpuck')).toHaveText('3');                 // the kinds now count youth and all-ages only
        await expect(kindCount(page, 'hockey')).toHaveText('1');
        await expect(whoChips(page).filter({ hasText: 'Youth' })).toHaveAttribute('aria-pressed', 'true');
        await whoChips(page).filter({ hasText: 'Adult' }).click();                  // several at once
        expect(await shown(page)).toHaveLength(6);
        await whoChips(page).filter({ hasText: 'Everyone' }).click();
        expect(await page.evaluate(() => SkateApp.S.who)).toEqual([]);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
        await app.noErrors();
    });

    test('the counts follow the cities and Free only; a pick with nothing left stays, at 0, so it can be undone', async ({ page, app }) => {
        addRows(app);
        await seed(page, hockeyOnly);
        await app.open();
        await openFilters(page);
        await expect(page.locator('#filters-body .fcheck', { hasText: 'Free sessions only' })).toContainText('hides 1 paid');
        await page.locator('input[data-flag="free"]').check();
        await expect(kindCount(page, 'stickpuck')).toHaveText('2');                 // the paid one is gone from the count too
        await expect(cityChip(page, 'Mississauga')).toHaveText('Mississauga · 1');   // the cities count the kinds picked
        await cityChip(page, 'Mississauga').click();
        await expect(kindCount(page, 'stickpuck')).toHaveText('3');
        await page.locator('#filters-body .fchip[data-city="Toronto"]').click();     // Mississauga alone
        await expect(kindCount(page, 'stickpuck')).toHaveText('1');
        await expect(kindCount(page, 'hockey')).toHaveText('0');                    // picked, nothing there: still shown
        await expect(page.locator('#filters-body .fcat.type-leisure')).toHaveCount(0);   // not picked, nothing there: not shown
        await whoChips(page).filter({ hasText: 'Adult' }).click();
        await page.evaluate(() => SkateApp.Actions.setWho(['youth']));               // a group with nothing here, already picked
        await expect(whoChips(page).filter({ hasText: 'Youth' })).toHaveText(/^Youth\s*0$/);
        await expect(cityChip(page, 'Mississauga')).toHaveText('Mississauga · 0');
        expect(await shown(page)).toEqual([]);
        await app.noErrors();
    });

    test('the Who pill: tap to change, the x for everyone', async ({ page, app }) => {
        addRows(app);
        await seed(page, { ...hockeyOnly, who: ['youth', 'adult'] });
        await app.open();
        const pill = page.locator('#active-filters .pill.who');
        await expect(pill).toContainText('Youth +1');
        await pill.click();
        await expect(page.locator('.popover .popover-title')).toHaveText('Who\'s skating');
        await page.locator('.popover .popover-item', { hasText: 'Adult' }).click();
        await expect(pill).toContainText('Youth');
        await expect(pill).not.toContainText('+1');
        await pill.locator('.pill-x').click();
        await expect(pill).toHaveCount(0);
        expect(await page.evaluate(() => SkateApp.S.who)).toEqual([]);
        await app.noErrors();
    });

    test('earlier picks carry over once: hockey becomes both kinds, a kind picked stays alone, ages become Who', async ({ page, app }) => {
        addRows(app);
        await seed(page, { typeSel: { hockey: ['youth'], leisure: 'all' }, hockeyKinds: ['stickpuck'], filtersV: null });
        await app.open();
        expect(await page.evaluate(() => [SkateApp.S.types, SkateApp.S.who])).toEqual([{ stickpuck: 'all', leisure: 'all' }, ['youth']]);
        const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('skate_settings_v1')));
        expect([saved.filtersV, saved.hockeyKinds ?? null]).toEqual([2, null]);
        await page.evaluate(() => { SkateApp.Actions.setType('stickpuck', null, false); SkateApp.Actions.setType('hockey', null, true); });
        await app.open();                                                            // not carried over a second time
        expect(await page.evaluate(() => SkateApp.S.types)).toEqual({ leisure: 'all', hockey: 'all' });
        await app.noErrors();
    });

    test('hockey that was on with no kind picked becomes Shinny and Stick & puck', async ({ page, app }) => {
        addRows(app);
        await seed(page, { typeSel: { hockey: 'all' }, filtersV: null });
        await app.open();
        expect(await page.evaluate(() => SkateApp.S.types)).toEqual({ hockey: 'all', stickpuck: 'all' });
        await app.noErrors();
    });
});
