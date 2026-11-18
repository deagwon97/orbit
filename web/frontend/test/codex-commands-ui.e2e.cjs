const fs = require('node:fs');
const {chromium} = require('/app/node_modules/playwright');
(async()=>{
 const c=JSON.parse(fs.readFileSync(0,'utf8'));
 const browser=await chromium.launch({executablePath:chromium.executablePath(),headless:true,args:['--no-sandbox']});
 const page=await browser.newPage({viewport:{width:1440,height:1000}});
 const name=`Codex Commands UI QA ${Date.now()}`;
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 async function seed(p){await p.goto(c.webUrl);await p.evaluate(c=>{localStorage.setItem('orbit.connections',JSON.stringify([{id:'commands',label:'Commands QA',url:c.orbitdUrl,token:c.token}]));localStorage.setItem('orbit.activeConnection','commands');},c);await p.reload();}
 async function typeCommand(p,text){
  await p.waitForFunction(()=>document.querySelector('.codexComposerMeta > button')?.disabled===false);
  const box=p.getByRole('textbox',{name:'Codex 메시지'});
  await box.fill(text);
  if(text==='/sta')await p.getByRole('option').filter({hasText:'/status'}).waitFor();
  if(p.viewportSize().width<=820)await p.getByRole('button',{name:'명령 실행',exact:true}).click();
  else await box.press('Enter');
 }
 try{
  await seed(page);await page.getByTitle('New session',{exact:true}).click();const modal=page.getByRole('dialog');
  await modal.getByRole('radio', { name: 'Web · Chat', exact: true }).check();await modal.getByLabel('Name',{exact:true}).fill(name);await modal.getByPlaceholder('cwd',{exact:true}).fill(c.cwd);await modal.getByRole('button',{name:'Run',exact:true}).click();
  await page.getByText('Codex 연결됨',{exact:true}).waitFor({timeout:60000});
  await typeCommand(page,'/sta');await page.getByRole('dialog',{name:'세션 상태'}).waitFor();await page.getByRole('dialog').press('Escape');
  await typeCommand(page,'/model');let dialog=page.getByRole('dialog',{name:'모델 및 추론 강도'});await dialog.waitFor();
  const model=await dialog.getByLabel('모델 선택',{exact:true}).inputValue();if(!model)throw Error('No model selected');
  const effortOptions=await dialog.getByLabel('추론 강도 선택',{exact:true}).locator('option').evaluateAll(nodes=>nodes.map(n=>n.value).filter(Boolean));
  const effort=effortOptions.includes('low')?'low':effortOptions[0];
  await dialog.getByLabel('추론 강도 선택',{exact:true}).selectOption(effort);await dialog.getByRole('button',{name:'적용',exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('.codexControls')?.textContent.includes('명령 처리 중…'));
  if(await dialog.getByLabel('추론 강도 선택',{exact:true}).inputValue()!==effort)throw Error('Effort not applied');
  await dialog.getByRole('button',{name:'명령 창 닫기'}).click();
  await typeCommand(page,'/status');dialog=page.getByRole('dialog',{name:'세션 상태'});await dialog.waitFor();
  if(!(await dialog.innerText()).includes(effort))throw Error('Status does not reflect effort');await dialog.getByRole('button',{name:'명령 창 닫기'}).click();
  await typeCommand(page,'/permissions full-access');dialog=page.getByRole('dialog',{name:'작업 권한'});await dialog.waitFor();
  if(await dialog.getByRole('button',{name:'전체 접근 적용',exact:true}).isEnabled())throw Error('Full access has no confirmation gate');
  await dialog.getByRole('button',{name:'읽기 전용',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.codexControls')?.textContent.includes('readOnly'));
  await dialog.getByRole('button',{name:'작업 폴더 수정',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.codexControls')?.textContent.includes('workspaceWrite'));
  await dialog.getByRole('button',{name:'명령 창 닫기'}).click();
  await typeCommand(page,'/does-not-exist');await page.locator('.codexError').filter({hasText:'지원하지 않는 명령'}).waitFor();if(await page.getByRole('textbox',{name:'Codex 메시지'}).inputValue()!=='/does-not-exist')throw Error('Invalid command draft lost');
  await page.setViewportSize({width:390,height:844});await typeCommand(page,'/model');await page.getByRole('dialog',{name:'모델 및 추론 강도'}).waitFor();
  if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1))throw Error('Mobile command dialog overflow');
  await page.screenshot({path:'/workspace/output/codex-commands-mobile.png'});
  await page.getByRole('button',{name:'명령 창 닫기'}).click();await page.setViewportSize({width:1440,height:1000});
  await typeCommand(page,'/status');await page.getByRole('dialog',{name:'세션 상태'}).waitFor();await page.screenshot({path:'/workspace/output/codex-commands-desktop.png'});
  const mock=await browser.newPage();let client;let queue={items:[],paused:false,error:null,version:0};const operations=[];
  const commands=[{name:'status',description:'세션 상태',duringTask:true},{name:'model',description:'모델',duringTask:true},{name:'compact',description:'문맥 압축',duringTask:false}];
  const snapshot=()=>({activeTurn:'mock-turn',connected:true,settings:{model:'GPT-6.1-Sol',effort:'medium',serviceTier:'priority',cwd:'/home/bdg/project/agent-analysis'},approvals:[],queue,capabilities:{commands:true,steer:true,queue:true}});
  await mock.routeWebSocket('**/api/v1/sessions/*/codex?*',ws=>{client=ws;ws.send(JSON.stringify({type:'ready',state:snapshot()}));ws.onMessage(raw=>{
   const b=JSON.parse(String(raw));operations.push(b);let result={};
   if(b.op==='history')result={thread:{turns:[{id:'mock-turn',status:'inProgress',items:[{id:'earlier-input',type:'userMessage',content:[{type:'text',text:'이전 입력 첫 줄\n이전 입력 두 번째 줄'}]},{id:'design-user',type:'userMessage',content:[{type:'text',text:'현재 프로젝트를 확인하고 변경 사항을 정리해줘.'}]},{id:'design-work',type:'commandExecution',status:'completed',command:'rg --files src',aggregatedOutput:'src/CodexChat.tsx\nsrc/CodexControls.tsx\nsrc/styles/codex-chat.css\nsrc/main.tsx',exitCode:0},{id:'design-answer',type:'agentMessage',text:'## 프로젝트를 확인했습니다\n채팅 화면과 세션 연결 구조를 살펴봤습니다. **작업 중 출력**도 대화 흐름에서 확인할 수 있습니다.\n\n- 세션별 실행 호스트와 작업 폴더 표시\n- 모델과 추론 강도 변경\n- 추가 지시와 다음 턴 예약\n\n| 항목 | 상태 |\n| --- | --- |\n| 대화 명령 | 적용 완료 |\n| 모바일 키보드 | 유지 |\n\n다음으로 변경한 화면을 검증하겠습니다.'}]}]},state:snapshot()};
   if(b.op==='command'){if(b.command==='/help')result={type:'help',commands};else if(b.command==='/status')result={type:'status',state:snapshot()};else {ws.send(JSON.stringify({type:'error',id:b.id,error:'작업이 끝난 뒤 실행하세요.'}));return;}}
   if(b.op==='steer')result={steered:true};
   if(b.op==='queue'){queue={...queue,version:queue.version+1,items:[...queue.items,{id:'q'+queue.version,text:b.text}]};result={queued:true,state:snapshot()};}
   if(b.op==='queue/remove'){queue={...queue,version:queue.version+1,items:queue.items.filter(x=>x.id!==b.entryId)};result=snapshot();}
   ws.send(JSON.stringify({type:'result',id:b.id,result}));
  });});
  await seed(mock);await mock.locator('.sessions .row').filter({hasText:name}).click();await mock.getByText('Codex 연결됨',{exact:true}).waitFor();
  const input=mock.getByRole('textbox',{name:'Codex 메시지'});
  const expectInput=async value=>{if(await input.inputValue()!==value)throw Error('Unexpected history input: '+await input.inputValue());};
  await input.fill('작성 중인 초안');
  await input.press('ArrowUp');await expectInput('현재 프로젝트를 확인하고 변경 사항을 정리해줘.');
  await input.press('ArrowUp');await expectInput('이전 입력 첫 줄\n이전 입력 두 번째 줄');
  await input.press('ArrowUp');await expectInput('이전 입력 첫 줄\n이전 입력 두 번째 줄');
  await input.press('ArrowDown');await expectInput('현재 프로젝트를 확인하고 변경 사항을 정리해줘.');
  await input.press('ArrowDown');await expectInput('작성 중인 초안');
  await input.fill('첫 줄\n두 번째 줄');
  await input.press('End');await input.press('ArrowUp');await expectInput('첫 줄\n두 번째 줄');
  if(await input.evaluate(el=>el.selectionStart)>='첫 줄'.length+1)throw Error('Multiline up key did not move the cursor');
  await input.fill('/');
  await mock.getByRole('option',{selected:true}).waitFor();
  const optionBefore=await mock.getByRole('option',{selected:true}).innerText();
  await input.press('ArrowDown');await expectInput('/');
  if(await mock.getByRole('option',{selected:true}).innerText()===optionBefore)throw Error('Arrow key did not move the command selection');
  await mock.getByRole('textbox',{name:'Codex 메시지'}).fill('작업 중 보충 지시');await mock.getByRole('textbox',{name:'Codex 메시지'}).press('Enter');
  await mock.waitForFunction(()=>document.querySelector('textarea').value==='');if(!operations.some(op=>op.op==='steer'&&op.text==='작업 중 보충 지시'))throw Error('Enter did not steer');
  await mock.getByRole('textbox',{name:'Codex 메시지'}).fill('다음 턴 지시');await mock.getByRole('textbox',{name:'Codex 메시지'}).press('Tab');
  await mock.locator('.codexQueue').waitFor();
  if(!operations.some(op=>op.op==='queue'&&op.text==='다음 턴 지시'))throw Error('Tab did not enqueue');
  await input.press('ArrowUp');await expectInput('다음 턴 지시');
  await input.press('ArrowDown');await expectInput('');
  await typeCommand(mock,'대기열이 있어도 즉시 반영');if(!operations.some(op=>op.op==='steer'&&op.text==='대기열이 있어도 즉시 반영'))throw Error('Queued message intercepted steer');
  await typeCommand(mock,'/status');await mock.getByRole('dialog',{name:'세션 상태'}).waitFor();await mock.getByRole('button',{name:'명령 창 닫기'}).click();
  await mock.locator('.codexQueue').getByRole('button',{name:'취소',exact:true}).click();await mock.waitForFunction(()=>!document.querySelector('.codexQueue'));
  await mock.setViewportSize({width:390,height:844});
  if(await mock.getByRole('button',{name:'키보드와 단축키'}).count())throw Error('Keyboard button remains');
  await mock.getByRole('textbox',{name:'Codex 메시지'}).fill('이 부분도 함께 확인해줘');
  if(await mock.locator('.codexComposerMeta > button').innerText()!=='GPT-6.1-Sol · medium · Fast')throw Error('Model status missing');
  if(await mock.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1))throw Error('Mobile chat overflow');
  await mock.locator('.codexMessages').evaluate(n=>n.scrollTop=0);await mock.screenshot({path:'/workspace/output/codex-design-mobile.png'});
  await mock.setViewportSize({width:1440,height:1000});await mock.screenshot({path:'/workspace/output/codex-design-desktop.png'});
  await mock.close();if(errors.length)throw Error(errors.join('\n'));
  console.log(JSON.stringify({status:true,modelAndEffort:true,permissions:true,fullAccessConfirmation:true,autocomplete:true,inputHistory:true,unknownCommandPreserved:true,busyStatus:true,enterSteer:true,tabQueue:true,queueCancellation:true,mobile:true}));
 } catch(error){console.log('Diagnostic:',(await page.locator('.codexChat').innerText().catch(()=>'' )).slice(-900));throw error;}
 finally{
  await page.evaluate(async({c,name})=>{const headers={Authorization:'Bearer '+c.token,'x-orbitd-url':c.orbitdUrl};const r=await fetch('/api/v1/sessions',{headers});if(!r.ok)return;const s=(await r.json()).find(s=>s.name===name&&s.mode==='web');if(s)await fetch('/api/v1/sessions/'+s.id,{method:'DELETE',headers});},{c,name}).catch(()=>{});await browser.close();
 }
})().catch(e=>{console.error(e.message);process.exitCode=1;});
