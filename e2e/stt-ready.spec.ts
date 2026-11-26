import {test,expect} from '@playwright/test';
import type {Page} from '@playwright/test';
// The STT model follows what is installed: set on the first models load or when the selected one is not installed, never over an
// installed choice; with none installed the "Chọn tệp & chép lời" button is blocked with the reason. Tauri is mocked; `__install()`
// installs a model and `__downloading()` queues a download job, both seen by the next poll.
const NAMES:Record<string,string>={'vieneu-v3':'VieNeu v3 Turbo','whisper-small':'Whisper Small','whisper-turbo':'Whisper Large v3 Turbo',diarization:'Phân biệt người nói'};
const mock=({installed,names,total}:{installed:string[];names:Record<string,string>;total:number|null})=>{
 const w=window as any,have=new Set(installed),jobs:any[]=[],now='2026-11-27T00:00:00Z';w.isTauri=true;w.__polls=0;w.__sent=[];
 w.__install=(id:string)=>{have.add(id);};
 w.__downloading=(id:string)=>{jobs.push({id:'d1',kind:'model_download',project_id:null,payload:{model_id:id},status:'running',progress:0.3,error:null,result:null,created_at:now,updated_at:now});};
 w.__TAURI_INTERNALS__={convertFileSrc:(p:string)=>p,transformCallback:()=>1,unregisterCallback:()=>{},metadata:{currentWindow:{label:'main'},currentWebview:{label:'main',windowLabel:'main'}},
  invoke:async(cmd:string,args:any)=>{switch(cmd){
   case 'list_projects':case 'list_voices':return [];case 'list_jobs':return JSON.parse(JSON.stringify(jobs));case 'get_settings':return {dictionary:{}};
   case 'list_models':w.__polls++;return Object.keys(names).map(id=>({id,name:names[id],engine:id.startsWith('whisper')||id==='diarization'?'stt':'tts',kind:'model',installed:have.has(id),revision:'r',license:'',description:''}));
   case 'runtime_status':return {python_ready:true,ffmpeg_ready:true,worker_ready:true,native_worker_ready:true,python_path:null,ffmpeg_path:null,native_worker_path:null,fallback_count:0,total_memory_mb:total,message:''};
   case 'plugin:dialog|open':return 'C:\media\a.wav';
   case 'create_project':return {id:'p1',name:args.name,updated_at:now,revision:0,segments:[],transcript:[],dictionary:{},source_asset_id:null};
   case 'enqueue_job':w.__sent.push(args.kind);return {id:'j2',kind:args.kind,project_id:'p1',payload:args.payload,status:'queued',progress:0,error:null,result:null,created_at:now,updated_at:now};
   default:return null;}}};
};
const open=async(page:Page,installed:string[],total:number|null=7910)=>{
 await page.addInitScript(mock,{installed,names:NAMES,total});await page.goto('/');
 await page.getByRole('button',{name:'Chép lời',exact:true}).click();
};
const polled=(page:Page)=>page.evaluate(()=>(window as any).__polls as number);
const nextPoll=async(page:Page)=>{const n=await polled(page);await page.waitForFunction(k=>(window as any).__polls>k,n);};
const select=(page:Page)=>page.getByRole('combobox',{name:'Model STT'});
const go=(page:Page)=>page.getByRole('button',{name:'Chọn tệp & chép lời'});

test('only Turbo installed: Turbo is selected, even where Small is the recommended model',async({page})=>{
 await open(page,['whisper-turbo']);
 await expect(select(page)).toHaveValue('whisper-turbo');
 await expect(go(page)).not.toHaveAttribute('aria-disabled','true');
});
test('both installed: the recommended one is selected for the machine memory',async({page})=>{
 await open(page,['whisper-small','whisper-turbo'],15760);
 await expect(select(page)).toHaveValue('whisper-turbo');
});
test('a model the user picks stays picked when another model is installed later',async({page})=>{
 await open(page,['whisper-turbo']);
 await expect(select(page)).toHaveValue('whisper-turbo');
 await page.evaluate(()=>(window as any).__install('whisper-small'));await nextPoll(page);
 await select(page).selectOption('whisper-small');
 await page.evaluate(()=>(window as any).__install('diarization'));await nextPoll(page);await nextPoll(page);
 await expect(select(page)).toHaveValue('whisper-small');
});
test('none installed: the button is blocked with the reason and sends nothing, then says the download is running',async({page})=>{
 await open(page,[]);
 await expect(select(page)).toHaveValue('whisper-small');
 await expect(go(page)).toHaveAttribute('aria-disabled','true');
 await expect(go(page)).toHaveAccessibleDescription('Chưa tải model chép lời: tải Whisper Small trong Model & cài đặt.');
 await go(page).click({force:true});
 expect(await page.evaluate(()=>(window as any).__sent)).toEqual([]);
 await page.evaluate(()=>(window as any).__downloading('whisper-small'));
 await expect(go(page)).toHaveAccessibleDescription('Đang tải Whisper Small…');
});
test('review B: with none installed, the model that finishes installing is selected',async({page})=>{
 await open(page,[]);
 await expect(go(page)).toHaveAttribute('aria-disabled','true');
 await expect(select(page)).toHaveValue('whisper-small');
 await page.evaluate(()=>(window as any).__install('whisper-turbo'));await nextPoll(page);await nextPoll(page);
 await expect(select(page)).toHaveValue('whisper-turbo');
 await expect(go(page)).not.toHaveAttribute('aria-disabled','true');
});
