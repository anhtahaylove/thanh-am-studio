import {test,expect} from '@playwright/test';
test('the normalized text marks what the dictionary and the text rules changed, naming the dictionary key',async({page})=>{
 await page.goto('/');await page.getByRole('button',{name:'Viết đoạn đầu tiên'}).click();await page.getByRole('textbox',{name:'Nội dung đoạn 1'}).fill('Dùng AI đi 5 km.');
 await page.getByRole('button',{name:'Từ điển phát âm'}).click();await page.getByLabel('Từ gốc').fill('AI');await page.getByLabel('Cách đọc').fill('ây ai');await page.getByRole('button',{name:'Thêm cách đọc'}).click();
 const box=page.locator('.normalization');await box.locator('summary').click();
 // Screen readers skip a mark's title, so each mark also carries the reason as visually hidden text.
 await expect(box.locator('p')).toHaveText('Dùng ây ai (Từ điển phát âm: “AI” → “ây ai”) đi 5 ki lô mét. (Đổi theo quy tắc chuẩn hóa văn bản)');const marks=box.locator('mark');
 await expect(marks).toHaveText(['ây ai (Từ điển phát âm: “AI” → “ây ai”)','ki lô mét. (Đổi theo quy tắc chuẩn hóa văn bản)']);await expect(marks.locator('.sr-only')).toHaveCount(2);await expect(marks.first()).toHaveAttribute('title','Từ điển phát âm: “AI” → “ây ai”');await expect(marks.nth(1)).toHaveAttribute('title','Đổi theo quy tắc chuẩn hóa văn bản');
});
test('subtitle-timed dubbing counts and marks the takes that still run past their cue at 1.5x',async({page})=>{
 await page.addInitScript(()=>{
  const seg=(id:string,ms:number,cue_start_ms:number,cue_end_ms:number)=>({id,text:'Câu '+id+'.',normalized_text:'Câu '+id+'.',voice_id:null,speaker:'Người dẫn',gap_ms:300,takes:[{id:'t'+id,asset_id:'a'+id,path:id+'.wav',duration_ms:ms,sample_rate:24000,created_at:'2026-01-01T00:00:00Z'}],selected_take_id:'t'+id,trim_start_ms:0,trim_end_ms:null,fade_in_ms:0,fade_out_ms:0,gain_db:0,cue_start_ms,cue_end_ms});
  // 4 s in a 2 s cue is 667 ms too long even at 1.5x; 3 s in the next 2 s cue fits at 1.5x but is pushed back; 1 s fits as is.
  localStorage.setItem('thanh-am-preview-projects-v1',JSON.stringify([{id:'p1',name:'Lồng tiếng',updated_at:'2026-01-01T00:00:00Z',revision:0,segments:[seg('1',4000,0,2000),seg('2',3000,2100,4100),seg('3',1000,6000,8000)],transcript:[],dictionary:{},source_asset_id:null}]));
 });
 await page.goto('/');await page.getByRole('button',{name:'Dự án',exact:true}).click();await page.getByRole('button',{name:'Mở dự án',exact:true}).click();
 const marker=page.locator('.segment .take-check',{hasText:'Dài hơn mốc'});await expect(page.getByRole('textbox',{name:'Nội dung đoạn 3'})).toBeVisible();await expect(marker).toHaveCount(0);
 await page.getByRole('checkbox',{name:'Theo mốc phụ đề'}).check();
 await expect(page.locator('.dub-stats')).toContainText('1 đoạn vẫn dài hơn mốc ở 1,5×');await expect(page.locator('.dub-stats')).toContainText('1 đoạn bị lùi');
 await expect(marker).toHaveCount(1);await expect(page.locator('.segment').first().locator('.take-check')).toHaveText('Dài hơn mốc 667 ms');
 await page.getByRole('checkbox',{name:'Theo mốc phụ đề'}).uncheck();await expect(marker).toHaveCount(0);
});
test('a take whose end Whisper heard twice says the voice looped and asks for a new take',async({page})=>{
 await page.addInitScript(()=>{
  const check={model:'whisper-small',heard:'Hãy chủ động thay đổi. Chủ động thay đổi.',mismatches:[{expected:'',heard:'chủ động thay đổi',soft:false}]};
  const take={id:'t1',asset_id:'a1',path:'t1.wav',duration_ms:3000,sample_rate:24000,created_at:'2026-01-01T00:00:00Z',check};
  localStorage.setItem('thanh-am-preview-projects-v1',JSON.stringify([{id:'p1',name:'Lặp',updated_at:'2026-01-01T00:00:00Z',revision:0,segments:[{id:'s1',text:'Hãy chủ động thay đổi.',normalized_text:'Hãy chủ động thay đổi.',voice_id:null,speaker:'Người dẫn',gap_ms:300,takes:[take],selected_take_id:'t1',trim_start_ms:0,trim_end_ms:null,fade_in_ms:0,fade_out_ms:0,gain_db:0}],transcript:[],dictionary:{},source_asset_id:null}]));
 });
 await page.goto('/');await page.getByRole('button',{name:'Dự án',exact:true}).click();await page.getByRole('button',{name:'Mở dự án',exact:true}).click();
 const chip=page.locator('.segment .take-check');await expect(chip).toHaveText('Giọng lặp lại cuối câu: tạo lại take');await expect(chip).toHaveAttribute('title',/giọng đọc lặp lại “chủ động thay đổi”\. Bấm “Tạo take mới”/);
});
test('a TXT export of a transcript with speakers reads as turns and comes back as roles through Thêm nội dung',async({page})=>{
 await page.addInitScript(()=>{
  const row=(id:string,start_ms:number,text:string,speaker:number)=>({id,start_ms,end_ms:start_ms+900,text,speaker});
  localStorage.setItem('thanh-am-preview-projects-v1',JSON.stringify([{id:'p1',name:'Phỏng vấn',updated_at:'2026-01-01T00:00:00Z',revision:0,segments:[],transcript:[row('a',0,'Chào chị.',0),row('b',1000,'Chị khỏe không?',0),row('c',2000,'Khỏe, cảm ơn em.',1),row('d',3000,'Vậy bắt đầu nhé.',0)],dictionary:{},source_asset_id:null}]));
 });
 await page.goto('/');await page.getByRole('button',{name:'Dự án',exact:true}).click();await page.getByRole('button',{name:'Mở dự án',exact:true}).click();await page.getByRole('button',{name:'Chép lời',exact:true}).click();
 const [download]=await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name:'TXT',exact:true}).click()]);
 const txt=await (await import('node:fs/promises')).readFile(await download.path(),'utf8');
 expect(txt).toBe('Người 1: Chào chị. Chị khỏe không?\n\nNgười 2: Khỏe, cảm ơn em.\n\nNgười 1: Vậy bắt đầu nhé.');
 await page.getByRole('button',{name:'Tạo giọng đọc',exact:true}).click();await page.getByRole('button',{name:'Thêm nội dung',exact:true}).click();await page.getByRole('textbox',{name:'Nội dung cần thêm'}).fill(txt);await page.getByRole('button',{name:/^Thêm \d+ đoạn vào kịch bản$/}).click();
 for(const [i,speaker,text] of [[1,'Người 1','Chào chị. Chị khỏe không?'],[2,'Người 2','Khỏe, cảm ơn em.'],[3,'Người 1','Vậy bắt đầu nhé.']] as const){await expect(page.getByRole('textbox',{name:`Nhân vật đoạn ${i}`})).toHaveValue(speaker);await expect(page.getByRole('textbox',{name:`Nội dung đoạn ${i}`})).toHaveValue(text);}
});
test('a segment too long to mark says so instead of showing no marks without a word',async({page})=>{
 await page.goto('/');await page.getByRole('button',{name:'Viết đoạn đầu tiên'}).click();
 await page.getByRole('textbox',{name:'Nội dung đoạn 1'}).fill(`5 km ${Array(2500).fill('chữ').join(' ')} 5 km`);
 const box=page.locator('.normalization');await box.locator('summary').click();
 await expect(box).toContainText('Đoạn quá dài nên không đánh dấu được những chữ đã đổi.');await expect(box.locator('mark')).toHaveCount(0);
 await page.getByRole('textbox',{name:'Nội dung đoạn 1'}).fill('Đi 5 km.');await expect(box.locator('mark')).toHaveCount(1);await expect(box).not.toContainText('Đoạn quá dài');
});
