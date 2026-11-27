import {test,expect} from '@playwright/test';
import type {Page} from '@playwright/test';
// The first-run checklists, one per job: three steps on the TTS page and three on the STT page, a load gate so a set-up user never sees them, a "Đã xong bước"
// notice only for steps finished after the first poll, and a stored "hidden" or "done" per page. Tauri is mocked; `__flip()` installs the voice model,
// `__flipWhisper()` the Whisper one, `__finishDownload(id)` ends a download the page started, `__finishJob(kind)` finishes a job of that kind.
type Setup={installed:boolean;projects:boolean;ttsDone:boolean;text?:string;renderDone?:boolean;whisper?:boolean;sttDone?:boolean;rows?:boolean;takes?:boolean};
const mock=(d:Setup)=>{
 const w=window as any,now='2026-11-22T00:00:00Z';let installed=d.installed,whisper=!!d.whisper;w.isTauri=true;w.__polls=0;w.__sent=[];w.__downloads=[];w.__exports=[];w.__flip=()=>{installed=true;};w.__flipWhisper=()=>{whisper=true;};
 const rows=d.rows?[{id:'r1',start_ms:0,end_ms:2000,text:'Xin chào.',speaker:0}]:[];
 const project={id:'p1',name:'Làng chài',updated_at:now,revision:1,segments:[{id:'s1',text:d.text??'',normalized_text:'',voice_id:null,speaker:'',gap_ms:300,takes:d.takes?[{id:'t1',asset_id:'a1',path:'/t1.wav',duration_ms:2000,sample_rate:24000,created_at:now}]:[],selected_take_id:d.takes?'t1':null,trim_start_ms:0,trim_end_ms:null,fade_in_ms:0,fade_out_ms:0,gain_db:0}],transcript:rows,dictionary:{},source_asset_id:null};
 const mk=(id:string,kind:string,status:string,payload:object={})=>({id,kind,project_id:'p1',payload,status,progress:status==='succeeded'?1:0.4,error:null,result:null,created_at:now,updated_at:now});
 const jobs:any[]=[...d.ttsDone?[mk('j1','tts','succeeded')]:[],...(d.renderDone??d.ttsDone)?[mk('j2','render','succeeded')]:[],...d.sttDone?[mk('j3','stt','succeeded')]:[]];
 w.__finishJob=(kind:string)=>{const j=jobs.find(x=>x.kind===kind&&x.status!=='succeeded')??(jobs.push(mk('n'+jobs.length,kind,'succeeded')),null);if(j){j.status='succeeded';j.progress=1;}};
 w.__finishDownload=(id:string)=>{const j=jobs.find(x=>x.kind==='model_download'&&x.payload.model_id===id);j.status='succeeded';j.progress=1;if(id==='vieneu-v3')installed=true;else whisper=true;};
 w.__TAURI_INTERNALS__={convertFileSrc:(p:string)=>p,transformCallback:()=>1,unregisterCallback:()=>{},metadata:{currentWindow:{label:'main'},currentWebview:{label:'main',windowLabel:'main'}},
  invoke:async(cmd:string,args:any)=>{switch(cmd){
   case 'list_projects':return d.projects?[{id:project.id,name:project.name,updated_at:now,revision:1}]:[];case 'load_project':return project;case 'save_project':return {...args.project,revision:args.project.revision+1};
   case 'list_jobs':return JSON.parse(JSON.stringify(jobs));case 'list_voices':return [];case 'get_settings':return {dictionary:{}};
   case 'list_models':w.__polls++;return [{id:'vieneu-v3',name:'VieNeu v3 Turbo',engine:'tts',kind:'model',installed,revision:'r',license:'',description:''},{id:'whisper-small',name:'Whisper Small',engine:'stt',kind:'model',installed:whisper,revision:'r',license:'',description:''},{id:'whisper-turbo',name:'Whisper Large v3 Turbo',engine:'stt',kind:'model',installed:false,revision:'r',license:'',description:''}];
   case 'runtime_status':return {python_ready:true,ffmpeg_ready:true,worker_ready:true,native_worker_ready:true,python_path:null,ffmpeg_path:null,native_worker_path:null,fallback_count:0,total_memory_mb:null,message:''};
   case 'download_model':{w.__downloads.push(args.id);const j=mk('dl-'+args.id,'model_download','running',{model_id:args.id});jobs.push(j);return j;}
   case 'plugin:dialog|open':if(w.__hold){await new Promise(r=>{w.__release=r;});return null;}return ['C:/x/phong-van.wav'];case 'import_asset':return {id:'a1',path:args.path,name:'phong-van.wav',duration_ms:5000,sample_rate:16000};
   case 'plugin:dialog|save':return w.__cancelSave?null:'C:/x/ban.txt';case 'export_text':w.__exports.push(args.path);return null;
   case 'enqueue_job':{w.__sent.push(args.kind);const j=mk('q'+jobs.length,args.kind,'running',args.payload);jobs.push(j);return j;}
   default:return null;}}};
};
// Records every node the app adds that is the checklist or says a step is done, and every text changed into one, from the first paint on.
const watch=()=>{
 const w=window as any;w.__seen=[];w.__said=[]; // __said: every text the live regions (the polite line and the role=status banner) ever showed, even one that clears itself later
 new MutationObserver(()=>{document.querySelectorAll('[aria-live="polite"],[role="status"]').forEach(e=>{const t=(e.textContent??'').trim();if(t&&!w.__said.includes(t))w.__said.push(t);});}).observe(document,{subtree:true,childList:true,characterData:true});
 const say=(t:string|null)=>(t??'').includes('Đã xong bước');
 new MutationObserver(ms=>{for(const m of ms){
  if(m.type==='characterData'){if(say(m.target.textContent))w.__seen.push(m.target.textContent);continue;} // text swapped into a node that was already there
  for(const n of m.addedNodes){const e=n as Element;if(n.nodeType===3?say(n.textContent):e.nodeType===1&&(e.matches('.first-run')||e.querySelector('.first-run')||say(e.textContent)))w.__seen.push(n.textContent);}
 }}).observe(document,{childList:true,subtree:true,characterData:true});
};
const NONE:Setup={installed:false,projects:false,ttsDone:false};
const open=async(page:Page,d:Setup,width=1440,height=1000)=>{await page.setViewportSize({width,height});await page.addInitScript(watch);await page.addInitScript(mock,d);await page.goto('/');};
const polls=(page:Page,n:number)=>page.waitForFunction(k=>(window as any).__polls>=k,n);
const guide=(page:Page)=>page.locator('.first-run');
const stored=(page:Page)=>page.evaluate(()=>localStorage.getItem('thanh-am-onboarding'));
const notices=(page:Page)=>page.getByRole('status').filter({hasText:'Đã xong bước'});

test('a new user sees the three TTS steps to do, with no project step; a step done after the first load is announced once',async({page})=>{
 await open(page,NONE);
 await expect(guide(page)).toBeVisible();
 await expect(guide(page).locator('li')).toHaveCount(3);
 await expect(guide(page).getByText('Chưa làm',{exact:true})).toHaveCount(3);
 await expect(guide(page).getByText('Tải VieNeu v3 Turbo (637 MB)')).toBeVisible();
 await expect(guide(page).getByText('Lưu file audio')).toBeVisible();
 for(const name of ['Tải ngay','Tạo giọng ngay','Xuất ngay'])await expect(guide(page).getByRole('button',{name,exact:true})).toBeVisible();
 await expect(guide(page).getByText('Tạo hoặc mở một dự án')).toHaveCount(0);await expect(guide(page).getByRole('button',{name:'Mở dự án mẫu'})).toHaveCount(0);
 await expect(notices(page)).toHaveCount(0);
 await page.evaluate(()=>(window as any).__flip());
 await expect(guide(page).getByText('Đã xong',{exact:true})).toHaveCount(1);
 await expect(notices(page)).toHaveCount(1);
 await expect(notices(page)).toContainText('Đã xong bước 1: Tải VieNeu v3 Turbo (637 MB)');
 await polls(page,await page.evaluate(()=>(window as any).__polls+2)); // later idle polls announce nothing more
 await expect(notices(page)).toHaveCount(1);
 await expect(guide(page).getByText('Chưa làm',{exact:true})).toHaveCount(2);
});
test('a set-up user never sees the checklist or a "Đã xong bước" notice, not even for one frame',async({page})=>{
 await open(page,{installed:true,projects:true,ttsDone:true});
 await polls(page,2);
 await expect(guide(page)).toHaveCount(0);await expect(notices(page)).toHaveCount(0);
 expect(await page.evaluate(()=>(window as any).__seen)).toEqual([]);
 expect(await stored(page)).toBe('done');
 await page.reload();await polls(page,2);await expect(guide(page)).toHaveCount(0);
});
test('the watcher does see the checklist for a new user (so the test above is not vacuous)',async({page})=>{
 await open(page,NONE);await expect(guide(page)).toBeVisible();
 expect((await page.evaluate(()=>(window as any).__seen)).length).toBeGreaterThan(0);
});
test('the watcher also sees a text swapped into an existing node',async({page})=>{
 await open(page,{installed:true,projects:true,ttsDone:true});await polls(page,1);
 await page.evaluate(async()=>{const t=document.createTextNode('x');document.body.append(t);await new Promise(r=>setTimeout(r,50));t.data='Đã xong bước 9: thử';});
 expect(await page.evaluate(()=>(window as any).__seen)).toEqual(['Đã xong bước 9: thử']);
});
test('a hidden checklist announces nothing when a step is finished later',async({page})=>{
 await open(page,NONE);
 await guide(page).getByRole('button',{name:'Ẩn hướng dẫn'}).click();await expect(guide(page)).toHaveCount(0);
 await page.evaluate(()=>(window as any).__flip());await polls(page,await page.evaluate(()=>(window as any).__polls+2));
 await expect(notices(page)).toHaveCount(0);expect(await stored(page)).toBe('hidden');
});
test('a finished checklist announces nothing when the model goes missing and comes back',async({page})=>{
 await page.addInitScript(()=>localStorage.setItem('thanh-am-onboarding','done'));
 await open(page,NONE);await polls(page,1);
 await page.evaluate(()=>(window as any).__flip());await polls(page,await page.evaluate(()=>(window as any).__polls+2));
 await expect(notices(page)).toHaveCount(0);await expect(guide(page)).toHaveCount(0);
});
test('the last step is still announced as the checklist turns done',async({page})=>{
 await open(page,{installed:false,projects:true,ttsDone:true});await expect(guide(page)).toBeVisible();
 await page.evaluate(()=>(window as any).__flip());
 await expect(notices(page)).toHaveCount(1);await expect(notices(page)).toContainText('Đã xong bước 1: Tải VieNeu v3 Turbo (637 MB)');
 await expect(guide(page)).toHaveCount(0);await expect.poll(()=>stored(page)).toBe('done');
});
test('a dismissed notice does not come back when the page re-renders',async({page})=>{
 await open(page,NONE);await expect(guide(page)).toBeVisible();
 await page.evaluate(()=>(window as any).__flip());await expect(notices(page)).toHaveCount(1);
 await page.getByRole('button',{name:'Đóng thông báo'}).click();await expect(notices(page)).toHaveCount(0);
 await page.keyboard.press('Control+k');await expect(page.getByRole('dialog',{name:'Bảng lệnh'})).toBeVisible();await page.keyboard.press('Escape');await expect(page.getByRole('dialog',{name:'Bảng lệnh'})).toHaveCount(0);
 await expect(notices(page)).toHaveCount(0);
});
const toolbar=(page:Page)=>page.locator('.script-panel .panel-toolbar button').first();
test('focus moves to the script toolbar when "Ẩn hướng dẫn" removes the checklist',async({page})=>{
 await open(page,NONE);await guide(page).getByRole('button',{name:'Ẩn hướng dẫn'}).click();
 await expect(guide(page)).toHaveCount(0);await expect(toolbar(page)).toBeFocused();
});
test('focus moves to the script toolbar when the last step finishes with the focus inside the checklist',async({page})=>{
 await open(page,{installed:false,projects:true,ttsDone:true});
 await guide(page).getByRole('button',{name:'Tải ngay',exact:true}).focus();
 await page.evaluate(()=>(window as any).__flip());
 await expect(guide(page)).toHaveCount(0);await expect(toolbar(page)).toBeFocused();
});
test('"Ẩn hướng dẫn" survives a reload, and the palette brings the checklist back',async({page})=>{
 await open(page,NONE);
 await guide(page).getByRole('button',{name:'Ẩn hướng dẫn'}).click();
 await expect(guide(page)).toHaveCount(0);expect(await stored(page)).toBe('hidden');
 await page.reload();await polls(page,1);await page.waitForTimeout(300);await expect(guide(page)).toHaveCount(0);
 await page.keyboard.press('Control+k');
 await page.getByRole('dialog',{name:'Bảng lệnh'}).getByRole('option',{name:'Hiện hướng dẫn bắt đầu'}).click();
 await expect(guide(page)).toBeVisible();expect(await stored(page)).toBeNull();
});
test('the palette also brings back a finished checklist',async({page})=>{
 await open(page,{installed:true,projects:true,ttsDone:true});await polls(page,1);
 await page.keyboard.press('Control+k');
 await page.getByRole('dialog',{name:'Bảng lệnh'}).getByRole('option',{name:'Hiện hướng dẫn bắt đầu'}).click();
 await expect(guide(page)).toBeVisible();await expect(guide(page).getByText('Đã xong',{exact:true})).toHaveCount(3);
});
test('the browser preview never shows the checklist',async({page})=>{
 await page.goto('/');await page.waitForTimeout(3000);
 await expect(page.getByRole('heading',{level:1})).toBeVisible();await expect(guide(page)).toHaveCount(0);
});
test('step 2 is disabled with its reason until a segment has text',async({page})=>{
 const generate=guide(page).getByRole('button',{name:'Tạo giọng ngay'});
 // No project: the reason is whyBlocked's.
 await open(page,{installed:true,projects:false,ttsDone:false});
 await expect(guide(page)).toBeVisible();await expect(generate).toBeDisabled();await expect(guide(page)).toContainText('Thêm ít nhất một đoạn');
});
for(const [text,reason] of [['','Đoạn này chưa có nội dung'],['Xin chào làng chài.',null]] as const)test(`step 2 with ${text?'a text':'an empty'} segment`,async({page})=>{
 await open(page,{installed:true,projects:true,ttsDone:false,text});
 await page.getByRole('button',{name:'Dự án',exact:true}).click();await page.getByRole('button',{name:'Mở dự án',exact:true}).click();
 await expect(page.getByRole('textbox',{name:'Nội dung đoạn 1'})).toBeVisible();
 const generate=guide(page).getByRole('button',{name:'Tạo giọng ngay'});
 await expect(guide(page)).toBeVisible();
 if(reason){await expect(generate).toBeDisabled();await expect(guide(page)).toContainText(reason);}
 else{await expect(generate).toBeEnabled();await generate.click();await expect.poll(()=>page.evaluate(()=>(window as any).__sent)).toContain('tts');}
});
for(const width of [800,640])test(`the checklist does not scroll sideways at ${width} px`,async({page})=>{
 await open(page,NONE,width,800);await expect(guide(page)).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
 expect(await page.evaluate(()=>[...document.querySelectorAll('.first-run, .first-run *')].filter(e=>e.getBoundingClientRect().right>innerWidth+1).length)).toBe(0);
});

// The STT page has its own checklist (storage key thanh-am-onboarding-stt), and "Tải ngay" downloads in place on both pages.
const said=(page:Page)=>page.evaluate(()=>(window as any).__said as string[]);
const storedStt=(page:Page)=>page.evaluate(()=>localStorage.getItem('thanh-am-onboarding-stt'));
const sidebar=(page:Page,label:RegExp)=>page.getByRole('navigation',{name:'Điều hướng chính'}).getByRole('button',{name:label});
const gotoStt=async(page:Page)=>{await sidebar(page,/^Chép lời/).click();await expect(page.locator('main h1')).toContainText('Chép lời');};
const sttPage=async(page:Page,d:Setup,openProject=false)=>{
 await open(page,d);
 if(openProject){await page.getByRole('button',{name:'Dự án',exact:true}).click();await page.getByRole('button',{name:'Mở dự án',exact:true}).click();await expect(page.getByRole('textbox',{name:'Nội dung đoạn 1'})).toBeVisible();}
 await gotoStt(page);
};
const downloads=(page:Page)=>page.evaluate(()=>(window as any).__downloads as string[]);
test('the STT page shows its own three steps and the TTS page keeps its own',async({page})=>{
 await sttPage(page,NONE);
 await expect(guide(page)).toBeVisible();await expect(guide(page).locator('li')).toHaveCount(3);
 await expect(guide(page).getByText('Chưa làm',{exact:true})).toHaveCount(3);
 for(const t of ['Tải Whisper Small (486 MB)','Chọn tệp âm thanh để chép lời','Lưu bản chép lời'])await expect(guide(page).getByText(t)).toBeVisible();
 for(const name of ['Tải ngay','Chọn tệp ngay','Chọn cách xuất'])await expect(guide(page).getByRole('button',{name,exact:true})).toBeVisible();
 await expect(guide(page).getByText('Tải VieNeu')).toHaveCount(0);
 await sidebar(page,/^Tạo giọng đọc/).click();
 await expect(guide(page).getByText('Tải VieNeu v3 Turbo (637 MB)')).toBeVisible();await expect(guide(page).getByText('Whisper')).toHaveCount(0);
});
test('the STT steps that cannot start yet say why',async({page})=>{
 await sttPage(page,NONE);
 await expect(guide(page).getByRole('button',{name:'Chọn tệp ngay',exact:true})).toBeDisabled();
 await expect(guide(page)).toContainText('Chưa tải model chép lời: tải Whisper Small trong Model & cài đặt.');
 await expect(guide(page).getByRole('button',{name:'Chọn cách xuất',exact:true})).toBeDisabled();
 await expect(guide(page)).toContainText('Chưa có nội dung để xuất');
});
test('"Tải ngay" on the TTS page downloads in place, shows the progress and is announced once, by the step',async({page})=>{
 await open(page,NONE);
 await guide(page).getByRole('button',{name:'Tải ngay',exact:true}).click();
 await expect.poll(()=>downloads(page)).toEqual(['vieneu-v3']);
 await expect(page.locator('main h1')).toContainText('Tạo giọng đọc');
 await expect(guide(page).locator('progress')).toHaveJSProperty('value',0.4);
 await expect(guide(page).getByRole('button',{name:'Đang tải…',exact:true})).toHaveAttribute('aria-disabled','true');
 await page.evaluate(()=>(window as any).__finishDownload('vieneu-v3'));
 await expect(notices(page)).toContainText('Đã xong bước 1: Tải VieNeu v3 Turbo (637 MB)',{timeout:10000});
 await expect(guide(page).locator('progress')).toHaveCount(0);
 expect((await said(page)).filter(t=>t.includes('Đã tải xong'))).toEqual([]);
 await expect(page.locator('main h1')).toContainText('Tạo giọng đọc');
});
test('"Tải ngay" on the STT page downloads the default Whisper model in place and is announced once, by the step',async({page})=>{
 await sttPage(page,NONE);
 await guide(page).getByRole('button',{name:'Tải ngay',exact:true}).click();
 await expect.poll(()=>downloads(page)).toEqual(['whisper-small']);
 await expect(page.locator('main h1')).toContainText('Chép lời');
 await expect(guide(page).locator('progress')).toHaveJSProperty('value',0.4);
 await expect(guide(page).getByRole('button',{name:'Đang tải…',exact:true})).toHaveAttribute('aria-disabled','true');
 await page.evaluate(()=>(window as any).__finishDownload('whisper-small'));
 await expect(notices(page)).toContainText('Đã xong bước 1: Tải Whisper Small (486 MB)',{timeout:10000});
 expect((await said(page)).filter(t=>t.includes('Đã tải xong'))).toEqual([]);
 await expect(page.locator('main h1')).toContainText('Chép lời');
});
test('a Whisper download that ends while the STT page is closed is announced as a download, and the step is silently done when the page opens again',async({page})=>{
 await sttPage(page,NONE);
 await guide(page).getByRole('button',{name:'Tải ngay',exact:true}).click();await expect(guide(page).locator('progress')).toHaveCount(1);
 await sidebar(page,/^Model & cài đặt/).click();await expect(page.locator('main h1')).toContainText('Model & cài đặt');
 await page.evaluate(()=>(window as any).__finishDownload('whisper-small'));
 await expect.poll(async()=>(await said(page)).includes('Đã tải xong Whisper Small.'),{timeout:10000}).toBe(true);
 expect((await said(page)).filter(t=>t.startsWith('Đã xong bước'))).toEqual([]);
 await gotoStt(page);
 await expect(guide(page).getByText('Đã xong',{exact:true})).toHaveCount(1);await page.waitForTimeout(300);
 expect((await said(page)).filter(t=>t.startsWith('Đã xong bước'))).toEqual([]);
});
test('the STT step 2 picks a file and is announced when the transcription finishes',async({page})=>{
 await sttPage(page,{installed:false,projects:true,ttsDone:false,whisper:true},true);
 await guide(page).getByRole('button',{name:'Chọn tệp ngay',exact:true}).click();
 await expect.poll(()=>page.evaluate(()=>(window as any).__sent)).toContain('stt');
 await expect(page.locator('main h1')).toContainText('Chép lời');
 await page.evaluate(()=>(window as any).__finishJob('stt'));
 await expect(notices(page)).toContainText('Đã xong bước 2: Chọn tệp âm thanh để chép lời',{timeout:10000});
});
test('the STT step 3 opens the transcript export menu, and saving a file finishes the checklist',async({page})=>{
 await sttPage(page,{installed:false,projects:true,ttsDone:false,whisper:true,sttDone:true,rows:true},true);
 await expect(guide(page).getByText('Đã xong',{exact:true})).toHaveCount(2);
 const trigger=page.locator('.transcript-panel').getByRole('button',{name:'Xuất…',exact:true});
 await guide(page).getByRole('button',{name:'Chọn cách xuất',exact:true}).click();
 await expect(trigger).toHaveAttribute('aria-expanded','true');
 await expect(page.getByRole('menu',{name:'Xuất…'}).getByRole('menuitem',{name:'TXT',exact:true})).toBeFocused();
 await page.getByRole('menuitem',{name:'TXT',exact:true}).click();
 await expect.poll(()=>page.evaluate(()=>(window as any).__exports)).toEqual(['C:/x/ban.txt']);
 await expect(notices(page)).toContainText('Đã xong bước 3: Lưu bản chép lời',{timeout:10000});
 await expect(guide(page)).toHaveCount(0);await expect.poll(()=>storedStt(page)).toBe('done');expect(await stored(page)).toBeNull();
});
test('the TTS step 3 is announced when an export finishes, and finishes the checklist',async({page})=>{
 await open(page,{installed:true,projects:true,ttsDone:true,renderDone:false});
 await expect(guide(page)).toBeVisible();await expect(guide(page).getByText('Đã xong',{exact:true})).toHaveCount(2);
 await page.evaluate(()=>(window as any).__finishJob('render'));
 await expect(notices(page)).toContainText('Đã xong bước 3: Lưu file audio',{timeout:10000});
 await expect(guide(page)).toHaveCount(0);await expect.poll(()=>stored(page)).toBe('done');expect(await storedStt(page)).toBeNull();
});
test('"Ẩn hướng dẫn" hides only its own page\'s checklist, and the palette brings back the one of the page it is used on',async({page})=>{
 await sttPage(page,NONE);
 await guide(page).getByRole('button',{name:'Ẩn hướng dẫn'}).click();
 await expect(guide(page)).toHaveCount(0);expect(await storedStt(page)).toBe('hidden');expect(await stored(page)).toBeNull();
 await page.reload();await polls(page,1);await gotoStt(page);await page.waitForTimeout(300);await expect(guide(page)).toHaveCount(0);
 await sidebar(page,/^Tạo giọng đọc/).click();await expect(guide(page)).toBeVisible();
 await gotoStt(page);
 await page.keyboard.press('Control+k');
 await page.getByRole('dialog',{name:'Bảng lệnh'}).getByRole('option',{name:'Hiện hướng dẫn bắt đầu'}).click();
 await expect(page.locator('main h1')).toContainText('Chép lời');await expect(guide(page)).toBeVisible();await expect(guide(page).getByText('Tải Whisper Small (486 MB)')).toBeVisible();
 expect(await storedStt(page)).toBeNull();
});
test('a set-up STT user is not shown the STT checklist',async({page})=>{
 await page.addInitScript(()=>localStorage.setItem('thanh-am-onboarding-stt','done'));
 await sttPage(page,{installed:true,projects:true,ttsDone:true,whisper:true,sttDone:true,rows:true});
 await polls(page,2);await page.waitForTimeout(300);await expect(guide(page)).toHaveCount(0);
});
test('while the app is busy the other steps keep their height and say nothing, their buttons are only disabled',async({page})=>{
 await open(page,{installed:false,projects:true,ttsDone:false,text:'Xin chào làng chài.'});
 await page.getByRole('button',{name:'Dự án',exact:true}).click();await page.getByRole('button',{name:'Mở dự án',exact:true}).click();
 await expect(page.getByRole('textbox',{name:'Nội dung đoạn 1'})).toBeVisible();
 const items=guide(page).locator('li'),height=(i:number)=>items.nth(i).evaluate(e=>e.getBoundingClientRect().height);
 const model=await height(0),exportStep=await height(2);
 await page.evaluate(()=>{(window as any).__hold=true;});
 await page.getByRole('button',{name:'Nhập TXT / SRT / Word'}).click(); // the file dialog stays open: the app is busy
 await expect(guide(page).getByRole('button',{name:'Tải ngay',exact:true})).toBeDisabled();
 expect(await height(0)).toBe(model);expect(await height(2)).toBe(exportStep);
 await expect(items.nth(0)).not.toContainText('Đang xử lý');await expect(items.nth(2)).not.toContainText('Đang xử lý');
 await page.evaluate(()=>(window as any).__release());
 await expect(guide(page).getByRole('button',{name:'Tải ngay',exact:true})).toBeEnabled();
});

// Focus: a step that finishes under the focus hands it to the next step's button, or to the heading when none can start.
const openProject=async(page:Page)=>{await page.getByRole('button',{name:'Dự án',exact:true}).click();await page.getByRole('button',{name:'Mở dự án',exact:true}).click();await expect(page.getByRole('textbox',{name:'Nội dung đoạn 1'})).toBeVisible();};
test('A: when the download that "Tải ngay" started finishes, the focus goes to the next step that can start',async({page})=>{
 await open(page,{installed:false,projects:true,ttsDone:false,text:'Xin chào làng chài.'});await openProject(page);
 const button=guide(page).locator('li').first().getByRole('button');await button.focus();await page.keyboard.press('Enter'); // its name turns into Đang tải…
 await expect(guide(page).locator('progress')).toHaveCount(1);await expect(button).toBeFocused();
 await page.evaluate(()=>(window as any).__finishDownload('vieneu-v3'));
 await expect(guide(page).getByRole('button',{name:'Tạo giọng ngay',exact:true})).toBeFocused({timeout:10000});
});
test('B: when the transcription of "Chọn tệp ngay" finishes and no later step can start, the focus goes to the checklist heading',async({page})=>{
 await sttPage(page,{installed:false,projects:true,ttsDone:false,whisper:true},true);
 const button=guide(page).getByRole('button',{name:'Chọn tệp ngay',exact:true});await button.focus();await page.keyboard.press('Enter');
 await expect.poll(()=>page.evaluate(()=>(window as any).__sent)).toContain('stt');await expect(button).toBeFocused();
 await page.evaluate(()=>(window as any).__finishJob('stt'));
 await expect(notices(page)).toContainText('Đã xong bước 2',{timeout:10000});
 await expect(guide(page).getByRole('heading',{name:'Chép lời đầu tiên với Thanh Âm'})).toBeFocused();
});
test('C: when the voice of "Tạo giọng ngay" is made, the focus goes to the next step that can start',async({page})=>{
 await open(page,{installed:true,projects:true,ttsDone:false,text:'Xin chào làng chài.',takes:true});await openProject(page);
 const button=guide(page).getByRole('button',{name:'Tạo giọng ngay',exact:true});await button.focus();await page.keyboard.press('Enter');
 await expect.poll(()=>page.evaluate(()=>(window as any).__sent)).toContain('tts');await expect(button).toBeFocused();
 await page.evaluate(()=>(window as any).__finishJob('tts'));
 await expect(notices(page)).toContainText('Đã xong bước 2',{timeout:10000});
 await expect(guide(page).getByRole('button',{name:'Xuất ngay',exact:true})).toBeFocused();
});
test('a step that finishes while the focus is elsewhere does not take the focus',async({page})=>{
 await open(page,{installed:false,projects:true,ttsDone:false,text:'Xin chào làng chài.'});await openProject(page);
 await guide(page).getByRole('button',{name:'Tải ngay',exact:true}).click();await expect(guide(page).locator('progress')).toHaveCount(1);
 const text=page.getByRole('textbox',{name:'Nội dung đoạn 1'});await text.focus();
 await page.evaluate(()=>(window as any).__finishDownload('vieneu-v3'));
 await expect(notices(page)).toContainText('Đã xong bước 1',{timeout:10000});await expect(text).toBeFocused();
});
test('a cancelled save dialog finishes nothing: step 3 stays undone, nothing is stored and nothing is announced',async({page})=>{
 await sttPage(page,{installed:false,projects:true,ttsDone:false,whisper:true,sttDone:true,rows:true},true);
 await page.evaluate(()=>{(window as any).__cancelSave=true;});
 await guide(page).getByRole('button',{name:'Chọn cách xuất',exact:true}).click();
 await page.getByRole('menuitem',{name:'TXT',exact:true}).click();
 await page.waitForTimeout(1500);
 expect(await page.evaluate(()=>(window as any).__exports)).toEqual([]);
 await expect(guide(page).getByText('Chưa làm',{exact:true})).toHaveCount(1);await expect(guide(page).getByText('Đã xong',{exact:true})).toHaveCount(2);
 expect(await storedStt(page)).toBeNull();expect((await said(page)).filter(t=>t.includes('Đã xong bước 3'))).toEqual([]);
});
test('"Xuất ngay" exports in place: the render is queued and the page stays',async({page})=>{
 await open(page,{installed:true,projects:true,ttsDone:true,renderDone:false,text:'Xin chào làng chài.',takes:true});await openProject(page);
 await guide(page).getByRole('button',{name:'Xuất ngay',exact:true}).click();
 await expect.poll(()=>page.evaluate(()=>(window as any).__sent)).toContain('render');
 await expect(page.locator('main h1')).toContainText('Tạo giọng đọc');
});
test('hiding the STT checklist moves the focus to the first button of the transcript toolbar',async({page})=>{
 await sttPage(page,NONE);
 await guide(page).getByRole('button',{name:'Ẩn hướng dẫn'}).click();
 await expect(guide(page)).toHaveCount(0);await expect(page.locator('.transcript-panel .panel-toolbar').getByRole('button',{name:'Thêm dòng'})).toBeFocused();
});
test('two models finishing in one poll are both announced, each by its own checklist',async({page})=>{
 await open(page,NONE);
 await guide(page).getByRole('button',{name:'Tải ngay',exact:true}).click();await expect(guide(page).locator('progress')).toHaveCount(1);
 await gotoStt(page);
 await guide(page).getByRole('button',{name:'Tải ngay',exact:true}).click();await expect(guide(page).locator('progress')).toHaveCount(1);
 await page.evaluate(()=>{const w=window as any;w.__finishDownload('vieneu-v3');w.__finishDownload('whisper-small');});
 await expect(notices(page)).toContainText('Tải Whisper Small (486 MB)',{timeout:10000});
 await expect(notices(page)).toContainText('Tải VieNeu v3 Turbo (637 MB)');
 expect((await said(page)).filter(t=>t.includes('Đã tải xong'))).toEqual([]);
});
