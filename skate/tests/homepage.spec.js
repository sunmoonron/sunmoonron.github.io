// The homepage (/): "Nostr Orbit", a timeline of what a few Nostr accounts posted.
//
// Everything it shows comes from relays, from localStorage and from its two input
// boxes, and it shares its origin with /skate, whose localStorage holds secret keys.
// So most of this file feeds it hostile versions of all three and checks that they
// end up as text or are dropped, and that no script from outside ever runs
// (window.__xss stays undefined). Two layers are checked separately:
//
//   1. the script itself (assets/js/app.refactored.js builds the page with DOM calls
//      and validates at the door): the hostile-input tests run a second time with
//      the Content-Security-Policy taken out of the page;
//   2. the CSP in index.html: markup planted by the test must not run.
//
// Hermetic: every relay is a mocked socket and any request that would leave the test
// server is answered here. This file does not use fixtures.js (that is the skate app's).
const { test, expect } = require('@playwright/test');

// Three fixed columns (280px | 1fr | 350px) that do not fold: in a phone-sized window the
// middle column has no width at all. The phone projects therefore run these checks in a
// desktop-sized window as well; what they add is the mobile browser profile.
test.use({ viewport: { width: 1280, height: 800 } });

// The five accounts every first-time visitor gets, in list order: the key their npub
// stands for, how the card abbreviates the npub, and the name the mocked relays give them.
const USERS = [
    { pk: '82341f882b6eabcd2ba7f1ef90aad961cf074af15b9ef44a09f9d2a8fbfbe6a2', shown: 'npub1sg6plzp...f63m', name: 'Alice' },
    { pk: 'eab0e756d32b80bcd464f3d844b8040303075a13eabc3599a762c9ac7ab91f4f', shown: 'npub1a2cww4k...w83a', name: 'Bob' },
    { pk: '3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d', shown: 'npub180cvv07...h6w6', name: 'Carol' },
    { pk: '460c25e682fda7832b52d1f22d3d22b3176d972f60dcdc3212ed8c92ef85065c', shown: 'npub1gcxzte5...nj5z', name: 'Dave' },
    { pk: '04c915daefee38317fa734444acee390a8269fe5810b2241e5e6dd343dfbecc9', shown: 'npub1qny3tkh...95gx', name: 'Erin' }
];
const [ALICE, BOB, CAROL] = USERS;
const RELAYS = ['relay.damus.io', 'nos.lol', 'relay.snort.social', 'relay.primal.net', 'nostr.wine'];
const STRANGER = 'ab'.repeat(32);                   // a well-formed key that is in nobody's list
const HOUR = 3600;
const SIG = 'f'.repeat(128);
const hex = (n) => n.toString(16).padStart(64, '0');    // a well-formed event id
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const OK_PICTURE = 'https://pics.test/ok.png';

/** A well-formed kind-1 event, `ago` seconds before the end of the range the page asked for. */
const note = (filter, pk, n, ago, content, tags = []) => ({ id: hex(n), pubkey: pk, kind: 1, created_at: filter.until - ago, tags, content, sig: SIG });

/** What Alice posted: two posts and a reply to herself today, one post 18 hours ago, one 40 hours ago. */
const aliceNotes = (f) => [
    note(f, ALICE.pk, 1, 1 * HOUR, 'gm'),
    note(f, ALICE.pk, 2, 3 * HOUR, 'a longer thought'),
    note(f, ALICE.pk, 3, 2 * HOUR, 'replying to myself', [['e', hex(2), '', 'reply'], ['p', STRANGER]]),
    note(f, ALICE.pk, 4, 18 * HOUR, 'yesterday evening'),
    note(f, ALICE.pk, 5, 40 * HOUR, 'the day before')
];

/**
 * The world around one test. Every relay is a mocked socket: it answers a REQ from
 * `profiles` (kind 0), `notes` (kind 1, only what falls in the asked range, as a relay
 * would) and `follows` (kind 3), then whatever `extra` returns, sent as it is, then EOSE.
 * Requests that would leave the test server are answered here and listed in `outside`.
 * `problems` collects page errors, console errors and files that failed or were missing.
 */
async function setup({ page, context, baseURL }, { csp = true, storage = null } = {}) {
    const origin = new URL(baseURL).origin;
    const w = {
        profiles: new Map(USERS.map(u => [u.pk, { name: u.name }])),   // pubkey -> content (an object, or a string sent as it is)
        notes: new Map(),                                              // pubkey -> (filter) => events
        follows: new Map(),                                            // pubkey -> tags
        extra: () => [],                                               // (filter, sub) -> frames: strings, Buffers or values to JSON-encode
        hangUp: new Set(),                                             // relay hosts that close as soon as they are reached
        sockets: [], reqs: [], outside: [], problems: []
    };

    await context.routeWebSocket(/^wss:\/\//, (ws) => {
        const host = new URL(ws.url()).host;
        w.sockets.push(host);
        if (w.hangUp.has(host)) { ws.close(); return; }
        ws.onMessage((raw) => {
            let m;
            try { m = JSON.parse(raw); } catch { return; }
            if (m[0] !== 'REQ') return;
            const [, sub, filter] = m;
            w.reqs.push({ host, sub, filter });
            const kind = filter.kinds[0];
            const frames = [];
            const event = (e) => frames.push(['EVENT', sub, e]);
            if (kind === 0) {
                filter.authors.forEach((pk, i) => {
                    if (!w.profiles.has(pk)) return;
                    const content = w.profiles.get(pk);
                    event({ id: hex(0xa000 + i), pubkey: pk, kind: 0, created_at: 1700000000, tags: [], content: typeof content === 'string' ? content : JSON.stringify(content), sig: SIG });
                });
            } else if (kind === 1) {
                const make = w.notes.get(filter.authors[0]);
                (make ? make(filter) : []).filter(e => e.created_at >= filter.since && e.created_at <= filter.until).forEach(event);
            } else if (kind === 3 && w.follows.has(filter.authors[0])) {
                event({ id: hex(0xb000), pubkey: filter.authors[0], kind: 3, created_at: 1700000000, tags: w.follows.get(filter.authors[0]), content: '', sig: SIG });
            }
            frames.push(...w.extra(filter, sub));
            for (const frame of frames) ws.send(typeof frame === 'string' || Buffer.isBuffer(frame) ? frame : JSON.stringify(frame));
            ws.send(JSON.stringify(['EOSE', sub]));
        });
    });

    await context.route((url) => url.origin !== origin, (route) => {
        const url = route.request().url();
        w.outside.push(url);
        if (url === OK_PICTURE) return route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
        if (url === 'https://pics.test/broken.png') return route.fulfill({ status: 200, contentType: 'image/png', body: 'not a picture' });
        return route.abort();
    });

    if (!csp) {
        // the page with its policy taken out: what is left is the script's own care
        await context.route(`${origin}/`, async (route) => {
            const html = await (await route.fetch()).text();
            await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/i, '') });
        });
    }

    await context.addInitScript((entries) => {
        window.__cspViolations = [];
        document.addEventListener('securitypolicyviolation', (e) => {
            if (!/favicon/.test(e.blockedURI)) window.__cspViolations.push(`${e.effectiveDirective} ${e.blockedURI}`);
        });
        for (const [key, value] of Object.entries(entries || {})) localStorage.setItem(key, value);
    }, storage);

    const local = (url) => url.startsWith(origin) && !/favicon/.test(url);
    page.on('pageerror', (e) => w.problems.push(`page error: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error' && !/favicon/.test(m.text())) w.problems.push(`console: ${m.text()}`); });
    page.on('response', (r) => { if (r.status() >= 400 && local(r.url())) w.problems.push(`${r.status()} ${r.url()}`); });
    page.on('requestfailed', (r) => { if (local(r.url())) w.problems.push(`failed: ${r.url()}`); });

    /** Nothing went wrong, nothing from outside ran, and nothing tried to leave except the pictures the test offers. */
    w.clean = async () => {
        await page.waitForTimeout(250);     // a planted handler would need a moment to fire
        expect(await page.evaluate(() => window.__xss), 'script from outside ran').toBeUndefined();
        expect(w.problems, 'page errors, console errors, failed or missing files').toEqual([]);
        expect(await page.evaluate(() => window.__cspViolations), 'the page tripped its own CSP').toEqual([]);
        expect(w.outside.filter(u => !u.startsWith('https://pics.test/')), 'requests that would have left the test server').toEqual([]);
        expect(await page.locator('meta[http-equiv="Content-Security-Policy"]').count(), 'CSP present or removed as the test asked').toBe(csp ? 1 : 0);
    };
    return w;
}

/** A hostile-input test, run as served and again with the CSP removed, where only the script stands in the way. */
function hostile(title, body) {
    test(title, async ({ page, context, baseURL }) => body({ page, context, baseURL }, { csp: true }));
    test(`${title} (CSP removed: the script on its own)`, async ({ page, context, baseURL }) => body({ page, context, baseURL }, { csp: false }));
}

/** Open the page on a first visit and wait for the five default cards with the names the relays gave. */
async function openFresh(page, names = USERS.map(u => u.name)) {
    await page.goto('/');
    await expect(page.locator('.user-name')).toHaveText(names);
    await expect(page.locator('#relay-count')).toHaveText('5/5');
}

const card = (page, user) => page.locator(`.user-card[data-pubkey="${user.pk || user}"]`);
// A card is selected by its avatar: the (invisible until hover) remove button is stretched over most of the card
const select = (page, user) => card(page, user).locator('.user-avatar').click();
/** Every element that carries a handler attribute or a javascript: URL. */
const handlerAttributes = (page) => page.evaluate(() => [...document.querySelectorAll('*')].flatMap(el => el.getAttributeNames()
    .filter(n => /^on/i.test(n) || /^\s*javascript:/i.test(el.getAttribute(n)))
    .map(n => `<${el.tagName.toLowerCase()} ${n}>`)));
const stored = (page, key) => page.evaluate((k) => JSON.parse(localStorage.getItem(k)), key);

test.describe('homepage', () => {

    test('boots: nothing missing, no error, the default accounts and relays', async ({ page, context, baseURL }) => {
        const w = await setup({ page, context, baseURL });
        const responses = [];
        page.on('response', (r) => responses.push(`${r.status()} ${new URL(r.url()).pathname}`));
        await openFresh(page);

        await expect(page).toHaveTitle(/NOSTR ORBIT/);
        expect(responses).toEqual(expect.arrayContaining(['200 /', '200 /assets/css/style.css', '200 /assets/js/nostr.bundle.js', '200 /assets/js/app.refactored.js']));
        await expect(page.locator('.user-card')).toHaveCount(5);
        await expect(page.locator('.user-npub')).toHaveText(USERS.map(u => u.shown));
        await expect(page.locator('.user-stats')).toHaveText(USERS.map(() => '0 posts in 1D'));
        await expect(page.locator('.user-avatar')).toHaveText(USERS.map(() => '👤'));
        await expect(page.locator('.relay-chip')).toHaveText(RELAYS.map(r => r.slice(0, 15)));
        await expect(page.locator('#selected-user-info')).toHaveText('Select a user to view their 24h activity');
        await expect(page.locator('#stats-header')).toHaveText('📈 1D Stats');
        await expect(page.locator('#event-detail')).toContainText('Select a user to view their events');
        await expect(page.locator('#identity-name')).toHaveText('Not connected');

        // each relay was asked once, for the profiles of exactly the five default keys
        await expect.poll(() => w.reqs.length).toBe(5);
        expect(w.sockets.slice().sort()).toEqual(RELAYS.slice().sort());
        expect(w.reqs.map(r => r.host).sort()).toEqual(RELAYS.slice().sort());
        for (const r of w.reqs) expect(r).toMatchObject({ sub: 'profiles', filter: { kinds: [0], authors: USERS.map(u => u.pk) } });

        // nothing is hung on window for markup to call any more
        expect(await page.evaluate(() => ['S', 'selectUser', 'removeUser', 'toggleRelay', 'renderEventFeed', 'addUserFromInput'].filter(k => k in window))).toEqual([]);
        await w.clean();
    });

    test('the CSP is in place, nothing carries a handler attribute, and the CSP alone stops planted script', async ({ page, context, baseURL }) => {
        const w = await setup({ page, context, baseURL });
        w.notes.set(ALICE.pk, aliceNotes);
        const response = await page.goto('/');
        const html = await response.text();

        // the policy, ahead of anything it has to govern
        const meta = page.locator('head > meta[http-equiv="Content-Security-Policy"]');
        await expect(meta, 'index.html carries the CSP in a meta tag').toHaveCount(1);
        const policy = await meta.getAttribute('content');
        const directives = Object.fromEntries(policy.split(';').map(d => d.trim().split(/\s+/)).filter(d => d[0]).map(([name, ...values]) => [name, values]));
        expect(directives['default-src']).toEqual(["'none'"]);
        expect(directives['script-src']).toEqual(["'self'"]);
        expect(directives['base-uri']).toEqual(["'none'"]);
        expect(directives['form-action']).toEqual(["'none'"]);
        expect(directives['style-src']).toContain("'self'");
        expect(directives['img-src']).toContain('https:');
        expect(directives['connect-src']).toContain('wss:');
        for (const name of ['img-src', 'connect-src']) for (const loose of ['*', 'http:', 'ws:', "'unsafe-inline'"]) expect(directives[name]).not.toContain(loose);
        for (const name of ['object-src', 'script-src-elem', 'script-src-attr']) expect(directives[name], `${name} is left to the stricter fallback`).toBeUndefined();
        expect(html.indexOf('Content-Security-Policy')).toBeGreaterThan(0);
        expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.search(/<(link|script|style)\b/i));

        // no handler attribute in the file ...
        expect(html.match(/ on[a-z]*="/g), 'grep " on...=" in index.html').toBeNull();
        expect(html.match(/\son[a-z]+\s*=/gi)).toBeNull();
        expect(html).not.toMatch(/javascript:/i);
        // ... and none in the page once the script has drawn everything it draws
        await expect(page.locator('.user-name')).toHaveText(USERS.map(u => u.name));
        await select(page, ALICE);
        await expect(page.locator('#event-detail .event-card')).toHaveCount(4);
        await page.locator('#compare-toggle').click();
        await card(page, BOB).locator('.user-compare-btn').click();
        await expect(page.locator('#compare-nodes .empty-state')).toHaveText('📭No events');
        await page.locator('#event-detail .event-card').first().click();
        await expect(page.getByRole('button', { name: '← Back to Feed' })).toBeVisible();
        await page.locator('#relay-toggle-btn').click();
        await expect(page.locator('.relay-item')).toHaveCount(5);
        expect(await handlerAttributes(page)).toEqual([]);
        expect(await page.locator('script').count()).toBe(2);

        // a tripwire, not a proof: the script has no HTML-string sink and no way to build code from text
        const source = await (await page.request.get('/assets/js/app.refactored.js')).text();
        expect(source).not.toMatch(/\.innerHTML\s*\+?=|\.outerHTML\s*\+?=|insertAdjacentHTML|document\.write|\.setAttribute\(\s*['"`]on|\beval\s*\(|new Function|\.srcdoc\b|DOMParser|createContextualFragment/);
        await w.clean();

        // layer 2 on its own: markup that somehow got in does not run
        await page.evaluate(() => {
            const box = document.createElement('div');
            box.id = 'planted';
            box.innerHTML = '<img src="data:image/png;base64,AAAA" onerror="window.__xss = \'onerror\'"><button onclick="window.__xss = \'onclick\'">x</button><a href="javascript:window.__xss = \'href\'">y</a>';
            document.body.append(box);
            const script = document.createElement('script');
            script.textContent = 'window.__xss = "inline script"';
            document.body.append(script);
            box.querySelector('button').click();
            box.querySelector('a').click();
        });
        await expect.poll(() => page.evaluate(() => window.__cspViolations.map(v => v.split(' ')[0]).sort().join(' '))).toMatch(/script-src-attr.*script-src-elem/);
        await page.waitForTimeout(250);
        expect(await page.evaluate(() => window.__xss), 'planted script ran in spite of the CSP').toBeUndefined();
        expect(w.problems.filter(p => !/Content Security Policy/.test(p))).toEqual([]);
    });

    hostile('a hostile profile is shown as text, and its picture is used only if it is https', async ({ page, context, baseURL }, { csp }) => {
        const w = await setup({ page, context, baseURL }, { csp });
        const NAME = '<img src=x onerror="window.__xss=1">';
        w.profiles = new Map([
            [USERS[0].pk, { name: NAME, picture: 'x" onerror="window.__xss=2' }],
            [USERS[1].pk, { name: 'Mallory', picture: 'javascript:window.__xss=3' }],
            [USERS[2].pk, { name: { toString: 'x' }, display_name: '"><script>window.__xss=4</script>\'`', picture: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" onload="window.__xss=5"/>' }],
            [USERS[3].pk, { name: `  Dave\n\t${'x'.repeat(5000)}`, picture: OK_PICTURE }],
            [USERS[4].pk, '["<img src=x onerror=window.__xss=6>"]']                      // JSON, but not a profile object
        ]);
        const names = [NAME, 'Mallory', '"><script>window.__xss=4</script>\'`', `Dave ${'x'.repeat(59)}`, 'Loading...'];
        await openFresh(page, names);

        // the names are text nodes; the only element anywhere in a name or an avatar is the one https picture
        await expect(page.locator('#user-list img')).toHaveCount(1);
        await expect(card(page, USERS[3]).locator('.user-avatar img')).toHaveJSProperty('src', OK_PICTURE);
        await expect(card(page, USERS[3]).locator('.user-avatar img')).toHaveJSProperty('complete', true);
        expect(await page.evaluate(() => [...new Set([...document.querySelectorAll('#user-list *')].map(e => e.tagName))].sort())).toEqual(['BUTTON', 'DIV', 'IMG']);
        expect(await page.locator('.user-name > *').count()).toBe(0);
        await expect(page.locator('.user-avatar').first()).toHaveText('👤');
        expect(await handlerAttributes(page)).toEqual([]);
        expect([...new Set(w.outside)]).toEqual([OK_PICTURE]);      // none of the other "pictures" was ever asked for

        // the same names in the other places a name goes
        w.notes.set(USERS[0].pk, (f) => [note(f, USERS[0].pk, 1, HOUR, 'hello')]);
        w.notes.set(USERS[2].pk, (f) => [note(f, USERS[2].pk, 2, HOUR, 'hello too')]);
        await select(page, USERS[0]);
        await expect(page.locator('#selected-user-info')).toHaveText(`${NAME} — 1 events in 1D`);
        await page.locator('#event-detail .event-card').click();
        await expect(page.locator('#event-detail h3')).toHaveText(`📝 ${NAME}'s Event`);
        await page.locator('#compare-toggle').click();
        await card(page, USERS[2]).locator('.user-compare-btn').click();
        await expect(page.locator('#compare-user-info')).toHaveText('"><script>window.__xss=4</script>\'` — 1 events');
        await expect(page.locator('#compare-name1')).toHaveText(NAME.slice(0, 8));
        await expect(page.locator('#compare-name2')).toHaveText('"><scrip');
        expect(await page.locator('#app img').count()).toBe(1);
        expect(await page.locator('script').count()).toBe(2);

        // and what was kept for the next visit is the cleaned version
        const kept = await stored(page, 'nostr_orbit_users');
        expect(kept.map(u => u.name)).toEqual([NAME, 'Mallory', '"><script>window.__xss=4</script>\'`', `Dave ${'x'.repeat(59)}`, null]);
        expect(kept.map(u => u.picture)).toEqual([null, null, null, OK_PICTURE, null]);
        await w.clean();
    });

    hostile('hostile notes are shown as text or dropped', async ({ page, context, baseURL }, { csp }) => {
        const w = await setup({ page, context, baseURL }, { csp });
        const BODY = '<script>window.__xss=7</script><img src=x onerror="window.__xss=8"> & "quotes" \'`';
        const MARKUP = '"><img src=x onerror=window.__xss=9>';
        w.notes.set(ALICE.pk, (f) => [
            note(f, ALICE.pk, 1, 1 * HOUR, BODY),
            note(f, ALICE.pk, 2, 2 * HOUR, 'a reply whose parent is not an id', [['e', MARKUP, '', 'reply'], ['p', MARKUP]]),
            // two notes that each claim the other as parent: following the thread must not loop for ever
            note(f, ALICE.pk, 3, 5 * HOUR, 'loop a', [['e', hex(4), '', 'reply']]),
            note(f, ALICE.pk, 4, 7 * HOUR, 'loop b', [['e', hex(3), '', 'reply']])
        ]);
        w.extra = (f, sub) => f.kinds[0] !== 1 ? [] : [
            ['EVENT', sub, { ...note(f, ALICE.pk, 20, HOUR, 'id is markup'), id: MARKUP }],
            ['EVENT', sub, { ...note(f, ALICE.pk, 21, HOUR, 'id is upper case'), id: 'A'.repeat(64) }],
            ['EVENT', sub, { ...note(f, ALICE.pk, 22, HOUR, 'id is short'), id: 'abc123' }],
            ['EVENT', sub, note(f, STRANGER, 23, HOUR, 'somebody else wrote this')],
            ['EVENT', sub, { ...note(f, ALICE.pk, 24, HOUR, 'author is markup'), pubkey: MARKUP }],
            ['EVENT', sub, { ...note(f, ALICE.pk, 25, HOUR, 'wrong kind'), kind: 0 }],
            ['EVENT', sub, { ...note(f, ALICE.pk, 26, HOUR, 'kind is text'), kind: '1' }],
            ['EVENT', sub, { ...note(f, ALICE.pk, 27, HOUR, 'time is text'), created_at: String(f.until - HOUR) }],
            `["EVENT",${JSON.stringify(sub)},{"id":"${hex(28)}","pubkey":"${ALICE.pk}","kind":1,"created_at":1e999,"tags":[],"content":"time is infinite","sig":"${SIG}"}]`,
            ['EVENT', sub, note(f, ALICE.pk, 29, 100 * HOUR, 'older than what was asked for')],
            ['EVENT', sub, note(f, ALICE.pk, 30, -5 * HOUR, 'from the future')],
            ['EVENT', sub, { ...note(f, ALICE.pk, 31, HOUR, ''), content: { html: MARKUP } }],
            ['EVENT', sub, { ...note(f, ALICE.pk, 32, HOUR, 'tags is text'), tags: MARKUP }],
            ['EVENT', sub, { ...note(f, ALICE.pk, 33, HOUR, 'a tag is not a list'), tags: [MARKUP] }],
            ['EVENT', sub, { ...note(f, ALICE.pk, 34, HOUR, 'a tag holds an object'), tags: [['e', { id: hex(1) }]] }],
            ['EVENT', sub, null],
            ['EVENT', sub, MARKUP],
            ['EVENT', sub, [note(f, ALICE.pk, 35, HOUR, 'an event in a list')]],
            ['EVENT', 'some-other-subscription', note(f, ALICE.pk, 36, HOUR, 'not for this subscription')],
            ['NOTICE', MARKUP],
            { not: 'a list' },
            'not json at all <img src=x onerror=window.__xss=10>',
            Buffer.from('a binary frame')
        ];
        await openFresh(page);
        await select(page, ALICE);

        // four notes survive, newest first; the body is text, markup and all
        const cards = page.locator('#event-detail .event-card');
        await expect(cards).toHaveCount(4);
        await expect(page.locator('#selected-user-info')).toHaveText('Alice — 4 events in 1D');
        await expect(page.locator('#event-detail .event-content')).toHaveText([BODY, 'a reply whose parent is not an id', 'loop a', 'loop b']);
        await expect(page.locator('#event-detail h3')).toHaveText('📝 Event Feed (4)');
        expect(await page.locator('#event-detail script, #event-detail img, #event-detail a').count()).toBe(0);
        await expect(cards.nth(0).locator('.event-meta')).toHaveText(`ID: ${hex(1).slice(0, 8)}...`);
        // the reply with a parent that is no id is still a reply, with one mention and no "Reply to" line
        await expect(cards.nth(1)).toHaveClass(/\breply\b/);
        await expect(cards.nth(1).locator('.event-meta')).toHaveText(/1 mentions/);
        await expect(cards.nth(1).locator('.thread-info')).toHaveCount(0);
        await expect(cards.nth(2).locator('.thread-info')).toHaveText(`↩️Reply to ${hex(4).slice(0, 8)}...• In view`);
        await expect(page.locator('#stat-total')).toHaveText('4');
        await expect(page.locator('#stat-posts')).toHaveText('1');
        await expect(page.locator('#stat-replies')).toHaveText('3');
        await expect(card(page, ALICE).locator('.user-stats')).toHaveText('4 posts in 1D');
        await expect(page.locator('#event-nodes .event-node')).toHaveCount(4);
        expect(await page.locator('#event-nodes .event-node').evaluateAll(ns => ns.map(n => n.dataset.eventId).sort())).toEqual([hex(1), hex(2), hex(3), hex(4)]);
        await expect(page.locator(`#event-nodes .event-node[data-event-id="${hex(1)}"]`)).toHaveAttribute('title', new RegExp('<script>window\\.__xss=7</script>'));

        // opened, the whole body is still text
        await cards.nth(0).click();
        await expect(page.locator('#event-detail h3')).toHaveText("📝 Alice's Event");
        await expect(page.locator('#event-detail .event-content')).toHaveText(BODY);
        expect(await page.locator('#event-detail script, #event-detail img').count()).toBe(0);
        await page.getByRole('button', { name: '← Back to Feed' }).click();
        await expect(cards).toHaveCount(4);

        // threads on, pointer over one half of the loop: the page stays alive and both halves light up
        await page.locator('#thread-toggle').click();
        await expect(page.locator('#thread-toggle')).toHaveText('🔗 Hide (2)');
        await expect(page.locator('#connections-svg path')).toHaveCount(2);
        await page.locator(`#event-nodes .event-node[data-event-id="${hex(3)}"]`).hover({ timeout: 10000 });
        await expect(page.locator('#connections-svg path.highlighted')).toHaveCount(2);
        expect(await handlerAttributes(page)).toEqual([]);
        await w.clean();
    });

    hostile('poisoned localStorage is cleaned on the way in', async ({ page, context, baseURL }, { csp }) => {
        const NAME = '<img src=x onerror="window.__xss=11">';
        const MARKUP = '"><script>window.__xss=12</script>';
        const w = await setup({ page, context, baseURL }, { csp, storage: {
            nostr_orbit_users: JSON.stringify([
                { pubkey: ALICE.pk, npub: 'npub1real', name: 'Stored Alice', picture: OK_PICTURE, about: MARKUP, lastActivity: 1700000000, postCount: 7 },
                { pubkey: BOB.pk, npub: '<img src=x onerror="window.__xss=13">', name: NAME, picture: 'x" onerror="window.__xss=14', lastActivity: 'yesterday', postCount: '<b>9</b>' },
                { pubkey: MARKUP, npub: MARKUP, name: 'no key' },
                { pubkey: ALICE.pk.toUpperCase(), name: 'upper-case key' },
                { pubkey: ALICE.pk, name: 'Alice again' },
                { npub: 'npub1sg6plzptd64u62a878hep2kev88swjh3tw00gjsfl8f237lmu63q0uf63m', name: 'npub but no key' },
                null, 7, 'text', [], [ALICE.pk]
            ]),
            nostr_orbit_relays: JSON.stringify([
                { url: 'wss://good.example', enabled: true },
                { url: 'wss://off.example/nostr', enabled: false },
                { url: 'wss://good.example/' },
                { url: 'javascript:window.__xss=15' },
                { url: 'wss://x"><img src=x onerror=window.__xss=16>' },
                { url: 'ws://plain.example' },
                { url: 'https://not-a-relay.example' },
                { url: 'good.example' },
                { url: `wss://${'a'.repeat(300)}.example` },
                { url: 42 }, null, 'wss://text.example'
            ]),
            nostr_orbit_identity: JSON.stringify({ pubkey: MARKUP, npub: '<img src=x onerror="window.__xss=17">', name: '<script>window.__xss=18</script>', picture: 'javascript:window.__xss=19' })
        } });
        await page.goto('/');

        // two users survive: their npub comes from the key, the name is text, the picture only if https
        await expect(page.locator('.user-card')).toHaveCount(2);
        await expect(page.locator('.user-name')).toHaveText(['Stored Alice', NAME]);
        await expect(page.locator('.user-npub')).toHaveText([ALICE.shown, BOB.shown]);
        await expect(page.locator('.user-stats')).toHaveText(['7 posts in 1D', '0 posts in 1D']);
        await expect(page.locator('#user-list img')).toHaveCount(1);
        await expect(card(page, ALICE).locator('img')).toHaveJSProperty('src', OK_PICTURE);
        // two relays survive, one of them switched off
        await expect(page.locator('.relay-chip')).toHaveText(['good.example']);
        await expect(page.locator('#relay-count')).toHaveText('0/1');
        await page.locator('#relay-toggle-btn').click();
        await expect(page.locator('.relay-url')).toHaveText(['good.example', 'off.example/nostr']);
        await expect(page.locator('.relay-toggle')).toHaveText(['ON', 'OFF']);
        await page.locator('#relay-manager .close-btn').click();
        // nobody is signed in
        await expect(page.locator('#identity-name')).toHaveText('Not connected');
        await expect(page.locator('#identity-logged-in')).toBeHidden();
        expect(await page.locator('#identity-panel img').count()).toBe(0);

        // storage itself now holds only what passed
        expect(await stored(page, 'nostr_orbit_users')).toEqual([
            { pubkey: ALICE.pk, npub: 'npub1sg6plzptd64u62a878hep2kev88swjh3tw00gjsfl8f237lmu63q0uf63m', name: 'Stored Alice', picture: OK_PICTURE, lastActivity: 1700000000, postCount: 7 },
            { pubkey: BOB.pk, npub: 'npub1a2cww4kn9wqte4ry70vyfwqyqvpswksna27rtxd8vty6c74era8sdcw83a', name: NAME, picture: null, lastActivity: null, postCount: 0 }
        ]);
        expect(await stored(page, 'nostr_orbit_relays')).toEqual([{ url: 'wss://good.example', enabled: true }, { url: 'wss://off.example/nostr', enabled: false }]);
        expect(await stored(page, 'nostr_orbit_identity')).toBeNull();

        // and only the relay that passed and is switched on is ever contacted
        expect(w.sockets).toEqual([]);
        await select(page, ALICE);
        await expect(page.locator('#selected-user-info')).toHaveText('Stored Alice has no events in the last 1D');
        expect(w.sockets).toEqual(['good.example']);
        expect(await handlerAttributes(page)).toEqual([]);
        await w.clean();
    });

    test('storage that is not even the right shape falls back to the defaults', async ({ page, context, baseURL }) => {
        const w = await setup({ page, context, baseURL }, { storage: {
            nostr_orbit_users: '{"pubkey": "<img src=x onerror=window.__xss=20>"',          // cut-off JSON
            nostr_orbit_relays: JSON.stringify({ url: 'wss://one.example' }),                // an object, not a list
            nostr_orbit_identity: '"<img src=x onerror=window.__xss=21>"'                    // a string, not an object
        } });
        await openFresh(page);
        await expect(page.locator('.user-npub')).toHaveText(USERS.map(u => u.shown));
        await expect(page.locator('.relay-chip')).toHaveText(RELAYS.map(r => r.slice(0, 15)));
        await expect(page.locator('#identity-name')).toHaveText('Not connected');
        expect(await stored(page, 'nostr_orbit_identity')).toBeNull();
        expect((await stored(page, 'nostr_orbit_relays')).map(r => r.url)).toEqual(RELAYS.map(r => `wss://${r}`));
        await w.clean();
    });

    hostile('the input boxes take a public key and a wss:// relay and nothing else', async ({ page, context, baseURL }, { csp }) => {
        const w = await setup({ page, context, baseURL }, { csp });
        w.profiles.set(STRANGER, { name: 'Stranger' });
        await openFresh(page);
        const toast = page.locator('#toast');
        // type into a box, press its button, and read the toast that this attempt (not an earlier one) produced
        const attempt = async (box, text, message) => {
            await page.evaluate(() => { document.getElementById('toast').textContent = ''; });
            await page.locator(`${box} input`).fill(text);
            await page.locator(`${box} button`).click();
            await expect(toast).toHaveText(message);
        };
        const addUser = (text, message) => attempt('#add-user-form', text, message);
        const addRelay = (text, message) => attempt('#add-relay-form', text, message);

        // users: markup, an npub that is not one, a secret key, a duplicate
        for (const text of ['<img src=x onerror="window.__xss=22">', 'npub1<script>window.__xss=23</script>', 'npub1sg6plzptd64u62a878hep2kev88swjh3tw00gjsfl8f237lmu63q0uf63x', 'f'.repeat(63), `${'f'.repeat(64)}"><img src=x onerror=window.__xss=24>`]) {
            await addUser(text, 'Invalid npub or pubkey');
            await expect(page.locator('#npub-input')).toHaveValue(text);
        }
        await addUser(`nsec1${'q'.repeat(58)}`, /secret key/);
        await expect(page.locator('#npub-input')).toHaveValue('');        // it does not even stay in the box
        await addUser(ALICE.pk, 'User already added');
        await expect(page.locator('.user-card')).toHaveCount(5);

        // a real key (upper-case hex is folded) is added, its profile fetched, and it can be removed again
        await addUser(STRANGER.toUpperCase(), 'User added!');
        await expect(page.locator('#npub-input')).toHaveValue('');
        await expect(page.locator('.user-name')).toHaveText([...USERS.map(u => u.name), 'Stranger']);
        await expect.poll(() => w.reqs.filter(r => r.sub.startsWith('profile-')).length).toBe(5);
        for (const r of w.reqs.filter(r => r.sub.startsWith('profile-'))) expect(r.filter).toEqual({ kinds: [0], authors: [STRANGER] });
        expect((await stored(page, 'nostr_orbit_users')).map(u => u.pubkey)).toEqual([...USERS.map(u => u.pk), STRANGER]);
        await card(page, STRANGER).locator('.user-remove').click();
        await expect(page.locator('.user-name')).toHaveText(USERS.map(u => u.name));
        expect((await stored(page, 'nostr_orbit_users')).map(u => u.pubkey)).toEqual(USERS.map(u => u.pk));

        // relays: markup, other schemes, an address, too long
        await page.locator('#relay-toggle-btn').click();
        await expect(page.locator('#relay-manager')).toBeVisible();
        for (const text of ['wss://x"><img src=x onerror=window.__xss=25>', 'javascript:window.__xss=26', 'ws://plain.example', 'https://relay.example', 'wss://user:pass@relay.example', 'wss://relay.example/#frag', `wss://${'a'.repeat(300)}.example`, "wss://relay.example/'quote'"]) {
            await addRelay(text, '⚠️ Enter a wss:// relay address');
        }
        await expect(page.locator('.relay-item')).toHaveCount(5);
        await addRelay('wss://relay.damus.io/', 'Relay already added');

        // a bare host is taken as wss://, as it always was; then switched off and on again
        await addRelay('  Relay.Example.com/inbox ', 'Relay added!');
        await expect(page.locator('#new-relay-input')).toHaveValue('');
        await expect(page.locator('.relay-url')).toHaveText([...RELAYS, 'relay.example.com/inbox']);
        await expect(page.locator('.relay-url').last()).toHaveAttribute('title', 'wss://relay.example.com/inbox');
        await expect(page.locator('.relay-chip')).toHaveText([...RELAYS.map(r => r.slice(0, 15)), 'relay.example.c']);
        await expect(page.locator('#relay-count')).toHaveText('5/6');
        const added = page.locator('.relay-item').last();
        await added.locator('.relay-toggle').click();
        await expect(added.locator('.relay-toggle')).toHaveText('OFF');
        await expect(page.locator('.relay-chip')).toHaveCount(5);
        await expect(page.locator('#relay-count')).toHaveText('5/5');
        expect(await stored(page, 'nostr_orbit_relays')).toEqual([...RELAYS.map(r => ({ url: `wss://${r}`, enabled: true })), { url: 'wss://relay.example.com/inbox', enabled: false }]);
        await added.locator('.relay-toggle').click();
        await expect(added.locator('.relay-toggle')).toHaveText('ON');
        await expect(page.locator('.relay-chip')).toHaveCount(6);

        // the new relay is asked along with the others from now on; nothing ever went to a refused address
        await page.locator('#relay-manager .close-btn').click();
        await expect(page.locator('#relay-manager')).toBeHidden();
        await select(page, ALICE);
        await expect(page.locator('#selected-user-info')).toHaveText('Alice has no events in the last 1D');
        await expect(page.locator('#relay-count')).toHaveText('6/6');
        expect([...new Set(w.sockets)].sort()).toEqual([...RELAYS, 'relay.example.com'].sort());
        // the secret key went nowhere: not into storage, not to a relay
        expect(await page.evaluate(() => JSON.stringify(Object.entries(localStorage)))).not.toContain('nsec1');
        expect(JSON.stringify(w.reqs)).not.toContain('nsec1');
        expect(await handlerAttributes(page)).toEqual([]);
        await w.clean();
    });

    test('select a user, open a note, switch the view and the time range', async ({ page, context, baseURL }) => {
        const w = await setup({ page, context, baseURL });
        w.notes.set(ALICE.pk, aliceNotes);
        await openFresh(page);

        await select(page, ALICE);
        const cards = page.locator('#event-detail .event-card');
        await expect(cards).toHaveCount(4);
        await expect(card(page, ALICE)).toHaveClass(/selected/);
        await expect(page.locator('.user-card.selected')).toHaveCount(1);
        await expect(page.locator('#selected-user-info')).toHaveText('Alice — 4 events in 1D');
        await expect(page.locator('#event-detail .event-content')).toHaveText(['gm', 'replying to myself', 'a longer thought', 'yesterday evening']);
        await expect(card(page, ALICE).locator('.user-stats')).toHaveText('4 posts in 1D');
        await expect(page.locator('#stat-total')).toHaveText('4');
        await expect(page.locator('#stat-posts')).toHaveText('3');
        await expect(page.locator('#stat-replies')).toHaveText('1');
        await expect(page.locator('#stat-threads')).toHaveText('1 visible');
        await expect(page.locator('#playback-time')).toHaveText('0 / 4');
        await expect(page.locator('#event-nodes .event-node.post')).toHaveCount(3);
        await expect(page.locator('#event-nodes .event-node.reply.has-thread')).toHaveCount(1);
        await expect.poll(() => w.reqs.filter(r => r.sub.startsWith('user-events-')).length).toBe(5);
        const asked = w.reqs.filter(r => r.sub.startsWith('user-events-'));
        expect(asked.map(r => r.host).sort()).toEqual(RELAYS.slice().sort());
        expect(asked[0].filter).toMatchObject({ kinds: [1], authors: [ALICE.pk], limit: 500 });
        expect(asked[0].filter.until - asked[0].filter.since).toBe(24 * HOUR);

        // a dot on the ring opens its note; Back returns to the feed
        await page.locator(`#event-nodes .event-node[data-event-id="${hex(4)}"]`).click();
        await expect(page.locator('#event-detail h3')).toHaveText("📝 Alice's Event");
        await expect(page.locator('#event-detail .event-content')).toHaveText('yesterday evening');
        await expect(page.locator('#event-nodes .event-node.selected')).toHaveCount(1);
        await page.getByRole('button', { name: '← Back to Feed' }).click();
        await expect(cards).toHaveCount(4);
        // so does a card in the feed
        await cards.nth(1).click();
        await expect(page.locator('#event-detail .event-content')).toHaveText('replying to myself');
        await expect(page.locator('#event-detail .thread-info')).toHaveText(`↩️Reply to ${hex(2).slice(0, 8)}...`);
        await expect(page.locator('#event-detail .event-meta')).toHaveText(`ID: ${hex(3).slice(0, 8)}...👥 1 mentions`);
        await page.getByRole('button', { name: '← Back to Feed' }).click();

        // view mode
        await page.locator('.toggle-btn[data-view="replies"]').click();
        await expect(page.locator('.toggle-btn.active')).toHaveText('Replies Only');
        await expect(page.locator('#event-detail .event-content')).toHaveText(['replying to myself']);
        await expect(page.locator('#event-nodes .event-node')).toHaveCount(1);
        await expect(page.locator('#selected-user-info')).toHaveText('Alice — 1 events in 1D');
        await page.locator('.toggle-btn[data-view="posts"]').click();
        await expect(cards).toHaveCount(3);
        await page.locator('.toggle-btn[data-view="all"]').click();
        await expect(cards).toHaveCount(4);

        // time range: the buttons, then the box
        await page.locator('.time-btn[data-hours="6"]').click();
        await expect(page.locator('.time-btn.active')).toHaveText('6h');
        await expect(cards).toHaveCount(3);
        await expect(page.locator('#selected-user-info')).toHaveText('Alice — 3 events in 6H');
        await expect(page.locator('#stats-header')).toHaveText('📈 6H Stats');
        await expect(card(page, ALICE).locator('.user-stats')).toHaveText('3 posts in 6H');
        await expect(card(page, BOB).locator('.user-stats')).toHaveText('0 posts in 6H');
        await page.locator('.time-btn[data-hours="48"]').click();
        await expect(cards).toHaveCount(5);
        await expect(page.locator('#selected-user-info')).toHaveText('Alice — 5 events in 2D');
        await page.locator('#custom-time-input').fill('36');
        await page.locator('#custom-time-input').press('Enter');
        await expect(page.locator('#toast')).toHaveText('⏱️ Showing last 1.5D');
        await expect(page.locator('.time-btn.active')).toHaveCount(0);
        await expect(cards).toHaveCount(4);
        await expect(page.locator('#selected-user-info')).toHaveText('Alice — 4 events in 1.5D');
        await page.locator('#custom-time-input').fill('9999');
        await page.locator('#custom-time-input').press('Enter');
        await expect(page.locator('#toast')).toHaveText('⚠️ Max 30 days');
        await expect(page.locator('#stats-header')).toHaveText('📈 1.5D Stats');
        await page.locator('.time-btn[data-hours="24"]').click();
        await expect(page.locator('#custom-time-input')).toHaveValue('');
        await expect(cards).toHaveCount(4);
        await expect(page.locator('#selected-user-info')).toHaveText('Alice — 4 events in 1D');

        // another user: the first one's notes are gone
        await select(page, BOB);
        await expect(page.locator('#selected-user-info')).toHaveText('Bob has no events in the last 1D');
        await expect(card(page, BOB)).toHaveClass(/selected/);
        await expect(cards).toHaveCount(0);
        await expect(page.locator('#event-nodes .event-node')).toHaveCount(0);
        await w.clean();
    });

    test('sort the list; threads, playback and compare', async ({ page, context, baseURL }) => {
        const w = await setup({ page, context, baseURL });
        w.notes.set(ALICE.pk, aliceNotes);
        w.notes.set(CAROL.pk, (f) => [
            note(f, CAROL.pk, 11, 4 * HOUR, 'carol one'),
            note(f, CAROL.pk, 12, 16 * HOUR, 'carol two', [['e', hex(11)]])
        ]);
        await openFresh(page);
        await select(page, ALICE);
        await expect(page.locator('#event-detail .event-card')).toHaveCount(4);

        // sorting
        await page.locator('.sort-btn[data-sort="name"]').click();
        await expect(page.locator('.sort-btn.active')).toHaveText('A-Z');
        await expect(page.locator('.user-name')).toHaveText(['Alice', 'Bob', 'Carol', 'Dave', 'Erin']);
        await select(page, CAROL);
        await expect(page.locator('#event-detail .event-card')).toHaveCount(2);
        await select(page, ALICE);
        await expect(page.locator('#event-detail .event-card')).toHaveCount(4);
        await page.locator('.sort-btn[data-sort="posts"]').click();
        await expect(page.locator('.user-name')).toHaveText(['Alice', 'Carol', 'Bob', 'Dave', 'Erin']);
        await page.locator('.sort-btn[data-sort="recent"]').click();
        await expect(page.locator('.sort-btn.active')).toHaveText('Recent');
        await expect(page.locator('.user-name')).toHaveText(['Alice', 'Carol', 'Bob', 'Dave', 'Erin']);

        // threads
        await page.locator('#thread-toggle').click();
        await expect(page.locator('#thread-toggle')).toHaveClass(/active/);
        await expect(page.locator('#thread-toggle')).toHaveText('🔗 Hide (1)');
        await expect(page.locator('#connections-svg path.connection-line.thread')).toHaveCount(1);
        await page.locator('#thread-toggle').click();
        await expect(page.locator('#thread-toggle')).toHaveText('🔗 Threads');
        await expect(page.locator('#connections-svg path')).toHaveCount(0);

        // playback: speed, play to the end, reset
        await page.locator('#playback-speed').click();
        await expect(page.locator('#playback-speed')).toHaveText('2x');
        await page.locator('#play-btn').click();
        await expect(page.locator('#playback-time')).toHaveText('4 / 4');
        await expect(page.locator('#play-btn')).not.toHaveClass(/active/);
        await expect(page.locator('#event-nodes .event-node.hidden')).toHaveCount(0);
        await page.locator('#playback-progress').click({ position: { x: 10, y: 2 } });
        await expect(page.locator('#playback-time')).toHaveText('0 / 4');
        await expect(page.locator('#event-nodes .event-node.hidden')).toHaveCount(4);
        await page.locator('.playback-btn[title="Reset"]').click();
        await expect(page.locator('#event-nodes .event-node.hidden')).toHaveCount(0);

        // compare
        await page.locator('#compare-toggle').click();
        await expect(page.locator('#app')).toHaveClass(/compare-mode/);
        await expect(page.locator('#compare-toggle')).toHaveText('📊 Exit');
        await expect(page.locator('#compare-container')).toBeVisible();
        await expect(page.locator('.user-compare-btn')).toHaveCount(5);
        await card(page, ALICE).locator('.user-compare-btn').click();
        await expect(page.locator('#toast')).toHaveText('⚠️ Select a different user');
        await card(page, CAROL).locator('.user-compare-btn').click();
        await expect(page.locator('#compare-user-info')).toHaveText('Carol — 2 events');
        await expect(card(page, CAROL).locator('.user-compare-btn')).toHaveClass(/active/);
        await expect(card(page, ALICE)).toHaveClass(/selected/);        // comparing did not also select the card
        await expect(page.locator('#compare-nodes .event-node')).toHaveCount(2);
        await expect(page.locator('#compare-stats')).toBeVisible();
        await expect(page.locator('#compare-name1')).toHaveText('Alice');
        await expect(page.locator('#compare-name2')).toHaveText('Carol');
        await expect(page.locator('#compare-total1')).toHaveText('4');
        await expect(page.locator('#compare-total2')).toHaveText('2');
        await expect(page.locator('#playback-time')).toHaveText('0 / 6');
        await page.locator(`#compare-nodes .event-node[data-event-id="${hex(12)}"]`).click();
        await expect(page.locator('#event-detail h3')).toHaveText("📊 Carol's Event");
        await expect(page.locator('#event-detail .event-content')).toHaveText('carol two');
        // a new range reloads both sides (they used to cancel each other)
        await page.locator('.time-btn[data-hours="12"]').click();
        await expect(page.locator('#compare-user-info')).toHaveText('Carol — 1 events');
        await expect(page.locator('#selected-user-info')).toHaveText('Alice — 3 events in 12H');
        await expect(page.locator('#event-detail .event-card')).toHaveCount(3);
        await expect(page.locator('#compare-total1')).toHaveText('3');
        await expect(page.locator('#compare-total2')).toHaveText('1');
        await page.locator('#compare-toggle').click();
        await expect(page.locator('#app')).not.toHaveClass(/compare-mode/);
        await expect(page.locator('#compare-container')).toBeHidden();
        await expect(page.locator('.user-compare-btn')).toHaveCount(0);
        await expect(page.locator('#playback-time')).toHaveText('0 / 3');
        await w.clean();
    });

    test('a relay that hangs up, and one that is switched off, do not hold up the rest', async ({ page, context, baseURL }) => {
        const w = await setup({ page, context, baseURL });
        w.hangUp.add('nostr.wine');
        w.notes.set(ALICE.pk, aliceNotes);
        w.notes.set(CAROL.pk, (f) => [note(f, CAROL.pk, 11, 4 * HOUR, 'carol one')]);
        await page.goto('/');
        await expect(page.locator('.user-name')).toHaveText(USERS.map(u => u.name));
        await expect(page.locator('#relay-count')).toHaveText('4/5');

        await page.locator('#relay-toggle-btn').click();
        const damus = page.locator('.relay-item', { hasText: 'relay.damus.io' });
        await expect(damus.locator('.relay-dot')).toHaveClass(/connected/);
        await damus.locator('.relay-toggle').click();
        await expect(damus.locator('.relay-toggle')).toHaveText('OFF');
        await expect(damus.locator('.relay-dot')).toHaveClass(/closed/);
        await expect(page.locator('#relay-count')).toHaveText('3/4');
        await expect(page.locator('.relay-chip')).toHaveCount(4);
        await page.locator('#relay-manager .close-btn').click();

        // the request still finishes: with notes, and with none (that message only comes when every relay is done)
        w.reqs.length = 0;
        await select(page, ALICE);
        await expect(page.locator('#event-detail .event-card')).toHaveCount(4);
        await expect(page.locator('#selected-user-info')).toHaveText('Alice — 4 events in 1D');
        await select(page, BOB);
        await expect(page.locator('#selected-user-info')).toHaveText('Bob has no events in the last 1D');
        expect([...new Set(w.reqs.map(r => r.host))].sort()).toEqual(['nos.lol', 'relay.primal.net', 'relay.snort.social']);
        // so does the compare side, which is only drawn once every relay is done
        await page.locator('#compare-toggle').click();
        await card(page, CAROL).locator('.user-compare-btn').click();
        await expect(page.locator('#compare-user-info')).toHaveText('Carol — 1 events');
        await expect(page.locator('#relay-count')).toHaveText('3/4');
        await w.clean();
    });

    test('NIP-07: connect, import follows, add me, disconnect; only the public key is asked for', async ({ page, context, baseURL }) => {
        const ME = 'cd'.repeat(32);
        const [F1, F2, F3] = ['1a'.repeat(32), '2b'.repeat(32), '3c'.repeat(32)];
        const NAME = '<img src=x onerror="window.__xss=27">';
        const w = await setup({ page, context, baseURL });
        w.profiles.set(ME, { name: 'me', display_name: NAME, picture: 'x" onerror="window.__xss=28' });
        w.profiles.set(F1, { name: 'Follow One' });
        w.profiles.set(F2, { name: 'Follow Two', picture: 'https://pics.test/broken.png' });
        w.follows.set(ME, [['p', F1], ['p', ALICE.pk], ['p', F2.toUpperCase()], ['p', F1], ['p', '<img src=x onerror=window.__xss=29>'], ['p', 'abc'], ['p'], ['e', F3], ['t', 'nostr']]);
        // a stand-in for the browser extension: it gives out the public key and notes anything else it is asked for
        await context.addInitScript((pubkey) => {
            window.__asked = [];
            const refuse = (name) => async () => { window.__asked.push(name); throw new Error(`the page must not call ${name}`); };
            window.nostr = {
                getPublicKey: async () => { window.__asked.push('getPublicKey'); return pubkey; },
                signEvent: refuse('signEvent'),
                getRelays: refuse('getRelays'),
                nip04: { encrypt: refuse('nip04.encrypt'), decrypt: refuse('nip04.decrypt') },
                nip44: { encrypt: refuse('nip44.encrypt'), decrypt: refuse('nip44.decrypt') }
            };
        }, ME.toUpperCase());
        await openFresh(page);

        const login = page.locator('#identity-logged-out button');
        await expect(login).toHaveText('🔑 Connect with Extension');
        await expect(page.locator('#identity-logged-in')).toBeHidden();
        await login.click();
        await expect(page.locator('#identity-name')).toHaveText(NAME);              // the profile's display name, as text
        await expect(page.locator('#identity-logged-in')).toBeVisible();
        await expect(page.locator('#identity-logged-out')).toBeHidden();
        await expect(page.locator('#identity-npub')).toHaveText(/^npub1[a-z0-9]{11}\.\.\.$/);
        await expect(page.locator('#identity-avatar')).toHaveText('👤');
        expect(await page.locator('#identity-panel img').count()).toBe(0);
        // what is kept is the public key and what the profile said, nothing else
        expect(await stored(page, 'nostr_orbit_identity')).toEqual({ pubkey: ME, npub: expect.stringMatching(/^npub1[a-z0-9]{58}$/), name: NAME, picture: null });

        await page.locator('#identity-actions button', { hasText: 'Import Follows' }).click();
        await expect(page.locator('#toast')).toHaveText('✅ Imported 2 follows!');
        await expect(page.locator('.user-name')).toHaveText([...USERS.map(u => u.name), 'Follow One', 'Follow Two']);
        await expect(card(page, F2).locator('.user-avatar')).toHaveText('👤');      // its picture did not load: the fallback is back
        expect(await page.locator('#user-list img').count()).toBe(0);
        expect((await stored(page, 'nostr_orbit_users')).map(u => u.pubkey)).toEqual([...USERS.map(u => u.pk), F1, F2]);
        expect(w.reqs.filter(r => r.sub.startsWith('follows-'))[0].filter).toEqual({ kinds: [3], authors: [ME], limit: 1 });

        await page.locator('#identity-actions button', { hasText: 'Add Me' }).click();
        await expect(page.locator('#toast')).toHaveText('✅ Added yourself!');
        await expect(page.locator('.user-name').last()).toHaveText(NAME);
        await expect(page.locator('.user-card')).toHaveCount(8);
        await page.locator('#identity-actions button', { hasText: 'Add Me' }).click();
        await expect(page.locator('#toast')).toHaveText('ℹ️ Already in list!');

        await page.locator('#identity-logged-in > button', { hasText: 'Disconnect' }).click();
        await expect(page.locator('#identity-name')).toHaveText('Not connected');
        await expect(page.locator('#identity-logged-out')).toBeVisible();
        expect(await stored(page, 'nostr_orbit_identity')).toBeNull();

        expect(await page.evaluate(() => window.__asked)).toEqual(['getPublicKey']);
        expect(await page.evaluate(() => Object.keys(localStorage).sort())).toEqual(['nostr_orbit_relays', 'nostr_orbit_users']);
        expect(await handlerAttributes(page)).toEqual([]);
        expect([...new Set(w.outside)]).toEqual(['https://pics.test/broken.png']);
        await w.clean();
    });

    test('NIP-07: an answer that is not a public key is refused, and a stored identity is restored', async ({ page, context, baseURL }) => {
        const ME = 'cd'.repeat(32);
        const w = await setup({ page, context, baseURL });
        w.profiles.set(ME, { name: 'Me Myself', picture: OK_PICTURE });
        await context.addInitScript(() => { window.nostr = { getPublicKey: async () => window.__answer }; });
        await openFresh(page);
        const login = page.locator('#identity-logged-out button');
        for (const answer of ['<img src=x onerror="window.__xss=30">', 'cd'.repeat(31), { pubkey: 'cd'.repeat(32) }, null]) {
            await page.evaluate((a) => { window.__answer = a; document.getElementById('toast').textContent = ''; }, answer);
            await login.click();
            await expect(page.locator('#toast')).toHaveText('❌ Failed to get public key');
        }
        await expect(page.locator('#identity-name')).toHaveText('Not connected');
        await expect(page.locator('#identity-logged-out')).toBeVisible();
        expect(await stored(page, 'nostr_orbit_identity')).toBeNull();

        // a good answer signs in; after a reload the page restores it from storage without asking again
        await page.evaluate((a) => { window.__answer = a; }, ME);
        await login.click();
        await expect(page.locator('#identity-name')).toHaveText('Me Myself');
        await expect(page.locator('#identity-avatar img')).toHaveJSProperty('src', OK_PICTURE);
        await page.reload();
        await expect(page.locator('#identity-name')).toHaveText('Me Myself');
        await expect(page.locator('#identity-logged-in')).toBeVisible();
        await expect(page.locator('#identity-avatar img')).toHaveAttribute('alt', 'avatar');
        await expect(page.locator('.user-name')).toHaveText(USERS.map(u => u.name));     // the list came back from storage too
        await w.clean();
    });

    test('without an extension the button says so and nothing is asked', async ({ page, context, baseURL }) => {
        const w = await setup({ page, context, baseURL });
        await openFresh(page);
        const login = page.locator('#identity-logged-out button');
        await expect(login).toHaveText('🔑 No Extension Found');
        await login.click();
        await expect(page.locator('#toast')).toHaveText('❌ No NIP-07 extension found');
        await expect(page.locator('#identity-name')).toHaveText('Not connected');
        await w.clean();
    });
});
