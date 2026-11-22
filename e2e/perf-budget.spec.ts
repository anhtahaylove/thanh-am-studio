import {test,expect,type BrowserContext} from '@playwright/test';
import {readFileSync} from 'node:fs';
// A long script stays responsive: a keystroke re-renders only its own segment row, and a poll that brings nothing new renders nothing.
// Tauri is mocked like chapters.spec.ts, every answer as fresh JSON like real IPC. Budgets are for this dev server (development React,
// StrictMode). On 800 segments before the memoized rows and the unchanged-poll skip, a keystroke took ~960 ms and every poll was a
// ~900 ms long task on the machine that set them; after, ~110 ms and none.
const IDLE_MS=100,KEY_MS=400;
const mock=({n,live}:{n:number;live:boolean})=>{
 const w=window as any;w.isTauri=true;w.__loads=0;w.__lt=[];w.__keys=[];
 const take=(id:string)=>({id,asset_id:'a'+id,path:id+'.wav',duration_ms:9000,sample_rate:48000,created_at:'2026-11-20T00:00:00Z',check:{model:'whisper-small',wer:0.02,heard:'x',mismatches:[],words:Array.from({length:30},(_,k)=>({text:'từ'+k,start_ms:k*200}))}});
 const text='Đây là một câu thử nghiệm khá dài để mô phỏng kịch bản tiếng Việt thật, có dấu và có nhiều từ trong một đoạn văn bình thường.';
 let project:any={id:'p1',name:'Sách nói',updated_at:'2026-11-20T00:00:00Z',revision:1,transcript:[],dictionary:{},source_asset_id:null,segments:Array.from({length:n},(_,i)=>({id:'s'+i,text:text+' '+i,normalized_text:text+' '+i,voice_id:'v'+(i%25),speaker:'Người dẫn',gap_ms:300,takes:[take('t'+i+'a'),take('t'+i+'b')],selected_take_id:'t'+i+'a',trim_start_ms:0,trim_end_ms:null,fade_in_ms:0,fade_out_ms:0,gain_db:0,chapter:i%100===0?'Chương '+(i/100+1):null}))};
 const voices=Array.from({length:25},(_,i)=>({id:'v'+i,name:'Giọng '+i,kind:'preset',reference_asset_id:null,consent:true,engine_voice_id:'v'+i}));
 const jobs=Array.from({length:n},(_,i)=>({id:'j'+i,kind:'tts',project_id:'p1',payload:{segment_id:'s'+i,text},status:live&&i<32?'running':'succeeded',progress:live&&i<32?(i?0:0.42):1,error:null,result:live&&i<32?null:{asset_id:'r'+i,take_id:'t'+i+'a'},created_at:'2026-11-20T00:00:00Z',updated_at:'2026-11-20T00:00:00Z'})); // `live`: the first segment's job runs at 42 %, the next 31 are running with no progress yet (a batch)
 const models=['vieneu-v3','whisper-small'].map(id=>({id,name:id,engine:'tts',kind:'model',installed:true,revision:'x',license:'MIT',description:''}));
 const ipc=(v:unknown)=>JSON.parse(JSON.stringify(v));
 w.__TAURI_INTERNALS__={convertFileSrc:(p:string)=>p,transformCallback:()=>1,unregisterCallback:()=>{},metadata:{currentWindow:{label:'main'},currentWebview:{label:'main',windowLabel:'main'}},
  invoke:async(cmd:string,args:any)=>{switch(cmd){
   case 'list_projects':return [{id:project.id,name:project.name,updated_at:project.updated_at,revision:project.revision}];case 'load_project':w.__loads++;return ipc(project);
   case 'list_voices':return ipc(voices);case 'list_models':return ipc(models);case 'list_jobs':if(live)jobs[0].progress=Math.min(.99,jobs[0].progress+.01);return ipc(jobs);case 'get_settings':return {dictionary:{}};
   case 'runtime_status':return {python_ready:true,ffmpeg_ready:true,worker_ready:true,native_worker_ready:true,python_path:null,ffmpeg_path:null,native_worker_path:null,fallback_count:0,message:''};
   case 'save_project':project={...ipc(args.project),revision:args.project.revision+1};return ipc(project);
   default:return null;}}};
 new PerformanceObserver(l=>{for(const e of l.getEntries())w.__lt.push(Math.round(e.duration));}).observe({type:'longtask'});
 // Event Timing reports interactions of 16 ms or more; a keystroke's keydown, keypress and keyup share one interactionId.
 new PerformanceObserver(l=>{for(const e of l.getEntries() as any[])if(e.interactionId)w.__keys.push({id:e.interactionId,ms:e.duration});}).observe({type:'event',durationThreshold:16} as PerformanceObserverInit);
};

// `live`: 1 running job and 31 batch jobs; 32 rows show a ring. The running job's progress moves on every poll (42 %, 43 %, ...), as a real job does, so its label changes each time and the jobs map is new on every poll. Only that one row may re-render.
const script800=async(page:import('@playwright/test').Page,live:boolean,narrow=false)=>{
 test.setTimeout(180000);
 if(narrow)await page.setViewportSize({width:800,height:900}); // at 920 px and below the selected segment's panel is inside its row
 await page.addInitScript(mock,{n:800,live});await page.goto('/');
 await page.getByRole('button',{name:'Dự án',exact:true}).click();await page.getByRole('button',{name:'Mở dự án'}).click();
 // CSS selectors from here on: computing accessible names over ~70k nodes takes seconds.
 await expect(page.locator('textarea[aria-label="Nội dung đoạn 800"]')).toBeAttached({timeout:90000});
 // Finished TTS jobs make the app load the project once more; let that render land before measuring.
 await expect.poll(()=>page.evaluate(()=>(window as any).__loads),{timeout:30000}).toBe(2);await page.waitForTimeout(2000);
 if(live)await expect(page.locator('.segment .job-ring')).toHaveCount(32);
 if(narrow)await page.locator('textarea[aria-label="Nội dung đoạn 400"]').click(); // the selected row, with the panel inside it, is not the job row: a poll must leave it alone too
 const label=live?await page.locator('.segment .job-ring').first().textContent():null;
 await page.evaluate(()=>{(window as any).__lt=[];});await page.waitForTimeout(6000); // two or three polls
 if(live)expect(await page.locator('.segment .job-ring').first().textContent(),'the running job advanced, so its label changed').not.toBe(label);
 const idle:number[]=await page.evaluate(()=>(window as any).__lt);
 expect.soft(Math.max(0,...idle),`long tasks (ms) during 6 s of polling: ${idle.join(', ')||'none'}`).toBeLessThan(IDLE_MS);
 const box=page.locator('textarea[aria-label="Nội dung đoạn 400"]');await box.click();await page.keyboard.press('End');await page.waitForTimeout(500);
 await page.evaluate(()=>{(window as any).__keys=[];});
 await page.keyboard.type('abcdefghij',{delay:80});await expect(box).toHaveValue(/abcdefghij$/);
 const keys:{id:number;ms:number}[]=await page.evaluate(()=>(window as any).__keys),slowest=new Map<number,number>();
 for(const k of keys)slowest.set(k.id,Math.max(slowest.get(k.id)??0,k.ms));
 const ms=[...slowest.values(),...Array(Math.max(0,10-slowest.size)).fill(16)].sort((a,b)=>a-b); // an unreported keystroke took under 16 ms
 console.log(`perf: ${narrow?'800 segments at 800 px wide: ':''}${live?'800 segments with 1 running and 31 batch jobs: ':''}idle long tasks (ms) ${idle.join(', ')||'none'}; keystrokes (ms) ${ms.map(Math.round).join(', ')}`); // the list reporter prints this, so CI shows the margin on a pass
 expect(ms[4],`median keystroke latency; all (ms): ${ms.join(', ')}`).toBeLessThan(KEY_MS);
};
test('an 800-segment script stays responsive: no long task while polls bring nothing new, and keystrokes stay fast',async({page})=>{await script800(page,false);});
test('an 800-segment script with 1 running and 31 batch jobs stays responsive: polls that change nothing for a row re-render no row, and keystrokes stay fast',async({page})=>{await script800(page,true);});
test('an 800-segment script at 800 px wide, with the panel of the selected segment inside its row, stays responsive: the same, and a keystroke re-renders only that row',async({page})=>{await script800(page,true,true);});
// One long selected segment: the normalized-text highlights are worked out only while "Văn bản sau chuẩn hóa" is open, so typing
// with it closed costs what it did before them. On the machine that set this, a keystroke in 1,500 words took ~100 ms when they were
// computed on every render and ~30 ms without them.
const LONG_KEY_MS=60;
test('typing in a 1,500-word selected segment stays fast while the normalized text is closed',async({page})=>{
 await page.addInitScript(()=>{
  const w=window as any;w.isTauri=true;w.__keys=[];
  const base='Hôm nay trời đẹp, chúng ta đi 5 km tới TP.HCM dùng AI và 50k tiền.'.split(' '),text=Array.from({length:1500},(_,i)=>base[i%base.length]).join(' ');
  let project:any={id:'p1',name:'Dài',updated_at:'2026-11-20T00:00:00Z',revision:1,transcript:[],dictionary:{AI:'ây ai'},source_asset_id:null,segments:[{id:'s0',text,normalized_text:text,voice_id:null,speaker:'Người dẫn',gap_ms:300,takes:[],selected_take_id:null,trim_start_ms:0,trim_end_ms:null,fade_in_ms:0,fade_out_ms:0,gain_db:0}]};
  const ipc=(v:unknown)=>JSON.parse(JSON.stringify(v));
  w.__TAURI_INTERNALS__={convertFileSrc:(p:string)=>p,transformCallback:()=>1,unregisterCallback:()=>{},metadata:{currentWindow:{label:'main'},currentWebview:{label:'main',windowLabel:'main'}},
   invoke:async(cmd:string,args:any)=>{switch(cmd){
    case 'list_projects':return [{id:project.id,name:project.name,updated_at:project.updated_at,revision:project.revision}];case 'load_project':return ipc(project);
    case 'list_voices':case 'list_models':case 'list_jobs':return [];case 'get_settings':return {dictionary:{}};
    case 'runtime_status':return {python_ready:true,ffmpeg_ready:true,worker_ready:true,native_worker_ready:true,python_path:null,ffmpeg_path:null,native_worker_path:null,fallback_count:0,message:''};
    case 'save_project':project={...ipc(args.project),revision:args.project.revision+1};return ipc(project);
    default:return null;}}};
  new PerformanceObserver(l=>{for(const e of l.getEntries() as any[])if(e.interactionId)w.__keys.push({id:e.interactionId,ms:e.duration});}).observe({type:'event',durationThreshold:16} as PerformanceObserverInit);
 });
 await page.goto('/');await page.getByRole('button',{name:'Dự án',exact:true}).click();await page.getByRole('button',{name:'Mở dự án'}).click();
 const box=page.locator('textarea[aria-label="Nội dung đoạn 1"]');await expect(box).toBeAttached({timeout:30000});await expect(page.locator('.normalization')).not.toHaveAttribute('open');
 await box.click();await page.keyboard.press('Control+End');await page.waitForTimeout(800);await page.evaluate(()=>{(window as any).__keys=[];});
 await page.keyboard.type('abcdefghijklmnopqrst',{delay:80});await expect(box).toHaveValue(/abcdefghijklmnopqrst$/);
 const keys:{id:number;ms:number}[]=await page.evaluate(()=>(window as any).__keys),slowest=new Map<number,number>();
 for(const k of keys)slowest.set(k.id,Math.max(slowest.get(k.id)??0,k.ms));
 const ms=[...slowest.values(),...Array(Math.max(0,20-slowest.size)).fill(16)].sort((a,b)=>a-b);
 console.log(`perf: long-segment keystrokes (ms) ${ms.map(Math.round).join(', ')}`);
 expect(ms[10],`median keystroke latency; all (ms): ${ms.join(', ')}`).toBeLessThan(LONG_KEY_MS);
});
// A long transcript: each row is memoized (TranscriptRow), so a keystroke re-renders only its own row. Before that, a keystroke in a
// 1,200-row transcript re-rendered every row, and the median at 1,200 rows was many times the median at 100.
// The rows are synthetic and generated: word salad, 3 speakers, about 3.7 s each, a silent row at every 200th, so the fixture can be regenerated.
const ROWS:{id:string}[]=JSON.parse(readFileSync('e2e/fixtures/transcript-1200.json','utf8'));
const mockTranscript=(rows:unknown[])=>{
 const w=window as any;w.isTauri=true;w.__lt=[];w.__keys=[];
 let project:any={id:'p1',name:'Phỏng vấn',updated_at:'2026-11-20T00:00:00Z',revision:1,transcript:rows,dictionary:{},source_asset_id:null,segments:[]};
 const ipc=(v:unknown)=>JSON.parse(JSON.stringify(v));
 w.__TAURI_INTERNALS__={convertFileSrc:(p:string)=>p,transformCallback:()=>1,unregisterCallback:()=>{},metadata:{currentWindow:{label:'main'},currentWebview:{label:'main',windowLabel:'main'}},
  invoke:async(cmd:string,args:any)=>{switch(cmd){
   case 'list_projects':return [{id:project.id,name:project.name,updated_at:project.updated_at,revision:project.revision}];case 'load_project':return ipc(project);
   case 'list_voices':case 'list_models':case 'list_jobs':return [];case 'get_settings':return {dictionary:{}};
   case 'runtime_status':return {python_ready:true,ffmpeg_ready:true,worker_ready:true,native_worker_ready:true,python_path:null,ffmpeg_path:null,native_worker_path:null,fallback_count:0,message:''};
   case 'save_project':project={...ipc(args.project),revision:args.project.revision+1};return ipc(project);
   default:return null;}}};
 new PerformanceObserver(l=>{for(const e of l.getEntries())w.__lt.push(Math.round(e.duration));}).observe({type:'longtask'});
 new PerformanceObserver(l=>{for(const e of l.getEntries() as any[])if(e.interactionId)w.__keys.push({id:e.interactionId,ms:e.duration});}).observe({type:'event',durationThreshold:16} as PerformanceObserverInit);
};
// Opens the transcript in a fresh page and returns the long tasks of a 6 s idle window (when `idle`) and the sorted keystroke times in row `id`.
// With a `query` the search box is filled first and the hits are marked in every matching row.
const measure=async(context:BrowserContext,rows:{id:string}[],id:string,idle=true,query='')=>{
 const page=await context.newPage();await page.addInitScript(mockTranscript,rows);await page.goto('/');
 await page.getByRole('button',{name:'Dự án',exact:true}).click();await page.getByRole('button',{name:'Mở dự án'}).click();await page.getByRole('button',{name:'Chép lời',exact:true}).click();
 const box=page.locator(`[data-row="${id}"] textarea`);await expect(box).toBeAttached({timeout:90000});
 if(query){await page.locator('input[aria-label="Tìm trong bản chép lời"]').fill(query);await expect(page.locator(`[data-row="${id}"] .match-preview`)).toBeAttached({timeout:90000});await expect(page.getByRole('button',{name:/^Thay \d+ chỗ$/})).toBeVisible();}
 await page.waitForTimeout(2000);
 await page.evaluate(()=>{(window as any).__lt=[];});if(idle)await page.waitForTimeout(6000); // two or three polls
 const longTasks:number[]=await page.evaluate(()=>(window as any).__lt);
 await box.click();await page.keyboard.press('End');await page.waitForTimeout(500);await page.evaluate(()=>{(window as any).__keys=[];});
 await page.keyboard.type('abcdefghij',{delay:80});await expect(box).toHaveValue(/abcdefghij$/);
 const keys:{id:number;ms:number}[]=await page.evaluate(()=>(window as any).__keys),slowest=new Map<number,number>();
 for(const k of keys)slowest.set(k.id,Math.max(slowest.get(k.id)??0,k.ms));
 await page.close();
 return {idle:longTasks,ms:[...slowest.values(),...Array(Math.max(0,10-slowest.size)).fill(16)].sort((a,b)=>a-b)};
};
test('a 1,200-row transcript stays responsive: no long task while polls bring nothing new, and a keystroke in row 600 stays fast',async({context})=>{
 test.setTimeout(240000);
 const big=await measure(context,ROWS,'r600'),small=await measure(context,ROWS.slice(0,100),'r50',false);
 // Evidence only, not a gate: App still does O(n) work per keystroke (speakerStats, suspiciousRows, the hits filter), and an unreported keystroke counts as 16 ms.
 console.log(`perf: transcript 1200 rows: idle long tasks (ms) ${big.idle.join(', ')||'none'}; keystrokes (ms) ${big.ms.map(Math.round).join(', ')}; 100 rows: keystrokes (ms) ${small.ms.map(Math.round).join(', ')}; median ratio 1200/100 ${(big.ms[4]/small.ms[4]).toFixed(2)}`);
 expect.soft(Math.max(0,...big.idle),`long tasks (ms) during 6 s of polling: ${big.idle.join(', ')||'none'}`).toBeLessThan(IDLE_MS);
 expect(big.ms[4],`median keystroke latency; all (ms): ${big.ms.join(', ')}`).toBeLessThan(KEY_MS);
});
// Search 2.0: with a query that marks nearly every row (the letter "a": 1,194 of the 1,200 rows), a keystroke still re-renders only its own row, and
// the O(n) search work per keystroke (hits, the exact counts behind "Thay N chỗ") stays inside the budget.
test('a 1,200-row transcript with an active search stays responsive: no long task while polls bring nothing new, and a keystroke in row 600 stays fast',async({context})=>{
 test.setTimeout(240000);
 const found=await measure(context,ROWS,'r600',true,'a');
 console.log(`perf: transcript 1200 rows with a search: idle long tasks (ms) ${found.idle.join(', ')||'none'}; keystrokes (ms) ${found.ms.map(Math.round).join(', ')}`);
 expect.soft(Math.max(0,...found.idle),`long tasks (ms) during 6 s of polling: ${found.idle.join(', ')||'none'}`).toBeLessThan(IDLE_MS);
 expect(found.ms[4],`median keystroke latency; all (ms): ${found.ms.join(', ')}`).toBeLessThan(KEY_MS);
});
