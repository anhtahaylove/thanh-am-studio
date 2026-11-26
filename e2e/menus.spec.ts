import {test,expect,type Page} from '@playwright/test';
import {readFileSync} from 'node:fs';
// Round 1.0.26 C1 (PLAN §6): the TTS hero shows two controls, "Tùy chọn" and "Tạo giọng tất cả". "Tùy chọn" is a disclosure button (aria-expanded, aria-controls, no menu roles,
// because its items are native checkboxes and a pressed toggle) holding "Chế độ tập trung", "Đọc từ tiếng Anh" and "Tự kiểm bằng Whisper". Tauri is mocked with the 12-segment fixture.
const PROJECT=JSON.parse(readFileSync('e2e/fixtures/script-12.json','utf8'));
const mock=(o:{project:string;whisper:boolean}):void=>{
 const w=window as any;w.isTauri=true;w.__clicks=0;w.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};
 addEventListener('click',e=>{if(e.isTrusted&&(e as MouseEvent).detail>0)w.__clicks++;},true); // a trusted mouse click; Enter and Space on a button have detail 0
 const project:any=JSON.parse(o.project),ipc=(v:unknown)=>JSON.parse(JSON.stringify(v));
 w.__TAURI_INTERNALS__={convertFileSrc:(p:string)=>p,transformCallback:()=>1,unregisterCallback:()=>{},metadata:{currentWindow:{label:'main'},currentWebview:{label:'main',windowLabel:'main'}},
  invoke:async(cmd:string,args:any)=>{switch(cmd){
   case 'list_projects':return [{id:project.id,name:project.name,updated_at:project.updated_at,revision:project.revision}];case 'load_project':return ipc(project);
   case 'list_voices':case 'list_jobs':return [];
   case 'list_models':return [{id:'vieneu-v3',name:'VieNeu v3 Turbo',engine:'tts',kind:'model',installed:true,revision:'r',license:'Apache-2.0',description:''},{id:'whisper-small',name:'Whisper Small',engine:'stt',kind:'model',installed:o.whisper,revision:'r',license:'MIT',description:''}];
   case 'get_settings':return {dictionary:{}};
   case 'runtime_status':return {python_ready:true,ffmpeg_ready:true,worker_ready:true,native_worker_ready:true,python_path:null,ffmpeg_path:null,native_worker_path:null,fallback_count:0,message:''};
   case 'save_project':return {...ipc(args.project),revision:args.project.revision+1};
   default:return null;}}};
};
const open=async(page:Page,d:{whisper?:boolean;reduce?:boolean;width?:number}={})=>{
 await page.setViewportSize({width:d.width??1440,height:960});
 if(d.reduce)await page.emulateMedia({reducedMotion:'reduce'});
 await page.addInitScript(mock,{project:JSON.stringify(PROJECT),whisper:d.whisper??true});await page.goto('/');
 await page.getByRole('button',{name:'Dự án',exact:true}).click();await page.getByRole('button',{name:'Mở dự án',exact:true}).click();
 await expect(page.getByRole('textbox',{name:'Nội dung đoạn 12'})).toBeAttached();
 await page.evaluate(()=>{(window as any).__clicks=0;}); // the scenario starts here, not at the setup clicks
};
const hero=(page:Page)=>page.locator('.hero-actions');
const options=(page:Page)=>hero(page).getByRole('button',{name:'Tùy chọn',exact:true});
const focusMode=(page:Page)=>page.getByRole('button',{name:'Chế độ tập trung',exact:true});
const english=(page:Page)=>page.getByRole('checkbox',{name:'Đọc từ tiếng Anh'});
const whisper=(page:Page)=>page.getByRole('checkbox',{name:'Tự kiểm bằng Whisper'});
const clicks=(page:Page)=>page.evaluate(()=>(window as any).__clicks as number);
const stored=(page:Page,key:string)=>page.evaluate(k=>localStorage.getItem(k),key);

test('hero has two controls; each option in 2 clicks, state kept; Escape returns focus',async({page})=>{
 await open(page);
 await expect(hero(page).locator('button:visible,input:visible'),'two visible controls, no checkbox').toHaveCount(2);
 await expect(options(page)).toHaveAttribute('aria-expanded','false');await expect(hero(page).getByRole('button',{name:'Tạo giọng tất cả'})).toBeVisible();
 for(const hidden of [focusMode(page),english(page),whisper(page)])await expect(hidden,'a closed panel leaves its options out of the page').toHaveCount(0);
 // A disclosure, not a menu: aria-controls names the panel and nothing carries a menu role or aria-haspopup.
 await options(page).click();await expect(options(page)).toHaveAttribute('aria-expanded','true');
 const panel=page.locator(`[id="${await options(page).getAttribute('aria-controls')}"]`);
 await expect(panel).toBeVisible();await expect(panel.getByRole('button',{name:'Chế độ tập trung'})).toBeVisible();await expect(panel.getByRole('checkbox')).toHaveCount(2);
 await expect(hero(page).locator('[role=menu],[role=menuitem],[aria-haspopup]')).toHaveCount(0);
 // Each option costs the opening click plus one: 2 clicks in all.
 await focusMode(page).click();expect(await clicks(page)).toBe(2);
 await expect(focusMode(page)).toHaveAttribute('aria-pressed','true');await expect(page.locator('.studio-grid')).toHaveClass(/focus-mode/);
 await english(page).check();await whisper(page).check();
 expect(await stored(page,'thanh-am-codeswitch')).toBe('1');expect(await stored(page,'thanh-am-check')).toBe('1');expect(await stored(page,'thanh-am-focus')).toBe('1');
 await expect(options(page),'choosing an option leaves the panel open').toHaveAttribute('aria-expanded','true');
 // Escape closes it and returns focus to the button; the choices are kept when it opens again.
 await whisper(page).focus();await page.keyboard.press('Escape');
 await expect(options(page)).toBeFocused();await expect(options(page)).toHaveAttribute('aria-expanded','false');await expect(english(page)).toHaveCount(0);
 await options(page).click();
 await expect(focusMode(page)).toHaveAttribute('aria-pressed','true');await expect(english(page)).toBeChecked();await expect(whisper(page)).toBeChecked();
 // A click outside closes it too, and focus that was in the panel goes back to the button instead of to nothing.
 await english(page).focus();await page.locator('main h1').click();
 await expect(options(page)).toHaveAttribute('aria-expanded','false');await expect(options(page)).toBeFocused();
});

test('keyboard: Enter opens, Tab walks the three options and the next Tab closes the panel on Tạo giọng tất cả',async({page})=>{
 await open(page);
 await options(page).focus();await page.keyboard.press('Enter');await expect(options(page)).toHaveAttribute('aria-expanded','true');await expect(options(page)).toBeFocused();
 await page.keyboard.press('Tab');await expect(focusMode(page)).toBeFocused();
 await page.keyboard.press('Tab');await expect(english(page)).toBeFocused();
 await page.keyboard.press('Space');await expect(english(page)).toBeChecked();
 await page.keyboard.press('Tab');await expect(whisper(page)).toBeFocused();
 await page.keyboard.press('Tab');await expect(hero(page).getByRole('button',{name:'Tạo giọng tất cả'})).toBeFocused();
 await expect(options(page)).toHaveAttribute('aria-expanded','false');
 expect(await clicks(page),'no mouse click was needed').toBe(0);
});

test('titles and disabled states move with the options: Whisper needs its model, Ctrl+Shift+F still toggles focus mode',async({page})=>{
 await open(page,{whisper:false});
 await options(page).click();
 await expect(focusMode(page)).toHaveAttribute('title','Chế độ tập trung (Ctrl+Shift+F)');
 await expect(page.locator('label.check',{has:english(page)})).toHaveAttribute('title',/^Từ tiếng Anh xen trong câu/);
 await expect(whisper(page)).toBeDisabled();await expect(page.locator('label.check',{has:whisper(page)})).toHaveAttribute('title','Tải Whisper Small trong Model & cài đặt để bật');
 await page.keyboard.press('Control+Shift+F');await expect(focusMode(page)).toHaveAttribute('aria-pressed','true');
 await page.keyboard.press('Escape');await page.keyboard.press('Control+Shift+F'); // closed: the shortcut still works and the option shows it when the panel opens again
 await options(page).click();await expect(focusMode(page)).toHaveAttribute('aria-pressed','false');
});

test('Ctrl+K from an option opens the palette and Escape gives focus back to the option',async({page})=>{
 await open(page);await options(page).click();
 await english(page).focus();await page.keyboard.press('Control+k');
 const palette=page.getByRole('dialog',{name:'Bảng lệnh'});await expect(palette).toBeVisible();
 await page.keyboard.press('Escape');await expect(palette).toHaveCount(0);await expect(english(page)).toBeFocused();
});

test('"?" from an option opens the shortcut sheet and Escape gives focus back to the option',async({page})=>{
 await open(page);await options(page).click();
 await focusMode(page).focus();await page.keyboard.press('?');
 const sheet=page.getByRole('dialog',{name:'Phím tắt'});await expect(sheet).toBeVisible();
 await page.keyboard.press('Escape');await expect(sheet).toHaveCount(0);await expect(focusMode(page)).toBeFocused();
});

test('with reduced motion the panel animates nothing, and the focus ring is drawn on an option',async({page})=>{
 await open(page,{reduce:true});
 await options(page).click();
 const motion=await page.evaluate(()=>{const c=getComputedStyle(document.querySelector('.menu-panel')!);return [c.transitionDuration,c.animationName] as const;});
 expect(motion[0].split(',').every(d=>parseFloat(d)===0),`transition ${motion[0]}`).toBe(true);expect(motion[1]).toBe('none');
 await page.keyboard.press('Tab');await expect(focusMode(page)).toBeFocused();
 expect(await focusMode(page).evaluate(e=>getComputedStyle(e).outlineStyle),'focus ring on an option').toBe('solid');
});

for(const width of [456,1440])test(`the panel stays inside the window at ${width} px`,async({page})=>{
 await open(page,{width});await options(page).click();
 const box=(await page.locator('.menu-panel').boundingBox())!;
 expect(box.x,'left edge').toBeGreaterThanOrEqual(0);expect(box.x+box.width,'right edge').toBeLessThanOrEqual(width);
});
