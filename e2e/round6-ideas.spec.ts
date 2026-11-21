import {test,expect} from '@playwright/test';
test('the normalized text marks what the dictionary and the text rules changed, naming the dictionary key',async({page})=>{
 await page.goto('/');await page.getByRole('button',{name:'Viết đoạn đầu tiên'}).click();await page.getByRole('textbox',{name:'Nội dung đoạn 1'}).fill('Dùng AI đi 5 km.');
 await page.getByRole('button',{name:'Từ điển phát âm'}).click();await page.getByLabel('Từ gốc').fill('AI');await page.getByLabel('Cách đọc').fill('ây ai');await page.getByRole('button',{name:'Thêm cách đọc'}).click();
 const box=page.locator('.normalization');await box.locator('summary').click();
 await expect(box.locator('p')).toHaveText('Dùng ây ai đi 5 ki lô mét.');const marks=box.locator('mark');
 await expect(marks).toHaveText(['ây ai','ki lô mét.']);await expect(marks.first()).toHaveAttribute('title','Từ điển phát âm: “AI” → “ây ai”');await expect(marks.nth(1)).toHaveAttribute('title','Đổi theo quy tắc chuẩn hóa văn bản');
});
test('subtitle-timed dubbing counts and marks the takes that still run past their cue at 1.5x',async({page})=>{
 await page.addInitScript(()=>{
  const seg=(id:string,ms:number,cue_start_ms:number,cue_end_ms:number)=>({id,text:'Câu '+id+'.',normalized_text:'Câu '+id+'.',voice_id:null,speaker:'Người dẫn',gap_ms:300,takes:[{id:'t'+id,asset_id:'a'+id,path:id+'.wav',duration_ms:ms,sample_rate:24000,created_at:'2026-01-01T00:00:00Z'}],selected_take_id:'t'+id,trim_start_ms:0,trim_end_ms:null,fade_in_ms:0,fade_out_ms:0,gain_db:0,cue_start_ms,cue_end_ms});
  // 4 s in a 2 s cue is 667 ms too long even at 1.5x; 3 s in the next 2 s cue fits at 1.5x but is pushed back; 1 s fits as is.
  localStorage.setItem('thanh-am-preview-projects-v1',JSON.stringify([{id:'p1',name:'Lồng tiếng',updated_at:'2026-01-01T00:00:00Z',revision:0,segments:[seg('1',4000,0,2000),seg('2',3000,2100,4100),seg('3',1000,6000,8000)],transcript:[],dictionary:{},source_asset_id:null}]));
 });
 await page.goto('/');await page.getByRole('button',{name:'Dự án',exact:true}).click();await page.getByRole('button',{name:'Mở dự án'}).click();
 const marker=page.locator('.segment .take-check',{hasText:'Dài hơn mốc'});await expect(page.getByRole('textbox',{name:'Nội dung đoạn 3'})).toBeVisible();await expect(marker).toHaveCount(0);
 await page.getByRole('checkbox',{name:'Theo mốc phụ đề'}).check();
 await expect(page.locator('.dub-stats')).toContainText('1 đoạn vẫn dài hơn mốc ở 1,5×');await expect(page.locator('.dub-stats')).toContainText('1 đoạn bị lùi');
 await expect(marker).toHaveCount(1);await expect(page.locator('.segment').first().locator('.take-check')).toHaveText('Dài hơn mốc 667 ms');
 await page.getByRole('checkbox',{name:'Theo mốc phụ đề'}).uncheck();await expect(marker).toHaveCount(0);
});
