import {test,expect} from '@playwright/test';
// Tauri is mocked as in keep-background.spec.ts: every command is recorded in window.__calls.
const mock=(o:{pack:boolean})=>{
 const w=window as any,calls:any[]=[];w.isTauri=true;w.__calls=calls;
 w.__TAURI_INTERNALS__={convertFileSrc:(p:string)=>p,transformCallback:()=>1,unregisterCallback:()=>{},metadata:{currentWindow:{label:'main'},currentWebview:{label:'main',windowLabel:'main'}},
  invoke:async(cmd:string,args:any)=>{calls.push({cmd,args});switch(cmd){
   case 'list_projects':case 'list_voices':case 'list_jobs':return [];case 'get_settings':return {dictionary:{}};
   case 'list_models':return [{id:'separation-runtime',name:'Gói chạy tách nhạc nền (Python + PyTorch)',engine:'runtime',kind:'runtime',installed:o.pack,revision:'separation-v1',license:'',description:''}];
   case 'runtime_status':return {python_ready:true,ffmpeg_ready:true,worker_ready:true,python_path:null,ffmpeg_path:null,message:''};
   default:return null;}}};
};
const downloads=(page:any)=>page.evaluate(()=>(window as any).__calls.filter((x:any)=>x.cmd==='download_model').map((x:any)=>x.args));
const open=async(page:any,pack:boolean)=>{
 await page.addInitScript(mock,{pack});await page.goto('/');await page.getByRole('button',{name:'Model & cài đặt',exact:true}).click();
 await page.getByText('Thêm model',{exact:true}).click(); // the pack card sits in the "Thêm model" fold
};

test('the pack is downloaded only after the oneMKL licence is accepted',async({page})=>{
 await open(page,false);
 await page.getByRole('button',{name:'Tải gói'}).click();
 const dialog=page.getByRole('dialog',{name:'Tải gói chạy tách nhạc nền'});
 await expect(dialog).toContainText('Intel oneMKL');
 await expect(dialog).toContainText('Giấy phép Phần mềm Đơn giản của Intel');
 await dialog.getByRole('button',{name:'Hủy'}).click();
 await expect(dialog).toHaveCount(0);
 expect(await downloads(page)).toEqual([]);
 await page.getByRole('button',{name:'Tải gói'}).click();
 await dialog.getByRole('button',{name:'Đồng ý và tải'}).click();
 expect(await downloads(page)).toEqual([{id:'separation-runtime',licenseAccepted:true}]);
});

test('an installed pack is re-checked on demand, without asking for the licence again',async({page})=>{
 await open(page,true);
 await page.getByRole('button',{name:'Kiểm tra lại gói'}).click();
 await expect(page.getByRole('dialog')).toHaveCount(0);
 expect(await downloads(page)).toEqual([{id:'separation-runtime'}]);
});

// Where keyboard focus is: inside a dialog or not.
const inDialog=(page:any)=>page.evaluate(()=>!!document.activeElement?.closest('[role=dialog]'));

test('the licence dialog starts on Cancel, keeps Tab inside, makes the page inert, and Escape cancels and returns focus',async({page})=>{
 await open(page,false);
 const opener=page.getByRole('button',{name:'Tải gói'});await opener.click();
 const dialog=page.getByRole('dialog',{name:'Tải gói chạy tách nhạc nền'});
 await expect(dialog.getByRole('button',{name:'Hủy'})).toBeFocused();
 await expect(page.locator('.sidebar')).toHaveJSProperty('inert',true);expect(await page.locator('main').evaluate(m=>!!m.closest('[inert]'))).toBe(true);
 // Three stops (close, Cancel, accept) plus wrap-around: none of 8 Tabs, forward or back, may leave the dialog.
 for(let i=0;i<8;i++){await page.keyboard.press('Tab');expect(await inDialog(page),`Tab ${i+1}`).toBe(true);}
 for(let i=0;i<8;i++){await page.keyboard.press('Shift+Tab');expect(await inDialog(page),`Shift+Tab ${i+1}`).toBe(true);}
 await page.keyboard.press('Escape');
 await expect(dialog).toHaveCount(0);await expect(opener).toBeFocused();
 await expect(page.locator('.sidebar')).toHaveJSProperty('inert',false);expect(await page.locator('main').evaluate(m=>!!m.closest('[inert]'))).toBe(false);
 expect(await downloads(page)).toEqual([]);
});

// "Có gì mới" opens over the licence dialog, as an async state change would. Script clicks, because the page behind a dialog is inert.
const openBoth=async(page:any)=>{
 await open(page,false);await page.getByRole('button',{name:'Tải gói'}).click();
 await expect(page.getByRole('dialog',{name:'Tải gói chạy tách nhạc nền'})).toBeVisible();
 await page.locator('button',{hasText:'Có gì mới'}).evaluate((b:HTMLElement)=>b.click());
 await expect(page.getByRole('dialog')).toHaveCount(2);
};

test('dialogs closing in a different order than they opened never leave the page inert',async({page})=>{
 await openBoth(page);
 // Only the newest dialog is interactive.
 await expect(page.locator('.modal-backdrop',{has:page.getByRole('dialog',{name:'Tải gói chạy tách nhạc nền'})})).toHaveJSProperty('inert',true);
 // The older one closes first.
 await page.getByRole('dialog',{name:'Tải gói chạy tách nhạc nền'}).getByRole('button',{name:'Hủy'}).evaluate((b:HTMLElement)=>b.click());
 await expect(page.getByRole('dialog')).toHaveCount(1);
 await page.getByRole('button',{name:'Đã hiểu'}).click();
 await expect(page.getByRole('dialog')).toHaveCount(0);await expect(page.locator('[inert]')).toHaveCount(0);
 await page.getByRole('button',{name:'Tải gói'}).click();await expect(page.getByRole('dialog')).toHaveCount(1);
});

test('one Escape that closes two dialogs at once leaves the page usable',async({page})=>{
 await openBoth(page);
 await page.keyboard.press('Escape');
 await expect(page.getByRole('dialog')).toHaveCount(0);await expect(page.locator('[inert]')).toHaveCount(0);
 await page.getByRole('button',{name:'Tải gói'}).click();await expect(page.getByRole('dialog')).toHaveCount(1);
});

test('when the opener is gone at close time, focus moves to the page content instead of the document body',async({page})=>{
 await open(page,false);const opener=page.getByRole('button',{name:'Tải gói'});await opener.click();
 await expect(page.getByRole('dialog')).toHaveCount(1);
 await opener.evaluate((b:HTMLElement)=>b.remove());
 await page.keyboard.press('Escape');
 await expect(page.getByRole('dialog')).toHaveCount(0);await expect(page.locator('main')).toBeFocused();
});
