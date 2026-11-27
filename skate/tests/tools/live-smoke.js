// The LIVE site with the LIVE data, headless (not part of the test suite; run by hand after a deploy):
//   node skate/tests/tools/live-smoke.js            (from the repo root)
// Checks: no page errors, the Filters numbers add up to the list, the Data status rows, searches,
// the day bar and date picker, indoor-before-outdoor order, prices without "?", the map's pins.
const { chromium, devices } = require('@playwright/test');
const URL = process.env.SITE || 'https://sunmoonron.github.io/skate/';
const problems = [];
const check = (ok, what) => { if (!ok) problems.push(what); };
async function run(device, settings, label) {
    const b = await chromium.launch();
    const ctx = await b.newContext({ ...device, locale: 'en-CA', timezoneId: 'America/Toronto' });
    await ctx.addInitScript((s) => { localStorage.setItem('skate_settings_v1', JSON.stringify(s)); }, settings);
    const p = await ctx.newPage();
    const errs = [];
    p.on('pageerror', e => errs.push('pageerror ' + e.message));
    p.on('console', m => { if (m.type() === 'error' && !/net::|Failed to load resource|WebSocket|open-meteo|tile\.openstreetmap/.test(m.text())) errs.push('console ' + m.text().slice(0, 160)); });
    await p.goto(URL + '?smoke=' + Date.now());
    await p.waitForFunction(() => window.SkateApp && SkateApp.S.programs.length > 1000, null, { timeout: 60000 });
    await p.waitForTimeout(1500);
    const out = await p.evaluate(async () => {
        const S = SkateApp.S, A = SkateApp.Actions, r = { v: SkateConfig.version };
        const wait = (ms) => new Promise(x => setTimeout(x, ms));
        const sheet = () => { A.openFilters(); const b = document.getElementById('filters-body');
            const cats = [...b.querySelectorAll('.fcat')].map(row => ({ on: row.querySelector('input').checked, n: +((row.querySelector('.fcount') || {}).textContent || 0) }));
            const cities = [...b.querySelectorAll('.fchip[data-city]')].filter(c => c.dataset.city).map(c => ({ on: c.classList.contains('active'), n: +(c.textContent.split('·')[1] || 0) }));
            A.closeFilters(); return { cats, cities, list: S.filtered.length }; };
        r.base = sheet();
        A.setCities([]); r.all = sheet();
        A.setFlag('free', true); r.free = sheet(); A.setFlag('free', false);
        A.setIce('outdoor'); r.outdoor = sheet(); A.setIce('all');
        // indoor first, then outdoor, within the first day that has both
        const out = (p) => { const k = (SkateGeo.rinkByLocation(SkateApp.P ? SkateApp.P.locKey(p) : String(p['Location ID'])) || {}).kinds || []; return k.includes('outdoor'); };
        const day = S.filtered.length ? String(S.filtered[0]['Start Date']) : '';
        const seq = S.filtered.filter(p => String(p['Start Date']) === day).map(out);
        r.order = { day, n: seq.length, outdoor: seq.filter(Boolean).length, indoorFirst: seq.lastIndexOf(false) < (seq.indexOf(true) < 0 ? Infinity : seq.indexOf(true)) };
        A.openStatus(); await wait(300);
        r.status = document.getElementById('status-body').innerText;
        document.getElementById('btn-status-close').click();
        const search = async (q) => { const i = document.getElementById('search-input'); i.value = q; i.dispatchEvent(new Event('input', { bubbles: true })); await wait(500); const n = S.filtered.length; i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); await wait(400); return n; };
        r.search = { aurora: await search('aurora'), varsity: await search('varsity'), coliseum: await search('coliseum'), iroquois: await search('iroquois') };
        r.qPrices = [...document.querySelectorAll('.price-badge, .c2-paid, .cal-price')].filter(e => e.textContent.includes('?')).length;
        r.bar = ['db-when', 'db-date', 'status-data'].map(id => document.getElementById(id).innerText.replace(/\s+/g, ' ').trim()).join(' | ');
        A.openDates(); await wait(200);
        const pop = document.getElementById('popover');
        r.picker = { days: pop.querySelectorAll('.dp-day:not([disabled]):not(.none)').length, overflow: pop.scrollWidth - pop.clientWidth };
        document.body.click();
        for (const t of ['week', 'time', 'rink', 'distance']) { try { A.setCalType(t); } catch (e) { r['cal_' + t] = String(e); } }
        return r;
    });
    await p.evaluate(() => { SkateApp.S.calMode = false; SkateApp.Render.programs(); });
    await p.click('#btn-rinks');
    await p.waitForSelector('.leaflet-marker-icon', { timeout: 30000 }).catch(() => problems.push(`${label}: map pins never appeared`));
    const pins = await p.locator('.leaflet-marker-pane .leaflet-marker-icon').count();
    await b.close();
    const sumOn = (s) => s.cats.filter(c => c.on).reduce((a, c) => a + c.n, 0);
    const sumCities = (s) => (s.cities.some(c => c.on) ? s.cities.filter(c => c.on) : s.cities).reduce((a, c) => a + c.n, 0);
    for (const [k, s] of Object.entries({ base: out.base, all: out.all, free: out.free, outdoor: out.outdoor })) {
        check(sumOn(s) === s.list, `${label} ${k}: kinds ticked add up to ${sumOn(s)}, the list has ${s.list}`);
        check(sumCities(s) === s.list, `${label} ${k}: cities add up to ${sumCities(s)}, the list has ${s.list}`);
    }
    for (const name of ['Town of Aurora', 'Town of Whitby', 'Varsity Arena', 'Ford Performance Centre', 'YZD', 'Canlan', 'Coca-Cola Coliseum']) check(out.status.includes(name), `${label}: status page has no row for ${name}`);
    check(!/undefined|NaN|\[object/.test(out.status), `${label}: status page shows undefined/NaN`);
    Object.entries(out.search).forEach(([q, n]) => check(n > 0, `${label}: searching "${q}" finds nothing`));
    check(!out.qPrices, `${label}: ${out.qPrices} prices read "?"`);
    check(out.picker.days > 0 && out.picker.overflow <= 0, `${label}: date picker ${JSON.stringify(out.picker)}`);
    check(out.order.indoorFirst, `${label}: ${out.order.day} is not indoor first, then outdoor`);
    check(pins > 150, `${label}: only ${pins} pins on the map`);
    Object.keys(out).filter(k => k.startsWith('cal_')).forEach(k => problems.push(`${label}: ${k} ${out[k]}`));
    errs.forEach(e => problems.push(`${label}: ${e}`));
    console.log(label, `v${out.v}`, JSON.stringify({ base: out.base.list, all: out.all.list, free: out.free.list, outdoor: out.outdoor.list, firstDay: out.order, search: out.search, pins }), '| bar:', out.bar);
}
(async () => {
    const fresh = { setupDone: true, tourDone: true, heartHintDone: true, installSeen: true, lastSeenVersion: '99', showGuides: false, showChats: false, cities: ['Toronto'], typeSel: { leisure: 'all', figure: 'all', hockey: 'all', other: 'all', adapted: 'all', ringette: 'all', speed: 'all' } };
    await run(devices['Desktop Chrome'], fresh, 'desktop');
    await run(devices['Pixel 7'], { ...fresh, theme: 'dark' }, 'phone');
    console.log(problems.length ? 'PROBLEMS:\n- ' + problems.join('\n- ') : 'no problems found');
})();
