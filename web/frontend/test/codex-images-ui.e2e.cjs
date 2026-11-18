// Run in the Playwright container; execution host credentials arrive only via stdin.
const fs=require('node:fs');const {chromium}=require('/app/node_modules/playwright');
(async()=>{
 const c=JSON.parse(fs.readFileSync(0,'utf8')),browser=await chromium.launch({executablePath:chromium.executablePath(),headless:true,args:['--no-sandbox']});
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),name=`Codex Images QA ${Date.now()}`,errors=[];let session;
 page.on('pageerror',e=>errors.push(e.message));
 const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
 const small=Buffer.from(png,'base64'),large=Buffer.concat([small,Buffer.alloc(12*1024*1024)]);
 async function seed(p){await p.goto(c.webUrl);await p.evaluate(c=>{localStorage.setItem('orbit.connections',JSON.stringify([{id:'images-qa',label:'Images QA',url:c.orbitdUrl,token:c.token}]));localStorage.setItem('orbit.activeConnection','images-qa');},c);await p.reload();}
 async function paste(p,name){await p.getByRole('textbox',{name:'Codex 메시지'}).evaluate((node,{png,name})=>{const file=new File([Uint8Array.from(atob(png),x=>x.charCodeAt(0))],name,{type:'image/png'}),data=new DataTransfer();data.items.add(file);node.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));},{png,name});}
 async function ready(p,count){await p.waitForFunction(count=>document.querySelectorAll('.codexImageDraft.ready').length===count,count);}
 try{
  await seed(page);await page.getByTitle('New session',{exact:true}).click();let modal=page.getByRole('dialog');await modal.getByRole('radio', { name: 'Web · Chat', exact: true }).check();await modal.getByLabel('Name',{exact:true}).fill(name);await modal.getByPlaceholder('cwd',{exact:true}).fill(c.cwd);await modal.getByRole('button',{name:'Run',exact:true}).click();
  await page.getByText('Codex 연결됨',{exact:true}).waitFor({timeout:60000});await page.getByRole('button',{name:'이미지 첨부',exact:true}).click();await page.getByRole('button',{name:'이미지 선택',exact:true}).waitFor();
  await page.getByLabel('첨부할 이미지 선택',{exact:true}).setInputFiles({name:'selected.png',mimeType:'image/png',buffer:large});await ready(page,1);
  session=await page.evaluate(async({c,name})=>{const r=await fetch('/api/v1/sessions',{headers:{Authorization:'Bearer '+c.token,'x-orbitd-url':c.orbitdUrl}});return(await r.json()).find(s=>s.name===name);},{c,name});
  const savedPath=await page.locator('.codexImageDraft code').textContent();if(!savedPath.startsWith('/tmp/')||!savedPath.includes('/'+session.id+'/'))throw Error('Upload did not reach session-scoped host /tmp');
  const imageId=savedPath.split('/').at(-1);
  const downloaded=await page.evaluate(async({c,session,imageId})=>{const r=await fetch(`/api/v1/sessions/${session.id}/images/${imageId}`,{headers:{Authorization:'Bearer '+c.token,'x-orbitd-url':c.orbitdUrl}});return{status:r.status,size:(await r.arrayBuffer()).byteLength,mime:r.headers.get('content-type')};},{c,session,imageId});
  if(downloaded.status!==200||downloaded.size!==large.length||downloaded.mime!=='image/png')throw Error('Binary image roundtrip failed');
  await page.locator('.codexChat').evaluate((node,png)=>{const data=new DataTransfer();data.items.add(new File([Uint8Array.from(atob(png),x=>x.charCodeAt(0))],'dropped.png',{type:'image/png'}));node.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data}));},png);await ready(page,2);
  await paste(page,'pasted.png');await ready(page,3);
  let fail=true;await page.route('**/api/v1/sessions/*/images',route=>fail?route.fulfill({status:500,contentType:'application/json',body:'{"error":"QA upload failure"}'}):route.continue());
  await paste(page,'retry.png');await page.locator('.codexImageDraft.error').waitFor();if(await page.getByRole('button',{name:'전송 ↑',exact:true}).isEnabled())throw Error('Failed attachment allows send');
  fail=false;await page.getByRole('button',{name:'retry.png 다시 업로드',exact:true}).click();await ready(page,4);await page.getByRole('button',{name:'retry.png 첨부 해제',exact:true}).click();await ready(page,3);await page.unroute('**/api/v1/sessions/*/images');
  await page.setViewportSize({width:390,height:844});if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1))throw Error('Mobile attachments overflow');await page.screenshot({path:'/workspace/output/codex-images-mobile.png'});
  if(c.inference){
   await page.getByRole('textbox',{name:'Codex 메시지'}).fill('이미지 첨부를 확인하고 다른 도구는 실행하지 말고 ORB_IMAGE_OK 한 줄만 답해주세요.');await page.getByRole('button',{name:'전송 ↑',exact:true}).click();
   await page.locator('.codexMessage.agentMessage').filter({hasText:'ORB_IMAGE_OK'}).waitFor({timeout:120000});await page.waitForFunction(()=>!document.querySelector('.codexWorking'),{timeout:120000});
   await page.reload();await page.locator('.sessions .row').filter({hasText:name}).click();await page.getByText('Codex 연결됨',{exact:true}).waitFor();
   await page.waitForFunction(()=>document.querySelectorAll('.codexHistoryImage img').length===3);if(!(await page.locator('.codexHistoryImage code').first().textContent()).startsWith('/tmp/'))throw Error('History lost image path');
  }
  const mock=await browser.newPage(),ops=[];let queue={items:[],version:0,paused:false};const state=()=>({connected:true,activeTurn:'images-turn',settings:{},capabilities:{commands:true,steer:true,queue:true,images:true},approvals:[],queue});
  await mock.routeWebSocket('**/api/v1/sessions/*/codex?*',ws=>{ws.send(JSON.stringify({type:'ready',state:state()}));ws.onMessage(raw=>{const b=JSON.parse(String(raw));ops.push(b);let result={};if(b.op==='history')result={thread:{turns:[]},state:state()};if(b.op==='command')result={type:'help',commands:[]};if(b.op==='steer')result={steered:true};if(b.op==='queue'){queue={...queue,version:queue.version+1,items:[{id:'image-queue',text:b.text,images:b.images}]};result={queued:true,state:state()};}ws.send(JSON.stringify({type:'result',id:b.id,result}));});});
  await seed(mock);await mock.locator('.sessions .row').filter({hasText:name}).click();await mock.getByText('Codex 연결됨',{exact:true}).waitFor();await paste(mock,'steer.png');await ready(mock,1);await mock.getByRole('textbox',{name:'Codex 메시지'}).press('Enter');await mock.waitForFunction(()=>!document.querySelector('.codexImageDraft'));
  if(!ops.some(o=>o.op==='steer'&&o.text===''&&o.images.length===1))throw Error('Image-only steer lost attachment');
  await paste(mock,'queued.png');await ready(mock,1);await mock.getByRole('textbox',{name:'Codex 메시지'}).press('Tab');await mock.locator('.codexQueue').filter({hasText:'이미지 1개'}).waitFor();if(!ops.some(o=>o.op==='queue'&&o.images.length===1))throw Error('Queue lost attachment');await mock.close();
  if(errors.length)throw Error(errors.join('\n'));console.log(JSON.stringify({filePicker:true,drop:true,paste:true,hostTmp:true,binary12MiB:true,retry:true,mobile:true,nativeInference:!!c.inference,historyPreview:!!c.inference,imageOnlySteer:true,imageQueue:true}));
 }catch(e){console.log('Browser errors:',errors);console.log('Diagnostic:',(await page.locator('.codexChat').innerText().catch(()=>'' )).slice(-1200));throw e;}
 finally{await page.evaluate(async({c,name})=>{const headers={Authorization:'Bearer '+c.token,'x-orbitd-url':c.orbitdUrl};const r=await fetch('/api/v1/sessions',{headers});if(!r.ok)return;const s=(await r.json()).find(s=>s.name===name&&s.mode==='web');if(s)await fetch('/api/v1/sessions/'+s.id,{method:'DELETE',headers});},{c,name}).catch(()=>{});await browser.close();}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
