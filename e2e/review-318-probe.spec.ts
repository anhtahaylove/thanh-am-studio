import {test,expect,type Page} from '@playwright/test';
import {readFileSync} from 'node:fs';
// Review probe for PR 318 (never merged): where focus goes after a dialog opened from inside the "Tùy chọn" panel closes, and the open panel at middle widths.
const PROJECT=JSON.parse(readFileSync('e2e/fixtures/script-12.json','utf8'));
const mock=(o:{project:string}):void=>{
 const w=window as any;w.isTauri=true;w.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};
 const project:any=JSON.parse(o.project),ipc=(v:unknown)=>JSON.parse(JSON.stringify(v));
 w.__TAURI_INTERNALS__={convertFileSrc:(p:string)=>p,transformCallback:()=>1,unregisterCallback:()=>{},metadata:{currentWindow:{label:'main'},currentWebview:{label:'main',windowLabel:'main'}},
  invoke:async(cmd:string,args:any)=>{switch(cmd){
   case 'list_projects':return [{id:project.id,name:project.name,updated_at:project.updated_at,revision:project.revision}];case 'load_project':return ipc(project);
   case 'list_voices':case 'list_jobs':return [];
   case 'list_models':return [{id:'vieneu-v3',name:'VieNeu v3 Turbo',engine:'tts',kind:'model',installed:true,revision:'r',license:'Apache-2.0',description:''},{id:'whisper-small',name:'Whisper Small',engine:'stt',kind:'model',installed:true,revision:'r',license:'MIT',description:''}];
   case 'get_settings':return {dictionary:{}};
   case 'runtime_status':return {python_ready:true,ffmpeg_ready:true,worker_ready:true,native_worker_ready:true,python_path:null,ffmpeg_path:null,native_worker_path:null,fallback_count:0,message:''};
   case 'save_project':return {...ipc(args.project),revision:args.project.revision+1};
   default:return null;}}};
};
const open=async(page:Page,width=1440)=>{
 await page.setViewportSize({width,height:960});
 await page.addInitScript(mock,{project:JSON.stringify(PROJECT)});await page.goto('/');
 await page.getByRole('button',{name:'Dự án',exact:true}).click();await page.getByRole('button',{name:'Mở dự án',exact:true}).click();
 await expect(page.getByRole('textbox',{name:'Nội dung đoạn 12'})).toBeAttached();
};
const options=(page:Page)=>page.locator('.hero-actions').getByRole('button',{name:'Tùy chọn',exact:true});
const focused=(page:Page)=>page.evaluate(()=>{const a=document.activeElement as HTMLElement|null;return a?`${a.tagName} "${(a.getAttribute('aria-label')??a.textContent??'').trim().slice(0,40)}" shown=${a===document.body||a.getClientRects().length>0}`:'none';});

test('probe A: Ctrl+K from an option in the panel, then Escape: focus lands on a shown control, not on the body',async({page})=>{
 await open(page);
 await options(page).click();await page.getByRole('checkbox',{name:'Đọc từ tiếng Anh'}).focus();
 await page.keyboard.press('Control+k');const palette=page.getByRole('dialog',{name:'Bảng lệnh'});await expect(palette).toBeVisible();
 console.log('probe A panel while the palette is open: aria-expanded='+await options(page).getAttribute('aria-expanded'));
 await page.keyboard.press('Escape');await expect(palette).toHaveCount(0);await page.waitForTimeout(300);
 const at=await focused(page);console.log('probe A focus after Escape: '+at);
 expect(at).not.toMatch(/^BODY/);expect(at).toMatch(/shown=true$/);
});
test('probe B: "?" on the focus-mode option, then Escape: focus lands on a shown control, not on the body',async({page})=>{
 await open(page);
 await options(page).click();await page.getByRole('button',{name:'Chế độ tập trung',exact:true}).focus();
 await page.keyboard.press('?');const sheet=page.getByRole('dialog',{name:'Phím tắt'});await expect(sheet).toBeVisible();
 await page.keyboard.press('Escape');await expect(sheet).toHaveCount(0);await page.waitForTimeout(300);
 const at=await focused(page);console.log('probe B focus after Escape: '+at);
 expect(at).not.toMatch(/^BODY/);expect(at).toMatch(/shown=true$/);
});
for(const width of [641,800,1024])test(`probe C: the open panel stays inside the window with no sideways scroll at ${width} px`,async({page})=>{
 await open(page,width);await options(page).click();
 const box=(await page.locator('.menu-panel').boundingBox())!;console.log(`probe C ${width}: x=${box.x} w=${box.width}`);
 expect(box.x).toBeGreaterThanOrEqual(0);expect(box.x+box.width).toBeLessThanOrEqual(width);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
});
