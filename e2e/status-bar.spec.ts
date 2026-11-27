import {test,expect} from '@playwright/test';
import type {Page} from '@playwright/test';
// Round 1.0.26 S3b: a line at the bottom of the workspace shows the running job ("{kind} {name} {percent}") or "Sẵn sàng" as one text plus a progress bar. It is not a live region
// (finished jobs keep using the existing notices), a click opens the queue drawer, and it never covers the audio dock or the drawer's last control. Tauri is mocked as in queue-drawer.spec.ts.
const mock=(running:boolean)=>{
 const w=window as any,now='2026-11-27T00:00:00Z';w.isTauri=true;
 const seg={id:'1',text:'Câu 1.',normalized_text:'Câu 1.',voice_id:null,speaker:'Người dẫn',gap_ms:300,takes:[{id:'t1',asset_id:'a1',path:'t1.wav',duration_ms:3000,sample_rate:48000,created_at:now}],selected_take_id:'t1',trim_start_ms:0,trim_end_ms:null,fade_in_ms:0,fade_out_ms:0,gain_db:0};
 const project={id:'p1',name:'Thanh trạng thái',updated_at:now,revision:1,segments:[seg],transcript:[],dictionary:{},source_asset_id:null};
 const job=(id:string,kind:string,status:string,payload:object,progress:number)=>({id,kind,project_id:'p1',payload,status,progress,error:null,result:status==='succeeded'?{asset_id:'r'+id}:null,created_at:now,updated_at:now});
 const jobs=[job('j1','render','succeeded',{format:'wav',name:'Bản cũ'},1),...(running?[job('j2','render','running',{name:'Chương 1'},.4)]:[])];
 w.__TAURI_INTERNALS__={convertFileSrc:(p:string)=>p,transformCallback:()=>1,unregisterCallback:()=>{},metadata:{currentWindow:{label:'main'},currentWebview:{label:'main',windowLabel:'main'}},
  invoke:async(cmd:string,args:any)=>{switch(cmd){
   case 'list_projects':return [{id:'p1',name:project.name,updated_at:now,revision:1}];case 'load_project':return JSON.parse(JSON.stringify(project));
   case 'save_project':return {...args.project,revision:args.project.revision+1};
   case 'list_voices':case 'list_models':return [];case 'get_settings':return {dictionary:{}};
   case 'list_jobs':return JSON.parse(JSON.stringify([...jobs].reverse()));
   case 'runtime_status':return {python_ready:true,ffmpeg_ready:true,worker_ready:true,python_path:null,ffmpeg_path:null,message:''};
   default:return null;}}};
};
const open=async(page:Page,running=true)=>{
 await page.addInitScript(mock,running);await page.goto('/');await page.getByRole('button',{name:'Dự án',exact:true}).click();
 await page.locator('.project-card',{hasText:'Thanh trạng thái'}).getByRole('button',{name:'Mở dự án',exact:true}).click();
 await expect(page.getByRole('textbox',{name:'Nội dung đoạn 1'})).toBeVisible();
};
const bar=(page:Page)=>page.locator('.status-bar');
const drawer=(page:Page)=>page.getByRole('complementary',{name:'Hàng đợi'});
const box=async(page:Page,selector:string)=>(await page.locator(selector).boundingBox())!;

test('the running job is shown as one text plus a bar; with nothing running it says "Sẵn sàng"',async({page})=>{
 await open(page);
 await expect(bar(page)).toHaveText('Đang xuất audio Chương 1 40%');await expect(bar(page).locator('progress')).toHaveJSProperty('value',0.4);
 await expect(bar(page).locator('progress'),'the bar repeats the text, so it is hidden from assistive tech').toHaveAttribute('aria-hidden','true');
});
test('with nothing running the bar says "Sẵn sàng" and has no progress bar',async({page})=>{
 await open(page,false);
 await expect(bar(page)).toHaveText('Sẵn sàng');await expect(bar(page).locator('progress')).toHaveCount(0);
});

test('a click on the bar opens the queue drawer beside the page',async({page})=>{
 await open(page);
 await expect(drawer(page)).toBeHidden();
 await bar(page).click();
 await expect(drawer(page)).toBeVisible();await expect(drawer(page)).toBeFocused();await expect(page.locator('main h1')).toContainText('Tạo giọng đọc');
 await expect(bar(page)).toHaveAttribute('aria-expanded','true');await expect(bar(page)).toBeVisible();
});

test('at 1024 px a click on the bar opens the overlay drawer and the bar stays under it, not over it',async({page})=>{
 await page.setViewportSize({width:1024,height:720});await open(page);
 await bar(page).click();await expect(drawer(page)).toBeFocused();
 const d=await box(page,'#queue-drawer'),b=await box(page,'.status-bar');
 expect(d.y+d.height,'the drawer ends where the bar starts').toBeLessThanOrEqual(b.y+1);
 await page.getByRole('textbox',{name:'Nội dung đoạn 1'}).focus();await expect(drawer(page)).toBeHidden();
});

test('the bar is not a live region: no aria-live, no status or alert role, and its text changing announces nothing',async({page})=>{
 await open(page);
 expect(await bar(page).evaluate(el=>[el,...el.querySelectorAll('*')].filter(e=>e.hasAttribute('aria-live')||['status','alert','log','timer'].includes(e.getAttribute('role')??'')).length)).toBe(0);
 expect(await bar(page).evaluate(el=>el.closest('[aria-live],[role=status],[role=alert]')===null)).toBe(true);
});

for(const [width,height] of [[1024,720],[1280,720],[1440,900]]){
 test(`at ${width}x${height} the bar covers neither the audio dock nor the drawer's last control, and the page has no horizontal scroll`,async({page})=>{
  await page.setViewportSize({width,height});await open(page);
  const b=await box(page,'.status-bar'),dock=await box(page,'#audio-dock');
  expect(b.y+b.height,'the bar sits on the bottom edge').toBeCloseTo(height,0);
  expect(dock.y+dock.height,'the sticky dock rests above the bar').toBeLessThanOrEqual(b.y+1);
  await bar(page).click();await expect(drawer(page)).toBeVisible();
  const last=await drawer(page).getByRole('button').last().boundingBox();expect(last!.y+last!.height,"the drawer's last control ends above the bar").toBeLessThanOrEqual(b.y+1);
  const d=await box(page,'#queue-drawer');expect(d.y+d.height,'the drawer column ends above the bar').toBeLessThanOrEqual(b.y+1);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth)).toBe(true);
 });
}
