// v3.15: the numbers in Filters follow your other filters, but nothing in the data is ever taken
// away from the lists: every city and every kind of skating stays offered, at 0 when your other
// filters leave nothing there (v3.14 hid them: with Free only on, Richmond Hill and Mississauga
// vanished from the city list).
const { test, expect, row, dayPlus } = require('./fixtures');

const PAID_ONLY = [
    { activity: 'Public Skating', source: 'richmondhill', paid: true, price: 5.9 },
    { activity: 'Stick & Puck', source: 'richmondhill', paid: true, price: 8.7 }
];
function addRows(app) {
    const programs = app.data['skating-programs.json'].programs;
    PAID_ONLY.forEach((o, i) => programs.push(row({ id: `f${i}`, rink: 'Ed Sackfield Arena', district: 'Richmond Hill', date: dayPlus(1), start: `${10 + i}:00`, end: `${10 + i}:50`, ...o })));
}

test('with Free only on, a city with only paid sessions stays in the list, at 0, and can still be picked', async ({ page, app }) => {
    addRows(app);
    await app.open();
    await page.click('#btn-filters');
    const rh = page.locator('#filters-body .fchip[data-city="Richmond Hill"]');
    await expect(rh).toHaveText(/^Richmond Hill · [1-9]/);
    await page.locator('#filters-modal label.ios-switch').click();
    await expect(page.locator('#f-free')).toBeChecked();
    await expect(rh).toHaveText('Richmond Hill · 0');                     // still there
    await rh.click();
    await expect(rh).toHaveClass(/active/);
    await page.locator('#filters-modal label.ios-switch').click();
    await expect(page.locator('#f-free')).not.toBeChecked();
    await expect(rh).toHaveText(/^Richmond Hill · [1-9]/);
    // the city pill's menu lists it too
    await page.keyboard.press('Escape');
    await page.locator('#active-filters .pill.city').click();
    await expect(page.locator('.popover .popover-item', { hasText: 'Richmond Hill' })).toBeVisible();
    await app.noErrors();
});

test('every kind of skating in the data stays in the list, at 0 when nothing of it is left', async ({ page, app }) => {
    addRows(app);
    await app.open();
    await page.click('#btn-filters');
    await page.evaluate(() => SkateApp.Actions.setCities(['Richmond Hill']));
    await page.locator('#filters-modal label.ios-switch').click();        // nothing left anywhere in the list
    for (const id of ['leisure', 'figure', 'hockey']) await expect(page.locator(`#filters-body .fcat.type-${id}`)).toBeVisible();
    await expect(page.locator('#filters-body .fcat.type-hockey .fcount')).toHaveText('0');
    await app.noErrors();
});

test('an age group stays offered when your other filters leave none of it (Figure\'s Adult with Free only on)', async ({ page, app }) => {
    const programs = app.data['skating-programs.json'].programs;
    programs.push(row({ id: 'fa1', loc: 100, rink: 'Alpha Arena', activity: 'Figure Skating: Adult', ageMin: 18, date: dayPlus(1), start: '07:00', end: '07:50', source: 'canlan-york', paid: true, price: 12 }));
    programs.push(row({ id: 'fa2', loc: 100, rink: 'Alpha Arena', activity: 'Figure Skating', date: dayPlus(1), start: '08:00', end: '08:50' }));
    await app.open();
    await page.click('#btn-filters');
    const expand = page.locator('.fexpand[data-expand="figure"]');
    await expect(expand).toBeVisible();
    await page.locator('#filters-modal label.ios-switch').click();               // the adult session is paid: none left
    await expect(expand).toBeVisible();                                         // the age groups are still there to open
    await expand.click();
    const adult = page.locator('#filters-body label', { has: page.locator('input[data-type="figure"][data-sub="adult"]') });
    await expect(adult.locator('.fcount')).toHaveText('0');
    await app.noErrors();
});

test('the Free only switch sits in the Filters header, is a real switch, and follows the top bar', async ({ page, app }) => {
    await app.open();
    await page.click('#btn-filters');
    const sw = page.locator('#f-free');
    await expect(sw).toHaveAttribute('role', 'switch');
    await expect(page.locator('#filters-modal .modal-header label.ios-switch')).toBeVisible();
    await expect(page.locator('#filters-body input[data-flag="free"]')).toHaveCount(0);   // one control, not two
    const before = await sw.isChecked();
    await page.locator('#filters-modal label.ios-switch').click();
    await expect(sw).toBeChecked({ checked: !before });
    expect(await page.evaluate(() => SkateApp.S.paidVisible)).toBe(before);
    // fits beside the title and the close button on a phone
    const head = await page.locator('#filters-modal .modal-header').boundingBox();
    const close = await page.locator('#btn-filters-close').boundingBox();
    expect(close.x + close.width).toBeLessThanOrEqual(head.x + head.width + 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await app.noErrors();
});

test('Your age is a box of its own: type an age, clear it', async ({ page, app }) => {
    await app.open();
    await page.click('#btn-filters');
    const box = page.locator('#filters-body .fage-box');
    await expect(box).toBeVisible();
    await expect(box.locator('.fage-unit')).toHaveText('years old');
    await page.fill('#f-age', '12');
    await page.locator('#f-age').blur();                                        // applies when you leave the box, like before
    await expect.poll(() => page.evaluate(() => SkateApp.S.age)).toBe(12);
    await page.locator('#filters-body [data-clear-age]').click();
    await expect.poll(() => page.evaluate(() => SkateApp.S.age)).toBe(null);
    await app.noErrors();
});

