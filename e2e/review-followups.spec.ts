import {test,expect} from '@playwright/test';
// Tauri is mocked like perf-budget.spec.ts: every answer is fresh JSON, as over real IPC.
const mock=(fail:'none'|'second'|'always')=>{
 const w=window as any;w.isTauri=true;w.__loads=0;w.__scrolls=[];
 const now='2026-11-21T00:00:00Z',take=(id:string)=>({id,asset_id:'a'+id,path:id+'.wav',duration_ms:3000,sample_rate:48000,created_at:now});
 const segment={id:'s1',text:'Xin chào',normalized_text:'Xin chào',voice_id:'v1',speaker:'Người dẫn',gap_ms:300,takes:[take('t1')],selected_take_id:'t1',trim_start_ms:0,trim_end_ms:null,fade_in_ms:0,fade_out_ms:0,gain_db:0,chapter:null};
 const transcript=[{id:'r1',start_ms:0,end_ms:1000,text:'Dòng một'},{id:'r2',start_ms:1000,end_ms:2000,text:'Dòng hai'}];
 const project={id:'p1',name:'Thử',updated_at:now,revision:1,transcript,dictionary:{},source_asset_id:'src',segments:[segment]};
 const jobs=[{id:'j1',kind:'tts',project_id:'p1',payload:{segment_id:'s1',text:'Xin chào'},status:'succeeded',progress:1,error:null,result:{asset_id:'at2',take_id:'t2'},created_at:now,updated_at:now}];
 // A running job makes every poll hand the app a new jobs list, which re-runs the reload effect each time.
 if(fail==='always')jobs.push({...jobs[0],id:'j2',status:'running',progress:0.5,result:null} as any);
 const ipc=(v:unknown)=>JSON.parse(JSON.stringify(v));
 w.__TAURI_INTERNALS__={convertFileSrc:(p:string)=>p,transformCallback:()=>1,unregisterCallback:()=>{},metadata:{currentWindow:{label:'main'},currentWebview:{label:'main',windowLabel:'main'}},
  invoke:async(cmd:string)=>{switch(cmd){
   case 'list_projects':return [{id:'p1',name:project.name,updated_at:now,revision:1}];
   case 'load_project':w.__loads++;if(fail==='second'&&w.__loads===2||fail==='always'&&w.__loads>1)throw Error('database is locked');return ipc(w.__loads>1?{...project,segments:[{...segment,takes:[take('t1'),take('t2')]}]}:project);
   case 'get_asset':return {id:'src',path:'goc.wav',name:'goc.wav',duration_ms:2000,sample_rate:48000};
   case 'list_jobs':return ipc(jobs);case 'list_voices':case 'list_models':return [];case 'get_settings':return {dictionary:{}};
   case 'runtime_status':return {python_ready:true,ffmpeg_ready:true,worker_ready:true,native_worker_ready:true,python_path:null,ffmpeg_path:null,native_worker_path:null,fallback_count:0,message:''};
   default:return null;}}};
 const scroll=Element.prototype.scrollIntoView;
 Element.prototype.scrollIntoView=function(this:Element,arg?:boolean|ScrollIntoViewOptions){w.__scrolls.push(typeof arg==='object'?arg.behavior:arg);return scroll.call(this,arg);};
};
const open=async(page:import('@playwright/test').Page)=>{await page.getByRole('button',{name:'Dự án',exact:true}).click();await page.getByRole('button',{name:'Mở dự án'}).click();};
const loads=(page:import('@playwright/test').Page)=>page.evaluate(()=>(window as any).__loads as number);

test('a failed reload after a finished TTS job is retried until the new take arrives, then stops',async({page})=>{
 await page.addInitScript(mock,'second');await page.goto('/');await open(page);
 // Load 1 opens the project, load 2 (after the finished job) fails, load 3 is the retry.
 await expect.poll(()=>loads(page),{timeout:10000}).toBe(3);
 await expect(page.locator('.inspector select option',{hasText:/^Take /})).toHaveCount(2);
 await page.waitForTimeout(3500);expect(await loads(page)).toBe(3);
});

test('a reload that keeps failing while a job runs retries at the poll pace instead of piling up retries',async({page})=>{
 test.setTimeout(60000);
 await page.addInitScript(mock,'always');await page.goto('/');await open(page);
 await expect.poll(()=>loads(page)).toBeGreaterThan(1);await page.waitForTimeout(10000);
 // Polls and retries are both 2.5 s apart, so at most about two loads per 2.5 s; piled-up retries add one more each poll.
 const before=await loads(page);await page.waitForTimeout(5000);
 expect(await loads(page)-before).toBeLessThanOrEqual(5);
});

test('following the playing transcript row scrolls instantly under reduced motion and smoothly otherwise',async({page})=>{
 await page.addInitScript(mock,'none');await page.goto('/');await open(page);
 await page.getByRole('button',{name:/Chép lời/}).first().click();
 const audio=page.locator('.source-player audio');await expect(audio).toBeAttached();
 // No real playback: report the player as playing at a given time and fire the event the app listens to.
 const playAt=(s:number)=>audio.evaluate((a:HTMLAudioElement,s)=>{Object.defineProperty(a,'paused',{get:()=>false,configurable:true});Object.defineProperty(a,'currentTime',{get:()=>s,configurable:true});a.dispatchEvent(new Event('timeupdate'));},s);
 const scrolls=()=>page.evaluate(()=>(window as any).__scrolls as unknown[]);
 await page.emulateMedia({reducedMotion:'reduce'});await playAt(1.5);
 await expect(page.locator('.transcript-row[data-row="r2"]')).toHaveAttribute('aria-current','true');await expect.poll(async()=>(await scrolls()).at(-1)).toBe('auto');
 await page.emulateMedia({reducedMotion:'no-preference'});await playAt(0.5);
 await expect(page.locator('.transcript-row[data-row="r1"]')).toHaveAttribute('aria-current','true');await expect.poll(async()=>(await scrolls()).at(-1)).toBe('smooth');
});
