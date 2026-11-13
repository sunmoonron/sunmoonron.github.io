// Free skates (v3.11): the City's lending van and the other free options from
// lending.json, as they show on sessions, day headings, rink rows and the
// Free skates page.
const { test, expect, dayPlus } = require('./fixtures');

const van = (extra) => Object.assign({
    name: 'Skate Lending Library', by: 'City of Toronto, with Desjardins', url: 'https://www.toronto.ca/explore-enjoy/x/skate-lending-library/',
    lends: 'skates, helmets and skating aids', terms: 'Free for all ages. No reservation: find the van at the rink.',
    status: 'soon', startsOn: dayPlus(27), modified: dayPlus(-30), stops: []
}, extra);
const also = () => [
    { id: 'weekly', place: 'Harbour Rink', address: '235 Queens Quay W', what: 'Free skate rentals every week, while quantities last', days: [new Date(dayPlus(1) + 'T12:00:00Z').getUTCDay()], start: dayPlus(-3), end: dayPlus(60), url: 'https://example.org/harbour', checked: dayPlus(0) },
    { id: 'hub', place: 'Skate Hub', address: '340 Chaplin Cres', what: 'Free skates to take', rink: '3489', start: dayPlus(-10), end: dayPlus(90), url: 'https://example.org/hub', checked: dayPlus(0) },
    { id: 'over', place: 'Last Winter Rink', what: 'Ended', start: dayPlus(-90), end: dayPlus(-1), url: 'https://example.org/over', checked: dayPlus(-90) }
];
const row = (page, text) => page.locator('.program-item', { hasText: text });

test.describe('free skates', () => {
    test('without the file nothing changes, and the page says so plainly', async ({ page, app }) => {
        await app.open();
        await expect(page.locator('.facts-badge.lend')).toHaveCount(0);
        await expect(page.locator('.day-lend')).toHaveCount(0);
        await page.click('#btn-rinks');
        await page.click('#btn-lending');
        await expect(page.locator('#lending-modal')).toBeVisible();
        await expect(page.locator('#lending-body')).toContainText('could not be loaded');
        await app.noErrors();
    });

    test('before the season: the start date, a plain "not posted yet", and the other free options', async ({ page, app }) => {
        app.data['lending.json'] = { generatedAt: app.NOW_ISO, checkedAt: app.NOW_ISO, van: van(), also: also() };
        await app.open();
        await expect(page.locator('.facts-badge.lend', { hasText: /\d/ })).toHaveCount(0);       // no van hours on any session
        await page.click('#btn-rinks');
        await page.click('#btn-lending');
        const body = page.locator('#lending-body');
        await expect(body).toContainText('free skates, helmets and skating aids');
        await expect(body.locator('.lend-note')).toContainText('The van starts on');
        await expect(body.locator('.lend-note')).toContainText('has not posted this winter\'s stops yet');
        await expect(body.locator('.lend-list:not(.also) li')).toHaveCount(0);
        await expect(body.locator('.lend-list.also li')).toHaveCount(2);                          // the one whose season is over is gone
        await expect(body.locator('.lend-list.also')).toContainText('Harbour Rink');
        await expect(body.locator('.lend-list.also')).not.toContainText('Last Winter Rink');
        await expect(body.locator('.lend-source a')).toHaveAttribute('href', /skate-lending-library/);
        await expect(body.locator('.lend-source a')).toHaveAttribute('rel', /noopener/);
        await page.click('#btn-lending-close');
        await expect(page.locator('#lending-modal')).toBeHidden();
        await app.noErrors();
    });

    test('in season: a chip on the sessions the van overlaps, a line under the day, the rink\'s next visit', async ({ page, app }) => {
        const T = dayPlus(0), T1 = dayPlus(1), T3 = dayPlus(3);
        app.data['lending.json'] = { generatedAt: app.NOW_ISO, checkedAt: app.NOW_ISO, also: also(), van: van({ status: 'scheduled', stops: [
            { date: T, from: '12:00', to: '18:00', id: '200', rink: '200', place: 'Beta Park <b>outdoor</b> rink', address: '2 Beta Ave.' },
            { date: T3, from: '16:00', to: '20:00', id: '100', rink: '100', place: 'Alpha Arena', address: '1 Alpha St.' },
            { date: dayPlus(-2), from: '12:00', to: '18:00', id: '300', rink: '300', place: 'Warning Arena', address: '3 Gamma Rd.' },
            { date: T1, from: '10:00', to: '16:00', id: '999', rink: null, place: 'A park this app does not list', address: '9 Nowhere Rd.' }
        ] }) };
        await app.open();
        // the van is at Beta Park 12–6 today: its 12:30 session says so, with the hours
        const beta = row(page, 'Beta Park Rink');
        await expect(beta.locator('.facts-badge.lend')).toHaveText('⛸ Free skates 12–6 PM');
        // same rink, three days on, 4–8 PM: the 9–10 AM session there is NOT during the visit
        await expect(row(page, 'Leisure Skate: Adult').locator('.facts-badge.lend')).toHaveCount(0);
        // a rink with a standing free option, any day
        await expect(row(page, 'Larry Grossman').locator('.facts-badge.lend')).toHaveText('⛸ Free skates');
        // under today's heading: where the van is (escaped as text, not markup)
        const today = page.locator('.day-head.today .day-lend');
        await expect(today).toContainText('Free skates: Beta Park <b>outdoor</b> rink 12–6 PM');
        expect(await page.locator('.day-head b').count()).toBe(0);
        // tomorrow: the stop at a place the app does not list still shows under the day, with the weekly option
        const tomorrow = page.locator('.day-head', { hasText: 'Tomorrow' }).locator('.day-lend');
        await expect(tomorrow).toContainText('A park this app does not list 10 AM–4 PM');
        await expect(tomorrow).toContainText('Harbour Rink');
        // the chip opens the Free skates page and leaves the session card alone
        await beta.locator('.facts-badge.lend').click();
        const body = page.locator('#lending-body');
        await expect(page.locator('#lending-modal')).toBeVisible();
        await expect(body.locator('.lend-list:not(.also) li')).toHaveCount(3);                    // the visit two days ago is not listed
        await expect(body.locator('.lend-list:not(.also) li').first()).toHaveClass(/today/);
        await expect(body.locator('.lend-list:not(.also) li').first()).toContainText('Today · 12–6 PM');
        await expect(body.locator('.lend-list:not(.also) li').first()).toContainText('2 Beta Ave.');
        await expect(page.locator('.modal-overlay:not(.hidden)')).toHaveCount(1);
        await page.click('#btn-lending-close');
        // Rinks & map: each rink's next visit, in words
        await page.click('#btn-rinks');
        await expect(page.locator('#rinks-list .rink-row', { hasText: 'Beta Park Rink' }).locator('.rink-meta')).toContainText('Free skates today, 12–6 PM');
        await expect(page.locator('#rinks-list .rink-row', { hasText: 'Alpha Arena' }).locator('.rink-meta')).toContainText(/Free skates \w{3}\.?,? \w{3}\.? \d+, 4–8 PM/);
        await expect(page.locator('#rinks-list .rink-row', { hasText: 'Warning Arena' }).locator('.rink-meta')).not.toContainText('Free skates');
        await expect(page.locator('#rinks-list .rink-row', { hasText: 'Grossman' }).locator('.rink-meta')).toContainText('Free skates to borrow');
        await app.noErrors();
    });

    test('hours follow the 24-hour setting', async ({ page, app }) => {
        app.data['lending.json'] = { generatedAt: app.NOW_ISO, checkedAt: app.NOW_ISO, also: [], van: van({ status: 'scheduled', stops: [{ date: dayPlus(0), from: '12:00', to: '18:00', id: '200', rink: '200', place: 'Beta Park Rink', address: '2 Beta Ave.' }] }) };
        await page.addInitScript(() => { const s = JSON.parse(localStorage.getItem('skate_settings_v1') || '{}'); s.timeFormat = '24h'; localStorage.setItem('skate_settings_v1', JSON.stringify(s)); });
        await app.open();
        await expect(row(page, 'Beta Park Rink').locator('.facts-badge.lend')).toHaveText('⛸ Free skates 12:00–18:00');
        await expect(page.locator('.day-head.today .day-lend')).toContainText('12:00–18:00');
    });

    test('a malformed file is ignored, not fatal', async ({ page, app }) => {
        app.data['lending.json'] = { van: { stops: [{ date: 'soon', from: 'noon', to: 'late', rink: '200' }, null, { date: dayPlus(0) }] }, also: 'nonsense' };
        await app.open();
        await expect(page.locator('.facts-badge.lend')).toHaveCount(0);
        await expect(page.locator('.day-lend')).toHaveCount(0);
        await page.click('#btn-rinks');
        await page.click('#btn-lending');
        await expect(page.locator('#lending-body')).toContainText('No upcoming stops');
        await app.noErrors();
    });
});
