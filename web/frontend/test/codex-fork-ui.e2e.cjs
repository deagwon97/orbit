// Uses two short turns in an isolated QA session. Connection settings are supplied on stdin.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('/app/node_modules/playwright');

(async () => {
  const config = JSON.parse(fs.readFileSync(0, 'utf8'));
  const browser = await chromium.launch({ executablePath: chromium.executablePath(), headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  let name, branchName;
  const headers = { Authorization: 'Bearer ' + config.token, 'x-orbitd-url': config.orbitdUrl };
  const sessions = () => page.evaluate(async headers => {
    const response = await fetch('/api/v1/sessions', { headers });
    if (!response.ok) throw Error('Unable to list QA sessions');
    return response.json();
  }, headers);
  const row = value => page.locator('.sessionName').getByText(value, { exact: true });
  const fork = page.getByRole('button', { name: 'Fork here', exact: true });
  const textbox = page.getByRole('textbox', { name: 'Codex 메시지' });

  try {
    await page.goto(config.webUrl);
    await page.evaluate(config => {
      localStorage.setItem('orbit.connections', JSON.stringify([{ id: 'fork-qa', label: 'Fork QA', url: config.orbitdUrl, token: config.token }]));
      localStorage.setItem('orbit.activeConnection', 'fork-qa');
    }, config);
    await page.reload();
    await page.getByTitle('New session', { exact: true }).click();
    const form = page.getByRole('dialog', { name: 'New session' });
    await form.getByRole('radio', { name: 'Web · Chat', exact: true }).check();
    await form.getByPlaceholder('cwd', { exact: true }).fill(config.cwd);
    const [created] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/sessions' && response.request().method() === 'POST'),
      form.getByRole('button', { name: 'Run', exact: true }).click()
    ]);
    if (!created.ok()) throw Error('QA session creation failed: ' + created.status());
    name = (await created.json()).name;
    branchName = name + ' · 포크';
    await page.getByText('Codex 연결됨', { exact: true }).waitFor();
    const source = (await sessions()).find(session => session.name === name);
    assert(source && Number.isInteger(source.pid) && source.pid > 0);

    for (const [index, word] of ['ORBIT_FORK_FIRST', 'ORBIT_FORK_SECOND'].entries()) {
      await textbox.fill(`도구를 실행하지 말고 ${word} 한 줄만 답해 주세요.`);
      await page.getByRole('button', { name: '전송 ↑', exact: true }).click();
      await fork.nth(index).waitFor({ timeout: 90000 });
    }
    await page.locator('.agentMessage').filter({ hasText: 'ORBIT_FORK_SECOND' }).waitFor();
    assert.equal(await fork.count(), 2);
    await fork.first().click();
    const branchTitle = page.locator('.codexConnectionTitle').getByText(branchName, { exact: true });
    await branchTitle.or(page.locator('.codexError')).waitFor();
    assert(await branchTitle.isVisible(), await page.locator('.codexError').allTextContents());
    await page.getByText('Codex 연결됨', { exact: true }).waitFor();
    await page.locator('.agentMessage').filter({ hasText: 'ORBIT_FORK_FIRST' }).waitFor();
    assert.equal(await page.locator('.codexMessages').getByText(/ORBIT_FORK_SECOND/).count(), 0);
    const after = await sessions();
    const branch = after.find(session => session.name === branchName);
    assert(branch && branch.mode === 'web');
    assert(Number.isInteger(branch.pid) && branch.pid > 0);
    assert.notEqual(branch.pid, source.pid);
    assert.notEqual(branch.id, source.id);
    assert.notEqual(branch.codex_thread_id, source.codex_thread_id);
    assert.equal(branch.cwd, source.cwd);
    assert.equal(after.find(session => session.id === source.id).codex_thread_id, source.codex_thread_id);

    await page.getByRole('button', { name: '세션 목록으로 돌아가기' }).click();
    await row(name).click();
    await page.getByText('Codex 연결됨', { exact: true }).waitFor();
    await page.locator('.agentMessage').filter({ hasText: 'ORBIT_FORK_SECOND' }).waitFor();
    assert.equal((await sessions()).find(session => session.id === source.id).pid, source.pid);
    console.log('Fork opened a separate Orbit session through the first completed turn and preserved the source history');
  } finally {
    await page.evaluate(async ({ name, branchName, headers }) => {
      const response = await fetch('/api/v1/sessions', { headers });
      if (!response.ok) return;
      for (const session of (await response.json()).filter(s => s.name === name || s.name === branchName)) {
        await fetch('/api/v1/sessions/' + encodeURIComponent(session.id), { method: 'DELETE', headers });
      }
    }, { name, branchName, headers }).catch(() => {});
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
