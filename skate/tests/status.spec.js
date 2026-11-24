// v3.12: the status line in two parts, and the Data status sheet behind "checked":
// every source the app reads, grouped, worded by how its last read went, and
// narrowed to the cities in the Where filter. No banner per failed feed any more.
const { test, expect, NOW_ISO } = require('./fixtures');

const at = new Date(NOW_ISO).toISOString();
const earlier = new Date(Date.parse(NOW_ISO) - 26 * 3600 * 1000).toISOString();   // yesterday, 11:00 am
const SOURCES = {
    'mosspark':        { ok: true, state: 'ok', count: 8, at, okAt: at },
    'bolton-public':   { ok: true, state: 'ok', count: 8, at, okAt: at },
    'bolton-adult':    { ok: false, state: 'failed', count: 4, at, okAt: earlier, error: 'HTTP 503 for https://www.billboltonarena.ca/public-skating' },
    'bolton-tots':     { ok: true, state: 'ok', count: 4, at, okAt: at },
    'georgebell':      { ok: true, state: 'ok', count: 16, at, okAt: at },
    'mccormick':       { ok: true, state: 'closed', count: 0, at, okAt: at, quote: 'This schedule ended on April 30th, 2026.' },
    'tedreeve':        { ok: true, state: 'none', count: 0, at, okAt: at, quote: 'Ted Reeve does not offer Pleasure Skating times.' },
    'harbourfront':    { ok: true, state: 'pending', count: 0, at, okAt: at, quote: 'The Rink will open for the season when cooler weather permits.' },
    'bentway':         { ok: true, state: 'pending', count: 3, at, okAt: at, season: { from: '2026-12-12', to: '2027-02-28' }, note: 'Opens December 12.' },
    'evergreen':       { ok: true, state: 'dormant', count: 0, at, resumes: '2026-10-28', opens: '2026-12-01' },
    'yzd':             { ok: true, state: 'pending', count: 0, at, okAt: at, manual: '2026-11-21', season: { from: '2026-12-19', to: '2027-02-15' } },
    'mississauga':     { ok: true, state: 'ok', count: 202, at, okAt: at },
    'mississauga-square': { ok: true, state: 'pending', count: 0, at, okAt: at, quote: 'Celebration Square’s ice rink is closed for the season and will reopen by winter 2026 (weather-dependant).' },
    'brampton-outdoor': { ok: true, state: 'ok', count: 12, at, okAt: at },
    'ajax':            { ok: false, state: 'failed', count: 0, at, error: 'no schedule rules parsed from page' }
};
function withSources(app, sources = SOURCES, extra = {}) {
    for (const f of ['skating-programs.json', 'meta.json']) {
        const m = f === 'meta.json' ? app.data[f] : app.data[f].metadata;
        m.sources = sources;
        m.counts = { ...(m.counts || {}), cityPrograms: 8688 };
        Object.assign(m, extra);
    }
}
const row = (page, name) => page.locator('#status-body .st-row', { has: page.locator('.st-top strong', { hasText: name }) });
const groups = (page) => page.locator('#status-body h4').allTextContents();

test.describe('data status', () => {
    test('the line has two parts: the count opens options, "checked" opens the sheet with the City\'s own checks', async ({ page, app }) => {
        withSources(app, {}, { city: { modified: earlier } });
        app.data['live-check.json'].stats = { missing: 1, extra: 0 };
        await app.open();
        await expect(page.locator('#status-data')).toHaveText(/^\d+ sessions?$/);
        await expect(page.locator('#status-checked')).toHaveText(/^✓ checked 1:00 p\.?m\.?$/i);
        await page.click('#status-data');
        await expect(page.locator('#popover .popover-title')).toHaveText('Sessions shown');
        await expect(page.locator('#popover')).toContainText('Refresh now');
        await page.locator('#popover .popover-item', { hasText: 'Data status' }).click();
        await expect(page.locator('#status-modal')).toBeVisible();
        await page.click('#btn-status-close');
        await expect(page.locator('#status-modal')).toBeHidden();

        await page.click('#status-checked');
        await expect(page.locator('#status-modal')).toBeVisible();
        expect((await groups(page))[0]).toBe('City of Toronto');
        await expect(row(page, 'Drop-in schedule')).toContainText('read 1:00');
        await expect(row(page, 'Drop-in schedule')).toContainText('8,688 sessions in the City\'s weekly file.');
        await expect(row(page, 'Drop-in schedule')).toContainText(/The City last refreshed that file Oct 23, 11:00 a\.?m\.?(?!\.)/);
        await expect(row(page, 'Rink closures and notices')).toContainText(/4 notices on file/);
        await expect(row(page, 'Live schedule cross-check')).toContainText('1 session hidden because toronto.ca no longer lists it');
        await expect(row(page, 'Free skates van')).toHaveCount(0);                 // this world has no lending file: no row, no fuss
        for (const n of ['Drop-in schedule', 'Rink closures and notices', 'Live schedule cross-check']) await expect(row(page, n)).toHaveClass(/st-ok/);
        await app.noErrors();
    });

    test('each source says how its last read went; one place read three ways is one row', async ({ page, app }) => {
        withSources(app);
        await app.open();
        // v3.15.3: an arena's own page (Bolton's) being behind is for the sheet, not the line; Ajax's site is outside the filter
        await expect(page.locator('#status-checked')).toHaveText(/^✓ checked 1:00 p\.?m\.?$/i);
        await expect(page.locator('#status-checked')).not.toHaveClass(/stale/);
        await expect(page.locator('.alert-banner', { hasText: 'feed failed' })).toHaveCount(0);   // no banner per feed
        await page.click('#status-checked');
        expect(await groups(page)).toEqual(['City of Toronto', 'Toronto arenas run by their own boards', 'Other Toronto rinks']);
        await expect(page.locator('#status-body .st-scope')).toContainText('Showing your cities: Toronto');
        await expect(page.locator('#status-body .st-sum.warn')).toContainText('One source needs attention');

        await expect(row(page, 'Moss Park Arena')).toContainText('read 1:00');
        await expect(row(page, 'Moss Park Arena')).toContainText('8 sessions');
        const bolton = row(page, 'William H. Bolton Arena');
        await expect(bolton).toHaveCount(1);
        await expect(bolton).toHaveClass(/st-warn/);
        await expect(bolton.locator('.st-head')).toHaveText(/not read since Oct 23, 11:00/);
        await expect(bolton).toContainText('Showing the 16 sessions from the last good read.');
        await expect(bolton).toContainText('HTTP 503');
        await expect(row(page, 'McCormick Arena').locator('.st-head')).toHaveText('closed for the season');
        await expect(row(page, 'McCormick Arena')).toContainText('Its page says: “This schedule ended on April 30th, 2026.”');
        await expect(row(page, 'McCormick Arena')).toContainText('Closed for renovations');
        await expect(row(page, 'Ted Reeve Community Arena').locator('.st-head')).toHaveText('no public skating');
        await expect(row(page, 'Ted Reeve Community Arena')).toContainText('Its site says: “Ted Reeve does not offer Pleasure Skating times.”');
        await expect(row(page, 'North Toronto Memorial Arena').locator('.st-head')).toHaveText('not read yet');   // configured, not in the file yet
        await expect(row(page, 'Harbourfront Centre Rink').locator('.st-head')).toHaveText('not open yet');
        await expect(row(page, 'Harbourfront Centre Rink')).toContainText('Its page says: “The Rink will open for the season when cooler weather permits.”');
        await expect(row(page, 'The Bentway Skate Trail').locator('.st-head')).toHaveText('opens Dec 12');
        await expect(row(page, 'The Bentway Skate Trail')).toContainText('3 sessions already listed.');
        await expect(row(page, 'Evergreen Brick Works').locator('.st-head')).toHaveText('out of season');
        await expect(row(page, 'Evergreen Brick Works')).toContainText('Not read again until Oct 28');
        await expect(row(page, 'YZD Hangar Skate').locator('.st-head')).toHaveText('opens Dec 19');
        await expect(row(page, 'YZD Hangar Skate')).toContainText('Hours entered by hand on Nov 21');
        for (const n of ['Harbourfront Centre Rink', 'The Bentway Skate Trail', 'YZD Hangar Skate']) await expect(row(page, n)).toHaveClass(/st-wait/);
        for (const n of ['McCormick Arena', 'Ted Reeve Community Arena', 'Evergreen Brick Works']) await expect(row(page, n)).toHaveClass(/st-off/);
        await expect(row(page, 'Town of Ajax')).toHaveCount(0);
        await app.noErrors();
    });

    test('it follows the city filter: one look at every city from the sheet, and all cities when none is picked', async ({ page, app }) => {
        withSources(app);
        await app.open();
        await page.click('#status-checked');
        await page.locator('#status-body [data-st-all="1"]').click();
        const all = await groups(page);
        expect(all.slice(0, 3)).toEqual(['City of Toronto', 'Toronto arenas run by their own boards', 'Other Toronto rinks']);
        expect(all.slice(3)).toEqual([...all.slice(3)].sort((a, b) => a.localeCompare(b)));          // then each city, A to Z
        expect(all).toEqual(expect.arrayContaining(['Ajax', 'Brampton', 'Mississauga', 'Markham']));
        await expect(page.locator('#status-body .st-sum.warn')).toContainText('2 sources need attention');
        const ajax = row(page, 'Town of Ajax');
        await expect(ajax.locator('.st-head')).toHaveText('could not be read');
        await expect(ajax).toContainText('Nothing from it is listed until it reads again.');
        await expect(row(page, 'Celebration Square Rink').locator('.st-head')).toHaveText('not open yet');
        await expect(row(page, 'Brampton outdoor rinks')).toContainText('12 sessions');
        await page.locator('#status-body [data-st-all="0"]').click();
        expect(await groups(page)).toHaveLength(3);
        await page.click('#btn-status-close');

        // widen the filter itself: the line counts Ajax, the Town's own site (Bolton's page still is not), and the sheet opens on everything
        await page.locator('#active-filters .pill.city .pill-x').click();
        await expect(page.locator('#status-checked')).toHaveText(/^⚠️ checked 1:00 p\.?m\.? · 1 source behind$/i);
        await page.click('#status-checked');
        expect(await groups(page)).toEqual(all);
        await expect(page.locator('#status-body .st-scope')).toHaveCount(0);
        await page.click('#btn-status-close');

        // one other city: only its rows, and the City of Toronto's are gone
        await page.locator('#active-filters .pill.city').click();
        await page.locator('#popover .popover-item', { hasText: 'Mississauga' }).click();
        await page.keyboard.press('Escape');
        await expect(page.locator('#status-checked')).not.toContainText('behind');
        await page.click('#status-checked');
        expect(await groups(page)).toEqual(['Mississauga']);
        await expect(page.locator('#status-body .st-row')).toHaveCount(2);
        await app.noErrors();
    });

    test('a page that changed: hand-entered hours are hidden (in the sheet, not on the line); a watched page with no skating only waits', async ({ page, app }) => {
        withSources(app, {
            tedreeve: { ok: true, state: 'changed', count: 0, at, okAt: at, note: 'Its page no longer says what it did when it was last looked at. It needs a look.' },
            yzd: { ok: true, state: 'changed', count: 0, at, okAt: at, manual: '2026-11-21', note: 'Its page changed since the hours were entered by hand. Nothing is listed until they are checked again.' }
        });
        await app.open();
        await expect(page.locator('#status-checked')).not.toContainText('behind');           // v3.15.3: a rink's page, not a city's site
        await page.click('#status-checked');
        await expect(page.locator('#status-body .st-sum.warn')).toContainText('One source needs attention');
        await expect(row(page, 'Ted Reeve Community Arena')).toHaveClass(/st-wait/);
        await expect(row(page, 'Ted Reeve Community Arena').locator('.st-head')).toHaveText('its page changed');
        await expect(row(page, 'YZD Hangar Skate')).toHaveClass(/st-warn/);
        await expect(row(page, 'YZD Hangar Skate')).toContainText('Nothing is listed until they are checked again.');
        await expect(row(page, 'YZD Hangar Skate')).not.toContainText('Its page is still checked each time');
        await app.noErrors();
    });

    test('hand-entered hours whose page was edited afterwards: still listed, noted quietly, not counted as behind', async ({ page, app }) => {
        withSources(app, {
            mosspark: { ok: true, state: 'ok', count: 8, at, okAt: at },
            yzd: { ok: true, state: 'ok', count: 9, at, okAt: at, manual: '2026-11-21', season: { from: '2026-12-19', to: '2027-02-15' }, edited: '2026-12-01' }
        });
        await app.open();
        await expect(page.locator('#status-checked')).toContainText('✓ checked');
        await expect(page.locator('#status-checked')).not.toContainText('behind');
        await expect(page.locator('#status-checked')).not.toHaveClass(/stale/);
        await page.click('#status-checked');
        const y = row(page, 'YZD Hangar Skate');
        await expect(y).toHaveClass(/st-wait/);
        await expect(y.locator('.st-head')).toHaveText('its page was edited');
        await expect(y).toContainText('Its page was edited on Dec 1, after these hours were entered, so they are being checked again. Its own site has the final word.');
        await expect(y).toContainText('9 sessions');
        await expect(y).toContainText('Hours entered by hand on Nov 21');
        await app.noErrors();
    });

    test('an edit flag that is not a date is ignored; a republished site is a note, not a warning', async ({ page, app }) => {
        withSources(app, {
            yzd: { ok: true, state: 'ok', count: 9, at, okAt: at, manual: '2026-11-21', edited: '<img src=x onerror=alert(1)>', note: 'Its whole site was republished on Dec 2, after these hours were entered.' }
        });
        await app.open();
        await expect(page.locator('#status-checked')).not.toContainText('behind');
        await page.click('#status-checked');
        const y = row(page, 'YZD Hangar Skate');
        await expect(y).toHaveClass(/st-ok/);
        await expect(y).toContainText('Its whole site was republished on Dec 2, after these hours were entered.');
        await expect(y).not.toContainText('its page was edited');
        await app.noErrors();
    });

    test('a file from before v3.12 (only ok and a count per source) still reads correctly', async ({ page, app }) => {
        withSources(app, { mosspark: { ok: true, count: 8 }, grossman: { ok: false, count: 5, error: 'HTTP 500' } });
        await app.open();
        await expect(page.locator('#status-checked')).not.toContainText('behind');           // an arena's page: the sheet says so
        await page.click('#status-checked');
        await expect(row(page, 'Moss Park Arena')).toContainText('read 1:00');
        const g = row(page, 'Larry Grossman Forest Hill Memorial Arena');
        await expect(g.locator('.st-head')).toHaveText('could not be read');
        await expect(g).toContainText('Showing the 5 sessions from the last good read.');
        await app.noErrors();
    });

    test('the line warns only for toronto.ca or a city\'s own site, and only for the cities you look at (v3.15.3)', async ({ page, app }) => {
        withSources(app, { ...SOURCES, markham: { ok: false, count: 5, error: 'HTTP 500' } });   // Markham's own site, a file from before v3.12
        app.data['alerts.json'].checkedAt = earlier;                                                 // the City's notices not read for a day
        await app.open();
        const line = page.locator('#status-checked');
        await expect(line).toHaveText(/^⚠️ checked 1:00 p\.?m\.? · 1 source behind$/i);           // toronto.ca; Bolton's page is not counted
        await expect(line).toHaveClass(/stale/);
        await page.evaluate(() => SkateApp.Actions.setCities(['Mississauga']));
        await expect(line).toHaveText(/^✓ checked 1:00 p\.?m\.?$/i);                               // not looking at Toronto: nothing to worry about
        await expect(line).not.toHaveClass(/stale/);
        await page.evaluate(() => SkateApp.Actions.setCities(['Markham', 'Ajax']));
        await expect(line).toHaveText(/· 2 sources behind$/);                                        // each town's own site
        await page.click('#status-checked');
        await expect(row(page, 'City of Markham').locator('.st-head')).toHaveText('could not be read');
        await app.noErrors();
    });

    test('text from the data file is shown as text, and odd values do not break the sheet', async ({ page, app }) => {
        withSources(app, {
            mosspark: { ok: true, state: 'ok', count: 'many', at: 'not a date', note: '<img src=x onerror="window.__x=1">' },
            harbourfront: { ok: true, state: 'pending', count: 0, at, quote: '<b>bold</b> ' + 'x'.repeat(600), season: { from: 12 } },
            bentway: 'nope', evergreen: null, yzd: { state: 'sideways' },
            'made-up-source': { ok: true, state: 'ok', count: 1, at }
        });
        await app.open();
        await page.click('#status-checked');
        await page.locator('#status-body [data-st-all="1"]').click();
        await expect(row(page, 'Moss Park Arena')).toContainText('<img src=x');
        expect(await page.evaluate(() => window.__x)).toBeUndefined();
        await expect(page.locator('#status-body img, #status-body b')).toHaveCount(0);
        const hf = await row(page, 'Harbourfront Centre Rink').locator('.st-line').first().textContent();
        expect(hf.length).toBeLessThan(220);
        await expect(row(page, 'The Bentway Skate Trail').locator('.st-head')).toHaveText('not read yet');
        await expect(row(page, 'made-up-source')).toHaveCount(1);          // a source the app has no label for is still listed
        await app.noErrors();
    });

    test('the two parts and the weather chip fit a narrow phone; the sheet scrolls inside itself', async ({ page, app }) => {
        withSources(app);
        await app.open();
        await page.setViewportSize({ width: 320, height: 640 });
        const fits = await page.evaluate(() => {
            const line = document.querySelector('.status-line').getBoundingClientRect();
            return [...document.querySelectorAll('.status-line .status-btn:not(.hidden)')].every(b => { const r = b.getBoundingClientRect(); return r.left >= line.left - 0.5 && r.right <= line.right + 0.5; });
        });
        expect(fits).toBe(true);
        await page.click('#status-checked');
        const box = await page.evaluate(() => {
            const m = document.querySelector('#status-modal .modal').getBoundingClientRect(), b = document.getElementById('status-body');
            return { inside: m.left >= 0 && m.right <= window.innerWidth + 0.5 && m.bottom <= window.innerHeight + 0.5, scrolls: b.scrollHeight > b.clientHeight, wide: b.scrollWidth <= b.clientWidth + 1 };
        });
        expect(box).toEqual({ inside: true, scrolls: true, wide: true });
        await app.noErrors();
    });
});
