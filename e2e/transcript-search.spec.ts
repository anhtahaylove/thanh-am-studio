import {test,expect,type Page} from '@playwright/test';
// Search 2.0 on the transcript page: "k/n", Enter and Shift+Enter through the hits, the replace preview by mark style, and "Thay N chỗ".
const KEY='thanh-am-preview-projects-v1';
type Row={id:string;start_ms:number;end_ms:number;text:string};
const row=(i:number,text:string,ms=1000):Row=>({id:'r'+i,start_ms:i*2000,end_ms:i*2000+ms,text});
const seed=async(page:Page,transcript:Row[])=>{
 await page.addInitScript(()=>{const w=window as any;w.__scrolls=[];const s=Element.prototype.scrollIntoView;Element.prototype.scrollIntoView=function(this:Element,arg?:boolean|ScrollIntoViewOptions){w.__scrolls.push(typeof arg==='object'?arg.behavior:arg);return s.call(this,arg);};});
 await page.goto('/');await page.evaluate(([k,t])=>localStorage.setItem(k,JSON.stringify([{id:'p1',name:'Tìm kiếm',updated_at:new Date().toISOString(),revision:1,segments:[],transcript:t,dictionary:{},source_asset_id:null}])),[KEY,transcript] as const);await page.reload();
 await page.getByRole('button',{name:'Dự án',exact:true}).click();await page.getByRole('button',{name:'Mở dự án',exact:true}).click();await page.getByRole('button',{name:'Chép lời',exact:true}).click();
 await expect(page.locator('.transcript-row')).toHaveCount(transcript.length);
};
const box=(page:Page)=>page.getByLabel('Tìm trong bản chép lời'),count=(page:Page)=>page.locator('.search-count');
const inView=(page:Page,id:string)=>page.evaluate(id=>{const l=document.querySelector('.transcript-list')!.getBoundingClientRect(),r=document.querySelector(`[data-row="${id}"]`)!.getBoundingClientRect();return r.top>=l.top-1&&r.bottom<=l.bottom+1;},id);
const twelve=()=>Array.from({length:12},(_,i)=>row(i,`Câu số ${i} mua cá thu tươi`));

test('Enter and Shift+Enter step through the hits and wrap, the row scrolls into view, the current hit is marked and focus stays in the box',async({page})=>{
 await page.emulateMedia({reducedMotion:'reduce'});await seed(page,twelve());
 await box(page).fill('cá thu');await expect(count(page)).toHaveText('1/12 kết quả');await expect(page.locator('mark.current')).toHaveCount(1);await expect(page.locator('[data-row="r0"] mark.current')).toHaveCount(1);
 // Enter that confirms an IME composition is not a request for the next hit.
 await box(page).evaluate(el=>el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true,cancelable:true})));await expect(count(page)).toHaveText('1/12 kết quả');
 await box(page).press('Enter');await expect(count(page)).toHaveText('2/12 kết quả');await expect(page.locator('[data-row="r1"] mark.current')).toHaveCount(1);await expect(page.locator('mark.current')).toHaveCount(1);
 for(let i=0;i<10;i++)await box(page).press('Enter');
 await expect(count(page)).toHaveText('12/12 kết quả');await expect(page.locator('[data-row="r11"] mark.current')).toHaveCount(1);expect(await inView(page,'r11')).toBe(true);await expect(box(page)).toBeFocused();
 expect(await page.evaluate(()=>(window as any).__scrolls.at(-1))).toBe('auto');
 await box(page).press('Enter');await expect(count(page)).toHaveText('1/12 kết quả');expect(await inView(page,'r0')).toBe(true);
 await box(page).press('Shift+Enter');await expect(count(page)).toHaveText('12/12 kết quả');expect(await inView(page,'r11')).toBe(true);
 await box(page).press('Shift+Enter');await expect(count(page)).toHaveText('11/12 kết quả');await expect(page.locator('[data-row="r10"] mark.current')).toHaveCount(1);
 // Typing a new query starts again at the first hit.
 await box(page).fill('tươi');await expect(count(page)).toHaveText('1/12 kết quả');await expect(box(page)).toBeFocused();
});
test('the row scrolls smoothly unless the system asks for reduced motion',async({page})=>{
 await seed(page,twelve());await box(page).fill('cá thu');await box(page).press('Enter');await expect(count(page)).toHaveText('2/12 kết quả');
 expect(await page.evaluate(()=>(window as any).__scrolls.at(-1))).toBe('smooth');
});
test('two hits in one row are visited in order, and a search with no hit has nothing to step through',async({page})=>{
 await seed(page,[row(0,'cá thu và cá thu'),row(1,'một câu khác'),row(2,'lại cá thu')]);
 await box(page).fill('cá thu');await expect(count(page)).toHaveText('1/3 kết quả');
 const marks=page.locator('.match-preview mark');await expect(marks.nth(0)).toHaveClass(/current/);
 await box(page).press('Enter');await expect(count(page)).toHaveText('2/3 kết quả');await expect(marks.nth(1)).toHaveClass(/current/);await expect(marks.nth(0)).not.toHaveClass(/current/);
 await box(page).press('Enter');await expect(page.locator('[data-row="r2"] mark.current')).toHaveCount(1);
 await box(page).fill('xyz');await expect(count(page)).toHaveText('0 kết quả');await box(page).press('Enter');await expect(count(page)).toHaveText('0 kết quả');await expect(page.locator('mark')).toHaveCount(0);
});
test('Replace says what it will change: solid marks are replaced, dashed ones only match without tone marks, and the button counts the solid ones',async({page})=>{
 // Folded matches: 1 + 1 + 2 + 1 = 5; exact (tone marks and all, any case): 'cá thu', 'Cá Thu', 'cá thu' = 3.
 await seed(page,[row(0,'cá thu tươi'),row(1,'ca thu rẻ'),row(2,'Cá Thu và ca thu nữa'),row(3,'cá thu')]);
 await box(page).fill('cá thu');await expect(count(page)).toHaveText('1/5 kết quả');
 await expect(page.getByRole('button',{name:'Thay 3 chỗ',exact:true})).toBeEnabled();
 await expect(page.locator('.match-preview mark.exact')).toHaveCount(3);await expect(page.locator('.match-preview mark:not(.exact)')).toHaveCount(2);
 await expect(page.getByText('Gạch liền: sẽ thay · Gạch đứt: chỉ khớp khi bỏ dấu')).toBeVisible();await expect(page.getByText('Gạch liền: sẽ thay')).toHaveAttribute('aria-hidden','true');
 await expect(page.locator('.match-preview mark.exact').first()).toHaveCSS('text-decoration-style','solid');await expect(page.locator('.match-preview mark:not(.exact)').first()).toHaveCSS('text-decoration-style','dashed');
 await expect(page.locator('.match-preview mark.current')).toHaveCSS('outline-style','solid');
 // The marks keep the ink colour, not the muted preview colour (4.5:1 on their tint in both themes).
 const ink=await page.evaluate(()=>{const p=document.createElement('i');p.style.color='var(--ink)';document.body.append(p);const c=getComputedStyle(p).color;p.remove();return c;});
 await expect(page.locator('.match-preview mark').first()).toHaveCSS('color',ink);
 await box(page).fill('');await expect(page.getByText('Gạch liền: sẽ thay')).toHaveCount(0);
});
test('with the suspicious filter on, matches in the rows it hides are listed apart in the button',async({page})=>{
 // Rows 1 and 2 end where they start, so they are flagged; row 0 is not and is hidden by the filter.
 await seed(page,[row(0,'cá thu một'),row(1,'cá thu hai',0),row(2,'cá thu ba',0)]);
 await box(page).fill('cá thu');await expect(page.getByRole('button',{name:'Thay 3 chỗ',exact:true})).toBeVisible();
 await page.getByRole('button',{name:/dòng đáng ngờ/}).click();await expect(page.locator('.transcript-row')).toHaveCount(2);
 await expect(page.getByRole('button',{name:'Thay 3 chỗ (1 chỗ ở dòng đang ẩn)'})).toBeVisible();await expect(count(page)).toHaveText('1/2 kết quả');
});
test('with no exact match the button is disabled and says why',async({page})=>{
 await seed(page,[row(0,'mua cá thu'),row(1,'cá thu tươi')]);
 await box(page).fill('ca thu');await expect(count(page)).toHaveText('1/2 kết quả');
 const replace=page.getByRole('button',{name:'Thay 0 chỗ',exact:true});await expect(replace).toBeDisabled();
 await expect(replace).toHaveAttribute('title','Thay thế chỉ khớp đúng dấu: không có chỗ nào khớp đúng “ca thu”');
 await page.getByLabel('Thay bằng').fill('x');await expect(replace).toBeDisabled();await expect(page.locator('.transcript-row textarea').first()).toHaveValue('mua cá thu');
});
test('a row stored in decomposed form still counts as an exact match',async({page})=>{
 await seed(page,[row(0,'cá thu tươi')]);
 await box(page).fill('cá thu'.normalize('NFC'));
 await expect(page.locator('.match-preview mark.exact')).toHaveCount(1);await expect(page.getByRole('button',{name:'Thay 1 chỗ',exact:true})).toBeEnabled();
});
test('after Replace the counter starts again at the first hit of the new text',async({page})=>{
 await seed(page,[row(0,'cá thu một'),row(1,'cá thu hai'),row(2,'cá thu ba')]);
 await box(page).fill('cá thu');await box(page).press('Enter');await box(page).press('Enter');await expect(count(page)).toHaveText('3/3 kết quả');
 await page.getByLabel('Thay bằng').fill('cá basa');await page.getByRole('button',{name:'Thay 3 chỗ',exact:true}).click();
 await expect(box(page)).toHaveValue('cá basa');await expect(count(page)).toHaveText('1/3 kết quả');
});
for(const [width,height] of [[1440,900],[800,700],[640,700]])test(`the toolbar keeps every button inside the panel at ${width} px with the filter on and hidden matches`,async({page})=>{
 await page.setViewportSize({width,height});
 // 13 exact matches, 11 of them in rows the filter hides: the longest label, "Thay 13 chỗ (11 chỗ ở dòng đang ẩn)".
 await seed(page,Array.from({length:13},(_,i)=>row(i,`cá thu số ${i}`,i<2?0:1000)));
 await box(page).fill('cá thu');await page.getByRole('button',{name:/dòng đáng ngờ/}).click();
 const replace=page.getByRole('button',{name:'Thay 13 chỗ (11 chỗ ở dòng đang ẩn)'});await expect(replace).toBeVisible();
 const edges=()=>page.evaluate(()=>{const p=document.querySelector('.transcript-panel')!,pr=p.getBoundingClientRect().right;return {over:[...p.querySelectorAll('.panel-toolbar button')].filter(b=>b.getBoundingClientRect().right>pr+0.5).map(b=>b.textContent),scroll:p.scrollLeft};});
 expect(await edges()).toEqual({over:[],scroll:0});
 await page.getByRole('button',{name:'TXT',exact:true}).focus();expect(await edges()).toEqual({over:[],scroll:0});
});
