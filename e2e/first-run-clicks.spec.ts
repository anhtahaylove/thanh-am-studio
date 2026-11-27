import {test,expect} from '@playwright/test';
import type {Page} from '@playwright/test';
// Round 1.0.26 criteria 1-3 (PLAN §2, §6 S1): on a fresh profile, text to a saved audio file takes at most 4 in-app clicks and an audio file to its transcript at most 3;
// typing and the native file dialogs do not count. The only page change is the one the job pick asks for. The start panel stands where the checklist does, every step has
// "Để sau" ("Later" in the test names), each step heading takes the focus, and `thanh-am-start` is written only when step 3 is reached.
// A click is a trusted mouse click inside the page (detail > 0); a MutationObserver on `main h1` logs each page change and whether a trusted input came just before it.
// Tauri is mocked: `__finish(kind)` ends every unfinished job of that kind (a download installs its model, a TTS job adds a take, an STT job brings one transcript row).
type Setup={download?:string;project?:boolean;stored?:string};
const mock=(d:Setup)=>{
 const w=window as any,now='2026-11-27T00:00:00Z',ipc=(v:unknown)=>JSON.parse(JSON.stringify(v));w.isTauri=true;w.__calls=[];w.__clicks=0;w.__log=[];w.__polls=0;
 if(d.stored)localStorage.setItem('thanh-am-start',d.stored);
 let input:string|null=null,at=0,last='';
 for(const type of ['click','keydown'])addEventListener(type,e=>{if(!e.isTrusted)return;if(type==='click'&&(e as MouseEvent).detail>0)w.__clicks++;input=type;at=performance.now();},true);
 new MutationObserver(()=>{const t=document.querySelector('main h1')?.firstChild?.textContent??'';if(t&&t!==last){w.__log.push({from:last,to:t,input:input&&performance.now()-at<3000?input:null});last=t;input=null;}}).observe(document,{childList:true,subtree:true,characterData:true});
 const installed=new Set<string>(),jobs:any[]=[],store:any[]=[];
 const seg=(id:string,text:string)=>({id,text,normalized_text:text,voice_id:null,speaker:'Người dẫn',gap_ms:300,takes:[],selected_take_id:null,trim_start_ms:0,trim_end_ms:null,fade_in_ms:0,fade_out_ms:0,gain_db:0});
 const mk=(id:string,name:string,segments:any[]=[])=>({id,name,updated_at:now,revision:1,segments,transcript:[],dictionary:{},source_asset_id:null});
 const job=(kind:string,status:string,payload:object,project_id:string|null=null)=>({id:'j'+jobs.length,kind,project_id,payload,status,progress:status==='succeeded'?1:0.4,error:null,result:null,created_at:now,updated_at:now});
 if(d.download)jobs.push(job('model_download','running',{model_id:d.download}));
 if(d.project)store.push(mk('p0','Dự án đầu tiên',[seg('s0','Xin chào.')]));
 w.__finish=(kind:string)=>{for(const j of jobs){if(j.kind!==kind||j.status==='succeeded')continue;j.status='succeeded';j.progress=1;
  if(kind==='model_download')installed.add(j.payload.model_id);
  if(kind==='tts'){const p=store.find(x=>x.id===j.project_id),s=p.segments.find((x:any)=>x.id===j.payload.segment_id);s.takes.push({id:'t1',asset_id:'at1',path:'/t1.wav',duration_ms:2000,sample_rate:24000,created_at:now});s.selected_take_id='t1';p.revision++;j.result={asset_id:'at1'};}
  if(kind==='render')j.result={asset_id:'ar1'};
  if(kind==='stt')j.result={segments:[{start_ms:0,end_ms:2000,text:'Xin chào làng chài.'}]};}};
 const MODELS=[['vieneu-v3','VieNeu v3 Turbo','tts'],['whisper-small','Whisper Small','stt'],['whisper-turbo','Whisper Large v3 Turbo','stt'],['diarization','Phân biệt người nói','stt']];
 w.__TAURI_INTERNALS__={convertFileSrc:(p:string)=>p,transformCallback:()=>1,unregisterCallback:()=>{},metadata:{currentWindow:{label:'main'},currentWebview:{label:'main',windowLabel:'main'}},
  invoke:async(cmd:string,args:any)=>{w.__calls.push({cmd,args:ipc(args??{})});switch(cmd){
   case 'list_projects':return store.map(p=>({id:p.id,name:p.name,updated_at:p.updated_at,revision:p.revision}));
   case 'load_project':return ipc(store.find(p=>p.id===args.id));
   case 'create_project':{const p=mk('n'+store.length,args.name);store.unshift(p);return ipc(p);}
   case 'save_project':{const old=store.find(p=>p.id===args.project.id),next={...ipc(args.project),revision:args.project.revision+1};next.segments=next.segments.map((s:any)=>{const o=old?.segments.find((x:any)=>x.id===s.id);return o?.takes.length&&!s.takes.length?{...s,takes:o.takes,selected_take_id:o.selected_take_id}:s;});if(old)store[store.indexOf(old)]=next;else store.unshift(next);return ipc(next);}
   case 'list_jobs':w.__polls++;return ipc(jobs);case 'list_voices':return [];case 'get_settings':return {dictionary:{}};
   case 'list_models':return MODELS.map(([id,name,engine])=>({id,name,engine,kind:'model',installed:installed.has(id),revision:'r1abcdef0123456',license:'Apache-2.0',description:''}));
   case 'runtime_status':return {python_ready:true,ffmpeg_ready:true,worker_ready:true,native_worker_ready:true,python_path:null,ffmpeg_path:null,native_worker_path:null,fallback_count:0,total_memory_mb:null,message:''};
   case 'download_model':{const j=job('model_download','running',{model_id:args.id});jobs.push(j);return ipc(j);}
   case 'enqueue_job':{const j=job(args.kind,'running',args.payload,args.projectId);jobs.push(j);return ipc(j);}
   case 'plugin:dialog|open':return ['C:/x/phong-van.wav'];case 'plugin:dialog|save':return 'C:/x/ban.wav';
   case 'import_asset':return {id:'src1',path:args.path,name:'phong-van.wav',duration_ms:5000,sample_rate:16000};
   case 'get_asset':return {id:args.id,path:'/src.wav',name:'phong-van.wav',duration_ms:5000,sample_rate:16000};
   default:return null;}}};
};
const open=async(page:Page,d:Setup={},width=1440)=>{await page.setViewportSize({width,height:1000});await page.addInitScript(mock,d);await page.goto('/');};
const panel=(page:Page)=>page.locator('.start-panel');
const checklist=(page:Page)=>page.locator('.first-run');
const heading=(page:Page,n:number)=>panel(page).getByRole('heading',{name:new RegExp(`^Bước ${n}/3`)});
const stored=(page:Page)=>page.evaluate(()=>localStorage.getItem('thanh-am-start'));
const calls=(page:Page,cmd:string)=>page.evaluate(c=>(window as any).__calls.filter((x:any)=>x.cmd===c).map((x:any)=>x.args),cmd);
const kinds=async(page:Page)=>(await calls(page,'enqueue_job')).map((a:any)=>a.kind);
const clicks=(page:Page)=>page.evaluate(()=>(window as any).__clicks as number);
const pageLog=(page:Page)=>page.evaluate(()=>((window as any).__log as {from:string;to:string;input:string|null}[]).filter(e=>e.from));
const finish=(page:Page,kind:string)=>page.evaluate(k=>(window as any).__finish(k),kind);
// One more poll after the action, so the app has seen its job running before the test ends it (a job finished at the first sight is only a baseline).
const nextPoll=async(page:Page)=>{const n=await page.evaluate(()=>(window as any).__polls);await page.waitForFunction(k=>(window as any).__polls>k,n);};
const ttsCard=(page:Page)=>panel(page).getByRole('button',{name:'Đọc văn bản thành giọng nói',exact:true});
const sttCard=(page:Page)=>panel(page).getByRole('button',{name:'Chép lời từ file âm thanh',exact:true});

test('text to a saved audio file takes 4 clicks from a fresh start, with no page change',async({page})=>{
 await open(page);
 await expect(heading(page,1)).toHaveAccessibleName('Bước 1/3 Bạn muốn làm gì trước?');
 await expect(checklist(page)).toHaveCount(0); // the panel stands where the checklist would
 await expect(ttsCard(page)).toHaveAccessibleDescription('Gõ hoặc dán chữ, nghe và lưu thành file audio.');
 await ttsCard(page).click(); // 1
 await expect(heading(page,2)).toHaveAccessibleName('Bước 2/3 Chọn model');await expect(heading(page,2)).toBeFocused();
 await expect(panel(page)).toContainText('Model tải trong lúc bạn tiếp tục.');
 await expect(panel(page).locator('.model-card')).toHaveCount(1);await expect(panel(page).locator('.model-card h3')).toHaveText('VieNeu v3 Turbo');
 await panel(page).getByRole('button',{name:'Tải model',exact:true}).click(); // 2
 await expect.poll(()=>calls(page,'download_model')).toEqual([{id:'vieneu-v3'}]);
 // The strip shows the download while the page is already usable: the first segment is there and its text box has the focus.
 const text=page.getByRole('textbox',{name:'Nội dung đoạn 1'});await expect(text).toBeFocused();
 await expect(heading(page,2)).toHaveAccessibleName('Bước 2/3 Đang tải VieNeu v3 Turbo…');await expect(panel(page).locator('progress')).toHaveJSProperty('value',0.4);
 await expect(panel(page).getByRole('button',{name:'Để sau',exact:true})).toBeVisible();
 await page.keyboard.type('Xin chào làng chài.');await expect(text).toHaveValue('Xin chào làng chài.'); // typing is no click
 expect(await stored(page),'the pick at step 2 writes nothing').toBeNull();
 await finish(page,'model_download');
 await expect(heading(page,3)).toHaveAccessibleName('Bước 3/3 Đã tải xong VieNeu v3 Turbo.',{timeout:10000});
 await expect.poll(()=>stored(page)).toBe('done');
 await expect(text,'step 3 does not take the focus from the text being typed').toBeFocused();
 await expect(checklist(page)).toBeVisible(); // the checklist takes over
 await checklist(page).getByRole('button',{name:'Tạo giọng ngay',exact:true}).click(); // 3
 await expect.poll(()=>kinds(page)).toEqual(['tts']);
 await nextPoll(page);await finish(page,'tts');
 await expect(page.locator('#audio-dock')).toContainText('Take 1',{timeout:10000});
 await expect(heading(page,3),'the first segment made a project, and the panel stays for the session').toBeVisible();
 await page.locator('#audio-dock').getByRole('button',{name:'Xuất audio',exact:true}).click(); // 4, then the native save dialog
 await expect.poll(()=>kinds(page)).toEqual(['tts','render']);
 await nextPoll(page);await finish(page,'render');
 await expect.poll(()=>calls(page,'export_asset'),{timeout:10000}).toEqual([{assetId:'ar1',path:'C:/x/ban.wav'}]);
 expect(await clicks(page),'in-app clicks from launch to the saved file').toBe(4);
 expect(await pageLog(page),'no page change').toEqual([]);
});

test('an audio file to its transcript takes 3 clicks from a fresh start, and only the job pick changes the page',async({page})=>{
 await open(page);
 await expect(sttCard(page)).toHaveAccessibleDescription('Chọn file ghi âm hoặc video, nhận bản chép lời.');
 await sttCard(page).click(); // 1
 await expect(page.locator('main h1')).toContainText('Chép lời');
 await expect(heading(page,2)).toHaveAccessibleName('Bước 2/3 Chọn model');await expect(heading(page,2)).toBeFocused();
 await expect(panel(page).locator('.model-card h3')).toHaveText(['Whisper Small']);
 await panel(page).getByRole('button',{name:'Tải model',exact:true}).click(); // 2
 await expect.poll(()=>calls(page,'download_model')).toEqual([{id:'whisper-small'}]);
 const pick=page.locator('.stt-import').getByRole('button',{name:'Chọn tệp & chép lời',exact:true});
 await expect(pick).toBeFocused();await expect(pick).toHaveAttribute('aria-disabled','true');await expect(pick).toHaveAccessibleDescription('Đang tải Whisper Small…');
 await expect(panel(page).locator('progress')).toHaveJSProperty('value',0.4);
 expect(await stored(page)).toBeNull();
 await finish(page,'model_download');
 await expect(heading(page,3)).toHaveAccessibleName('Bước 3/3 Đã tải xong Whisper Small.',{timeout:10000});
 await expect(pick).not.toHaveAttribute('aria-disabled','true');await expect(pick).toBeFocused();
 await expect.poll(()=>stored(page)).toBe('done');
 await pick.click(); // 3, then the native open dialog
 await expect.poll(()=>kinds(page)).toEqual(['stt']);
 await nextPoll(page);await finish(page,'stt');
 await expect(page.locator('.transcript-row'),'the finished transcription fills the empty transcript with no click').toHaveCount(1,{timeout:10000});
 expect(await clicks(page),'in-app clicks from launch to the transcript').toBe(3);
 expect(await pageLog(page),'one page change, asked for by the job pick').toEqual([{from:'Tạo giọng đọc',to:'Chép lời',input:'click'}]);
});

test('each step heading takes the focus: after the pick, Back, the palette, and at step 3 when the focus was in the panel',async({page})=>{
 await open(page);
 await ttsCard(page).click();await expect(heading(page,2)).toBeFocused();
 await panel(page).getByRole('button',{name:'Quay lại',exact:true}).click();
 await expect(heading(page,1)).toHaveAccessibleName('Bước 1/3 Bạn muốn làm gì trước?');await expect(heading(page,1)).toBeFocused();
 await page.keyboard.press('Control+k');await page.getByRole('dialog',{name:'Bảng lệnh'}).getByRole('option',{name:'Hiện hướng dẫn bắt đầu'}).click();
 await expect(heading(page,1)).toBeFocused();
 await sttCard(page).click();await panel(page).getByRole('button',{name:'Tải model',exact:true}).click();
 const later=panel(page).getByRole('button',{name:'Để sau',exact:true});await expect(heading(page,2)).toContainText('Đang tải');await later.focus();
 await finish(page,'model_download');
 await expect(heading(page,3)).toBeFocused({timeout:10000});
});

for(const at of ['1','2','2 strip','3'] as const)test(`"Later" at step ${at} hides only the start panel, and the panel stays away after a reload`,async({page})=>{
 await open(page);
 if(at!=='1')await ttsCard(page).click();
 if(at==='2 strip'||at==='3'){await panel(page).getByRole('button',{name:'Tải model',exact:true}).click();await expect(panel(page).locator('progress')).toHaveCount(1);}
 if(at==='3'){await finish(page,'model_download');await expect(heading(page,3)).toBeVisible({timeout:10000});}
 await panel(page).getByRole('button',{name:'Để sau',exact:true}).click();
 await expect(panel(page)).toHaveCount(0);
 await expect(checklist(page),'"Để sau" leaves the checklist').toBeVisible();
 await expect(checklist(page).getByRole('heading',{name:'Bắt đầu với Thanh Âm'})).toBeFocused();
 expect(await stored(page)).toBe(at==='3'?'done':'hidden');
 await page.reload();await nextPoll(page);await page.waitForTimeout(300);
 await expect(panel(page)).toHaveCount(0);await expect(checklist(page)).toBeVisible();
});

test('a relaunch while the picked starter model downloads resumes the strip at step 2, even when its first segment made a project',async({page})=>{
 await open(page,{download:'vieneu-v3',project:true});
 await expect(heading(page,2)).toHaveAccessibleName('Bước 2/3 Đang tải VieNeu v3 Turbo…');
 await expect(panel(page).locator('progress')).toHaveJSProperty('value',0.4);
 await expect(checklist(page)).toHaveCount(0);expect(await stored(page)).toBeNull();
 await finish(page,'model_download');
 await expect(heading(page,3)).toBeVisible({timeout:10000});await expect.poll(()=>stored(page)).toBe('done');await expect(checklist(page)).toBeVisible();
});

for(const d of [{stored:'hidden'},{stored:'done'},{project:true}] as Setup[])test(`no start panel at launch with ${JSON.stringify(d)}`,async({page})=>{
 await open(page,d);await nextPoll(page);await page.waitForTimeout(300);
 await expect(panel(page)).toHaveCount(0);await expect(checklist(page)).toBeVisible();
});

for(const width of [800,640])test(`the start panel does not scroll sideways at ${width} px`,async({page})=>{
 await open(page,{},width);await expect(heading(page,1)).toBeVisible();
 const over=()=>page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth+[...document.querySelectorAll('.start-panel, .start-panel *')].filter(e=>e.getBoundingClientRect().right>innerWidth+1).length);
 expect(await over()).toBeLessThanOrEqual(0);
 await ttsCard(page).click();await expect(heading(page,2)).toBeVisible();expect(await over()).toBeLessThanOrEqual(0);
});
