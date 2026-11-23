// Browser layout, Back navigation and interrupt checks with fixture HTTP and WebSocket responses.
const fs=require('node:fs'),{chromium}=require('/app/node_modules/playwright');
(async()=>{
 const c=JSON.parse(fs.readFileSync(0,'utf8')),browser=await chromium.launch({executablePath:chromium.executablePath(),headless:true,args:['--no-sandbox']}),page=await browser.newPage({viewport:{width:390,height:844},hasTouch:true,isMobile:true}),name=`Mobile UI QA ${Date.now()}`,errors=[],ops=[];let active=true,wsClient,wsAttempts=0,failConnections=false;
 await page.addInitScript(() => {
  Object.defineProperty(navigator.serviceWorker, 'ready', {value:Promise.resolve({
   pushManager:{subscribe:async ({userVisibleOnly,applicationServerKey})=>{
    if(!userVisibleOnly||applicationServerKey[0]!==1)throw Error('Missing Web Push options');
    return {endpoint:'https://fcm.googleapis.com/fcm/send/fixture'};
   }},
  })});
  Object.defineProperty(window, 'SpeechRecognition', {value:undefined,configurable:true});
  window.webkitSpeechRecognition = class {
   start() {
    window.voiceFixture = this;
    queueMicrotask(() => this.onstart?.());
   }
   stop() {
    queueMicrotask(() => {
     this.onresult?.({resultIndex:1,results:[
      Object.assign([{transcript:'이전 결과'}],{isFinal:true}),
      Object.assign([{transcript:' 음성으로 추가한 내용 '}],{isFinal:true}),
      Object.assign([{transcript:' 임시 결과 '}],{isFinal:false}),
     ]});
     this.onend?.();
    });
   }
   abort() {
    window.voiceAborted = true;
    this.onend?.();
   }
  };
 });
 const diagramAnswer=[
  '~~~', 'flowchart TB',
  '  subgraph ORB["orb · 터미널 클라이언트"]', '    Entry["orb 실행"] -->|"인자 없이 실행"| TUI["TUI"]',
  '    Entry -->|"하위 명령"| CLI["CLI"]', '    TUI --> Client["internal/client"]', '    CLI --> Client', '  end',
  '  Browser["브라우저 · React 웹 UI"] --> Proxy["Fastify 프록시"]',
  '  Client --> Daemon["orbitd"]', '  Proxy --> Daemon',
  '  Daemon --> Session["Session"] --> Worker["Worker"] --> State["State"]', '~~~', '',
  '~~~svg', '<svg viewBox="0 0 200 60" xmlns="http://www.w3.org/2000/svg"><text x="10" y="30">SVG diagram</text></svg>', '~~~', '',
  '~~~html', '<!doctype html><html><head><style>article{display:flex;gap:16px}</style></head><body><article><span>Start</span> → <span>Finish</span></article><img src="/diagram-preview-fixture.png" alt=""><script>document.body.dataset.previewScript = "ran";</script></body></html>', '~~~', '',
  '~~~mermaid', 'flowchart LR', '  A -->', '~~~',
 ].join('\n');
 const startedAt=Math.floor((Date.now()-234000)/1000),settings={model:'gpt-6.1-sol-long-model-name-layout-check',effort:'medium',serviceTier:'priority',approvalPolicy:'never',sandboxPolicy:{type:'dangerFullAccess'},cwd:'/home/bdg/project/a-very-long-project-folder/mobile-layout-and-working-status-validation'};
 let queue={items:[],version:0,paused:false};
 const snapshot=()=>({connected:true,activeTurn:active?'ui-turn':null,settings,tokenUsage:{total:{inputTokens:123456,cachedInputTokens:64000,outputTokens:3456,totalTokens:126912},last:{totalTokens:12000},modelContextWindow:200000},capabilities:{commands:true,steer:true,queue:true,images:true,fileAttachments:true,resume:true},approvals:[],queue});
 const limits={rateLimits:{limitName:'Codex',primary:{usedPercent:20,windowDurationMins:300,resetsAt:Math.floor(Date.now()/1000)+3600},secondary:{usedPercent:60,windowDurationMins:10080,resetsAt:Math.floor(Date.now()/1000)+86400}}};
 const commands=[{name:'status',description:'세션 상태',duringTask:true},{name:'model',description:'모델 선택',duringTask:true},{name:'resume',description:'이전 대화',duringTask:true},{name:'help',description:'명령 안내',duringTask:true}];
 const testCwd=c.cwd||'/home/qa/project';
 const connection={id:'mobile-ui',label:'Home workstation with a long host name',url:'http://qa.invalid:7777',token:'fixture'};
 let storedSession;
 let pushEnabled=false;
 const graphPath='/home/qa/project/results/comparison.png';
 const relativeGraphPath=settings.cwd+'/results/relative chart.svg';
 const generatedPath='/tmp/orbit-generated.png';
 const missingGraphPath='/mnt/data/missing.png';
 const imageRequests=[];
 await page.route('**/api/v1/**',async route=>{
  const {pathname}=new URL(route.request().url());
  const method=route.request().method();
  if(pathname==='/api/v1/push/sessions/mobile-ui-fixture'){
   const headers=route.request().headers();
   if(headers['x-orbitd-url']!==connection.url||!(/^[0-9a-f]{64}$/).test(headers['x-orbit-push-device']))throw Error('Missing push device or server');
   if(method==='GET')return route.fulfill({json:{publicKey:'AQ',enabled:pushEnabled}});
   if(method==='PUT'&&route.request().postDataJSON().connection!==connection.id)throw Error('Missing push connection');
   pushEnabled=method==='PUT';
   return route.fulfill({status:204});
  }
  if(pathname.endsWith('/backends'))return route.fulfill({json:[{id:'codex',name:'Codex',modes:['cli','web']}]});
  if(pathname.endsWith('/sessions')){
   if(method==='POST'){
    const data=route.request().postDataJSON();
    storedSession={id:'mobile-ui-fixture',name,mode:data.mode,tool:data.tool,cwd:data.cwd,status:'running',codex_thread_id:'mobile-ui-thread'};
    return route.fulfill({status:201,json:storedSession});
   }
   return route.fulfill({json:storedSession?[storedSession]:[]});
  }
  if(method==='DELETE'&&pathname.endsWith('/sessions/mobile-ui-fixture')){
   storedSession=null;
   return route.fulfill({json:{ok:true}});
  }
  if(method==='POST'&&pathname.endsWith('/sessions/mobile-ui-fixture/files')){
   const name=new URL(route.request().url()).searchParams.get('name');
   if(route.request().headers()['content-type']!=='application/octet-stream')throw Error('Ordinary file upload was not binary');
   return route.fulfill({json:{id:name,path:'/tmp/orbit-codex-images-qa/mobile-ui-fixture/'+name}});
  }
  if(pathname.endsWith('/fs/raw')){
   const file=new URL(route.request().url());
   const path=file.searchParams.get('path');
   imageRequests.push(path);
   if(file.searchParams.has('token')||route.request().headers().authorization!=='Bearer fixture'||route.request().headers()['x-orbitd-url']!==connection.url)throw Error('Image request did not use the session host and header auth');
   if(path===missingGraphPath)return route.fulfill({status:404,body:'Missing'});
   if(![graphPath,relativeGraphPath,generatedPath].includes(path))throw Error('Unexpected image path: '+path);
   return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="640" height="300"><rect width="640" height="300" fill="blue"/></svg>'});
  }
  if(pathname.endsWith('/dirs'))return route.fulfill({json:{path:testCwd,cwd:testCwd,home:testCwd,parent:'/home/qa',dirs:[]}});
  return route.abort();
 });
 await page.routeWebSocket('**/api/v1/sessions/*/codex?*',ws=>{wsClient=ws;wsAttempts++;
  if(failConnections){void ws.close({code:1011,reason:'QA unavailable'});return;}
  ws.send(JSON.stringify({type:'ready',state:snapshot()}));ws.onMessage(raw=>{
  const b=JSON.parse(String(raw));ops.push(b);let result={};
  if(b.op==='history')result={thread:{turns:[{id:'ui-turn',startedAt,status:active?'inProgress':'completed',items:[{id:'user',type:'userMessage',content:[{type:'text',text:'모바일 화면과 진행 상태를 확인해줘.'}]},{id:'work',type:'commandExecution',status:'completed',command:'rg --files src',aggregatedOutput:'src/CodexChat.tsx\nsrc/CodexControls.tsx\nsrc/CodexStatus.tsx\nsrc/styles/codex-chat.css\nsrc/main.tsx',exitCode:0},{id:'empty-reasoning',type:'reasoning',summary:[]},{id:'answer',type:'agentMessage',text:'## 화면을 정리하고 있습니다\n세션의 실행 위치와 작업 내용을 확인할 수 있습니다.\n\n- 대화 공간을 넓게 사용합니다.\n- 주간 한도를 막대로 확인합니다.\n\n```js\n'+Array.from({length:28},(_,i)=>'const line'+i+' = '+i+';').join('\n')+'\n```\n\n추가 지시는 작업 중에도 보낼 수 있습니다.'},{id:'diagrams',type:'agentMessage',status:'completed',text:diagramAnswer},{id:'charts',type:'agentMessage',status:'completed',text:'[비교 그래프]('+graphPath+')\n\n![상대 경로 그래프](results/relative%20chart.svg)\n\n[없는 그래프](sandbox:'+missingGraphPath+')'},{id:'native-image',type:'imageGeneration',status:'completed',savedPath:generatedPath}]}]},state:snapshot()};
  if(b.op==='command'){if(b.command==='/help')result={type:'help',commands};else if(b.command==='/status')result={type:'status',threadId:'12345678-1234-4234-8234-123456789012',state:snapshot()};else if(b.command==='/usage')result={type:'usage',...limits};else if(b.command==='/model')result={type:'model',state:snapshot(),models:[{id:settings.model,model:settings.model,supportedReasoningEfforts:[{reasoningEffort:'medium',description:'Medium'}]}]};else result={type:'resume',data:[],state:snapshot()};}
  if(b.op==='interrupt'){active=false;ws.send(JSON.stringify({type:'notification',message:{method:'turn/completed',params:{turn:{id:'ui-turn',status:'interrupted'}}}}));}
  if(b.op==='command'&&/^\/plan(?: |$)/.test(b.command)){
   if(b.command!=='/plan')settings.collaborationMode={mode:b.command==='/plan on'?'plan':'default'};
   result={type:'plan',state:snapshot()};
  }
  if(b.op==='command'&&b.command==='/rename')result={type:'rename',currentName:storedSession.name,suggestion:'모바일 화면과 진행 상태 확인'};
  if(b.op==='command'&&b.command.startsWith('/rename ')){
   storedSession={...storedSession,name:b.command.slice('/rename '.length)};
   result={type:'rename',name:storedSession.name,session:storedSession};
  }
  if(b.op==='queue/remove'){
   queue={...queue,items:queue.items.filter(item=>item.id!==b.entryId),version:queue.version+1};
   result=snapshot();
  }
  ws.send(JSON.stringify({type:'result',id:b.id,result}));
 });});
 async function command(text){const box=page.getByRole('textbox',{name:'Codex 메시지'});await box.fill(text);await page.getByRole('button',{name:'명령 실행',exact:true}).click();}
 async function assertFit(label){const metrics=await page.evaluate(()=>{const chat=document.querySelector('.codexChat'),composer=document.querySelector('.codexComposer'),messages=document.querySelector('.codexMessages'),dialog=document.querySelector('.codexControls');return {overflow:document.documentElement.scrollWidth>innerWidth+1,chat:chat&&chat.getBoundingClientRect().width,composer:composer&&composer.getBoundingClientRect().bottom,height:visualViewport.height,visible:messages&&messages.clientHeight,dialog:dialog&&{width:dialog.getBoundingClientRect().width,height:dialog.getBoundingClientRect().height,bottom:dialog.getBoundingClientRect().bottom,scroll:dialog.scrollWidth>dialog.clientWidth+1}};});if(metrics.overflow||metrics.composer>metrics.height+2||metrics.dialog?.scroll||metrics.dialog?.bottom>metrics.height+2)throw Error(label+' overflow '+JSON.stringify(metrics));return metrics;}
 try{
  await page.goto(c.webUrl);await page.evaluate(connection=>{localStorage.setItem('orbit.connections',JSON.stringify([connection]));localStorage.setItem('orbit.activeConnection',connection.id);},connection);await page.reload();await page.getByTitle('New session',{exact:true}).click();let dialog=page.getByRole('dialog');await dialog.getByRole('radio', { name: 'Web · Chat', exact: true }).check();await dialog.getByPlaceholder('cwd',{exact:true}).fill(testCwd);await dialog.getByRole('button',{name:'Run',exact:true}).click();await page.getByText('Codex 연결됨',{exact:true}).waitFor();
  await page.waitForFunction(()=>history.state?.orbitDetail===true&&!history.state?.orbitModal);
  const modeLabel=page.locator('.codexModeLabel');
  await modeLabel.filter({hasText:/^Default$/}).waitFor();
  wsClient.send(JSON.stringify({type:'notification',message:{
   method:'thread/settings/updated',params:{threadSettings:{...settings,collaborationMode:{mode:'plan'}}},
  }}));
  await modeLabel.filter({hasText:/^Plan$/}).waitFor();
  wsClient.send(JSON.stringify({type:'notification',message:{
   method:'thread/settings/updated',params:{threadSettings:{...settings,collaborationMode:{mode:'default'}}},
  }}));
  await modeLabel.filter({hasText:/^Default$/}).waitFor();
  const cwdDetails=page.locator('.codexCwd');
  const cwdSummary=cwdDetails.locator('summary');
  await cwdDetails.locator('.codexCwdCompact').waitFor();
  if(await cwdSummary.getAttribute('title')!==settings.cwd)throw Error('Composer must show the live session working directory');
  await cwdSummary.click();
  const cwdPopup=cwdDetails.locator('.sessionDetailsPopup');
  await cwdPopup.getByText(settings.cwd,{exact:true}).waitFor();
  await cwdSummary.press('Escape');
  await cwdPopup.waitFor({state:'hidden'});
  for(const label of ['비교 그래프','상대 경로 그래프','orbit-generated.png']){
   const chart=page.getByRole('img',{name:label,exact:true});
   await chart.waitFor();
   await page.waitForFunction(name=>Array.from(document.images).some(img=>img.alt===name&&img.naturalWidth===640),label);
   const image=await chart.boundingBox();
   if(image.width>390)throw Error('Chart overflows the mobile chat');
  }
  await page.getByRole('status').filter({hasText:'미리보기를 불러올 수 없습니다.'}).waitFor();
  if(imageRequests.length!==4||!imageRequests.includes(relativeGraphPath))throw Error('Unexpected workspace image fetches');
  const queuePanel=page.locator('.codexQueue');
  const queueRows=queuePanel.locator(':scope > ol > li');
  const updateQueue=items=>{
   queue={...queue,items,version:queue.version+1};
   wsClient.send(JSON.stringify({type:'state',state:snapshot()}));
  };
  const longQueueText='공백이 있는 긴 대기 메시지 '.repeat(20)+'\n'+'long-file-path-'.repeat(28);
  const queued=Array.from({length:4},(_,index)=>({id:'queued-'+index,text:index===0?longQueueText:'대기 항목 '+index}));
  updateQueue(queued.slice(0,3));
  await queuePanel.getByText('대기 메시지 3개',{exact:true}).waitFor();
  for(const width of [320,390]){
   await page.setViewportSize({width,height:844});
   const completeRows=await queueRows.evaluateAll(rows=>rows.filter(row=>{
    const list=row.parentElement.getBoundingClientRect(), button=row.querySelector('button').getBoundingClientRect();
    return button.height>=39&&button.top>=list.top&&button.bottom<=list.bottom;
   }).length);
   if(completeRows!==3)throw Error('Queue rows or cancel buttons are cut off at '+width);
  }
  for(const width of [320,390,1440]){
   await page.setViewportSize({width,height:844});
   const fits=await queueRows.first().evaluate(row=>{
    const list=row.parentElement, bounds=list.getBoundingClientRect();
    const button=row.querySelector('button').getBoundingClientRect(), message=row.querySelector('span');
    return list.scrollWidth<=list.clientWidth&&button.right<=bounds.right&&
     message.scrollWidth>message.clientWidth&&getComputedStyle(message).textOverflow==='ellipsis';
   });
   if(!fits)throw Error('Long queued text pushes the cancel button outside the card at '+width);
  }
  await page.setViewportSize({width:390,height:844});
  await page.evaluate(()=>{
   Object.defineProperty(window.visualViewport,'height',{configurable:true,get:()=>440});
   window.visualViewport.dispatchEvent(new Event('resize'));
  });
  await page.waitForFunction(()=>document.documentElement.dataset.keyboardOpen==='true');
  if(await queueRows.locator('visible=true').count()!==1)throw Error('Keyboard queue preview should show one complete row');
  await page.evaluate(()=>{
   delete window.visualViewport.height;
   window.visualViewport.dispatchEvent(new Event('resize'));
  });
  await page.waitForFunction(()=>document.documentElement.dataset.keyboardOpen==='false');
  updateQueue(queued);
  await queuePanel.getByText('대기 메시지 4개',{exact:true}).waitFor();
  await queuePanel.getByRole('button',{name:'전체 보기'}).click();
  const queueDialog=page.getByRole('dialog',{name:'대기 메시지 전체 보기'});
  await queueDialog.getByText('대기 항목 3',{exact:true}).waitFor();
  const fullText=queueDialog.getByRole('listitem').first().locator('span');
  if(await fullText.textContent()!==longQueueText||!await fullText.evaluate(span=>span.scrollWidth<=span.clientWidth&&span.clientHeight>80))throw Error('Long queued text did not wrap in the full queue');
  await queueDialog.getByRole('listitem').filter({hasText:'대기 항목 3'}).getByRole('button',{name:'취소'}).click();
  await queueDialog.getByText('대기 항목 3',{exact:true}).waitFor({state:'hidden'});
  if(!ops.some(op=>op.op==='queue/remove'&&op.entryId==='queued-3'))throw Error('Queue dialog removed the wrong entry');
  await page.goBack();
  await queueDialog.waitFor({state:'hidden'});
  await queuePanel.getByRole('button',{name:'전체 보기'}).click();
  await queueDialog.waitFor();
  await page.mouse.click(2,2);
  await queueDialog.waitFor({state:'hidden'});
  await page.getByText('Codex 연결됨',{exact:true}).waitFor();
  updateQueue([]);
  await queuePanel.waitFor({state:'hidden'});
  const codeBlock=page.locator('.codexMessage.agentMessage .codexCode').first();
  const expectedCode=Array.from({length:28},(_,i)=>'const line'+i+' = '+i+';').join('\n');
  await page.context().grantPermissions(['clipboard-read','clipboard-write']);
  const toolbar=codeBlock.locator('.codexCodeToolbar');
  const expand=toolbar.getByRole('button',{name:'Expand code',exact:true});
  const copyCode=toolbar.getByRole('button',{name:'Copy code',exact:true});
  await expand.locator('.lucide-plus').waitFor();
  const [expandBox,copyBox]=await Promise.all([expand.boundingBox(),copyCode.boundingBox()]);
  if(copyBox.x<=expandBox.x)throw Error('Copy must be on the right side of the code toolbar');
  if(expandBox.width>32||expandBox.height>32||await copyCode.innerText())throw Error('Code toolbar buttons must be compact icons');
  await copyCode.click();
  await copyCode.locator('.lucide-check').waitFor();
  if(await page.evaluate(()=>navigator.clipboard.readText())!==expectedCode)throw Error('Copy did not preserve the full collapsed code block');
  await expand.click();
  const collapse=codeBlock.getByRole('button',{name:'Collapse code',exact:true});
  if(await collapse.locator('.lucide-minus').count()!==2)throw Error('Expanded code lost its collapse controls');
  await collapse.last().click();
  await expand.waitFor();
  const mermaidFrame=page.frameLocator('iframe[title="Mermaid preview"]').first();
  await mermaidFrame.getByText('orbitd', {exact:true}).waitFor();
  if(!await mermaidFrame.locator('svg .edgePaths path').count())throw Error('Mermaid preview lost the flowchart edge');
  const mermaidSvg=mermaidFrame.locator('svg');
  const waitForFittedDiagram=()=>page.waitForFunction(()=>{
   const doc=document.querySelector('iframe[title="Mermaid preview"]')?.contentDocument;
   const svg=doc?.querySelector('svg');
   if(!svg)return false;
   const view=svg.viewBox.baseVal,bounds=svg.getBBox();
   const {scrollHeight,clientHeight,scrollWidth,clientWidth}=doc.documentElement;
   return bounds.width>0&&bounds.height>0&&
    view.x<=bounds.x&&view.y<=bounds.y&&
    view.x+view.width>=bounds.x+bounds.width&&view.y+view.height>=bounds.y+bounds.height&&
    scrollHeight<=clientHeight+1&&scrollWidth<=clientWidth+1&&
    svg.getBoundingClientRect().height>40;
  },{},{timeout:5000});
  await waitForFittedDiagram();
  await page.setViewportSize({width:1440,height:900});
  await waitForFittedDiagram();
  const inlineHeight=await mermaidSvg.evaluate(svg=>svg.getBoundingClientRect().height);
  if(inlineHeight<=560)throw Error('The tall fixture must exercise the former 560px height cap');
  await page.setViewportSize({width:390,height:844});
  const enlargeDiagram=page.getByRole('button',{name:'Enlarge Mermaid diagram',exact:true});
  await enlargeDiagram.click();
  const diagramDialog=page.getByRole('dialog',{name:'Mermaid diagram',exact:true});
  const expandedSvg=diagramDialog.frameLocator('iframe[title="Expanded Mermaid preview"]').locator('svg');
  await expandedSvg.waitFor();
  const fittedWidth=(await expandedSvg.boundingBox()).width;
  await diagramDialog.getByRole('button',{name:'Zoom in',exact:true}).click();
  await expandedSvg.waitFor();
  if((await expandedSvg.boundingBox()).width<=fittedWidth)throw Error('Zoom did not enlarge the diagram');
  await page.goBack();
  await diagramDialog.waitFor({state:'hidden'});
  await enlargeDiagram.focus();
  await page.keyboard.press('Enter');
  await diagramDialog.waitFor();
  await page.keyboard.press('Escape');
  await diagramDialog.waitFor({state:'hidden'});
  await enlargeDiagram.click();
  await diagramDialog.waitFor();
  await page.mouse.click(2,2);
  await diagramDialog.waitFor({state:'hidden'});
  const mermaidBlock=page.locator('.codexCode').filter({has:page.locator('iframe[title="Mermaid preview"]')}).first();
  await mermaidBlock.getByRole('button',{name:'Show source',exact:true}).click();
  await page.locator('.codexCode pre').filter({hasText:'터미널 클라이언트'}).waitFor();
  await page.getByRole('button',{name:'Preview Mermaid',exact:true}).click();
  await mermaidFrame.locator('svg').waitFor();
  await page.getByRole('button',{name:'Preview SVG',exact:true}).click();
  await page.frameLocator('iframe[title="SVG preview"]').getByText('SVG diagram',{exact:true}).waitFor();
  let previewRequests=0;
  await page.route('**/diagram-preview-fixture.png',route=>{previewRequests++;return route.abort();});
  await page.getByRole('button',{name:'Preview HTML',exact:true}).click();
  const htmlFrame=page.frameLocator('iframe[title="HTML preview"]');
  await htmlFrame.getByText('Finish',{exact:true}).waitFor();
  if(await htmlFrame.locator('article').evaluate(node=>getComputedStyle(node).display)!=='flex')throw Error('HTML preview dropped the diagram stylesheet');
  if(await page.locator('iframe[title="HTML preview"]').getAttribute('sandbox')!=='allow-same-origin')throw Error('HTML preview lost its sandbox');
  const previewImage=htmlFrame.locator('img');
  await previewImage.waitFor({state:'attached'});
  if(!await previewImage.evaluate(node=>node.complete&&!node.naturalWidth)||previewRequests)throw Error('HTML preview loaded an external image');
  if(await htmlFrame.locator('script, body[data-preview-script]').count())throw Error('HTML preview retained executable script');
  await page.getByText('Diagram could not be rendered.',{exact:false}).waitFor();
  const mic=page.getByRole('button',{name:'음성 입력 시작',exact:true});
  const voiceDraft=page.getByRole('textbox',{name:'Codex 메시지'});
  await voiceDraft.fill('작성 중');
  await mic.click();
  const stopMic=page.getByRole('button',{name:'음성 입력 중지',exact:true});
  await stopMic.waitFor();
  if(!await page.locator('.codexSend').isDisabled())throw Error('Sending is still enabled while recording');
  await stopMic.click();
  await mic.waitFor();
  if(await voiceDraft.inputValue()!=='작성 중 음성으로 추가한 내용'||ops.some(op=>['send','steer','queue'].includes(op.op)))throw Error('Voice result was not added to the unsent draft');
  await voiceDraft.fill('');
  await mic.click();
  await stopMic.waitFor();
  await page.evaluate(()=>window.voiceFixture.onerror({error:'not-allowed'}));
  await page.getByRole('alert').getByText(/마이크 접근을 허용하세요/).waitFor();
  await page.getByRole('button',{name:'오류 닫기',exact:true}).click();
  await page.getByRole('button',{name:'파일 첨부',exact:true}).click();
  await page.getByRole('button',{name:'이미지 선택',exact:true}).waitFor();
  await page.getByRole('button',{name:'파일 선택',exact:true}).waitFor();
  await page.getByLabel('첨부할 파일 선택',{exact:true}).setInputFiles({name:'notes.txt',mimeType:'text/plain',buffer:Buffer.from('QA notes')});
  await page.locator('.codexImageDraft.ready').filter({hasText:'notes.txt'}).waitFor();
  await voiceDraft.evaluate(node=>{
   const data=new DataTransfer();
   data.items.add(new File(['QA table'],'table.csv',{type:'text/csv'}));
   node.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));
  });
  await page.locator('.codexImageDraft.ready').filter({hasText:'table.csv'}).waitFor();
  await page.locator('.codexChat').evaluate(node=>{
   const data=new DataTransfer();
   data.items.add(new File(['QA report'],'report.pdf',{type:'application/pdf'}));
   node.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data}));
  });
  await page.locator('.codexImageDraft.ready').filter({hasText:'report.pdf'}).waitFor();
  await page.locator('.codexSend').click();
  await page.locator('.codexImageDrafts').waitFor({state:'hidden'});
  if(!ops.some(op=>op.op==='steer'&&op.text===''&&JSON.stringify(op.files)===JSON.stringify(['notes.txt','table.csv','report.pdf'])))throw Error('General files were not sent for Codex input');


  await page.getByRole('button',{name:'Interrupt current task',exact:true}).waitFor();
  await assertFit('mobile');const time=await page.locator('.codexWorking time').innerText();if(!/3m|4m/.test(time))throw Error('Working timer did not use turn start');await page.waitForFunction(before=>document.querySelector('.codexWorking time').textContent!==before,time);if(await page.getByText('Reasoning summary',{exact:true}).count())throw Error('Empty reasoning shown');
  if(await page.locator('.codexChat > .codexConnection + .codexMessages').count()!==1)throw Error('Mobile chat header still has an extra location row');
  if(await page.getByRole('button',{name:'탐색 메뉴 열기',exact:true}).count())throw Error('Redundant chat navigation menu remains');
  const before=await page.locator('.codexMessages').boundingBox(),historyCount=ops.filter(o=>o.op==='history').length;
  await page.getByRole('textbox',{name:'Codex 메시지'}).fill('새로고침 중 유지할 입력');await page.getByRole('button',{name:'대화 새로고침',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.codexConnectionState')?.dataset.state==='ready');if(ops.filter(o=>o.op==='history').length<=historyCount)throw Error('Refresh did not reload history');if(await page.getByRole('textbox',{name:'Codex 메시지'}).inputValue()!=='새로고침 중 유지할 입력')throw Error('Refresh lost draft');await page.getByRole('textbox',{name:'Codex 메시지'}).fill('');const after=await page.locator('.codexMessages').boundingBox();if(before.height!==after.height)throw Error('Refresh changes chat layout');
  await page.getByRole('button',{name:'세션 목록으로 돌아가기',exact:true}).click();await page.getByTitle('New session',{exact:true}).click();await page.locator('.sessionModal').waitFor();await page.getByTitle('Browse folders',{exact:true}).click();await page.locator('.folderPicker').waitFor();await page.goBack();await page.locator('.folderPicker').waitFor({state:'hidden'});await page.locator('.sessionModal').waitFor();await page.goBack();await page.locator('.sessionModal').waitFor({state:'hidden'});await page.locator('.sessions .row').filter({hasText:name}).click();await page.getByText('Codex 연결됨',{exact:true}).waitFor();
  await command('/status');dialog=page.getByRole('dialog',{name:'세션 상태'});await dialog.waitFor();await dialog.getByRole('meter',{name:'Codex Weekly limit',exact:true}).waitFor();if(await dialog.getByRole('meter',{name:'Codex Weekly limit',exact:true}).getAttribute('aria-valuenow')!=='40')throw Error('Weekly limit remaining incorrect');await assertFit('mobile status');await page.screenshot({path:'/workspace/output/orbit-status-mobile.png'});await page.goBack();await dialog.waitFor({state:'hidden'});await page.getByText('Codex 연결됨',{exact:true}).waitFor();
  await page.getByRole('button',{name:'대화 명령 열기',exact:true}).click();dialog=page.getByRole('dialog',{name:'대화 명령'});await dialog.waitFor();await dialog.getByRole('button').filter({hasText:'/model'}).click();await command('/model');await page.getByRole('dialog',{name:'모델 및 추론 강도'}).waitFor();await page.getByRole('button',{name:'명령 창 닫기'}).click();await page.waitForFunction(()=>!history.state?.orbitModal);await page.getByText('Codex 연결됨',{exact:true}).waitFor();
  for(const width of [320,390,768]){await page.setViewportSize({width,height:844});await assertFit('width '+width);const touch=await page.getByRole('button',{name:'파일 첨부',exact:true}).boundingBox();if(touch.height<43||touch.width<43)throw Error('Attachment button too small');}
  await page.setViewportSize({width:390,height:844});if(await page.getByRole('button',{name:'키보드와 단축키'}).count())throw Error('Keyboard button remains');const plus=await page.getByRole('button',{name:'파일 첨부',exact:true}).boundingBox(),input=await page.getByRole('textbox',{name:'Codex 메시지'}).boundingBox(),send=await page.locator('.codexSend').boundingBox();if(!(plus.x<input.x&&input.x<send.x)||Math.abs(plus.y-send.y)>2)throw Error('Composer is not one row with attachment on the left');await page.getByRole('textbox',{name:'Codex 메시지'}).fill('작업 중 보충 지시');
  const box=page.getByRole('textbox',{name:'Codex 메시지'}),inputOps=ops.filter(o=>['send','steer','queue'].includes(o.op)).length;
  await box.press('End');await box.press('Enter');await box.press('Shift+Enter');
  if(await box.inputValue()!=='작업 중 보충 지시\n\n'||ops.filter(o=>['send','steer','queue'].includes(o.op)).length!==inputOps)throw Error('Mobile Enter should insert newlines without submitting');
  await page.setViewportSize({width:820,height:844});
  await box.press('Enter');
  if(await box.inputValue()!=='작업 중 보충 지시\n\n\n')throw Error('Enter did not insert a newline at the mobile breakpoint');
  await page.setViewportSize({width:390,height:844});
  const wide=await box.boundingBox(),bottomPlus=await page.getByRole('button',{name:'파일 첨부',exact:true}).boundingBox(),bottomSend=await page.locator('.codexSend').boundingBox();
  if(wide.width<=input.width+50||bottomPlus.y<wide.y+wide.height||Math.abs(bottomPlus.y-bottomSend.y)>2)throw Error('Multiline buttons did not move below full-width input');
  await box.fill('자동 줄바꿈을 확인하는 긴 문장입니다. '.repeat(5));
  if(!await page.locator('.codexComposer.multiline').count())throw Error('Soft wrapping did not expand the composer');
  await box.fill('짧은 입력');
  if(await page.locator('.codexComposer.multiline').count())throw Error('Composer did not return to one row');
  await box.fill('첫 줄\n두 번째 줄\n세 번째 줄');
  const composerMeta=page.locator('.codexComposerMeta');
  await composerMeta.waitFor({state:'visible'});
  await page.evaluate(()=>{Object.defineProperty(window.visualViewport,'height',{configurable:true,get:()=>440});window.visualViewport.dispatchEvent(new Event('resize'));});
  await page.waitForFunction(()=>document.documentElement.dataset.keyboardOpen==='true');
  await composerMeta.waitFor({state:'hidden'});
  await assertFit('keyboard viewport');
  await page.evaluate(()=>{delete window.visualViewport.height;window.visualViewport.dispatchEvent(new Event('resize'));});
  await composerMeta.waitFor({state:'visible'});
  await page.screenshot({path:'/workspace/output/orbit-chat-mobile.png'});
  await box.press('Control+Enter');
  await page.waitForFunction(()=>document.querySelector('.codexComposer textarea').value==='');
  if(!ops.some(o=>o.op==='steer'&&o.text==='첫 줄\n두 번째 줄\n세 번째 줄'))throw Error('Multiline payload did not preserve newlines');
  if(await page.locator('.codexComposer.multiline').count())throw Error('Composer did not collapse after sending');
  await page.setViewportSize({width:821,height:1000});
  await box.fill('넓은 터치 화면에서 전송');
  const sentBeforeComposition=ops.filter(o=>o.op==='steer').length;
  await box.dispatchEvent('keydown',{key:'Enter',isComposing:true});
  if(await box.inputValue()!=='넓은 터치 화면에서 전송'||ops.filter(o=>o.op==='steer').length!==sentBeforeComposition)throw Error('Enter sent unfinished IME composition');
  await box.press('Enter');
  await page.waitForFunction(()=>!document.querySelector('.codexComposer textarea').value);
  if(!ops.some(o=>o.op==='steer'&&o.text==='넓은 터치 화면에서 전송'))throw Error('Plain Enter did not send above the mobile breakpoint');
  await page.setViewportSize({width:1440,height:1000});
  await box.fill('데스크톱 첫 줄');
  await box.press('End');
  await box.press('Shift+Enter');
  await page.keyboard.insertText('데스크톱 둘째 줄');
  if(await box.inputValue()!=='데스크톱 첫 줄\n데스크톱 둘째 줄')throw Error('Desktop Shift+Enter did not insert a newline');
  await box.press('Control+Enter');
  await page.waitForFunction(()=>!document.querySelector('.codexComposer textarea').value);
  if(!ops.some(o=>o.op==='steer'&&o.text==='데스크톱 첫 줄\n데스크톱 둘째 줄'))throw Error('Desktop Ctrl+Enter did not send');
  const cwdPath=cwdDetails.locator('.codexCwdFull');
  await cwdPath.waitFor();
  const modelControl=page.getByTitle('모델 및 추론 강도',{exact:true});
  if(await cwdPath.innerText()!==settings.cwd||(await cwdSummary.boundingBox()).x>=(await modelControl.boundingBox()).x)throw Error('Desktop working path should precede the model');
  await page.getByRole('button',{name:'Interrupt',exact:true}).waitFor();
  if(await page.getByRole('button',{name:'Interrupt current task',exact:true}).count())throw Error('Desktop shows a duplicate interrupt control');
  if(!await mic.isVisible()||await page.getByRole('button',{name:'명령 선택',exact:true}).count())throw Error('Desktop voice button did not replace the slash shortcut');
  await mic.click();
  await stopMic.press('Escape');
  await mic.waitFor();
  if(!await page.evaluate(()=>window.voiceAborted))throw Error('Escape did not cancel voice capture');
  const header=page.locator('.codexConnection');
  await header.getByText(name,{exact:true}).waitFor();
  if(!await page.locator('.codexSessionPane').evaluate(panel=>{
    const outer=panel.parentElement.getBoundingClientRect(),inner=panel.getBoundingClientRect();
    return ['top','left','right','bottom'].every(edge=>Math.abs(outer[edge]-inner[edge])<1)&&getComputedStyle(panel).borderRadius==='0px';
  }))throw Error('Chat panel has outer spacing');
  await header.getByText('Codex 연결됨',{exact:true}).waitFor();
  if(await header.locator('button:visible').count())throw Error('Desktop header still displays shortcuts');
  const details=page.locator('.codexDesktopDetails');
  await details.locator('summary').click();
  await details.getByText(settings.cwd,{exact:true}).waitFor();
  if(await details.getByRole('button',{name:/^(Detach|Delete session)$/}).count())throw Error('Session actions still appear in chat details');
  await details.locator('summary').press('Escape');
  await details.getByText(settings.cwd,{exact:true}).waitFor({state:'hidden'});
  await page.clock.install();
  const beforeReconnect=ops.filter(o=>o.op==='history').length;
  const beforeAttempts=wsAttempts;
  await box.fill('다시 연결한 뒤에도 유지할 입력');
  wsClient.send(JSON.stringify({type:'disconnected',error:'QA disconnect'}));
  await header.getByText('연결 끊김',{exact:true}).waitFor();
  const workingStatus=page.locator('.codexWorking');
  if(await workingStatus.isVisible())throw Error('Working timer remained visible after disconnect');
  if(await header.getByRole('button',{name:'다시 연결',exact:true}).count()||wsAttempts!==beforeAttempts)throw Error('Reconnect was manual or immediate');
  await page.clock.fastForward(5000);
  await header.getByText('Codex 연결됨',{exact:true}).waitFor();
  await workingStatus.waitFor({state:'visible'});
  if(wsAttempts!==beforeAttempts+1||ops.filter(o=>o.op==='history').length<=beforeReconnect)throw Error('Automatic reconnect did not reload history');
  if(await box.inputValue()!=='다시 연결한 뒤에도 유지할 입력')throw Error('Reconnect lost draft');

  failConnections=true;
  const beforeFailures=wsAttempts;
  await wsClient.close({code:1011,reason:'QA unavailable'});
  const disconnected=header.locator('[data-state="offline"]');
  for(let attempt=1;attempt<=5;attempt++){
    await disconnected.waitFor();
    await page.clock.fastForward(5000);
    await header.locator(`[data-state="${attempt===5?'stopped':'offline'}"]`).waitFor();
    if(wsAttempts!==beforeFailures+attempt)throw Error('Incorrect retry count after disconnect');
  }
  await header.getByText('연결 중단',{exact:true}).waitFor();
  if(await workingStatus.isVisible())throw Error('Working timer remained visible after reconnect attempts stopped');
  await page.clock.fastForward(10000);
  if(wsAttempts!==beforeFailures+5)throw Error('Reconnect continued after five failures');
  failConnections=false;
  await page.setViewportSize({width:390,height:844});
  await page.getByRole('button',{name:'대화 새로고침',exact:true}).click();
  await header.getByText('Codex 연결됨',{exact:true}).waitFor();
  if(await box.inputValue()!=='다시 연결한 뒤에도 유지할 입력')throw Error('Refresh from stopped state lost draft');
  await page.setViewportSize({width:1440,height:1000});
  await command('/status');dialog=page.getByRole('dialog',{name:'세션 상태'});await dialog.getByRole('meter',{name:'Codex Weekly limit',exact:true}).waitFor();await assertFit('desktop status');await page.screenshot({path:'/workspace/output/orbit-status-desktop.png'});await page.goBack();await dialog.waitFor({state:'hidden'});await page.getByText('Codex 연결됨',{exact:true}).waitFor();
  const interrupts=ops.filter(o=>o.op==='interrupt').length;await command('/help');await page.getByRole('dialog',{name:'대화 명령'}).waitFor();await page.getByRole('dialog').press('Escape');await page.getByRole('dialog').waitFor({state:'hidden'});if(ops.filter(o=>o.op==='interrupt').length!==interrupts)throw Error('Closing dialog interrupts work');
  await page.getByRole('textbox',{name:'Codex 메시지'}).focus();await page.getByRole('textbox',{name:'Codex 메시지'}).press('Escape');await page.locator('.codexWorking').waitFor({state:'hidden'});if(ops.filter(o=>o.op==='interrupt').length!==interrupts+1)throw Error('Esc did not interrupt the active turn');
  const modePicker=page.getByRole('radiogroup',{name:'대화 모드',exact:true});
  const planChoice=modePicker.getByRole('radio',{name:'Plan',exact:true});
  await box.fill('유지할 초안');
  await box.press('Alt+p');
  await modePicker.getByRole('radio',{name:'Plan',exact:true,checked:true}).waitFor();
  if(await box.inputValue()!=='유지할 초안'||await page.getByRole('dialog').count())throw Error('Desktop mode shortcut should keep the draft and avoid a modal');
  await command('/plan');
  if(!await planChoice.evaluate(el=>el===document.activeElement))throw Error('Desktop /plan should focus the current mode');
  await planChoice.press('ArrowLeft');
  await modePicker.getByRole('radio',{name:'Default',exact:true,checked:true}).waitFor();
  if(!ops.some(op=>op.command==='/plan off')||!await box.evaluate(el=>el===document.activeElement))throw Error('Desktop mode selection did not return to the composer');
  await page.setViewportSize({width:390,height:844});
  await command('/plan');
  const mobilePlan=page.getByRole('dialog',{name:'Plan 모드',exact:true});
  await mobilePlan.getByRole('button',{name:'Plan 모드',exact:true}).waitFor();
  await mobilePlan.getByRole('button',{name:'명령 창 닫기'}).click();
  await mobilePlan.waitFor({state:'hidden'});
  await page.waitForFunction(()=>!history.state?.orbitModal);
  await command('/rename');
  const renameDialog=page.getByRole('dialog',{name:'대화 이름',exact:true});
  const suggestion=renameDialog.getByRole('textbox',{name:'추천 이름'});
  if(await suggestion.inputValue()!=='모바일 화면과 진행 상태 확인')throw Error('Chat title suggestion was not prefilled');
  await page.locator('.codexConnection').getByText(name,{exact:true}).waitFor();
  const renamed='모바일 화면 점검';
  await suggestion.fill(renamed);
  await renameDialog.getByRole('button',{name:'이름 적용'}).click();
  await page.locator('.codexConnection').getByText(renamed,{exact:true}).waitFor();
  await renameDialog.getByRole('button',{name:'명령 창 닫기'}).click();
  await page.waitForFunction(()=>!history.state?.orbitModal);
  const pushLink=new URL(c.webUrl);
  pushLink.searchParams.set('orbitSession',storedSession.id);
  pushLink.searchParams.set('orbitConnection',connection.id);
  await page.goto(pushLink.href);
  await page.locator('.codexConnection').getByText(renamed,{exact:true}).waitFor();
  await page.waitForFunction(()=>!new URLSearchParams(location.search).has('orbitSession'));
  const back=page.getByRole('button',{name:'세션 목록으로 돌아가기',exact:true});
  await back.click();
  const card=page.locator('.sessionCard').filter({has:page.getByTitle(renamed,{exact:true})});
  const row=card.locator('.row'),actions=card.getByLabel(`Actions for ${renamed}`,{exact:true});
  await row.waitFor();await assertFit('session cards');
  await page.screenshot({path:'/workspace/output/orbit-sessions-mobile.png'});
  const sessionActions=page.getByRole('dialog',{name:'Session actions',exact:true});
  await actions.click();
  await sessionActions.waitFor();
  if(!await sessionActions.evaluate(el=>el.matches(':modal')))throw Error('Mobile session actions are not modal');
  await sessionActions.getByText(renamed,{exact:true}).waitFor();
  const enablePush=sessionActions.getByRole('button',{name:'완료 알림 켜기',exact:true});
  const disablePush=sessionActions.getByRole('button',{name:'완료 알림 끄기',exact:true});
  await enablePush.click();
  await disablePush.click();
  await enablePush.waitFor();
  await page.waitForFunction(()=>!!history.state?.orbitModal);
  await page.goBack();
  await sessionActions.waitFor({state:'hidden'});
  if(await actions.getAttribute('aria-expanded')!=='false')throw Error('Back did not close session actions');
  await actions.click();
  await sessionActions.getByRole('button',{name:'Detach',exact:true}).click();
  await row.waitFor();
  if(await row.getAttribute('aria-current')||await actions.getAttribute('aria-expanded')!=='false')throw Error('List detach did not clear the selected session');
  await row.click();
  await page.getByText('Codex 연결됨',{exact:true}).waitFor();
  await back.click();
  await actions.click();
  await sessionActions.getByRole('button',{name:'Delete session',exact:true}).click();
  await card.waitFor({state:'hidden'});
  if(errors.length)throw Error(errors.join('\n'));console.log(JSON.stringify({mobileWidths:[320,390,768],weeklyLimitBars:true,statusDesktopAndMobile:true,compactDesktopHeader:true,automaticReconnect:true,reconnectStopsAfterFive:true,dialogBack:true,nestedDialogBack:true,chatMenuRemoved:true,mobileLocationRowRemoved:true,refreshPreservesDraft:true,noChatJump:true,singleRowComposer:true,multilineComposer:true,mobileEnterNewline:true,voiceInput:true,generalAttachments:true,touchDesktopMode:true,multilinePayload:true,leftAttachment:true,keyboardButtonRemoved:true,visualViewport:true,workingTimer:true,escInterrupt:true,emptyReasoningHidden:true,sessionCards:true,listDetachAndDelete:true}));
 }catch(e){console.log('Browser errors:',errors);console.log('Diagnostic:',(await page.locator('.codexChat').innerText({timeout:1000}).catch(()=>'' )).slice(-1200));await page.screenshot({path:'/workspace/output/orbit-mobile-error.png'});throw e;}
 finally{await browser.close();}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
