import {test,expect,type Page} from '@playwright/test';
import {readFileSync} from 'node:fs';
// Focus mode (Ctrl+Shift+F): on the TTS page the inspector goes, the active row keeps its toolbar and take controls while the others lose them, and the script is set in a
// reading face. It persists in localStorage['thanh-am-focus']. Tauri is mocked with the 12-segment fixture (segments 2, 6 and 9 have a take; 2 and 9 a checked one) with chapters
// opening at segments 4 and 8; segment 1 is the active row when the project opens.
const PROJECT=JSON.parse(readFileSync('e2e/fixtures/script-12.json','utf8'));
PROJECT.segments[3].chapter='Chương 1';PROJECT.segments[7].chapter='Chương 2';
const mock=(o:{project:string}):void=>{
 const w=window as any;w.isTauri=true;w.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};
 const project:any=JSON.parse(o.project),ipc=(v:unknown)=>JSON.parse(JSON.stringify(v));
 w.__TAURI_INTERNALS__={convertFileSrc:(p:string)=>p,transformCallback:()=>1,unregisterCallback:()=>{},metadata:{currentWindow:{label:'main'},currentWebview:{label:'main',windowLabel:'main'}},
  invoke:async(cmd:string,args:any)=>{switch(cmd){
   case 'list_projects':return [{id:project.id,name:project.name,updated_at:project.updated_at,revision:project.revision}];case 'load_project':return ipc(project);
   case 'list_voices':case 'list_jobs':return [];case 'list_models':return [{id:'vieneu-v3',name:'VieNeu v3 Turbo',engine:'tts',installed:true,revision:'r',license:'Apache-2.0',description:''}];
   case 'get_settings':return {dictionary:{}};
   case 'runtime_status':return {python_ready:true,ffmpeg_ready:true,worker_ready:true,native_worker_ready:true,python_path:null,ffmpeg_path:null,native_worker_path:null,fallback_count:0,message:''};
   case 'save_project':return {...ipc(args.project),revision:args.project.revision+1};
   default:return null;}}};
};
const open=async(page:Page,d:{width?:number;height?:number;stored?:string;reduce?:boolean}={})=>{
 await page.setViewportSize({width:d.width??1440,height:d.height??960});
 if(d.reduce)await page.emulateMedia({reducedMotion:'reduce'});
 if(d.stored)await page.addInitScript(v=>localStorage.setItem('thanh-am-focus',v),d.stored);
 await page.addInitScript(mock,{project:JSON.stringify(PROJECT)});await page.goto('/');
 await page.getByRole('button',{name:'Dự án',exact:true}).click();await page.getByRole('button',{name:'Mở dự án',exact:true}).click();
 await expect(page.getByRole('textbox',{name:'Nội dung đoạn 12'})).toBeAttached();
};
const toggle=(page:Page)=>page.getByRole('button',{name:'Chế độ tập trung',exact:true});
const grid=(page:Page)=>page.locator('.studio-grid');
const area=(page:Page,n:number)=>page.getByRole('textbox',{name:`Nội dung đoạn ${n}`,exact:true});
const said=(page:Page,text:string)=>expect(page.locator('[aria-live=polite]').filter({hasText:text})).toHaveCount(1);
const stored=(page:Page)=>page.evaluate(()=>localStorage.getItem('thanh-am-focus'));

test('the heading button, Ctrl+Shift+F and the palette each toggle focus mode, and each says so aloud',async({page})=>{
 await open(page);
 await expect(toggle(page)).toHaveAttribute('aria-pressed','false');await expect(toggle(page)).toHaveAttribute('title','Chế độ tập trung (Ctrl+Shift+F)');
 await toggle(page).click();
 await expect(toggle(page)).toHaveAttribute('aria-pressed','true');await expect(grid(page)).toHaveClass(/focus-mode/);await said(page,'Đã bật chế độ tập trung.');
 await page.keyboard.press('Control+Shift+F');
 await expect(toggle(page)).toHaveAttribute('aria-pressed','false');await expect(grid(page)).not.toHaveClass(/focus-mode/);await said(page,'Đã tắt chế độ tập trung.');
 await page.keyboard.press('Control+k');
 const on=page.getByRole('option',{name:'Bật chế độ tập trung'});await expect(on).toBeVisible();await expect(page.getByRole('option',{name:'Tắt chế độ tập trung'})).toHaveCount(0);
 await on.click();
 await expect(grid(page)).toHaveClass(/focus-mode/);await expect(toggle(page)).toHaveAttribute('aria-pressed','true');await said(page,'Đã bật chế độ tập trung.');
 await page.keyboard.press('Control+k');
 await page.getByRole('option',{name:'Tắt chế độ tập trung'}).click();
 await expect(grid(page)).not.toHaveClass(/focus-mode/);await said(page,'Đã tắt chế độ tập trung.');
});

test('Ctrl+Shift+F works while typing in a segment, types nothing and keeps the caret; the shortcut sheet lists it',async({page})=>{
 await open(page);
 const box=area(page,3);await box.click();const before=await box.inputValue();
 await page.keyboard.press('Control+Shift+F');
 await expect(toggle(page)).toHaveAttribute('aria-pressed','true');await expect(box).toBeFocused();await expect(box).toHaveValue(before);
 await page.keyboard.press('Control+Shift+F');await expect(toggle(page)).toHaveAttribute('aria-pressed','false');await expect(box).toBeFocused();
 await page.locator('main').click({position:{x:2,y:2}});await page.keyboard.press('?');
 const sheet=page.getByRole('dialog',{name:'Phím tắt'});
 await expect(sheet.getByText('Bật hoặc tắt chế độ tập trung',{exact:true})).toBeVisible();
 await expect(sheet.locator('dt',{hasText:'Ctrl+Shift+F'})).toHaveCount(1);
});

test('Ctrl+Shift+F does nothing in a dialog or on another page',async({page})=>{
 await open(page);
 await page.getByRole('button',{name:'Chép lời',exact:true}).click();
 await page.keyboard.press('Control+Shift+F');expect(await stored(page)).toBeNull();
 await page.getByRole('button',{name:'Tạo giọng đọc',exact:true}).click();
 await expect(toggle(page)).toHaveAttribute('aria-pressed','false');
 await page.keyboard.press('Control+k');await expect(page.getByRole('dialog',{name:'Bảng lệnh'})).toBeVisible();
 await page.keyboard.press('Control+Shift+F');
 await expect(page.getByRole('dialog',{name:'Bảng lệnh'})).toBeVisible();expect(await stored(page)).toBeNull();
 await page.keyboard.press('Escape');await expect(toggle(page)).toHaveAttribute('aria-pressed','false');
});

test('the choice is stored in thanh-am-focus and survives a reload; a storage that throws does not break the toggle',async({page})=>{
 await open(page);
 await toggle(page).click();expect(await stored(page)).toBe('1');
 await page.reload();await page.getByRole('button',{name:'Dự án',exact:true}).click();await page.getByRole('button',{name:'Mở dự án',exact:true}).click();
 await expect(toggle(page)).toHaveAttribute('aria-pressed','true');await expect(grid(page)).toHaveClass(/focus-mode/);
 await toggle(page).click();expect(await stored(page)).toBe('0');
 await page.reload();await page.getByRole('button',{name:'Dự án',exact:true}).click();await page.getByRole('button',{name:'Mở dự án',exact:true}).click();
 await expect(toggle(page)).toHaveAttribute('aria-pressed','false');
});

test('a storage that refuses reads and writes leaves focus mode working for the session',async({page})=>{
 await page.addInitScript(()=>{
  const get=Storage.prototype.getItem,set=Storage.prototype.setItem,no=()=>{throw new Error('blocked');};
  Storage.prototype.getItem=function(k:string){if(k==='thanh-am-focus')no();return get.call(this,k);};
  Storage.prototype.setItem=function(k:string,v:string){if(k==='thanh-am-focus')no();return set.call(this,k,v);};
 });
 await open(page);
 await expect(toggle(page)).toHaveAttribute('aria-pressed','false');
 await toggle(page).click();await expect(grid(page)).toHaveClass(/focus-mode/);await expect(toggle(page)).toHaveAttribute('aria-pressed','true');
});

test('focus mode takes the inspector out of the layout and the accessibility tree, at wide and narrow widths',async({page})=>{
 await open(page);
 const aside=page.getByRole('complementary',{name:'Chi tiết đoạn'});
 await expect(aside).toBeVisible();await expect(page.getByRole('group',{name:'Giọng & tốc độ'})).toBeVisible();
 await toggle(page).click();
 await expect(aside).toHaveCount(0);await expect(page.getByRole('group',{name:'Giọng & tốc độ'})).toHaveCount(0);await expect(page.getByRole('button',{name:'Từ điển phát âm'})).toHaveCount(0);
 await expect(page.locator('.inspector')).toBeHidden();
 await expect.poll(async()=>(await page.locator('.script-panel').boundingBox())!.width).toBeGreaterThan(1100); // the script takes the inspector's column too
 await page.setViewportSize({width:800,height:720});
 await expect(page.locator('.segment-detail')).toBeHidden();await expect(page.getByRole('group',{name:'Giọng & tốc độ'})).toHaveCount(0);await expect(page.getByRole('combobox',{name:'Giọng đoạn 1',exact:true})).toHaveCount(0);
 await toggle(page).click();
 await expect(page.locator('.segment-detail')).toBeVisible();await expect(page.getByRole('combobox',{name:'Giọng đoạn 1',exact:true})).toBeVisible();
});

test('Tab skips the toolbar and take controls of every row but the active one',async({page})=>{
 await open(page,{width:800,height:720}); // at 920 px and below focus does not select a row, so Tab walks past every row
 const walk=async()=>{
  await area(page,1).click();
  const seen:{row:number;toolbar:boolean;take:boolean;active:boolean}[]=[];
  for(let i=0;i<70;i++){
   await page.keyboard.press('Tab');
   seen.push(await page.evaluate(()=>{const a=document.activeElement as HTMLElement,row=a.closest('.segment');
    return {row:row?[...document.querySelectorAll('.segment')].indexOf(row)+1:0,toolbar:!!a.closest('.segment-toolbar'),take:a.matches('button.take-check'),active:!!row?.classList.contains('selected')};}));
  }
  return seen;
 };
 const plain=await walk();
 expect(plain.some(s=>s.toolbar&&!s.active),'without focus mode Tab reaches the toolbars of other rows').toBe(true);
 expect(plain.some(s=>s.take&&!s.active),'and their take buttons').toBe(true);
 await toggle(page).click();
 const focused=await walk();
 expect(focused.filter(s=>(s.toolbar||s.take)&&!s.active),'focus mode: no stop in a toolbar or take button of an inactive row').toEqual([]);
 expect(focused.some(s=>s.toolbar&&s.active),'the active row keeps its toolbar').toBe(true);
 expect(Math.max(...focused.map(s=>s.row)),'the walk still reaches later rows').toBeGreaterThan(3);
});

test('the active row keeps its toolbar and take controls and the other rows show none',async({page})=>{
 await open(page);await toggle(page).click();
 await area(page,2).click();
 const row=(n:number)=>page.locator('.segment').nth(n-1);
 await expect(row(2)).toHaveClass(/selected/);
 await expect(row(2).getByRole('toolbar',{name:'Thao tác đoạn 2'})).toBeVisible();await expect(row(2).locator('button.take-check')).toBeVisible();
 await expect(page.getByRole('toolbar',{name:/^Thao tác đoạn/})).toHaveCount(1);
 await expect(page.locator('.segment:not(.selected) button.take-check:visible')).toHaveCount(0);
 await area(page,6).click();
 await expect(page.getByRole('toolbar',{name:'Thao tác đoạn 6'})).toBeVisible();await expect(page.getByRole('toolbar',{name:/^Thao tác đoạn/})).toHaveCount(1);
});

test('the text is set in the reading face: 19 px serif at 1.7, 17 px at 640 px and below, and only while focus mode is on',async({page})=>{
 await open(page);
 const style=()=>area(page,1).evaluate(t=>{const c=getComputedStyle(t);return {family:c.fontFamily,size:c.fontSize,line:c.lineHeight};});
 expect((await style()).size).toBe('15px');
 await toggle(page).click();
 let s=await style();expect(s.size).toBe('19px');expect(s.family).toContain('Palatino Linotype');expect(s.family).toContain('serif');expect(parseFloat(s.line)).toBeCloseTo(19*1.7,1);
 await page.setViewportSize({width:640,height:720});s=await style();expect(s.size).toBe('17px');expect(parseFloat(s.line)).toBeCloseTo(17*1.7,1);
 await page.setViewportSize({width:641,height:720});expect((await style()).size).toBe('19px');
 await toggle(page).click();await page.setViewportSize({width:1440,height:960});expect((await style()).size).toBe('15px');
});

for(const [width,height] of [[1440,960],[1024,720],[800,720],[641,720],[456,320]]){
 test(`focus mode has no sideways scroll at ${width}x${height}, with the chapter map and the audio dock as before`,async({page})=>{
  await open(page,{width,height,stored:'1'});
  await expect(grid(page)).toHaveClass(/focus-mode/);
  const over=await page.evaluate(()=>({doc:document.documentElement.scrollWidth-document.documentElement.clientWidth,body:document.body.scrollWidth-document.body.clientWidth,panel:(()=>{const p=document.querySelector('.script-panel') as HTMLElement;return p.scrollWidth-p.clientWidth;})(),box:(()=>{const r=(document.querySelector('.script-panel') as HTMLElement).getBoundingClientRect();return r.right-innerWidth;})()}));
  expect(over.doc,'document').toBeLessThanOrEqual(0);expect(over.body,'body').toBeLessThanOrEqual(0);expect(over.panel,'script panel').toBeLessThanOrEqual(0);expect(over.box,'script panel right edge').toBeLessThanOrEqual(0);
  await expect(page.getByRole('navigation',{name:'Mục lục chương'})).toBeVisible();
  await expect(page.getByRole('toolbar',{name:'Chương'}).getByRole('button')).toHaveCount(3);
  await expect(page.locator('#audio-dock')).toBeAttached();
  await area(page,12).scrollIntoViewIfNeeded();await expect(area(page,12)).toBeVisible();
 });
}

test('the chapter map still jumps to a chapter with focus mode on',async({page})=>{
 await open(page,{stored:'1'});
 await page.getByRole('toolbar',{name:'Chương'}).getByRole('button',{name:/^Chương 2/}).click();
 await expect(area(page,8)).toBeFocused();await expect(page.locator('.segment').nth(7)).toHaveClass(/selected/);
 await expect(page.getByRole('toolbar',{name:/^Thao tác đoạn/})).toHaveCount(1);
});

test('turning it on with focus inside the inspector moves focus to the active segment text',async({page})=>{
 await open(page);
 await page.getByRole('combobox',{name:'Giọng đoạn 1',exact:true}).focus();
 await page.keyboard.press('Control+Shift+F');
 await expect(grid(page)).toHaveClass(/focus-mode/);await expect(area(page,1)).toBeFocused();
 await page.keyboard.press('Control+Shift+F');await expect(area(page,1)).toBeFocused(); // already in the text: it stays
 await area(page,5).click();await page.getByRole('button',{name:'Từ điển phát âm'}).focus();
 await page.keyboard.press('Control+k');await page.getByRole('option',{name:'Bật chế độ tập trung'}).click();
 await expect(area(page,5)).toBeFocused();
});

test('turning it on with focus inside the in-row panel at 800 px moves focus to the segment text',async({page})=>{
 await open(page,{width:800,height:720});
 await page.getByRole('combobox',{name:'Giọng đoạn 1',exact:true}).focus();
 await page.keyboard.press('Control+Shift+F');
 await expect(grid(page)).toHaveClass(/focus-mode/);await expect(area(page,1)).toBeFocused();
});

test('with reduced motion focus mode animates nothing',async({page})=>{
 await open(page,{reduce:true});
 await toggle(page).click();await expect(grid(page)).toHaveClass(/focus-mode/);
 const motion=await page.evaluate(()=>['.studio-grid','.script-panel','.segment','.segment textarea','.segment-toolbar'].map(q=>{const c=getComputedStyle(document.querySelector(q)!);return [q,c.transitionDuration,c.animationName] as const;}));
 for(const [q,t,a] of motion){expect(t.split(',').every(d=>parseFloat(d)===0),`${q} transition ${t}`).toBe(true);expect(a,`${q} animation`).toBe('none');}
});
