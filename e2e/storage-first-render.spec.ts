import {test,expect} from '@playwright/test';
// Blocked site data (privacy settings) makes every localStorage.getItem throw: the first render must still show the TTS page with the defaults.
test('a localStorage that throws on every read still renders the TTS page with the defaults',async({page})=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{Storage.prototype.getItem=function(){throw new Error('blocked');};});
 await page.goto('/');
 await expect(page.getByRole('heading',{level:1,name:/Tạo giọng đọc/})).toBeVisible();
 await page.getByRole('button',{name:'Tùy chọn',exact:true}).click();
 await expect(page.getByRole('checkbox',{name:'Đọc từ tiếng Anh'})).not.toBeChecked();
 await expect(page.getByRole('checkbox',{name:/^Tự kiểm/})).not.toBeChecked();
 expect(errors).toEqual([]);
});
