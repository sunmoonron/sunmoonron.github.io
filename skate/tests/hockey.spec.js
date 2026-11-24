// Hockey by kind (v3.12.2, one tap since v3.12.3): Any, Pickup (shinny) or Stick & puck,
// read from each session's title. The age groups under it count only the kind picked, and
// an age group with nothing in it is not offered. Every project: desktop and phone, light
// and dark. The suite's fixture data has one more hockey session: "Shinny: Adult" today.
const { test, expect, row, dayPlus } = require('./fixtures');

const HOCKEY = [
    { activity: 'Stick & Puck' },                                          // no ages given: All ages
    { activity: 'Drop-In Stick & Puck (16+)', ageMin: 16 },                // Adult
    { activity: 'Stick and Puck: Youth', ageMin: 13, ageMax: 17 },         // Youth
    { activity: 'Pick Up Hockey: Adults', ageMin: 18 },                    // Adult
    { activity: 'Shinny: Youth', ageMin: 13, ageMax: 17 },                 // Youth
    { activity: 'Shinny: Older Adult', ageMin: 55 },                       // Older adult: pickup only
    { activity: 'Drop-in Stick & Ring' }                                   // ringette's own drill, not hockey
];
function addHockey(app) {
    const programs = app.data['skating-programs.json'].programs;
    HOCKEY.forEach((o, i) => programs.push(row({ id: `h${i}`, loc: 300, rink: 'Warning Arena', district: 'Scarborough', date: dayPlus(1), start: `${String(8 + i).padStart(2, '0')}:00`, end: `${String(8 + i).padStart(2, '0')}:50`, ...o })));
}
const hockeyOn = (page) => page.addInitScript(() => {
    if (sessionStorage.getItem('seeded')) return;              // the first load only
    sessionStorage.setItem('seeded', '1');
    const s = JSON.parse(localStorage.getItem('skate_settings_v1') || '{}');
    s.typeSel = { ...(s.typeSel || {}), hockey: 'all' };
    localStorage.setItem('skate_settings_v1', JSON.stringify(s));
});
/** The hockey-ish titles the list would show right now (the app's own filtered set). */
const shown = (page) => page.evaluate(() => SkateApp.S.filtered.map(p => p.Activity).filter(a => /shinny|hockey|stick|puck/i.test(a)).sort());
const pill = (page) => page.locator('#active-filters .pill.type[data-pill="type:hockey"]');
const kindChip = (page, id) => page.locator(`#filters-body .fchip[data-kind-chip="${id}"]`);
/** Age groups offered under Hockey, as "label count". */
const agesOffered = (page) => page.locator('#filters-body input[data-type="hockey"][data-sub]').evaluateAll(els => els.map(e => { const l = e.closest('label'); return `${l.querySelector('.fcheck-label').textContent} ${l.querySelector('.fcount').textContent}`; }));
async function openHockey(page) {
    await page.click('#btn-filters');
    await expect(page.locator('#filters-modal')).toBeVisible();
    const expand = page.locator('.fexpand[data-expand="hockey"]');
    await expect(expand).toContainText('Kind & ages');
    if (await expand.getAttribute('aria-expanded') !== 'true') await expand.click();
}

test.describe('hockey by kind', () => {
    test('one tap on a kind shows only that hockey; the ages count that kind and empty ones are hidden', async ({ page, app }) => {
        addHockey(app);
        await app.open();
        await openHockey(page);
        await expect(page.locator('#filters-body .fkinds .fchip')).toHaveText([/^Any\s*7$/, /^Pickup \(shinny\)\s*4$/, /^Stick & puck\s*3$/]);   // no "Other hockey"
        await expect(page.locator('#filters-body .fkinds .fchip.active')).toHaveCount(0);   // Hockey is off in the suite's defaults
        await kindChip(page, 'stickpuck').click();                                        // one tap: Hockey on, just stick & puck
        await expect(kindChip(page, 'stickpuck')).toHaveAttribute('aria-pressed', 'true');
        await expect(kindChip(page, 'any')).toHaveAttribute('aria-pressed', 'false');
        await expect(page.locator('input[data-type="hockey"]:not([data-sub])')).toBeChecked();
        expect(await shown(page)).toEqual(['Drop-In Stick & Puck (16+)', 'Drop-in Stick & Ring', 'Stick & Puck', 'Stick and Puck: Youth']);   // Stick & Ring is ringette, which is on
        await expect(page.locator('#filters-body .fsubs-head')).toHaveText(['Kind', 'Ages in stick & puck']);
        expect(await agesOffered(page)).toEqual(['All ages 1', 'Youth 1', 'Adult 1']);

        await kindChip(page, 'pickup').click();                                           // the ages follow the kind
        expect(await agesOffered(page)).toEqual(['Youth 1', 'Adult 2', 'Older adult 55+ 1']);
        await kindChip(page, 'any').click();
        await expect(page.locator('#filters-body .fsubs-head')).toHaveText(['Kind', 'Ages']);
        expect(await agesOffered(page)).toEqual(['All ages 1', 'Youth 2', 'Adult 3', 'Older adult 55+ 1']);
        await app.noErrors();
    });

    test('kind and ages together, remembered; an age with nothing in the new kind is let go', async ({ page, app }) => {
        addHockey(app);
        await app.open();
        await openHockey(page);
        await kindChip(page, 'pickup').click();
        for (const id of ['youth', 'adult']) await page.locator(`input[data-type="hockey"][data-sub="${id}"]`).uncheck();   // Older adult only
        expect(await shown(page)).toEqual(['Drop-in Stick & Ring', 'Shinny: Older Adult']);
        await kindChip(page, 'stickpuck').click();                                        // no older adults there: every age again
        expect(await shown(page)).toEqual(['Drop-In Stick & Puck (16+)', 'Drop-in Stick & Ring', 'Stick & Puck', 'Stick and Puck: Youth']);
        await page.locator('input[data-type="hockey"][data-sub="all"]').uncheck();
        await page.locator('input[data-type="hockey"][data-sub="adult"]').uncheck();      // Youth only
        expect(await shown(page)).toEqual(['Drop-in Stick & Ring', 'Stick and Puck: Youth']);
        await page.keyboard.press('Escape');
        await expect(pill(page)).toContainText('Hockey: Stick & puck, Youth');
        await app.open();                                                                 // remembered across a reload
        await expect(pill(page)).toContainText('Hockey: Stick & puck, Youth');
        expect(await shown(page)).toEqual(['Drop-in Stick & Ring', 'Stick and Puck: Youth']);
        await app.noErrors();
    });

    test('the Hockey pill menu: one kind at a time (●), the ages below follow it', async ({ page, app }) => {
        addHockey(app);
        await hockeyOn(page);
        await app.open();
        await pill(page).click();
        await expect(page.locator('.popover .popover-title')).toHaveText('Hockey: kind and age');
        const texts = async () => (await page.locator('.popover .popover-item').allTextContents()).map(t => t.replace(/[ \s]+/g, ' ').trim());
        expect((await texts()).slice(0, 4)).toEqual(['● Any kind · 7', '○ Pickup (shinny) · 4', '○ Stick & puck · 3', '✓ Every age group · 7']);
        await expect(page.locator('.popover .popover-item').nth(3)).toHaveClass(/popover-sep/);
        await page.locator('.popover .popover-item', { hasText: 'Stick & puck' }).click();
        await expect(pill(page)).toContainText('Hockey: Stick & puck');
        expect(await texts()).toEqual(['○ Any kind · 7', '○ Pickup (shinny) · 4', '● Stick & puck · 3', '✓ Every age group · 3', '✓ All ages · 1', '✓ Youth · 1', '✓ Adult · 1']);
        await page.locator('.popover .popover-item', { hasText: 'Any kind' }).click();
        await expect(pill(page)).toHaveText(/^Hockey\s*▾?\s*✕?$/);
        expect(await shown(page)).toEqual(expect.arrayContaining(['Pick Up Hockey: Adults', 'Shinny: Youth', 'Stick & Puck']));
        await app.noErrors();
    });

    test('turning Hockey off forgets the kind; Clear does too; nothing overflows', async ({ page, app }) => {
        addHockey(app);
        await app.open();
        await openHockey(page);
        await kindChip(page, 'pickup').click();
        expect(await page.evaluate(() => { const b = document.getElementById('filters-body'); return [b.scrollWidth <= b.clientWidth + 1, document.documentElement.scrollWidth <= innerWidth + 1]; })).toEqual([true, true]);
        const cat = page.locator('#filters-body input[data-type="hockey"]:not([data-sub])');
        await cat.uncheck();
        expect(await page.evaluate(() => [SkateApp.S.kinds, JSON.parse(localStorage.getItem('skate_settings_v1')).hockeyKinds])).toEqual([null, null]);
        await cat.check();
        await expect(kindChip(page, 'any')).toHaveAttribute('aria-pressed', 'true');
        await kindChip(page, 'stickpuck').click();
        await page.keyboard.press('Escape');
        await expect(pill(page)).toContainText('Hockey: Stick & puck');
        await page.evaluate(() => SkateApp.Actions.resetFilters());
        expect(await page.evaluate(() => SkateApp.S.kinds)).toBeNull();
        await expect(pill(page)).toHaveCount(0);
        await app.noErrors();
    });

    test('a stored kind that is not one kind is ignored', async ({ page, app }) => {
        addHockey(app);
        await page.addInitScript(() => {
            if (sessionStorage.getItem('seeded')) return;
            sessionStorage.setItem('seeded', '1');
            const s = JSON.parse(localStorage.getItem('skate_settings_v1') || '{}');
            s.typeSel = { ...(s.typeSel || {}), hockey: 'all' };
            s.hockeyKinds = ['<img src=x onerror=alert(1)>', 'stickpuck', 'stickpuck'];
            localStorage.setItem('skate_settings_v1', JSON.stringify(s));
        });
        await app.open();
        expect(await page.evaluate(() => SkateApp.S.kinds)).toEqual(['stickpuck']);
        await expect(pill(page)).toContainText('Hockey: Stick & puck');
        for (const bad of [['pickup', 'stickpuck'], ['other'], 'stickpuck']) {           // v3.12.2 kept several; one at a time now
            await page.evaluate((v) => { const s = JSON.parse(localStorage.getItem('skate_settings_v1')); s.hockeyKinds = v; localStorage.setItem('skate_settings_v1', JSON.stringify(s)); }, bad);
            await app.open();
            expect(await page.evaluate(() => SkateApp.S.kinds)).toBeNull();
        }
        await app.noErrors();
    });
});
