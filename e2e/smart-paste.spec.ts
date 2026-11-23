import {test,expect} from '@playwright/test';
import type {Locator,Page} from '@playwright/test';
// Pastes go through synthetic events: a ClipboardEvent carrying text/plain. It returns false when the app prevented the browser's own paste.
const paste=(target:Locator,text:string)=>target.evaluate((el,text)=>{const dt=new DataTransfer();dt.setData('text/plain',text);return el.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));},text);
const dialog=(page:Page)=>page.getByRole('dialog',{name:'Thêm nội dung'}),dashBox=(page:Page)=>dialog(page).getByRole('checkbox',{name:'Tách dòng “Tên - lời” thành lời nhân vật'});
const status=(page:Page)=>dialog(page).getByRole('region',{name:'Xem trước'}).getByRole('status');
const seg=(page:Page,n:number)=>page.getByRole('textbox',{name:`Nội dung đoạn ${n}`}),who=(page:Page,n:number)=>page.getByRole('textbox',{name:`Nhân vật đoạn ${n}`});
const withSegment=async(page:Page,text:string)=>{await page.goto('/');await page.getByRole('button',{name:'Viết đoạn đầu tiên'}).click();await seg(page,1).fill(text);};
const CAST='Mai: Chào anh.\nHùng – Chào em.';

test('a cast pasted into a segment opens the preview with "Tên - lời" ticked, and adding it is one undo step',async({page})=>{
 await withSegment(page,'Mở đầu.');
 expect(await paste(seg(page,1),CAST)).toBe(false);
 await expect(dialog(page)).toBeVisible();await expect(dialog(page).getByRole('textbox',{name:'Nội dung cần thêm'})).toHaveValue(CAST);
 await expect(dashBox(page)).toBeChecked();await expect(status(page)).toHaveText('Sẽ thêm 2 đoạn · 2 nhân vật');
 await expect(dialog(page).getByRole('listitem')).toHaveText(['Mai: Chào anh.','Hùng: Chào em.']);
 await expect(dialog(page)).toContainText('Dòng “Tên: lời” thành đoạn của nhân vật đó; dòng “Tên - lời” khi chọn ô bên dưới.');
 await dialog(page).getByRole('button',{name:'Thêm 2 đoạn vào kịch bản'}).click();await expect(dialog(page)).toHaveCount(0);
 await expect(seg(page,1)).toHaveValue('Mở đầu.');await expect(who(page,2)).toHaveValue('Mai');await expect(seg(page,2)).toHaveValue('Chào anh.');await expect(who(page,3)).toHaveValue('Hùng');await expect(seg(page,3)).toHaveValue('Chào em.');
 await expect(seg(page,1)).toBeFocused();await page.keyboard.press('Control+z');
 await expect(seg(page,2)).toHaveCount(0);await expect(seg(page,1)).toHaveValue('Mở đầu.');
});
test('"Dán nguyên văn" puts the pasted text at the caret of the segment it was pasted into',async({page})=>{
 await withSegment(page,'Đầu. Cuối.');await seg(page,1).evaluate((el:HTMLTextAreaElement)=>el.setSelectionRange(5,5));
 expect(await paste(seg(page,1),CAST)).toBe(false);
 await dialog(page).getByRole('button',{name:'Dán nguyên văn vào đoạn 1'}).click();await expect(dialog(page)).toHaveCount(0);
 await expect(seg(page,1)).toHaveValue(`Đầu. ${CAST} Cuối.`);await expect(seg(page,2)).toHaveCount(0);
});
test('opened from the toolbar, dash lines stay one speaker unless ticked, and Add gives the 1.0.22 segments',async({page})=>{
 await page.goto('/');await page.getByRole('button',{name:'Thêm nội dung',exact:true}).click();
 await dialog(page).getByRole('textbox',{name:'Nội dung cần thêm'}).fill('Mai - Chào\nHùng - Ừ');
 await expect(dashBox(page)).not.toBeChecked();await expect(status(page)).toHaveText('Sẽ thêm 2 đoạn · 1 nhân vật');await expect(dialog(page).getByRole('listitem')).toHaveText(['Người dẫn: Mai - Chào','Người dẫn: Hùng - Ừ']);
 await dashBox(page).check();await expect(status(page)).toHaveText('Sẽ thêm 2 đoạn · 2 nhân vật');await expect(dialog(page).getByRole('listitem')).toHaveText(['Mai: Chào','Hùng: Ừ']);
 await dashBox(page).uncheck();await expect(status(page)).toHaveText('Sẽ thêm 2 đoạn · 1 nhân vật');
 await expect(dialog(page).getByRole('button',{name:/^Dán nguyên văn/})).toHaveCount(0);
 await dialog(page).getByRole('button',{name:'Thêm 2 đoạn vào kịch bản'}).click();
 await expect(who(page,1)).toHaveValue('Người dẫn');await expect(seg(page,1)).toHaveValue('Mai - Chào');await expect(who(page,2)).toHaveValue('Người dẫn');await expect(seg(page,2)).toHaveValue('Hùng - Ừ');await expect(seg(page,3)).toHaveCount(0);
});
test('a single line or prose pasted into a segment is left to the browser',async({page})=>{
 await withSegment(page,'Mở đầu.');
 expect(await paste(seg(page,1),'Một dòng thôi: không phải vai.')).toBe(true);expect(await paste(seg(page,1),'Một câu.\nHai câu.\nBa - bốn.')).toBe(true);expect(await paste(seg(page,1),'Mai: Chào anh.')).toBe(true);
 await expect(dialog(page)).toHaveCount(0);
});
test('a paste outside a field on the empty script opens the dialog prefilled; the toolbar then opens it unticked',async({page})=>{
 await page.goto('/');await expect(page.getByRole('button',{name:'Viết đoạn đầu tiên'})).toBeVisible();
 expect(await paste(page.locator('body'),'Mai - Chào\r\nHùng - Ừ')).toBe(false);
 await expect(dialog(page).getByRole('textbox',{name:'Nội dung cần thêm'})).toHaveValue('Mai - Chào\nHùng - Ừ');await expect(dashBox(page)).toBeChecked();await expect(status(page)).toHaveText('Sẽ thêm 2 đoạn · 2 nhân vật');
 await expect(dialog(page).getByRole('button',{name:/^Dán nguyên văn/})).toHaveCount(0);
 await page.keyboard.press('Escape');await expect(dialog(page)).toHaveCount(0);
 await page.getByRole('button',{name:'Thêm nội dung',exact:true}).click();await expect(dashBox(page)).not.toBeChecked();await expect(status(page)).toHaveText('Sẽ thêm 2 đoạn · 1 nhân vật');
 await dialog(page).getByRole('button',{name:'Thêm 2 đoạn vào kịch bản'}).click();await expect(seg(page,2)).toHaveValue('Hùng - Ừ');
 expect(await paste(page.locator('body'),'Mai - Chào\nHùng - Ừ')).toBe(true);await expect(dialog(page)).toHaveCount(0);
});
test('the "Tên - lời" checkbox is absent when dash labels change nothing, and Add then follows the plain split',async({page})=>{
 await page.goto('/');await expect(page.getByRole('button',{name:'Viết đoạn đầu tiên'})).toBeVisible();
 expect(await paste(page.locator('body'),'Mai: Chào\nHùng: Ừ')).toBe(false);
 await expect(dialog(page)).toBeVisible();await expect(dashBox(page)).toHaveCount(0);await expect(status(page)).toHaveText('Sẽ thêm 2 đoạn · 2 nhân vật');
 await dialog(page).getByRole('button',{name:'Thêm 2 đoạn vào kịch bản'}).click();
 await expect(who(page,1)).toHaveValue('Mai');await expect(seg(page,1)).toHaveValue('Chào');await expect(who(page,2)).toHaveValue('Hùng');await expect(seg(page,2)).toHaveValue('Ừ');
});
test('a "Tên: lời" line whose name is longer than 30 characters stays narration',async({page})=>{
 await page.goto('/');await expect(page.getByRole('button',{name:'Viết đoạn đầu tiên'})).toBeVisible();
 const long='Một người rất dài dòng không bao giờ ngừng nói';
 expect(await paste(page.locator('body'),`${long}: Chào anh.\nMai: Ừ.`)).toBe(false);
 await expect(status(page)).toHaveText('Sẽ thêm 3 đoạn · 3 nhân vật');await expect(dialog(page).getByRole('listitem')).toHaveText([`Người dẫn: ${long}: Chào anh.`,'Mai: Ừ.','Hùng: Vâng.']);
 await dialog(page).getByRole('button',{name:'Thêm 3 đoạn vào kịch bản'}).click();
 await expect(who(page,1)).toHaveValue('Người dẫn');await expect(seg(page,1)).toHaveValue(`${long}: Chào anh.`);await expect(who(page,2)).toHaveValue('Mai');
});
test('the preview lists at most 8 rows of 60 characters, counts the rest, and fits a 1024x720 window',async({page})=>{
 await page.setViewportSize({width:1024,height:720});await page.goto('/');await expect(page.getByRole('button',{name:'Viết đoạn đầu tiên'})).toBeVisible();
 const long='Một câu rất dài kể về làng chài ven biển lúc bình minh lên cao dần.';
 await paste(page.locator('body'),[`Mai - ${long}`,...Array.from({length:9},(_,i)=>`${i%2?'Mai':'Hùng'} - Câu ${i+2}.`)].join('\n'));
 await expect(status(page)).toHaveText('Sẽ thêm 10 đoạn · 2 nhân vật');
 const rows=dialog(page).getByRole('listitem');await expect(rows).toHaveCount(8);await expect(rows.first()).toHaveText(`Mai: ${long.slice(0,60)}…`);
 await expect(dialog(page).getByRole('region',{name:'Xem trước'})).toContainText('… và 2 đoạn nữa');
 expect(await dialog(page).evaluate(d=>[d.scrollHeight<=d.clientHeight,d.scrollWidth<=d.clientWidth])).toEqual([true,true]);
 await expect(dialog(page).getByRole('button',{name:'Thêm 10 đoạn vào kịch bản'})).toBeInViewport({ratio:1});
});
test('a TXT import with dash lines gives the 1.0.22 segments',async({page})=>{
 await page.addInitScript(()=>{
  const w=window as any,calls:any[]=[];w.isTauri=true;w.__calls=calls;let project:any=null;
  w.__TAURI_INTERNALS__={convertFileSrc:(p:string)=>p,transformCallback:()=>1,unregisterCallback:()=>{},metadata:{currentWindow:{label:'main'},currentWebview:{label:'main',windowLabel:'main'}},
   invoke:async(cmd:string,args:any)=>{calls.push({cmd,args});switch(cmd){
    case 'list_projects':return project?[project]:[];case 'load_project':return project;case 'list_jobs':case 'list_voices':case 'list_models':return [];case 'get_settings':return {dictionary:{}};
    case 'runtime_status':return {python_ready:true,ffmpeg_ready:true,worker_ready:true,python_path:null,ffmpeg_path:null,message:''};
    case 'create_project':project={id:'p1',name:args.name,updated_at:new Date().toISOString(),revision:1,segments:[],transcript:[],dictionary:{},source_asset_id:null};return project;
    case 'save_project':project={...args.project,revision:args.project.revision+1};return project;
    case 'plugin:dialog|open':return ['C:/kịch bản.txt'];case 'read_text_file':return 'Mai - Chào\nHùng – Ừ\nMai: Hết.';
    default:return null;}}};
 });
 await page.goto('/');await page.getByRole('button',{name:/Nhập TXT \/ SRT \/ Word/}).click();
 await expect.poll(()=>page.evaluate(()=>{const saves=(window as any).__calls.filter((c:any)=>c.cmd==='save_project');return saves.at(-1)?.args.project.segments.map((s:any)=>[s.speaker,s.text]);})).toEqual([['Người dẫn','Mai - Chào'],['Người dẫn','Hùng – Ừ'],['Người dẫn','Mai: Hết.']]);
 await expect(dialog(page)).toHaveCount(0);
});
