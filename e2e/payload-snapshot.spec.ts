import {test,expect} from '@playwright/test';
import type {Page} from '@playwright/test';
import {readFileSync,writeFileSync} from 'node:fs';
// Locks every payload the UI hands the backend (every enqueue_job, clone_preview included, plus save_settings and save_voice) to
// e2e/fixtures/payloads-1.0.21.json. That file is owner-locked: a change to it can change spoken or rendered audio and needs owner
// listening. A UI change may rewrite the driver steps below, never the expected payloads. Each fixture entry is one test, and an entry no
// scenario drives fails, so a dropped or renamed scenario cannot pass silently. The payloads a run sent are written to its test output
// (payloads.json). A payload sent after a scenario's last UI signal is not recorded: each signal below comes after the last send today.
// Tauri is mocked like perf-budget.spec.ts, with the project in e2e/fixtures/payload-project.json; arguments are recorded as the backend
// gets them (JSON over IPC). A TTS job finishes at once and, like store.rs, adds a take that becomes the selected one when the segment has
// none; every other job stays queued until a test moves it on.
const data=JSON.parse(readFileSync('e2e/fixtures/payload-project.json','utf8'));
const expected:Record<string,unknown[]>=JSON.parse(readFileSync('e2e/fixtures/payloads-1.0.21.json','utf8'));
const version=JSON.parse(readFileSync('package.json','utf8')).version;
const mock=(d:any)=>{
 const w=window as any,ipc=(v:unknown)=>JSON.parse(JSON.stringify(v)),jobs:any[]=[];let project=d.project,settings=d.settings,voices=d.voices;w.isTauri=true;w.__sent=[];w.__jobs=jobs;
 const models=['vieneu-v3','whisper-small','whisper-turbo','diarization','htdemucs','separation-runtime'].map(id=>({id,name:id,engine:'x',kind:id==='separation-runtime'?'runtime':'model',installed:true,revision:'r',license:'',description:''}));
 w.__TAURI_INTERNALS__={convertFileSrc:(p:string)=>p,transformCallback:()=>1,unregisterCallback:()=>{},metadata:{currentWindow:{label:'main'},currentWebview:{label:'main',windowLabel:'main'}},
  invoke:async(cmd:string,args:any)=>{if(['enqueue_job','save_settings','save_voice'].includes(cmd))w.__sent.push({cmd,args:ipc(args)});switch(cmd){
   case 'list_projects':return [{id:project.id,name:project.name,updated_at:project.updated_at,revision:project.revision}];case 'load_project':return ipc(project);
   case 'save_project':project={...ipc(args.project),revision:args.project.revision+1};return ipc(project);
   case 'list_voices':return ipc(voices);case 'save_voice':voices=[...voices,ipc(args.voice)];return ipc(args.voice);
   case 'get_settings':return ipc(settings);case 'save_settings':settings=ipc(args.settings);return ipc(settings);
   case 'list_models':return ipc(models);case 'list_jobs':return ipc([...jobs].reverse());
   case 'runtime_status':return {python_ready:true,ffmpeg_ready:true,worker_ready:true,native_worker_ready:true,python_path:null,ffmpeg_path:null,native_worker_path:null,fallback_count:0,message:''};
   case 'get_asset':return ipc(d.source);
   case 'plugin:dialog|open':return 'C:\\media\\phỏng vấn.wav';
   case 'import_asset':return {id:'a-picked',path:args.path,name:'phỏng vấn.wav',duration_ms:60000,sample_rate:16000};
   case 'enqueue_job':{const a=ipc(args),job:any={id:'j'+(jobs.length+1),kind:a.kind,project_id:a.projectId,payload:a.payload,status:'queued',progress:0,error:null,result:null,created_at:new Date(Date.now()+jobs.length).toISOString(),updated_at:new Date().toISOString()};
    const s=a.kind==='tts'&&project.segments.find((x:any)=>x.id===a.payload.segment_id);
    if(s){const n=s.takes.length,take={id:`take-${s.id}-${n}`,asset_id:`asset-${s.id}-${n}`,path:`C:\\takes\\${s.id}-${n}.wav`,duration_ms:2000,sample_rate:48000,created_at:'2026-11-21T00:00:00Z'};
     project={...project,segments:project.segments.map((x:any)=>x===s?{...x,takes:[...x.takes,take],selected_take_id:x.selected_take_id??take.id}:x)};Object.assign(job,{status:'succeeded',progress:1,result:{asset_id:take.asset_id,take_id:take.id}});}
    jobs.push(job);return ipc(job);}
   case 'plugin:dialog|save':return 'C:/x/ban-xuat.wav';default:return null;}}};
};
const sorted=(v:any):any=>Array.isArray(v)?v.map(sorted):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sorted(v[k])])):v;
// Canonical text: keys sorted; a random id (the chapter `batch`, the id of a segment or voice the app makes) named by its first appearance,
// so which payloads share one stays locked; the app version as a placeholder, so a release bump is not a payload change.
const canon=(sent:any[])=>{const ids=new Map<string,string>();
 return JSON.stringify(sorted(sent.map(s=>s.args.kind==='clone_preview'&&s.args.payload.version===version?{...s,args:{...s.args,payload:{...s.args.payload,version:'<version>'}}}:s)),null,1)
  .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,m=>{if(!ids.has(m))ids.set(m,`<uuid ${ids.size+1}>`);return ids.get(m)!;});};
const open=async(page:Page,patch:object={})=>{
 await page.addInitScript(mock,{...data,project:{...data.project,...patch}});await page.goto('/');await page.getByRole('button',{name:'Dự án',exact:true}).click();await page.getByRole('button',{name:'Mở dự án',exact:true}).click();
 await expect(page.getByRole('textbox',{name:'Nội dung đoạn 7'})).toBeVisible();
};
const go=(page:Page,label:string)=>page.getByRole('navigation',{name:'Điều hướng chính'}).getByRole('button',{name:label,exact:true}).click();
const check=(page:Page,label:string)=>page.getByRole('checkbox',{name:label}).check();
const row=(page:Page,n:number)=>page.locator('article.segment').nth(n-1);
const pick=async(page:Page,n:number)=>{await row(page,n).locator('.segment-index').click();await expect(row(page,n)).toHaveClass(/selected/);};
// A number field takes its value on Enter.
const type=async(page:Page,label:string,value:string)=>{const f=page.getByRole('spinbutton',{name:label,exact:true});await f.fill(value);await f.press('Enter');};
// What each action shows once it has sent everything it sends.
const queued=(page:Page)=>expect(page.getByRole('status').filter({hasText:'Đã thêm vào hàng đợi. Audio mới được giữ thành take riêng.'})).toBeVisible();
const exported=async(page:Page,chapters=false)=>{await page.getByRole('button',{name:'Xuất audio'}).click();
 // The export stays on the page: one render is in the mock's job list (its send is recorded first), or the chapters' notice has come after the last send.
 if(chapters)await expect(page.getByRole('status').filter({hasText:/^Đã thêm \d+ chương vào hàng đợi xuất\.$/})).toBeVisible();
 else await expect.poll(()=>page.evaluate(()=>(window as any).__jobs.filter((j:any)=>j.kind==='render').length)).toBe(1);};
const generateAll=async(page:Page)=>{await page.getByRole('button',{name:'Tạo giọng tất cả'}).click();await queued(page);};
const addEntry=async(page:Page,scope:string,key:string,value:string)=>{const d=page.locator(scope);await d.getByRole('textbox',{name:'Từ gốc'}).fill(key);await d.getByRole('textbox',{name:'Cách đọc'}).fill(value);
 await d.getByRole('button',{name:'Thêm cách đọc'}).click();await expect(d.getByText(`${key} → ${value}`)).toBeVisible();};
const transcribe=async(page:Page)=>{await page.getByRole('button',{name:'Chọn tệp & chép lời'}).click();await expect(page.getByRole('status').filter({hasText:'Đã thêm 1 tệp vào hàng đợi chép lời.'})).toBeVisible();};
const NO_SOURCE='"Giữ nhạc nền" in a project without a source: the picked file is separated';
const scenarios:Record<string,(page:Page)=>Promise<void>>={
 'generate all, "Đọc từ tiếng Anh" off':generateAll,
 'generate all, "Đọc từ tiếng Anh" on':async page=>{await check(page,'Đọc từ tiếng Anh');await generateAll(page);},
 'generate the selected segment from the command palette':async page=>{
  await pick(page,5);await page.keyboard.press('Control+k');await page.getByRole('dialog',{name:'Bảng lệnh'}).getByRole('option',{name:'Tạo giọng đoạn đang chọn'}).click();await queued(page);
 },
 'export audio, plain':exported,
 'export audio, "Theo mốc phụ đề"':async page=>{await check(page,'Theo mốc phụ đề');await exported(page);},
 'export audio, "Theo mốc phụ đề" and "Giữ nhạc nền"':async page=>{
  await check(page,'Theo mốc phụ đề');
  const keep=page.getByRole('checkbox',{name:'Giữ nhạc nền'});await expect(page.locator('label',{has:keep})).toHaveAttribute('title',/nguồn có nhạc\.mp4/); // the source is loaded
  await keep.click();await expect(keep).toBeChecked();await expect.poll(()=>page.evaluate(()=>(window as any).__jobs.filter((j:any)=>j.kind==='separate').length)).toBe(1);
  await page.evaluate(()=>Object.assign((window as any).__jobs.find((j:any)=>j.kind==='separate'),{status:'succeeded',progress:1,result:{asset_id:'bg-stem',path:'C:\\assets\\bg-stem.flac'}}));
  await exported(page);
 },
 [NO_SOURCE]:async page=>{
  await check(page,'Theo mốc phụ đề');const keep=page.getByRole('checkbox',{name:'Giữ nhạc nền'});await keep.click();await expect(keep).toBeChecked();
  await expect(page.getByRole('status').filter({hasText:'Đang tách nhạc nền từ phỏng vấn.wav'})).toBeVisible();
 },
 'export audio, "Mỗi chương một file"':async page=>{await check(page,'Mỗi chương một file');await exported(page,true);},
 'edit (a): take 2 chosen in the inspector, then export':async page=>{
  await page.getByRole('combobox',{name:'Take đang sử dụng'}).selectOption('t1b');await exported(page);
 },
 'edit (b): a row\'s voice and speed changed, then generate with "Tự kiểm bằng Whisper" on':async page=>{
  await pick(page,3); // the voice and speed selects are in the inspector, which shows the selected segment
  await page.getByRole('combobox',{name:'Giọng đoạn 3'}).selectOption('v-ref');await page.getByRole('combobox',{name:'Tốc độ đọc đoạn 3'}).selectOption('1.15');await check(page,'Tự kiểm bằng Whisper');
  await row(page,3).getByRole('button',{name:'Tạo take mới'}).click();await queued(page);
 },
 'edit (c): a project dictionary entry added, then generate all':async page=>{
  await page.getByRole('button',{name:'Từ điển phát âm'}).click();await addEntry(page,'.inspector','sách nói','sách đọc thành tiếng');await generateAll(page);
 },
 'edit (d): a transcript end time edited, "Thành kịch bản", generate, then export by subtitle cues':async page=>{
  // Rows 1 and 2 share a speaker, so they become one line whose cue ends where row 2 now ends.
  await go(page,'Chép lời');await page.locator('.tr-time').nth(1).click();const end=page.getByRole('textbox',{name:'Kết thúc'});await end.fill('0:05,000');await end.press('Enter');await expect(page.locator('.tr-time').nth(1)).toContainText('– 0:05,000');
  await page.getByRole('button',{name:'Thành kịch bản'}).click();await expect(page.getByRole('textbox',{name:'Nội dung đoạn 9'})).toBeVisible();
  for(const n of [8,9]){await row(page,n).getByRole('button',{name:'Tạo giọng'}).click();await expect(row(page,n).getByRole('button',{name:'Tạo take mới'})).toBeVisible();}
  await check(page,'Theo mốc phụ đề');await exported(page);
 },
 'edit (e): every inspector field of a segment, then export as MP3 without "Chuẩn hóa"':async page=>{
  await pick(page,2); // its trim end is unset
  await page.getByText('Chỉnh âm',{exact:true}).click();
  await page.getByRole('textbox',{name:'Chương',exact:true}).fill('Chương 1b');
  for(const [label,value] of [['Nghỉ sau (ms)','750'],['Âm lượng (dB)','-4.5'],['Cắt đầu (ms)','120'],['Cắt cuối (ms)','0'],['To dần (ms)','35'],['Nhỏ dần (ms)','90']])await type(page,label,value);
  await pick(page,4);await page.getByRole('textbox',{name:'Chương',exact:true}).fill(''); // a cleared chapter is null, not ''
  await pick(page,6);await type(page,'Cắt cuối (ms)','1600');
  await page.getByRole('combobox',{name:'Định dạng audio'}).selectOption({label:'MP3'});await page.getByRole('checkbox',{name:'Chuẩn hóa'}).uncheck();await exported(page);
 },
 // The caret is not where a split without one would cut (the sentence end nearest the middle, after TP.HCM.).
 'edit (f): split at the caret, merge with the next segment, move down, then generate all and export by subtitle cues':async page=>{
  const text=page.getByRole('textbox',{name:'Nội dung đoạn 1'});await text.click();await text.press('Control+Home');for(let i=0;i<'Chào mừng đến TP.HCM. [nghỉ 0.5s]'.length;i++)await text.press('ArrowRight');
  await row(page,1).getByRole('button',{name:'Chia đoạn tại con trỏ'}).click();await expect(text).toHaveValue('Chào mừng đến TP.HCM. [nghỉ 0.5s]');
  await row(page,4).getByRole('button',{name:'Gộp với đoạn sau'}).click();await expect(page.getByRole('textbox',{name:'Nội dung đoạn 4'})).toHaveValue('Trí tuệ AI giúp làm sách nói. Tôi đã đọc 3 chương.');
  await row(page,6).getByRole('button',{name:'Đưa đoạn xuống'}).click();await expect(page.getByRole('textbox',{name:'Nội dung đoạn 6'})).toHaveValue('Hết.');
  await generateAll(page);await check(page,'Theo mốc phụ đề');await exported(page);
 },
 'stt: model, language, diarization and a speaker range':async page=>{
  await go(page,'Chép lời');await page.getByRole('combobox',{name:'Model STT'}).selectOption('whisper-turbo');await page.getByRole('combobox',{name:'Ngôn ngữ STT'}).selectOption('auto');
  await check(page,'Phân biệt người nói');await page.getByRole('combobox',{name:'Số người nói'}).selectOption('3-4');await transcribe(page);
 },
 'stt: the defaults, without diarization':async page=>{await go(page,'Chép lời');await transcribe(page);},
 'voice library: clone_preview of a picked sample, then save it as a voice':async page=>{
  await go(page,'Thư viện giọng');await page.getByRole('button',{name:'Chọn mẫu audio'}).click();await expect(page.getByRole('button',{name:'phỏng vấn.wav'})).toBeVisible();
  await page.getByRole('button',{name:'Nghe mẫu đã làm sạch'}).click();await expect(page.getByRole('button',{name:'Đang chờ hàng đợi…'})).toBeVisible();
  await page.getByRole('textbox',{name:'Tên hiển thị'}).fill('Giọng phỏng vấn');await check(page,'Tôi có quyền sử dụng và tạo giọng từ mẫu audio này.');
  await page.getByRole('button',{name:'Lưu mẫu giọng'}).click();await expect(page.getByRole('status').filter({hasText:'Đã lưu mẫu giọng.'})).toBeVisible();
 },
 'models: the app dictionary gets two entries, then generate all':async page=>{
  // TP.HCM is in the project dictionary too, which wins.
  await go(page,'Model & cài đặt');await addEntry(page,'.app-dictionary','TP.HCM','tê pê hát xê em');await addEntry(page,'.app-dictionary','weekend','cuối tuần');
  await go(page,'Tạo giọng đọc');await generateAll(page);
 },
 'models: "Bộ xử lý" set to Python for TTS, STT, export and the cloned-voice preview':async page=>{
  await go(page,'Model & cài đặt');await page.getByText('Nâng cao: bộ xử lý').click(); // the processor panel is folded away
  for(const label of ['Đọc văn bản','Chép lời','Xuất âm thanh','Nghe thử giọng nhân bản']){const s=page.locator('.engine-rows label').filter({hasText:label}).locator('select');await s.selectOption('python');await expect(s).toHaveValue('python');}
 },
};

for(const name of new Set([...Object.keys(expected),...Object.keys(scenarios)]))test(name,async({page})=>{
 expect(scenarios[name],'a fixture entry that no scenario drives').toBeDefined();
 await open(page,name===NO_SOURCE?{source_asset_id:null}:{});await scenarios[name](page);
 const sent=canon(await page.evaluate(()=>(window as any).__sent)),file=test.info().outputPath('payloads.json');writeFileSync(file,sent);await test.info().attach('payloads',{path:file});
 expect(expected[name],'a scenario without a fixture entry').toBeDefined();
 expect(sent).toBe(canon(expected[name]));
});
