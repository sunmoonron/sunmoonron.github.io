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
