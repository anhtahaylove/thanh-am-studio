import {test,expect,type Page} from '@playwright/test';
// Ctrl+P quick-open: the command palette's dialog over the project list, matched without tone marks (whole words first, then letters in
// order). Runs in the browser preview, whose store is seeded with three projects, newest first as list_projects returns them.
const KEY='thanh-am-preview-projects-v1';
const seg=(id:string,text:string)=>({id,text,normalized_text:text,voice_id:null,speaker:'Người dẫn',gap_ms:300,takes:[],selected_take_id:null,trim_start_ms:0,trim_end_ms:null,fade_in_ms:0,fade_out_ms:0,gain_db:0});
const proj=(id:string,name:string,updated_at:string,text:string)=>({id,name,updated_at,revision:1,segments:[seg(id+'-1',text)],transcript:[],dictionary:{},source_asset_id:null});
// The newest project holds "lang" only as letters in order, so for "lang" it ranks below the demo, which holds the word.
const PROJECTS=[proj('lop','Lớp anh ngữ Giang','2026-11-22T10:00:00Z','Bài một.'),proj('demo','Làng chài · dự án mẫu','2026-11-21T10:00:00Z','Sáng sớm, làng chài thức dậy.'),proj('tin','Bản tin sáng','2026-11-20T10:00:00Z','Tin đầu tiên.')];
const dialog=(page:Page)=>page.getByRole('dialog',{name:'Mở nhanh dự án'}),box=(page:Page)=>page.getByRole('combobox',{name:'Gõ để tìm dự án'});
const options=(page:Page)=>dialog(page).getByRole('listbox',{name:'Dự án'}).getByRole('option');
const seeded=async(page:Page)=>{await page.goto('/');await page.evaluate(([k,p])=>localStorage.setItem(k,JSON.stringify(p)),[KEY,PROJECTS] as const);await page.reload();await expect(page.getByRole('heading',{level:1})).toBeVisible();};
const pick=async(page:Page,query:string)=>{await page.keyboard.press('Control+p');await expect(options(page)).toHaveCount(3);await box(page).fill(query);await page.keyboard.press('Enter');await expect(dialog(page)).toHaveCount(0);};
const stored=(page:Page,id:string)=>page.evaluate(([k,i])=>JSON.parse(localStorage.getItem(k)!).find((p:{id:string})=>p.id===i).segments[0].text,[KEY,id] as const);

test('Ctrl+P opens "Mở nhanh dự án", labelled by its own heading; whole-word matches come first, then letters in order, each newest first',async({page})=>{
 await seeded(page);const opener=page.getByRole('button',{name:'Thư viện giọng',exact:true});await opener.focus();
 await page.keyboard.press('Control+p');await expect(dialog(page)).toBeVisible();await expect(box(page)).toBeFocused();
 const heading=dialog(page).getByRole('heading'),id=await dialog(page).getAttribute('aria-labelledby');
 expect(id).toBeTruthy();expect(id).not.toBe('palette-title');await expect(heading).toHaveText('Mở nhanh dự án');await expect(heading).toHaveAttribute('id',id!);
 await expect(dialog(page).getByRole('button',{name:'Đóng mở nhanh dự án',exact:true})).toBeVisible();
 await expect(box(page)).toHaveAttribute('placeholder','Gõ tên dự án… (không cần gõ dấu)');await expect(dialog(page)).toContainText('↑ ↓ để chọn, Enter để mở, Esc để đóng.');
 await expect(options(page)).toHaveText(['Lớp anh ngữ Giang','Làng chài · dự án mẫu','Bản tin sáng']);
 await box(page).fill('lang');await expect(options(page)).toHaveText(['Làng chài · dự án mẫu','Lớp anh ngữ Giang']);
 await box(page).fill('CHAI lang');await expect(options(page)).toHaveText(['Làng chài · dự án mẫu']);
 await box(page).fill('bts');await expect(options(page)).toHaveText(['Bản tin sáng']);
 await box(page).fill('xyz');await expect(options(page)).toHaveCount(0);await expect(dialog(page)).toContainText('Không có dự án nào khớp.');
 await page.keyboard.press('Escape');await expect(dialog(page)).toHaveCount(0);await expect(opener).toBeFocused();
});
test('"lang" + Enter opens the demo on "Tạo giọng đọc" from another page, and the open project\'s unsaved edit survives',async({page})=>{
 await seeded(page);await page.getByRole('button',{name:'Chép lời',exact:true}).click();
 // Focus lands on the opened project's first segment text, whether Ctrl+P was pressed on a nav button or in the old project's text.
 await pick(page,'ban tin');await expect(page.getByRole('heading',{level:1})).toContainText('Tạo giọng đọc');
 const text=page.getByRole('textbox',{name:'Nội dung đoạn 1'});await expect(text).toHaveValue('Tin đầu tiên.');await expect(text).toBeFocused();
 await text.fill('Tin đầu tiên, sửa chưa lưu.');await page.getByRole('button',{name:'Thư viện giọng',exact:true}).click();
 await pick(page,'lang');await expect(page.getByRole('heading',{level:1})).toContainText('Tạo giọng đọc');await expect(text).toHaveValue('Sáng sớm, làng chài thức dậy.');await expect(text).toBeFocused();
 await expect.poll(()=>stored(page,'tin')).toBe('Tin đầu tiên, sửa chưa lưu.');
 await pick(page,'ban tin');await expect(text).toHaveValue('Tin đầu tiên, sửa chưa lưu.');await expect(text).toBeFocused();
});
test('a picked project without segments puts focus on "Viết đoạn đầu tiên", not on the page body',async({page})=>{
 await page.goto('/');await page.evaluate(([k,p])=>localStorage.setItem(k,JSON.stringify(p)),[KEY,[{...PROJECTS[2],segments:[]},PROJECTS[1]]] as const);await page.reload();await expect(page.getByRole('heading',{level:1})).toBeVisible();
 await page.keyboard.press('Control+p');await box(page).fill('lang');await page.keyboard.press('Enter');await expect(page.getByRole('textbox',{name:'Nội dung đoạn 1'})).toBeFocused();
 await page.keyboard.press('Control+p');await box(page).fill('ban tin');await page.keyboard.press('Enter');await expect(dialog(page)).toHaveCount(0);
 await expect(page.getByRole('button',{name:'Viết đoạn đầu tiên'})).toBeFocused();
});
test('the open project shows "Đang mở", picking it does nothing, and Escape returns to the segment text',async({page})=>{
 await seeded(page);await pick(page,'ban tin');const text=page.getByRole('textbox',{name:'Nội dung đoạn 1'});await text.fill('Tin sửa.');
 await page.keyboard.press('Control+p');const current=options(page).filter({hasText:'Bản tin sáng'});
 await expect(current).toHaveAttribute('aria-disabled','true');await expect(current).toContainText('Đang mở');
 await expect(options(page).filter({hasText:'Làng chài'})).not.toHaveAttribute('aria-disabled','true');
 await box(page).fill('ban tin');await page.keyboard.press('Enter');await expect(dialog(page)).toBeVisible();
 await current.click({force:true});await expect(dialog(page)).toBeVisible();
 await page.keyboard.press('Escape');await expect(dialog(page)).toHaveCount(0);await expect(text).toBeFocused();
 // Reopening would have reset the undo history; it is still there.
 await page.keyboard.press('Control+z');await expect(text).toHaveValue('Tin đầu tiên.');
});
test('Ctrl+P is always prevented: over the shortcut sheet or the palette it opens no second dialog; Ctrl+Shift+P and Ctrl+Alt+P are left alone',async({page})=>{
 await seeded(page);
 await page.evaluate(()=>{const w=window as any;w.__prevented=[];window.addEventListener('keydown',e=>{if(e.ctrlKey&&e.key.toLowerCase()==='p')w.__prevented.push(e.defaultPrevented);});});
 const prevented=()=>page.evaluate(()=>(window as any).__prevented);
 await page.getByRole('button',{name:'Thư viện giọng',exact:true}).focus();await page.keyboard.press('Shift+Slash');const sheet=page.getByRole('dialog',{name:'Phím tắt'});await expect(sheet).toBeVisible();
 await expect(sheet).toContainText('Mở nhanh một dự án theo tên (không cần gõ dấu)');
 await page.keyboard.press('Control+p');await expect.poll(prevented).toEqual([true]);await expect(dialog(page)).toHaveCount(0);await expect(page.getByRole('dialog')).toHaveCount(1);
 await page.keyboard.press('Escape');await expect(sheet).toHaveCount(0);
 await page.keyboard.press('Control+k');await expect(page.getByRole('dialog',{name:'Bảng lệnh'})).toBeVisible();await page.keyboard.press('Control+p');await expect.poll(prevented).toEqual([true,true]);
 await expect(dialog(page)).toHaveCount(0);await page.keyboard.press('Escape');await expect(page.getByRole('dialog')).toHaveCount(0);
 for(const combo of ['Control+Shift+p','Control+Alt+p'])await page.keyboard.press(combo);await expect.poll(prevented).toEqual([true,true,false,false]);await expect(dialog(page)).toHaveCount(0);
 await page.keyboard.press('Control+p');await expect(dialog(page)).toBeVisible();await expect.poll(prevented).toEqual([true,true,false,false,true]);
});
test('the Ctrl+K palette opens quick-open too, and Escape returns focus to where it was',async({page})=>{
 await seeded(page);await pick(page,'ban tin');const text=page.getByRole('textbox',{name:'Nội dung đoạn 1'});await text.focus();
 await page.keyboard.press('Control+k');const palette=page.getByRole('dialog',{name:'Bảng lệnh'});await page.getByRole('combobox',{name:'Gõ để tìm lệnh'}).fill('mo nhanh');
 await expect(palette.getByRole('option')).toHaveText(['Mở nhanh dự án (Ctrl+P)']);await page.keyboard.press('Enter');
 await expect(palette).toHaveCount(0);await expect(dialog(page)).toBeVisible();await expect(box(page)).toBeFocused();
 await page.keyboard.press('Escape');await expect(dialog(page)).toHaveCount(0);await expect(text).toBeFocused();
});
test('with no project yet, quick-open says where to make one',async({page})=>{
 await page.goto('/');await expect(page.getByRole('heading',{level:1})).toBeVisible();
 await page.keyboard.press('Control+p');await expect(dialog(page)).toBeVisible();await expect(options(page)).toHaveCount(0);
 await expect(dialog(page)).toContainText('Chưa có dự án nào. Tạo dự án ở trang Dự án.');
});
