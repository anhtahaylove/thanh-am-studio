import {test,expect} from '@playwright/test';
import type {Page} from '@playwright/test';
// The first-run checklist on the TTS page: three steps, a load gate so a set-up user never sees it, a "Đã xong bước" notice only for
// steps finished after the first poll, and a stored "hidden" or "done". Tauri is mocked; `__flip()` installs the voice model.
type Setup={installed:boolean;projects:boolean;ttsDone:boolean;text?:string};
const mock=(d:Setup)=>{
 const w=window as any,now='2026-11-22T00:00:00Z';let installed=d.installed;w.isTauri=true;w.__polls=0;w.__sent=[];w.__flip=()=>{installed=true;};
 const project={id:'p1',name:'Làng chài',updated_at:now,revision:1,segments:[{id:'s1',text:d.text??'',normalized_text:'',voice_id:null,speaker:'',gap_ms:300,takes:[],selected_take_id:null,trim_start_ms:0,trim_end_ms:null,fade_in_ms:0,fade_out_ms:0,gain_db:0}],transcript:[],dictionary:{},source_asset_id:null};
 const job={id:'j1',kind:'tts',project_id:'p1',payload:{},status:'succeeded',progress:1,error:null,result:null,created_at:now,updated_at:now};
 w.__TAURI_INTERNALS__={convertFileSrc:(p:string)=>p,transformCallback:()=>1,unregisterCallback:()=>{},metadata:{currentWindow:{label:'main'},currentWebview:{label:'main',windowLabel:'main'}},
  invoke:async(cmd:string,args:any)=>{switch(cmd){
   case 'list_projects':return d.projects?[{id:project.id,name:project.name,updated_at:now,revision:1}]:[];case 'load_project':return project;case 'save_project':return {...args.project,revision:args.project.revision+1};
   case 'list_jobs':return d.ttsDone?[job]:[];case 'list_voices':return [];case 'get_settings':return {dictionary:{}};
   case 'list_models':w.__polls++;return [{id:'vieneu-v3',name:'VieNeu v3 Turbo',engine:'tts',kind:'model',installed,revision:'r',license:'',description:''}];
   case 'runtime_status':return {python_ready:true,ffmpeg_ready:true,worker_ready:true,native_worker_ready:true,python_path:null,ffmpeg_path:null,native_worker_path:null,fallback_count:0,total_memory_mb:null,message:''};
   case 'enqueue_job':w.__sent.push(args.kind);return {id:'j2',kind:args.kind,project_id:'p1',payload:args.payload,status:'queued',progress:0,error:null,result:null,created_at:now,updated_at:now};
   default:return null;}}};
};
// Records every node the app adds that is the checklist or says a step is done, and every text changed into one, from the first paint on.
const watch=()=>{
 const w=window as any;w.__seen=[];
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

test('a new user sees three steps to do; a step done after the first load is announced once',async({page})=>{
 await open(page,NONE);
 await expect(guide(page)).toBeVisible();
 await expect(guide(page).locator('li')).toHaveCount(3);
 await expect(guide(page).getByText('Chưa làm',{exact:true})).toHaveCount(3);
 await expect(guide(page).getByText('Tải VieNeu v3 Turbo (637 MB)')).toBeVisible();
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
 await guide(page).getByRole('button',{name:'Xem model giọng đọc'}).focus();
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
test('step 3 is disabled with its reason until a segment has text',async({page})=>{
 const generate=guide(page).getByRole('button',{name:'Tạo giọng ngay'});
 // No project: the reason is whyBlocked's.
 await open(page,{installed:true,projects:false,ttsDone:false});
 await expect(guide(page)).toBeVisible();await expect(generate).toBeDisabled();await expect(guide(page)).toContainText('Thêm ít nhất một đoạn');
});
for(const [text,reason] of [['','Đoạn này chưa có nội dung'],['Xin chào làng chài.',null]] as const)test(`step 3 with ${text?'a text':'an empty'} segment`,async({page})=>{
 await open(page,{installed:true,projects:true,ttsDone:false,text});
 await page.getByRole('navigation',{name:'Điều hướng chính'}).getByRole('button',{name:'Dự án',exact:true}).click();await page.getByRole('button',{name:'Mở dự án'}).click();
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
