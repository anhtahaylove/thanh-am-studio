import {test,expect} from '@playwright/test';
import type {Page} from '@playwright/test';
// Round 1.0.26 S3a: "Hàng đợi" in the sidebar opens the queue as a drawer, never as a page: a column beside the page above 1200 px, an overlay over its right side at 1200 px
// and below, which closes when focus or a pointer press goes outside it. Escape inside the drawer closes it and gives focus back to the button; Escape elsewhere leaves it open.
// The chapter notice ("Đã thêm … chương vào hàng đợi xuất.") clears when the drawer opens, its "Mở hàng đợi" opens the drawer, a repeat is a new status element (read again),
// an export while the drawer is open shows none, and opening another project clears it. Tauri is mocked as in export-in-place.spec.ts; commands are recorded in window.__calls.
const mock=()=>{
 const w=window as any,now='2026-11-27T00:00:00Z',calls:any[]=[];w.isTauri=true;w.__calls=calls;
 const take=(id:string)=>({id,asset_id:'a'+id,path:id+'.wav',duration_ms:3000,sample_rate:48000,created_at:now});
 const seg=(i:number)=>({id:String(i),text:'Câu '+i+'.',normalized_text:'Câu '+i+'.',voice_id:null,speaker:'Người dẫn',gap_ms:300,takes:[take('t'+i)],selected_take_id:'t'+i,trim_start_ms:0,trim_end_ms:null,fade_in_ms:0,fade_out_ms:0,gain_db:0,chapter:'P'+i});
 const projects=[{id:'p1',name:'Xuất tại chỗ',updated_at:now,revision:1,segments:[seg(1),seg(2)],transcript:[],dictionary:{},source_asset_id:null},{id:'p2',name:'Dự án khác',updated_at:now,revision:1,segments:[seg(3)],transcript:[],dictionary:{},source_asset_id:null}];
 const job=(id:string,kind:string,status:string,payload:object)=>({id,kind,project_id:'p1',payload,status,progress:status==='running'?.4:status==='succeeded'?1:0,error:null,result:status==='succeeded'?{asset_id:'r'+id}:null,created_at:now,updated_at:now});
 const jobs:any[]=[job('j1','render','succeeded',{format:'wav',name:'Bản cũ'}),job('j2','tts','running',{segment_id:'1',text:'Câu 1.'})];
 w.__TAURI_INTERNALS__={convertFileSrc:(p:string)=>p,transformCallback:()=>1,unregisterCallback:()=>{},metadata:{currentWindow:{label:'main'},currentWebview:{label:'main',windowLabel:'main'}},
  invoke:async(cmd:string,args:any)=>{calls.push({cmd,args:JSON.parse(JSON.stringify(args??{}))});switch(cmd){
   case 'list_projects':return projects.map(p=>({id:p.id,name:p.name,updated_at:now,revision:1}));case 'load_project':return JSON.parse(JSON.stringify(projects.find(p=>p.id===args.id)));
   case 'save_project':return {...args.project,revision:args.project.revision+1};
   case 'list_voices':case 'list_models':return [];case 'get_settings':return {dictionary:{}};
   case 'list_jobs':return JSON.parse(JSON.stringify([...jobs].reverse()));
   case 'runtime_status':return {python_ready:true,ffmpeg_ready:true,worker_ready:true,python_path:null,ffmpeg_path:null,message:''};
   case 'enqueue_job':{const j=job('n'+jobs.length,'render','queued',args.payload);jobs.push(j);return j;}
   default:return null;}}};
};
const open=async(page:Page,project='Xuất tại chỗ')=>{
 await page.addInitScript(mock);await page.goto('/');await page.getByRole('button',{name:'Dự án',exact:true}).click();
 await page.locator('.project-card',{hasText:project}).getByRole('button',{name:'Mở dự án',exact:true}).click();
 await expect(page.getByRole('textbox',{name:'Nội dung đoạn 1'})).toBeVisible();
};
const queueButton=(page:Page)=>page.getByRole('navigation',{name:'Điều hướng chính'}).getByRole('button',{name:/^Hàng đợi/});
const drawerOf=(page:Page)=>page.getByRole('complementary',{name:'Hàng đợi'});
const h1=(page:Page)=>page.locator('main h1');
const enqueued=(page:Page)=>page.evaluate(()=>(window as any).__calls.filter((c:any)=>c.cmd==='enqueue_job').length as number);
const box=async(page:Page,selector:string)=>(await page.locator(selector).boundingBox())!;
const perChapter=async(page:Page)=>{await page.getByText('Tùy chọn xuất',{exact:true}).click();await page.getByRole('checkbox',{name:'Mỗi chương một file'}).check();};
const exportAudio=(page:Page)=>page.getByRole('button',{name:'Xuất audio',exact:true});
const notice=(page:Page)=>page.getByRole('status').filter({hasText:'Đã thêm 2 chương vào hàng đợi xuất.'});

test('Hàng đợi opens the drawer beside the current page; Escape inside closes it; Escape elsewhere does not',async({page})=>{
 await open(page);const button=queueButton(page),drawer=drawerOf(page);
 await expect(button).toHaveAttribute('aria-expanded','false');await expect(drawer).toBeHidden();
 await button.click();
 await expect(drawer).toBeVisible();await expect(button).toHaveAttribute('aria-expanded','true');
 expect(await button.getAttribute('aria-controls')).toBe(await drawer.getAttribute('id'));
 await expect(drawer).toBeFocused();await expect(h1(page)).toContainText('Tạo giọng đọc'); // the page stays; focus moves into the drawer
 await expect(drawer.locator('.job-row')).toHaveCount(2);await expect(drawer.getByRole('button',{name:'Lưu audio'})).toBeVisible();await expect(drawer.getByRole('button',{name:'Hủy'})).toBeVisible();
 const m=await box(page,'main'),d=await box(page,'#queue-drawer');expect(d.x,'the drawer starts where the page ends').toBeGreaterThanOrEqual(m.x+m.width-1);
 await page.getByRole('textbox',{name:'Nội dung đoạn 1'}).click();await page.keyboard.press('Escape');
 await expect(drawer,'Escape in the script leaves the drawer open').toBeVisible();await expect(button).toHaveAttribute('aria-expanded','true');
 await drawer.getByRole('button',{name:'Làm mới'}).focus();await page.keyboard.press('Escape');
 await expect(drawer).toBeHidden();await expect(button).toHaveAttribute('aria-expanded','false');await expect(button).toBeFocused();
});

test('the Queue button keeps the running count and toggles the drawer; "Đóng hàng đợi" closes it and gives focus back to the button',async({page})=>{
 await open(page);const button=queueButton(page),drawer=drawerOf(page);
 await expect(button).toHaveAccessibleName('Hàng đợi (1)');await expect(button.locator('.nav-count')).toHaveText('1');await expect(button).not.toHaveAttribute('aria-current');
 await button.click();await expect(drawer).toBeVisible();
 await drawer.getByRole('button',{name:'Đóng hàng đợi',exact:true}).click();
 await expect(drawer).toBeHidden();await expect(button).toBeFocused();await expect(button).toHaveAttribute('aria-expanded','false');
 await button.click();await expect(drawer).toBeVisible();await button.click();await expect(drawer).toBeHidden();await expect(button).toBeFocused();
});

test('the palette command "Đi tới Hàng đợi" opens the drawer on the page the user is on and moves focus into it',async({page})=>{
 await open(page);await page.getByRole('navigation',{name:'Điều hướng chính'}).getByRole('button',{name:'Chép lời',exact:true}).click();
 await page.keyboard.press('Control+k');await page.getByRole('dialog',{name:'Bảng lệnh'}).getByRole('option',{name:'Đi tới Hàng đợi',exact:true}).click();
 await expect(drawerOf(page)).toBeVisible();await expect(drawerOf(page)).toBeFocused();await expect(h1(page)).toContainText('Chép lời');
});

test('at 1024 px the drawer lies over the page: a press inside keeps it, a press outside or focus moving outside closes it',async({page})=>{
 await page.setViewportSize({width:1024,height:720});await open(page);const button=queueButton(page),drawer=drawerOf(page);
 await button.click();await expect(drawer).toBeFocused();
 const m=await box(page,'main'),d=await box(page,'#queue-drawer');expect(d.x,'the drawer lies over the page').toBeLessThan(m.x+m.width);
 await drawer.locator('.job-row').first().click();await expect(drawer).toBeVisible();
 await h1(page).click();await expect(drawer).toBeHidden();await expect(button).toHaveAttribute('aria-expanded','false');
 await button.click();await expect(drawer).toBeFocused();
 await page.getByRole('textbox',{name:'Nội dung đoạn 1'}).focus();await expect(drawer).toBeHidden();
});

test('the drawer is not modal: nothing goes inert, its controls show the focus ring, and with reduced motion it does not fade in',async({page})=>{
 await open(page);const drawer=drawerOf(page);
 await queueButton(page).click();await expect(drawer).toBeVisible();
 expect(await drawer.evaluate(d=>getComputedStyle(d).animationName)).toBe('fade-in');
 for(const s of ['.sidebar','.workspace'])await expect(page.locator(s)).toHaveJSProperty('inert',false);
 await page.keyboard.press('Tab');const first=drawer.getByRole('button').first();await expect(first).toBeFocused();
 expect(await first.evaluate(e=>`${getComputedStyle(e).outlineStyle} ${getComputedStyle(e).outlineWidth}`)).toBe('solid 2px');
 await page.keyboard.press('Escape');await page.emulateMedia({reducedMotion:'reduce'});await queueButton(page).click();await expect(drawer).toBeVisible();
 expect(await drawer.evaluate(d=>getComputedStyle(d).animationName)).toBe('none');
});

test('the chapter notice: a repeat is a new status element, "Mở hàng đợi" opens the drawer and clears it, and closing the drawer does not bring it back',async({page})=>{
 await open(page);await perChapter(page);
 await exportAudio(page).click();await expect(notice(page)).toBeVisible();await expect.poll(()=>enqueued(page)).toBe(2);
 const first=await notice(page).elementHandle();await expect(exportAudio(page)).toBeEnabled();
 await exportAudio(page).click();await expect.poll(()=>enqueued(page)).toBe(4);
 await expect(notice(page)).toBeVisible();expect(await first!.evaluate(e=>e.isConnected),'the repeated notice is a new element, so a screen reader reads it again').toBe(false);
 await notice(page).getByRole('button',{name:'Mở hàng đợi',exact:true}).click();
 await expect(drawerOf(page)).toBeVisible();await expect(drawerOf(page)).toBeFocused();await expect(notice(page)).toHaveCount(0);await expect(h1(page)).toContainText('Tạo giọng đọc');
 await page.keyboard.press('Escape');await expect(drawerOf(page)).toBeHidden();await expect(notice(page)).toHaveCount(0);
});

test('opening the drawer clears the chapter notice, and an export from the palette while it is open shows none',async({page})=>{
 await open(page);await perChapter(page);
 await exportAudio(page).click();await expect(notice(page)).toBeVisible();
 await queueButton(page).click();await expect(drawerOf(page)).toBeVisible();await expect(notice(page)).toHaveCount(0);
 await page.keyboard.press('Control+k');await page.getByRole('dialog',{name:'Bảng lệnh'}).getByRole('option',{name:'Xuất audio',exact:true}).click();
 await expect.poll(()=>enqueued(page)).toBe(4);await page.waitForTimeout(300);
 await expect(drawerOf(page)).toBeVisible();await expect(notice(page)).toHaveCount(0);
 await queueButton(page).click();await expect(drawerOf(page)).toBeHidden();await expect(notice(page)).toHaveCount(0);
});

test('opening another project clears the chapter notice',async({page})=>{
 await open(page);await perChapter(page);
 await exportAudio(page).click();await expect(notice(page)).toBeVisible();
 await page.getByRole('button',{name:'Dự án',exact:true}).click();await page.locator('.project-card',{hasText:'Dự án khác'}).getByRole('button',{name:'Mở dự án',exact:true}).click();
 await expect(page.locator('.topbar')).toContainText('Dự án khác');await expect(notice(page)).toHaveCount(0);
});
