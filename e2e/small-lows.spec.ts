import {test,expect,type Page} from '@playwright/test';
// Three small lows: the reason bubble sits above the Undo toast, a take file the browser cannot decode says so in Vietnamese (a failed read keeps its old text),
// and an identical error shown again is a new alert element, which a screen reader reads again. Tauri is mocked; a take path ending in bad.wav is not audio.
const mock=(o:{path:string})=>{
 const w=window as any;w.isTauri=true;w.__saves=0;w.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};
 const take={id:'t1',asset_id:'a1',path:o.path,duration_ms:1000,sample_rate:8000,created_at:'2026-01-01T00:00:00Z'};
 const project={id:'p1',name:'Có take',updated_at:'2026-01-01T00:00:00Z',revision:1,segments:[{id:'s1',text:'Câu một.',normalized_text:'Câu một.',voice_id:null,speaker:'',gap_ms:0,takes:[take],selected_take_id:'t1',trim_start_ms:0,trim_end_ms:null,fade_in_ms:0,fade_out_ms:0,gain_db:0}],transcript:[],dictionary:{},source_asset_id:null};
 w.__TAURI_INTERNALS__={convertFileSrc:(p:string)=>p,transformCallback:()=>1,unregisterCallback:()=>{},metadata:{currentWindow:{label:'main'},currentWebview:{label:'main',windowLabel:'main'}},
  invoke:async(cmd:string,args:any)=>{switch(cmd){
   case 'list_projects':return [{id:project.id,name:project.name,updated_at:project.updated_at,revision:project.revision}];case 'load_project':return JSON.parse(JSON.stringify(project));
   case 'list_voices':case 'list_models':case 'list_jobs':return [];case 'get_settings':return {dictionary:{}};
   case 'runtime_status':return {python_ready:true,ffmpeg_ready:true,worker_ready:true,python_path:null,ffmpeg_path:null,message:''};
   case 'save_project':w.__saves++;throw 'DISK_FULL: no space left';
   default:return null;}}};
};
const open=async(page:Page,path:string)=>{
 await page.route('**/bad.wav',r=>r.fulfill({body:'this is not audio',contentType:'audio/wav'}));await page.route('**/gone.wav',r=>r.fulfill({status:404,body:''}));
 await page.addInitScript(mock,{path});await page.goto('/');
 await page.getByRole('button',{name:'Dự án',exact:true}).click();await page.getByRole('button',{name:'Mở dự án',exact:true}).click();
 await expect(page.getByRole('textbox',{name:'Nội dung đoạn 1',exact:true})).toBeVisible();
};

test('a toast never covers the reason bubble',async({page})=>{
 await page.goto('/');await page.getByRole('button',{name:'Thêm nội dung',exact:true}).click();await page.getByRole('textbox',{name:'Nội dung cần thêm'}).fill('Câu một.\nCâu hai.');await page.getByRole('button',{name:/^Thêm \d+ đoạn vào kịch bản$/}).click();
 await page.getByRole('button',{name:'Xóa đoạn',exact:true}).first().click();const toast=page.locator('.toast');await expect(toast).toBeVisible();
 const exportAudio=page.getByRole('button',{name:'Xuất audio',exact:true});await exportAudio.focus();const bubble=page.locator('.reason-bubble');await expect(bubble).toHaveText('Cần bản desktop để xuất audio');
 // Lay the toast over the bubble's centre, then ask which of the two is on top there (the bubble lets clicks through, so it is hit-testable only for this check).
 const topmost=await page.evaluate(()=>{
  const b=document.querySelector<HTMLElement>('.reason-bubble')!,t=document.querySelector<HTMLElement>('.toast')!,r=b.getBoundingClientRect();
  t.style.cssText+=`;right:auto;bottom:auto;left:${r.left-10}px;top:${r.top-10}px;width:${Math.max(r.width+20,300)}px;min-height:${r.height+20}px`;
  b.style.pointerEvents='auto';const hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);b.style.pointerEvents='';return hit===b;
 });
 expect(topmost,'the bubble is the topmost element at its own centre').toBe(true);
});

test('a take file that cannot be decoded says so in Vietnamese',async({page})=>{
 await open(page,'/bad.wav');await page.locator('.play-button').click();
 await expect(page.locator('.alert.error')).toContainText('Không đọc được audio của take này: tệp có thể bị hỏng hoặc chưa ghi xong. Hãy tạo take mới.');
});

test('a take file that cannot be fetched keeps its own text',async({page})=>{
 await open(page,'/gone.wav');await page.locator('.play-button').click();
 await expect(page.locator('.alert.error')).toContainText('Đọc audio không thành công');
});

test('the same autosave failure twice is a new alert element each time',async({page})=>{
 await open(page,'/gone.wav');const text=page.getByRole('textbox',{name:'Nội dung đoạn 1',exact:true}),alert=page.locator('.alert.error');
 const saves=()=>page.evaluate(()=>(window as any).__saves as number);
 await text.fill('Câu một, sửa lần một.');await expect.poll(saves).toBe(1);await expect(alert).toContainText('DISK_FULL: no space left');
 await alert.evaluate(el=>el.setAttribute('data-first','1'));
 await text.fill('Câu một, sửa lần hai.');await expect.poll(saves).toBe(2);
 await expect(alert,'the second identical failure replaced the alert element').not.toHaveAttribute('data-first','1');await expect(alert).toContainText('DISK_FULL: no space left');
});
