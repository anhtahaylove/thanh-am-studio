import {test,expect,type Page} from '@playwright/test';
// Keyboard focus survives the buttons that switch pages, remove their own card or reach the end of the history. Runs in the browser preview,
// whose store is seeded with projects, newest first as list_projects returns them.
const KEY='thanh-am-preview-projects-v1';
const seg=(id:string,text:string)=>({id,text,normalized_text:text,voice_id:null,speaker:'Người dẫn',gap_ms:300,takes:[],selected_take_id:null,trim_start_ms:0,trim_end_ms:null,fade_in_ms:0,fade_out_ms:0,gain_db:0});
const proj=(id:string,name:string,updated_at:string,segments:unknown[])=>({id,name,updated_at,revision:1,segments,transcript:[],dictionary:{},source_asset_id:null});
const PROJECTS=[proj('lop','Lớp anh ngữ Giang','2026-11-22T10:00:00Z',[seg('lop-1','Bài một.')]),proj('tin','Bản tin sáng','2026-11-21T10:00:00Z',[seg('tin-1','Tin đầu tiên.')]),proj('trong','Dự án trống','2026-11-20T10:00:00Z',[])];
const projects=async(page:Page,list:unknown[]=PROJECTS)=>{await page.goto('/');await page.evaluate(([k,p])=>localStorage.setItem(k,JSON.stringify(p)),[KEY,list] as const);await page.reload();await page.getByRole('button',{name:'Dự án',exact:true}).click();await expect(page.getByRole('heading',{level:1})).toContainText('Dự án');};
const card=(page:Page,name:string)=>page.locator('article.project-card').filter({hasText:name});
const press=async(page:Page,button:ReturnType<Page['getByRole']>)=>{await button.focus();await page.keyboard.press('Enter');};

test('"Mở dự án" puts focus on the opened project\'s first segment text',async({page})=>{
 await projects(page);await press(page,card(page,'Bản tin sáng').getByRole('button',{name:'Mở dự án',exact:true}));
 await expect(page.getByRole('heading',{level:1})).toContainText('Tạo giọng đọc');await expect(page.getByRole('textbox',{name:'Nội dung đoạn 1'})).toBeFocused();
});

test('"Mở dự án" on a project without segments puts focus on "Viết đoạn đầu tiên"',async({page})=>{
 await projects(page);await press(page,card(page,'Dự án trống').getByRole('button',{name:'Mở dự án',exact:true}));
 await expect(page.getByRole('heading',{level:1})).toContainText('Tạo giọng đọc');await expect(page.getByRole('button',{name:'Viết đoạn đầu tiên'})).toBeFocused();
});

test('"Tạo dự án" puts focus on "Viết đoạn đầu tiên" of the new project',async({page})=>{
 await projects(page);await press(page,page.getByRole('button',{name:'Tạo dự án',exact:true}));
 await expect(page.getByRole('heading',{level:1})).toContainText('Tạo giọng đọc');await expect(page.getByRole('button',{name:'Viết đoạn đầu tiên'})).toBeFocused();
});

test('deleting a project (dialog accepted) moves focus to the next card\'s "Mở dự án"',async({page})=>{
 await projects(page);page.once('dialog',d=>void d.accept());
 await press(page,page.getByRole('button',{name:'Xóa dự án Lớp anh ngữ Giang',exact:true}));
 await expect(card(page,'Lớp anh ngữ Giang')).toHaveCount(0);
 await expect(card(page,'Bản tin sáng').getByRole('button',{name:'Mở dự án',exact:true})).toBeFocused();
});

test('deleting the last remaining project moves focus to "Tạo dự án"',async({page})=>{
 await projects(page,[PROJECTS[1]]);page.once('dialog',d=>void d.accept());
 await press(page,page.getByRole('button',{name:'Xóa dự án Bản tin sáng',exact:true}));
 await expect(page.locator('article.project-card')).toHaveCount(0);
 await expect(page.getByRole('button',{name:'Tạo dự án',exact:true})).toBeFocused();
});

test('Enter on Undo at the end of the history keeps focus on it, now blocked with aria-disabled',async({page})=>{
 await projects(page);await press(page,card(page,'Bản tin sáng').getByRole('button',{name:'Mở dự án',exact:true}));
 const text=page.getByRole('textbox',{name:'Nội dung đoạn 1'});await text.fill('Tin đầu tiên, đã sửa.');
 const undo=page.getByRole('button',{name:'Hoàn tác (Ctrl+Z)'}),redo=page.getByRole('button',{name:'Làm lại (Ctrl+Shift+Z)'});
 await expect(undo).not.toHaveAttribute('aria-disabled','true');await expect(redo).toHaveAttribute('aria-disabled','true');
 await press(page,undo);
 await expect(text).toHaveValue('Tin đầu tiên.');await expect(undo).toBeFocused();await expect(undo).toHaveAttribute('aria-disabled','true');
 await press(page,redo);
 await expect(text).toHaveValue('Tin đầu tiên, đã sửa.');await expect(redo).toBeFocused();await expect(redo).toHaveAttribute('aria-disabled','true');
});
