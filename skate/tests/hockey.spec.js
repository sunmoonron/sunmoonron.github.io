// Hockey by kind (v3.14): two ticks under Hockey, Pickup (shinny) and Stick & puck, both on
// when Hockey is on; untick one to hide its sessions. The age groups under it count the kinds
// ticked, an empty age group is not shown, and every number follows the cities and Free only.
// Every project: desktop and phone, light and dark. The suite's own data has one more hockey
// session: "Shinny: Adult" today in Toronto.
const { test, expect, row, dayPlus } = require('./fixtures');

const HOCKEY = [
    { activity: 'Stick & Puck' },                                          // Toronto, all ages
    { activity: 'Drop-In Stick & Puck (16+)', ageMin: 16 },                // Toronto, adult
    { activity: 'Stick and Puck: Youth', ageMin: 13, ageMax: 17 },         // Toronto, youth
    { activity: 'Pick Up Hockey: Adults', ageMin: 18 },                    // Toronto, adult
    { activity: 'Shinny: Youth', ageMin: 13, ageMax: 17 },                 // Toronto, youth
    { activity: 'Shinny: Older Adult', ageMin: 55 },                       // Toronto, older adult: pickup only
    { activity: 'Drop-in Stick & Ring' },                                  // ringette's own drill, not hockey
    { activity: 'Stick & Puck', source: 'mississauga' },                   // Mississauga
    { activity: 'Stick & Puck', source: 'canlan-york', paid: true, price: 12 }   // Toronto, paid
];
function addHockey(app) {
    const programs = app.data['skating-programs.json'].programs;
    HOCKEY.forEach((o, i) => programs.push(row({ id: `h${i}`, loc: 300, rink: 'Warning Arena', district: 'Scarborough', date: dayPlus(1), start: `${String(8 + i).padStart(2, '0')}:00`, end: `${String(8 + i).padStart(2, '0')}:50`, ...o })));
}
/** Saved settings for the first load only. */
const seed = (page, patch) => page.addInitScript((p) => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    const s = JSON.parse(localStorage.getItem('skate_settings_v1') || '{}');
    Object.assign(s, p);
    localStorage.setItem('skate_settings_v1', JSON.stringify(s));
}, patch);
/** The hockey-ish titles the list would show right now (the app's own filtered set). */
const shown = (page) => page.evaluate(() => SkateApp.S.filtered.map(p => p.Activity).filter(a => /shinny|hockey|stick|puck/i.test(a)).sort());
const pill = (page) => page.locator('#active-filters .pill.type[data-pill="type:hockey"]');
const kind = (page, id) => page.locator(`#filters-body input[data-kind="${id}"]`);
const hockeyBox = (page) => page.locator('#filters-body input[data-type="hockey"]:not([data-sub])');
/** Age groups offered under Hockey, as "label count". */
const agesOffered = (page) => page.locator('#filters-body input[data-type="hockey"][data-sub]').evaluateAll(els => els.map(e => { const l = e.closest('label'); return `${l.querySelector('.fcheck-label').textContent} ${l.querySelector('.fcount').textContent}`; }));
const count = (page, sel) => page.locator(`#filters-body ${sel} .fcount`).first();
async function openHockey(page) {
    await page.click('#btn-filters');
    await expect(page.locator('#filters-modal')).toBeVisible();
    const expand = page.locator('.fexpand[data-expand="hockey"]');
    await expect(expand).toContainText('Kind & ages');
    if (await expand.getAttribute('aria-expanded') !== 'true') await expand.click();
}

test.describe('hockey by kind', () => {
    test('ticks like everything else: Hockey on ticks both; untick one and only the other shows', async ({ page, app }) => {
        addHockey(app);
        await app.open();
        await openHockey(page);
        await expect(page.locator('#filters-body .fchip[data-kind-chip], #filters-body .fkinds')).toHaveCount(0);   // no bubbles, no "Any"
        await expect(page.locator('#filters-body .fsubs-head')).toHaveText(['Kind', 'Ages']);
        await expect(kind(page, 'pickup')).not.toBeChecked();                       // Hockey is off in the suite's defaults
        await hockeyBox(page).check();
        await expect(kind(page, 'pickup')).toBeChecked();
        await expect(kind(page, 'stickpuck')).toBeChecked();
        expect(await shown(page)).toEqual(['Drop-In Stick & Puck (16+)', 'Drop-in Stick & Ring', 'Pick Up Hockey: Adults', 'Shinny: Adult', 'Shinny: Older Adult', 'Shinny: Youth', 'Stick & Puck', 'Stick & Puck', 'Stick and Puck: Youth']);
        await kind(page, 'pickup').uncheck();
        expect(await shown(page)).toEqual(['Drop-In Stick & Puck (16+)', 'Drop-in Stick & Ring', 'Stick & Puck', 'Stick & Puck', 'Stick and Puck: Youth']);
        await expect(page.locator('#filters-body .fsubs-head')).toHaveText(['Kind', 'Ages in stick & puck']);
        expect(await agesOffered(page)).toEqual(['All ages 2', 'Youth 1', 'Adult 1']);   // no older adults in stick & puck: not offered
        await kind(page, 'pickup').check();
        expect(await agesOffered(page)).toEqual(['All ages 2', 'Youth 2', 'Adult 3', 'Older adult 55+ 1']);
        await kind(page, 'stickpuck').uncheck();
        expect(await shown(page)).toEqual(['Drop-in Stick & Ring', 'Pick Up Hockey: Adults', 'Shinny: Adult', 'Shinny: Older Adult', 'Shinny: Youth']);
        await kind(page, 'pickup').uncheck();                                       // neither: Hockey is off
        await expect(hockeyBox(page)).not.toBeChecked();
        await page.keyboard.press('Escape');
        await expect(pill(page)).toHaveCount(0);
        await app.noErrors();
    });

    test('with Hockey off, ticking one kind turns Hockey on with just that one; remembered', async ({ page, app }) => {
        addHockey(app);
        await app.open();
        await openHockey(page);
        await kind(page, 'stickpuck').check();
        await expect(hockeyBox(page)).toBeChecked();
        await expect(kind(page, 'pickup')).not.toBeChecked();
        await page.keyboard.press('Escape');
        await expect(pill(page)).toContainText('Hockey: Stick & puck');
        await app.open();
        await expect(pill(page)).toContainText('Hockey: Stick & puck');
        expect(await shown(page)).toEqual(['Drop-In Stick & Puck (16+)', 'Drop-in Stick & Ring', 'Stick & Puck', 'Stick & Puck', 'Stick and Puck: Youth']);
        await app.noErrors();
    });

    test('an age with nothing in the kind left ticked is let go', async ({ page, app }) => {
        addHockey(app);
        await seed(page, { typeSel: { hockey: ['older'] } });
        await app.open();
        await openHockey(page);
        expect(await shown(page)).toEqual(['Shinny: Older Adult']);                 // only hockey is on in this profile
        await kind(page, 'pickup').uncheck();                                       // stick & puck has no older adults: every age again
        expect(await shown(page)).toEqual(['Drop-In Stick & Puck (16+)', 'Stick & Puck', 'Stick & Puck', 'Stick and Puck: Youth']);
        await app.noErrors();
    });

    test('the Hockey pill menu: a tick per kind, both on, no "Any"', async ({ page, app }) => {
        addHockey(app);
        await seed(page, { typeSel: { hockey: 'all' } });
        await app.open();
        await pill(page).click();
        const texts = async () => (await page.locator('.popover .popover-item').allTextContents()).map(t => t.replace(/[ \s]+/g, ' ').trim());
        expect((await texts()).slice(0, 3)).toEqual(['✓ Pickup (shinny) · 4', '✓ Stick & puck · 4', '✓ Every age group · 8']);
        await page.locator('.popover .popover-item', { hasText: 'Pickup (shinny)' }).click();
        await expect(pill(page)).toContainText('Hockey: Stick & puck');
        expect((await texts()).slice(0, 2)).toEqual(['Pickup (shinny) · 4', '✓ Stick & puck · 4']);
        await page.locator('.popover .popover-item', { hasText: 'Pickup (shinny)' }).click();
        await expect(pill(page)).toHaveText(/^Hockey\s*▾?\s*✕?$/);
        await app.noErrors();
    });

    test('the numbers follow the cities and Free only; a pick with nothing left stays at 0', async ({ page, app }) => {
        addHockey(app);
        await seed(page, { typeSel: { hockey: 'all' }, cities: ['Toronto'] });
        await app.open();
        await openHockey(page);
        await expect(count(page, '.fcat.type-hockey')).toHaveText('8');            // Toronto: seven of ours plus "Shinny: Adult"
        await expect(page.locator('#filters-body .fcheck', { hasText: 'Free sessions only' })).toContainText('hides 1 paid');
        await page.locator('input[data-flag="free"]').check();
        await expect(count(page, '.fcat.type-hockey')).toHaveText('7');            // the paid one is out of the count too
        await expect(kind(page, 'stickpuck').locator('xpath=..')).toContainText('3');
        await expect(page.locator('#filters-body .fchip[data-city="Mississauga"]')).toHaveText(/Mississauga · \d+/);
        await page.locator('#filters-body .fchip[data-city="Mississauga"]').click();
        await page.locator('#filters-body .fchip[data-city="Toronto"]').click();    // Mississauga alone
        await expect(count(page, '.fcat.type-hockey')).toHaveText('1');
        await expect(kind(page, 'pickup').locator('xpath=..')).toContainText('0');  // both kinds stay offered; none of one here reads 0
        await expect(kind(page, 'stickpuck').locator('xpath=..')).toContainText('1');
        await page.evaluate(() => SkateApp.Actions.setType('figure', null, true));
        await page.evaluate(() => SkateApp.Actions.setCities(['Pickering']));      // nothing of ours there
        await expect(page.locator('#filters-body .fcat.type-hockey')).toBeVisible(); // picked, 0: still shown so it can be unticked
        await expect(count(page, '.fcat.type-hockey')).toHaveText('0');
        await app.noErrors();
    });

    test('a stored kind that is not one kind is ignored', async ({ page, app }) => {
        addHockey(app);
        await seed(page, { typeSel: { hockey: 'all' }, hockeyKinds: ['<img src=x onerror=alert(1)>', 'stickpuck', 'stickpuck'] });
        await app.open();
        expect(await page.evaluate(() => SkateApp.S.kinds)).toEqual(['stickpuck']);
        await expect(pill(page)).toContainText('Hockey: Stick & puck');
        for (const bad of [['pickup', 'stickpuck'], ['other'], 'stickpuck']) {
            await page.evaluate((v) => { const s = JSON.parse(localStorage.getItem('skate_settings_v1')); s.hockeyKinds = v; localStorage.setItem('skate_settings_v1', JSON.stringify(s)); }, bad);
            await app.open();
            expect(await page.evaluate(() => SkateApp.S.kinds)).toBeNull();
        }
        await app.noErrors();
    });
});
