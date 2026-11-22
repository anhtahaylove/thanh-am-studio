import {test,expect,type Page} from '@playwright/test';
// A segment row shows what its newest tts job is doing: a ring and a Vietnamese label in the head. A finished job is announced once, and the take count pops only
// when a take arrives while the row is on screen. Tauri is mocked; the test moves jobs on through window hooks, and the app polls every 2.5 s.
type J={segment:string;status:string;progress?:number;created?:string};
const mock=(o:{jobs:J[];takes?:Record<string,number>})=>{
 const w=window as any;w.isTauri=true;w.__announced=[];w.__pops=[];
 const take=(id:string)=>({id,asset_id:'a'+id,path:id+'.wav',duration_ms:2000,sample_rate:24000,created_at:'2026-11-22T00:00:00Z'});
 const segment=(i:number)=>{const n=o.takes?.['s'+i]??0,takes=Array.from({length:n},(_,k)=>take(`t${i}-${k}`));return {id:'s'+i,text:`Câu số ${i}.`,normalized_text:`Câu số ${i}.`,voice_id:null,speaker:'Người dẫn',gap_ms:300,takes,selected_take_id:takes[0]?.id??null,trim_start_ms:0,trim_end_ms:null,fade_in_ms:0,fade_out_ms:0,gain_db:0};};
 const project:any={id:'p1',name:'Tiến trình',updated_at:'2026-11-22T00:00:00Z',revision:1,transcript:[],dictionary:{},source_asset_id:null,segments:[1,2,3,4,5,6,7].map(segment)};
 const mk=(j:J,i:number)=>({id:'j'+i,kind:'tts',project_id:'p1',payload:{segment_id:j.segment,text:'x'},status:j.status,progress:j.progress??0,error:null,result:j.status==='succeeded'?{asset_id:'r'+i}:null,created_at:j.created??'2026-11-22T00:00:0'+(i%10)+'Z',updated_at:'2026-11-22T00:00:00Z'}),jobs:any[]=o.jobs.map(mk);
 const voices:any[]=[];w.__addVoice=()=>voices.push({id:'v1',name:'Giọng mới',kind:'preset',reference_asset_id:null,consent:true,engine_voice_id:'v1'});
 w.__addJob=(j:J)=>jobs.push(mk(j,jobs.length));
 w.__setJob=(id:string,patch:object)=>Object.assign(jobs.find(j=>j.id===id),patch);
 // A finished job: succeeded, with the take it made.
 w.__finish=(id:string)=>{const j=jobs.find(x=>x.id===id),s=project.segments.find((x:any)=>x.id===j.payload.segment_id),t=take(`n${s.takes.length}-${s.id}`);Object.assign(j,{status:'succeeded',progress:1,result:{asset_id:t.asset_id}});s.takes.push(t);s.selected_take_id??=t.id;};
 new MutationObserver(l=>{for(const m of l)for(const n of m.addedNodes)if(n instanceof HTMLElement&&n.parentElement?.matches('.sr-only[aria-live=polite]')&&n.textContent?.startsWith('Đã tạo xong'))w.__announced.push(n.textContent);}).observe(document,{childList:true,subtree:true});
 // Every start of the take-count pop, so a test can tell a pop on arrival from one on mount.
 document.addEventListener('animationstart',e=>{const t=e.target as Element;if(e.animationName.includes('pop-in')&&t.matches('.take-status'))w.__pops.push(t.textContent);},true);
 const ipc=(v:unknown)=>JSON.parse(JSON.stringify(v));
 w.__TAURI_INTERNALS__={convertFileSrc:(p:string)=>p,transformCallback:()=>1,unregisterCallback:()=>{},metadata:{currentWindow:{label:'main'},currentWebview:{label:'main',windowLabel:'main'}},
  invoke:async(cmd:string,args:any)=>{switch(cmd){
   case 'list_projects':return [{id:project.id,name:project.name,updated_at:project.updated_at,revision:project.revision}];case 'load_project':return ipc(project);
   case 'list_voices':return ipc(voices);
   case 'enqueue_job':if(w.__hold)await new Promise(r=>{w.__release=r;});return null;case 'list_models':return [{id:'vieneu-v3',name:'VieNeu v3 Turbo',engine:'tts',installed:true,revision:'r',license:'Apache-2.0',description:''}];
   case 'list_jobs':return ipc(jobs);case 'get_settings':return {dictionary:{}};
   case 'runtime_status':return {python_ready:true,ffmpeg_ready:true,worker_ready:true,python_path:null,ffmpeg_path:null,message:''};
   case 'save_project':return {...ipc(args.project),revision:args.project.revision+1};
   default:return null;}}};
};
const open=async(page:Page,jobs:J[],width=1440,takes:Record<string,number>={})=>{
 await page.setViewportSize({width,height:900});await page.addInitScript(mock,{jobs,takes});await page.goto('/');
 await page.getByRole('button',{name:'Dự án',exact:true}).click();await page.getByRole('button',{name:'Mở dự án',exact:true}).click();
 await expect(page.getByRole('textbox',{name:'Nội dung đoạn 7'})).toBeVisible();
};
const ring=(page:Page,n:number)=>page.locator('.segment').nth(n-1).locator('.job-ring');
const region=(page:Page)=>page.locator('.sr-only[aria-live=polite]');
const pops=(page:Page)=>page.evaluate(()=>(window as any).__pops as string[]);
const addJob=(page:Page,j:object)=>page.evaluate(x=>(window as any).__addJob(x),j);
const announced=(page:Page)=>page.evaluate(()=>(window as any).__announced as string[]);
const set=(page:Page,id:string,patch:object)=>page.evaluate(([i,p])=>(window as any).__setJob(i,p),[id,patch] as [string,object]);
const finish=(page:Page,id:string)=>page.evaluate(i=>(window as any).__finish(i),id);
const ALL:J[]=[{segment:'s1',status:'queued'},{segment:'s2',status:'running',progress:0},{segment:'s3',status:'running',progress:0.424},{segment:'s4',status:'failed'},{segment:'s5',status:'cancelled'},{segment:'s6',status:'interrupted'}];

test('each state reads in the head of its own segment only, in words',async({page})=>{
 await open(page,ALL);
 const texts=['Đang chờ','Chờ trong lô','Đang tạo 42 %','Lỗi · xem Hàng đợi','Đã hủy · Thử lại trong Hàng đợi','Gián đoạn · Thử lại trong Hàng đợi'];
 for(const [i,t] of texts.entries())await expect(ring(page,i+1)).toHaveText(t);
 await expect(ring(page,7)).toHaveCount(0);await expect(page.locator('.segment .job-ring')).toHaveCount(6);
 await expect(page.locator('.segment').nth(2).locator('.job-ring')).toHaveClass(/running/);await expect(page.locator('.segment').nth(3).locator('.job-ring')).toHaveClass(/failed/);
});

test('a segment whose newest job succeeded shows no ring, and a newer job replaces an older failed one',async({page})=>{
 await open(page,[{segment:'s1',status:'failed',created:'2026-11-22T00:00:01Z'},{segment:'s1',status:'queued',created:'2026-11-22T00:00:05Z'},{segment:'s2',status:'failed',created:'2026-11-22T00:00:01Z'},{segment:'s2',status:'succeeded',created:'2026-11-22T00:00:05Z'}]);
 await expect(ring(page,1)).toHaveText('Đang chờ');await expect(ring(page,2)).toHaveCount(0);
});

test('the ring changes shape with the state, so colour is not the only signal',async({page})=>{
 await open(page,ALL);const shapes=await page.locator('.segment .job-ring svg').evaluateAll(l=>l.map(s=>s.innerHTML.replace(/\s+/g,' ')));
 expect(shapes.length).toBe(6);expect(new Set(shapes).size).toBe(6);for(const s of await page.locator('.segment .job-ring svg').all())await expect(s).toHaveAttribute('aria-hidden','true');
});

test('the ring follows its job live: queued, then running with a percentage, then gone when it succeeds',async({page})=>{
 await open(page,[{segment:'s3',status:'queued'}]);await expect(ring(page,3)).toHaveText('Đang chờ');
 await set(page,'j0',{status:'running',progress:0.5});await expect(ring(page,3)).toHaveText('Đang tạo 50 %',{timeout:8000});
 await finish(page,'j0');await expect(ring(page,3)).toHaveCount(0,{timeout:8000});
});

test('a finished job is announced once, with its segment number, and opening a project announces nothing',async({page})=>{
 await open(page,[{segment:'s3',status:'running',progress:0.4},{segment:'s5',status:'succeeded'}]);
 await page.waitForTimeout(3000);expect(await announced(page)).toEqual([]);
 await finish(page,'j0');await expect(region(page).filter({hasText:'Đã tạo xong đoạn 3'})).toHaveCount(1,{timeout:8000});
 await page.waitForTimeout(7000); // the line clears after 6 s
 await set(page,'j1',{status:'running',progress:0.6}); // a later poll that changes the list must not announce the old job again
 await expect(ring(page,5)).toHaveText('Đang tạo 60 %',{timeout:8000});await page.waitForTimeout(3000);
 expect(await announced(page)).toEqual(['Đã tạo xong đoạn 3']);
});

test('the live region is in the page before its text, polite and atomic, and has no status role',async({page})=>{
 await open(page,[{segment:'s2',status:'queued'},{segment:'s7',status:'succeeded'}]);
 await expect(region(page)).toHaveCount(1);await expect(region(page)).toBeEmpty();await expect(region(page)).toHaveAttribute('aria-atomic','true');await expect(region(page)).not.toHaveAttribute('role','status');await expect(region(page)).toHaveClass(/sr-only/);
 await set(page,'j0',{status:'running',progress:0.2});await page.waitForTimeout(3000);await finish(page,'j0');
 await expect(region(page)).toHaveText('Đã tạo xong đoạn 2',{timeout:8000});await expect(region(page)).toBeEmpty({timeout:8000});expect((await announced(page)).length).toBe(1);
});

test('the same segment finishing twice within 6 s is announced twice, not swallowed as unchanged text',async({page})=>{
 await open(page,[{segment:'s3',status:'running',progress:0.3},{segment:'s7',status:'succeeded'}]);
 await finish(page,'j0');await expect.poll(()=>announced(page),{timeout:8000}).toHaveLength(1);
 await addJob(page,{segment:'s3',status:'running',progress:0.2,created:'2026-11-22T00:00:09Z'});await expect(ring(page,3)).toHaveText('Đang tạo 20 %',{timeout:8000});
 await finish(page,'j2');await expect.poll(()=>announced(page),{timeout:8000}).toHaveLength(2);
 expect(await announced(page)).toEqual(['Đã tạo xong đoạn 3','Đã tạo xong đoạn 3']);
});

test('with the first-run checklist shown, the first success is announced once, by the checklist, and later ones by the segment line',async({page})=>{
 await open(page,[{segment:'s3',status:'running',progress:0.4},{segment:'s5',status:'running',progress:0.4}]);
 await expect(page.getByRole('heading',{name:'Bắt đầu với Thanh Âm'})).toBeVisible();
 await finish(page,'j0');await expect(page.getByText(/Đã xong bước 3/)).toBeVisible({timeout:8000});
 await page.waitForTimeout(3000);expect(await announced(page)).toEqual([]);
 await finish(page,'j1');await expect.poll(()=>announced(page),{timeout:8000}).toEqual(['Đã tạo xong đoạn 5']);
});

test('the take count pops when a take arrives while the row is on screen, never when a project opens, and not under reduced motion',async({page})=>{
 await open(page,[{segment:'s3',status:'running',progress:0.4}],1440,{s1:1,s2:2});
 await page.waitForTimeout(500);await expect(page.locator('.take-status.pop')).toHaveCount(0);expect(await pops(page)).toEqual([]);
 // Leaving the page and coming back mounts the rows again: still no pop.
 await page.getByRole('button',{name:/^Hàng đợi/}).click();await page.getByRole('button',{name:/^Tạo giọng đọc/}).click();await expect(page.getByRole('textbox',{name:'Nội dung đoạn 7'})).toBeVisible();await page.waitForTimeout(500);expect(await pops(page)).toEqual([]);
 await finish(page,'j0');await expect(page.locator('.segment').nth(2).locator('.take-status.pop')).toHaveCount(1,{timeout:10000});
 expect(await page.locator('.segment').nth(2).locator('.take-status').evaluate(e=>getComputedStyle(e).animationName)).toBe('pop-in');
 await expect(page.locator('.segment').nth(2).locator('.take-status')).toHaveText('1 take');expect(await pops(page)).toEqual(['1 take']);
});
test('under reduced motion the take pop does not animate',async({page})=>{
 await page.emulateMedia({reducedMotion:'reduce'});await open(page,[{segment:'s3',status:'running',progress:0.4}]);
 await finish(page,'j0');const t=page.locator('.segment').nth(2).locator('.take-status.pop');await expect(t).toHaveCount(1,{timeout:10000});
 expect(await t.evaluate(e=>getComputedStyle(e).animationName)).toBe('none');
});

for(const width of [1440,800,640])test(`the head fits at ${width} px: no sideways scroll, the ring stays inside the row`,async({page})=>{
 await open(page,[{segment:'s6',status:'interrupted'},{segment:'s2',status:'failed'}],width,{s6:1});
 const m=await page.evaluate(()=>{const el=document.documentElement,r=document.querySelectorAll('.segment')[5].querySelector('.job-ring')!.getBoundingClientRect(),row=document.querySelectorAll('.segment')[5].getBoundingClientRect(),head=document.querySelectorAll('.segment')[5].querySelector('.segment-head')!.getBoundingClientRect(),take=document.querySelectorAll('.segment')[5].querySelector('.take-status')!.getBoundingClientRect();return {above:r.top-take.bottom,over:el.scrollWidth-el.clientWidth,right:r.right,rowRight:row.right,headRight:head.right,left:r.left,rowLeft:row.left};});
 expect(m.over).toBeLessThanOrEqual(0);expect(m.above).toBeGreaterThanOrEqual(-0.5); // second line of the head, under the chips
 expect(m.right).toBeLessThanOrEqual(m.headRight+0.5);expect(m.right).toBeLessThanOrEqual(m.rowRight);expect(m.left).toBeGreaterThanOrEqual(m.rowLeft);
});

for(const theme of ['light','dark'])test(`every state's label has AA contrast against the row in ${theme} mode`,async({page})=>{
 await page.emulateMedia({colorScheme:theme as 'light'|'dark'});await open(page,ALL);
 const lum=(c:string)=>{const [r,g,b]=(c.match(/[\d.]+/g)??[]).slice(0,3).map(Number).map(v=>{v/=255;return v<=.03928?v/12.92:((v+.055)/1.055)**2.4;});return .2126*r+.7152*g+.0722*b;};
 const rows=await page.locator('.segment').evaluateAll(l=>l.slice(0,6).map(s=>{const j=getComputedStyle(s.querySelector('.job-ring')!);let bg='',e:Element|null=s;while(e&&(!bg||bg==='rgba(0, 0, 0, 0)')){bg=getComputedStyle(e).backgroundColor;e=e.parentElement;}return {fg:j.color,bg,theme:document.documentElement.dataset.theme};}));
 for(const r of rows){expect(r.theme).toBe(theme);const a=lum(r.fg),b=lum(r.bg),ratio=(Math.max(a,b)+.05)/(Math.min(a,b)+.05);expect(ratio,`${r.fg} on ${r.bg}`).toBeGreaterThanOrEqual(4.5);}
});

test('a segment that is running one job keeps showing it when another is queued, and the first one finishing is still announced',async({page})=>{
 await open(page,[{segment:'s3',status:'running',progress:0.4,created:'2026-11-22T00:00:01Z'},{segment:'s3',status:'queued',created:'2026-11-22T00:00:05Z'},{segment:'s7',status:'succeeded'}]);
 await expect(ring(page,3)).toHaveText('Đang tạo 40 %');
 await finish(page,'j0');await expect.poll(()=>announced(page),{timeout:8000}).toEqual(['Đã tạo xong đoạn 3']);await expect(ring(page,3)).toHaveText('Đang chờ');
});

test('with the checklist brought back from the palette, a success it does not announce is announced by the segment line',async({page})=>{
 await open(page,[{segment:'s3',status:'running',progress:0.4},{segment:'s5',status:'running',progress:0.4}]);
 await finish(page,'j0');await expect(page.getByText(/Đã xong bước 3/)).toBeVisible({timeout:8000});
 await page.keyboard.press('Control+k');await page.getByRole('dialog',{name:'Bảng lệnh'}).getByRole('option',{name:'Hiện hướng dẫn bắt đầu'}).click();
 await expect(page.getByRole('heading',{name:'Bắt đầu với Thanh Âm'})).toBeVisible();
 await set(page,'j0',{status:'failed'});await expect(page.getByText('Chưa làm',{exact:true})).toHaveCount(1,{timeout:8000}); // step 3 is undone and the checklist has already told it once
 await finish(page,'j1');await expect.poll(()=>announced(page),{timeout:8000}).toEqual(['Đã tạo xong đoạn 5']);
});

test('a checklist notice that comes late, with no job change, does not swallow the next segment announcement',async({page})=>{
 await open(page,[{segment:'s3',status:'running',progress:0.4},{segment:'s5',status:'running',progress:0.4}]);
 await page.getByRole('button',{name:'Ẩn hướng dẫn'}).click();
 await finish(page,'j0');await expect.poll(()=>announced(page),{timeout:8000}).toEqual(['Đã tạo xong đoạn 3']);
 await page.keyboard.press('Control+k');await page.getByRole('dialog',{name:'Bảng lệnh'}).getByRole('option',{name:'Hiện hướng dẫn bắt đầu'}).click();
 await expect(page.getByText(/Đã xong bước 3/)).toBeVisible({timeout:8000}); // the checklist speaks now, on a render that is not a poll
 await finish(page,'j1');await expect.poll(()=>announced(page),{timeout:8000}).toEqual(['Đã tạo xong đoạn 3','Đã tạo xong đoạn 5']);
});

// The row list is memoized, so these pin what it must be rebuilt for.
test('the generate button of every row is disabled while the app is busy, and enabled again after',async({page})=>{
 await open(page,[]);await page.evaluate(()=>{(window as any).__hold=true;});
 const buttons=page.locator('.segment .segment-toolbar .quiet.accent');await expect(buttons.nth(1)).toBeEnabled();
 await buttons.nth(0).click();await expect(buttons.nth(1)).toBeDisabled();await expect(buttons.nth(6)).toBeDisabled();
 await page.evaluate(()=>(window as any).__release());await expect(buttons.nth(1)).toBeEnabled();await expect(buttons.nth(6)).toBeEnabled();
});

test('a voice added while the page is open appears in the voice select of every row',async({page})=>{
 await open(page,[]);const select=page.getByRole('combobox',{name:'Giọng đoạn 3'});
 await expect(select.locator('option')).toHaveCount(1);
 await page.evaluate(()=>(window as any).__addVoice());
 await expect(select.locator('option')).toHaveCount(2,{timeout:8000});await expect(select).toContainText('Giọng mới');
});
