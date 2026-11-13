// Chats, dev chat and guides against the mocked relay: rooms, send → settle,
// reactions, unsend, a private group, the feedback sheet, an empty guides list.
const { test, expect } = require('./fixtures');

test.describe('community', () => {
    test.use({ settings: { showChats: true, showGuides: true } });

    const booted = (page) => page.waitForFunction(() => window.SkateChat && SkateChat.booted && SkateNostr.connectedCount() > 0, null, { timeout: 25000 });

    test('rooms list, send settles, react, unsend', async ({ page, app }) => {
        await app.open();
        await booted(page);
        await app.view('chats');
        await expect(page.locator('#conversation-list .conv-item')).toHaveCount(5);
        await page.locator('#conversation-list .conv-item', { hasText: 'General Chat' }).click();
        await expect(page.locator('#chats-convo-mode')).toBeVisible();
        await expect(page.locator('#chat-title')).toContainText('General Chat');
        await page.fill('#chat-input', 'hello from the smoke suite');
        await page.keyboard.press('Enter');
        const mine = page.locator('.chat-msg.mine', { hasText: 'hello from the smoke suite' });
        await expect(mine).toBeVisible();
        await expect(mine.locator('.msg-tick:not(.pending):not(.failed)')).toBeVisible({ timeout: 20000 });   // a relay said OK
        await mine.locator('.bubble').click();
        await expect(page.locator('#popover .react-pick').first()).toBeVisible();
        await page.locator('#popover .react-pick').first().click();
        await expect(mine.locator('.react-chip.mine')).toContainText('1');
        page.once('dialog', (d) => d.accept());
        await mine.locator('.bubble').click();
        await page.locator('#popover .popover-item', { hasText: 'Unsend' }).click();
        await expect(page.locator('.chat-msg.deleted')).toHaveCount(1);
        await app.noErrors();
    });

    test('create a private group, copy its invite, leave it', async ({ page, app }) => {
        await app.open();
        await booted(page);
        await app.view('chats');
        await page.click('#btn-discover');
        await page.fill('#group-name-input', 'Smoke group');
        await page.click('#btn-create-group');
        await expect(page.locator('#chat-title')).toContainText('Smoke group');
        expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('#i=');
        await expect(page.locator('#chats-list-mode')).toBeHidden();                 // conversation mode hides the list
        page.once('dialog', (d) => d.accept());
        await page.click('#btn-chat-menu');
        await page.locator('#popover .popover-item', { hasText: 'Leave group' }).click();
        await expect(page.locator('#chats-list-mode')).toBeVisible();
        await expect(page.locator('#conversation-list .conv-item')).toHaveCount(5);
        await app.noErrors();
    });

    test('dev inbox: the thread rail keeps its height and its names when the thread on screen is long', async ({ page, app }) => {
        await app.open();
        await page.evaluate(() => SkateApp.Actions.bootCommunity());
        await page.waitForFunction(() => window.SkateChat && SkateChat.getIdentity().pk, null, { timeout: 20000 });
        await page.evaluate(() => {
            SkateConfig.devPubkey = SkateChat.getIdentity().pk;                    // this device is the dev for the test
            const now = Date.now();
            const thread = (name, n) => ({ name, lastReadTs: 0, messages: Array.from({ length: n }, (_, i) => ({ mine: i % 2 === 1, ts: now - (n - i) * 60000, text: `line ${i}: the rink time looked wrong on my phone`, type: 'chat', status: 'sent' })) });
            const th = SkateChat.getState().dmThreads;
            th['26b2b8' + 'a'.repeat(58)] = thread('Smoothy', 40);
            th['b77dd6' + 'b'.repeat(58)] = thread('QuickTiger60', 3);
            th['c0ffee' + 'c'.repeat(58)] = thread('A visitor with quite a long display name', 2);
            SkateDev.open();
        });
        await expect(page.locator('#devchat-title')).toHaveText('Dev inbox');
        const chips = page.locator('#devchat-threads .devchat-thread');
        await expect(chips).toHaveCount(3);
        const rail = await page.locator('#devchat-threads').boundingBox();
        expect(rail.height).toBeGreaterThanOrEqual(40);                             // it was squashed to a sliver
        for (const chip of await chips.all()) {
            const fits = await chip.evaluate(e => ({ h: e.getBoundingClientRect().height, clipped: e.scrollHeight > e.clientHeight + 1 }));
            expect(fits.h).toBeGreaterThanOrEqual(32);
            expect(fits.clipped).toBe(false);
        }
        await expect(chips.first()).toContainText('Smoothy · 26b2b8');
        await chips.nth(1).click();                                                 // and it still switches threads
        await expect(chips.nth(1)).toHaveClass(/active/);
        await expect(page.locator('#devchat-messages .devchat-msg')).toHaveCount(3);
    });

    test('the feedback sheet sends a message to the dev', async ({ page, app }) => {
        await app.open();
        await page.click('#btn-feedback');
        await expect(page.locator('#devchat-modal')).toBeVisible({ timeout: 20000 });
        await page.fill('#devchat-input', 'smoke: the rink line is cut off');
        await page.click('#devchat-send');
        await expect(page.locator('#devchat-messages .devchat-msg.mine')).toContainText('smoke: the rink line');
        await app.noErrors();
    });

    test('guides tab loads and says when the relays hold none', async ({ page, app }) => {
        await app.open();
        await booted(page);
        await app.view('guides');
        await expect(page.locator('#guides-list')).toContainText('No guides here yet', { timeout: 20000 });
        await app.noErrors();
    });
});
