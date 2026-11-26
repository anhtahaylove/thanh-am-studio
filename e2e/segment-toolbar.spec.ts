import {test,expect,type Page} from '@playwright/test';
import {readFileSync} from 'node:fs';
// Each segment's actions are one toolbar with a single tab stop and arrow keys; the shortcuts act only in the segment's textarea or toolbar; a move that is out of bounds
// and a generate that is blocked do nothing, however they are activated; a skip link leads to the export dock. Tauri is mocked; the script is the 12-segment fixture.
const FIXTURE:string=readFileSync('e2e/fixtures/script-12.json','utf8');
const mock=(o:{project:string;installed:boolean}):void=>{
 const w=window as any;w.isTauri=true;w.__calls=[];w.__kd=[];w.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}}; // the event API's cleanup, so a page error means a real one
 const project:any=JSON.parse(o.project);
 const ipc=(v:unknown)=>JSON.parse(JSON.stringify(v));
 w.__TAURI_INTERNALS__={convertFileSrc:(p:string)=>p,transformCallback:()=>1,unregisterCallback:()=>{},metadata:{currentWindow:{label:'main'},currentWebview:{label:'main',windowLabel:'main'}},
  invoke:async(cmd:string,args:any)=>{w.__calls.push(cmd);switch(cmd){
   case 'list_projects':return [{id:project.id,name:project.name,updated_at:project.updated_at,revision:project.revision}];case 'load_project':return ipc(project);
   case 'list_voices':return [];case 'list_models':return [{id:'vieneu-v3',name:'VieNeu v3 Turbo',engine:'tts',installed:o.installed,revision:'r',license:'Apache-2.0',description:''}];
   case 'list_jobs':return [];case 'get_settings':return {dictionary:{}};
   case 'runtime_status':return {python_ready:true,ffmpeg_ready:true,worker_ready:true,python_path:null,ffmpeg_path:null,message:''};
   case 'save_project':return {...ipc(args.project),revision:args.project.revision+1};
   default:return null;}}};
 // The keydown as it reaches the window, in the bubble phase: after the page's own handlers have run.
 window.addEventListener('keydown',e=>{if(e.altKey&&e.key==='ArrowDown')w.__kd.push(e.defaultPrevented);});
 // Every action the app runs shows the busy indicator for a moment, so counting it tells whether a button's handler ran.
 // What the live region receives: a node added to it is what a screen reader reads.
 w.__said=[];new MutationObserver(l=>{for(const m of l)for(const n of m.addedNodes)if(n instanceof HTMLElement&&n.parentElement?.matches('.sr-only[aria-live=polite]'))w.__said.push(n.textContent);}).observe(document,{childList:true,subtree:true});
 w.__busy=0;new MutationObserver(l=>{for(const m of l)for(const n of m.addedNodes)if(n instanceof HTMLElement&&n.classList.contains('busy-indicator'))w.__busy++;}).observe(document,{childList:true,subtree:true});
};
const open=async(page:Page,o:{width?:number;installed?:boolean;empty?:boolean}={})=>{
 const project=o.empty?JSON.stringify({...JSON.parse(FIXTURE),segments:[]}):FIXTURE;
 await page.setViewportSize({width:o.width??1440,height:900});await page.addInitScript(mock,{project,installed:o.installed??true});await page.goto('/');
 await page.getByRole('button',{name:'Dự án',exact:true}).click();await page.getByRole('button',{name:'Mở dự án',exact:true}).click();
 if(!o.empty)await expect(page.getByRole('textbox',{name:'Nội dung đoạn 12'})).toBeVisible();
};
const seg=(page:Page,n:number)=>page.locator('.segment').nth(n-1);
const toolbar=(page:Page,n:number)=>seg(page,n).getByRole('toolbar');
const more=(page:Page,n:number)=>seg(page,n).getByRole('button',{name:`Thao tác khác cho đoạn ${n}`,exact:true});
const item=(page:Page,n:number,name:string)=>seg(page,n).getByRole('menuitem',{name,exact:true});
const area=(page:Page,n:number)=>page.getByRole('textbox',{name:`Nội dung đoạn ${n}`,exact:true});
const texts=(page:Page)=>page.locator('.segment textarea').evaluateAll(l=>l.map(t=>(t as HTMLTextAreaElement).value));
const region=(page:Page)=>page.locator('.sr-only[aria-live=polite]');
const calls=(page:Page,name:string)=>page.evaluate(n=>((window as any).__calls as string[]).filter(c=>c===n).length,name);
const active=(page:Page)=>page.evaluate(()=>{const e=document.activeElement;return e?(e.getAttribute('aria-label')??e.tagName):'';});
const undo=(page:Page)=>page.getByRole('button',{name:'Hoàn tác (Ctrl+Z)'});
const settle=(page:Page)=>page.evaluate(()=>new Promise<void>(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r()))));
const ORIGINAL:string[]=JSON.parse(FIXTURE).segments.map((s:{text:string})=>s.text);

test('a segment that is not selected has three tab stops, in the order speaker, toolbar, text',async({page})=>{
 await open(page);
 const stops=await page.evaluate(()=>[...document.querySelectorAll('.segment')[5].querySelectorAll<HTMLElement>('a[href],button,input,select,textarea,[tabindex]')].filter(e=>e.tabIndex>=0&&!(e as HTMLButtonElement).disabled).map(e=>e.getAttribute('aria-label')??e.tagName));
 expect(stops).toEqual(['Nhân vật đoạn 6','Tạo take mới','Nội dung đoạn 6']); // the voice and speed selects are in the inspector now
 await page.getByRole('textbox',{name:'Nhân vật đoạn 6'}).focus();
 // Focusing the row selects it, which adds its emotion bar after the text; the count above is for a row that is not selected.
 for(const next of ['Tạo take mới','Nội dung đoạn 6']){await page.keyboard.press('Tab');expect(await active(page)).toBe(next);}
});

test('a segment with a checked take has four tab stops: speaker, the check, toolbar, text',async({page})=>{
 await open(page);
 for(const n of [2,9]){
  const stops=await page.evaluate(i=>[...document.querySelectorAll('.segment')[i-1].querySelectorAll<HTMLElement>('a[href],button,input,select,textarea,[tabindex]')].filter(e=>e.tabIndex>=0&&!(e as HTMLButtonElement).disabled).map(e=>e.getAttribute('aria-label')??e.textContent),n);
  expect(stops,`segment ${n}`).toEqual(['Nhân vật đoạn '+n,'Khớp kịch bản','Tạo take mới','Nội dung đoạn '+n]);
 }
});

test('the arrow keys, Home and End move inside the toolbar and wrap, and Tab comes back to the item that last had focus',async({page})=>{
 await open(page);
 await page.getByRole('textbox',{name:'Nhân vật đoạn 6'}).focus();await page.keyboard.press('Tab');
 expect(await active(page)).toBe('Tạo take mới');
 await page.keyboard.press('ArrowRight');expect(await active(page)).toBe('Chi tiết đoạn 6');
 await page.keyboard.press('End');expect(await active(page)).toBe('Thao tác khác cho đoạn 6');await page.keyboard.press('ArrowRight');expect(await active(page)).toBe('Tạo take mới');
 await page.keyboard.press('ArrowLeft');expect(await active(page)).toBe('Thao tác khác cho đoạn 6');await page.keyboard.press('ArrowLeft');expect(await active(page)).toBe('Xóa đoạn');await page.keyboard.press('Home');expect(await active(page)).toBe('Tạo take mới');
 await page.keyboard.press('ArrowRight');await page.keyboard.press('ArrowRight');expect(await active(page)).toBe('Xóa đoạn');
 await page.keyboard.press('Tab');expect(await active(page)).toBe('Nội dung đoạn 6');
 await page.keyboard.press('Shift+Tab');expect(await active(page)).toBe('Xóa đoạn');
 await expect(page.getByRole('menuitem')).toHaveCount(0); // the arrows and Home and End moved along the toolbar and opened no menu
});

test('a segment moved to the end still reaches its toolbar with Tab, and its blocked items say why',async({page})=>{
 await open(page);
 await area(page,6).focus();for(let i=0;i<6;i++){await page.keyboard.press('Alt+ArrowDown');await settle(page);}
 expect((await texts(page))[11]).toBe(ORIGINAL[5]);expect(await active(page)).toBe('Nội dung đoạn 12');
 await page.getByRole('textbox',{name:'Nhân vật đoạn 12'}).focus();await page.keyboard.press('Tab');
 expect(await toolbar(page,12).evaluate(t=>t.contains(document.activeElement))).toBe(true);
 await page.keyboard.press('End');await page.keyboard.press('Enter'); // the menu button is the last stop; Enter opens the menu on its first item
 await page.keyboard.press('ArrowDown');await page.keyboard.press('ArrowDown');
 await expect(page.locator(':focus')).toHaveAccessibleName('Gộp với đoạn sau');await expect(page.locator(':focus')).toHaveAccessibleDescription('Không có đoạn sau để gộp');
 await page.keyboard.press('ArrowDown');await page.keyboard.press('ArrowDown');
 await expect(page.locator(':focus')).toHaveAccessibleName('Đưa đoạn xuống');await expect(page.locator(':focus')).toHaveAccessibleDescription('Đây là đoạn cuối cùng');
 await expect(page.locator(':focus')).toHaveAttribute('aria-disabled','true');
});

test('moving the first segment up does nothing, by click, Enter, Space or Alt+Up: no change, no undo step, no error',async({page})=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await open(page);
 await more(page,1).click();
 const up=item(page,1,'Đưa đoạn lên');await expect(up).toHaveAttribute('aria-disabled','true');await expect(up).toHaveAccessibleDescription('Đây là đoạn đầu tiên');
 await up.click({force:true});await up.focus();await page.keyboard.press('Enter');await page.keyboard.press('Space');
 await area(page,1).focus();await page.keyboard.press('Alt+ArrowUp');await settle(page);
 expect(await texts(page)).toEqual(ORIGINAL);await expect(undo(page)).toBeDisabled();await expect(page.getByText(/Đoạn chuyển/)).toHaveCount(0);
 await expect(seg(page,1)).toBeVisible();expect(await page.locator('.segment').count()).toBe(12);expect(errors).toEqual([]);
});

test('moving the last segment down or merging it does nothing, by click, Enter, Space or Alt+Down',async({page})=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await open(page);
 await more(page,12).click();
 for(const name of ['Đưa đoạn xuống','Gộp với đoạn sau']){const b=item(page,12,name);await expect(b).toHaveAttribute('aria-disabled','true');await b.click({force:true});await b.focus();await page.keyboard.press('Enter');await page.keyboard.press('Space');}
 await area(page,12).focus();await page.keyboard.press('Alt+ArrowDown');await settle(page);
 expect(await texts(page)).toEqual(ORIGINAL);await expect(undo(page)).toBeDisabled();await expect(page.getByText(/Đoạn chuyển/)).toHaveCount(0);expect(errors).toEqual([]);
});

test('a blocked button runs no handler at all, while an enabled one does',async({page})=>{
 await open(page);await settle(page);await page.waitForTimeout(500);const busy=()=>page.evaluate(()=>(window as any).__busy as number),before=await busy(); // opening the project showed it too
 await more(page,12).click();const merge=item(page,12,'Gộp với đoạn sau');
 await merge.click({force:true});await merge.focus();await page.keyboard.press('Enter');await page.keyboard.press('Space');await settle(page);
 expect(await busy()).toBe(before);
 await more(page,11).click();await item(page,11,'Gộp với đoạn sau').click();await expect.poll(busy).toBeGreaterThan(before); // the control: an enabled button shows the indicator
});

test('with the voice model missing, Ctrl+Enter and the blocked generate button enqueue nothing',async({page})=>{
 await open(page,{installed:false});
 const gen=seg(page,3).getByRole('button',{name:'Tạo giọng',exact:true});await expect(gen).toHaveAttribute('aria-disabled','true');await expect(gen).toHaveAccessibleDescription(/^((?!VieNeu).)*VieNeu((?!VieNeu).)*$/s) // the model sentence once, not twice (the hidden reason is not read as well);
 await area(page,3).focus();await page.keyboard.press('Control+Enter');await gen.click({force:true});await gen.focus();await page.keyboard.press('Enter');await page.keyboard.press('Control+Enter');await settle(page);
 expect(await calls(page,'enqueue_job')).toBe(0);
});

test('"Chi tiết đoạn N" is never blocked: with the voice model missing it still leads to the panel',async({page})=>{
 await open(page,{installed:false});
 const b=seg(page,3).getByRole('button',{name:'Chi tiết đoạn 3',exact:true});await expect(b).not.toHaveAttribute('aria-disabled','true');await expect(b).toBeEnabled();
 await b.click();await expect(page.getByRole('combobox',{name:'Giọng đoạn 3'})).toBeFocused();
});

test('Ctrl+Enter generates this segment once, and Ctrl+Shift+Enter splits it at the caret',async({page})=>{
 await open(page);
 await area(page,3).focus();await page.keyboard.press('Control+Enter');await expect.poll(()=>calls(page,'enqueue_job')).toBe(1);await settle(page);expect(await calls(page,'enqueue_job')).toBe(1);
 await area(page,4).focus();await page.keyboard.press('Home');for(let i=0;i<12;i++)await page.keyboard.press('ArrowRight');
 await page.keyboard.press('Control+Shift+Enter');await expect(page.locator('.segment')).toHaveCount(13);
 const t=await texts(page);expect(t[3]).toBe(ORIGINAL[3].slice(0,12).trim());expect(t[4]).toBe(ORIGINAL[3].slice(12).trim());expect(await calls(page,'enqueue_job')).toBe(1);
});

test('Alt+Down in the textarea moves the segment and focus stays in it; from the toolbar too',async({page})=>{
 await open(page);
 await area(page,2).focus();await page.keyboard.press('Alt+ArrowDown');await settle(page);
 expect((await texts(page)).slice(0,3)).toEqual([ORIGINAL[0],ORIGINAL[2],ORIGINAL[1]]);expect(await active(page)).toBe('Nội dung đoạn 3');
 await seg(page,3).getByRole('button',{name:'Xóa đoạn'}).focus();await page.keyboard.press('Alt+ArrowUp');await settle(page);
 expect((await texts(page)).slice(0,3)).toEqual(ORIGINAL.slice(0,3));expect(await active(page)).toBe('Xóa đoạn');
 expect(await toolbar(page,2).evaluate(t=>t.contains(document.activeElement))).toBe(true);
});

test('a move is said through the live region that is already in the page, again for the same words, and shows no banner',async({page})=>{
 await open(page);const said=()=>page.evaluate(()=>(window as any).__said as string[]);
 await expect(region(page)).toHaveCount(1);await expect(region(page)).toBeEmpty();await expect(region(page)).toHaveAttribute('aria-live','polite');expect(await said()).toEqual([]);
 await area(page,2).focus();await page.keyboard.press('Alt+ArrowDown');await expect(region(page)).toHaveText('Đoạn chuyển xuống vị trí 3');
 await page.keyboard.press('Alt+ArrowUp');await expect(region(page)).toHaveText('Đoạn chuyển lên vị trí 2');
 await page.keyboard.press('Alt+ArrowDown'); // the same words as the first move, inside the 6 s the first one stays
 await expect.poll(said).toEqual(['Đoạn chuyển xuống vị trí 3','Đoạn chuyển lên vị trí 2','Đoạn chuyển xuống vị trí 3']);
 await more(page,3).click();await item(page,3,'Đưa đoạn xuống').click(); // a click on the item says it too
 await expect.poll(said).toHaveLength(4);
 await expect(page.locator('.alert.notice')).toHaveCount(0);
});

test('Alt+Down on the speaker input neither moves the segment nor is prevented',async({page})=>{
 await open(page);
 for(const name of ['Nhân vật đoạn 3']){
  await page.evaluate(()=>{(window as any).__kd=[];});
  await page.locator(`[aria-label="${name}"]`).focus();await page.keyboard.press('Alt+ArrowDown');await settle(page);
  expect(await texts(page),name).toEqual(ORIGINAL);expect(await page.evaluate(()=>(window as any).__kd),name).toEqual([false]);
 }
});

test('the shortcuts do nothing while an input method is composing',async({page})=>{
 await open(page);
 await area(page,3).focus();
 await page.evaluate(()=>{const t=document.activeElement!;for(const init of [{key:'ArrowDown',altKey:true},{key:'Enter',ctrlKey:true},{key:'Enter',ctrlKey:true,shiftKey:true}]){t.dispatchEvent(new KeyboardEvent('keydown',{...init,isComposing:true,bubbles:true,cancelable:true}));t.dispatchEvent(new KeyboardEvent('keydown',{...init,keyCode:229,bubbles:true,cancelable:true}));}});
 await settle(page);expect(await texts(page)).toEqual(ORIGINAL);expect(await calls(page,'enqueue_job')).toBe(0);await expect(page.locator('.segment')).toHaveCount(12);
});

test('the toolbar shows four buttons, and split and pause still act at the caret from the menu',async({page})=>{
 await open(page);
 const bar=toolbar(page,4);
 await expect(bar.getByRole('button')).toHaveCount(4);await expect(bar.getByRole('menuitem'),'the menu items are not in the page while the menu is closed').toHaveCount(0);
 expect(await bar.getByRole('button').evaluateAll(l=>l.map(b=>b.getAttribute('aria-label')))).toEqual(['Tạo giọng','Chi tiết đoạn 4','Xóa đoạn','Thao tác khác cho đoạn 4']);
 await expect(more(page,4)).toHaveAttribute('aria-haspopup','menu');await expect(more(page,4)).toHaveAttribute('aria-expanded','false');
 // The caret is set in the text, the focus goes to the menu button and then to an item: the cut is still where the caret was.
 await area(page,4).click();await page.keyboard.press('Home');for(let i=0;i<12;i++)await page.keyboard.press('ArrowRight');
 await more(page,4).click();await expect(bar.getByRole('menuitem')).toHaveCount(5);await item(page,4,'Chia đoạn tại con trỏ').click();
 await expect(page.locator('.segment')).toHaveCount(13);
 const t=await texts(page);expect(t[3]).toBe(ORIGINAL[3].slice(0,12).trim());expect(t[4]).toBe(ORIGINAL[3].slice(12).trim());
 // The same for a pause mark: 5 characters into segment 8 (now segment 9), and it needs no space of its own where the text already has one.
 const text=ORIGINAL[7],k=5,gap=(c?:string)=>/s/.test(c??'');
 await area(page,9).click();await page.keyboard.press('Home');for(let i=0;i<k;i++)await page.keyboard.press('ArrowRight');
 await more(page,9).click();await item(page,9,'Chèn khoảng nghỉ 0,5 giây tại con trỏ').click();
 await expect(area(page,9)).toHaveValue(text.slice(0,k)+(gap(text[k-1])?'':' ')+'[nghỉ 0.5s]'+(gap(text[k])?'':' ')+text.slice(k));
});

test('a segment menu is not clipped: every item of the last segment is on top, over the dock',async({page})=>{
 await open(page);
 await more(page,12).click();await page.keyboard.press('End');
 await expect(item(page,12,'Đưa đoạn xuống')).toBeFocused();
 const hits=await seg(page,12).getByRole('menuitem').evaluateAll(l=>l.map(i=>{const r=i.getBoundingClientRect(),top=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return {name:i.textContent,onTop:!!top&&i.contains(top),inside:r.top>=0&&r.bottom<=innerHeight};}));
 expect(hits).toHaveLength(5);for(const h of hits)expect(h,h.name??'').toEqual({name:h.name,onTop:true,inside:true});
});

for(const width of [456,1440])test(`a segment menu stays inside the window at ${width} px`,async({page})=>{
 await open(page,{width});await more(page,6).click();
 const box=(await seg(page,6).locator('.menu-panel').boundingBox())!;
 expect(box.x,'left edge').toBeGreaterThanOrEqual(0);expect(box.x+box.width,'right edge').toBeLessThanOrEqual(width);
});

test('the toolbar shows on hover, focus and for the selected segment, and hides by opacity only',async({page})=>{
 await open(page);await page.mouse.move(2,2);
 const opacity=(n:number)=>toolbar(page,n).evaluate(t=>getComputedStyle(t).opacity);
 await expect.poll(()=>opacity(6)).toBe('0');await expect.poll(()=>opacity(1)).toBe('1'); // the first segment is the selected one
 await expect(toolbar(page,6)).toBeAttached();expect(await toolbar(page,6).getByRole('button').count()).toBe(4);
 await page.getByRole('textbox',{name:'Nhân vật đoạn 6'}).focus();await page.keyboard.press('Tab');await expect.poll(()=>opacity(6)).toBe('1');
 await page.getByRole('textbox',{name:'Nhân vật đoạn 9'}).focus();await expect.poll(()=>opacity(6)).toBe('0');
 await seg(page,8).hover({position:{x:200,y:60}});await expect.poll(()=>opacity(8)).toBe('1');
});

test('the toolbar shows while focus is inside it, even where the focus ring is not shown',async({page})=>{
 await open(page);await page.mouse.move(2,2);
 await area(page,9).click(); // selects another segment, so segment 6 is neither selected nor hovered
 const opacity=()=>toolbar(page,6).evaluate(t=>getComputedStyle(t).opacity);
 await expect.poll(opacity).toBe('0');
 await toolbar(page,6).getByRole('button').nth(1).evaluate(b=>(b as HTMLElement).focus()); // from script: no :focus-visible, so the row is not selected
 await page.mouse.move(2,2); // focusing scrolled the page under the pointer, which must not count as a hover
 await expect.poll(opacity).toBe('1');
 expect(await seg(page,6).evaluate(e=>e.classList.contains('selected'))).toBe(false);
});

test.describe('on a touch screen',()=>{
 test.use({hasTouch:true,isMobile:true});
 test('the toolbar is always shown',async({page})=>{
  await open(page,{width:800});await page.mouse.move(2,2);
  expect(await page.evaluate(()=>matchMedia('(hover:none)').matches)).toBe(true);
  await expect.poll(()=>toolbar(page,6).evaluate(t=>getComputedStyle(t).opacity)).toBe('1');
 });
});

test('the opacity change does not animate when the system asks for reduced motion',async({page})=>{
 await page.emulateMedia({reducedMotion:'reduce'});await open(page);
 expect(await toolbar(page,6).evaluate(t=>getComputedStyle(t).transitionDuration)).toBe('0s');
});

for(const width of [1440,800,640])test(`the toolbar fits at ${width} px: no sideways scroll, inside its segment`,async({page})=>{
 await open(page,{width});
 for(const n of [1,6,12]){
  const m=await page.evaluate(i=>{const s=document.querySelectorAll('.segment')[i-1],t=s.querySelector('.segment-toolbar')!.getBoundingClientRect(),r=s.getBoundingClientRect(),d=document.documentElement;return {over:d.scrollWidth-d.clientWidth,left:t.left-r.left,right:r.right-t.right,height:t.height};},n);
  expect(m.over,`segment ${n}`).toBeLessThanOrEqual(0);expect(m.left,`segment ${n} left`).toBeGreaterThanOrEqual(0);expect(m.right,`segment ${n} right`).toBeGreaterThanOrEqual(-0.5);
 }
});

for(const theme of ['light','dark'])test(`the toolbar's generate text and icons have AA contrast in ${theme} mode, and so has the skip link`,async({page})=>{
 await page.emulateMedia({colorScheme:theme as 'light'|'dark'});await open(page);
 const lum=(c:string)=>{const [r,g,b]=(c.match(/[\d.]+/g)??[]).slice(0,3).map(Number).map(v=>{v/=255;return v<=.03928?v/12.92:((v+.055)/1.055)**2.4;});return .2126*r+.7152*g+.0722*b;};
 await page.getByRole('textbox',{name:'Nhân vật đoạn 6'}).focus();await page.keyboard.press('Tab'); // the toolbar of segment 6 is shown
 const pairs=await page.evaluate(()=>{const bgOf=(el:Element)=>{let bg='',e:Element|null=el;while(e&&(!bg||bg==='rgba(0, 0, 0, 0)')){bg=getComputedStyle(e).backgroundColor;e=e.parentElement;}return bg;};
  const seg=document.querySelectorAll('.segment')[5],gen=seg.querySelector('.segment-toolbar .quiet')!,icon=seg.querySelector('.segment-toolbar .icon-button')!,skip=document.querySelector('.skip-link')!;
  return [gen,icon,skip].map(e=>({fg:getComputedStyle(e).color,bg:bgOf(e)}));});
 for(const p of pairs){const a=lum(p.fg),b=lum(p.bg);expect((Math.max(a,b)+.05)/(Math.min(a,b)+.05),`${p.fg} on ${p.bg}`).toBeGreaterThanOrEqual(4.5);}
});

// The link is the first focusable element of the page: Shift+Tab from the first nav button lands on it.
const skipTo=async(page:Page)=>{
 const link=page.getByRole('link',{name:'Bỏ qua đến Xuất audio'});
 expect(await page.evaluate(()=>document.querySelector('a[href],button:not(:disabled),input:not(:disabled),select,textarea,[tabindex]:not([tabindex="-1"])')!.className)).toBe('skip-link');
 await page.getByRole('button',{name:'Tạo giọng đọc',exact:true}).focus();await page.keyboard.press('Shift+Tab');await expect(link).toBeFocused();
 return link;
};
test('the skip link is the first stop of the page, shows on focus, and moves focus to the export dock',async({page})=>{
 await open(page);
 const link=page.getByRole('link',{name:'Bỏ qua đến Xuất audio'});
 expect(await link.evaluate(l=>l.getBoundingClientRect().bottom)).toBeLessThan(0); // off screen until focused
 await expect(link).toHaveAttribute('href','#audio-dock');await expect(page.locator('section.audio-dock')).toHaveAttribute('id','audio-dock');
 await skipTo(page);expect(await link.evaluate(l=>l.getBoundingClientRect().top)).toBeGreaterThanOrEqual(0);
 await page.keyboard.press('Enter');
 expect(await page.evaluate(()=>{const e=document.activeElement!;return e.matches('section.audio-dock[aria-label="Xuất audio"]');})).toBe(true);
});

test('the skip link reaches the dock in an empty desktop project, where Xuất audio is disabled',async({page})=>{
 await open(page,{empty:true});await expect(page.getByRole('button',{name:'Xuất audio'}).first()).toBeDisabled();
 await skipTo(page);await page.keyboard.press('Enter');
 expect(await page.evaluate(()=>document.activeElement!.matches('section.audio-dock[aria-label="Xuất audio"]'))).toBe(true);
});

test('the skip link reaches the dock in the browser preview',async({page})=>{
 await page.goto('/');await expect(page.getByRole('heading',{name:/Tạo giọng đọc/})).toBeVisible();
 await page.keyboard.press('Tab');await expect(page.getByRole('link',{name:'Bỏ qua đến Xuất audio'})).toBeFocused();await page.keyboard.press('Enter');
 expect(await page.evaluate(()=>document.activeElement!.matches('section.audio-dock[aria-label="Xuất audio"]'))).toBe(true);
});

test('the skip link is only on the page that has the dock',async({page})=>{
 await open(page);await page.getByRole('button',{name:'Thư viện giọng',exact:true}).click();
 await expect(page.getByRole('link',{name:'Bỏ qua đến Xuất audio'})).toHaveCount(0);
});
