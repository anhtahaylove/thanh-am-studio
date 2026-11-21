import {test,expect} from '@playwright/test';
// Tauri is mocked as in review-followups.spec.ts: the job list is whatever window.__jobs holds, and window.__bar records every set_progress_bar call.
const mock=()=>{
 const w=window as any;w.isTauri=true;w.__jobs=[];w.__bar=[];
 const now='2026-11-21T00:00:00Z',job=(id:string,status:string,progress:number)=>({id,kind:'tts',project_id:null,payload:{},status,progress,error:null,result:null,created_at:now,updated_at:now});
 w.__job=job;
 w.__TAURI_INTERNALS__={convertFileSrc:(p:string)=>p,transformCallback:()=>1,unregisterCallback:()=>{},metadata:{currentWindow:{label:'main'},currentWebview:{label:'main',windowLabel:'main'}},
  invoke:async(cmd:string,args:any)=>{switch(cmd){
   case 'plugin:window|set_progress_bar':w.__bar.push({label:args.label,...args.value});return null;
   case 'list_jobs':return JSON.parse(JSON.stringify(w.__jobs));
   case 'list_projects':case 'list_voices':case 'list_models':return [];case 'get_settings':return {dictionary:{}};
   case 'runtime_status':return {python_ready:true,ffmpeg_ready:true,worker_ready:true,python_path:null,ffmpeg_path:null,message:''};
   default:return null;}}};
};
type Page=import('@playwright/test').Page;
const last=(page:Page)=>page.evaluate(()=>{const b=(window as any).__bar as any[];return b.length?b[b.length-1]:null;});
const calls=(page:Page)=>page.evaluate(()=>(window as any).__bar.length as number);
const jobs=(page:Page,list:[string,string,number][])=>page.evaluate(l=>{const w=window as any;w.__jobs=l.map(([id,s,p])=>w.__job(id,s,p));},list);

test('the taskbar shows the average progress of running jobs, indeterminate while unknown, and clears when idle',async({page})=>{
 test.setTimeout(90000);
 await page.addInitScript(mock);await page.goto('/');
 await expect.poll(()=>last(page)).toEqual({label:'main',status:'none'});
 await jobs(page,[['a','running',0.5],['b','running',0.3],['c','succeeded',1]]);
 await expect.poll(()=>last(page),{timeout:8000}).toEqual({label:'main',status:'normal',progress:40});
 // The same list on the next poll sends nothing.
 const n=await calls(page);await page.waitForTimeout(2800);expect(await calls(page)).toBe(n);
 await jobs(page,[['a','running',0]]);
 await expect.poll(()=>last(page),{timeout:8000}).toEqual({label:'main',status:'indeterminate'});
 await jobs(page,[['a','succeeded',1]]);
 await expect.poll(()=>last(page),{timeout:8000}).toEqual({label:'main',status:'none'});
});
