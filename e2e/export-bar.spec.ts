import {test,expect} from '@playwright/test';
test('the export bar keeps its controls on one line each with the subtitle timing on',async({page})=>{
 await page.addInitScript(()=>{
  const w=window as any;w.isTauri=true;
  const take=(id:string)=>({id,asset_id:'a'+id,path:id+'.wav',duration_ms:3000,sample_rate:48000,created_at:new Date().toISOString()});
  const seg=(id:string,cue_start_ms:number)=>({id,text:'Câu '+id+'.',normalized_text:'Câu '+id+'.',voice_id:null,speaker:'Người dẫn',gap_ms:300,takes:[take('t'+id)],selected_take_id:'t'+id,trim_start_ms:0,trim_end_ms:null,fade_in_ms:0,fade_out_ms:0,gain_db:0,cue_start_ms,cue_end_ms:cue_start_ms+2000});
  const project={id:'p1',name:'Lồng tiếng',updated_at:new Date().toISOString(),revision:1,segments:[seg('1',0),seg('2',2000)],transcript:[],dictionary:{},source_asset_id:null};
  w.__TAURI_INTERNALS__={convertFileSrc:(p:string)=>p,transformCallback:()=>1,unregisterCallback:()=>{},metadata:{currentWindow:{label:'main'},currentWebview:{label:'main',windowLabel:'main'}},
   invoke:async(cmd:string)=>{switch(cmd){case 'list_projects':return [project];case 'load_project':return project;case 'list_jobs':case 'list_voices':case 'list_models':return [];case 'get_settings':return {dictionary:{}};
    case 'runtime_status':return {python_ready:true,ffmpeg_ready:true,worker_ready:true,python_path:null,ffmpeg_path:null,message:''};default:return null;}}};
 });
 await page.goto('/');await page.getByRole('button',{name:'Dự án',exact:true}).click();await page.getByRole('button',{name:'Mở dự án'}).click();
 await page.getByRole('checkbox',{name:'Theo mốc phụ đề'}).check();await expect(page.locator('.dub-stats')).toContainText('đọc nhanh hơn');
 for(const width of [1920,1600,1520,1440,1280,1240,1218,1200,1100,1024,960,800,640]){
  await page.setViewportSize({width,height:900});
  const m=await page.evaluate(()=>{const bar=document.querySelector('.export-controls')!,sel=bar.querySelector('select')!,box=(e:Element)=>e.getBoundingClientRect();
   return {select:box(sel).width,labels:[...bar.querySelectorAll('label.check')].map(l=>box(l).height),buttons:[...bar.querySelectorAll('button')].map(b=>box(b).height),overflow:document.documentElement.scrollWidth>innerWidth};});
  // One line of the 10 px check labels is 16 px; the format menu needs about 60 px to show "WAV" next to its arrow.
  expect(m,`at ${width} px`).toMatchObject({overflow:false});expect(m.select,`select at ${width} px`).toBeGreaterThanOrEqual(58);
  for(const h of m.labels)expect(h,`label at ${width} px`).toBeLessThan(22);
  for(const h of m.buttons)expect(h,`button at ${width} px`).toBeLessThan(44);
 }
});
