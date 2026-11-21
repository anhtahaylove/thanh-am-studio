import {test,expect} from '@playwright/test';
import type {Page} from '@playwright/test';
const palette=(page:Page)=>page.getByRole('dialog',{name:'Bảng lệnh'}),box=(page:Page)=>page.getByRole('combobox',{name:'Gõ để tìm lệnh'}),sheet=(page:Page)=>page.getByRole('dialog',{name:'Phím tắt'});
const withSegment=async(page:Page)=>{await page.goto('/');await page.getByRole('button',{name:'Viết đoạn đầu tiên'}).click();await expect(page.getByRole('textbox',{name:'Nội dung đoạn 1'})).toBeVisible();};

test('? opens the shortcut sheet outside text fields only, lists the real shortcuts, and Escape returns focus',async({page})=>{
 await withSegment(page);const text=page.getByRole('textbox',{name:'Nội dung đoạn 1'});
 await text.focus();await page.keyboard.type('Hỏi?');await expect(text).toHaveValue('Hỏi?');await expect(sheet(page)).toHaveCount(0);
 const speaker=page.getByRole('textbox',{name:'Nhân vật đoạn 1'});await speaker.focus();await page.keyboard.type('?');await expect(sheet(page)).toHaveCount(0);
 await page.getByRole('button',{name:'Thư viện giọng',exact:true}).focus();await page.keyboard.press('Shift+Slash');await expect(sheet(page)).toBeVisible();
 await expect(sheet(page).locator('dt')).toHaveText(['Ctrl+K','?','Ctrl+S','Ctrl+Z','Ctrl+Shift+Z hoặc Ctrl+Y','Esc','Space','Ctrl+F','Space','Enter hoặc Ctrl+S','Esc']);
 await expect(sheet(page)).toContainText('Mở bảng lệnh');await expect(sheet(page)).toContainText('Tìm trong bản chép lời');
 await page.keyboard.press('Escape');await expect(sheet(page)).toHaveCount(0);await expect(page.getByRole('button',{name:'Thư viện giọng',exact:true})).toBeFocused();
});
test('the shortcuts the sheet lists work: Ctrl+Z, Ctrl+Y, Ctrl+Shift+Z and Ctrl+F on the transcript page',async({page})=>{
 await withSegment(page);const text=page.getByRole('textbox',{name:'Nội dung đoạn 1'}),start=page.getByRole('button',{name:'Viết đoạn đầu tiên'});
 await page.keyboard.press('Control+z');await expect(text).toHaveCount(0);await expect(start).toBeVisible();
 await page.keyboard.press('Control+y');await expect(text).toBeVisible();
 await page.keyboard.press('Control+z');await expect(text).toHaveCount(0);await page.keyboard.press('Control+Shift+z');await expect(text).toBeVisible();
 await page.getByRole('button',{name:'Chép lời',exact:true}).click();await page.keyboard.press('Control+f');await expect(page.getByLabel('Tìm trong bản chép lời')).toBeFocused();
});
test('Ctrl+K opens the palette, filters without tone marks, runs with arrows and Enter, and Escape returns focus',async({page})=>{
 await withSegment(page);const text=page.getByRole('textbox',{name:'Nội dung đoạn 1'});
 await text.focus();await page.keyboard.press('Control+k');await expect(palette(page)).toBeVisible();await expect(box(page)).toBeFocused();
 await expect(palette(page).getByRole('option')).toHaveCount(11);await expect(palette(page)).not.toContainText('Nhấn ?');
 await box(page).fill('cai dat');await expect(palette(page).getByRole('option')).toHaveText(['Mở Model & cài đặt']);
 await box(page).fill('tao giong');await expect(palette(page).getByRole('option')).toHaveCount(3);await expect(palette(page).getByRole('option').first()).toHaveAttribute('aria-selected','true');
 await box(page).fill('HANG doi');await expect(palette(page).getByRole('option')).toHaveText(['Đi tới Hàng đợi']);
 await box(page).fill('xyz');await expect(palette(page).getByRole('option')).toHaveCount(0);await expect(palette(page)).toContainText('Không có lệnh nào khớp');
 await page.keyboard.press('Escape');await expect(palette(page)).toHaveCount(0);await expect(text).toBeFocused();
 await page.keyboard.press('Control+k');await box(page).fill('');await page.keyboard.press('ArrowDown');await page.keyboard.press('ArrowDown');
 await expect(palette(page).getByRole('option').nth(2)).toHaveAttribute('aria-selected','true');await expect(box(page)).toHaveAttribute('aria-activedescendant',/.+/);
 await page.keyboard.press('ArrowUp');await page.keyboard.press('ArrowUp');await page.keyboard.press('ArrowUp');await expect(palette(page).getByRole('option').last()).toHaveAttribute('aria-selected','true');
 await box(page).fill('chep loi');await page.keyboard.press('Enter');await expect(palette(page)).toHaveCount(0);await expect(page.getByRole('heading',{level:1})).toContainText('Chép lời');
 await page.keyboard.press('Control+k');await page.keyboard.press('Control+k');await expect(palette(page)).toHaveCount(0);
});
test('the palette goes to each page, opens the project list and settings, and adds a segment from any page',async({page})=>{
 await page.goto('/');await expect(page.getByRole('navigation')).toBeVisible();
 for(const [query,heading] of [['chep loi','Chép lời'],['thu vien','Thư viện giọng'],['hang doi','Hàng đợi'],['danh sach du an','Dự án'],['cai dat','Model & cài đặt'],['tao giong doc','Tạo giọng đọc']]){
  await page.keyboard.press('Control+k');await box(page).fill(query);await page.keyboard.press('Enter');await expect(page.getByRole('heading',{level:1})).toContainText(heading);
 }
 await page.getByRole('button',{name:'Model & cài đặt',exact:true}).click();await page.keyboard.press('Control+k');await box(page).fill('them doan');await page.keyboard.press('Enter');
 await expect(page.getByRole('heading',{level:1})).toContainText('Tạo giọng đọc');await expect(page.getByRole('textbox',{name:'Nội dung đoạn 1'})).toBeVisible();
 await page.getByRole('button',{name:'Chép lời',exact:true}).click();await page.keyboard.press('Control+k');await box(page).fill('them doan');await palette(page).getByRole('option',{name:'Thêm đoạn mới'}).click();
 await expect(page.getByRole('textbox',{name:'Nội dung đoạn 2'})).toBeVisible();
});
test('commands the app would disable show the same reason and do nothing',async({page})=>{
 await page.goto('/');await page.getByRole('button',{name:'Viết đoạn đầu tiên'}).click();
 await page.keyboard.press('Control+k');
 const gen=palette(page).getByRole('option',{name:/Tạo giọng tất cả/}),one=palette(page).getByRole('option',{name:/Tạo giọng đoạn đang chọn/}),out=palette(page).getByRole('option',{name:/Xuất audio/});
 for(const o of [gen,one])await expect(o).toHaveAttribute('aria-disabled','true');await expect(out).toHaveAttribute('aria-disabled','true');
 await expect(gen).toContainText('Cần bản desktop để tạo giọng');await expect(out).toContainText('Cần bản desktop để xuất audio');
 await expect(page.getByRole('button',{name:'Tạo giọng tất cả'})).toBeDisabled();await expect(page.getByRole('button',{name:'Xuất audio'})).toBeDisabled();
 await expect(palette(page).getByRole('option',{name:/Thêm đoạn mới/})).not.toHaveAttribute('aria-disabled','true');
 await box(page).fill('xuat audio');await page.keyboard.press('Enter');await expect(palette(page)).toBeVisible();
 await out.click({force:true});await expect(palette(page)).toBeVisible();
});
test('the palette and the sheet do not open over another dialog',async({page})=>{
 await page.goto('/');await page.getByRole('button',{name:'Thêm nội dung',exact:true}).click();const add=page.getByRole('dialog',{name:'Thêm nội dung'});await expect(add).toBeVisible();
 await page.keyboard.press('Control+k');await expect(palette(page)).toHaveCount(0);await page.getByRole('button',{name:'Đóng nhập nội dung'}).focus();await page.keyboard.press('Shift+Slash');await expect(sheet(page)).toHaveCount(0);
 await expect(add).toBeVisible();
 // The same keys do work once the dialog is closed, so the checks above are about the dialog and not about dead keys.
 await page.getByRole('button',{name:'Đóng nhập nội dung'}).click();await expect(add).toHaveCount(0);
 await page.keyboard.press('Control+k');await expect(palette(page)).toBeVisible();await page.keyboard.press('Escape');
 await page.getByRole('button',{name:'Thư viện giọng',exact:true}).focus();await page.keyboard.press('Shift+Slash');await expect(sheet(page)).toBeVisible();
});
test('enabled commands call the existing generate and export handlers',async({page})=>{
 await page.addInitScript(()=>{
  const w=window as any,calls:any[]=[];w.isTauri=true;w.__calls=calls;
  const take=(id:string)=>({id,asset_id:'a'+id,path:id+'.wav',duration_ms:3000,sample_rate:48000,created_at:'2026-01-01T00:00:00Z'});
  const seg=(id:string)=>({id,text:'Câu '+id+'.',normalized_text:'Câu '+id+'.',voice_id:null,speaker:'Người dẫn',gap_ms:300,takes:[take('t'+id)],selected_take_id:'t'+id,trim_start_ms:0,trim_end_ms:null,fade_in_ms:0,fade_out_ms:0,gain_db:0});
  const project={id:'p1',name:'Bảng lệnh',updated_at:'2026-01-01T00:00:00Z',revision:1,segments:[seg('1'),seg('2')],transcript:[],dictionary:{},source_asset_id:null};
  w.__TAURI_INTERNALS__={convertFileSrc:(p:string)=>p,transformCallback:()=>1,unregisterCallback:()=>{},metadata:{currentWindow:{label:'main'},currentWebview:{label:'main',windowLabel:'main'}},
   invoke:async(cmd:string,args:any)=>{calls.push({cmd,args});switch(cmd){case 'list_projects':return [project];case 'load_project':return project;case 'list_jobs':case 'list_voices':return [];
    case 'list_models':return [{id:'vieneu-v3',name:'VieNeu',engine:'vieneu',installed:true,revision:'1',license:'',description:''}];case 'get_settings':return {dictionary:{}};
    case 'runtime_status':return {python_ready:true,ffmpeg_ready:true,worker_ready:true,python_path:null,ffmpeg_path:null,message:''};default:return null;}}};
 });
 const jobs=()=>page.evaluate(()=>(window as any).__calls.filter((c:any)=>c.cmd==='enqueue_job').map((c:any)=>[c.args.kind,c.args.payload.segment_id??null]));
 await page.goto('/');await page.getByRole('button',{name:'Dự án',exact:true}).click();await page.getByRole('button',{name:'Mở dự án'}).click();await expect(page.getByRole('textbox',{name:'Nội dung đoạn 2'})).toBeVisible();
 await page.keyboard.press('Control+k');await expect(palette(page).getByRole('option',{name:/Tạo giọng tất cả/})).not.toHaveAttribute('aria-disabled','true');
 await box(page).fill('tao giong tat ca');await page.keyboard.press('Enter');await expect.poll(jobs).toEqual([['tts','1'],['tts','2']]);
 await page.getByRole('textbox',{name:'Nội dung đoạn 2'}).click();await page.keyboard.press('Control+k');await box(page).fill('dang chon');await page.keyboard.press('Enter');
 await expect.poll(jobs).toEqual([['tts','1'],['tts','2'],['tts','2']]);
 await page.keyboard.press('Control+k');await box(page).fill('xuat audio');await page.keyboard.press('Enter');
 await expect.poll(jobs).toEqual([['tts','1'],['tts','2'],['tts','2'],['render',null]]);
});
test('? typed with AltGr (Ctrl+Alt on Windows) opens the sheet, while Ctrl+? or Alt+? alone and AltGr+? in a text field do not',async({page})=>{
 await withSegment(page);await page.getByRole('textbox',{name:'Nội dung đoạn 1'}).focus();await page.keyboard.press('Control+Alt+?');await expect(sheet(page)).toHaveCount(0);
 const nav=page.getByRole('button',{name:'Thư viện giọng',exact:true});await nav.focus();
 for(const combo of ['Control+?','Alt+?']){await page.keyboard.press(combo);await expect(sheet(page)).toHaveCount(0);}
 await page.keyboard.press('Control+Alt+?');await expect(sheet(page)).toBeVisible();
 await page.keyboard.press('Escape');await expect(sheet(page)).toHaveCount(0);await expect(nav).toBeFocused();
});
test('Ctrl+K closes the palette from its close button too, not only from the filter',async({page})=>{
 await withSegment(page);const text=page.getByRole('textbox',{name:'Nội dung đoạn 1'});await text.focus();
 await page.keyboard.press('Control+k');await expect(box(page)).toBeFocused();await page.keyboard.press('Shift+Tab');await expect(palette(page).getByRole('button',{name:'Đóng bảng lệnh'})).toBeFocused();
 await page.keyboard.press('Control+k');await expect(palette(page)).toHaveCount(0);await expect(text).toBeFocused();
});
