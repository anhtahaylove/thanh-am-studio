import {test,expect} from '@playwright/test';
test('transcript rows that look like Whisper mistakes get a warning chip, a count and a filter, and nothing is changed',async({page})=>{
 await page.goto('/');await page.getByRole('button',{name:'Chép lời',exact:true}).click();for(let i=0;i<4;i++)await page.getByRole('button',{name:'Thêm dòng'}).click();
 const texts=page.getByLabel(/^Lời nói tại/),chips=page.locator('.suspect-chip'),toggle=page.getByRole('button',{name:/dòng đáng ngờ/});
 await texts.nth(0).fill('Cảm ơn các bạn đã xem.');await texts.nth(1).fill('  cảm ơn các bạn đã xem ');await texts.nth(2).fill('Một câu bình thường.');await texts.nth(3).fill('Ừ');
 await expect(toggle).toHaveText('1 dòng đáng ngờ');await expect(chips).toContainText(['Lặp dòng trước']);await expect(chips.first()).toHaveAttribute('title',/giống hệt dòng ngay trước/);
 // Row 4 runs 3000 to 4000 ms; stretching it to 8000 (5 s) with one letter of text is the typical silence hallucination.
 const end=page.getByLabel('Đến (ms)').nth(3);await end.fill('8000');await end.press('Tab');
 await expect(toggle).toHaveText('2 dòng đáng ngờ');await expect(chips).toContainText(['Lặp dòng trước','Gần như im lặng']);
 await toggle.click();await expect(toggle).toHaveAttribute('aria-pressed','true');await expect(texts).toHaveCount(2);await expect(texts.nth(0)).toHaveValue('  cảm ơn các bạn đã xem ');await expect(texts.nth(1)).toHaveValue('Ừ');
 await toggle.click();await expect(toggle).toHaveAttribute('aria-pressed','false');await expect(texts).toHaveCount(4);
 // Fixing a row clears its flag; with no flagged rows left the count and the filter go away.
 await texts.nth(1).fill('Tạm biệt.');await expect(toggle).toHaveText('1 dòng đáng ngờ');
 await texts.nth(3).fill('Và đây là một câu đủ dài để lấp đầy năm giây im lặng.');await expect(toggle).toHaveCount(0);await expect(chips).toHaveCount(0);await expect(texts).toHaveCount(4);
});

const flagged=async(page:import('@playwright/test').Page)=>{
 await page.goto('/');await page.getByRole('button',{name:'Chép lời',exact:true}).click();for(let i=0;i<4;i++)await page.getByRole('button',{name:'Thêm dòng'}).click();
 const texts=page.getByLabel(/^Lời nói tại/);await texts.nth(0).fill('Cảm ơn các bạn đã xem.');await texts.nth(1).fill('cảm ơn các bạn đã xem');await texts.nth(2).fill('Một câu bình thường.');await texts.nth(3).fill('Ừ');
 const end=page.getByLabel('Đến (ms)').nth(3);await end.fill('8000');await end.press('Tab');
 return {texts,chips:page.locator('.suspect-chip'),toggle:page.getByRole('button',{name:/dòng đáng ngờ/})};
};
test('with the filter on, fixing a flagged row keeps it on screen and focused while its chip goes away',async({page})=>{
 const {texts,chips,toggle}=await flagged(page);await expect(toggle).toHaveText('2 dòng đáng ngờ');
 await toggle.click();await expect(texts).toHaveCount(2);
 const row=texts.nth(1);await row.focus();await page.keyboard.press('End');await page.keyboard.type(' và rồi nói thêm một câu đủ dài');
 await expect(row).toHaveValue('Ừ và rồi nói thêm một câu đủ dài');await expect(row).toBeFocused();await expect(texts).toHaveCount(2);await expect(chips).toContainText(['Lặp dòng trước']);await expect(toggle).toHaveText('1 dòng đáng ngờ');
 // Once the last flagged row is fixed the filter lifts by itself and the row being edited stays put.
 const first=texts.nth(0);await first.focus();await page.keyboard.press('End');await page.keyboard.type(' nữa');
 await expect(toggle).toHaveCount(0);await expect(texts).toHaveCount(4);await expect(texts.nth(1)).toHaveValue('cảm ơn các bạn đã xem nữa');await expect(texts.nth(1)).toBeFocused();
});
test('the filter does not come back by itself when a new row is flagged later',async({page})=>{
 const {texts,toggle}=await flagged(page);await toggle.click();await expect(texts).toHaveCount(2);
 await texts.nth(0).fill('Tạm biệt.');await texts.nth(1).fill('Một câu đủ dài để không bị nghi ngờ nữa.');await expect(toggle).toHaveCount(0);await expect(texts).toHaveCount(4);
 await texts.nth(2).fill('Ừ');const end=page.getByLabel('Đến (ms)').nth(2);await end.fill('9000');await end.press('Tab');
 await expect(toggle).toHaveText('1 dòng đáng ngờ');await expect(toggle).toHaveAttribute('aria-pressed','false');await expect(texts).toHaveCount(4);
});
test('deleting every flagged row while the filter is on returns to the full list',async({page})=>{
 const {texts,toggle}=await flagged(page);await toggle.click();await expect(texts).toHaveCount(2);
 await page.getByRole('button',{name:'Xóa dòng'}).first().click();await expect(texts).toHaveCount(1);await page.getByRole('button',{name:'Xóa dòng'}).first().click();
 await expect(toggle).toHaveCount(0);await expect(texts).toHaveCount(2);
});
test('the reason is available to assistive technology, not only as a tooltip',async({page})=>{
 const {texts}=await flagged(page);
 await expect(texts.nth(1)).toHaveAccessibleDescription(/giống hệt dòng ngay trước/);await expect(texts.nth(3)).toHaveAccessibleDescription(/gần như không có chữ/);await expect(texts.nth(2)).toHaveAccessibleDescription('');
});
