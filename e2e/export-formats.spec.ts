import {test,expect} from '@playwright/test';
// Tauri is mocked: every command is answered (and recorded in window.__calls) here; the render job succeeds at once.
const mock=()=>{
 const w=window as any,calls:any[]=[];w.isTauri=true;w.__calls=calls;
 const take=(id:string)=>({id,asset_id:'a'+id,path:id+'.wav',duration_ms:3000,sample_rate:48000,created_at:new Date().toISOString()});
 const seg=(id:string)=>({id,text:'Câu '+id+'.',normalized_text:'Câu '+id+'.',voice_id:null,speaker:'Người dẫn',gap_ms:300,takes:[take('t'+id)],selected_take_id:'t'+id,trim_start_ms:0,trim_end_ms:null,fade_in_ms:0,fade_out_ms:0,gain_db:0,chapter:null});
 const project={id:'p1',name:'Xuất',updated_at:new Date().toISOString(),revision:1,segments:[seg('1')],transcript:[],dictionary:{},source_asset_id:null};
 const jobs:any[]=[];
 w.__TAURI_INTERNALS__={convertFileSrc:(p:string)=>p,transformCallback:()=>1,unregisterCallback:()=>{},metadata:{currentWindow:{label:'main'},currentWebview:{label:'main',windowLabel:'main'}},
  invoke:async(cmd:string,args:any)=>{calls.push({cmd,args});switch(cmd){
   case 'list_projects':return [project];case 'load_project':return project;case 'list_voices':case 'list_models':return [];case 'get_settings':return {dictionary:{}};
   case 'list_jobs':return [...jobs].reverse();
   case 'runtime_status':return {python_ready:true,ffmpeg_ready:true,worker_ready:true,python_path:null,ffmpeg_path:null,message:''};
   case 'save_project':return {...args.project,revision:args.project.revision+1};
   case 'enqueue_job':{const job={id:'j'+(jobs.length+1),kind:args.kind,project_id:args.projectId,payload:args.payload,status:'succeeded',progress:1,error:null,result:{asset_id:'r'+(jobs.length+1)},created_at:new Date().toISOString(),updated_at:new Date().toISOString()};jobs.push(job);return job;}
   case 'plugin:dialog|save':return 'C:\\Xuất\\x';
   default:return null;}}};
};
const calls=(page:any,cmd:string)=>page.evaluate((c:string)=>(window as any).__calls.filter((x:any)=>x.cmd===c).map((x:any)=>x.args),cmd);

for(const [value,label] of [['wav','WAV'],['mp3','MP3'],['m4a','M4A'],['flac','FLAC'],['opus','Opus']]){
 test(`${label} is offered, sent as payload.format and saved with a ${value} file name and filter`,async({page})=>{
  await page.addInitScript(mock);await page.goto('/');await page.getByRole('button',{name:'Dự án',exact:true}).click();await page.getByRole('button',{name:'Mở dự án',exact:true}).click();
  const menu=page.getByRole('combobox',{name:'Định dạng audio'});
  await expect(menu.locator('option')).toHaveText(['WAV','MP3','M4A','FLAC','Opus']);
  await menu.selectOption(value);await page.getByRole('button',{name:'Xuất audio'}).click();
  await expect.poll(async()=>(await calls(page,'enqueue_job')).length).toBe(1);
  expect((await calls(page,'enqueue_job'))[0].payload.format).toBe(value);
  await page.getByRole('button',{name:'Lưu audio'}).click();
  await expect.poll(async()=>(await calls(page,'plugin:dialog|save')).length).toBe(1);
  const options=(await calls(page,'plugin:dialog|save'))[0].options;
  expect(options.defaultPath).toBe(`thanh-am.${value}`);expect(options.filters[0].extensions).toEqual([value]);
 });
}
