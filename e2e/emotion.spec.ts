import {test,expect} from '@playwright/test';
const mock=()=>{
 const w=window as any,calls:any[]=[];w.isTauri=true;w.__calls=calls;
 const seg={id:'1',text:'Nghe hay quá 50k nhé.',normalized_text:'Nghe hay quá 50 nghìn nhé.',voice_id:null,speaker:'Người dẫn',gap_ms:300,takes:[],selected_take_id:null,trim_start_ms:0,trim_end_ms:null,fade_in_ms:0,fade_out_ms:0,gain_db:0};
 let project:any={id:'p1',name:'Biểu cảm',updated_at:new Date().toISOString(),revision:1,segments:[seg],transcript:[],dictionary:{},source_asset_id:null};
 w.__TAURI_INTERNALS__={convertFileSrc:(p:string)=>p,transformCallback:()=>1,unregisterCallback:()=>{},metadata:{currentWindow:{label:'main'},currentWebview:{label:'main',windowLabel:'main'}},
  invoke:async(cmd:string,args:any)=>{calls.push({cmd,args});switch(cmd){
   case 'list_projects':return [project];case 'load_project':return project;case 'list_jobs':case 'list_voices':return [];case 'list_models':return [];case 'get_settings':return {dictionary:{}};
   case 'runtime_status':return {python_ready:true,ffmpeg_ready:true,worker_ready:true,python_path:null,ffmpeg_path:null,message:''};
   case 'save_project':project={...args.project,revision:args.project.revision+1};return project;default:return null;}}};
};
const open=async(page:any)=>{await page.addInitScript(mock);await page.goto('/');await page.getByRole('button',{name:'Dự án',exact:true}).click();await page.getByRole('button',{name:'Mở dự án'}).click();};
test('emotion cue buttons insert at the cursor or over the selection and keep the normalized text in step',async({page})=>{
 await page.addInitScript(()=>{
  const w=window as any,calls:any[]=[];w.isTauri=true;w.__calls=calls;
  const seg={id:'1',text:'Nghe hay quá 50k nhé.',normalized_text:'Nghe hay quá 50 nghìn nhé.',voice_id:null,speaker:'Người dẫn',gap_ms:300,takes:[],selected_take_id:null,trim_start_ms:0,trim_end_ms:null,fade_in_ms:0,fade_out_ms:0,gain_db:0};
  let project:any={id:'p1',name:'Biểu cảm',updated_at:new Date().toISOString(),revision:1,segments:[seg],transcript:[],dictionary:{},source_asset_id:null};
  w.__TAURI_INTERNALS__={convertFileSrc:(p:string)=>p,transformCallback:()=>1,unregisterCallback:()=>{},metadata:{currentWindow:{label:'main'},currentWebview:{label:'main',windowLabel:'main'}},
   invoke:async(cmd:string,args:any)=>{calls.push({cmd,args});switch(cmd){
    case 'list_projects':return [project];case 'load_project':return project;case 'list_jobs':case 'list_voices':return [];case 'list_models':return [];case 'get_settings':return {dictionary:{}};
    case 'runtime_status':return {python_ready:true,ffmpeg_ready:true,worker_ready:true,python_path:null,ffmpeg_path:null,message:''};
    case 'save_project':project={...args.project,revision:args.project.revision+1};return project;default:return null;}}};
 });
 await page.goto('/');await page.getByRole('button',{name:'Dự án',exact:true}).click();await page.getByRole('button',{name:'Mở dự án'}).click();
 const box=page.getByRole('textbox',{name:'Nội dung đoạn 1'});
 const saved=()=>page.evaluate(()=>{const saves=(window as any).__calls.filter((c:any)=>c.cmd==='save_project');const s=saves.at(-1)?.args.project.segments[0];return s&&[s.text,s.normalized_text];});
 await box.click();await expect(page.getByRole('button',{name:'Cười',exact:true})).toHaveAttribute('title','Chèn [cười] tại con trỏ (thử nghiệm)');await page.keyboard.press('Control+Home');for(let i=0;i<8;i++)await page.keyboard.press('ArrowRight');
 await page.getByRole('button',{name:'Cười',exact:true}).click();
 await expect(box).toHaveValue('Nghe hay [cười] quá 50k nhé.');
 await expect.poll(saved).toEqual(['Nghe hay [cười] quá 50k nhé.','Nghe hay [cười] quá 50 nghìn nhé.']);
 await box.press('Control+End');await page.getByRole('button',{name:'Thở dài',exact:true}).click();
 await expect(box).toHaveValue('Nghe hay [cười] quá 50k nhé. [thở dài] ');
 await box.press('Control+a');await page.getByRole('button',{name:'Hắng giọng',exact:true}).click();
 await expect(box).toHaveValue('[hắng giọng] ');
 await expect.poll(saved).toEqual(['[hắng giọng] ','[hắng giọng] ']);
 await page.keyboard.press('Control+z');await expect(box).not.toHaveValue('[hắng giọng] ');
});

test('after an emotion or pause button the caret sits behind the inserted tag, so the next tag and typing follow it',async({page})=>{
 await open(page);const box=page.getByRole('textbox',{name:'Nội dung đoạn 1'});
 const at8=async()=>{await box.click();await page.keyboard.press('Control+Home');for(let i=0;i<8;i++)await page.keyboard.press('ArrowRight');};
 await at8();await page.getByRole('button',{name:'Cười',exact:true}).click();await page.getByRole('button',{name:'Thở dài',exact:true}).click();
 await expect(box).toHaveValue('Nghe hay [cười] [thở dài] quá 50k nhé.');await expect(box).toBeFocused();
 await page.keyboard.type('X');await expect(box).toHaveValue('Nghe hay [cười] [thở dài]X quá 50k nhé.');
 await box.fill('Nghe hay quá 50k nhé.');await at8();
 const pause=page.getByRole('button',{name:'Chèn khoảng nghỉ 0,5 giây tại con trỏ'});
 await pause.click();await pause.click();
 await expect(box).toHaveValue('Nghe hay [nghỉ 0.5s] [nghỉ 0.5s] quá 50k nhé.');await expect(box).toBeFocused();
 await page.keyboard.type('X');await expect(box).toHaveValue('Nghe hay [nghỉ 0.5s] [nghỉ 0.5s]X quá 50k nhé.');
});
