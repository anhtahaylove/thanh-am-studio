import {test,expect} from '@playwright/test';
import type {Page} from '@playwright/test';
// Round 1.0.26 F3: a transcription that finishes in the open project fills its empty transcript by itself, without a click and without
// leaving the page. Tauri is mocked: jobs start running or already succeeded, `__finish()` completes every running one (the next poll
// sees it), and every command is recorded in window.__calls.
type J={id:string;project?:string;asset?:string;at?:string;status?:'running'|'succeeded';rows:string[]};
type O={jobs:J[];rows?:string[];second?:boolean};
const mock=(o:O)=>{
 const w=window as any,calls:any[]=[],now='2026-11-27T00:00:00Z';w.isTauri=true;w.__calls=calls;
 const mk=(id:string,name:string,rows:string[])=>({id,name,updated_at:now,revision:1,segments:[],transcript:rows.map((text,i)=>({id:id+'r'+i,start_ms:i*1000,end_ms:i*1000+900,text})),dictionary:{},source_asset_id:'A'});
 const projects:Record<string,any>={p1:mk('p1','Dự án một',o.rows??[])};if(o.second)projects.p2=mk('p2','Dự án hai',[]);
 const result=(j:J)=>({segments:j.rows.map((text,i)=>({start:i,end:i+1,text}))});
 const jobs=o.jobs.map(j=>({id:j.id,kind:'stt',project_id:j.project??'p1',payload:{asset_id:j.asset??'A',model_id:'whisper-small'},status:j.status??'running',progress:j.status==='succeeded'?1:0.4,error:null,result:j.status==='succeeded'?result(j):null,created_at:j.at??now,updated_at:now,_rows:j.rows}));
 w.__finish=()=>{for(const j of jobs)if(j.status==='running'){j.status='succeeded';j.progress=1;(j as any).result={segments:j._rows.map((text:string,i:number)=>({start:i,end:i+1,text}))};}};
 w.__TAURI_INTERNALS__={convertFileSrc:(p:string)=>p,transformCallback:()=>1,unregisterCallback:()=>{},metadata:{currentWindow:{label:'main'},currentWebview:{label:'main',windowLabel:'main'}},
  invoke:async(cmd:string,args:any)=>{calls.push({cmd,args:JSON.parse(JSON.stringify(args??{}))});switch(cmd){
   case 'list_projects':return Object.values(projects).map((p:any)=>({id:p.id,name:p.name,updated_at:p.updated_at,revision:p.revision}));
   case 'load_project':return JSON.parse(JSON.stringify(projects[args.id]));
   case 'save_project':projects[args.project.id]={...args.project,revision:args.project.revision+1};return projects[args.project.id];
   case 'list_voices':case 'list_models':return [];case 'get_settings':return {dictionary:{}};
   case 'get_asset':return {id:args.id,path:args.id+'.wav',name:args.id+'.wav',duration_ms:5000,sample_rate:16000};
   case 'list_jobs':return JSON.parse(JSON.stringify([...jobs].reverse().map(({_rows,...j})=>j))); // a copy, as IPC gives: the app skips a poll that equals the last one
   case 'runtime_status':return {python_ready:true,ffmpeg_ready:true,worker_ready:true,python_path:null,ffmpeg_path:null,message:''};
   default:return null;}}};
};
const open=async(page:Page,o:O,to:'Chép lời'|'Hàng đợi'|null='Chép lời')=>{
 await page.addInitScript(mock,o);await page.goto('/');await page.getByRole('button',{name:'Dự án',exact:true}).click();
 await page.locator('.project-card',{hasText:'Dự án một'}).getByRole('button',{name:'Mở dự án',exact:true}).click();
 if(to)await nav(page,to).click();
};
// The Queue button's name carries the number of running jobs: "Hàng đợi (1)".
const nav=(page:Page,name:string)=>page.getByRole('button',{name:new RegExp(String.raw`^${name}( \(\d+\))?$`)});
const calls=(page:Page)=>page.evaluate(()=>(window as any).__calls as {cmd:string;args:any}[]);
const of=async(page:Page,cmd:string)=>(await calls(page)).filter(c=>c.cmd===cmd).map(c=>c.args);
const finish=(page:Page)=>page.evaluate(()=>(window as any).__finish());
// Two polls after the job finished: the app has seen the finished job and what its effect did with it.
const settle=async(page:Page)=>{const n=(await of(page,'list_jobs')).length;await expect.poll(async()=>(await of(page,'list_jobs')).length,{timeout:20000}).toBeGreaterThanOrEqual(n+2);};
const rows=(page:Page)=>page.getByLabel(/^Lời nói tại/);
const texts=(page:Page)=>rows(page).evaluateAll(els=>els.map(e=>(e as HTMLTextAreaElement).value));
const EMPTY='Chọn tệp để bắt đầu. Bản chép lời hiện ở đây khi xong.';

test('an empty transcript page says what to do and where the result shows up',async({page})=>{
 await open(page,{jobs:[]});
 await expect(page.getByText(EMPTY,{exact:true})).toBeVisible();
});

test('the transcript appears when the job finishes, with no click, on the page the user is on',async({page})=>{
 await open(page,{jobs:[{id:'j1',rows:['Xin chào','Tạm biệt']}]});
 await expect(rows(page)).toHaveCount(0);await finish(page);
 await expect(rows(page)).toHaveCount(2,{timeout:20000});expect(await texts(page)).toEqual(['Xin chào','Tạm biệt']);
 await expect(page.locator('main h1')).toContainText('Chép lời');await expect(page.getByText(EMPTY,{exact:true})).toHaveCount(0);
});

test('a job that finishes while another page is open fills the transcript without changing the page',async({page})=>{
 await open(page,{jobs:[{id:'j1',rows:['Một dòng']}]},'Hàng đợi');
 await expect(page.locator('main h1')).toContainText('Hàng đợi');await finish(page);await settle(page);
 await expect(page.locator('main h1')).toContainText('Hàng đợi');await expect(page.getByRole('button',{name:'Áp dụng transcript'})).toBeVisible();
 await nav(page,'Chép lời').click();
 await expect(rows(page)).toHaveCount(1);expect(await texts(page)).toEqual(['Một dòng']);
});

test('a job for another source is not applied',async({page})=>{
 await open(page,{jobs:[{id:'j1',asset:'B',rows:['Từ tệp khác']}]});
 await finish(page);await settle(page);
 await expect(rows(page)).toHaveCount(0);await expect(page.getByText(EMPTY,{exact:true})).toBeVisible();
});

test('a transcript that already has rows is not replaced',async({page})=>{
 await open(page,{jobs:[{id:'j1',rows:['Bản mới']}],rows:['Dòng có sẵn']});
 await finish(page);await settle(page);
 expect(await texts(page)).toEqual(['Dòng có sẵn']);
 expect((await of(page,'save_project')).filter(a=>a.project.transcript.some((t:any)=>t.text==='Bản mới'))).toEqual([]);
});

test('a job that finished before the app started is not applied again',async({page})=>{
 await open(page,{jobs:[{id:'j1',status:'succeeded',rows:['Đã xong từ trước']}]});
 await settle(page);
 await expect(rows(page)).toHaveCount(0);await expect(page.getByText(EMPTY,{exact:true})).toBeVisible();
});

test('a job that finishes while another project is open is not applied to it',async({page})=>{
 await open(page,{jobs:[{id:'j1',rows:['Của dự án một']}],second:true});
 await page.getByRole('button',{name:'Dự án',exact:true}).click();
 await page.locator('.project-card',{hasText:'Dự án hai'}).getByRole('button',{name:'Mở dự án',exact:true}).click();
 await nav(page,'Chép lời').click();
 await finish(page);await settle(page);
 await expect(rows(page)).toHaveCount(0);await expect(page.getByText(EMPTY,{exact:true})).toBeVisible();
 expect((await of(page,'save_project')).filter(a=>a.project.id==='p2'&&a.project.transcript.length)).toEqual([]);
});

test('two jobs for the same source: only the first is applied, the second finds rows',async({page})=>{
 await open(page,{jobs:[{id:'j1',at:'2026-11-27T00:00:00Z',rows:['Lần một']},{id:'j2',at:'2026-11-27T00:05:00Z',rows:['Lần hai a','Lần hai b']}]});
 await finish(page);
 await expect(rows(page)).toHaveCount(1,{timeout:20000});await settle(page);
 expect(await texts(page)).toEqual(['Lần một']);
});

test('the Queue button still applies a finished transcript by hand and opens the page',async({page})=>{
 await open(page,{jobs:[{id:'j1',status:'succeeded',rows:['Bấm tay']}]},'Hàng đợi');
 await page.getByRole('button',{name:'Áp dụng transcript'}).click();
 await expect(page.locator('main h1')).toContainText('Chép lời');await expect(rows(page)).toHaveCount(1);expect(await texts(page)).toEqual(['Bấm tay']);
});
