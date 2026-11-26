import {test,expect,type Page} from '@playwright/test';
// Replacing the project content (restoring a version, "Tải lại để nhận take mới") clears the highlighted transcript row (activeRow)
// and, only when the source file changed, the "Giữ nhạc nền" choice (keepBg): the separated stem belongs to the source, so it stays valid for the same one.
// Tauri is mocked as in keep-background.spec.ts; window.__disk is the stored project, window.__calls records every command.
const mock=()=>{
 const w=window as any,calls:any[]=[],jobs:any[]=[];w.isTauri=true;w.__calls=calls;
 const take=(id:string)=>({id,asset_id:'a'+id,path:id+'.wav',duration_ms:3000,sample_rate:48000,created_at:new Date().toISOString()});
 const seg=(id:string,cue:number)=>({id,text:'Câu '+id+'.',normalized_text:'Câu '+id+'.',voice_id:null,speaker:'Người dẫn',gap_ms:300,takes:[take('t'+id)],selected_take_id:'t'+id,trim_start_ms:0,trim_end_ms:null,fade_in_ms:0,fade_out_ms:0,gain_db:0,cue_start_ms:cue,cue_end_ms:cue+2000});
 w.__disk={id:'p1',name:'Lồng tiếng',updated_at:new Date().toISOString(),revision:1,segments:[seg('1',0),seg('2',2000)],transcript:[{id:'r1',start_ms:0,end_ms:2000,text:'Dòng một.'},{id:'r2',start_ms:2000,end_ms:4000,text:'Dòng hai.'}],dictionary:{},source_asset_id:'src'};
 jobs.push({id:'sep',kind:'separate',project_id:'p1',payload:{asset_id:'src'},status:'succeeded',progress:1,error:null,result:{asset_id:'stem',path:'C:\\assets\\stem.flac'},created_at:new Date(1).toISOString(),updated_at:new Date(1).toISOString()},{id:'tts1',kind:'tts',project_id:'p1',payload:{segment_id:'1'},status:'succeeded',progress:1,error:null,result:null,created_at:new Date(2).toISOString(),updated_at:new Date(2).toISOString()});
 const at=(h:number)=>new Date(Date.now()-h*3600000).toISOString();
 w.__TAURI_INTERNALS__={convertFileSrc:(p:string)=>p,transformCallback:()=>1,unregisterCallback:()=>{},metadata:{currentWindow:{label:'main'},currentWebview:{label:'main',windowLabel:'main'}},
  invoke:async(cmd:string,args:any)=>{calls.push({cmd,args});const disk=()=>structuredClone(w.__disk);switch(cmd){
   case 'list_projects':return [{id:'p1',name:'Lồng tiếng',updated_at:w.__disk.updated_at,revision:w.__disk.revision}];case 'load_project':return disk();case 'list_voices':return [];case 'get_settings':return {dictionary:{}};
   case 'list_models':return [{id:'htdemucs',name:'Tách giọng và nhạc nền (HTDemucs)',engine:'separation',installed:true,revision:'r',license:'',description:''},{id:'separation-runtime',name:'Gói chạy tách nhạc nền (Python + PyTorch)',engine:'runtime',kind:'runtime',installed:true,revision:'separation-v1',license:'',description:''}];
   case 'list_jobs':return [...jobs].reverse();
   case 'runtime_status':return {python_ready:true,ffmpeg_ready:true,worker_ready:true,python_path:null,ffmpeg_path:null,message:''};
   case 'get_asset':return {id:args.id,path:`C:\\media\\${args.id}.mp4`,name:'nguồn.mp4',duration_ms:null,sample_rate:null};
   case 'save_project':w.__disk={...args.project,revision:args.project.revision+1};return disk();
   case 'list_project_versions':return [{id:'v1',state_at:at(2),reason:'auto',segments:2,transcript:2,content:[['1','Câu 1.'],['2','Câu 2.']]}];
   case 'restore_project_version':w.__disk={...w.__disk,source_asset_id:'src2',revision:w.__disk.revision+1};return disk();
   case 'enqueue_job':return {id:'j'+(jobs.length+1),kind:args.kind,project_id:args.projectId,payload:args.payload,status:'queued',progress:0,error:null,result:null,created_at:new Date().toISOString(),updated_at:new Date().toISOString()};
   case 'plugin:dialog|save':return 'C:/x/ban-xuat.wav';default:return null;}}};
};
const keep=(page:Page)=>page.getByRole('checkbox',{name:'Giữ nhạc nền'});
const activeRows=(page:Page)=>page.locator('.transcript-row.active');
// With the project open: dub and background on, and the first transcript row highlighted.
const prepare=async(page:Page)=>{
 await page.addInitScript(mock);await page.goto('/');await page.getByRole('button',{name:'Dự án',exact:true}).click();await page.getByRole('button',{name:'Mở dự án',exact:true}).click();
 await page.getByRole('checkbox',{name:'Theo mốc phụ đề'}).check();await keep(page).click();await expect(keep(page)).toBeChecked();
 await page.getByRole('button',{name:'Chép lời',exact:true}).click();await page.locator('.transcript-row').first().locator('.tr-time').focus();await expect(activeRows(page)).toHaveCount(1);
 await page.getByRole('button',{name:'Tạo giọng đọc',exact:true}).click();
};
const replaced=async(page:Page)=>{
 await expect(keep(page)).not.toBeChecked();
 await page.getByRole('button',{name:'Xuất audio'}).click();
 await expect.poll(()=>page.evaluate(()=>(window as any).__calls.filter((c:any)=>c.cmd==='enqueue_job').length)).toBe(1);
 const job=await page.evaluate(()=>(window as any).__calls.find((c:any)=>c.cmd==='enqueue_job').args);
 expect(job.kind).toBe('render');expect(job.payload.background_asset_id).toBeUndefined();
 await page.getByRole('button',{name:'Tạo giọng đọc',exact:true}).click();await page.getByRole('button',{name:'Chép lời',exact:true}).click();
 await expect(activeRows(page)).toHaveCount(0);
};

test('restoring a version with a different source clears the background choice and the highlighted transcript row',async({page})=>{
 await prepare(page);
 await page.getByRole('button',{name:'Lịch sử phiên bản',exact:true}).click();
 await page.getByRole('dialog',{name:'Lịch sử phiên bản'}).getByRole('button',{name:/^Khôi phục trạng thái lúc/}).click();
 await expect(page.getByRole('dialog',{name:'Lịch sử phiên bản'})).toHaveCount(0);
 await replaced(page);
});

test('reloading from disk with a different source clears the background choice and the highlighted transcript row',async({page})=>{
 await prepare(page);
 await page.evaluate(()=>{(window as any).__disk.source_asset_id='src2';});
 await page.getByRole('button',{name:'Tải lại để nhận take mới'}).click();
 await replaced(page);
});

// The normal case: the source is unchanged, so the stem still fits and the export keeps the background.
const kept=async(page:Page)=>{
 await expect(keep(page)).toBeChecked();
 await page.getByRole('button',{name:'Xuất audio'}).click();
 await expect.poll(()=>page.evaluate(()=>(window as any).__calls.filter((c:any)=>c.cmd==='enqueue_job').length)).toBe(1);
 const job=await page.evaluate(()=>(window as any).__calls.find((c:any)=>c.cmd==='enqueue_job').args);
 expect(job.kind).toBe('render');expect(job.payload.background_asset_id).toBe('stem');
 await page.getByRole('button',{name:'Tạo giọng đọc',exact:true}).click();await page.getByRole('button',{name:'Chép lời',exact:true}).click();
 await expect(activeRows(page)).toHaveCount(0);
};

test('reloading from disk with the same source keeps the background choice and clears the highlighted row',async({page})=>{
 await prepare(page);
 await page.getByRole('button',{name:'Tải lại để nhận take mới'}).click();
 await expect(page.getByText('Đã tải lại')).toBeVisible();
 await kept(page);
});

test('restoring a version with the same source keeps the background choice and clears the highlighted row',async({page})=>{
 await prepare(page);
 await page.evaluate(()=>{const w=window as any,orig=w.__TAURI_INTERNALS__.invoke;w.__TAURI_INTERNALS__.invoke=async(c:string,a:any)=>{if(c!=='restore_project_version')return orig(c,a);w.__calls.push({cmd:c,args:a});w.__disk={...w.__disk,revision:w.__disk.revision+1};return structuredClone(w.__disk);};});
 await page.getByRole('button',{name:'Lịch sử phiên bản',exact:true}).click();
 await page.getByRole('dialog',{name:'Lịch sử phiên bản'}).getByRole('button',{name:/^Khôi phục trạng thái lúc/}).click();
 await expect(page.getByRole('dialog',{name:'Lịch sử phiên bản'})).toHaveCount(0);
 await kept(page);
});
