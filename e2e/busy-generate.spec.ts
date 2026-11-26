import {test,expect,type Page} from '@playwright/test';
// While a generate action is busy its button is natively `disabled`, so a double click cannot queue a second job. enqueue_job answers after
// 700 ms to keep the action busy; the recorded enqueue_job calls are the job count. Tauri is mocked as in take-diff.spec.ts.
const wav=()=>{const rate=8000,n=rate,b=Buffer.alloc(44+n*2);b.write('RIFF',0);b.writeUInt32LE(36+n*2,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(rate,24);b.writeUInt32LE(rate*2,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(n*2,40);return b;};
const mock=()=>{
 const w=window as any,calls:any[]=[],later=(ms:number)=>new Promise(r=>setTimeout(r,ms));w.isTauri=true;w.__calls=calls;w.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};
 const check={model:'whisper-small',wer:.2,heard:'kí tên vào đây',mismatches:[{expected:'ký',heard:'kí',soft:false}],words:[{text:'kí',start_ms:0},{text:'tên',start_ms:300}]};
 const take={id:'t1',asset_id:'a1',path:'/t1.wav',duration_ms:1000,sample_rate:8000,created_at:'2026-11-26T00:00:00Z',check};
 const project={id:'p1',name:'Bận',updated_at:'2026-11-26T00:00:00Z',revision:1,segments:[{id:'1',text:'Ký tên vào đây.',normalized_text:'Ký tên vào đây.',voice_id:null,speaker:'Người dẫn',gap_ms:300,takes:[take],selected_take_id:'t1',trim_start_ms:0,trim_end_ms:null,fade_in_ms:0,fade_out_ms:0,gain_db:0}],transcript:[],dictionary:{},source_asset_id:null};
 w.__TAURI_INTERNALS__={convertFileSrc:(p:string)=>p,transformCallback:()=>1,unregisterCallback:()=>{},metadata:{currentWindow:{label:'main'},currentWebview:{label:'main',windowLabel:'main'}},
  invoke:async(cmd:string,args:any)=>{calls.push({cmd,args});switch(cmd){
   case 'list_projects':return [project];case 'load_project':return JSON.parse(JSON.stringify(project));case 'list_voices':case 'list_jobs':return [];case 'get_settings':return {dictionary:{}};
   case 'list_models':return [{id:'vieneu-v3',name:'VieNeu v3 Turbo',engine:'tts',installed:true,revision:'r',license:'Apache-2.0',description:''}];
   case 'runtime_status':return {python_ready:true,ffmpeg_ready:true,worker_ready:true,python_path:null,ffmpeg_path:null,message:''};
   case 'save_project':return {...args.project,revision:args.project.revision+1};
   case 'enqueue_job':await later(700);return {id:'j'+calls.length,kind:args.kind,project_id:args.projectId,payload:args.payload,status:'queued',progress:0,error:null,result:null,created_at:'2026-11-26T00:00:02Z',updated_at:'2026-11-26T00:00:02Z'};
   default:return null;}}};
};
const open=async(page:Page)=>{
 await page.route('**/t1.wav',r=>r.fulfill({body:wav(),contentType:'audio/wav'}));await page.addInitScript(mock);await page.goto('/');
 await page.getByRole('button',{name:'Dự án',exact:true}).click();await page.getByRole('button',{name:'Mở dự án',exact:true}).click();
 await expect(page.getByRole('textbox',{name:'Nội dung đoạn 1'})).toBeVisible();
};
const enqueued=(page:Page)=>page.evaluate(()=>(window as any).__calls.filter((x:any)=>x.cmd==='enqueue_job').length as number);

test('"Tạo giọng tất cả" is natively disabled while it is busy: a double click queues one job',async({page})=>{
 await open(page);const all=page.getByRole('button',{name:'Tạo giọng tất cả',exact:true});
 await expect(all).toBeEnabled();await all.dblclick();
 await expect(all).toBeDisabled();await expect(all).not.toHaveAttribute('aria-disabled','true');
 await expect(all).toBeEnabled();expect(await enqueued(page)).toBe(1);
});
test('"Tạo take mới" in the take dialog is natively disabled while it is busy: a double click queues one job',async({page})=>{
 await open(page);await page.locator('.segment .take-check').first().click();
 const again=page.getByRole('dialog').getByRole('button',{name:'Tạo take mới'});
 await expect(again).toBeEnabled();await again.dblclick();
 await expect(again).toBeDisabled();await expect(again).not.toHaveAttribute('aria-disabled','true');
 await expect(page.getByRole('dialog')).toHaveCount(0);expect(await enqueued(page)).toBe(1);
});
