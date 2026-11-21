import {test,expect} from '@playwright/test';
test('the normalized text marks what the dictionary and the text rules changed, naming the dictionary key',async({page})=>{
 await page.goto('/');await page.getByRole('button',{name:'Viết đoạn đầu tiên'}).click();await page.getByRole('textbox',{name:'Nội dung đoạn 1'}).fill('Dùng AI đi 5 km.');
 await page.getByRole('button',{name:'Từ điển phát âm'}).click();await page.getByLabel('Từ gốc').fill('AI');await page.getByLabel('Cách đọc').fill('ây ai');await page.getByRole('button',{name:'Thêm cách đọc'}).click();
 const box=page.locator('.normalization');await box.locator('summary').click();
 await expect(box.locator('p')).toHaveText('Dùng ây ai đi 5 ki lô mét.');const marks=box.locator('mark');
 await expect(marks).toHaveText(['ây ai','ki lô mét.']);await expect(marks.first()).toHaveAttribute('title','Từ điển phát âm: “AI” → “ây ai”');await expect(marks.nth(1)).toHaveAttribute('title','Đổi theo quy tắc chuẩn hóa văn bản');
});
