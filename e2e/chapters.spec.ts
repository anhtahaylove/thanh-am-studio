import {test,expect} from '@playwright/test';
// Tauri is mocked: the page believes it is the desktop app and every command is answered (and recorded in window.__calls) here.
const mock=(o:{chapters:(string|null)[];cues?:boolean;failEnqueueAt?:number})=>{
 const w=window as any,calls:any[]=[];w.isTauri=true;w.__calls=calls;
 const take=(id:string)=>({id,asset_id:'a'+id,path:id+'.wav',duration_ms:3000,sample_rate:48000,created_at:new Date().toISOString()});
 const seg=(i:number,chapter:string|null)=>({id:String(i+1),text:'Câu '+(i+1)+'.',normalized_text:'Câu '+(i+1)+'.',voice_id:null,speaker:'Người dẫn',gap_ms:300,takes:[take('t'+(i+1))],selected_take_id:'t'+(i+1),trim_start_ms:0,trim_end_ms:null,fade_in_ms:0,fade_out_ms:0,gain_db:0,chapter,...(o.cues&&{cue_start_ms:i*2000,cue_end_ms:i*2000+2000})});
 let project:any=JSON.parse(localStorage.getItem("mock-project")||"null")??{id:'p1',name:'Chương',updated_at:new Date().toISOString(),revision:1,segments:o.chapters.map((c:string|null,i:number)=>seg(i,c)),transcript:[],dictionary:{},source_asset_id:null};
 const jobs:any[]=[];
 w.__TAURI_INTERNALS__={convertFileSrc:(p:string)=>p,transformCallback:()=>1,unregisterCallback:()=>{},metadata:{currentWindow:{label:'main'},currentWebview:{label:'main',windowLabel:'main'}},
  invoke:async(cmd:string,args:any)=>{calls.push({cmd,args});switch(cmd){
   case 'list_projects':return [project];case 'load_project':return project;case 'list_voices':case 'list_models':return [];case 'get_settings':return {dictionary:{}};
   case 'list_jobs':return [...jobs].reverse();
   case 'runtime_status':return {python_ready:true,ffmpeg_ready:true,worker_ready:true,python_path:null,ffmpeg_path:null,message:''};
   case 'save_project':project={...args.project,revision:args.project.revision+1};localStorage.setItem("mock-project",JSON.stringify(project));return project;
   case 'enqueue_job':{if(o.failEnqueueAt===jobs.length)throw "QUEUE_FULL";const job={id:'j'+(jobs.length+1),kind:args.kind,project_id:args.projectId,payload:args.payload,status:'succeeded',progress:1,error:null,result:{asset_id:'r'+(jobs.length+1)},created_at:new Date(Date.now()+jobs.length).toISOString(),updated_at:new Date().toISOString()};jobs.push(job);return job;}
   case 'plugin:dialog|open':return 'C:\\Xuất';case 'plugin:dialog|save':return 'C:\\Xuất\\x.wav';
   case 'export_asset_new':{const p=String(args.path);if(p.includes("003-"))throw "DISK_FULL";return !p.includes("002-");}
   default:return null;}}};
};
const open=async(page:any,opts:{chapters:(string|null)[];cues?:boolean;failEnqueueAt?:number})=>{
 await page.addInitScript(mock,opts);await page.goto('/');await page.getByRole('button',{name:'Dự án',exact:true}).click();await page.getByRole('button',{name:'Mở dự án'}).click();
};
const calls=(page:any,cmd:string)=>page.evaluate((c:string)=>(window as any).__calls.filter((x:any)=>x.cmd===c).map((x:any)=>x.args),cmd);

test('a script with [P1] and [P2] lines shows one chip per chapter, never speaks the marker, and the Chương field edits it',async({page})=>{
 await page.goto('/');await page.getByRole('button',{name:'Thêm nội dung',exact:true}).click();
 await page.getByRole('textbox',{name:'Nội dung cần thêm'}).fill('[P1] Mở đầu.\nMột câu nữa.\n[ p2 ]\nChương hai.');await page.getByRole('button',{name:'Thêm vào kịch bản'}).click();
 await expect(page.getByRole('textbox',{name:'Nội dung đoạn 1'})).toHaveValue('Mở đầu.');await expect(page.getByRole('textbox',{name:'Nội dung đoạn 3'})).toHaveValue('Chương hai.');
 await expect(page.locator('.chapter-chip')).toHaveText(['P1','P2']);
 await expect(page.getByRole('textbox',{name:'Chương',exact:true})).toHaveValue('P1');
 await page.getByRole('textbox',{name:'Chương',exact:true}).fill('');await expect(page.locator('.chapter-chip')).toHaveText(['P2']);
 await page.getByRole('textbox',{name:'Chương',exact:true}).fill('Mở đầu');await expect(page.locator('.chapter-chip')).toHaveText(['Mở đầu','P2']);
});

test('one render job per chapter with numbered names, and the queue saves them all into a folder without overwriting',async({page})=>{
 await open(page,{chapters:['P1',null,'P2']});
 await expect(page.locator('.chapter-chip')).toHaveText(['P1','P2']);
 await page.getByRole('checkbox',{name:'Mỗi chương một file'}).check();await page.getByRole('button',{name:'Xuất audio'}).click();
 await expect.poll(async()=>(await calls(page,'enqueue_job')).length).toBe(2);
 const sent=await calls(page,'enqueue_job');
 expect(sent.map((c:any)=>[c.kind,c.payload.name,c.payload.segments.map((s:any)=>s.id)])).toEqual([['render','001-P1',['1','2']],['render','002-P2',['3']]]);
 expect(sent[0].payload).toMatchObject({normalize:true,format:'wav'});expect(sent[0].payload.batch).toBeTruthy();expect(sent[1].payload.batch).toBe(sent[0].payload.batch);
 await expect(page.getByText('001-P1',{exact:true})).toBeVisible();await expect(page.getByText('002-P2',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Lưu audio'}).first().click();
 expect((await calls(page,'plugin:dialog|save')).at(-1).options.defaultPath).toMatch(/^002-P2\.wav$/);
 await page.getByRole('button',{name:'Lưu tất cả chương'}).click();
 await expect(page.getByRole('status')).toContainText('Đã lưu 1/2 chương. Bỏ qua vì đã có tệp trùng tên: 002-P2.wav.');
 expect((await calls(page,'export_asset_new')).map((c:any)=>c.path)).toEqual(['C:\\Xuất\\001-P1.wav','C:\\Xuất\\002-P2.wav']);
});

test('the per-chapter checkbox is hidden while no segment starts a chapter',async({page})=>{
 await open(page,{chapters:[null,null]});
 await expect(page.getByRole('checkbox',{name:'Mỗi chương một file'})).toHaveCount(0);
});

test('chapter export and subtitle timing exclude each other and the bar stays tidy',async({page})=>{
 await open(page,{chapters:['P1',null,'P2'],cues:true});
 const dub=page.getByRole('checkbox',{name:'Theo mốc phụ đề'}),chap=page.getByRole('checkbox',{name:'Mỗi chương một file'});
 await dub.check();await expect(chap).toBeDisabled();await expect(chap).not.toBeChecked();await dub.uncheck();
 await chap.check();await expect(dub).toBeDisabled();await expect(chap).toBeEnabled();
 for(const width of [1920,1280,1024,800,640]){
  await page.setViewportSize({width,height:900});
  const m=await page.evaluate(()=>{const bar=document.querySelector('.export-controls')!,box=(e:Element)=>e.getBoundingClientRect();
   return {labels:[...bar.querySelectorAll('label.check')].map(l=>box(l).height),overflow:document.documentElement.scrollWidth>innerWidth};});
  expect(m.overflow,`at ${width} px`).toBe(false);for(const h of m.labels)expect(h,`label at ${width} px`).toBeLessThan(22);
 }
 await page.getByRole('button',{name:'Xuất audio'}).click();
 await expect.poll(async()=>(await calls(page,'enqueue_job')).length).toBe(2);
 expect((await calls(page,'enqueue_job')).every((c:any)=>!c.payload.timeline)).toBe(true);
});

test('one file that cannot be saved does not stop the others and the notice names it',async({page})=>{
 await open(page,{chapters:['P1','P2','P3']});
 await page.getByRole('checkbox',{name:'Mỗi chương một file'}).check();await page.getByRole('button',{name:'Xuất audio'}).click();
 await expect(page.getByText('003-P3',{exact:true})).toBeVisible();
 expect((await calls(page,'enqueue_job')).map((c:any)=>c.payload.batch_size)).toEqual([3,3,3]);
 await page.getByRole('button',{name:'Lưu tất cả chương'}).click();
 await expect(page.getByRole('status')).toContainText('Đã lưu 1/3 chương. Bỏ qua vì đã có tệp trùng tên: 002-P2.wav. Không lưu được: 003-P3.wav (DISK_FULL).');
 expect((await calls(page,'export_asset_new')).map((c:any)=>c.path)).toEqual(['C:\\Xuất\\001-P1.wav','C:\\Xuất\\002-P2.wav','C:\\Xuất\\003-P3.wav']);
});

test('a batch that stopped enqueuing halfway is never offered as complete',async({page})=>{
 await open(page,{chapters:['P1','P2'],failEnqueueAt:1});
 await page.getByRole('checkbox',{name:'Mỗi chương một file'}).check();await page.getByRole('button',{name:'Xuất audio'}).click();
 await expect(page.getByRole('alert')).toContainText('QUEUE_FULL');
 await page.getByRole('navigation',{name:'Điều hướng chính'}).getByRole('button',{name:/^Hàng đợi/}).click();
 await expect(page.getByText('001-P1',{exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'Lưu tất cả chương'})).toHaveCount(0);
});

test('a chapter label survives save and reload',async({page})=>{
 await open(page,{chapters:['P1',null,'P2']});
 await page.getByRole('textbox',{name:'Chương',exact:true}).fill('Mở đầu');await expect(page.locator('.chapter-chip')).toHaveText(['Mở đầu','P2']);
 await page.keyboard.press('Control+s');
 await expect.poll(async()=>(await calls(page,'save_project')).at(-1)?.project.segments.map((s:any)=>s.chapter??null)).toEqual(['Mở đầu',null,'P2']);
 await page.reload();await page.getByRole('button',{name:'Dự án',exact:true}).click();await page.getByRole('button',{name:'Mở dự án'}).click();
 await expect(page.locator('.chapter-chip')).toHaveText(['Mở đầu','P2']);
});
