// v3.22: the weather recovers from a failed request (a 429 above all): the last good reading is kept and
// shown for up to three hours, and the next try waits instead of asking again every minute.
const { test, expect, NOW_ISO } = require('./fixtures');

const NOW = Date.parse(NOW_ISO);
const kept = (minsAgo, temp = -4) => JSON.stringify({ spot: '43.742,-79.373', current: { temp, feels: temp - 5, code: 71, label: 'Toronto', at: NOW - minsAgo * 60000 } });
const seed = (page, value) => page.addInitScript((v) => { if (!sessionStorage.getItem('wx-seeded')) { sessionStorage.setItem('wx-seeded', '1'); localStorage.setItem('skate_weather_v1', v); } }, value);

test('a 429 at start: the reading kept from 50 minutes ago shows (with its time), and it does not ask again each minute', async ({ page, app }) => {
    let calls = 0;
    await page.route('https://api.open-meteo.com/**', (route) => { calls++; return route.fulfill({ status: 429, headers: { 'Retry-After': '600', 'access-control-allow-origin': '*', 'access-control-expose-headers': 'Retry-After' }, body: '{"error":true,"reason":"Too many requests"}' }); });
    await seed(page, kept(50));
    await app.open();
    const chip = page.locator('#weather-chip');
    await expect(chip).toBeVisible();
    await expect(chip).toContainText('-4°');
    await expect(chip).toHaveAttribute('title', /As of 12:10/);
    await expect.poll(() => calls).toBe(1);
    for (let i = 0; i < 5; i++) await page.evaluate(() => SkateWeather.load());
    expect(calls).toBe(1);                                                                // waiting, as the server asked (10 minutes)
    expect(await page.evaluate(() => SkateWeather.nextTryAt - Date.now())).toBeGreaterThan(9 * 60000);
});

test('a reading from four hours ago is not shown; one from ten minutes ago needs no request at all', async ({ page, app }) => {
    let calls = 0;
    await page.route('https://api.open-meteo.com/**', (route) => { calls++; return route.fulfill({ status: 429, headers: { 'access-control-allow-origin': '*' }, body: '{}' }); });
    await seed(page, kept(240));
    await app.open();
    await expect.poll(() => calls).toBe(1);
    await expect(page.locator('#weather-chip')).toBeHidden();
    expect(await page.evaluate(() => SkateWeather.nextTryAt - Date.now())).toBeGreaterThan(100000);   // no Retry-After: two minutes first
    await page.evaluate((v) => { localStorage.setItem('skate_weather_v1', v); sessionStorage.setItem('wx-seeded', '1'); }, kept(10, 2));
    calls = 0;
    await page.reload();
    await page.waitForSelector('.program-item');
    await expect(page.locator('#weather-chip')).toContainText('2°');
    expect(calls).toBe(0);
});

test('a good answer is kept on the device for the next time', async ({ page, app }) => {
    await page.route('https://api.open-meteo.com/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({ current: { temperature_2m: -7.6, apparent_temperature: -13.2, weather_code: 3 } }) }));
    await app.open();
    await expect(page.locator('#weather-chip')).toContainText('-8°');
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('skate_weather_v1')));
    expect(saved).toMatchObject({ spot: '43.742,-79.373', current: { temp: -8, feels: -13, code: 3 } });
});
