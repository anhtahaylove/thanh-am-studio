import {test,expect} from '@playwright/test';
test('transcript rows that look like Whisper mistakes get a warning chip, a count and a filter, and nothing is changed',async({page})=>{
 await page.goto('/');await page.getByRole('button',{name:'Chép lời',exact:true}).click();for(let i=0;i<4;i++)await page.getByRole('button',{name:'Thêm dòng'}).click();
 const texts=page.getByLabel(/^Lời nói tại/),chips=page.locator('.suspect-chip'),toggle=page.getByRole('button',{name:/dòng đáng ngờ/});
 await texts.nth(0).fill('Cảm ơn các bạn đã xem.');await texts.nth(1).fill('  cảm ơn các bạn đã xem ');await texts.nth(2).fill('Một câu bình thường.');await texts.nth(3).fill('Ừ');
 await expect(toggle).toHaveText('1 dòng đáng ngờ');await expect(chips).toHaveText(['Lặp dòng trước']);await expect(chips.first()).toHaveAttribute('title',/giống hệt dòng ngay trước/);
 // Row 4 runs 3000 to 4000 ms; stretching it to 8000 (5 s) with one letter of text is the typical silence hallucination.
 const end=page.getByLabel('Đến (ms)').nth(3);await end.fill('8000');await end.press('Tab');
 await expect(toggle).toHaveText('2 dòng đáng ngờ');await expect(chips).toHaveText(['Lặp dòng trước','Gần như im lặng']);
 await toggle.click();await expect(toggle).toHaveAttribute('aria-pressed','true');await expect(texts).toHaveCount(2);await expect(texts.nth(0)).toHaveValue('  cảm ơn các bạn đã xem ');await expect(texts.nth(1)).toHaveValue('Ừ');
 await toggle.click();await expect(toggle).toHaveAttribute('aria-pressed','false');await expect(texts).toHaveCount(4);
 // Fixing a row clears its flag; with no flagged rows left the count and the filter go away.
 await texts.nth(1).fill('Tạm biệt.');await expect(toggle).toHaveText('1 dòng đáng ngờ');
 await texts.nth(3).fill('Và đây là một câu đủ dài để lấp đầy năm giây im lặng.');await expect(toggle).toHaveCount(0);await expect(chips).toHaveCount(0);await expect(texts).toHaveCount(4);
});
