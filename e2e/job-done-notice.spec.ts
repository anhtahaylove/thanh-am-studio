import {test,expect} from '@playwright/test';
// Tauri is mocked as in taskbar-progress.spec.ts: the job list is whatever window.__jobs holds, window.__focus is what document.hasFocus() answers,
// and window.__attention records every request_user_attention call. A job's age sets its updated_at, which is when the app takes a running job to have started.
const mock=()=>{
 const w=window as any;w.isTauri=true;w.__jobs=[];w.__attention=[];w.__focus=false;w.__polls=0;
 document.hasFocus=()=>w.__focus;
 w.__job=(id:string,kind:string,status:string,age:number)=>({id,kind,project_id:null,payload:{},status,progress:0.5,error:null,result:null,created_at:new Date(Date.now()-age*1000).toISOString(),updated_at:new Date(Date.now()-age*1000).toISOString()});
 w.__TAURI_INTERNALS__={convertFileSrc:(p:string)=>p,transformCallback:()=>1,unregisterCallback:()=>{},metadata:{currentWindow:{label:'main'},currentWebview:{label:'main',windowLabel:'main'}},
  invoke:async(cmd:string,args:any)=>{switch(cmd){
   case 'plugin:window|request_user_attention':w.__attention.push(args.value);return null;
   case 'list_jobs':w.__polls++;return JSON.parse(JSON.stringify(w.__jobs));
   case 'list_projects':case 'list_voices':case 'list_models':return [];case 'get_settings':return {dictionary:{}};
   case 'runtime_status':return {python_ready:true,ffmpeg_ready:true,worker_ready:true,python_path:null,ffmpeg_path:null,message:''};
   default:return null;}}};
};
type Page=import('@playwright/test').Page;
const attention=(page:Page)=>page.evaluate(()=>(window as any).__attention as unknown[]);
const setJobs=(page:Page,list:[string,string,string,number][])=>page.evaluate(l=>{const w=window as any;w.__jobs=l.map(([id,kind,status,age])=>w.__job(id,kind,status,age));},list);
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
