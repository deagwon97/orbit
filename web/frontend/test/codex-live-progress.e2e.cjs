// Only the shell Orb session is real. Model and tool activity use a WS fixture.
const fs=require('node:fs'),{chromium}=require('/app/node_modules/playwright');
(async()=>{
const c=JSON.parse(fs.readFileSync(0,'utf8')),browser=await chromium.launch({executablePath:chromium.executablePath(),headless:true,args:['--no-sandbox']}),page=await browser.newPage({viewport:{width:390,height:844}}),name='Live progress QA '+Date.now();let session,client,held,fail=false,reviewReject=false,queue={items:[],paused:false,version:0};const ops=[],errors=[];page.on('pageerror',e=>errors.push(e.message));
const snapshot=()=>({activeTurn:'live-turn',connected:true,settings:{model:'test-model',cwd:c.cwd},capabilities:{commands:true,steer:true,queue:true,images:true,liveInput:true},approvals:[],queue});
const emit=(method,params)=>client.send(JSON.stringify({type:'notification',message:{method,params:{threadId:'thread',turnId:'live-turn',...params}}}));
await page.routeWebSocket('**/api/v1/sessions/*/codex?*',ws=>{client=ws;ws.send(JSON.stringify({type:'ready',state:snapshot()}));ws.onMessage(raw=>{const b=JSON.parse(String(raw));ops.push(b);let result={};
if(b.op==='history')result={thread:{turns:[{id:'live-turn',status:'inProgress',startedAt:Math.floor(Date.now()/1000)-120,items:[{id:'answer',type:'agentMessage',text:'작업을 확인했습니다.'},{id:'cmd',type:'commandExecution',status:'completed',command:'echo done',aggregatedOutput:'done',exitCode:0},{id:'raw',type:'reasoning',summary:[],content:['PRIVATE_RAW_REASONING']}]}]},state:snapshot()};
if(b.op==='command')result=b.command==='/help'?{type:'help',commands:[]}:{type:'ps',data:[{processId:'42',command:'sleep 60',cwd:c.cwd}]};
if(b.op==='steer'){if(fail){ws.send(JSON.stringify({type:'error',id:b.id,error:'QA rejected input'}));return;}if(reviewReject){reviewReject=false;ws.send(JSON.stringify({type:'error',id:b.id,error:'cannot steer a review turn'}));return;}if(b.text==='first pending'){held=b;return;}result={steered:true};}
if(b.op==='queue'){queue={...queue,version:queue.version+1,items:[...queue.items,{id:'q'+queue.version,text:b.text,images:b.images}]};result={queued:true,state:snapshot()};}
ws.send(JSON.stringify({type:'result',id:b.id,result}));});});
async function send(text){const input=page.getByRole('textbox',{name:'Codex 메시지'});await input.fill(text);await input.press('Enter');await page.waitForFunction(()=>document.querySelector('textarea').value==='');}
try{
await page.goto(c.webUrl);await page.evaluate(c=>{localStorage.setItem('orbit.connections',JSON.stringify([{id:'live-progress',label:'Home',url:c.orbitdUrl,token:c.token}]));localStorage.setItem('orbit.activeConnection','live-progress');},c);await page.reload();await page.getByTitle('New session',{exact:true}).click();let d=page.getByRole('dialog');await d.getByRole('radio', { name: 'Web · Chat', exact: true }).check();await d.getByLabel('Name',{exact:true}).fill(name);await d.getByPlaceholder('cwd',{exact:true}).fill(c.cwd);await d.getByRole('button',{name:'Run',exact:true}).click();await page.getByText('Codex 연결됨',{exact:true}).waitFor();session=await page.evaluate(async({c,name})=>(await(await fetch('/api/v1/sessions',{headers:{Authorization:'Bearer '+c.token,'x-orbitd-url':c.orbitdUrl}})).json()).find(s=>s.name===name),{c,name});
await page.locator('.codexWorkHeading strong').filter({hasText:'Ran'}).waitFor();if(await page.locator('.codexMessage.agentMessage > small').count())throw Error('Repeated Codex label remains');if((await page.locator('.codexChat').innerText()).includes('Codex가 작업하고 있습니다'))throw Error('Generic Working copy remains');if((await page.locator('.codexChat').innerText()).includes('PRIVATE_RAW_REASONING'))throw Error('Raw reasoning exposed');
const markdownSample=[
  '입력창에서 **↑**를 누르고 **↓**로 이동합니다. **`여기서 포크`**를 누르세요.',
  '기호**(완료)**를 확인하고 `**↑**를`와 \\**↓**를 비교합니다.',
  '- [x] 확인\n- [ ] 대기',
  '| 선택 | 방향 |\n| :--- | ---: |\n| [공식 문서][guide] | **↑**를 |',
  '[guide]: https://example.com/guide',
].join('\n\n');
emit('item/agentMessage/delta',{itemId:'markdown-check',delta:'입력창에서 **↑'});
emit('item/agentMessage/delta',{itemId:'markdown-check',delta:markdownSample.slice('입력창에서 **↑'.length)});
const markdown=page.locator('.codexMessage.agentMessage').filter({hasText:'여기서 포크'});
await markdown.locator('p strong').getByText('↑',{exact:true}).waitFor();
await markdown.locator('strong').getByText('↓',{exact:true}).waitFor();
await markdown.locator('strong > code').getByText('여기서 포크',{exact:true}).waitFor();
await markdown.locator('strong').getByText('(완료)',{exact:true}).waitFor();
await markdown.locator('code').getByText('**↑**를',{exact:true}).waitFor();
if(!(await markdown.innerText()).includes('와 **↓**를 비교'))throw Error('Escaped emphasis was rendered as bold');
const tasks=markdown.getByRole('checkbox');
if(await tasks.count()!==2||!await tasks.first().isChecked()||await tasks.last().isChecked()||!await tasks.first().isDisabled())throw Error('Task list rendering failed');
if(await markdown.getByRole('link',{name:'공식 문서'}).getAttribute('href')!=='https://example.com/guide')throw Error('Reference link rendering failed');
if((await markdown.getByRole('columnheader',{name:'방향'}).evaluate(el=>getComputedStyle(el).textAlign))!=='right')throw Error('Table alignment was lost');
if((await markdown.innerText()).includes('[guide]:'))throw Error('Reference definition leaked into the message');
emit('item/completed',{item:{id:'explore-labels',type:'commandExecution',status:'completed',command:'inspect project',commandActions:[{type:'read',name:'example.ts'},{type:'search',query:'config'},{type:'listFiles',path:'src'}],aggregatedOutput:'first\nsecond\nthird\nfourth'}});
const explored=page.locator('[data-item="explore-labels"]');
for(const label of ['Read','Search','List files'])await explored.getByText(label,{exact:true}).waitFor();
await explored.getByRole('button',{name:'+ 1 more line',exact:true}).click();
if(await explored.getByRole('button',{name:'− Collapse',exact:true}).count()!==2)throw Error('Collapse labels missing above and below the output');
await explored.getByRole('button',{name:'− Collapse',exact:true}).first().click();
emit('item/completed',{item:{id:'long-output',type:'commandExecution',status:'completed',command:'print results',aggregatedOutput:'one\ntwo\nthree\nfour\nfive'}});
await page.locator('[data-item="long-output"]').getByRole('button',{name:'+ 2 more lines',exact:true}).waitFor();
await send('first pending');await page.getByRole('region',{name:'전송 중인 입력'}).filter({hasText:'first pending'}).waitFor();await send('second while pending');await send('third while pending');if(!ops.some(o=>o.op==='queue'&&o.text==='second while pending')||!ops.some(o=>o.op==='queue'&&o.text==='third while pending'))throw Error('Additional input blocked by pending request');
emit('item/started',{item:{id:'dynamic',type:'dynamicToolCall',tool:'search_files',arguments:{query:'visible argument'},status:'inProgress'}});emit('item/mcpToolCall/progress',{itemId:'mcp',message:'live tool progress'});emit('error',{willRetry:true,error:{message:'Reconnecting 1/3'}});emit('item/fileChange/patchUpdated',{itemId:'patch',changes:[{path:'src/example.ts',diff:'+ changed while working'}]});
await page.getByText('live tool progress',{exact:true}).waitFor();await page.getByText('Retrying · Reconnecting 1/3',{exact:true}).waitFor();const tool=page.locator('[data-item="dynamic"]');await tool.getByRole('button',{name:'+ Show details',exact:true}).click();await tool.getByText(/visible argument/).waitFor();await page.locator('[data-item="patch"]').getByRole('button',{name:'+ Show details',exact:true}).click();await page.getByText('+ changed while working',{exact:true}).waitFor();await page.getByRole('button',{name:'View 1 background terminal',exact:true}).waitFor();
client.send(JSON.stringify({type:'result',id:held.id,result:{steered:true}}));await page.locator('.codexSubmissions .sending').waitFor({state:'hidden'});
emit('item/started',{item:{id:'review',type:'enteredReviewMode',review:'Reviewing changes'}});await send('review follow-up');if(!ops.some(o=>o.op==='queue'&&o.text==='review follow-up'))throw Error('Review follow-up was not queued');emit('item/completed',{item:{id:'review-end',type:'exitedReviewMode',review:'Review done'}});
emit('item/started',{item:{id:'compact',type:'contextCompaction',status:'inProgress'}});await send('compact follow-up');if(!ops.some(o=>o.op==='queue'&&o.text==='compact follow-up'))throw Error('Compaction input was blocked');emit('item/completed',{item:{id:'compact',type:'contextCompaction',status:'completed'}});
reviewReject=true;await send('server rejects steer');await page.waitForFunction(()=>document.querySelector('.codexQueue')?.textContent.includes('server rejects steer'));if(!ops.some(o=>o.op==='queue'&&o.text==='server rejects steer'))throw Error('Definitive rejection did not fall back to queue');
fail=true;await send('keep failed input');await page.locator('.codexSubmissions .failed').filter({hasText:'keep failed input'}).waitFor();fail=false;await page.getByRole('button',{name:'입력으로 복원',exact:true}).click();if(await page.getByRole('textbox',{name:'Codex 메시지'}).inputValue()!=='keep failed input')throw Error('Failed input lost');await page.getByRole('textbox',{name:'Codex 메시지'}).fill('');
emit('item/completed',{item:{id:'async-question',type:'agentMessage',text:'진행 중 추가 확인입니다.',delivery:'async',questions:[{title:'출력 형식',options:['JSON','Text']}]}});await page.getByRole('button',{name:'JSON',exact:true}).click();await page.getByRole('textbox',{name:'Codex 메시지'}).press('Enter');await page.waitForFunction(()=>document.querySelector('textarea').value==='');if(!ops.some(o=>o.text==='출력 형식: JSON'))throw Error('Async question could not be answered during work');
if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1))throw Error('Mobile progress overflow');await page.screenshot({path:'/workspace/output/orbit-live-progress-mobile.png'});if(errors.length)throw Error(errors.join('\n'));console.log(JSON.stringify({labels:true,ran:true,noGenericWorking:true,pendingInput:true,reviewAndCompactQueue:true,steerFallback:true,failedInputRecovery:true,asyncQuestions:true,toolArgumentsAndProgress:true,patch:true,retry:true,backgroundTerminals:true,noRawReasoning:true}));
}catch(e){console.log('Diagnostic:',(await page.locator('.codexChat').innerText().catch(()=>'' )).slice(-1800));throw e;}finally{await page.evaluate(async({c,id,name})=>{const headers={Authorization:'Bearer '+c.token,'x-orbitd-url':c.orbitdUrl};if(!id){const r=await fetch('/api/v1/sessions',{headers});if(r.ok)id=(await r.json()).find(s=>s.name===name)?.id;}if(id)await fetch('/api/v1/sessions/'+id,{method:'DELETE',headers});},{c,id:session?.id,name}).catch(()=>{});await browser.close();}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
