// v3.18: outdoor rinks. Their sessions carry an Outdoor tag; with both kinds of ice listed each day is
// its indoor sessions first, then its outdoor rinks (open most of the day, they would bury the rest),
// with a line in the day header to jump to them; Filters has Ice: Indoor + outdoor / Indoor / Outdoor.
// And an old open-ended closure notice is "Call to confirm", not a cancellation.
const { test, expect, row, dayPlus, stamp } = require('./fixtures');

const D = dayPlus(1);
function world(app) {
    const programs = app.data['skating-programs.json'].programs;
    // Beta Park Rink (200) is outdoor, Alpha Arena (100) indoor
    programs.push(row({ id: 'o1', loc: 200, rink: 'Beta Park Rink', activity: 'Leisure Skate', date: D, start: '09:00', end: '22:00' }));
    programs.push(row({ id: 'o2', loc: 200, rink: 'Beta Park Rink', activity: 'Leisure Skate: Adult', ageMin: 18, date: D, start: '10:00', end: '12:00' }));
    programs.push(row({ id: 'i1', loc: 100, rink: 'Alpha Arena', activity: 'Leisure Skate', date: D, start: '19:00', end: '20:00' }));
    programs.push(row({ id: 'i2', loc: 100, rink: 'Alpha Arena', activity: 'Figure Skating', date: D, start: '20:00', end: '21:00' }));
}
const dayItems = (page) => page.evaluate((d) => {
    const out = []; let on = false;
    for (const li of document.querySelectorAll('#program-list > li')) {
        if (li.classList.contains('day-head')) { on = li.dataset.day === d; continue; }
        if (!on) continue;
        out.push(li.classList.contains('out-head') ? 'OUT-HEAD' : (li.querySelector('.ice-badge') ? 'out' : 'in'));
    }
    return out;
}, D);

test('outdoor sessions carry a tag; a day lists indoor first, then its outdoor rinks under a sub-header', async ({ page, app }) => {
    world(app);
    await app.open();
    const items = await dayItems(page);
    const cut = items.indexOf('OUT-HEAD');
    expect(cut).toBeGreaterThan(0);
    expect(items.slice(0, cut).every(k => k === 'in')).toBe(true);
    expect(items.slice(cut + 1).every(k => k === 'out')).toBe(true);
    expect(items.slice(cut + 1).length).toBeGreaterThanOrEqual(2);
    await expect(page.locator('.program-item', { hasText: 'Alpha Arena' }).first().locator('.ice-badge')).toHaveCount(0);
    // the day's header has one line that brings the outdoor rinks into view
    const line = page.locator(`#program-list .day-out[data-out-day="${D}"]`);
    await expect(line).toHaveText(/^Outdoor rinks: \d+ sessions? ↓$/);
    await line.click();
    const y = await page.locator(`#program-list .out-head[data-day="${D}"]`).evaluate(e => e.getBoundingClientRect().top);
    expect(y).toBeGreaterThanOrEqual(0);
    expect(y).toBeLessThan(await page.evaluate(() => innerHeight));
    await app.noErrors();
});

test('indoor or outdoor: a section of its own in Filters (under Your age) and a standing pill beside the city; it is remembered', async ({ page, app }) => {
    world(app);
    await app.open();
    const pill = page.locator('#active-filters .pill.ice');
    await expect(pill).toHaveText(/^Indoor \+ outdoor/);                                 // always there
    await expect(pill).not.toHaveClass(/\bon\b/);
    // v3.20: a colour of its own that shows what it holds: a blend for both, one colour once narrowed
    const paint = () => pill.evaluate(e => getComputedStyle(e).backgroundImage);
    const both = await paint();
    expect(both).toMatch(/linear-gradient/);
    await page.click('#btn-filters');
    // v3.19: its own section, with Distance and Order, between Your age and When; each row on one line
    const heads = await page.locator('#filters-body .fsec h4').allTextContents();
    expect(heads.slice(heads.indexOf('Your age'), heads.indexOf('When') + 1)).toEqual(['Your age', 'Indoor or outdoor', 'Distance from you', 'Order', 'When']);
    await expect(page.locator('#filters-body .fice .fchip')).toHaveText(['Both', 'Indoor', 'Outdoor']);
    for (const row of ['.fice', '.fradius', '.forder']) expect(new Set(await page.locator(`#filters-body ${row} .fchip`).evaluateAll(els => els.map(e => Math.round(e.getBoundingClientRect().top)))).size, `${row} on one line`).toBe(1);
    await page.locator('#filters-body .fice .fchip', { hasText: /^Outdoor$/ }).click();
    await page.click('#btn-filters-apply');
    await expect(pill).toHaveText(/^Outdoor/);
    await expect(pill).toHaveClass(/\bon\b/);
    expect(await paint()).not.toBe(both);
    expect(await page.evaluate(() => SkateApp.S.filtered.length > 0 && [...document.querySelectorAll('.program-item')].every(c => c.querySelector('.ice-badge')))).toBe(true);
    await expect(page.locator('#program-list .out-head, #program-list .day-out')).toHaveCount(0);   // one kind listed: nothing to split
    expect(await page.evaluate(() => SkateSettings.get('ice'))).toBe('outdoor');
    // the pill's menu picks another; its x goes back to both
    await pill.click();
    await page.locator('#popover .popover-item', { hasText: 'Indoor only' }).click();
    await expect(pill).toHaveText(/^Indoor/);
    expect(await page.evaluate(() => document.querySelectorAll('.program-item .ice-badge').length)).toBe(0);
    await pill.locator('.pill-x').click();
    expect(await page.evaluate(() => SkateApp.S.ice)).toBe('all');
    await expect(pill).toHaveText(/^Indoor \+ outdoor/);
    await app.noErrors();
});

test('a closure notice with no end date is a likely cancellation for 48 hours, then "Call to confirm"', async ({ page, app }) => {
    const programs = app.data['skating-programs.json'].programs;
    // posted 22 days ago and never updated (Downsview, Nov 2026); and one posted this morning
    app.data['alerts.json'].alerts.push(
        { LocationID: 600, AssetID: '60', AssetName: 'Stale Arena', Type: 'Centre', DisplayAlertName: 'Centre', Category: 'STALE ARENA', Status: 0, Scope: 'facility',
          Reason: 'Emergency Response', Comments: 'Stale arena is closed for emergency repairs. We apologize.', PostedDate: stamp(-22) },
        { LocationID: 601, AssetID: '61', AssetName: 'Fresh Arena', Type: 'Centre', DisplayAlertName: 'Centre', Category: 'FRESH ARENA', Status: 0, Scope: 'facility',
          Reason: 'Emergency Response', Comments: 'Fresh arena is closed for emergency repairs. We apologize.', PostedDate: stamp(0) });
    programs.push(row({ id: 's1', loc: 600, rink: 'Stale Arena', activity: 'Leisure Skate', date: D, start: '18:00', end: '19:00' }));
    programs.push(row({ id: 'f1', loc: 601, rink: 'Fresh Arena', activity: 'Leisure Skate', date: D, start: '18:00', end: '19:00' }));
    programs.push(row({ id: 'f2', loc: 601, rink: 'Fresh Arena', activity: 'Leisure Skate: Adult', ageMin: 18, date: dayPlus(9), start: '18:00', end: '19:00' }));
    await app.open();
    await page.evaluate(() => { SkateApp.S.limit = 500; SkateApp.Render.programs(); });
    const stale = page.locator('.program-item', { hasText: 'Stale Arena' });
    await expect(stale.locator('.alert-banner')).toContainText('Call to confirm');
    await expect(stale.locator('.alert-banner')).toContainText('has not updated it since');
    await expect(stale.locator('.alert-banner')).toContainText('Stale arena is closed for emergency repairs');
    await expect(stale).not.toHaveClass(/has-alert-closed/);
    await expect(stale.locator('.program-title')).toHaveCSS('text-decoration-line', 'none');
    // posted this morning: tomorrow evening's session (33 hours on) is still a likely cancellation; the one nine days out is not our call
    const fresh = page.locator('.program-item', { hasText: 'Fresh Arena' });
    await expect(fresh.first()).toHaveClass(/has-alert-closed/);
    await expect(fresh.first().locator('.alert-banner')).toContainText('Likely cancelled');
    await expect(fresh.nth(1).locator('.alert-banner')).toContainText('Call to confirm');
    await app.noErrors();
});
