// v3.17: one job per colour, in light and dark (each test runs in both themes): every label on a
// card readable at WCAG AA (4.5:1), age chips neutral, titles in the text colour, no emoji pin,
// and the kinds' tags in soft colours of their own.
const { test, expect, row, dayPlus } = require('./fixtures');

const RATIO = (el) => {
    // rgb(…) is 0–255; color(srgb …), which color-mix() gives, is 0–1
    const parse = (c) => { const m = (c.match(/[\d.]+/g) || [0, 0, 0, 0]).map(Number); const v = m.length > 3 ? m : [...m, 1]; return c.startsWith('color(') ? [v[0] * 255, v[1] * 255, v[2] * 255, v[3]] : v; };
    const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    let bg = [255, 255, 255, 1];
    for (let e = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c[3] > 0.5) { bg = c; break; } }
    const a = lum(parse(getComputedStyle(el).color)), b = lum(bg);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};

test.describe('colours', () => {
    test.use({ settings: { typeSel: { leisure: 'all', figure: 'all', hockey: 'all', other: 'all', adapted: 'all', ringette: 'all', speed: 'all' } } });
    test('every label on a card is readable, age chips are neutral, titles are text-coloured, no emoji pin', async ({ page, app }) => {
        const programs = app.data['skating-programs.json'].programs;
        ['Shinny', 'Ringette (drop-in)', 'Speed Skating', 'Adapted Skating', 'Ice Breakdancing', 'Figure Skating: Adult'].forEach((activity, i) =>
            programs.push(row({ id: `c${i}`, loc: 100, rink: 'Alpha Arena', activity, date: dayPlus(1), start: `1${i}:00`, end: `1${i}:50`, ageMin: i === 5 ? 18 : null })));
        await app.open();
        await expect(page.locator('.program-item .tag').first()).toBeVisible();
        const worst = await page.evaluate((fn) => {
            const ratio = new Function(`return (${fn})`)();
            const out = {};
            for (const sel of ['.program-item .tag', '.program-item .age-badge', '.program-item .program-title', '.program-item .price-badge', '.program-item .where-link', '#active-filters .pill:not(.k-mix)', '#day-bar .db-btn']) {
                const els = [...document.querySelectorAll(sel)].filter(e => e.offsetParent);
                if (els.length) out[sel] = Math.min(...els.map(ratio));
            }
            return out;
        }, RATIO.toString());
        for (const [sel, r] of Object.entries(worst)) expect(r, `${sel} contrast`).toBeGreaterThanOrEqual(4.5);
        expect(Object.keys(worst).length).toBeGreaterThanOrEqual(6);
        // age chips have no hue of their own; titles are the text colour; the pin is a plain icon
        const chip = await page.locator('.program-item .age-badge').first().evaluate(e => getComputedStyle(e).color.match(/\d+/g).map(Number));
        expect(Math.max(...chip) - Math.min(...chip)).toBeLessThan(40);
        const [title, text] = await page.evaluate(() => [getComputedStyle(document.querySelector('.program-item .program-title')).color, getComputedStyle(document.body).color]);
        expect(title).toBe(text);
        expect(await page.locator('.program-item .where-link').first().textContent()).not.toContain('📍');
        await expect(page.locator('.program-item .where-link svg.pin').first()).toBeVisible();
        await app.noErrors();
    });
});
