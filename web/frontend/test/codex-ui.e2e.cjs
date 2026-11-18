// Run in the repository's Playwright container; configuration (including token) comes from stdin.
const fs = require('node:fs');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || '/app/node_modules/playwright');
(async () => {
  const config = JSON.parse(fs.readFileSync(0, 'utf8'));
  const browser = await chromium.launch({ executablePath: chromium.executablePath(), headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const name = `Codex Web QA ${Date.now()}`;
  try {
    await page.goto(config.webUrl);
    await page.evaluate(config => {
      localStorage.setItem('orbit.connections', JSON.stringify([{ id: 'codex-test', label: 'Codex Web Dev', url: config.orbitdUrl, token: config.token }]));
      localStorage.setItem('orbit.activeConnection', 'codex-test');
    }, config);
    await page.reload();
    await page.getByTitle('New session', { exact: true }).click();
    const modal = page.getByRole('dialog');
    await modal.getByRole('radio', { name: 'Web · Chat', exact: true }).check();
    if (await modal.getByLabel('Environment', { exact: true }).count()) throw Error('Web mode exposes unsupported environment overrides');
    await modal.getByLabel('Name', { exact: true }).fill(name);
    await modal.getByPlaceholder('cwd', { exact: true }).fill(config.cwd);
    await modal.getByRole('button', { name: 'Run', exact: true }).click();
    await page.getByText('Codex 연결됨', { exact: true }).waitFor({ timeout: 60000 });
    const session = await page.evaluate(async ({ name, config }) => {
      const result = await fetch('/api/v1/sessions', { headers: { Authorization: `Bearer ${config.token}`, 'x-orbitd-url': config.orbitdUrl } });
      return (await result.json()).find(session => session.name === name);
    }, { name, config });
    if (!session || !Number.isInteger(session.pid) || session.pid <= 0 || session.mode !== 'web' || !session.codex_thread_id) throw Error('Web worker or thread mapping invalid');
    if (config.inference) {
      await page.getByRole('textbox', { name: 'Codex 메시지' }).fill('다른 도구를 실행하지 말고 ORB_WEB_OK 한 줄만 답해주세요.');
      await page.getByRole('button', { name: '전송 ↑', exact: true }).click();
      await page.locator('.codexMessage.agentMessage').filter({ hasText: 'ORB_WEB_OK' }).waitFor({ timeout: 120000 });
      await page.getByRole('button', { name: '전송 ↑', exact: true }).waitFor({ state: 'visible' });
      await page.waitForFunction(() => !document.querySelector('.codexWorking'), { timeout: 120000 });
    }
    await page.reload();
    await page.locator('.sessions .row').filter({ hasText: name }).click();
    await page.getByText('Codex 연결됨', { exact: true }).waitFor({ timeout: 60000 });
    if (config.inference) await page.locator('.codexMessage.agentMessage').filter({ hasText: 'ORB_WEB_OK' }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(200);
    const horizontal = await page.locator('.codexChat').evaluate(node => node.scrollWidth > node.clientWidth + 1);
    if (horizontal) throw Error('Chat overflows on mobile');
    await page.screenshot({ path: '/workspace/output/codex-orb-mobile.png' });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({ path: '/workspace/output/codex-orb-desktop.png' });
    if (errors.length) throw Error(errors.join('\n'));
    // Validate legacy-backend capability gating in a separate, fresh page.
    const legacy = await browser.newPage(); await legacy.goto(config.webUrl);
    await legacy.evaluate(config => {
      localStorage.setItem('orbit.connections', JSON.stringify([{ id: 'legacy', label: 'Legacy orbitd', url: config.legacyUrl, token: config.token }]));
      localStorage.setItem('orbit.activeConnection', 'legacy');
    }, config);
    await legacy.reload(); await legacy.getByTitle('New session', { exact: true }).click();
    const legacyOption = legacy.getByRole('radio', { name: 'Web · Chat', exact: true });
    if (!(await legacyOption.evaluate(node => node.disabled))) { console.log('Legacy option diagnostic:', await legacyOption.evaluate(node => node.outerHTML)); throw Error('Legacy server incorrectly offers Web mode'); }
    await legacy.close();
    // Exercise approval and question forms without invoking tools or the model.
    const forms = await browser.newPage();
    const requests = [
      { id: 1, method: 'item/commandExecution/requestApproval', params: { turnId: 'forms-turn', command: 'echo test', availableDecisions: ['decline'] } },
      { id: 2, method: 'item/fileChange/requestApproval', params: { turnId: 'forms-turn', itemId: 'file', availableDecisions: ['accept', 'decline'] } },
      { id: 3, method: 'item/tool/requestUserInput', params: { turnId: 'forms-turn', questions: [{ id: 'language', question: '언어를 선택하세요', options: [{ label: 'TypeScript' }] }] } }
    ];
    const replies = [];
    let currentRequest = 0;
    await forms.routeWebSocket('**/api/v1/sessions/*/codex?*', ws => {
      const live = () => ({ connected: true, activeTurn: 'forms-turn', approvals: currentRequest < requests.length ? [requests[currentRequest]] : [] });
      ws.send(JSON.stringify({ type: 'ready', state: live() }));
      ws.onMessage(raw => {
        const body = JSON.parse(String(raw));
        if (body.op === 'history') ws.send(JSON.stringify({ type: 'result', id: body.id, result: { thread: { turns: [{ id: 'forms-turn', status: 'inProgress', items: [{ id: 'file', type: 'fileChange', status: 'inProgress', changes: [{ path: 'src/example.ts', diff: '- old\n+ new' }] }] }] }, state: live() } }));
        else if (body.op === 'reply') {
          replies.push(body);
          ws.send(JSON.stringify({ type: 'result', id: body.id, result: {} }));
          ws.send(JSON.stringify({ type: 'resolved', requestId: requests[currentRequest].id }));
          currentRequest++;
          if (currentRequest < requests.length) ws.send(JSON.stringify({ type: 'request', message: requests[currentRequest] }));
        }
      });
    });
    await forms.goto(config.webUrl);
    await forms.evaluate(config => {
      localStorage.setItem('orbit.connections', JSON.stringify([{ id: 'forms', label: 'Forms QA', url: config.orbitdUrl, token: config.token }]));
      localStorage.setItem('orbit.activeConnection', 'forms');
    }, config);
    await forms.reload(); await forms.locator('.sessions .row').filter({ hasText: name }).click();
    await forms.getByText('Codex 연결됨', { exact: true }).waitFor();
    if (await forms.locator('.codexApproval').getByRole('button', { name: '이번만 허용', exact: true }).count()) throw Error('Unavailable approval decision exposed');
    await forms.locator('.codexApproval').getByRole('button', { name: '거부', exact: true }).click();
    await forms.locator('.codexApproval').getByText('src/example.ts', { exact: true }).waitFor();
    await forms.locator('.codexApproval').getByRole('button', { name: '이번만 허용', exact: true }).click();
    await forms.getByRole('button', { name: 'TypeScript', exact: true }).click();
    await forms.getByRole('button', { name: '응답 보내기', exact: true }).click();
    await forms.waitForFunction(() => document.querySelectorAll('.codexApproval').length === 0);
    if (replies[0].decision !== 'decline' || replies[1].decision !== 'accept' || replies[2].answers.language !== 'TypeScript') throw Error('Approval/question reply mismatch');
    await forms.close();

    console.log(JSON.stringify({ webCreate: true, noPty: true, threadMapped: true, inference: !!config.inference, refreshHistory: true, mobile: true, legacyCliDefault: true, approvalForms: true, questions: true, sessionId: session.id }));
  } catch (error) {
    console.log('Chat diagnostic:', (await page.locator('.codexChat').innerText().catch(() => 'Chat was not mounted')).slice(0,900));
    await page.screenshot({path:'/workspace/output/codex-orb-error.png'}); throw error;
  } finally {
    await page.evaluate(async ({ config, name }) => {
      const headers = { Authorization: `Bearer ${config.token}`, 'x-orbitd-url': config.orbitdUrl };
      const response = await fetch('/api/v1/sessions', { headers });
      if (!response.ok) return;
      const own = (await response.json()).find(session => session.name === name && session.mode === 'web');
      if (own) await fetch(`/api/v1/sessions/${encodeURIComponent(own.id)}`, { method: 'DELETE', headers });
    }, { config, name }).catch(() => {});
    await browser.close();
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
