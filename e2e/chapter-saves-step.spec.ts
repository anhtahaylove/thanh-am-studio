import {test,expect} from '@playwright/test';
import type {Page} from '@playwright/test';
// The TTS checklist's step 3 ("Lưu file audio") also counts a chapter batch save: at least one file written by "Lưu tất cả chương" finishes it, a cancelled or fully failed batch does not,
// and the "saved x/y chapters" notice stays beside the step's announcement. Tauri is mocked; `__save` picks what the folder save does: 'ok' writes every file, 'skip' finds them all taken, 'fail' throws, 'cancel' closes the folder dialog.
type Mode='ok'|'skip'|'fail'|'cancel';
const mock=(mode:Mode)=>{
 const w=window as any,now='2026-11-28T00:00:00Z';w.isTauri=true;w.__calls=[];w.__save=mode;localStorage.setItem('thanh-am-start','hidden');
 const take=(id:string)=>({id,asset_id:'a'+id,path:id+'.wav',duration_ms:3000,sample_rate:48000,created_at:now});
 const seg=(i:number,chapter:string|null)=>({id:String(i+1),text:'Câu '+(i+1)+'.',normalized_text:'Câu '+(i+1)+'.',voice_id:null,speaker:'Người dẫn',gap_ms:300,takes:[take('t'+(i+1))],selected_take_id:'t'+(i+1),trim_start_ms:0,trim_end_ms:null,fade_in_ms:0,fade_out_ms:0,gain_db:0,chapter});
 let project:any=JSON.parse(localStorage.getItem('mock-project')||'null')??{id:'p1',name:'Chương',updated_at:now,revision:1,segments:[seg(0,'P1'),seg(1,null),seg(2,'P2')],transcript:[],dictionary:{},source_asset_id:null};
 const jobs:any[]=[];
 w.__TAURI_INTERNALS__={convertFileSrc:(p:string)=>p,transformCallback:()=>1,unregisterCallback:()=>{},metadata:{currentWindow:{label:'main'},currentWebview:{label:'main',windowLabel:'main'}},
  invoke:async(cmd:string,args:any)=>{w.__calls.push({cmd,args});switch(cmd){
   case 'list_projects':return [project];case 'load_project':return project;case 'list_voices':return [];case 'get_settings':return {dictionary:{}};
   case 'list_models':return [{id:'vieneu-v3',name:'VieNeu v3 Turbo',engine:'tts',kind:'model',installed:true,revision:'r',license:'',description:''}];
   case 'list_jobs':return [...jobs].reverse();
   case 'runtime_status':return {python_ready:true,ffmpeg_ready:true,worker_ready:true,native_worker_ready:true,python_path:null,ffmpeg_path:null,native_worker_path:null,fallback_count:0,total_memory_mb:null,message:''};
   case 'save_project':project={...args.project,revision:args.project.revision+1};localStorage.setItem('mock-project',JSON.stringify(project));return project;
   case 'enqueue_job':{const job={id:'j'+(jobs.length+1),kind:args.kind,project_id:args.projectId,payload:args.payload,status:'succeeded',progress:1,error:null,result:{asset_id:'r'+(jobs.length+1)},created_at:new Date(Date.now()+jobs.length).toISOString(),updated_at:now};jobs.push(job);return job;}
   case 'plugin:dialog|open':return w.__save==='cancel'?null:'C:\Xuất';
   case 'export_asset_new':if(w.__save==='fail')throw 'DISK_FULL';return w.__save==='ok';
   default:return null;}}};
};
const guide=(page:Page)=>page.locator('.first-run');
const saved=(page:Page)=>page.evaluate(()=>localStorage.getItem('thanh-am-onboarding-saved'));
const open=async(page:Page,mode:Mode)=>{await page.addInitScript(mock,mode);await page.goto('/');await page.getByRole('button',{name:'Dự án',exact:true}).click();await page.getByRole('button',{name:'Mở dự án',exact:true}).click();await page.getByText('Tùy chọn xuất',{exact:true}).click();};
// Renders one job per chapter, opens the queue and saves them all into a folder.
const saveAll=async(page:Page)=>{
 await page.getByRole('checkbox',{name:'Mỗi chương một file'}).check();await page.getByRole('button',{name:'Xuất audio'}).click();
 await page.getByRole('navigation',{name:'Điều hướng chính'}).getByRole('button',{name:/^Hàng đợi/}).click();
 await page.getByRole('button',{name:'Lưu tất cả chương'}).click();
};

test('a chapter batch save finishes step 3, keeps the chapter notice, and the step stays done after a reload',async({page})=>{
 await open(page,'ok');
 await expect(guide(page).getByText('Đã xong',{exact:true})).toHaveCount(1);
 await saveAll(page);
 const status=page.getByRole('status').filter({hasText:'chương'});
 await expect(status).toContainText('Đã lưu 2/2 chương.');await expect(status).toContainText('Đã xong bước 3: Lưu file audio');
 await expect.poll(()=>saved(page)).toBe('1');
 await page.reload();await expect(guide(page).getByText('Đã xong',{exact:true})).toHaveCount(2);
 await expect(guide(page).getByRole('button',{name:'Xuất ngay',exact:true})).toHaveCount(0);
});
for(const mode of ['fail','skip','cancel'] as const)test(`a chapter batch save that writes no file (${mode}) leaves step 3 not done`,async({page})=>{
 await open(page,mode);
 await saveAll(page);
 if(mode!=='cancel')await expect(page.getByRole('status').filter({hasText:'chương'})).toContainText('Đã lưu 0/2 chương.');
 await page.waitForTimeout(1000);
 await expect(guide(page).getByText('Đã xong',{exact:true})).toHaveCount(1);
 expect(await saved(page)).toBeNull();
});
