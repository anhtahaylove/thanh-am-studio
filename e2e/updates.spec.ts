import {test,expect} from '@playwright/test';
import {readFileSync} from 'node:fs';
const {version}=JSON.parse(readFileSync('package.json','utf8')),next=version.replace(/\d+$/,(n:string)=>String(+n+1));
// A desktop bridge whose update feed the test controls; event callbacks are kept so the test can fire window and progress events.
const mock=(o:{found:any;fail?:string;badPackage?:boolean;seen?:string;theme?:boolean;installing?:string;jobs?:any[];project?:boolean})=>{
 const w=window as any,calls:any[]=[],callbacks:any[]=[];w.isTauri=true;w.__calls=calls;
 if(!sessionStorage.getItem('seeded')){if(o.seen)localStorage.setItem('thanh-am-seen-version',o.seen);if(o.theme)localStorage.setItem('thanh-am-theme','light');sessionStorage.setItem('seeded','1');}
 w.__fire=(event:string,payload:any)=>{for(const c of calls)if(c.cmd==='plugin:event|listen'&&c.args.event===event)callbacks[c.args.handler]?.({event,id:1,payload});};
 const seg={id:'1',text:'Xin chào.',normalized_text:'Xin chào.',voice_id:null,speaker:'Người dẫn',gap_ms:300,takes:[],selected_take_id:null,trim_start_ms:0,trim_end_ms:null,fade_in_ms:0,fade_out_ms:0,gain_db:0};
 let project:any={id:'p1',name:'Cập nhật',updated_at:new Date().toISOString(),revision:1,segments:[seg],transcript:[],dictionary:{},source_asset_id:null};
 w.__TAURI_INTERNALS__={convertFileSrc:(p:string)=>p,transformCallback:(cb:any)=>callbacks.push(cb)-1,unregisterCallback:()=>{},metadata:{currentWindow:{label:'main'},currentWebview:{label:'main',windowLabel:'main'}},
  invoke:async(cmd:string,args:any)=>{calls.push({cmd,args});switch(cmd){
   case 'list_jobs':return o.jobs??[];case 'list_projects':return o.project?[project]:[];case 'load_project':return project;case 'list_voices':case 'list_models':return [];case 'get_settings':return {dictionary:{}};
   case 'runtime_status':return {python_ready:true,ffmpeg_ready:true,worker_ready:true,python_path:null,ffmpeg_path:null,message:''};
   case 'save_project':project={...args.project,revision:args.project.revision+1};return project;
   case 'update_last_install':return o.installing??null;
   case 'update_check':if(o.fail)throw o.fail;return o.found;
   case 'update_download':if(w.__hold)await w.__hold;if(o.badPackage)throw 'the signature verification failed: InvalidSignature';return o.found;default:return null;}}};
};
const commands=(page:any,cmd:string)=>page.evaluate((c:string)=>(window as any).__calls.filter((x:any)=>x.cmd===c).map((x:any)=>x.args),cmd);
const order=(page:any)=>page.evaluate(()=>(window as any).__calls.map((x:any)=>x.cmd).filter((c:string)=>c==='save_project'||c==='update_install'));

test('what is new opens once after an update and lists only the versions since the last one seen',async({page})=>{
 await page.addInitScript(mock,{found:null,seen:'1.0.9'});await page.goto('/');
 const dialog=page.getByRole('dialog',{name:'Có gì mới'});
 await expect(dialog).toBeVisible();await expect(dialog.getByRole('heading',{name:new RegExp(`^Bản ${version.replace(/\./g,'\\.')}`)})).toBeVisible();await expect(dialog.getByRole('heading',{name:/^Bản 1\.0\.10/})).toBeVisible();await expect(dialog.getByRole('heading',{name:/^Bản 1\.0\.9/})).toHaveCount(0);
 await expect(dialog.getByRole('button',{name:'Đóng Có gì mới'})).toBeFocused();await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);
 await page.reload();await page.waitForTimeout(500);await expect(dialog).toHaveCount(0);
 await page.getByRole('button',{name:'Model & cài đặt'}).click();await page.getByRole('button',{name:'Có gì mới'}).click();
 await expect(dialog.getByRole('heading',{name:/^Bản 1\.0\.7/})).toBeVisible();await dialog.getByRole('button',{name:'Đã hiểu'}).click();await expect(dialog).toHaveCount(0);
});

test('someone updating from a version that did not record what they saw still gets this version\'s changes',async({page})=>{
 await page.addInitScript(mock,{found:null,theme:true});await page.goto('/');
 const dialog=page.getByRole('dialog',{name:'Có gì mới'});await expect(dialog).toBeVisible();
 await expect(dialog.getByRole('heading',{name:/^Bản /})).toHaveCount(1);await expect(dialog.getByRole('heading',{name:new RegExp(`^Bản ${version.replace(/\./g,'\\.')}`)})).toBeVisible();
});

test('a newer release downloads in the background, shows its notes and installs on close',async({page})=>{
 await page.addInitScript(mock,{found:{version:next,notes:'- Sửa lỗi xuất phụ đề\n- Thêm giọng mới',date:null}});await page.goto('/');
 await expect(page.getByText(`Bản ${next} đã tải xong và đã kiểm chữ ký. App sẽ cài khi bạn đóng cửa sổ.`)).toBeVisible({timeout:10000});
 await page.getByRole('button',{name:'Có gì mới'}).click();const dialog=page.getByRole('dialog',{name:'Có gì mới'});
 await expect(dialog.getByText('Sửa lỗi xuất phụ đề')).toBeVisible();await expect(dialog.getByText('Thêm giọng mới')).toBeVisible();await dialog.getByRole('button',{name:'Đã hiểu'}).click();
 // Closing the window asks first; "later" closes without installing, "install" runs the installer without reopening the app.
 await page.evaluate(()=>(window as any).__fire('tauri://close-requested',null));
 const ask=page.getByRole('dialog',{name:`Cài bản ${next} rồi đóng?`});await expect(ask).toBeVisible();await expect(ask.getByRole('button',{name:'Quay lại app'})).toBeFocused();
 await page.keyboard.press('Escape');await expect(ask).toHaveCount(0);expect(await commands(page,'plugin:window|destroy')).toHaveLength(0);
 await page.evaluate(()=>(window as any).__fire('tauri://close-requested',null));await ask.getByRole('button',{name:'Đóng, để lần sau'}).click();
 await expect.poll(()=>commands(page,'plugin:window|destroy')).toHaveLength(1);expect(await commands(page,'update_install')).toEqual([]);
 await page.evaluate(()=>(window as any).__fire('tauri://close-requested',null));await ask.getByRole('button',{name:'Cài và đóng'}).click();
 await expect.poll(()=>commands(page,'update_install')).toEqual([{restart:false}]);
});

test('install now saves the open project first, then restarts into the new version; download progress is shown',async({page})=>{
 await page.addInitScript(mock,{found:{version:next,notes:null,date:null},project:true});
 await page.addInitScript(()=>{const w=window as any;w.__hold=new Promise(r=>w.__release=r);});
 await page.goto('/');await page.getByRole('button',{name:'Dự án',exact:true}).click();await page.getByRole('button',{name:'Mở dự án'}).click();
 await expect(page.getByText(`Đang tải bản ${next}…`)).toBeVisible({timeout:10000});
 await page.evaluate(()=>(window as any).__fire('update-progress',{downloaded:40,total:100}));await expect(page.getByText(`Đang tải bản ${next} · 40 %`)).toBeVisible();
 await page.evaluate(()=>(window as any).__release());
 await expect(page.getByText(new RegExp(`Bản ${next.replace(/\./g,'\\.')} đã tải xong`))).toBeVisible();
 await page.getByRole('textbox',{name:'Nội dung đoạn 1'}).fill('Xin chào, bản mới.');
 await page.getByRole('button',{name:'Cài ngay và mở lại'}).click();
 await expect.poll(()=>commands(page,'update_install')).toEqual([{restart:true}]);
 expect(await order(page)).toEqual(['save_project','update_install']);
});

test('install now asks first while a job runs, and does nothing if the user stays',async({page})=>{
 const now=new Date().toISOString();
 await page.addInitScript(mock,{found:{version:next,notes:null,date:null},jobs:[{id:'j1',kind:'tts',project_id:null,payload:{},status:'running',progress:0.3,error:null,result:null,created_at:now,updated_at:now}]});await page.goto('/');
 await expect(page.getByText(new RegExp(`Bản ${next.replace(/\./g,'\\.')} đã tải xong`))).toBeVisible({timeout:10000});
 const asked:string[]=[];page.once('dialog',d=>{asked.push(d.message());void d.dismiss();});
 await page.getByRole('button',{name:'Cài ngay và mở lại'}).click();
 await expect.poll(()=>asked.length).toBe(1);expect(asked[0]).toContain('Đang chạy 1 việc');await page.waitForTimeout(300);expect(await commands(page,'update_install')).toEqual([]);
 page.once('dialog',d=>void d.accept());await page.getByRole('button',{name:'Cài ngay và mở lại'}).click();
 await expect.poll(()=>commands(page,'update_install')).toEqual([{restart:true}]);
});

test('settings check reports the newest version, and the automatic check can be turned off',async({page})=>{
 await page.addInitScript(mock,{found:null});await page.goto('/');
 await page.getByRole('button',{name:'Model & cài đặt'}).click();
 await page.getByRole('button',{name:'Kiểm tra ngay'}).click();await expect(page.getByText(`Bạn đang dùng bản mới nhất (${version}).`)).toBeVisible();
 const auto=page.getByRole('checkbox',{name:'Tự kiểm tra và tải bản mới'});await expect(auto).toBeChecked();await auto.uncheck();
 await page.reload();await page.waitForTimeout(4000);expect(await commands(page,'update_check')).toEqual([]);
 await page.getByRole('button',{name:'Model & cài đặt'}).click();await expect(auto).not.toBeChecked();
});

test('a failed manual check says why in plain words, while a failed automatic check stays quiet',async({page})=>{
 await page.addInitScript(mock,{found:null,fail:'Could not fetch a valid release JSON from the remote'});await page.goto('/');
 await expect.poll(()=>commands(page,'update_check'),{timeout:10000}).toHaveLength(1);await expect(page.getByRole('alert')).toHaveCount(0);
 await page.getByRole('button',{name:'Model & cài đặt'}).click();await page.getByRole('button',{name:'Kiểm tra ngay'}).click();
 const alert=page.getByRole('alert').filter({hasText:'Không kiểm tra được bản mới'});await expect(alert).toContainText('Không lấy được thông tin bản mới từ GitHub');
 await alert.getByRole('button',{name:'Đóng lỗi cập nhật'}).click();await expect(alert).toHaveCount(0);
});

test('a package that fails its signature check is dropped and never offered for install',async({page})=>{
 await page.addInitScript(mock,{found:{version:next,notes:null,date:null},badPackage:true});await page.goto('/');
 await expect.poll(()=>commands(page,'update_download'),{timeout:10000}).toHaveLength(1);
 await page.getByRole('button',{name:'Model & cài đặt'}).click();await page.getByRole('button',{name:'Kiểm tra ngay'}).click();
 await expect(page.getByRole('alert').filter({hasText:'Không kiểm tra được bản mới'})).toContainText('không khớp chữ ký');
 await expect(page.getByRole('button',{name:'Cài ngay và mở lại'})).toHaveCount(0);
});

test('an install that did not finish is reported on the next start',async({page})=>{
 await page.addInitScript(mock,{found:null,installing:next});await page.goto('/');
 await expect(page.getByRole('alert').filter({hasText:`Chưa cài được bản ${next}`})).toBeVisible();
 expect((await commands(page,'update_last_install')).length).toBeGreaterThan(0);
});

test('an install that finished shows no failure',async({page})=>{
 await page.addInitScript(mock,{found:null,installing:version});await page.goto('/');
 await expect.poll(async()=>(await commands(page,'update_last_install')).length).toBeGreaterThan(0);await page.waitForTimeout(300);await expect(page.getByRole('alert')).toHaveCount(0);
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
