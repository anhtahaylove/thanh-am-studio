import {test,expect} from '@playwright/test';
import type {Locator,Page} from '@playwright/test';
// Guards of the page paste listener (App.tsx smart paste effect): a paste is left to the browser in a field, under another dialog, and on other pages.
// Same synthetic paste as smart-paste.spec.ts: dispatchEvent returns false only when the app called preventDefault().
const paste=(target:Locator,text:string)=>target.evaluate((el,text)=>{const dt=new DataTransfer();dt.setData('text/plain',text);return el.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));},text);
const dialog=(page:Page)=>page.getByRole('dialog',{name:'Thêm nội dung'}),sheet=(page:Page)=>page.getByRole('dialog',{name:'Phím tắt'});
const CAST='Mai: Chào anh.\nHùng – Chào em.';
const emptyScript=async(page:Page)=>{await page.goto('/');await expect(page.getByRole('button',{name:'Viết đoạn đầu tiên'})).toBeVisible();};

test('on the empty script, a cast pasted into a field other than a segment is left to the browser',async({page})=>{
 await emptyScript(page);
 expect(await paste(page.getByRole('checkbox',{name:/^Đọc từ tiếng Anh/}),CAST)).toBe(true);
 await expect(page.getByRole('button',{name:'Viết đoạn đầu tiên'})).toBeVisible();await expect(dialog(page)).toHaveCount(0);
});
test('on the empty script, a paste while another dialog is open opens no second dialog',async({page})=>{
 await emptyScript(page);
 await page.getByRole('button',{name:'Thư viện giọng',exact:true}).focus();await page.keyboard.press('Shift+Slash');await expect(sheet(page)).toBeVisible();
 expect(await paste(page.locator('body'),CAST)).toBe(true);
 await expect(sheet(page)).toBeVisible();await expect(dialog(page)).toHaveCount(0);
});
test('on another page with no script, a paste outside a field opens nothing',async({page})=>{
 await emptyScript(page);
 await page.getByRole('button',{name:'Chép lời',exact:true}).click();await expect(page.getByRole('heading',{level:1})).toContainText('Chép lời');
 expect(await paste(page.locator('body'),CAST)).toBe(true);
 await expect(dialog(page)).toHaveCount(0);
});
