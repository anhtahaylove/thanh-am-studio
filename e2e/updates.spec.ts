import {test,expect} from '@playwright/test';
// A desktop bridge whose update feed the test controls; event callbacks are kept so the test can fire window and progress events.
const mock=(o:{found:any;fail?:boolean;seen?:string;installing?:string;jobs?:any[]})=>{
 const w=window as any,calls:any[]=[],callbacks:any[]=[];w.isTauri=true;w.__calls=calls;
 if(!sessionStorage.getItem('seeded')){if(o.seen)localStorage.setItem('thanh-am-seen-version',o.seen);if(o.installing)localStorage.setItem('thanh-am-installing',o.installing);sessionStorage.setItem('seeded','1');}
 w.__fire=(event:string,payload:any)=>{for(const c of calls)if(c.cmd==='plugin:event|listen'&&c.args.event===event)callbacks[c.args.handler]?.({event,id:1,payload});};
 w.__TAURI_INTERNALS__={convertFileSrc:(p:string)=>p,transformCallback:(cb:any)=>callbacks.push(cb)-1,unregisterCallback:()=>{},metadata:{currentWindow:{label:'main'},currentWebview:{label:'main',windowLabel:'main'}},
  invoke:async(cmd:string,args:any)=>{calls.push({cmd,args});switch(cmd){
   case 'list_jobs':return o.jobs??[];case 'list_projects':case 'list_voices':case 'list_models':return [];case 'get_settings':return {dictionary:{}};
   case 'runtime_status':return {python_ready:true,ffmpeg_ready:true,worker_ready:true,python_path:null,ffmpeg_path:null,message:''};
   case 'update_check':if(o.fail)throw 'error sending request: offline';return o.found;
   case 'update_download':if(w.__hold)await w.__hold;return o.found;default:return null;}}};
};
const commands=(page:any,cmd:string)=>page.evaluate((c:string)=>(window as any).__calls.filter((x:any)=>x.cmd===c).map((x:any)=>x.args),cmd);

test('what is new opens once after an update and lists only the versions since the last one seen',async({page})=>{
 await page.addInitScript(mock,{found:null,seen:'1.0.9'});await page.goto('/');
 const dialog=page.getByRole('dialog',{name:'Có gì mới'});
 await expect(dialog).toBeVisible();await expect(dialog.getByRole('heading',{name:/^Bản 1\.0\.11/})).toBeVisible();await expect(dialog.getByRole('heading',{name:/^Bản 1\.0\.10/})).toBeVisible();await expect(dialog.getByRole('heading',{name:/^Bản 1\.0\.9/})).toHaveCount(0);
 await dialog.getByRole('button',{name:'Đã hiểu'}).click();await expect(dialog).toHaveCount(0);
 await page.reload();await page.waitForTimeout(500);await expect(dialog).toHaveCount(0);
 await page.getByRole('button',{name:'Model & cài đặt'}).click();await page.getByRole('button',{name:'Có gì mới'}).click();
 await expect(dialog.getByRole('heading',{name:/^Bản 1\.0\.7/})).toBeVisible();
});

test('a newer release downloads in the background, shows its notes and installs on close',async({page})=>{
 await page.addInitScript(mock,{found:{version:'1.0.12',notes:'- Sửa lỗi xuất phụ đề\n- Thêm giọng mới',date:null}});await page.goto('/');
 await expect(page.getByText('Bản 1.0.12 đã tải xong và đã kiểm chữ ký. App sẽ cài khi bạn đóng cửa sổ.')).toBeVisible({timeout:10000});
 await page.getByRole('button',{name:'Có gì mới'}).click();const dialog=page.getByRole('dialog',{name:'Có gì mới'});
 await expect(dialog.getByText('Sửa lỗi xuất phụ đề')).toBeVisible();await expect(dialog.getByText('Thêm giọng mới')).toBeVisible();await dialog.getByRole('button',{name:'Đã hiểu'}).click();
 // Closing the window asks first; "later" closes without installing, "install" runs the installer without reopening the app.
 await page.evaluate(()=>(window as any).__fire('tauri://close-requested',null));
 const ask=page.getByRole('dialog',{name:'Cài bản 1.0.12 rồi đóng?'});await expect(ask).toBeVisible();
 await ask.getByRole('button',{name:'Quay lại app'}).click();await expect(ask).toHaveCount(0);expect(await commands(page,'plugin:window|destroy')).toHaveLength(0);
 await page.evaluate(()=>(window as any).__fire('tauri://close-requested',null));await ask.getByRole('button',{name:'Đóng, để lần sau'}).click();
 await expect.poll(()=>commands(page,'plugin:window|destroy')).toHaveLength(1);expect(await commands(page,'update_install')).toEqual([]);
 await page.evaluate(()=>(window as any).__fire('tauri://close-requested',null));await ask.getByRole('button',{name:'Cài và đóng'}).click();
 await expect.poll(()=>commands(page,'update_install')).toEqual([{restart:false}]);
});

test('install now restarts into the new version, and download progress is shown',async({page})=>{
 await page.addInitScript(mock,{found:{version:'1.0.12',notes:null,date:null}});
 await page.addInitScript(()=>{const w=window as any;w.__hold=new Promise(r=>w.__release=r);});
 await page.goto('/');
 await expect(page.getByText('Đang tải bản 1.0.12…')).toBeVisible({timeout:10000});
 await page.evaluate(()=>(window as any).__fire('update-progress',{downloaded:40,total:100}));await expect(page.getByText('Đang tải bản 1.0.12 · 40 %')).toBeVisible();
 await page.evaluate(()=>(window as any).__release());
 await expect(page.getByText(/Bản 1\.0\.12 đã tải xong/)).toBeVisible();
 await page.getByRole('button',{name:'Cài ngay và mở lại'}).click();
 await expect.poll(()=>commands(page,'update_install')).toEqual([{restart:true}]);expect(await page.evaluate(()=>localStorage.getItem('thanh-am-installing'))).toBe('1.0.12');
});

test('settings check reports the newest version or the failure, and the automatic check can be turned off',async({page})=>{
 await page.addInitScript(mock,{found:null});await page.goto('/');
 await page.getByRole('button',{name:'Model & cài đặt'}).click();
 await page.getByRole('button',{name:'Kiểm tra ngay'}).click();await expect(page.getByText('Bạn đang dùng bản mới nhất (1.0.11).')).toBeVisible();
 const auto=page.getByRole('checkbox',{name:'Tự kiểm tra và tải bản mới'});await expect(auto).toBeChecked();await auto.uncheck();
 await page.reload();await page.waitForTimeout(4000);expect(await commands(page,'update_check')).toEqual([]);
 await page.getByRole('button',{name:'Model & cài đặt'}).click();await expect(auto).not.toBeChecked();
});

test('a failed manual check says why, while a failed automatic check stays quiet',async({page})=>{
 await page.addInitScript(mock,{found:null,fail:true});await page.goto('/');
 await expect.poll(()=>commands(page,'update_check'),{timeout:10000}).toHaveLength(1);await expect(page.getByRole('alert')).toHaveCount(0);
 await page.getByRole('button',{name:'Model & cài đặt'}).click();await page.getByRole('button',{name:'Kiểm tra ngay'}).click();
 const alert=page.getByRole('alert').filter({hasText:'Không kiểm tra được bản mới'});await expect(alert).toContainText('Không kết nối được tới máy chủ cập nhật');
 await alert.getByRole('button',{name:'Đóng lỗi cập nhật'}).click();await expect(alert).toHaveCount(0);
});

test('an install that did not finish is reported once on the next start',async({page})=>{
 await page.addInitScript(mock,{found:null,installing:'1.0.12'});await page.goto('/');
 const alert=page.getByRole('alert').filter({hasText:'Chưa cài được bản 1.0.12'});await expect(alert).toBeVisible();
 expect(await page.evaluate(()=>localStorage.getItem('thanh-am-installing'))).toBeNull();
 await page.reload();await page.waitForTimeout(500);await expect(alert).toHaveCount(0);
});

test('an install that finished shows no failure',async({page})=>{
 await page.addInitScript(mock,{found:null,installing:'1.0.11'});await page.goto('/');await page.waitForTimeout(500);
 await expect(page.getByRole('alert')).toHaveCount(0);expect(await page.evaluate(()=>localStorage.getItem('thanh-am-installing'))).toBeNull();
});

test('closing while a job runs asks first',async({page})=>{
 const now=new Date().toISOString();
 await page.addInitScript(mock,{found:null,jobs:[{id:'j1',kind:'tts',project_id:null,payload:{},status:'running',progress:0.3,error:null,result:null,created_at:now,updated_at:now}]});await page.goto('/');
 await expect(page.getByRole('button',{name:'Hàng đợi'})).toBeVisible();await page.waitForTimeout(300);
 const asked:string[]=[];page.once('dialog',d=>{asked.push(d.message());void d.dismiss();});
 await page.evaluate(()=>(window as any).__fire('tauri://close-requested',null));
 await expect.poll(()=>asked.length).toBe(1);expect(asked[0]).toContain('Đang chạy 1 việc');expect(await commands(page,'plugin:window|destroy')).toHaveLength(0);
 page.once('dialog',d=>void d.accept());await page.evaluate(()=>(window as any).__fire('tauri://close-requested',null));
 await expect.poll(()=>commands(page,'plugin:window|destroy')).toHaveLength(1);
});
