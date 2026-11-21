import {test,expect} from '@playwright/test';
import type {Page} from '@playwright/test';
import {readFileSync,writeFileSync} from 'node:fs';
// Locks every payload the UI hands the backend (every enqueue_job; clone_preview is one) to e2e/fixtures/payloads-1.0.21.json.
// That file is owner-locked: a change to it can change spoken or rendered audio and needs owner listening. A UI change may rewrite the
// driver steps below, never the expected payloads. Each fixture entry is one test, and an entry no scenario drives fails, so a dropped or
// renamed scenario cannot pass silently. The payloads a run sent are written to its test output (payloads.json).
// Tauri is mocked like perf-budget.spec.ts, with the project in e2e/fixtures/payload-project.json; arguments are recorded as the backend
// gets them (JSON over IPC). A TTS job finishes at once and, like store.rs, adds a take that becomes the selected one when the segment has
// none; every other job stays queued until a test moves it on.
const data=JSON.parse(readFileSync('e2e/fixtures/payload-project.json','utf8'));
const expected:Record<string,unknown[]>=JSON.parse(readFileSync('e2e/fixtures/payloads-1.0.21.json','utf8'));
const version=JSON.parse(readFileSync('package.json','utf8')).version;
const mock=(d:any)=>{
 const w=window as any,ipc=(v:unknown)=>JSON.parse(JSON.stringify(v)),jobs:any[]=[];let project=d.project;w.isTauri=true;w.__sent=[];w.__jobs=jobs;
 const models=['vieneu-v3','whisper-small','whisper-turbo','diarization','htdemucs','separation-runtime'].map(id=>({id,name:id,engine:'x',kind:id==='separation-runtime'?'runtime':'model',installed:true,revision:'r',license:'',description:''}));
 w.__TAURI_INTERNALS__={convertFileSrc:(p:string)=>p,transformCallback:()=>1,unregisterCallback:()=>{},metadata:{currentWindow:{label:'main'},currentWebview:{label:'main',windowLabel:'main'}},
  invoke:async(cmd:string,args:any)=>{switch(cmd){
   case 'list_projects':return [{id:project.id,name:project.name,updated_at:project.updated_at,revision:project.revision}];case 'load_project':return ipc(project);
   case 'save_project':project={...ipc(args.project),revision:args.project.revision+1};return ipc(project);
   case 'list_voices':return ipc(d.voices);case 'list_models':return ipc(models);case 'list_jobs':return ipc([...jobs].reverse());case 'get_settings':return ipc(d.settings);
   case 'runtime_status':return {python_ready:true,ffmpeg_ready:true,worker_ready:true,native_worker_ready:true,python_path:null,ffmpeg_path:null,native_worker_path:null,fallback_count:0,message:''};
   case 'get_asset':return ipc(d.source);
   case 'plugin:dialog|open':return 'C:\\media\\phỏng vấn.wav';
   case 'import_asset':return {id:'a-picked',path:args.path,name:'phỏng vấn.wav',duration_ms:60000,sample_rate:16000};
   case 'enqueue_job':{const a=ipc(args);w.__sent.push(a);const job:any={id:'j'+(jobs.length+1),kind:a.kind,project_id:a.projectId,payload:a.payload,status:'queued',progress:0,error:null,result:null,created_at:new Date(Date.now()+jobs.length).toISOString(),updated_at:new Date().toISOString()};
    const s=a.kind==='tts'&&project.segments.find((x:any)=>x.id===a.payload.segment_id);
    if(s){const n=s.takes.length,take={id:`take-${s.id}-${n}`,asset_id:`asset-${s.id}-${n}`,path:`C:\\takes\\${s.id}-${n}.wav`,duration_ms:2000,sample_rate:48000,created_at:'2026-11-21T00:00:00Z'};
     project={...project,segments:project.segments.map((x:any)=>x===s?{...x,takes:[...x.takes,take],selected_take_id:x.selected_take_id??take.id}:x)};Object.assign(job,{status:'succeeded',progress:1,result:{asset_id:take.asset_id,take_id:take.id}});}
    jobs.push(job);return ipc(job);}
   default:return null;}}};
};
const sorted=(v:any):any=>Array.isArray(v)?v.map(sorted):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sorted(v[k])])):v;
// Canonical text: keys sorted; a random id (the chapter `batch`, the id of a segment the app makes) named by its first appearance, so which
// payloads share one stays locked; the app version as a placeholder, so a release bump is not a payload change.
const canon=(sent:any[])=>{const ids=new Map<string,string>();return JSON.stringify(sorted(sent.map(a=>a.kind==='clone_preview'&&a.payload.version===version?{...a,payload:{...a.payload,version:'<version>'}}:a)),null,1)
 .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,m=>{if(!ids.has(m))ids.set(m,`<uuid ${ids.size+1}>`);return ids.get(m)!;});};
const open=async(page:Page)=>{
 await page.addInitScript(mock,data);await page.goto('/');await page.getByRole('button',{name:'Dự án',exact:true}).click();await page.getByRole('button',{name:'Mở dự án'}).click();
 await expect(page.getByRole('textbox',{name:'Nội dung đoạn 7'})).toBeVisible();
};
const go=(page:Page,label:string)=>page.getByRole('navigation',{name:'Điều hướng chính'}).getByRole('button',{name:label,exact:true}).click();
const check=(page:Page,label:string)=>page.getByRole('checkbox',{name:label}).check();
// What each action shows once it has sent everything it sends.
const queued=(page:Page)=>expect(page.getByRole('status').filter({hasText:'Đã thêm vào hàng đợi. Audio mới được giữ thành take riêng.'})).toBeVisible();
const exported=async(page:Page)=>{await page.getByRole('button',{name:'Xuất audio'}).click();await expect(page.getByRole('heading',{level:1,name:/^Hàng đợi/})).toBeVisible();};
const generateAll=async(page:Page)=>{await page.getByRole('button',{name:'Tạo giọng tất cả'}).click();await queued(page);};
const scenarios:Record<string,(page:Page)=>Promise<void>>={
 'generate all, "Đọc từ tiếng Anh" off':generateAll,
 'generate all, "Đọc từ tiếng Anh" on':async page=>{await check(page,'Đọc từ tiếng Anh');await generateAll(page);},
 'export audio, plain':exported,
 'export audio, "Theo mốc phụ đề"':async page=>{await check(page,'Theo mốc phụ đề');await exported(page);},
 'export audio, "Theo mốc phụ đề" and "Giữ nhạc nền"':async page=>{
  await check(page,'Theo mốc phụ đề');
  const keep=page.getByRole('checkbox',{name:'Giữ nhạc nền'});await expect(page.locator('label',{has:keep})).toHaveAttribute('title',/nguồn có nhạc\.mp4/); // the source is loaded
  await keep.check();await expect.poll(()=>page.evaluate(()=>(window as any).__jobs.filter((j:any)=>j.kind==='separate').length)).toBe(1);
  await page.evaluate(()=>Object.assign((window as any).__jobs.find((j:any)=>j.kind==='separate'),{status:'succeeded',progress:1,result:{asset_id:'bg-stem',path:'C:\\assets\\bg-stem.flac'}}));
  await exported(page);
 },
 'export audio, "Mỗi chương một file"':async page=>{await check(page,'Mỗi chương một file');await exported(page);},
 'edit (a): take 2 chosen in the inspector, then export':async page=>{
  await page.getByRole('combobox',{name:'Take đang sử dụng'}).selectOption('t1b');await exported(page);
 },
 'edit (b): a row\'s voice and speed changed, then generate':async page=>{
  await page.getByRole('combobox',{name:'Giọng đoạn 3'}).selectOption('v-ref');await page.getByRole('combobox',{name:'Tốc độ đọc đoạn 3'}).selectOption('1.15');
  await page.locator('article.segment').nth(2).getByRole('button',{name:'Tạo take mới'}).click();await queued(page);
 },
 'edit (c): a project dictionary entry added, then generate all':async page=>{
  await page.getByRole('button',{name:'Từ điển phát âm'}).click();await page.getByRole('textbox',{name:'Từ gốc'}).fill('sách nói');await page.getByRole('textbox',{name:'Cách đọc'}).fill('sách đọc thành tiếng');
  await page.getByRole('button',{name:'Thêm cách đọc'}).click();await expect(page.getByText('sách nói → sách đọc thành tiếng')).toBeVisible();await generateAll(page);
 },
 'edit (d): a transcript end time edited, "Thành kịch bản", generate, then export by subtitle cues':async page=>{
  await go(page,'Chép lời');const end=page.getByRole('spinbutton',{name:'Đến (ms)'}).nth(2);await end.fill('8600');await end.press('Enter');
  await page.getByRole('button',{name:'Thành kịch bản'}).click();await expect(page.getByRole('textbox',{name:'Nội dung đoạn 10'})).toBeVisible();
  for(const i of [7,8,9]){const row=page.locator('article.segment').nth(i);await row.getByRole('button',{name:'Tạo giọng'}).click();await expect(row.getByRole('button',{name:'Tạo take mới'})).toBeVisible();}
  await check(page,'Theo mốc phụ đề');await exported(page);
 },
 'stt: model, language, diarization and a speaker range':async page=>{
  await go(page,'Chép lời');await page.getByRole('combobox',{name:'Model STT'}).selectOption('whisper-turbo');await page.getByRole('combobox',{name:'Ngôn ngữ STT'}).selectOption('auto');
  await check(page,'Phân biệt người nói');await page.getByRole('combobox',{name:'Số người nói'}).selectOption('3-4');
  await page.getByRole('button',{name:'Chọn tệp & chép lời'}).click();await expect(page.getByRole('status').filter({hasText:'Đã thêm 1 tệp vào hàng đợi chép lời.'})).toBeVisible();
 },
 'clone_preview of a picked voice sample':async page=>{
  await go(page,'Thư viện giọng');await page.getByRole('button',{name:'Chọn mẫu audio'}).click();await expect(page.getByRole('button',{name:'phỏng vấn.wav'})).toBeVisible();
  await page.getByRole('button',{name:'Nghe mẫu đã làm sạch'}).click();await expect(page.getByRole('button',{name:'Đang chờ hàng đợi…'})).toBeVisible();
 },
};

for(const name of new Set([...Object.keys(expected),...Object.keys(scenarios)]))test(name,async({page})=>{
 expect(scenarios[name],'a fixture entry that no scenario drives').toBeDefined();
 await open(page);await scenarios[name](page);
 const sent=canon(await page.evaluate(()=>(window as any).__sent));writeFileSync(test.info().outputPath('payloads.json'),sent);
 expect(expected[name],'a scenario without a fixture entry').toBeDefined();
 expect(sent).toBe(canon(expected[name]));
});
