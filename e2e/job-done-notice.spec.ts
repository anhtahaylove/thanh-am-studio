import {test,expect} from '@playwright/test';
// Tauri is mocked as in taskbar-progress.spec.ts: the job list is whatever window.__jobs holds, window.__focus is what document.hasFocus() answers,
// window.__attention records every request_user_attention call, and window.__notified every desktop notification asked for (the asset behind a job is named "<asset_id>.mp3"). A job's age sets its updated_at, which is when the app takes a running job to have started.
const mock=()=>{
 const w=window as any;w.isTauri=true;w.__jobs=[];w.__attention=[];w.__notified=[];w.__projects=[];w.__focus=false;w.__polls=0;
 document.hasFocus=()=>w.__focus;
 w.__job=(id:string,kind:string,status:string,age:number,payload:object={},project_id:string|null=null)=>({id,kind,project_id,payload,status,progress:0.5,error:null,result:null,created_at:new Date(Date.now()-age*1000).toISOString(),updated_at:new Date(Date.now()-age*1000).toISOString()});
 w.__TAURI_INTERNALS__={convertFileSrc:(p:string)=>p,transformCallback:()=>1,unregisterCallback:()=>{},metadata:{currentWindow:{label:'main'},currentWebview:{label:'main',windowLabel:'main'}},
  invoke:async(cmd:string,args:any)=>{switch(cmd){
   case 'plugin:window|request_user_attention':w.__attention.push(args.value);return null;
   case 'plugin:notification|notify':w.__notified.push(args.options);return null;
   case 'get_asset':return {id:args.id,path:'/audio/'+args.id,name:args.id+'.mp3',duration_ms:1000,sample_rate:16000};
   case 'list_jobs':w.__polls++;return JSON.parse(JSON.stringify(w.__jobs));
   case 'list_projects':return w.__projects;
   case 'list_voices':case 'list_models':return [];case 'get_settings':return {dictionary:{}};
   case 'runtime_status':return {python_ready:true,ffmpeg_ready:true,worker_ready:true,python_path:null,ffmpeg_path:null,message:''};
   default:return null;}}};
};
type Page=import('@playwright/test').Page;
const attention=(page:Page)=>page.evaluate(()=>(window as any).__attention as unknown[]);
const notified=(page:Page)=>page.evaluate(()=>(window as any).__notified as {title:string;body:string}[]);
const setJobs=(page:Page,list:[string,string,string,number,object?,string?][])=>page.evaluate(l=>{const w=window as any;w.__jobs=l.map(([id,kind,status,age,payload,project])=>w.__job(id,kind,status,age,payload,project));},list);
// Waits until the app has applied two polls of the current list (one may have been in flight when the list changed).
const settle=async(page:Page)=>{const n=await page.evaluate(()=>(window as any).__polls as number);await page.waitForFunction(k=>(window as any).__polls>=k,n+2,{timeout:10000});};

test('a long job that finishes while the window is in the background flashes the taskbar button once',async({page})=>{
 test.setTimeout(90000);
 await page.addInitScript(mock);await page.goto('/');
 await setJobs(page,[['a','stt','running',60]]);await settle(page);
 expect(await attention(page)).toEqual([]);
 await setJobs(page,[['a','stt','succeeded',0]]);
 await expect.poll(()=>attention(page),{timeout:8000}).toEqual([{type:'Informational'}]);
 // The same list on the next polls does not flash again.
 await settle(page);expect(await attention(page)).toHaveLength(1);
});

test('two long jobs that finish in the same poll flash the taskbar button once',async({page})=>{
 test.setTimeout(90000);
 await page.addInitScript(mock);await page.goto('/');
 await setJobs(page,[['a','stt','running',60],['b','render','running',60]]);await settle(page);
 await setJobs(page,[['a','stt','succeeded',0],['b','render','failed',0]]);
 await expect.poll(()=>attention(page),{timeout:8000}).not.toEqual([]);
 await settle(page);expect(await attention(page)).toHaveLength(1);
});

test('a job that finishes while the window has focus, or after a short run, or of another kind, does not flash',async({page})=>{
 test.setTimeout(90000);
 await page.addInitScript(mock);await page.goto('/');
 await page.evaluate(()=>{(window as any).__focus=true;});
 await setJobs(page,[['a','stt','running',60]]);await settle(page);
 await setJobs(page,[['a','stt','succeeded',0]]);await settle(page);
 await page.evaluate(()=>{(window as any).__focus=false;});
 await setJobs(page,[['b','render','running',5]]);await settle(page);
 await setJobs(page,[['b','render','succeeded',0]]);await settle(page);
 await setJobs(page,[['c','tts','running',60]]);await settle(page);
 await setJobs(page,[['c','tts','succeeded',0]]);await settle(page);
 expect(await attention(page)).toEqual([]);
});

test('a long transcription that finishes in the background raises one notification naming its file and how long it ran',async({page})=>{
 test.setTimeout(90000);
 await page.addInitScript(mock);await page.goto('/');
 await setJobs(page,[['phong-van','stt','running',60,{asset_id:'phong-van'}]]);await settle(page);
 expect(await notified(page)).toEqual([]);
 await setJobs(page,[['phong-van','stt','succeeded',0,{asset_id:'phong-van'}]]);
 await expect.poll(()=>notified(page),{timeout:8000}).toHaveLength(1);
 expect((await notified(page))[0]).toEqual({title:'Đã chép lời xong',body:expect.stringMatching(/^phong-van\.mp3 · 1 phút$/)});
 await settle(page);expect(await notified(page)).toHaveLength(1);
});

test('a long export that fails in the background raises a notification that points to the error',async({page})=>{
 test.setTimeout(90000);
 await page.addInitScript(mock);await page.goto('/');
 await setJobs(page,[['a','render','running',60,{name:'Chương 1'}]]);await settle(page);
 await setJobs(page,[['a','render','failed',0,{name:'Chương 1'}]]);
 await expect.poll(()=>notified(page),{timeout:8000}).toHaveLength(1);
 expect((await notified(page))[0]).toEqual({title:'Xuất audio không thành công',body:expect.stringMatching(/^Chương 1 · 1 phút · Mở Thanh Âm Studio để xem lỗi\.$/)});
});

test('two long jobs that finish in the same poll raise one notification that counts them',async({page})=>{
 test.setTimeout(90000);
 await page.addInitScript(mock);await page.goto('/');
 await setJobs(page,[['a','separate','running',60,{name:'nhac.mp3'}],['b','render','running',60,{name:'Chương 2'}]]);await settle(page);
 await setJobs(page,[['a','separate','succeeded',0,{name:'nhac.mp3'}],['b','render','failed',0,{name:'Chương 2'}]]);
 await expect.poll(()=>notified(page),{timeout:8000}).toHaveLength(1);
 expect((await notified(page))[0]).toEqual({title:'Đã xong 2 công việc',body:'Tách nhạc nền: nhac.mp3; Xuất audio: Chương 2'});
 await settle(page);expect(await notified(page)).toHaveLength(1);
});

test('no notification while the window has focus, after a short run, or for another kind of job',async({page})=>{
 test.setTimeout(90000);
 await page.addInitScript(mock);await page.goto('/');
 await page.evaluate(()=>{(window as any).__focus=true;});
 await setJobs(page,[['a','stt','running',60]]);await settle(page);
 await setJobs(page,[['a','stt','succeeded',0]]);await settle(page);
 await page.evaluate(()=>{(window as any).__focus=false;});
 await setJobs(page,[['b','render','running',5]]);await settle(page);
 await setJobs(page,[['b','render','succeeded',0]]);await settle(page);
 await setJobs(page,[['c','tts','running',60]]);await settle(page);
 await setJobs(page,[['c','tts','succeeded',0]]);await settle(page);
 expect(await notified(page)).toEqual([]);
});

test('a plain export with no name of its own is named after its project',async({page})=>{
 test.setTimeout(90000);
 await page.addInitScript(mock);await page.goto('/');
 await page.evaluate(()=>{(window as any).__projects=[{id:'p1',name:'Dự án A',updated_at:'2026-11-25T10:00:00Z',revision:1}];});
 await setJobs(page,[['a','render','running',60,{},'p1']]);await settle(page);
 await setJobs(page,[['a','render','succeeded',0,{},'p1']]);
 await expect.poll(()=>notified(page),{timeout:8000}).toHaveLength(1);
 expect((await notified(page))[0]).toEqual({title:'Đã xuất audio xong',body:expect.stringMatching(/^Dự án A · 1 phút$/)});
});
