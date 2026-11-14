import {test,expect} from '@playwright/test';
// Tauri is mocked: the first load_project returns segments without takes (the editor before its next poll), later ones the takes the server already made.
test('export loads the takes the server already made instead of failing on a stale copy',async({page})=>{
 await page.addInitScript(()=>{
  const w=window as any,calls:any[]=[];w.isTauri=true;w.__calls=calls;
  const take=(id:string)=>({id,asset_id:'a'+id,path:id+'.wav',duration_ms:3000,sample_rate:48000,created_at:new Date().toISOString()});
  const seg=(i:number,takes:boolean)=>({id:String(i+1),text:'Câu '+(i+1)+'.',normalized_text:'Câu '+(i+1)+'.',voice_id:null,speaker:'Người dẫn',gap_ms:300,takes:takes?[take('t'+(i+1))]:[],selected_take_id:takes?'t'+(i+1):null,trim_start_ms:0,trim_end_ms:null,fade_in_ms:0,fade_out_ms:0,gain_db:0});
  const make=(takes:boolean)=>({id:'p1',name:'Mới tạo',updated_at:new Date().toISOString(),revision:1,segments:[0,1].map(i=>seg(i,takes)),transcript:[],dictionary:{},source_asset_id:null});
  const jobs:any[]=[];let loads=0;
  w.__TAURI_INTERNALS__={convertFileSrc:(p:string)=>p,transformCallback:()=>1,unregisterCallback:()=>{},metadata:{currentWindow:{label:'main'},currentWebview:{label:'main',windowLabel:'main'}},
   invoke:async(cmd:string,args:any)=>{calls.push({cmd,args});switch(cmd){
    case 'list_projects':return [make(false)];case 'load_project':return make(loads++>0);case 'list_voices':case 'list_models':return [];case 'get_settings':return {dictionary:{}};
    case 'list_jobs':return [...jobs].reverse();
    case 'runtime_status':return {python_ready:true,ffmpeg_ready:true,worker_ready:true,python_path:null,ffmpeg_path:null,message:''};
    case 'enqueue_job':{const job={id:'j'+(jobs.length+1),kind:args.kind,project_id:args.projectId,payload:args.payload,status:'succeeded',progress:1,error:null,result:{asset_id:'r1'},created_at:new Date().toISOString(),updated_at:new Date().toISOString()};jobs.push(job);return job;}
    default:return null;}}};
 });
 await page.goto('/');await page.getByRole('button',{name:'Dự án',exact:true}).click();await page.getByRole('button',{name:'Mở dự án'}).click();
 await expect(page.getByRole('textbox',{name:'Nội dung đoạn 2'})).toHaveValue('Câu 2.');
 await page.getByRole('button',{name:'Xuất audio'}).click();
 await expect.poll(()=>page.evaluate(()=>(window as any).__calls.filter((c:any)=>c.cmd==='enqueue_job').length)).toBe(1);
 const sent=await page.evaluate(()=>(window as any).__calls.find((c:any)=>c.cmd==='enqueue_job').args);
 expect(sent.kind).toBe('render');expect(sent.payload.segments.map((s:any)=>s.selected_take_id)).toEqual(['t1','t2']);
 await expect(page.getByRole('alert')).toHaveCount(0);
});
