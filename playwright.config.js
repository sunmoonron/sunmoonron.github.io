// Browser smoke suite for /skate (see skate/tests/README.md).
// Four projects: desktop and phone, each light and dark. The static site is
// served by the same python server the dev preview uses.
const { defineConfig, devices } = require('@playwright/test');

const phone = { ...devices['Pixel 7'], hasTouch: true, isMobile: true };

module.exports = defineConfig({
    testDir: 'skate/tests',
    timeout: 45000,
    expect: { timeout: 10000, toHaveScreenshot: { maxDiffPixelRatio: 0.02, animations: 'disabled', caret: 'hide' } },
    fullyParallel: true,
    retries: process.env.CI ? 1 : 0,
    reporter: [['list'], ['html', { open: 'never' }]],
    snapshotPathTemplate: '{testDir}/__screenshots__/{projectName}/{testFilePath}/{arg}{ext}',
    use: {
        baseURL: 'http://127.0.0.1:8618',
        locale: 'en-CA',
        timezoneId: 'America/Toronto',
        permissions: ['clipboard-read', 'clipboard-write'],
        // the service worker would answer fetches itself and bypass page.route(); one test turns it on
        serviceWorkers: 'block',
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure'
    },
    webServer: {
        command: 'python3 -m http.server 8618 --bind 127.0.0.1',
        url: 'http://127.0.0.1:8618/skate/',
        reuseExistingServer: true,
        timeout: 20000
    },
    projects: [
        { name: 'desktop-light', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 }, theme: 'light' } },
        { name: 'desktop-dark',  use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 }, theme: 'dark' } },
        { name: 'phone-light',   use: { ...phone, theme: 'light' } },
        { name: 'phone-dark',    use: { ...phone, theme: 'dark' } }
    ]
});
