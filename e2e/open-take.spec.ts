import {test,expect} from '@playwright/test';
import type {Page} from '@playwright/test';
// Round 1.0.28 Z2: "Mở take" on a finished voice job in the queue drawer opens the job's own segment. For the open project it must not reload it: the selection moves to the job's segment
// and its text box takes focus, undo history and "Giữ nhạc nền" stay as they are (a finished voice job also makes the app reload its project in the background, so reload counts are not asserted). For another project it opens that project and then does the same. A job whose segment is gone falls back to a reload.
// Tauri is mocked as in keep-background.spec.ts and queue-drawer.spec.ts; commands are recorded in window.__calls.
const mock=(o:{jobs:{id:string;project_id:string;segment_id:string}[]})=>{
 const w=window as any,now='2026-11-28T00:00:00Z',calls:any[]=[];w.isTauri=true;w.__calls=calls;
 const take=(id:string)=>({id,asset_id:'a'+id,path:id+'.wav',duration_ms:3000,sample_rate:48000,created_at:now});
 const seg=(id:string,cue:number)=>({id,text:'Câu '+id+'.',normalized_text:'Câu '+id+'.',voice_id:null,speaker:'Người dẫn',gap_ms:300,takes:[take('t'+id)],selected_take_id:'t'+id,trim_start_ms:0,trim_end_ms:null,fade_in_ms:0,fade_out_ms:0,gain_db:0,cue_start_ms:cue,cue_end_ms:cue+2000});
 const projects=[{id:'p1',name:'Dự án một',updated_at:now,revision:1,segments:[seg('1',0),seg('2',2000),seg('3',4000)],transcript:[],dictionary:{},source_asset_id:'src'},
  {id:'p2',name:'Dự án hai',updated_at:now,revision:1,segments:[seg('y1',0),seg('y2',2000)],transcript:[],dictionary:{},source_asset_id:null}];
 const jobs:any[]=o.jobs.map(j=>({id:j.id,kind:'tts',project_id:j.project_id,payload:{segment_id:j.segment_id,text:'x'},status:'succeeded',progress:1,error:null,result:{asset_id:'r'+j.id},created_at:now,updated_at:now}));
 w.__TAURI_INTERNALS__={convertFileSrc:(p:string)=>p,transformCallback:()=>1,unregisterCallback:()=>{},metadata:{currentWindow:{label:'main'},currentWebview:{label:'main',windowLabel:'main'}},
  invoke:async(cmd:string,args:any)=>{calls.push({cmd,args:JSON.parse(JSON.stringify(args??{}))});switch(cmd){
   case 'list_projects':return projects.map(p=>({id:p.id,name:p.name,updated_at:now,revision:1}));case 'load_project':return JSON.parse(JSON.stringify(projects.find(p=>p.id===args.id)));
   case 'save_project':return {...args.project,revision:args.project.revision+1};
   case 'list_voices':return [];case 'get_settings':return {dictionary:{}};
   case 'list_models':return [{id:'htdemucs',name:'Tách giọng và nhạc nền (HTDemucs)',engine:'separation',installed:true,revision:'r',license:'',description:''},{id:'separation-runtime',name:'Gói chạy tách nhạc nền (Python + PyTorch)',engine:'runtime',kind:'runtime',installed:true,revision:'separation-v1',license:'',description:''}];
   case 'list_jobs':return JSON.parse(JSON.stringify([...jobs].reverse()));
   case 'runtime_status':return {python_ready:true,ffmpeg_ready:true,worker_ready:true,python_path:null,ffmpeg_path:null,message:''};
   case 'get_asset':return {id:args.id,path:`C:\\media\\${args.id}.mp4`,name:'nguồn có nhạc.mp4',duration_ms:null,sample_rate:null};
   case 'enqueue_job':{const j={id:'n'+jobs.length,kind:args.kind,project_id:args.projectId,payload:args.payload,status:'queued',progress:0,error:null,result:null,created_at:now,updated_at:now};jobs.push(j);return j;}
   default:return null;}}};
};
const open=async(page:Page,jobs:Parameters<typeof mock>[0]['jobs'])=>{
 await page.addInitScript(mock,{jobs});await page.goto('/');await page.getByRole('button',{name:'Dự án',exact:true}).click();
 await page.locator('.project-card',{hasText:'Dự án một'}).getByRole('button',{name:'Mở dự án',exact:true}).click();
 await expect(page.getByRole('textbox',{name:'Nội dung đoạn 1'})).toBeVisible();
};
const openTake=async(page:Page)=>{
 await page.getByRole('navigation',{name:'Điều hướng chính'}).getByRole('button',{name:/^Hàng đợi/}).click();
 await page.getByRole('complementary',{name:'Hàng đợi'}).getByRole('button',{name:'Mở take'}).click();
};
const selected=(page:Page,n:number)=>page.locator('article.segment.selected').getByRole('textbox',{name:`Nội dung đoạn ${n}`});
const loads=(page:Page)=>page.evaluate(()=>(window as any).__calls.filter((c:any)=>c.cmd==='load_project').map((c:any)=>c.args.id as string));

test('"Mở take" for a segment of the open project selects it and focuses its text box',async({page})=>{
 await open(page,[{id:'j1',project_id:'p1',segment_id:'3'}]);
 await expect(selected(page,1)).toBeVisible();
 await openTake(page);
 await expect(selected(page,3)).toBeVisible();
 await expect(page.getByRole('textbox',{name:'Nội dung đoạn 3'})).toBeFocused();
});

test('"Mở take" for the open project keeps the undo history',async({page})=>{
 await open(page,[{id:'j1',project_id:'p1',segment_id:'3'}]);
 const undo=page.getByRole('button',{name:'Hoàn tác (Ctrl+Z)'});
 await expect(undo).toBeDisabled();
 await page.getByRole('textbox',{name:'Nội dung đoạn 1'}).fill('Câu một đã sửa.');
 await expect(undo).toBeEnabled();
 await openTake(page);
 await expect(selected(page,3)).toBeVisible();
 await expect(undo).toBeEnabled();
});

test('"Mở take" for the open project keeps "Giữ nhạc nền" on',async({page})=>{
 await open(page,[{id:'j1',project_id:'p1',segment_id:'3'}]);
 await page.getByText('Tùy chọn xuất',{exact:true}).click();
 await page.getByRole('checkbox',{name:'Theo mốc phụ đề'}).check();
 const keep=page.getByRole('checkbox',{name:'Giữ nhạc nền'});
 await keep.click();await expect(keep).toBeChecked();
 await openTake(page);
 await expect(selected(page,3)).toBeVisible();
 await expect(keep).toBeChecked();
});

test('"Mở take" for a job of another project opens that project on the job\'s segment',async({page})=>{
 await open(page,[{id:'j1',project_id:'p2',segment_id:'y2'}]);
 await openTake(page);
 await expect.poll(()=>loads(page)).toContain('p2');
 await expect(selected(page,2)).toBeVisible();
 await expect(page.getByRole('textbox',{name:'Nội dung đoạn 2'})).toBeFocused();
 await expect(page.getByRole('textbox',{name:'Nội dung đoạn 3'})).toHaveCount(0); // the second project has two segments
});

test('"Mở take" for a segment that no longer exists falls back to opening the project on its first segment',async({page})=>{
 await open(page,[{id:'j1',project_id:'p1',segment_id:'gone'}]);
 await page.getByRole('textbox',{name:'Nội dung đoạn 2'}).click();await expect(selected(page,2)).toBeVisible();
 await openTake(page);
 await expect(selected(page,1)).toBeVisible();
});
