import {test,expect} from '@playwright/test';
import type {Page} from '@playwright/test';
// A queued download has no progress yet: the model card, the checklist step and the start strip show "Đang chờ…" and no bar; a running one keeps its bar.
// Tauri is mocked: one starter model (VieNeu) and one download job of the given status.
const mock=({status,stored}:{status:string;stored:string})=>{
 const w=window as any,now=new Date().toISOString();
 if(stored)localStorage.setItem('thanh-am-start',stored);
 const jobs=[{id:'dl0',kind:'model_download',project_id:null,payload:{model_id:'vieneu-v3'},status,progress:status==='running'?0.4:0,error:null,result:null,created_at:now,updated_at:now}];
 w.isTauri=true;
 w.__TAURI_INTERNALS__={convertFileSrc:(p:string)=>p,transformCallback:()=>1,unregisterCallback:()=>{},metadata:{currentWindow:{label:'main'},currentWebview:{label:'main',windowLabel:'main'}},
  invoke:async(cmd:string)=>{switch(cmd){
   case 'list_projects':case 'list_voices':return [];case 'list_jobs':return jobs;case 'get_settings':return {dictionary:{},worker_engines:{}};
   case 'list_models':return [{id:'vieneu-v3',name:'VieNeu v3 Turbo',engine:'tts',kind:'model',installed:false,revision:'9f8e7d6c5b4a3921',license:'MIT',description:'Mô tả ngắn của model.'}];
   case 'runtime_status':return {python_ready:true,ffmpeg_ready:true,worker_ready:true,native_worker_ready:true,python_path:null,ffmpeg_path:null,native_worker_path:null,fallback_count:0,total_memory_mb:7910,message:'Runtime đã tìm thấy.'};
   default:return null;}}};
};
const open=async(page:Page,status:string,stored:string)=>{await page.addInitScript(mock,{status,stored});await page.goto('/');};
// The progress area of a download: the bar (if any) and its label, inside the surface that holds it.
const check=async(page:Page,where:string,status:string)=>{
 const area=page.locator(where),label=area.locator('.job-progress');
 await expect(label).toBeVisible();
 if(status==='queued'){await expect(label).toHaveText('Đang chờ…');await expect(area.getByRole('progressbar')).toHaveCount(0);}
 else{await expect(label).not.toHaveText('Đang chờ…');await expect(area.getByRole('progressbar')).toHaveCount(1);}
};
for(const status of ['queued','running']){
 test(`model card: a ${status} download ${status==='queued'?'shows no bar and Đang chờ…':'keeps its bar'}`,async({page})=>{
  await open(page,status,'hidden');
  await page.getByRole('navigation',{name:'Điều hướng chính'}).getByRole('button',{name:'Model & cài đặt',exact:true}).click();
  await check(page,'.model-card',status);
 });
 test(`checklist: a ${status} download ${status==='queued'?'shows no bar and Đang chờ…':'keeps its bar'}`,async({page})=>{
  await open(page,status,'hidden');
  await check(page,'.first-run',status);
 });
 test(`start strip: a ${status} download ${status==='queued'?'shows no bar and Đang chờ…':'keeps its bar'}`,async({page})=>{
  await open(page,status,'');
  await expect(page.locator('.start-strip')).toBeVisible();
  await check(page,'.start-strip',status);
 });
}
