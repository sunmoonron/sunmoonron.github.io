// The members' entrance (projects/js/gate.js), tested on its own: a stand-in
// relay on a mocked socket and a stand-in app. What must hold whatever the
// real app is: an ordinary visit never touches any of this; a key that is not
// on the list gets a card and nothing else; only a build signed by the pinned
// release key is ever run, never an altered or an older one; and when the
// server says no, nothing of the members' area stays on the device.
const fs = require('fs');
const path = require('path');
const { test, expect } = require('./fixtures');

const N = new Function(fs.readFileSync(path.join(__dirname, '..', '..', 'assets', 'js', 'nostr.bundle.js'), 'utf8') + '\n; return NostrTools;')();
const GATE_URL = 'ws://gate.test/hq';
const release = N.generateSecretKey(), releasePk = N.getPublicKey(release);
const memberSk = N.generateSecretKey(), memberPk = N.getPublicKey(memberSk);
const hex = (b) => Buffer.from(b).toString('hex');

/* a stand-in for the members' app: a box with a close button, and its context exposed for the test */
const appCode = (build) => `
    return { build: ${build}, mount(ctx) {
        const el = document.createElement('div');
        el.id = 'members-app'; el.hidden = true;
        el.style.cssText = 'position:fixed;inset:0;z-index:5000;background:#fff;color:#000;padding:24px';
        el.innerHTML = '<p>members app build ${build}</p><button id="members-close">close</button>';
        document.body.appendChild(el);
        let open = false;
        const api = {
            show() { open = true; el.hidden = false; },
            hide() { open = false; el.hidden = true; if (ctx.onHide) ctx.onHide(); },
            isOpen: () => open, unread: () => 0,
            async destroy(wipe) { const was = open; open = false; el.remove(); window.__destroyed = (window.__destroyed || 0) + 1; window.__wiped = !!wipe; return was; }
        };
        el.querySelector('#members-close').onclick = () => api.hide();
        window.__gate = { ctx, pk: ctx.identity.pk, superadmins: ctx.superadmins, url: ctx.url };
        return api;
    } };`;
const build = (v, sk = release) => N.finalizeEvent({ kind: 39199, created_at: 1, tags: [['d', 'hq-web'], ['v', String(v)]], content: appCode(v) }, sk);

/** the relay's side of the handshake: challenge, signature check, list check, then the build */
async function relay(context, world) {
    await context.routeWebSocket(GATE_URL, (ws) => {
        world.connects++;
        const challenge = 'c0ffee'.repeat(8);
        ws.send(JSON.stringify(['AUTH', challenge]));
        ws.onMessage((raw) => {
            let m;
            try { m = JSON.parse(raw); } catch { return; }
            if (m[0] === 'AUTH') {
                const ev = m[1];
                const tag = (n) => (ev.tags.find(t => t[0] === n) || [])[1];
                const good = ev.kind === 22242 && tag('challenge') === challenge && tag('relay') === GATE_URL &&
                    N.verifyEvent({ id: ev.id, pubkey: ev.pubkey, created_at: ev.created_at, kind: ev.kind, tags: ev.tags, content: ev.content, sig: ev.sig });
                world.proved.push(good ? ev.pubkey : null);
                if (!good || !world.members.has(ev.pubkey)) { ws.send('["NO"]'); ws.close({ code: 4003 }); return; }
                ws.send(JSON.stringify(['HELLO', { v: 1, pk: ev.pubkey, sid: 's1', role: 'member', now: 0, app: 7, online: [] }]));
            } else if (m[0] === 'APP') ws.send(JSON.stringify(['R', m[1], true, world.served]));
        });
    });
}
/** point the page at the stand-in relay and release key at the moment config.js defines SkateConfig */
async function arrange(context, { identity } = {}) {
    const world = { members: new Set([memberPk]), served: build(7), connects: 0, proved: [] };
    await relay(context, world);
    await context.addInitScript(([gate, id]) => {
        if (id && !localStorage.getItem('skate_identity_v1')) localStorage.setItem('skate_identity_v1', id);
        Object.defineProperty(window, 'SkateConfig', {
            configurable: true,
            get() { return undefined; },
            set(v) { v.gate = gate; Object.defineProperty(window, 'SkateConfig', { value: v, writable: true, configurable: true, enumerable: true }); }
        });
    }, [{ url: GATE_URL, key: releasePk }, identity ? JSON.stringify({ sk: hex(identity), pk: N.getPublicKey(identity), name: 'Tester' }) : null]);
    return world;
}
const kept = (page) => page.evaluate(() => new Promise((res) => {
    const r = indexedDB.open('skate-gate');
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => { const g = r.result.transaction('kv').objectStore('kv').get('app'); g.onsuccess = () => { r.result.close(); res(g.result ? Number(g.result.tags.find(t => t[0] === 'v')[1]) : null); }; };
    r.onerror = () => res(null);
}));
const gateState = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('skate_gate_v1') || '{"members":{},"min":0}'));

test.describe('members\' entrance', () => {
    test('an ordinary visit does not load it, show it, or connect anywhere for it', async ({ page, context, app }) => {
        const world = await arrange(context);
        const urls = [];
        page.on('request', (r) => urls.push(r.url()));
        await app.open();
        await page.waitForTimeout(2200);          // past the idle warm-up a known device would get
        expect(urls.filter(u => /gate\.js|nostr\.bundle/.test(u))).toEqual([]);
        expect(world.connects).toBe(0);
        await expect(page.locator('#btn-gate')).toBeHidden();
        await expect(page.locator('.gate-backdrop')).toHaveCount(0);
        expect(await page.evaluate(() => typeof window.SkateGate)).toBe('undefined');
        await app.noErrors();
    });

    test('a key that is not on the list: one card, the key to pass on, and nothing kept', async ({ page, context, app }) => {
        const world = await arrange(context);
        await app.open('/skate/#hq');
        const card = page.locator('.gate-card');
        await expect(card.locator('h2')).toHaveText('Members only');
        const npub = await card.locator('code').textContent();
        expect(npub).toMatch(/^npub1[a-z0-9]{58}$/);
        expect(world.connects).toBe(0);                      // nothing is sent until the visitor asks
        await card.getByRole('button', { name: 'Copy' }).click();
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(npub);
        await card.getByRole('button', { name: 'Continue' }).click();
        await expect(card.locator('h2')).toHaveText('Not on the list');
        expect(world.proved).toHaveLength(1);
        expect(world.proved[0]).toBe(N.nip19.decode(npub).data);     // the challenge really was signed by that key
        expect(await page.evaluate(() => window.__gate)).toBeUndefined();
        expect(await kept(page)).toBe(null);
        expect((await gateState(page)).members).toEqual({});
        await expect(page.locator('#btn-gate')).toBeHidden();
        // Escape closes the card and the address is the plain app again
        await page.keyboard.press('Escape');
        await expect(card).toHaveCount(0);
        expect(new URL(page.url()).hash).toBe('');
        await app.noErrors();
    });

    test('a member: the build is verified, run, kept; the button appears; a reload needs no network', async ({ page, context, app }) => {
        const world = await arrange(context, { identity: memberSk });
        await app.open('/skate/#hq');
        await page.locator('.gate-card').getByRole('button', { name: 'Continue' }).click();
        await expect(page.locator('#members-app')).toBeVisible();
        await expect(page.locator('#members-app')).toContainText('build 7');
        await expect(page.locator('.gate-card')).toHaveCount(0);
        const seen = await page.evaluate(() => ({ pk: window.__gate.pk, superadmins: window.__gate.superadmins, url: window.__gate.url, dev: window.SkateConfig.devPubkey }));
        expect(seen.pk).toBe(memberPk);
        expect(seen.superadmins).toEqual([seen.dev]);            // the app is told who the superadmin is by the page, not by the relay
        expect(seen.url).toBe(GATE_URL);
        expect(await kept(page)).toBe(7);
        expect(await gateState(page)).toEqual({ members: { [memberPk]: 1 }, min: 7 });
        expect(new URL(page.url()).hash).toBe('#hq');
        // closed: plain address, and the button brings it back without another sign-in
        await page.locator('#members-close').click();
        await expect(page.locator('#members-app')).toBeHidden();
        expect(new URL(page.url()).hash).toBe('');
        await expect(page.locator('#btn-gate')).toBeVisible();
        const before = world.connects;
        await page.locator('#btn-gate').click();
        await expect(page.locator('#members-app')).toBeVisible();
        expect(world.connects).toBe(before);
        // a later visit: the kept build starts in the background, from this device alone
        await page.locator('#members-close').click();
        world.served = null;
        await page.reload();
        await expect(page.locator('#btn-gate')).toBeVisible();
        await expect(page.locator('#members-app')).toHaveCount(1, { timeout: 10000 });
        await expect(page.locator('#members-app')).toBeHidden();
        expect(world.connects).toBe(before);
        await page.locator('#btn-gate').click();
        await expect(page.locator('#members-app')).toBeVisible();
        await app.noErrors();
    });

    test('a build signed by another key, altered after signing, or older than one already run is never executed', async ({ page, context, app }) => {
        const world = await arrange(context, { identity: memberSk });
        const tryIt = async (served, heading) => {
            world.served = served;
            if (await page.locator('.gate-card').count()) await page.locator('.gate-card').getByRole('button', { name: 'Close' }).click();
            await page.evaluate(() => { window.location.hash = 'hq'; });
            await page.locator('.gate-card').getByRole('button', { name: 'Continue' }).click();
            await expect(page.locator('.gate-card h2')).toHaveText(heading);
            expect(await page.evaluate(() => window.__gate)).toBeUndefined();
            await expect(page.locator('#members-app')).toHaveCount(0);
            expect(await kept(page)).toBe(null);
        };
        await app.open();
        await tryIt(build(7, N.generateSecretKey()), 'Stopped for safety');
        const altered = JSON.parse(JSON.stringify(build(7)));
        altered.content = altered.content.replace('members app', 'malicious app');
        await tryIt(altered, 'Stopped for safety');
        const wrongKind = N.finalizeEvent({ kind: 1, created_at: 1, tags: [['d', 'hq-web'], ['v', '9']], content: appCode(9) }, release);
        await tryIt(wrongKind, 'Stopped for safety');
        await tryIt(null, 'Not available right now');
        // this device has run build 7 before: build 5, though properly signed, is a step back
        await page.evaluate((pk) => localStorage.setItem('skate_gate_v1', JSON.stringify({ members: { [pk]: 1 }, min: 7 })), memberPk);
        world.served = build(5);
        await page.locator('.gate-card').getByRole('button', { name: 'Close' }).click();
        await page.reload();
        await page.locator('#btn-gate').click();
        await expect(page.locator('.gate-card h2')).toHaveText('Stopped for safety');
        expect(await page.evaluate(() => window.__gate)).toBeUndefined();
        // and the genuine current build still works afterwards
        world.served = build(8);
        await page.locator('.gate-card').getByRole('button', { name: 'Close' }).click();
        await page.locator('#btn-gate').click();
        await expect(page.locator('#members-app')).toContainText('build 8');
    });

    test('the app can install a newer verified build, and only that', async ({ page, context, app }) => {
        const world = await arrange(context, { identity: memberSk });
        await app.open('/skate/#hq');
        await page.locator('.gate-card').getByRole('button', { name: 'Continue' }).click();
        await expect(page.locator('#members-app')).toContainText('build 7');
        const install = (ev) => page.evaluate((e) => window.__gate.ctx.install(e), ev);
        expect(await install(build(9, N.generateSecretKey()))).toBe(false);
        expect(await install(build(6))).toBe(false);
        expect(await install(build(7))).toBe(false);
        expect(await kept(page)).toBe(7);
        expect(await install(build(9))).toBe(true);
        expect(await kept(page)).toBe(9);
        await page.evaluate(() => { window.__gate.ctx.reload(); });
        await expect(page.locator('#members-app')).toContainText('build 9');
        await expect(page.locator('#members-app')).toBeVisible();
        expect(await page.evaluate(() => window.__destroyed)).toBe(1);
        expect((await gateState(page)).min).toBe(9);
        expect(world.connects).toBe(1);
    });

    test('when the server says no, nothing of the members\' area stays on the device', async ({ page, context, app }) => {
        await arrange(context, { identity: memberSk });
        await app.open('/skate/#hq');
        await page.locator('.gate-card').getByRole('button', { name: 'Continue' }).click();
        await expect(page.locator('#members-app')).toBeVisible();
        await page.evaluate(() => { window.__gate.ctx.wipe(); });
        await expect(page.locator('#members-app')).toHaveCount(0);
        await expect(page.locator('.gate-card h2')).toHaveText('Not on the list');
        expect(await page.evaluate(() => window.__wiped)).toBe(true);
        expect(await kept(page)).toBe(null);
        expect((await gateState(page)).members).toEqual({});
        await expect(page.locator('#btn-gate')).toBeHidden();
    });

    test('"Use another key" switches the device to an invited key', async ({ page, context, app }) => {
        const world = await arrange(context);
        await app.open('/skate/#hq');
        const card = page.locator('.gate-card');
        const first = await card.locator('code').textContent();
        await card.getByRole('button', { name: 'Use another key' }).click();
        await card.locator('input').fill('not a key');
        await card.getByRole('button', { name: 'Use this key' }).click();
        await expect(card.locator('.gate-error')).toContainText('not a secret key');
        await card.locator('input').fill('  ' + N.nip19.nsecEncode(memberSk).toUpperCase() + ' ');
        await card.getByRole('button', { name: 'Use this key' }).click();
        await expect(card.locator('code')).toHaveText(N.nip19.npubEncode(memberPk));
        expect(first).not.toBe(N.nip19.npubEncode(memberPk));
        await card.getByRole('button', { name: 'Continue' }).click();
        await expect(page.locator('#members-app')).toBeVisible();
        expect(world.proved).toEqual([memberPk]);
        expect(JSON.parse(await page.evaluate(() => localStorage.getItem('skate_identity_v1'))).pk).toBe(memberPk);
    });
});
