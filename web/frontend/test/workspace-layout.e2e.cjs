// Exercise the production UI with browser-side fixtures, without writing remote files or running commands.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('/app/node_modules/playwright');

const home = '/home/developer';
const project = home + '/projects/orbit';
const path = project + '/README.md';
const sessionName = 'Build and test on ARM64';

(async () => {
  const { webUrl } = JSON.parse(fs.readFileSync(0, 'utf8'));
  const browser = await chromium.launch({ executablePath: chromium.executablePath(), headless: true, args: ['--no-sandbox'] });
  try {
    for (const width of [320, 390, 1440]) {
      const mobile = width < 821;
      const page = await browser.newPage({ viewport: { width, height: 844 }, isMobile: mobile, hasTouch: mobile, serviceWorkers: 'block' });
      let saved, shortcut, deletedSession;
      let canCreateFile = false, tempPath, tempSession, submittedSession;
      let tempFoldersCreated = 0, failFirstRun = width === 320;
      const entries = [
        { name: 'README.md', path, kind: 'file' },
        { name: 'example.js', path: project + '/example.js', kind: 'file' }
      ];
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
        if (pathname.endsWith('/sessions')) {
          if (route.request().method() === 'POST') {
            submittedSession = route.request().postDataJSON();
            if (failFirstRun) {
              failFirstRun = false;
              return route.fulfill({ status: 500, body: 'Start failed' });
            }
            tempSession = { ...submittedSession, id: 'temp-session', name: 'codex-temp-session', status: 'running' };
            return route.fulfill({ status: 201, json: tempSession });
          }
          return fulfill([
            { id: 'fixture-cli', name: sessionName, tool: 'codex', mode: 'cli', cwd: project, status: 'running', pid: 19234 },
            { id: 'fixture-web', name: '대화 작업', tool: 'codex', mode: 'web', cwd: project, status: 'stopped' },
            ...(tempSession ? [tempSession] : []),
          ]);
        }
        if (pathname.endsWith('/dirs') && route.request().method() === 'GET') {
          return fulfill({ path: project, home, cwd: project, parent: home, dirs: [] });
        }
        if (route.request().method() === 'DELETE' && pathname.endsWith('/sessions/fixture-web')) {
          deletedSession = 'fixture-web';
          return fulfill({ ok: true });
        }
        if (pathname.endsWith('/logs')) return fulfill({
          lines: [{ id: 1, timestamp: '2026-01-01T00:00:00Z', content: 'b3JiaXQgbG9n' }],
          has_more: false, next_after: 1, snapshot_last_id: 1
        });
        if (pathname.endsWith('/entries')) return fulfill({ path: project, home: project, parent: null, entries, can_create_file: canCreateFile });
        if (route.request().method() === 'POST' && (pathname.endsWith('/dirs') || pathname.endsWith('/files'))) {
          const body = route.request().postDataJSON();
          if (pathname.endsWith('/dirs') && body.name.startsWith('orbit-tmp-')) {
            assert.equal(body.parent, home);
            tempFoldersCreated++;
            tempPath = home + '/' + body.name;
            return route.fulfill({ status: 201, json: { path: tempPath } });
          }
          assert.equal(body.parent, project);
          if (entries.some(entry => entry.name === body.name)) {
            return route.fulfill({ status: 409, json: { error: 'An entry with that name already exists.' } });
          }
          const created = { name: body.name, path: project + '/' + body.name, kind: pathname.endsWith('/dirs') ? 'dir' : 'file' };
          entries.push(created);
          return route.fulfill({ status: 201, json: { path: created.path } });
        }
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
      await page.routeWebSocket('**/api/v1/sessions/temp-session/codex?*', ws => {
        ws.send(JSON.stringify({ type: 'ready', state: {} }));
        ws.onMessage(raw => {
          const request = JSON.parse(String(raw));
          if (request.op === 'history') ws.send(JSON.stringify({ type: 'result', id: request.id, result: { thread: { turns: [] }, state: {} } }));
        });
      });
      await page.goto(webUrl);
      const menuButton = page.getByRole('button', { name: 'Orbit menu', exact: true });
      const menu = page.getByRole('dialog', { name: 'Orbit menu', exact: true });
      const themeToggle = menu.getByRole('button', { name: 'Dark mode', exact: true });
      const scheme = () => page.locator('html').evaluate(el => getComputedStyle(el).colorScheme);
      async function openMenu() {
        await menuButton.click();
        await menu.waitFor();
        await page.waitForFunction(() => !!history.state?.orbitModal);
      }
      async function waitForMenuClose() {
        await menu.waitFor({ state: 'hidden' });
        await page.waitForFunction(() => !history.state?.orbitModal);
      }
      async function closeMenu() {
        await menu.getByRole('button', { name: 'Close Orbit menu' }).click();
        await waitForMenuClose();
      }
      assert.equal(await scheme(), 'dark');
      assert.equal(await page.locator('.app > .toolbar').count(), 0);
      assert.equal(await page.locator('#session-list-pane').getByText('Orbit', { exact: true }).count(), 1);
      await openMenu();
      assert.equal(await menu.getByRole('button', { name: 'Build workstation', exact: true }).getAttribute('aria-current'), 'true');
      await menu.getByText('http://build.internal:7777', { exact: true }).waitFor();
      assert.equal(await menu.evaluate(el => el.scrollWidth > el.clientWidth + 1), false);
      await themeToggle.click();
      assert.equal(await scheme(), 'light');
      await page.keyboard.press('Escape');
      await waitForMenuClose();
      assert(await menuButton.evaluate(el => document.activeElement === el));
      await page.reload();
      await openMenu();
      assert.equal(await themeToggle.getAttribute('aria-pressed'), 'false');
      assert.equal(await scheme(), 'light');
      await themeToggle.click();
      assert.equal(await themeToggle.getAttribute('aria-pressed'), 'true');
      assert.equal(await scheme(), 'dark');
      await page.goBack();
      await waitForMenuClose();
      await page.reload();
      assert.equal(await scheme(), 'dark');
      const row = page.locator('.sessions .row').filter({ hasText: sessionName });
      await row.waitFor();
      assert.match(await row.innerText(), /running\s+CLI/);
      const overflow = selector => page.locator(selector).evaluate(el => el.scrollWidth > el.clientWidth + 1);
      assert.equal(await overflow('.sessions'), false, `session list overflows at ${width}px`);

      await page.getByTitle('New session', { exact: true }).click();
      const create = page.getByRole('dialog', { name: 'New session' });
      assert(await create.getByRole('radio', { name: 'CLI · Terminal' }).isChecked());
      assert.deepEqual(await create.locator('.sessionModeOptions label').allTextContents(), ['Web · Chat', 'CLI · Terminal']);
      assert.equal(await create.getByLabel('Name', { exact: true }).count(), 0);
      assert.equal(await create.getByLabel('Attach after run', { exact: true }).count(), 0);
      await create.getByRole('radio', { name: 'Web · Chat' }).check();
      assert.equal(await create.getByLabel('Environment', { exact: true }).count(), 0);
      await create.getByRole('button', { name: 'Cancel' }).click();
      await page.waitForFunction(() => !history.state?.orbitModal);
      await page.getByTitle('New session', { exact: true }).click();
      await create.getByRole('radio', { name: 'Web · Chat', exact: true }).check();
      await create.getByPlaceholder('cwd', { exact: true }).fill(project);
      await create.getByRole('button', { name: 'Run in temp folder', exact: true }).click();
      if (width === 320) {
        await create.getByRole('alert').getByText('Start failed', { exact: true }).waitFor();
        assert.equal(await create.getByPlaceholder('cwd', { exact: true }).inputValue(), tempPath);
        await create.getByRole('button', { name: 'Run', exact: true }).click();
      }
      await create.waitFor({ state: 'hidden' });
      await page.locator('.codexConnectionTitle').getByText('codex-temp-session', { exact: true }).waitFor();
      await page.getByText('Codex 연결됨', { exact: true }).waitFor();
      assert.equal(tempFoldersCreated, 1);
      assert.match(tempPath, /^\/home\/developer\/orbit-tmp-\d+-\d+$/);
      assert.deepEqual(submittedSession, { tool: 'codex', mode: 'web', env: {}, cwd: tempPath });
      if (mobile) await page.getByRole('button', { name: '세션 목록으로 돌아가기', exact: true }).click();
      await row.click();
      const terminal = page.locator('.cliSessionPane');
      const hideSessions = page.getByRole('button', { name: 'Hide session list' });
      if (mobile) {
        assert.equal(await hideSessions.count(), 0);
      } else {
        const divider = page.getByRole('separator', { name: 'Resize panes' });
        const pane = page.locator('#session-list-pane');
        assert.equal(await hideSessions.evaluate(button => button.previousElementSibling.textContent), 'Files');
        assert(await hideSessions.evaluate(button => {
          const tabs = button.parentElement;
          const right = tabs.getBoundingClientRect().right - parseFloat(getComputedStyle(tabs).paddingRight);
          return Math.abs(right - button.getBoundingClientRect().right) < 1;
        }));
        await divider.press('ArrowRight');
        const originalPaneWidth = (await pane.boundingBox()).width;
        const rail = await divider.boundingBox();
        assert.equal(rail.width, 1);
        const railY = rail.y + rail.height / 2;
        await page.mouse.move(rail.x + 3, railY);
        await page.mouse.down();
        await page.mouse.move(rail.x + 43, railY, { steps: 4 });
        await page.mouse.up();
        const initialPaneWidth = (await pane.boundingBox()).width;
        assert.equal(initialPaneWidth, originalPaneWidth + 40);
        const initialTerminalWidth = (await terminal.boundingBox()).width;
        await hideSessions.click();
        const showSessions = page.getByRole('button', { name: 'Show session list' });
        assert(await showSessions.evaluate(button => getComputedStyle(button).position === 'absolute' && !!button.closest('.sessionWorkPane')));
        assert.equal(await menuButton.isVisible(), false);
        assert.equal(await showSessions.getAttribute('aria-expanded'), 'false');
        assert.equal(await pane.isVisible(), false);
        assert.equal(await divider.isVisible(), false);
        assert((await terminal.boundingBox()).width > initialTerminalWidth);
        await showSessions.click();
        assert(await hideSessions.evaluate(el => document.activeElement === el));
        assert.equal((await pane.boundingBox()).width, initialPaneWidth);
        assert.equal((await terminal.boundingBox()).width, initialTerminalWidth);
        const movedRail = await divider.boundingBox();
        await page.mouse.move(movedRail.x + 3, railY);
        await page.mouse.down();
        await page.mouse.move(8, railY, { steps: 12 });
        assert((await pane.boundingBox()).width < 24);
        await page.mouse.up();
        await showSessions.waitFor();
        assert.equal(await pane.isVisible(), false);
        assert((await terminal.boundingBox()).width > initialTerminalWidth);
        assert(await showSessions.evaluate(el => document.activeElement === el));
        await showSessions.click();
        assert.equal((await pane.boundingBox()).width, initialPaneWidth);
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
      } else {
        const otherCard = page.locator('.sessionCard').filter({ hasText: '대화 작업' });
        const otherActions = otherCard.getByRole('button', { name: 'Actions for 대화 작업', exact: true });
        const sessionMenu = page.getByRole('dialog', { name: 'Session actions', exact: true });
        const before = await otherCard.boundingBox();
        await otherActions.click();
        await sessionMenu.waitFor();
        assert.deepEqual(await otherCard.boundingBox(), before);
        const menuBounds = await sessionMenu.boundingBox(), triggerBounds = await otherActions.boundingBox();
        assert(Math.abs(menuBounds.x + menuBounds.width - (triggerBounds.x + triggerBounds.width)) < 1);
        assert(menuBounds.y >= triggerBounds.y + triggerBounds.height);
        assert.equal(await sessionMenu.getByRole('button', { name: 'Detach', exact: true }).count(), 0);
        await page.keyboard.press('Escape');
        await sessionMenu.waitFor({ state: 'hidden' });
        assert(await otherActions.evaluate(el => document.activeElement === el));
        await otherActions.click();
        await page.locator('.sessionTitle strong').click();
        await sessionMenu.waitFor({ state: 'hidden' });
        await otherActions.click();
        await sessionMenu.getByRole('button', { name: 'Delete session', exact: true }).click();
        await otherCard.waitFor({ state: 'hidden' });
        assert.equal(deletedSession, 'fixture-web');
        assert.equal(await row.getAttribute('aria-current'), 'true');
        await terminal.waitFor();
        const card = page.locator('.sessionCard').filter({ hasText: sessionName });
        await card.getByLabel(`Actions for ${sessionName}`).click();
        await sessionMenu.getByRole('button', { name: 'Detach', exact: true }).click();
        await terminal.waitFor({ state: 'hidden' });
        await row.waitFor();
      }

      const sidebarAppearance = locator => locator.evaluate(panel => ({
        width: panel.getBoundingClientRect().width,
        background: getComputedStyle(panel).backgroundColor,
        listPadding: getComputedStyle(panel.querySelector('.paneList')).padding,
        rowRadius: getComputedStyle(panel.querySelector('.paneListItem')).borderRadius,
      }));
      const sessionsAppearance = await sidebarAppearance(page.locator('#session-list-pane'));
      await page.getByRole('button', { name: 'Files', exact: true }).click();
      const fileRow = page.getByRole('button', { name: 'README.md', exact: true });
      await fileRow.waitFor();
      assert.deepEqual(await sidebarAppearance(page.locator('.fileExplorer')), sessionsAppearance);
      assert.equal(await overflow('.fileExplorerList'), false, `file list overflows at ${width}px`);

      const newFolderButton = page.getByRole('button', { name: 'New folder', exact: true });
      const newFileButton = page.getByRole('button', { name: 'New file', exact: true });
      for (const button of [newFolderButton, newFileButton]) {
        assert.equal(await button.innerText(), '');
        assert.equal(await button.locator('svg').count(), 1);
      }
      assert.equal((await newFolderButton.boundingBox()).y, (await newFileButton.boundingBox()).y);
      assert(await newFileButton.isDisabled());
      await newFolderButton.click();
      const newFolder = page.getByRole('dialog', { name: 'New folder', exact: true });
      await newFolder.getByText(project, { exact: true }).waitFor();
      await newFolder.getByLabel('Name', { exact: true }).fill('notes');
      canCreateFile = true;
      await newFolder.getByRole('button', { name: 'Create', exact: true }).click();
      await newFolder.waitFor({ state: 'hidden' });
      await page.waitForFunction(() => !history.state?.orbitModal);
      await page.getByRole('button', { name: 'notes', exact: true }).waitFor();

      assert(await newFileButton.isEnabled());
      await newFileButton.click();
      const newFile = page.getByRole('dialog', { name: 'New file', exact: true });
      const fileName = newFile.getByLabel('Name', { exact: true });
      await fileName.fill('README.md');
      const createFile = newFile.getByRole('button', { name: 'Create', exact: true });
      await createFile.click();
      await newFile.getByRole('alert').getByText('An entry with that name already exists.', { exact: true }).waitFor();
      await fileName.fill('notes.txt');
      await createFile.click();
      await newFile.waitFor({ state: 'hidden' });
      await page.waitForFunction(() => !history.state?.orbitModal);
      await page.getByRole('button', { name: 'notes.txt', exact: true }).waitFor();
      await fileRow.click();
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
        await openMenu();
        await themeToggle.click();
        assert.equal(await scheme(), 'light');
        assert.equal(await syntaxColor(), 'rgb(0, 0, 255)');
        assert.equal(await code.innerText(), 'const unsaved = 2;');
        await themeToggle.click();
        await closeMenu();
      }
      await openMenu();
      await menu.getByRole('button', { name: 'Home workstation', exact: true }).click();
      await waitForMenuClose();
      await openMenu();
      assert.equal(await menu.getByRole('button', { name: 'Home workstation', exact: true }).getAttribute('aria-current'), 'true');
      await themeToggle.click();
      await Promise.all([
        page.waitForEvent('load'),
        menu.getByRole('button', { name: 'Refresh', exact: true }).click()
      ]);
      assert.equal(await scheme(), 'light');
      await menuButton.waitFor();
      assert.equal(await menu.count(), 0);
      await page.close();
    }
    console.log('Workspace layout passed at 320, 390 and 1440 pixels');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
