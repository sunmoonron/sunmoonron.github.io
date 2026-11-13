// The schedule: boot, search, filters, pills, saved sessions, menus, alerts,
// calendar, the self-update check, the service worker, phone layout.
const { test, expect, dayPlus, stamp, row, NOW_ISO } = require('./fixtures');

const card = (page, text) => page.locator('.program-item', { hasText: text });
const isPhone = (testInfo) => testInfo.project.name.startsWith('phone');

test.describe('schedule', () => {
    test('boots from data, renders cards, loads no community code, logs no errors', async ({ page, app }) => {
        await app.open();
        expect(await page.locator('.program-item').count()).toBeGreaterThanOrEqual(6);
        await expect(page.locator('#status-data')).toContainText('sessions');
        const files = await page.evaluate(() => performance.getEntriesByType('resource').map(e => e.name.split('/').pop().split('?')[0]));
        expect(files.filter(f => /nostr|chat-v2|guides|devchat|moderation|profanity/.test(f))).toEqual([]);
        await expect(card(page, 'Shinny: Adult')).toHaveCount(0);                 // hockey is off for a new visitor
        await expect(card(page, 'Paul Coffey Arena')).toHaveCount(0);             // Toronto only by default
        await app.noErrors();
    });

    test('time status: on now, starts in, ended sessions hidden', async ({ page, app }) => {
        await app.open();
        await expect(card(page, 'Beta Park Rink').locator('.happening-now')).toContainText('On now');
        await expect(card(page, 'Alpha Arena').first().locator('.happening-now')).toContainText('Starts in');
        expect(await card(page, 'Alpha Arena').count()).toBe(1);                   // the 10:00 one is over
        await app.noErrors();
    });

    test('search narrows the list and the ✕ clears it', async ({ page, app }) => {
        await app.open();
        const before = await page.locator('.program-item').count();
        await page.fill('#search-input', 'Beta');
        await expect(page.locator('.program-item')).toHaveCount(1);
        await page.click('#btn-search-clear');
        await expect(page.locator('.program-item')).toHaveCount(before);
        await app.noErrors();
    });

    test('filters sheet: kinds, day chips, pills', async ({ page, app }) => {
        await app.open();
        await page.click('#btn-filters');
        await expect(page.locator('#filters-modal')).toBeVisible();
        await page.locator('#filters-body input[data-type="leisure"]').first().click();
        await expect(card(page, 'Beta Park Rink')).toHaveCount(0);
        await expect(card(page, 'Warning Arena')).toHaveCount(1);                  // figure stays
        await page.locator('#filters-body input[data-type="hockey"]').first().click();
        await expect(card(page, 'Shinny: Adult')).toHaveCount(1);
        await page.click('#filters-body .fchip[data-day="today"]');
        await expect(card(page, 'Leaside Memorial')).toHaveCount(0);              // tomorrow
        await page.click('#btn-filters-apply');
        await expect(page.locator('#filters-modal')).toBeHidden();
        await expect(page.locator('#active-filters .pill[data-pill="day"]')).toBeVisible();
        await page.click('#active-filters .pill[data-pill="day"]');
        await expect(card(page, 'Leaside Memorial')).toHaveCount(1);
        await page.click('#active-filters .pill[data-pill="type:hockey"] .pill-x');
        await expect(card(page, 'Shinny: Adult')).toHaveCount(0);
        await app.noErrors();
    });

    test('Free only hides paid sessions and says so', async ({ page, app }) => {
        await app.open();
        await expect(card(page, 'Pleasure Skate')).toHaveCount(1);
        await page.click('#btn-free');
        await expect(card(page, 'Pleasure Skate')).toHaveCount(0);
        await expect(card(page, 'Leaside Memorial')).toHaveCount(0);
        await expect(page.locator('#status-data')).toContainText('paid hidden');
        await page.click('#btn-free');
        await expect(card(page, 'Pleasure Skate')).toHaveCount(1);
        await app.noErrors();
    });

    test('end of the day: the list says so and offers tomorrow', async ({ page, app }) => {
        await app.open();
        await page.clock.setFixedTime(new Date(`${dayPlus(0)}T22:30:00-04:00`));
        await page.evaluate(() => SkateApp.Actions.setDay('today'));
        await expect(page.locator('#program-list')).toContainText('No more sessions today');
        await page.click('#program-list [data-day-tomorrow]');
        await expect(card(page, 'Leaside Memorial')).toHaveCount(1);
        await app.noErrors();
    });

    test('♡ saves a session, it shows up top and survives a reload', async ({ page, app }) => {
        await app.open();
        await page.locator('.program-item [data-act="fav"]').first().click();
        await expect(page.locator('#saved-next')).toBeVisible();
        await expect(page.locator('#saved-next .saved-row')).toHaveCount(1);
        await page.reload();
        await expect(page.locator('#saved-next .saved-row')).toHaveCount(1);
        await app.noErrors();
    });

    test('card menu: a title, a ✕, Escape', async ({ page, app }) => {
        await app.open();
        const first = page.locator('.program-item').first();
        const title = (await first.locator('.program-title').innerText()).trim();
        await first.locator('[data-act="copy"]').click();
        await expect(page.locator('#popover')).toBeVisible();
        await expect(page.locator('#popover .popover-title')).toHaveText(title);
        await page.click('#popover .popover-close');
        await expect(page.locator('#popover')).toBeHidden();
        await first.locator('[data-act="copy"]').click();
        await expect(page.locator('#popover')).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(page.locator('#popover')).toBeHidden();
        await app.noErrors();
    });

    test('alerts: closed strikes, warning warns, an ended one is a note, a long-ended one is silent, live-check drops', async ({ page, app }) => {
        await app.open();
        const alpha = card(page, 'Alpha Arena').first();
        await expect(alpha).toHaveClass(/has-alert-closed/);
        await expect(alpha.locator('.alert-banner.closed')).toContainText('Likely cancelled');
        await expect(alpha.locator('.program-title')).toHaveCSS('text-decoration-line', 'line-through');
        await expect(alpha.locator('.program-time')).toHaveCSS('text-decoration-line', 'line-through');
        await expect(card(page, 'Warning Arena').locator('.alert-banner.warning')).toContainText('Service alert');
        await expect(card(page, 'Note Arena').locator('.alert-banner.note')).toContainText('Worth a quick call');
        await expect(card(page, 'Expired Arena').locator('.alert-banner')).toHaveCount(0);
        await expect(card(page, 'Leisure Skate: Adult')).toHaveCount(0);           // the City's live schedule dropped it
        await page.evaluate(() => SkateApp.Actions.setFlag('dropped', true));
        await expect(card(page, 'Leisure Skate: Adult').locator('.alert-banner.live-flag')).toContainText("Not on the City's live schedule");
        await app.noErrors();
    });

    test('alerts v3.10: the pipeline\'s reading wins over the words, a building notice is grey, last season\'s notice is a note and yellow on the day', async ({ page, app }) => {
        const T = dayPlus(0), T3 = dayPlus(3);
        const rink = (o) => ({ postal: 'M8V 6Z6', district: 'Etobicoke York', lat: 43.61, lng: -79.5, pads: 1, operator: '', source: 'city', ...o });
        app.data['rinks.json'].rinks.push(
            rink({ locationid: '600', name: 'Frost Park Rink', address: '6 Zeta Way', kinds: ['outdoor'] }),
            rink({ locationid: '700', name: 'Lobby Arena', address: '7 Eta Blvd', kinds: ['indoor'], pads: 2 }),
            rink({ locationid: '800', name: 'Zed Arena', address: '8 Theta Cres', kinds: ['indoor'] }));
        app.data['skating-programs.json'].programs.push(
            row({ id: 's1', loc: 600, rink: 'Frost Park Rink', activity: 'Leisure Skate', date: T, start: '21:00', end: '22:00' }),
            row({ id: 's2', loc: 600, rink: 'Frost Park Rink', activity: 'Leisure Skate', date: T3, start: '11:00', end: '12:00' }),
            row({ id: 'b1', loc: 700, rink: 'Lobby Arena', activity: 'Leisure Skate', date: T, start: '21:30', end: '22:30' }),
            row({ id: 'z1', loc: 800, rink: 'Zed Arena', activity: 'Leisure Skate', date: T, start: '22:00', end: '23:00' }));
        const alerts = app.data['alerts.json'];
        alerts.alerts.push(
            // last winter's notice, still posted: this fall's sessions are a new season
            { LocationID: 600, AssetID: '6', AssetName: 'Frost Park Rink - Outdoor Artificial Ice Rink', Type: 'Outdoor Artificial Ice Rink', DisplayAlertName: 'Skate', Category: 'FROST PARK', Status: 0,
              Reason: 'Closed for the Season', Comments: '', PostedDate: stamp(-220) },
            { LocationID: 700, AssetID: '7', AssetName: 'Lobby Arena - Indoor Ice Rink', Type: 'Indoor Ice Rink', DisplayAlertName: 'Skate', Category: 'LOBBY ARENA', Status: 2,
              Reason: 'Technical Issues', Comments: 'Please note that the elevator is currently out of service.', PostedDate: stamp(-30) },
            // no closure word for the rules to find; the reading says what it means
            { LocationID: 800, AssetID: '8', AssetName: 'Zed Arena - Indoor Ice Rink', Type: 'Indoor Ice Rink', DisplayAlertName: 'Skate', Category: 'ZED ARENA', Status: 2,
              Reason: 'Maintenance/Repairs', Comments: 'The Zamboni is away for repairs this week, so public skating will not run.', PostedDate: stamp(-1),
              Read: { v: 1, skating: 'off', about: 'ice', starts: dayPlus(-1), ends: null, timeFrom: null, timeTo: null, seasonal: false, by: 'claude-haiku-5-5' } });
        alerts.reader = { v: 1, by: 'claude-haiku-5-5', read: 1, rules: 6, waiting: 0, error: null };
        await app.open();

        const frostToday = card(page, 'Frost Park Rink').first(), frostLater = card(page, 'Frost Park Rink').nth(1);
        await expect(frostToday.locator('.alert-banner.warning')).toContainText('Still marked closed for the season');
        await expect(frostToday).not.toHaveClass(/has-alert-closed/);
        await expect(frostLater).toHaveClass(/has-alert-note/);
        await expect(frostLater.locator('.alert-banner.note')).toContainText('lifts it when the rink reopens');
        await expect(frostLater.locator('.program-title')).toHaveCSS('text-decoration-line', 'none');
        await expect(card(page, 'Lobby Arena').locator('.alert-banner.note')).toContainText('Building notice, skating not affected');
        await expect(card(page, 'Zed Arena')).toHaveClass(/has-alert-closed/);
        await expect(card(page, 'Zed Arena').locator('.alert-banner.closed')).toContainText('Likely cancelled');

        await page.click('#status-data');                                           // the freshness menu names the reader
        await expect(page.locator('#popover')).toContainText('Alert reading: claude-haiku-5-5');
        await page.keyboard.press('Escape');
        await app.noErrors();
    });

    test('home server down (Cloudflare error 1033): schedule, alerts and rinks come from the committed copies on the first paint, and the server gets another look later', async ({ page, context, app }) => {
        // what Cloudflare answers when the tunnel is gone: HTTP 530 with no CORS headers, so the browser fails the fetch
        const down = (route) => route.fulfill({ status: 530, contentType: 'text/plain', body: 'error code: 1033' });
        await context.route(/skate-data\.ronishbhatt\.com/, down);
        await app.open();
        await expect(card(page, 'Alpha Arena').first().locator('.alert-banner.closed')).toContainText('Likely cancelled');   // 2026-11-12: there were no alerts at all
        const state = () => page.evaluate(() => ({
            onHomeServer: !!(SkateAPI._dataBase && !SkateAPI._remoteBroken),
            alerts: !!SkateAlerts.checkedAt, liveCheck: !!SkateAlerts.liveCheckedAt, rinks: !!SkateGeo.rinkByLocation('100')
        }));
        expect(await state()).toEqual({ onHomeServer: false, alerts: true, liveCheck: true, rinks: true });
        await expect(card(page, 'Leaside Memorial').locator('.spots-badge, .live-spots, [class*="spots"]').first()).toBeVisible();   // live spots too

        // the outage ends; ten minutes on, the next alert refresh finds the home server again
        await context.unroute(/skate-data\.ronishbhatt\.com/, down);
        await page.clock.setFixedTime(new Date(new Date(NOW_ISO).getTime() + 5 * 60000));
        await page.evaluate(() => SkateAlerts.load(true));
        expect((await state()).onHomeServer).toBe(false);                            // too soon: no probe storm against a dead server
        await page.clock.setFixedTime(new Date(new Date(NOW_ISO).getTime() + 11 * 60000));
        await page.evaluate(() => SkateAlerts.load(true));
        expect(await state()).toEqual({ onHomeServer: true, alerts: true, liveCheck: true, rinks: true });
        expect(app.errors.filter(e => e.startsWith('pageerror'))).toEqual([]);      // blocked fetches log to the console; nothing may throw
    });

    test('unverified banner, price, rentals chip and live spots', async ({ page, app }) => {
        await app.open();
        const grossman = card(page, 'Pleasure Skate');
        await expect(grossman.locator('.alert-banner.unverified')).toContainText('Unverified');
        await expect(grossman.locator('.price-badge.paid')).toHaveText('$3');
        await expect(grossman.locator('.facts-badge.yes')).toContainText('Rentals $6');
        const leaside = card(page, 'Leaside Memorial');
        await expect(leaside.locator('.spots-badge')).toContainText('20/22 spots left');
        await expect(leaside.locator('.price-badge.paid')).toHaveText('$11.50');
        await app.noErrors();
    });

    test('adding a city in the sheet shows its sessions', async ({ page, app }) => {
        await app.open();
        await page.click('#btn-filters');
        await page.click('#filters-body .fchip[data-city="Mississauga"]');
        await expect(card(page, 'Paul Coffey Arena')).toHaveCount(1);
        await page.click('#btn-filters-apply');
        await expect(page.locator('#active-filters .pill.city')).toContainText(/Toronto \+ 1|Mississauga/);
        await app.noErrors();
    });

    test('calendar view renders blocks, lights today, blocks open a menu', async ({ page, app }) => {
        await app.open();
        await page.click('#btn-cal');
        await expect(page.locator('#calendar-view .cal-block').first()).toBeVisible();
        expect(await page.locator('#calendar-view .cal-block').count()).toBeGreaterThanOrEqual(5);
        await expect(page.locator('.cal-daychip.today')).toHaveCount(1);
        await page.locator('#calendar-view .cal-block').first().click();
        await expect(page.locator('#popover .popover-title')).not.toBeEmpty();
        await page.keyboard.press('Escape');
        await page.click('#btn-list');
        await expect(page.locator('.program-item').first()).toBeVisible();
        await app.noErrors();
    });

    test('a newer deployed version shows the Update bar; ↻ updates the app', async ({ page, app }) => {
        await app.open();
        await page.route(/\/skate\/\?fresh=/, async (route) => {
            const res = await route.fetch();
            const html = (await res.text()).replace(/app\.js\?v=(\d+)/, (m, n) => `app.js?v=${+n + 1}`);
            await route.fulfill({ response: res, body: html, headers: { ...res.headers(), 'content-type': 'text/html' } });
        });
        await page.evaluate(() => SkateApp.Actions.checkForUpdate({ force: true }));
        await expect(page.locator('#update-bar')).toBeVisible();
        await expect(page.locator('#update-text')).toContainText('newer version');
        await page.click('#btn-update-later');
        await expect(page.locator('#update-bar')).toBeHidden();
        await Promise.all([page.waitForEvent('load'), page.click('#btn-refresh')]);   // the stale app reloads itself
        await expect(page.locator('.program-item').first()).toBeVisible();
    });

    test.describe('service worker', () => {
        test.use({ serviceWorkers: 'allow' });
        test('registers and keeps versioned files cache-first', async ({ page, app }) => {
            await app.open();
            await page.evaluate(() => navigator.serviceWorker.ready);
            await page.reload();
            await page.waitForSelector('.program-item');
            const cached = await page.evaluate(async () => {
                const keys = await caches.keys();
                const name = keys.find(k => k.startsWith('skate-'));
                if (!name) return { name: null };
                const c = await caches.open(name);
                const app = document.querySelector('script[src*="app.js"]').src;
                return { name, app: !!(await c.match(app)), css: !!(await c.match(document.querySelector('link[href*="style-v3.css"]').href)) };
            });
            expect(cached.name).toMatch(/^skate-/);
            expect(cached.app).toBe(true);
            expect(cached.css).toBe(true);
        });
    });

    test('phone layout: nothing overflows, the search row fits, controls sit inside the viewport', async ({ page, app }, testInfo) => {
        test.skip(!isPhone(testInfo), 'phone projects only');
        await app.open();
        const m = await page.evaluate(() => {
            const r = (s) => document.querySelector(s).getBoundingClientRect();
            const inView = (b) => b.left >= 0 && b.right <= innerWidth + 0.5 && b.top >= 0;
            return {
                scrollW: document.documentElement.scrollWidth, innerW: innerWidth,
                searchRight: r('#search-input').right, filtersLeft: r('#btn-filters').left,
                topbar: ['#btn-feedback', '#btn-free', '#btn-refresh', '#btn-settings'].every(s => inView(r(s))),
                pills: inView(r('#active-filters'))
            };
        });
        expect(m.scrollW).toBeLessThanOrEqual(m.innerW + 1);
        expect(m.searchRight).toBeLessThanOrEqual(m.filtersLeft);
        expect(m.topbar).toBe(true);
        expect(m.pills).toBe(true);
        await page.click('#btn-filters');
        const sheet = await page.evaluate(() => { const b = document.querySelector('#filters-modal .modal').getBoundingClientRect(); return { top: b.top, bottom: b.bottom, h: innerHeight, footer: document.querySelector('#filters-modal .sheet-footer').getBoundingClientRect().bottom }; });
        expect(sheet.top).toBeGreaterThanOrEqual(0);
        expect(sheet.footer).toBeLessThanOrEqual(sheet.h + 0.5);
        await app.noErrors();
    });

    test.describe('install hint', () => {
        test.use({ settings: { installSeen: false } });
        test('appears on a phone browser, Not now hides it for good', async ({ page, app }, testInfo) => {
            test.skip(!isPhone(testInfo), 'phone projects only');
            await app.open();
            await expect(page.locator('#install-hint')).toBeVisible();
            await page.click('#install-hint [data-install="later"]');
            await expect(page.locator('#install-hint')).toBeHidden();
            await page.reload();
            await page.waitForSelector('.program-item');
            await expect(page.locator('#install-hint')).toBeHidden();
        });
    });
});
