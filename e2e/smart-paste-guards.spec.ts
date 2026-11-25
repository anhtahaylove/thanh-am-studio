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
// An IME can paste a single composed character ("â") outside a field: that is not a script, so no dialog; two or more words (NBSP included) are.
const compose=(page:Page,type:'compositionstart'|'compositionend')=>page.evaluate(type=>{document.body.dispatchEvent(new CompositionEvent(type,{bubbles:true}));},type);

test('on the empty script, a single composed character pasted outside a field opens no dialog',async({page})=>{
 await emptyScript(page);
 expect(await paste(page.locator('body'),'â')).toBe(true);
 await expect(page.getByRole('button',{name:'Viết đoạn đầu tiên'})).toBeVisible();await expect(dialog(page)).toHaveCount(0);
});
test('on the empty script, a paste during an IME composition opens no dialog, and one after it ends does',async({page})=>{
 await emptyScript(page);
 await compose(page,'compositionstart');
 expect(await paste(page.locator('body'),CAST)).toBe(true);await expect(dialog(page)).toHaveCount(0);
 await compose(page,'compositionend');
 expect(await paste(page.locator('body'),CAST)).toBe(false);await expect(dialog(page)).toBeVisible();
});
test('on the empty script, two words separated by a no-break space open the dialog',async({page})=>{
 await emptyScript(page);
 expect(await paste(page.locator('body'),'Chào\u00a0bạn')).toBe(false);
 await expect(dialog(page)).toBeVisible();await expect(dialog(page).getByRole('textbox',{name:'Nội dung cần thêm'})).toHaveValue('Chào\u00a0bạn');
});
test('on the empty script, one word pasted outside a field opens no dialog',async({page})=>{
 await emptyScript(page);
 expect(await paste(page.locator('body'),'Chào')).toBe(true);
 await expect(dialog(page)).toHaveCount(0);
});
test('on the empty script, a "Tên - lời" cast pasted outside a field still opens the dialog',async({page})=>{
 await emptyScript(page);
 expect(await paste(page.locator('body'),'Mai - Chào\nHùng - Ừ')).toBe(false);
 await expect(dialog(page)).toBeVisible();await expect(dialog(page).getByRole('textbox',{name:'Nội dung cần thêm'})).toHaveValue('Mai - Chào\nHùng - Ừ');
});
