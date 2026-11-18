// Exercise the production UI with browser-side fixtures, without writing remote files or running commands.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('/app/node_modules/playwright');

const project = '/home/developer/projects/orbit';
const path = project + '/README.md';
const sessionName = 'Build and test on ARM64';

(async () => {
  const { webUrl } = JSON.parse(fs.readFileSync(0, 'utf8'));
  const browser = await chromium.launch({ executablePath: chromium.executablePath(), headless: true, args: ['--no-sandbox'] });
  try {
    for (const width of [320, 390, 1440]) {
      const mobile = width < 821;
      const page = await browser.newPage({ viewport: { width, height: 844 }, isMobile: mobile, hasTouch: mobile, serviceWorkers: 'block' });
      let saved, shortcut;
      await page.addInitScript(() => {
        localStorage.setItem('orbit.connections', JSON.stringify([
          { id: 'build', label: 'Build workstation', url: 'http://build.internal:7777', token: 'fixture' },
          { id: 'home', label: 'Home workstation', url: 'http://home.internal:7777', token: 'fixture' }
        ]));
      });
      await page.route('**/api/v1/**', route => {
        const { pathname } = new URL(route.request().url());
        const fulfill = json => route.fulfill({ json });
        if (pathname.endsWith('/backends')) return fulfill([{ id: 'codex', name: 'Codex', modes: ['cli', 'web'] }]);
        if (pathname.endsWith('/sessions')) return fulfill([
          { id: 'fixture-cli', name: sessionName, tool: 'codex', mode: 'cli', cwd: project, status: 'running', pid: 19234 },
          { id: 'fixture-web', name: '대화 작업', tool: 'codex', mode: 'web', cwd: project, status: 'stopped' }
        ]);
        if (pathname.endsWith('/logs')) return fulfill({
          lines: [{ id: 1, timestamp: '2026-01-01T00:00:00Z', content: 'b3JiaXQgbG9n' }],
          has_more: false, next_after: 1, snapshot_last_id: 1
        });
        if (pathname.endsWith('/entries')) return fulfill({
          path: project, home: project, parent: null, entries: [
            { name: 'README.md', path, kind: 'file' },
            { name: 'example.js', path: project + '/example.js', kind: 'file' }
          ]
        });
        if (pathname.endsWith('/files')) {
          if (route.request().method() === 'PUT') {
            saved = route.request().postDataJSON();
            return fulfill({ ok: true });
          }
          const file = new URL(route.request().url()).searchParams.get('path');
          return fulfill({ path: file, content: file === path ? '# Orbit' : 'const orbit = 1;' });
        }
        return route.abort();
      });
      await page.routeWebSocket('**/api/v1/sessions/*/attach?*', ws => {
        ws.onMessage(raw => {
          const frame = JSON.parse(String(raw));
          if (frame.type === 'stdin') shortcut = Buffer.from(frame.data, 'base64').toString();
        });
      });
      await page.goto(webUrl);
      const themeToggle = page.getByRole('button', { name: 'Dark mode', exact: true });
      const scheme = () => page.locator('html').evaluate(el => getComputedStyle(el).colorScheme);
      assert.equal(await scheme(), 'light');
      await themeToggle.click();
      assert.equal(await themeToggle.getAttribute('aria-pressed'), 'true');
      assert.equal(await scheme(), 'dark');
      await page.reload();
      assert.equal(await themeToggle.getAttribute('aria-pressed'), 'true');
      assert.equal(await scheme(), 'dark');
      const row = page.getByRole('button', { name: new RegExp(sessionName) });
      await row.waitFor();
      assert.match(await row.innerText(), /running\s+CLI/);
      const overflow = selector => page.locator(selector).evaluate(el => el.scrollWidth > el.clientWidth + 1);
      assert.equal(await overflow('.sessions'), false, `session list overflows at ${width}px`);

      await page.getByTitle('New session', { exact: true }).click();
      const create = page.getByRole('dialog', { name: 'New session' });
      assert(await create.getByRole('radio', { name: 'CLI · Terminal' }).isChecked());
      await create.getByRole('radio', { name: 'Web · Chat' }).check();
      assert.equal(await create.getByLabel('Environment', { exact: true }).count(), 0);
      await create.getByRole('button', { name: 'Cancel' }).click();
      await page.waitForFunction(() => !history.state?.orbitModal);

      await row.click();
      const terminal = page.locator('.cliSessionPane');
      const hideSessions = page.getByRole('button', { name: 'Hide session list' });
      if (mobile) {
        assert.equal(await hideSessions.count(), 0);
      } else {
        const divider = page.getByRole('separator', { name: 'Resize panes' });
        const pane = page.locator('#session-list-pane');
        await divider.press('ArrowRight');
        const initialPaneWidth = (await pane.boundingBox()).width;
        const initialTerminalWidth = (await terminal.boundingBox()).width;
        await hideSessions.click();
        const showSessions = page.getByRole('button', { name: 'Show session list' });
        assert.equal(await showSessions.getAttribute('aria-expanded'), 'false');
        assert.equal(await pane.isVisible(), false);
        assert.equal(await divider.isVisible(), false);
        assert((await terminal.boundingBox()).width > initialTerminalWidth);
        await showSessions.click();
        assert.equal((await pane.boundingBox()).width, initialPaneWidth);
        assert.equal((await terminal.boundingBox()).width, initialTerminalWidth);
      }
      await terminal.locator('summary').click();
      await terminal.getByText('19234', { exact: true }).waitFor();
      await terminal.locator('summary').press('Escape');
      await terminal.getByText('19234', { exact: true }).waitFor({ state: 'hidden' });
      await terminal.getByRole('button', { name: 'Esc', exact: true }).click();
      await terminal.getByRole('button', { name: 'Logs', exact: true }).click();
      await terminal.getByText('1 chunks', { exact: true }).waitFor();
      assert.equal(shortcut, '\x1b');
      await terminal.getByRole('button', { name: 'Terminal', exact: true }).click();
      if (mobile) {
        await terminal.getByRole('button', { name: 'Back to Sessions' }).click();
        await row.waitFor();
        assert.equal(await page.evaluate(() => !!history.state?.orbitDetail), false);
      }

      await page.getByRole('button', { name: 'Files', exact: true }).click();
      await page.getByRole('button', { name: 'README.md', exact: true }).click();
      const editor = page.locator('.fileEditorSurface');
      await editor.getByRole('textbox').fill('# Updated on ' + width);
      await editor.getByRole('button', { name: 'Save', exact: true }).click();
      await editor.getByRole('button', { name: 'Saved', exact: true }).waitFor();
      assert.deepEqual(saved, { path, content: '# Updated on ' + width });
      assert.equal(await overflow('.fileTabs'), false);
      await editor.getByRole('button', { name: 'Preview', exact: true }).click();
      await editor.getByRole('heading', { name: 'Updated on ' + width }).waitFor();
      if (mobile) {
        await editor.getByRole('button', { name: 'Back to Explorer' }).click();
        await page.getByRole('button', { name: 'README.md', exact: true }).click();
        await editor.getByRole('textbox').waitFor();
        await page.goBack();
        await editor.waitFor({ state: 'hidden' });
        await page.getByRole('button', { name: 'README.md', exact: true }).waitFor();
      } else {
        await page.getByRole('button', { name: 'example.js', exact: true }).click();
        const code = editor.locator('.cm-content');
        await code.fill('const unsaved = 2;');
        const syntaxColor = () => code.getByText('const', { exact: true }).evaluate(el => getComputedStyle(el).color);
        assert.equal(await syntaxColor(), 'rgb(154, 191, 255)');
        await themeToggle.click();
        assert.equal(await scheme(), 'light');
        assert.equal(await syntaxColor(), 'rgb(0, 0, 255)');
        assert.equal(await code.innerText(), 'const unsaved = 2;');
        await themeToggle.click();
      }
      await page.getByRole('button', { name: /Orbitd connections/ }).click();
      await page.getByRole('button', { name: 'Home workstation', exact: true }).click();
      await page.getByRole('button', { name: 'Orbitd connections · Home workstation' }).waitFor();
      await themeToggle.click();
      await page.reload();
      assert.equal(await themeToggle.getAttribute('aria-pressed'), 'false');
      assert.equal(await scheme(), 'light');
      await page.close();
    }
    console.log('Workspace layout passed at 320, 390 and 1440 pixels');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
