// Isolated QA conversations only. Credentials come from stdin.
const fs=require('node:fs'),{chromium}=require('/app/node_modules/playwright');
(async()=>{
 const c=JSON.parse(fs.readFileSync(0,'utf8')),browser=await chromium.launch({executablePath:chromium.executablePath(),headless:true,args:['--no-sandbox']}),page=await browser.newPage({viewport:{width:1440,height:1000}});
 const tag=`Resume QA ${Date.now()}`,ids=[],errors=[];page.on('pageerror',e=>errors.push(e.message));
 const headers={Authorization:'Bearer '+c.token,'x-orbitd-url':c.orbitdUrl};
 async function command(text){const box=page.getByRole('textbox',{name:'Codex 메시지'});await box.fill(text);await box.press('Enter');}
 async function sessions(){return page.evaluate(async headers=>{const r=await fetch('/api/v1/sessions',{headers});return r.json();},headers);}
 async function create(name){await page.getByTitle('New session',{exact:true}).click();const modal=page.getByRole('dialog');await modal.getByLabel('Open with').selectOption('web');await modal.getByLabel('Name',{exact:true}).fill(name);await modal.getByPlaceholder('cwd',{exact:true}).fill(c.cwd);await modal.getByRole('button',{name:'Run',exact:true}).click();await page.getByText('Codex 연결됨',{exact:true}).waitFor({timeout:60000});const s=(await sessions()).find(s=>s.name===name);ids.push(s.id);return s;}
 async function closeDialog(){await page.getByRole('button',{name:'명령 창 닫기'}).click();}
 try{
  await page.goto(c.webUrl);await page.evaluate(c=>{localStorage.setItem('orbit.connections',JSON.stringify([{id:'resume-qa',label:'Resume QA',url:c.orbitdUrl,token:c.token}]));localStorage.setItem('orbit.activeConnection','resume-qa');},c);await page.reload();
  const target=await create(tag+' Target');await page.locator('.codexYolo').waitFor();
  await page.getByRole('textbox',{name:'Codex 메시지'}).fill('다른 도구는 실행하지 말고 ORB_RESUME_OK 한 줄만 답해주세요.');await page.getByRole('button',{name:'전송 ↑',exact:true}).click();await page.locator('.codexMessage.agentMessage').filter({hasText:'ORB_RESUME_OK'}).waitFor({timeout:120000});await page.waitForFunction(()=>!document.querySelector('.codexWorking'),{timeout:120000});
  await command('/rename '+tag+' Saved');await page.getByText('대화 이름을 “'+tag+' Saved”으로 변경했습니다.',{exact:true}).waitFor();await closeDialog();
  await command('/permissions read-only');await page.getByRole('dialog',{name:'작업 권한'}).getByText('readOnly',{exact:true}).waitFor();await closeDialog();
  await page.evaluate(async({headers,id})=>{const r=await fetch('/api/v1/sessions/'+id+'/stop',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:'{}'});if(!r.ok)throw Error('Stop failed');},{headers,id:target.id});
  const current=await create(tag+' Current'),beforeCount=(await sessions()).length;
  await command('/status');let dialog=page.getByRole('dialog',{name:'세션 상태'});await dialog.getByText('dangerFullAccess',{exact:true}).waitFor();await dialog.getByText('never',{exact:true}).waitFor();await closeDialog();
  await command('/resume');dialog=page.getByRole('dialog',{name:'이전 대화 이어가기'});await dialog.waitFor();await dialog.getByLabel('이전 대화 검색',{exact:true}).fill(tag+' Saved');await dialog.getByRole('button',{name:'검색',exact:true}).click();
  const choice=dialog.locator('.codexResumeList button').filter({hasText:target.codex_thread_id});await choice.waitFor();await page.setViewportSize({width:390,height:844});if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1))throw Error('Resume dialog mobile overflow');await page.screenshot({path:'/workspace/output/codex-resume-mobile.png'});await choice.click();
  await page.locator('.codexMessage.agentMessage').filter({hasText:'ORB_RESUME_OK'}).waitFor({timeout:60000});await page.getByText('Codex 연결됨',{exact:true}).waitFor();
  let all=await sessions(),switched=all.find(s=>s.id===current.id);if(switched.codex_thread_id!==target.codex_thread_id||all.length!==beforeCount)throw Error('Resume created a new Orb session or changed the wrong thread');
  await command('/status');dialog=page.getByRole('dialog',{name:'세션 상태'});await dialog.getByText('readOnly',{exact:true}).waitFor();await dialog.getByText('on-request',{exact:true}).waitFor();await closeDialog();
  await command('/resume 99999999-9999-4999-8999-999999999999');await page.locator('.codexError').waitFor();if((await sessions()).find(s=>s.id===current.id).codex_thread_id!==target.codex_thread_id)throw Error('Failed resume lost the current thread');
  await page.reload();await page.locator('.sessions .row').filter({hasText:current.id}).click();await page.locator('.codexMessage.agentMessage').filter({hasText:'ORB_RESUME_OK'}).waitFor();
  if(errors.length)throw Error(errors.join('\n'));console.log(JSON.stringify({defaultYolo:true,resumeSearch:true,sameOrbId:true,noNewOrbSession:true,historyRestored:true,savedPermissionsPreserved:true,failedSwitchPreservesCurrent:true,reload:true,mobile:true}));
 }catch(e){console.log('Diagnostic:',(await page.locator('.codexChat').innerText().catch(()=>'' )).slice(-1600));console.log('Browser errors:',errors);throw e;}
 finally{await page.evaluate(async({headers,ids})=>{for(const id of ids.reverse())await fetch('/api/v1/sessions/'+id,{method:'DELETE',headers});},{headers,ids}).catch(()=>{});await browser.close();}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
