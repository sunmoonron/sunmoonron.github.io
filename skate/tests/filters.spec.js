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
    await page.locator('input[data-flag="free"]').check();
    await expect(rh).toHaveText('Richmond Hill · 0');                     // still there
    await rh.click();
    await expect(rh).toHaveClass(/active/);
    await page.locator('input[data-flag="free"]').uncheck();
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
    await page.locator('input[data-flag="free"]').check();               // nothing left anywhere in the list
    for (const id of ['leisure', 'figure', 'hockey']) await expect(page.locator(`#filters-body .fcat.type-${id}`)).toBeVisible();
    await expect(page.locator('#filters-body .fcat.type-hockey .fcount')).toHaveText('0');
    await app.noErrors();
});
