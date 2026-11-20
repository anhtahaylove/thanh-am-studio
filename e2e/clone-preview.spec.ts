import {test,expect} from '@playwright/test';
import {readFileSync} from 'node:fs';
const version=JSON.parse(readFileSync('package.json','utf8')).version;
// Tauri is mocked as in chapters.spec.ts; enqueued jobs stay queued until the test moves them on, and play() records the source.
const mock=(o:{voiceModel:boolean;jobs?:any[]})=>{
 const w=window as any,calls:any[]=[],jobs:any[]=o.jobs??[];w.isTauri=true;w.__calls=calls;w.__jobs=jobs;w.__played=[];
 HTMLMediaElement.prototype.play=function(){w.__played.push(this.getAttribute('src'));return Promise.resolve();};
 w.__TAURI_INTERNALS__={convertFileSrc:(p:string)=>p,transformCallback:()=>1,unregisterCallback:()=>{},metadata:{currentWindow:{label:'main'},currentWebview:{label:'main',windowLabel:'main'}},
  invoke:async(cmd:string,args:any)=>{calls.push({cmd,args});switch(cmd){
   case 'list_projects':case 'list_voices':return [];case 'get_settings':return {dictionary:{}};
   case 'list_models':return o.voiceModel?[{id:'vieneu-v3',name:'VieNeu v3 Turbo',engine:'tts',installed:true,revision:'r',license:'Apache-2.0',description:''}]:[];
   case 'list_jobs':return structuredClone([...jobs].reverse()); // a copy, as real IPC answers are: setJob edits the stored job in place
   case 'runtime_status':return {python_ready:true,ffmpeg_ready:true,worker_ready:true,python_path:null,ffmpeg_path:null,message:''};
   case 'plugin:dialog|open':return 'C:\\mẫu giọng.wav';
   case 'import_asset':return {id:'a1',path:'C:\\assets\\a1.wav',name:'mẫu giọng.wav',duration_ms:null,sample_rate:null};
   case 'enqueue_job':{const job={id:'j'+(jobs.length+1),kind:args.kind,project_id:args.projectId,payload:args.payload,status:'queued',progress:0,error:null,result:null,created_at:new Date(Date.now()+jobs.length).toISOString(),updated_at:new Date().toISOString()};jobs.push(job);return job;}
   default:return null;}}};
};
const calls=(page:any,cmd:string)=>page.evaluate((c:string)=>(window as any).__calls.filter((x:any)=>x.cmd===c).map((x:any)=>x.args),cmd);
const setJob=(page:any,patch:object)=>page.evaluate((p:object)=>Object.assign((window as any).__jobs.at(-1),p),patch);
const pickSample=async(page:any,o:{voiceModel:boolean;jobs?:any[]})=>{
 await page.addInitScript(mock,o);await page.goto('/');
 await page.getByRole('navigation',{name:'Điều hướng chính'}).getByRole('button',{name:'Thư viện giọng'}).click();
 await page.getByRole('button',{name:'Chọn mẫu audio'}).click();await expect(page.getByRole('button',{name:'mẫu giọng.wav'})).toBeVisible();
};

test('the cleaned sample is made once in the queue, plays when it is ready, and plays again without a new job',async({page})=>{
 await page.addInitScript(mock,{voiceModel:true});await page.goto('/');
 await page.getByRole('navigation',{name:'Điều hướng chính'}).getByRole('button',{name:'Thư viện giọng'}).click();
 const listen=page.getByRole('button',{name:'Nghe mẫu đã làm sạch'});
 await expect(listen).toBeDisabled(); // no sample yet
 await expect(page.getByText('Chỉ dùng 8 giây có âm thanh to và liền mạch nhất của mẫu (nhạc hoặc tiếng ồn to cũng có thể được chọn), đã lọc ồn. Nghe thử: nếu còn nhạc, tiếng ồn hoặc giọng khác, hãy chọn mẫu khác.')).toBeVisible();
 await page.getByRole('button',{name:'Chọn mẫu audio'}).click();await expect(page.getByRole('button',{name:'mẫu giọng.wav'})).toBeVisible();
 await listen.click(); // no consent needed: nothing is cloned
 expect(await calls(page,'enqueue_job')).toEqual([{kind:'clone_preview',projectId:null,payload:{asset_id:'a1',name:'mẫu giọng.wav',version}}]);
 await expect(page.getByRole('button',{name:'Đang chờ hàng đợi…'})).toBeDisabled();
 await setJob(page,{status:'running',progress:0.5});
 await expect(page.getByRole('button',{name:'Đang làm sạch…'})).toBeVisible();
 expect(await page.evaluate(()=>(window as any).__played)).toEqual([]);
 await setJob(page,{status:'succeeded',progress:1,result:{asset_id:'r1',path:'C:\\assets\\r1.wav',duration_ms:8000,sample_rate:44100}});
 await expect.poll(()=>page.evaluate(()=>(window as any).__played)).toEqual(['C:\\assets\\r1.wav']);
 await expect(listen).toBeEnabled();await listen.click();
 await expect.poll(()=>page.evaluate(()=>(window as any).__played)).toEqual(['C:\\assets\\r1.wav','C:\\assets\\r1.wav']);
 expect(await calls(page,'enqueue_job')).toHaveLength(1);
});

test('a preview made by another app version is not reused',async({page})=>{
 const old={id:'j0',kind:'clone_preview',project_id:null,payload:{asset_id:'a1',name:'mẫu giọng.wav',version:'0.0.1'},status:'succeeded',progress:1,error:null,result:{asset_id:'r0',path:'C:\\assets\\r0.wav'},created_at:new Date(0).toISOString(),updated_at:new Date(0).toISOString()};
 await pickSample(page,{voiceModel:true,jobs:[old]});
 await page.getByRole('button',{name:'Nghe mẫu đã làm sạch'}).click();
 await expect.poll(async()=>(await calls(page,'enqueue_job')).map((a:any)=>a.payload.version)).toEqual([version]);
 expect(await page.evaluate(()=>(window as any).__played)).toEqual([]);
});

test('without the VieNeu model the button is off and says where to get it',async({page})=>{
 await pickSample(page,{voiceModel:false});
 const listen=page.getByRole('button',{name:'Nghe mẫu đã làm sạch'});
 await expect(listen).toBeDisabled();await expect(listen).toHaveAttribute('title','Tải VieNeu v3 Turbo trong Model & cài đặt để bật');
});
