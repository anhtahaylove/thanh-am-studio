import {test,expect,type Page} from '@playwright/test';
// An in-memory desktop mock of the version store: save_project and restore_project_version keep the project and bump its revision as the real store does, and every call is logged.
type V={id:string;state_at:string;reason:'auto'|'before_restore';segments:number;transcript:number;content:[string,string][]};
const pad=(n:number)=>String(n).padStart(2,'0'),dm=(d:Date)=>`${pad(d.getDate())}/${pad(d.getMonth()+1)}`,hm=(d:Date)=>`${pad(d.getHours())}:${pad(d.getMinutes())}`;
const ago=(days:number,h:number,m:number)=>{const d=new Date();d.setDate(d.getDate()-days);d.setHours(h,m,0,0);return d;};
const ver=(id:string,d:Date,content:[string,string][],reason:V['reason']='auto',transcript=0):V=>({id,state_at:d.toISOString(),reason,segments:content.length,transcript,content});
const OLD=ago(0,9,5),BEFORE=ago(1,23,40),OLDER=ago(5,8,3);
const versions=()=>[ver('v1',OLD,[['a','Bản cũ một.'],['b','Bản cũ hai.']]),ver('v2',BEFORE,[['c','Chỉ còn một đoạn khác.']],'before_restore',4),ver('v3',OLDER,[['a','Bản rất cũ.'],['b','Hai.'],['d','Ba.']]),ver('v0',ago(7,7,0),[])];
const tts=(status:string,project='p1')=>({id:'j-'+status,kind:'tts',project_id:project,payload:{segment_id:'a'},status,progress:status==='succeeded'?1:0,error:null,result:null,created_at:new Date().toISOString(),updated_at:new Date().toISOString()});
const install=(page:Page,list:V[],jobs:object[]=[])=>page.addInitScript(([list,jobs])=>{
 const w=window as any;w.isTauri=true;
 const seg=(id:string,text:string)=>({id,text,normalized_text:text,voice_id:null,speaker:'Người dẫn',gap_ms:300,takes:[],selected_take_id:null,trim_start_ms:0,trim_end_ms:null,fade_in_ms:0,fade_out_ms:0,gain_db:0});
 const st=w.__st={project:{id:'p1',name:'Lịch sử',updated_at:new Date().toISOString(),revision:5,segments:[seg('a','Bản hiện tại.'),seg('b','Đoạn hai.')],transcript:[],dictionary:{},source_asset_id:null},versions:list,jobs,calls:[] as string[],saveGate:null as Promise<void>|null,loadGate:null as Promise<void>|null,loaded:0,restoreError:null as string|null};
 w.__TAURI_INTERNALS__={convertFileSrc:(p:string)=>p,transformCallback:()=>1,unregisterCallback:()=>{},metadata:{currentWindow:{label:'main'},currentWebview:{label:'main',windowLabel:'main'}},
  invoke:async(cmd:string,args:any)=>{switch(cmd){
   case 'list_projects':return [{id:st.project.id,name:st.project.name,updated_at:st.project.updated_at,revision:st.project.revision}];
   case 'load_project':{const snapshot=structuredClone(st.project);st.calls.push('load');if(st.loadGate)await st.loadGate;st.loaded++;return snapshot;}
   case 'save_project':{st.calls.push('save');if(st.saveGate)await st.saveGate;if(args.project.revision!==st.project.revision)throw 'REVISION_CONFLICT: Dự án đã thay đổi. Hãy tải lại trước khi lưu.';st.project={...args.project,revision:args.project.revision+1,updated_at:new Date().toISOString()};st.calls.push('saved');return st.project;}
   case 'list_project_versions':return st.versions;
   case 'restore_project_version':{st.calls.push('restore:'+args.revision);if(st.restoreError)throw st.restoreError;if(args.revision!==st.project.revision)throw 'REVISION_CONFLICT: Dự án đã thay đổi. Hãy tải lại trước khi lưu.';const v=st.versions.find((x:any)=>x.id===args.versionId);if(!v)throw 'VERSION_NOT_FOUND: Phiên bản này không còn. Mở lại lịch sử phiên bản.';st.project={...st.project,segments:v.content.map(([id,text]:[string,string])=>seg(id,text)),revision:st.project.revision+1,updated_at:new Date().toISOString()};return st.project;}
   case 'list_jobs':return st.jobs;
   case 'list_voices':case 'list_models':return [];
   case 'get_settings':return {dictionary:{}};
   case 'runtime_status':return {python_ready:true,ffmpeg_ready:true,worker_ready:true,native_worker_ready:false,python_path:null,ffmpeg_path:null,native_worker_path:null,fallback_count:0,message:''};
   default:return null;}}};
},[list,jobs] as const);
const calls=(page:Page)=>page.evaluate(()=>(window as any).__st.calls as string[]);
const setSt=(page:Page,patch:Record<string,unknown>)=>page.evaluate(p=>Object.assign((window as any).__st,p),patch);
const openProject=async(page:Page)=>{await page.goto('/');await page.getByRole('button',{name:'Dự án',exact:true}).click();await page.getByRole('button',{name:'Mở dự án',exact:true}).click();await expect(page.getByRole('textbox',{name:'Nội dung đoạn 1'})).toHaveValue('Bản hiện tại.');await page.evaluate(()=>{const st=(window as any).__st;st.calls.length=0;st.loaded=0;});};
const topbar=(page:Page)=>page.getByRole('button',{name:'Lịch sử phiên bản',exact:true}),dialog=(page:Page)=>page.getByRole('dialog',{name:'Lịch sử phiên bản'});
const restoreButtons=(page:Page)=>dialog(page).getByRole('button',{name:/^Khôi phục trạng thái lúc/});
const commands=(page:Page)=>page.getByRole('dialog',{name:'Bảng lệnh'}).getByRole('option');
const first=(page:Page)=>page.getByRole('textbox',{name:'Nội dung đoạn 1'});
const edit=async(page:Page)=>{await first(page).focus();await page.keyboard.press('End');await page.keyboard.type('!');await expect(page.getByRole('button',{name:'Chưa lưu'})).toBeVisible();};
const PROJECT_BUSY='PROJECT_BUSY: Dự án đang có công việc chạy hoặc chờ. Chờ xong hoặc hủy rồi khôi phục.',CONFLICT='REVISION_CONFLICT: Dự án đã thay đổi. Hãy tải lại trước khi lưu.';

test('opens from the topbar button and from the palette, names itself, lists newest first and closes with Escape back to the button',async({page})=>{
 await install(page,versions());await openProject(page);
 await topbar(page).click();await expect(dialog(page)).toBeVisible();
 await expect(dialog(page).getByRole('heading',{name:'Lịch sử phiên bản'})).toBeVisible();
 await expect(dialog(page)).toContainText('Ứng dụng tự lưu một phiên bản khi bạn sửa dự án, tối đa 10 phút một lần, và giữ tối đa 30 phiên bản gần nhất.');
 await expect(restoreButtons(page)).toHaveCount(4);await expect(restoreButtons(page).first()).toBeFocused();
 await page.keyboard.press('Escape');await expect(dialog(page)).toHaveCount(0);await expect(topbar(page)).toBeFocused();
 await topbar(page).click();await dialog(page).getByRole('button',{name:'Đóng lịch sử phiên bản'}).click();await expect(dialog(page)).toHaveCount(0);await expect(topbar(page)).toBeFocused();
 await page.keyboard.press('Control+k');await page.getByRole('combobox',{name:'Gõ để tìm lệnh'}).fill('lich su');
 await expect(commands(page)).toHaveText(['Lịch sử phiên bản…']);await page.keyboard.press('Enter');
 await expect(dialog(page)).toBeVisible();await expect(page.getByRole('dialog',{name:'Bảng lệnh'})).toHaveCount(0);await page.keyboard.press('Escape');await expect(dialog(page)).toHaveCount(0);
});
test('an empty history says so and has nothing to restore',async({page})=>{
 await install(page,[]);await openProject(page);await topbar(page).click();
 await expect(dialog(page)).toContainText('Chưa có phiên bản nào. Phiên bản đầu tiên được lưu khi bạn sửa dự án lần tới.');
 await expect(restoreButtons(page)).toHaveCount(0);await expect(dialog(page).getByRole('button',{name:'Đóng lịch sử phiên bản'})).toBeFocused();
});
test('rows read "Hôm nay | Hôm qua | dd/MM lúc HH:mm · n đoạn · m dòng chép lời", mark the before-restore version, and name the state to restore',async({page})=>{
 await install(page,versions());await openProject(page);await topbar(page).click();
 const rows=dialog(page).locator('li'),label=(i:number)=>rows.nth(i).locator('.version-label');
 await expect(label(0)).toHaveText(`Hôm nay lúc ${hm(OLD)} · 2 đoạn · 0 dòng chép lời`);
 await expect(label(1)).toHaveText(`Hôm qua lúc ${hm(BEFORE)} · 1 đoạn · 4 dòng chép lời`);
 await expect(label(2)).toHaveText(`${dm(OLDER)} lúc ${hm(OLDER)} · 3 đoạn · 0 dòng chép lời`);
 await expect(dialog(page).getByText('Trước khi khôi phục',{exact:true})).toHaveCount(1);await expect(rows.nth(1).getByText('Trước khi khôi phục',{exact:true})).toBeVisible();
 await expect(rows.nth(0).getByRole('button',{name:`Khôi phục trạng thái lúc ${hm(OLD)} ngày ${dm(OLD)}`})).toHaveText('Khôi phục');
 await expect(rows.nth(2).getByRole('button',{name:`Khôi phục trạng thái lúc ${hm(OLDER)} ngày ${dm(OLDER)}`})).toBeVisible();
});
test('restoring saves unsaved edits first, restores at the saved revision, then shows the state, a 6 s status and focus in the first segment; undo history is cleared',async({page})=>{
 await install(page,versions());await openProject(page);
 await edit(page);await expect(page.getByRole('button',{name:'Hoàn tác (Ctrl+Z)'})).toBeEnabled();
 await topbar(page).click();await restoreButtons(page).first().click();
 await expect(dialog(page)).toHaveCount(0);await expect(first(page)).toHaveValue('Bản cũ một.');await expect(first(page)).toBeFocused();
 expect(await calls(page)).toEqual(['save','saved','restore:6']);
 await expect(page.getByRole('button',{name:'Đã lưu'})).toBeVisible();
 const status=page.getByRole('status').filter({hasText:'Đã khôi phục trạng thái lúc'});
 await expect(status).toHaveText(`Đã khôi phục trạng thái lúc ${hm(OLD)}. Trạng thái trước đó được lưu thành phiên bản “Trước khi khôi phục”.`);
 await expect(page.getByRole('button',{name:'Hoàn tác (Ctrl+Z)'})).toBeDisabled();
 await page.keyboard.press('Control+z');await expect(first(page)).toHaveValue('Bản cũ một.');await expect(page.getByRole('button',{name:'Đã lưu'})).toBeVisible();
 await expect(status).toHaveCount(0,{timeout:9000});
 expect(await calls(page)).toEqual(['save','saved','restore:6']);
});
test('an autosave already in flight finishes before the restore starts, and the restore uses the revision it produced',async({page})=>{
 await install(page,versions());await openProject(page);
 await page.evaluate(()=>{const st=(window as any).__st;st.saveGate=new Promise<void>(r=>{st.release=r;});});
 await edit(page);await expect.poll(()=>calls(page)).toEqual(['save']);
 await topbar(page).click();await restoreButtons(page).first().click();
 await page.waitForTimeout(400);expect(await calls(page)).toEqual(['save']);
 await page.evaluate(()=>(window as any).__st.release());
 await expect(first(page)).toHaveValue('Bản cũ một.');expect(await calls(page)).toEqual(['save','saved','restore:6']);
});
test('a load issued before the restore that resolves after it does not overwrite the restored project',async({page})=>{
 await install(page,versions());await openProject(page);
 await page.evaluate(()=>{const st=(window as any).__st;st.calls.length=0;st.loadGate=new Promise<void>(r=>{st.release=r;});});
 await setSt(page,{jobs:[tts('succeeded')]});
 await expect.poll(()=>calls(page),{timeout:8000}).toEqual(['load']);
 await topbar(page).click();await restoreButtons(page).first().click();
 await expect(first(page)).toHaveValue('Bản cũ một.');
 await page.evaluate(()=>(window as any).__st.release());
 await expect.poll(()=>page.evaluate(()=>(window as any).__st.loaded)).toBe(1);
 await page.evaluate(()=>new Promise<void>(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r()))));
 await expect(first(page)).toHaveValue('Bản cũ một.');await expect(page.getByRole('button',{name:'Đã lưu'})).toBeVisible();
});
for(const [name,message] of [['PROJECT_BUSY',PROJECT_BUSY],['REVISION_CONFLICT',CONFLICT]] as const)test(`a ${name} rejection shows its message in the alert, leaves the project as it was, and a later edit is still saved`,async({page})=>{
 await install(page,versions());await openProject(page);
 await setSt(page,{restoreError:message});await topbar(page).click();await restoreButtons(page).first().click();
 await expect(dialog(page)).toHaveCount(0);await expect(page.getByRole('alert')).toContainText(message);await expect(first(page)).toHaveValue('Bản hiện tại.');
 await edit(page);
 await expect.poll(()=>calls(page)).toEqual(['restore:5','save','saved']);
 await expect(page.getByRole('button',{name:'Đã lưu'})).toBeVisible();await expect(first(page)).toHaveValue('Bản hiện tại.!');
});
test('a version the store no longer has is reported in the alert',async({page})=>{
 await install(page,versions());await openProject(page);await topbar(page).click();await expect(restoreButtons(page)).toHaveCount(4);
 await setSt(page,{versions:[]});await restoreButtons(page).first().click();
 await expect(page.getByRole('alert')).toContainText('VERSION_NOT_FOUND: Phiên bản này không còn. Mở lại lịch sử phiên bản.');
});
test('with a queued or running job of the project every Khôi phục says why it is blocked and does nothing; another project\'s job does not block',async({page})=>{
 await install(page,versions(),[tts('running')]);await openProject(page);await topbar(page).click();
 const reason='Dự án đang có công việc chạy hoặc chờ. Chờ xong hoặc hủy rồi khôi phục.';
 for(let i=0;i<4;i++){const b=restoreButtons(page).nth(i);await expect(b).toHaveAttribute('aria-disabled','true');await expect(b).toHaveAccessibleDescription(reason);await expect(b).toHaveAttribute('title',reason);}
 await restoreButtons(page).first().click({force:true});await page.waitForTimeout(300);expect(await calls(page)).toEqual([]);await expect(dialog(page)).toBeVisible();
 await page.keyboard.press('Escape');await setSt(page,{jobs:[tts('running','other')]});await topbar(page).click();await expect(restoreButtons(page).first()).not.toHaveAttribute('aria-disabled','true');
 await page.keyboard.press('Escape');await setSt(page,{jobs:[tts('queued')]});await topbar(page).click();await expect(restoreButtons(page).first()).toHaveAttribute('aria-disabled','true');
});
test('the selected segment stays selected when it still exists, else the first one is; a project with no segments puts focus on "Viết đoạn đầu tiên"',async({page})=>{
 await install(page,versions());await openProject(page);
 const rows=page.locator('article.segment');
 await page.getByRole('textbox',{name:'Nội dung đoạn 2'}).click();await expect(rows.nth(1)).toHaveClass(/selected/);
 await topbar(page).click();await restoreButtons(page).first().click();await expect(first(page)).toHaveValue('Bản cũ một.');await expect(rows).toHaveCount(2);await expect(rows.nth(1)).toHaveClass(/selected/);
 await topbar(page).click();await restoreButtons(page).nth(1).click();await expect(first(page)).toHaveValue('Chỉ còn một đoạn khác.');await expect(rows).toHaveCount(1);await expect(rows.first()).toHaveClass(/selected/);
 await topbar(page).click();await restoreButtons(page).nth(3).click();await expect(page.getByRole('button',{name:'Viết đoạn đầu tiên'})).toBeFocused();
});
test('fits a 456 x 320 window: no sideways scroll, every row reachable',async({page})=>{
 await page.setViewportSize({width:456,height:320});
 await install(page,versions());await openProject(page);await topbar(page).click();
 const box=await dialog(page).boundingBox();expect(box!.x).toBeGreaterThanOrEqual(0);expect(box!.y).toBeGreaterThanOrEqual(0);expect(box!.x+box!.width).toBeLessThanOrEqual(456);expect(box!.y+box!.height).toBeLessThanOrEqual(320);
 expect(await dialog(page).evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);
 await restoreButtons(page).last().scrollIntoViewIfNeeded();await expect(restoreButtons(page).last()).toBeInViewport();
});
test('the browser preview has no version history button or palette command',async({page})=>{
 await page.goto('/');await page.getByRole('button',{name:'Viết đoạn đầu tiên'}).click();await expect(page.getByRole('textbox',{name:'Nội dung đoạn 1'})).toBeVisible();
 await expect(topbar(page)).toHaveCount(0);
 await page.keyboard.press('Control+k');await expect(page.getByRole('dialog',{name:'Bảng lệnh'})).toBeVisible();await page.getByRole('combobox',{name:'Gõ để tìm lệnh'}).fill('lich su');
 await expect(commands(page)).toHaveCount(0);
});
