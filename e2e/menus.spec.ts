import {test,expect,type Page} from '@playwright/test';
import {readFileSync} from 'node:fs';
// Round 1.0.26 C1 (PLAN §6), and C3's tests of the kind-`menu` contract through the segment menu (from "Kind menu" on): the TTS hero shows two controls, "Tùy chọn" and "Tạo giọng tất cả". "Tùy chọn" is a disclosure button (aria-expanded, aria-controls, no menu roles,
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

test('a click inside the palette opened from an option keeps the panel, and Escape gives focus back to the option',async({page})=>{
 await open(page);await options(page).click();
 await english(page).focus();await page.keyboard.press('Control+k');
 const palette=page.getByRole('dialog',{name:'Bảng lệnh'});await expect(palette).toBeVisible();
 await palette.getByRole('combobox').click();
 await page.keyboard.press('Escape');await expect(palette).toHaveCount(0);await expect(english(page)).toBeFocused();
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
 const box=(await page.locator('.hero-actions .menu-panel').boundingBox())!;
 expect(box.x,'left edge').toBeGreaterThanOrEqual(0);expect(box.x+box.width,'right edge').toBeLessThanOrEqual(width);
});

// Kind `menu` (C3 is its first consumer): the menu button of a segment holds the five items "Chia đoạn tại con trỏ", "Chèn khoảng nghỉ 0,5 giây tại con trỏ", "Gộp với đoạn sau", "Đưa đoạn lên" and "Đưa đoạn xuống".
const NAMES=['Chia đoạn tại con trỏ','Chèn khoảng nghỉ 0,5 giây tại con trỏ','Gộp với đoạn sau','Đưa đoạn lên','Đưa đoạn xuống'];
const row=(page:Page,n:number)=>page.locator('.segment').nth(n-1);
const more=(page:Page,n:number)=>row(page,n).getByRole('button',{name:`Thao tác khác cho đoạn ${n}`,exact:true});
const item=(page:Page,n:number,name:string)=>row(page,n).getByRole('menuitem',{name,exact:true});
const area=(page:Page,n:number)=>page.getByRole('textbox',{name:`Nội dung đoạn ${n}`,exact:true});
const expanded=(page:Page,n:number,v:'true'|'false')=>expect(more(page,n)).toHaveAttribute('aria-expanded',v);

test('menu: an aria-disabled item keeps the menu open and focus where it is, by click, Enter and Space',async({page})=>{
 await open(page);
 await more(page,12).click();await expanded(page,12,'true');
 const merge=item(page,12,'Gộp với đoạn sau');await expect(merge).toHaveAttribute('aria-disabled','true');await expect(merge).toHaveAccessibleDescription('Không có đoạn sau để gộp');
 await merge.focus();await merge.click({force:true});await page.keyboard.press('Enter');await page.keyboard.press('Space');
 await expanded(page,12,'true');await expect(merge).toBeFocused();await expect(page.locator('.segment')).toHaveCount(12);
 await page.keyboard.press('Escape');await expanded(page,12,'false');await expect(more(page,12)).toBeFocused(); // Escape still closes it
});

test('menu: focus goes back to the button only when it was still inside the menu',async({page})=>{
 await open(page);
 // Inside the menu, then a click on a spot that takes no focus: the focus would be lost, so it returns to the button.
 await more(page,6).click();await expect(item(page,6,NAMES[0])).toBeFocused();await page.locator('main h1').click();
 await expanded(page,6,'false');await expect(more(page,6)).toBeFocused();
 // A click on another field closes the menu and keeps the focus where the click put it.
 await more(page,6).click();await area(page,9).click();
 await expanded(page,6,'false');await expect(area(page,9)).toBeFocused();
 // An item that moves focus on purpose keeps it: the pause item puts the caret back in the text.
 await area(page,6).click();await more(page,6).click();await item(page,6,NAMES[1]).click();
 await expanded(page,6,'false');await expect(area(page,6)).toBeFocused();await expect(area(page,6)).toHaveValue(/\[nghỉ 0\.5s\]/);
});

test('menu: the items are not tab stops; Tab leaves and closes the menu, and so does Shift+Tab, which lands on the button',async({page})=>{
 await open(page);
 await more(page,6).focus();await page.keyboard.press('Enter');await expect(row(page,6).getByRole('menuitem')).toHaveCount(5);
 expect(await row(page,6).getByRole('menuitem').evaluateAll(l=>l.map(i=>(i as HTMLElement).tabIndex))).toEqual([-1,-1,-1,-1,-1]);
 await page.keyboard.press('Tab');
 await expanded(page,6,'false');expect(await page.evaluate(()=>!!document.activeElement?.closest('.menu-panel')),'focus is outside the menu').toBe(false);await expect(area(page,6)).toBeFocused(); // the next stop after the toolbar
 await more(page,6).focus();await page.keyboard.press('Enter');await expect(item(page,6,NAMES[0])).toBeFocused();
 await page.keyboard.press('ArrowDown');await page.keyboard.press('ArrowDown');await page.keyboard.press('Shift+Tab'); // from the third item, not only from the first
 await expanded(page,6,'false');await expect(more(page,6)).toBeFocused();
});

test('menu: the items exist only while it is open, and aria-controls always names the panel',async({page})=>{
 await open(page);
 const id=await more(page,6).getAttribute('aria-controls');expect(id).toBeTruthy();
 const panel=page.locator(`[id="${id}"]`);
 await expect(panel).toHaveCount(1);await expect(panel).toBeHidden();await expect(panel).toHaveAttribute('role','menu');await expect(panel).toHaveAttribute('aria-label','Thao tác khác cho đoạn 6');
 expect(await panel.evaluate(p=>p.childElementCount),'a closed menu holds nothing').toBe(0);await expect(page.getByRole('menuitem')).toHaveCount(0);
 await more(page,6).click();
 await expect(panel).toBeVisible();expect(await panel.evaluate(p=>p.childElementCount)).toBe(5);
 expect(await row(page,6).getByRole('menuitem').evaluateAll(l=>l.map(i=>i.textContent))).toEqual(NAMES);
 await page.keyboard.press('Escape');
 await expect(panel).toHaveCount(1);await expect(panel).toBeHidden();expect(await panel.evaluate(p=>p.childElementCount)).toBe(0);
});

test('menu: ArrowDown opens on the first item and ArrowUp on the last; Home, End and the arrows move inside; the focus ring is drawn',async({page})=>{
 await open(page);
 await more(page,6).focus();await page.keyboard.press('ArrowUp');
 await expanded(page,6,'true');await expect(item(page,6,NAMES[4])).toBeFocused();
 expect(await item(page,6,NAMES[4]).evaluate(e=>getComputedStyle(e).outlineStyle),'focus ring on an item').toBe('solid');
 await page.keyboard.press('Home');await expect(item(page,6,NAMES[0])).toBeFocused();
 await page.keyboard.press('End');await expect(item(page,6,NAMES[4])).toBeFocused();
 await page.keyboard.press('ArrowDown');await expect(item(page,6,NAMES[0])).toBeFocused();
 await page.keyboard.press('ArrowUp');await expect(item(page,6,NAMES[4])).toBeFocused();
 await page.keyboard.press('ArrowUp');await expect(item(page,6,NAMES[3])).toBeFocused();
 await page.keyboard.press('Escape');await expanded(page,6,'false');await expect(more(page,6)).toBeFocused();
 await page.keyboard.press('ArrowDown');await expanded(page,6,'true');await expect(item(page,6,NAMES[0])).toBeFocused();
});

test('menu: Home and End on the closed button open nothing; the toolbar around it moves along its buttons',async({page})=>{
 await open(page);
 await more(page,6).focus();await page.keyboard.press('Home');
 await expect(row(page,6).getByRole('button',{name:'Tạo take mới',exact:true})).toBeFocused();await expanded(page,6,'false');
 await page.keyboard.press('End');await expect(more(page,6)).toBeFocused();await expanded(page,6,'false');
 await expect(page.getByRole('menuitem')).toHaveCount(0);
});

// Every item that changes or moves the row leaves focus on something sensible, never <body>: the button of the row the item ends in (a row that moves keeps its focus too), the text for the pause mark.
const AFTER:[string,(n:number)=>string,number][]=[ // [item, the button that holds focus afterwards, segments afterwards]
 [NAMES[0],n=>`Thao tác khác cho đoạn ${n}`,13],[NAMES[2],n=>`Thao tác khác cho đoạn ${n}`,11],[NAMES[3],n=>`Thao tác khác cho đoạn ${n-1}`,12],[NAMES[4],n=>`Thao tác khác cho đoạn ${n+1}`,12]];
for(const [name,button,count] of AFTER)test(`menu: after "${name}" the menu is closed and focus is on the button of the row, not on the page`,async({page})=>{
 await open(page);
 await area(page,5).click();await page.keyboard.press('Control+Home');for(let i=0;i<10;i++)await page.keyboard.press('ArrowRight'); // the caret is inside the text, for the split
 await more(page,5).click();await item(page,5,name).click();
 await expect(page.locator('.segment')).toHaveCount(count);
 await expect(page.getByRole('menuitem')).toHaveCount(0);
 await expect(page.getByRole('button',{name:button(5),exact:true})).toBeFocused();
 expect(await page.evaluate(()=>document.activeElement===document.body)).toBe(false);
});
test('menu: after "Chèn khoảng nghỉ 0,5 giây tại con trỏ" the menu is closed and the caret is in the text, after the mark',async({page})=>{
 await open(page);
 await area(page,5).click();await page.keyboard.press('Control+Home');for(let i=0;i<10;i++)await page.keyboard.press('ArrowRight');
 await more(page,5).click();await item(page,5,NAMES[1]).click();
 await expect(page.getByRole('menuitem')).toHaveCount(0);await expect(area(page,5)).toBeFocused();
 await page.keyboard.type('X');await expect(area(page,5)).toHaveValue(/\[nghỉ 0\.5s\] ?X/);
});
