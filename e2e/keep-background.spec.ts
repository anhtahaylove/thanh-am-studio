import {test,expect} from '@playwright/test';
// Tauri is mocked as in clone-preview.spec.ts: every command is recorded in window.__calls, enqueued jobs stay queued.
const mock=(o:{model:boolean;source:string|null;cues?:boolean;jobs?:any[]})=>{
 const w=window as any,calls:any[]=[],jobs:any[]=o.jobs??[];w.isTauri=true;w.__calls=calls;w.__jobs=jobs;
 const take=(id:string)=>({id,asset_id:'a'+id,path:id+'.wav',duration_ms:3000,sample_rate:48000,created_at:new Date().toISOString()});
 const seg=(id:string,cue:number)=>({id,text:'Câu '+id+'.',normalized_text:'Câu '+id+'.',voice_id:null,speaker:'Người dẫn',gap_ms:300,takes:[take('t'+id)],selected_take_id:'t'+id,trim_start_ms:0,trim_end_ms:null,fade_in_ms:0,fade_out_ms:0,gain_db:0,...(o.cues===false?{}:{cue_start_ms:cue,cue_end_ms:cue+2000})});
 let project={id:'p1',name:'Lồng tiếng',updated_at:new Date().toISOString(),revision:1,segments:[seg('1',0),seg('2',2000)],transcript:[],dictionary:{},source_asset_id:o.source};
 w.__TAURI_INTERNALS__={convertFileSrc:(p:string)=>p,transformCallback:()=>1,unregisterCallback:()=>{},metadata:{currentWindow:{label:'main'},currentWebview:{label:'main',windowLabel:'main'}},
  invoke:async(cmd:string,args:any)=>{calls.push({cmd,args});switch(cmd){
   case 'list_projects':return [project];case 'load_project':return project;case 'list_voices':return [];case 'get_settings':return {dictionary:{}};
   case 'list_models':return o.model?[{id:'htdemucs',name:'Tách giọng và nhạc nền (HTDemucs)',engine:'separation',installed:true,revision:'r',license:'',description:''}]:[];
   case 'list_jobs':return [...jobs].reverse();
   case 'runtime_status':return {python_ready:true,ffmpeg_ready:true,worker_ready:true,python_path:null,ffmpeg_path:null,message:''};
   case 'get_asset':return {id:args.id,path:`C:\\media\\${args.id}.mp4`,name:'nguồn có nhạc.mp4',duration_ms:null,sample_rate:null};
   case 'plugin:dialog|open':return 'C:\\phim có nhạc.mp4';
   case 'import_asset':return {id:'a2',path:'C:\\assets\\a2.mp4',name:'phim có nhạc.mp4',duration_ms:null,sample_rate:null};
   case 'save_project':project={...args.project,revision:args.project.revision+1};return project;
   case 'create_project':project={...project,id:'p2',name:args.name,revision:0,source_asset_id:null};return project;
   case 'enqueue_job':{const job={id:'j'+(jobs.length+1),kind:args.kind,project_id:args.projectId,payload:args.payload,status:'queued',progress:0,error:null,result:null,created_at:new Date(Date.now()+jobs.length).toISOString(),updated_at:new Date().toISOString()};jobs.push(job);return job;}
   default:return null;}}};
};
const calls=(page:any,cmd:string)=>page.evaluate((c:string)=>(window as any).__calls.filter((x:any)=>x.cmd===c).map((x:any)=>x.args),cmd);
const separation=(asset_id:string,status:string,stem?:string,at=0)=>({id:`s-${asset_id}-${status}-${at}`,kind:'separate',project_id:'p1',payload:{asset_id},status,progress:status==='succeeded'?1:0,error:null,result:stem?{asset_id:stem,path:`C:\\assets\\${stem}.flac`}:null,created_at:new Date(at).toISOString(),updated_at:new Date(at).toISOString()});
const open=async(page:any,o:Parameters<typeof mock>[0])=>{
 await page.addInitScript(mock,o);await page.goto('/');await page.getByRole('button',{name:'Dự án',exact:true}).click();await page.getByRole('button',{name:'Mở dự án'}).click();
};
const keep=(page:any)=>page.getByRole('checkbox',{name:'Giữ nhạc nền'});

test('without subtitle cues there is no background option',async({page})=>{
 await open(page,{model:true,source:'src',cues:false});
 await expect(page.getByRole('button',{name:'Xuất audio'})).toBeVisible();
 await expect(keep(page)).toHaveCount(0);
});

test('the option comes with the subtitle timing and is off, pointing to the models page, without the separation model',async({page})=>{
 await open(page,{model:false,source:'src'});
 await expect(keep(page)).toHaveCount(0);
 await page.getByRole('checkbox',{name:'Theo mốc phụ đề'}).check();
 await expect(keep(page)).toBeDisabled();
 await expect(page.locator('label',{has:keep(page)})).toHaveAttribute('title','Tải Tách giọng và nhạc nền (HTDemucs) trong Model & cài đặt để bật');
});

test('with a source, checking separates that source without asking for a file',async({page})=>{
 await open(page,{model:true,source:'src'});
 await page.getByRole('checkbox',{name:'Theo mốc phụ đề'}).check();
 await expect(page.locator('label',{has:keep(page)})).toHaveAttribute('title',/nguồn có nhạc\.mp4/);
 await keep(page).click();await expect(keep(page)).toBeChecked();
 expect(await calls(page,'enqueue_job')).toEqual([{kind:'separate',projectId:'p1',payload:{asset_id:'src',name:'nguồn có nhạc.mp4'}}]);
 expect(await calls(page,'plugin:dialog|open')).toEqual([]);
 await expect(page.getByRole('status').filter({hasText:'Đang tách nhạc nền từ nguồn có nhạc.mp4: có thể lâu hơn độ dài file và chạy sau các việc khác trong Hàng đợi.'})).toBeVisible();
 await page.getByRole('navigation',{name:'Điều hướng chính'}).getByRole('button',{name:/^Hàng đợi/}).click();
 await expect(page.locator('article',{hasText:'Tách nhạc nền'})).toContainText('nguồn có nhạc.mp4');
});

test('without a source, the picked file becomes the project source and is separated',async({page})=>{
 await open(page,{model:true,source:null});
 await page.getByRole('checkbox',{name:'Theo mốc phụ đề'}).check();
 await keep(page).click();await expect(keep(page)).toBeChecked();
 expect(await calls(page,'plugin:dialog|open')).toHaveLength(1);
 expect((await calls(page,'save_project')).at(-1).project.source_asset_id).toBe('a2');
 expect(await calls(page,'enqueue_job')).toEqual([{kind:'separate',projectId:'p1',payload:{asset_id:'a2',name:'phim có nhạc.mp4'}}]);
});

for(const [status,again] of [['queued',false],['running',false],['succeeded',false],['failed',true],['cancelled',true]] as const){
 test(`a ${status} separation of the source ${again?'does not stop':'stops'} a new one`,async({page})=>{
  await open(page,{model:true,source:'src',jobs:[separation('src',status,status==='succeeded'?'stem':undefined)]});
  await page.getByRole('checkbox',{name:'Theo mốc phụ đề'}).check();
  await keep(page).click();await expect(keep(page)).toBeChecked();
  expect((await calls(page,'enqueue_job')).map((a:any)=>[a.kind,a.payload.asset_id])).toEqual(again?[['separate','src']]:[]);
 });
}

test('the newest succeeded separation of the source goes under the render',async({page})=>{
 await open(page,{model:true,source:'src',jobs:[separation('src','succeeded','stem-old',1000),separation('src','succeeded','stem-new',2000),separation('other','succeeded','stem-other',3000)]});
 await page.getByRole('checkbox',{name:'Theo mốc phụ đề'}).check();
 await keep(page).click();await expect(keep(page)).toBeChecked();
 await page.getByRole('button',{name:'Xuất audio'}).click();
 await expect.poll(async()=>(await calls(page,'enqueue_job')).length).toBe(1);
 const [render]=await calls(page,'enqueue_job');
 expect([render.kind,render.payload.timeline,render.payload.background_asset_id]).toEqual(['render',true,'stem-new']);
});

test('a separation of another file is ignored, and the render refuses to drop the background',async({page})=>{
 await open(page,{model:true,source:'src',jobs:[separation('other','succeeded','stem-other')]});
 await page.getByRole('checkbox',{name:'Theo mốc phụ đề'}).check();
 await keep(page).click();await expect(keep(page)).toBeChecked();
 expect((await calls(page,'enqueue_job')).map((a:any)=>[a.kind,a.payload.asset_id])).toEqual([['separate','src']]);
 const exportAudio=page.getByRole('button',{name:'Xuất audio'});
 await exportAudio.click();
 await expect(page.getByRole('alert')).toContainText('Nhạc nền đang được tách. Đợi việc “Tách nhạc nền” trong Hàng đợi xong rồi xuất lại.');
 await page.evaluate(()=>Object.assign((window as any).__jobs.at(-1),{status:'cancelled'}));
 await page.getByRole('button',{name:'Đóng lỗi'}).click();await exportAudio.click();
 await expect(page.getByRole('alert')).toContainText('Chưa có nhạc nền tách từ file gốc. Bỏ chọn rồi chọn lại “Giữ nhạc nền” để tách, hoặc bỏ chọn để xuất không kèm nhạc nền.');
 expect((await calls(page,'enqueue_job')).filter((a:any)=>a.kind==='render')).toEqual([]);
});

test('another or a new project starts with the background option off',async({page})=>{
 await open(page,{model:true,source:'src',jobs:[separation('src','succeeded','stem')]});
 await page.getByRole('checkbox',{name:'Theo mốc phụ đề'}).check();
 await keep(page).click();await expect(keep(page)).toBeChecked();
 await page.getByRole('navigation',{name:'Điều hướng chính'}).getByRole('button',{name:'Dự án'}).click();await page.getByRole('button',{name:'Mở dự án'}).click();
 await expect(keep(page)).not.toBeChecked();
 await keep(page).click();await expect(keep(page)).toBeChecked();
 await page.getByRole('navigation',{name:'Điều hướng chính'}).getByRole('button',{name:'Dự án'}).click();await page.getByRole('button',{name:'Tạo dự án'}).click();
 await expect(page.getByRole('textbox',{name:'Nội dung đoạn 1'})).toBeVisible(); // the mock's new project has the same cues
 await expect(keep(page)).not.toBeChecked();
});
