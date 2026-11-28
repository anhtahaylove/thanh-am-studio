import {test,expect} from '@playwright/test';
// Tauri is mocked as in separation-pack.spec.ts. list_jobs fails while __fail is set, and __failed counts those failures.
const mock=()=>{
 const w=window as any;w.isTauri=true;w.__fail=false;w.__failed=0;
 w.__TAURI_INTERNALS__={convertFileSrc:(p:string)=>p,transformCallback:()=>1,unregisterCallback:()=>{},metadata:{currentWindow:{label:'main'},currentWebview:{label:'main',windowLabel:'main'}},
  invoke:async(cmd:string)=>{switch(cmd){
   case 'list_jobs':if(w.__fail){w.__failed++;throw Error('database is locked');}w.__ok=(w.__ok||0)+1;return [];
   case 'create_project':throw Error('cannot create project');
   case 'list_projects':case 'list_voices':case 'list_models':return [];case 'get_settings':return {dictionary:{}};
   case 'runtime_status':return {python_ready:true,ffmpeg_ready:true,worker_ready:true,python_path:null,ffmpeg_path:null,message:''};
   default:return null;}}};
};
const failed=(page:import('@playwright/test').Page)=>page.evaluate(()=>(window as any).__failed as number);
const breakBackend=async(page:import('@playwright/test').Page)=>{await page.addInitScript(mock);await page.goto('/');await expect(page.getByRole('navigation')).toBeVisible();await page.evaluate(()=>{(window as any).__fail=true;});};

test('a backend that keeps failing is reported after the third failed poll, and the notice clears when a poll works again',async({page})=>{
 test.setTimeout(60000);
 await breakBackend(page);
 const alert=page.getByRole('alert');
 // Two failed polls are still quiet; the third one reports it.
 await expect.poll(()=>failed(page),{timeout:8000}).toBe(2);await expect(alert).toHaveCount(0);
 await expect(alert).toContainText('database is locked',{timeout:8000});expect(await failed(page)).toBe(3);
 await page.evaluate(()=>{(window as any).__fail=false;});
 await expect(alert).toHaveCount(0,{timeout:8000});
});

test('a failure notice the user dismissed does not come back while the backend keeps failing',async({page})=>{
 test.setTimeout(60000);
 await breakBackend(page);
 await expect(page.getByRole('alert')).toContainText('database is locked',{timeout:12000});
 await page.getByRole('button',{name:'Đóng lỗi'}).click();
 const seen=await failed(page);await expect.poll(()=>failed(page),{timeout:10000}).toBeGreaterThanOrEqual(seen+2);
 await expect(page.getByRole('alert')).toHaveCount(0);
});

test('a successful poll clears only its own failure notice, and the third failure replaces another visible error',async({page})=>{
 test.setTimeout(60000);
 await breakBackend(page);
 const alert=page.getByRole('alert');
 await expect(alert).toContainText('database is locked',{timeout:12000});
 // A user action fails with its own error while the poll notice is still pending: it replaces the notice.
 await page.getByRole('button',{name:'Dự án',exact:true}).click();await page.getByRole('button',{name:'Tạo dự án'}).click();
 await expect(alert).toContainText('cannot create project');
 // The backend recovers and two polls succeed: the action's error must stay.
 await page.evaluate(()=>{const w=window as any;w.__fail=false;w.__ok=0;});
 await expect.poll(()=>page.evaluate(()=>(window as any).__ok as number),{timeout:8000}).toBeGreaterThanOrEqual(2);
 await expect(alert).toContainText('cannot create project');
 // A new failure streak replaces whatever error is showing: a backend that keeps failing matters more.
 await page.evaluate(()=>{(window as any).__fail=true;});
 await expect(alert).toContainText('database is locked',{timeout:12000});
});

test('closing the failure alert with Enter leaves focus on the page, not on nothing',async({page})=>{
 test.setTimeout(60000);
 await breakBackend(page);
 const alert=page.getByRole('alert');await expect(alert).toContainText('database is locked',{timeout:12000});
 await alert.getByRole('button',{name:'Đóng lỗi'}).focus();await page.keyboard.press('Enter');
 await expect(alert).toHaveCount(0);await expect(page.locator('main')).toBeFocused();
});
