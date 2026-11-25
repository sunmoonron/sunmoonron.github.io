// v3.16: a simpler top and one bar that stays above the list: the day you are looking at
// (tap: the When choices), its date (tap: a calendar for one day or a range), the count and
// the weather. Refresh and Settings sit under ⋯; Free only is a labelled switch (All | Free);
// filter pills wear their kind's colours.
const { test, expect, row, dayPlus } = require('./fixtures');

const today = dayPlus(0);
function manyToday(app, n = 12) {   // enough to scroll, few enough that the next day is in the first 30 rows
    const programs = app.data['skating-programs.json'].programs;
    for (let i = 0; i < n; i++) programs.push(row({ id: `m${i}`, loc: 100, rink: 'Alpha Arena', activity: 'Leisure Skate', date: today, start: `${String(14 + Math.floor(i / 6)).padStart(2, '0')}:${String((i % 6) * 10).padStart(2, '0')}`, end: '23:00' }));
}

test('the bar names the day at the top of the list, and follows it as you scroll', async ({ page, app }) => {
    manyToday(app);
    await app.open();
    await expect(page.locator('#db-when')).toHaveText(/^Today/);
    await expect(page.locator('#status-checked')).toHaveCount(0);
    // v3.16.3: no ▾ anywhere on the bar, every part still a button
    expect(await page.locator('#day-bar').evaluate(b => b.innerText.includes('▾') || [...b.querySelectorAll('*')].some(e => getComputedStyle(e, '::after').content.includes('▾')))).toBe(false);
    await expect(page.locator('#day-bar button:visible')).toHaveCount(3);   // the day, the date, the count (no weather in the test world)
    const next = page.locator('#program-list .day-head[data-day]:not(.first)').first();
    const nextDay = await next.getAttribute('data-day');
    // v3.16.2: the count lives at the bar's right end, at rest and scrolled
    await expect(page.locator('#day-bar #status-data')).toBeVisible();
    await next.evaluate(h => h.scrollIntoView());
    await expect.poll(() => page.evaluate(() => SkateApp.S.barDay)).toBe(nextDay);
    await expect(page.locator('#day-bar #status-data')).toBeVisible();
    await expect(page.locator('#status-data')).toHaveText(/^\d+ sessions?/);
    await page.locator('#status-data').dispatchEvent('click');   // a plain tap: no scroll first (a scroll closes menus by design)
    await expect(page.locator('#popover .popover-title')).toHaveText('Sessions shown');
    await page.keyboard.press('Escape');
    // it stays in view while the list scrolls under it
    const bar = await page.locator('#day-bar').boundingBox();
    expect(bar.y).toBeGreaterThanOrEqual(-12);
    await app.noErrors();
});

test('a day you picked is named by its weekday on the bar, even with nothing left on it (never "Any day")', async ({ page, app }) => {
    await app.open();
    const k = dayPlus(5), weekday = new Date(`${k}T12:00:00`).toLocaleDateString('en-CA', { weekday: 'long' });
    await page.evaluate((d) => SkateApp.Actions.setDates(d), k);
    await expect(page.locator('#db-when')).toHaveText(new RegExp(`^${weekday}`));
    await expect(page.locator('#db-date')).toHaveClass(/\bon\b/);
    await page.evaluate(() => SkateApp.Actions.setDates(null));
    await page.locator('#search-input').fill('zzzz no such rink');                       // nothing listed, no day picked: today
    await expect(page.locator('#db-when')).toHaveText(/^Today/);
    await expect(page.locator('#day-bar')).not.toContainText(/any day/i);
    await app.noErrors();
});

test('the day part opens the When choices; picking one filters and shows on the bar', async ({ page, app }) => {
    await app.open();
    await page.click('#db-when');
    await expect(page.locator('#popover .popover-title')).toHaveText('Day');
    await expect(page.locator('#popover .popover-item').first()).toHaveText(/✓ Any day/);
    await page.locator('#popover .popover-item', { hasText: 'Tomorrow' }).click();
    await expect.poll(() => page.evaluate(() => SkateApp.S.day)).toBe('tomorrow');
    await expect(page.locator('#db-when')).toHaveText(/^Tomorrow/);
    await expect(page.locator('#db-when')).toHaveClass(/\bon\b/);
    await expect(page.locator('#active-filters .pill[data-pill="day"]')).toHaveCount(1);
    await app.noErrors();
});

test('the date part opens a calendar: a day, then another for a range; Show applies it; Any date clears it', async ({ page, app }) => {
    await app.open();
    await page.click('#db-date');
    await expect(page.locator('#popover .dp-grid')).toBeVisible();
    await expect(page.locator(`#popover .dp-day[data-d="${dayPlus(-1)}"]`)).toBeDisabled();   // no going back in time
    const open = () => page.locator('#popover .dp-day:not([disabled]):not(.none)');   // days with sessions
    const a = await open().nth(0).getAttribute('data-d');
    await open().nth(0).click();
    await expect(page.locator('#popover .dp-hint')).toContainText('Tap another day for a range');
    const b = await open().nth(1).getAttribute('data-d');
    await open().nth(1).click();
    expect(await page.locator('#popover .dp-day.sel').count()).toBeGreaterThanOrEqual(2);
    await expect(page.locator('#popover .dp-go')).toHaveText(/^Show \d+ sessions?$/);
    await page.locator('#popover .dp-go').click();
    await expect.poll(() => page.evaluate(() => [SkateApp.S.dateFrom, SkateApp.S.dateTo, SkateApp.S.day])).toEqual([a, b, '']);
    await expect(page.locator('#db-date')).toHaveClass(/\bon\b/);
    await expect(page.locator('#active-filters .pill[data-pill="dates"]')).toHaveCount(1);
    const dates = await page.evaluate(() => [...new Set(SkateApp.S.filtered.map(p => p['Start Date']))]);
    expect(dates.length).toBeGreaterThan(0);
    expect(dates.every(d => d >= a && d <= b)).toBe(true);
    // picking a day from the When choices replaces the dates, and Any date clears them
    await page.click('#db-date');
    await page.locator('#popover .dp-any').click();
    await expect.poll(() => page.evaluate(() => SkateApp.S.dateFrom)).toBe(null);
    await expect(page.locator('#active-filters .pill[data-pill="dates"]')).toHaveCount(0);
    await app.noErrors();
});

test('⋮ holds Feedback, Refresh and Settings, closes on a tap elsewhere, and carries the dot of what is inside', async ({ page, app }) => {
    await app.open();
    const menu = page.locator('#more-menu');
    await expect(menu).toBeHidden();
    await page.click('#btn-more');
    await expect(menu).toBeVisible();
    await expect(menu.locator('.more-item:visible')).toHaveCount(3);
    await expect(page.locator('#btn-feedback')).toContainText('Feedback');
    await expect(page.locator('#btn-refresh')).toContainText('Refresh');
    await expect(page.locator('#btn-settings')).toContainText('Settings');
    await page.locator('#search-input').click();
    await expect(menu).toBeHidden();
    await expect(page.locator('#more-dot')).toBeHidden();
    await page.evaluate(() => document.getElementById('settings-dot').classList.remove('hidden'));
    await expect(page.locator('#more-dot')).toBeVisible();
    await page.click('#btn-more');
    await page.click('#btn-settings');
    await expect(page.locator('#settings-modal')).toBeVisible();
    await expect(menu).toBeHidden();
    await app.noErrors();
});

test('Free only is a labelled switch, All or Free inside it, the same in the top bar and in Filters', async ({ page, app }) => {
    await app.open();
    const top = page.locator('#btn-free');
    await expect(top).toHaveAttribute('role', 'switch');
    await expect(top).toHaveAttribute('aria-checked', 'false');
    await expect(top.locator('.fswitch-opt')).toHaveText(['All', 'Free']);
    await top.click();
    await expect(top).toHaveAttribute('aria-checked', 'true');
    await page.click('#btn-filters');
    await expect(page.locator('#f-free')).toBeChecked();
    await expect(page.locator('#filters-modal .ios-switch .fswitch-opt')).toHaveText(['All', 'Free']);
    // the knob sits inside its track with the same gap all round
    const k = await top.evaluate(t => { const s = getComputedStyle(t, '::before'), r = t.getBoundingClientRect(); return { top: parseFloat(s.top), left: parseFloat(s.left), h: parseFloat(s.height), H: r.height }; });
    expect(k.top).toBe(k.left);
    expect(k.h + 2 * k.top).toBeCloseTo(k.H, 0);
    await app.noErrors();
});

test('pills wear their colours: the city its own, each kind as on the cards, Other a blend of what it holds', async ({ page, app }) => {
    const programs = app.data['skating-programs.json'].programs;   // Other's pill shows only for kinds the data has
    ['Ringette (drop-in)', 'Speed Skating', 'Adapted Skating'].forEach((activity, i) => programs.push(row({ id: `o${i}`, loc: 100, rink: 'Alpha Arena', activity, date: dayPlus(1), start: `1${i}:00`, end: `1${i}:50` })));
    await app.open();
    const bg = (s) => page.locator(s).evaluate(e => getComputedStyle(e).backgroundColor);
    const colours = [await bg('#active-filters .pill.city'), await bg('#active-filters .pill.k-leisure'), await bg('#active-filters .pill.k-figure')];
    expect(new Set(colours).size).toBe(3);
    await expect(page.locator('#active-filters .pill.city')).not.toHaveClass(/\bk-/);   // the city pill keeps its own colour
    // any other filter's pill is a filled blue, unlike the city's
    await page.evaluate(() => SkateApp.Actions.setDay('tomorrow'));
    const day = await bg('#active-filters .pill[data-pill="day"]');
    expect(day).not.toBe(colours[0]);
    expect(day).not.toBe('rgba(0, 0, 0, 0)');
    const mix = page.locator('#active-filters .pill.k-mix');
    const before = await mix.evaluate(e => getComputedStyle(e).backgroundImage);
    expect(before).toMatch(/linear-gradient/);
    await page.click('#btn-filters');
    await page.locator('.fexpand[data-expand="__other"]').click();
    await page.locator('#filters-body input[data-type="ringette"]').uncheck();
    await expect.poll(() => mix.evaluate(e => getComputedStyle(e).backgroundImage)).not.toBe(before);
    await app.noErrors();
});
