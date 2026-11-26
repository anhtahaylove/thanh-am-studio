import {test,expect} from '@playwright/test';
import type {Page} from '@playwright/test';
// A model download runs in place: one click on the card, no page change, progress on the card, "Đã tải xong {tên}." in the live region when it ends,
// and a desktop notice for a long one while the window is in the background. Tauri is mocked as in job-done-notice.spec.ts: window.__calls records every
// command, window.__finish(id) ends the running download job (and installs the model), window.__notified records every desktop notification asked for.
const NAMES:Record<string,string>={'whisper-small':'Whisper Small','separation-runtime':'Gói chạy tách nhạc nền (Python + PyTorch)'};
const mock=({names,done}:{names:Record<string,string>;done:boolean})=>{
 const w=window as any;w.isTauri=true;w.__calls=[];w.__jobs=[];w.__notified=[];w.__installed=new Set<string>();w.__focus=false;document.hasFocus=()=>w.__focus;
 if(done){w.__installed.add('whisper-small');w.__jobs=[{id:'old',kind:'model_download',project_id:null,payload:{model_id:'whisper-small'},status:'succeeded',progress:1,error:null,result:null,created_at:new Date().toISOString(),updated_at:new Date().toISOString()}];}
 w.__finish=(id:string)=>{const j=w.__jobs.find((x:any)=>x.payload.model_id===id);j.status='succeeded';j.progress=1;w.__installed.add(id);};
 w.__TAURI_INTERNALS__={convertFileSrc:(p:string)=>p,transformCallback:()=>1,unregisterCallback:()=>{},metadata:{currentWindow:{label:'main'},currentWebview:{label:'main',windowLabel:'main'}},
  invoke:async(cmd:string,args:any)=>{w.__calls.push({cmd,args});switch(cmd){
   case 'plugin:window|is_focused':return w.__focus;
   case 'plugin:window|request_user_attention':return null;
   case 'plugin:notification|notify':w.__notified.push(args.options);return null;
   case 'download_model':{const t=new Date(Date.now()-60000).toISOString(),j={id:'dl-'+args.id,kind:'model_download',project_id:null,payload:{model_id:args.id},status:'running',progress:0.4,error:null,result:null,created_at:t,updated_at:t};w.__jobs=[j];return j;}
   case 'list_jobs':return JSON.parse(JSON.stringify(w.__jobs));
   case 'list_models':return Object.keys(names).map(id=>({id,name:names[id],engine:id==='whisper-small'?'stt':'runtime',kind:id==='separation-runtime'?'runtime':'model',installed:w.__installed.has(id),revision:'9f8e7d6c5b4a3921',license:'MIT',description:'Mô tả ngắn của model.'}));
   case 'list_projects':case 'list_voices':return [];case 'get_settings':return {dictionary:{}};
   case 'runtime_status':return {python_ready:true,ffmpeg_ready:true,worker_ready:true,python_path:null,ffmpeg_path:null,message:''};
   default:return null;}}};
};
const open=async(page:Page,done=false)=>{
 await page.addInitScript(mock,{names:NAMES,done});await page.goto('/');
 await page.getByRole('navigation',{name:'Điều hướng chính'}).getByRole('button',{name:'Model & cài đặt',exact:true}).click();
 await expect(page.locator('.model-card')).toHaveCount(2);
};
const card=(page:Page,id:string)=>page.locator('.model-card').filter({has:page.getByRole('heading',{level:3,name:NAMES[id],exact:true})});
const downloads=(page:Page)=>page.evaluate(()=>(window as any).__calls.filter((x:any)=>x.cmd==='download_model').map((x:any)=>x.args));
const finish=(page:Page,id:string)=>page.evaluate(i=>(window as any).__finish(i),id);
const live=(page:Page,text:string)=>page.locator('.sr-only[aria-live="polite"]').filter({hasText:text});
const stays=async(page:Page)=>{await expect(page.locator('main h1')).toContainText('Model & cài đặt');await expect(page.getByText('Công việc gần đây')).toHaveCount(0);};

test('one click on a model card starts the download, keeps the page, and shows the progress on the card',async({page})=>{
 await open(page);
 await card(page,'whisper-small').getByRole('button',{name:'Tải model',exact:true}).click();
 await expect.poll(()=>downloads(page)).toEqual([{id:'whisper-small'}]);
 await expect(card(page,'whisper-small').locator('progress')).toHaveJSProperty('value',0.4);
 await expect(card(page,'whisper-small').getByRole('button',{name:'Đang tải…',exact:true})).toBeDisabled();
 await expect(card(page,'separation-runtime').locator('progress')).toHaveCount(0);
 await stays(page);
});

test('when the download ends the live region says so, the card reads "Đã tải" and the page is still the same',async({page})=>{
 await open(page);
 await card(page,'whisper-small').getByRole('button',{name:'Tải model',exact:true}).click();
 await expect(card(page,'whisper-small').locator('progress')).toHaveCount(1);
 await expect(live(page,'Đã tải xong')).toHaveCount(0);
 await finish(page,'whisper-small');
 await expect(live(page,'Đã tải xong Whisper Small.')).toHaveCount(1,{timeout:10000});
 await expect(card(page,'whisper-small').getByRole('button',{name:'Đã tải',exact:true})).toBeDisabled();
 await expect(card(page,'whisper-small').locator('progress')).toHaveCount(0);
 await stays(page);
});

test('a download already finished when the app opens is not announced',async({page})=>{
 await open(page,true);
 await expect(card(page,'whisper-small').getByRole('button',{name:'Đã tải',exact:true})).toBeVisible();
 await page.waitForTimeout(3000);
 await expect(live(page,'Đã tải xong')).toHaveCount(0);
});

test('a long download that ends while the window is in the background raises the desktop notice with the model name',async({page})=>{
 test.setTimeout(60000);
 await open(page);
 await card(page,'whisper-small').getByRole('button',{name:'Tải model',exact:true}).click();
 await expect(card(page,'whisper-small').locator('progress')).toHaveCount(1);
 await finish(page,'whisper-small');
 await expect.poll(()=>page.evaluate(()=>(window as any).__notified),{timeout:10000}).toEqual([{title:'Đã tải model xong',body:'Whisper Small · 1 phút'}]);
});

test('the separation pack downloads in place after the licence is accepted',async({page})=>{
 await open(page);
 await card(page,'separation-runtime').getByRole('button',{name:'Tải gói',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'Tải gói chạy tách nhạc nền'});
 await dialog.getByRole('button',{name:'Đồng ý và tải'}).click();
 await expect(dialog).toHaveCount(0);
 await expect.poll(()=>downloads(page)).toEqual([{id:'separation-runtime',licenseAccepted:true}]);
 await expect(card(page,'separation-runtime').locator('progress')).toHaveJSProperty('value',0.4);
 await expect(card(page,'separation-runtime').getByRole('button',{name:'Đang tải…',exact:true})).toBeDisabled();
 await stays(page);
 await finish(page,'separation-runtime');
 await expect(live(page,'Đã tải xong Gói chạy tách nhạc nền (Python + PyTorch).')).toHaveCount(1,{timeout:10000});
 await stays(page);
});
