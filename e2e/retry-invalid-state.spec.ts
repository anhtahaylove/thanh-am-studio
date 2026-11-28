import {test,expect} from '@playwright/test';
import type {Page} from '@playwright/test';
// Round 1.0.28: a retry the backend rejects with INVALID_JOB_STATE (the job was already re-run or finished, so it is not failed, cancelled or interrupted any more) shows a
// Vietnamese sentence instead of the raw code, and the jobs are refreshed so the row or strip shows the real state. Covered for both retry callers: the queue drawer "Thử lại"
// and the start strip "Tải tiếp". Tauri is mocked: retry_job moves the job to its newer state and rejects with the bare code, as the host does; list_jobs counts its calls.
// The poll runs every 2.5 s, so each test clicks right after a poll and asserts within 1.5 s: only a refresh caused by the click can pass.
type Case={name:string;job:object;open:(page:Page)=>Promise<void>;button:(page:Page)=>ReturnType<Page['getByRole']>;shown:(page:Page)=>Promise<void>};
const TEXT='Việc này đã được chạy lại hoặc đã xong nên không cần thử lại. Danh sách đã được làm mới.';
const mock=(d:{job:object;after:string})=>{
 const w=window as any,now='2026-11-28T00:00:00Z',ipc=(v:unknown)=>JSON.parse(JSON.stringify(v));w.isTauri=true;w.__polls=0;w.__retries=0;
 const jobs=[{id:'j0',project_id:null,payload:{},status:'failed',progress:0.4,error:null,result:null,created_at:now,updated_at:now,...d.job}];
 w.__TAURI_INTERNALS__={convertFileSrc:(p:string)=>p,transformCallback:()=>1,unregisterCallback:()=>{},metadata:{currentWindow:{label:'main'},currentWebview:{label:'main',windowLabel:'main'}},
  invoke:async(cmd:string)=>{switch(cmd){
   case 'list_jobs':w.__polls++;return ipc(jobs);
   case 'retry_job':w.__retries++;jobs[0].status=d.after;throw 'INVALID_JOB_STATE';
   case 'list_projects':return [{id:'p0',name:'Dự án đầu tiên',updated_at:now,revision:1}];
   case 'list_voices':return [];case 'get_settings':return {dictionary:{}};
   case 'list_models':return [{id:'vieneu-v3',name:'VieNeu v3 Turbo',engine:'tts',kind:'model',installed:false,revision:'r1abcdef0123456',license:'Apache-2.0',description:''}];
   case 'runtime_status':return {python_ready:true,ffmpeg_ready:true,worker_ready:true,native_worker_ready:true,python_path:null,ffmpeg_path:null,native_worker_path:null,fallback_count:0,total_memory_mb:null,message:''};
   default:return null;}}};
};
const polls=(page:Page)=>page.evaluate(()=>(window as any).__polls as number);
const heading=(page:Page)=>page.locator('.start-panel h2');
const cases:Case[]=[
 {name:'queue drawer Thử lại',job:{kind:'tts',payload:{text:'Câu một.'},status:'failed',error:'x'},
  open:async page=>{await page.getByRole('navigation',{name:'Điều hướng chính'}).getByRole('button',{name:/^Hàng đợi/}).click();await expect(page.getByRole('complementary',{name:'Hàng đợi'}).getByRole('button',{name:'Thử lại'})).toBeVisible();},
  button:page=>page.getByRole('complementary',{name:'Hàng đợi'}).getByRole('button',{name:'Thử lại'}),
  shown:async page=>{await expect(page.locator('.job-row .status'),'the row shows the job as running').toHaveText('Đang xử lý',{timeout:1500});await expect(page.getByRole('button',{name:'Thử lại'})).toHaveCount(0);}},
 {name:'start strip Tải tiếp',job:{kind:'model_download',payload:{model_id:'vieneu-v3'},status:'interrupted'},
  open:async page=>{await expect(heading(page)).toHaveAccessibleName('Bước 2/3 Tải VieNeu v3 Turbo bị gián đoạn.');},
  button:page=>page.locator('.start-panel').getByRole('button',{name:'Tải tiếp',exact:true}),
  shown:async page=>{await expect(heading(page),'the strip shows the download as running').toHaveAccessibleName('Bước 2/3 Đang tải VieNeu v3 Turbo…',{timeout:1500});await expect(page.getByRole('button',{name:'Tải tiếp'})).toHaveCount(0);}}];
for(const c of cases){
 const click=async(page:Page)=>{
  await page.addInitScript(mock,{job:c.job,after:'running'});await page.goto('/');await c.open(page);
  const n=await polls(page);await page.waitForFunction(k=>(window as any).__polls>k,n);
  const before=await polls(page);await c.button(page).click();return before;};
 test(`${c.name}: a retry rejected with INVALID_JOB_STATE shows the plain sentence in the error alert`,async({page})=>{
  await click(page);
  await expect(page.getByRole('alert').locator('p')).toHaveText(TEXT,{timeout:1500});
  expect(await page.evaluate(()=>(window as any).__retries)).toBe(1);
 });
 test(`${c.name}: a retry rejected with INVALID_JOB_STATE refreshes the jobs and shows the new state`,async({page})=>{
  const before=await click(page);
  await expect.poll(()=>polls(page),{timeout:1500}).toBeGreaterThan(before);
  await c.shown(page);
 });
}
