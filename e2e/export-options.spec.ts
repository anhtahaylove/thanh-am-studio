import {test,expect} from '@playwright/test';
import type {Page} from '@playwright/test';
// Round 1.0.26 C2: the dock shows the format and "Xuất audio"; the other export options sit in the closed "Tùy chọn xuất" group.
// Tauri is mocked: every command is answered and recorded in window.__calls (in call order).
const mock=()=>{
 const w=window as any,now='2026-11-27T00:00:00Z',calls:any[]=[];w.isTauri=true;w.__calls=calls;
 const take=(id:string)=>({id,asset_id:'a'+id,path:id+'.wav',duration_ms:3000,sample_rate:48000,created_at:now});
 const seg=(i:number)=>({id:String(i),text:'Câu '+i+'.',normalized_text:'Câu '+i+'.',voice_id:null,speaker:'Người dẫn',gap_ms:300,takes:[take('t'+i)],selected_take_id:'t'+i,trim_start_ms:0,trim_end_ms:null,fade_in_ms:0,fade_out_ms:0,gain_db:0,chapter:'P'+i,cue_start_ms:i*2000,cue_end_ms:i*2000+2000});
 const project={id:'p1',name:'Tùy chọn xuất',updated_at:now,revision:1,segments:[seg(1),seg(2)],transcript:[],dictionary:{},source_asset_id:null};
 const jobs:any[]=[];
 w.__TAURI_INTERNALS__={convertFileSrc:(p:string)=>p,transformCallback:()=>1,unregisterCallback:()=>{},metadata:{currentWindow:{label:'main'},currentWebview:{label:'main',windowLabel:'main'}},
  invoke:async(cmd:string,args:any)=>{calls.push({cmd,args:JSON.parse(JSON.stringify(args??{}))});switch(cmd){
   case 'list_projects':return [{id:'p1',name:project.name,updated_at:now,revision:1}];case 'load_project':return project;
   case 'save_project':return {...args.project,revision:args.project.revision+1};
   case 'list_voices':case 'list_models':return [];case 'get_settings':return {dictionary:{}};
   case 'list_jobs':return JSON.parse(JSON.stringify([...jobs].reverse()));
   case 'runtime_status':return {python_ready:true,ffmpeg_ready:true,worker_ready:true,python_path:null,ffmpeg_path:null,message:''};
   case 'enqueue_job':{const j={id:'j'+(jobs.length+1),kind:args.kind,project_id:'p1',payload:args.payload,status:'queued',progress:0,error:null,result:null,created_at:now,updated_at:now};jobs.push(j);return j;}
   case 'plugin:dialog|save':return 'C:\\Xuất\\bản-xuất.mp3';
   default:return null;}}};
};
const open=async(page:Page)=>{
 await page.addInitScript(mock);await page.goto('/');await page.getByRole('button',{name:'Dự án',exact:true}).click();await page.getByRole('button',{name:'Mở dự án',exact:true}).click();
 await expect(page.getByRole('textbox',{name:'Nội dung đoạn 2'})).toBeVisible();
};
const sent=(page:Page)=>page.evaluate(()=>(window as any).__calls.filter((c:any)=>c.cmd==='enqueue_job').map((c:any)=>c.args));
const dock=(page:Page)=>page.locator('#audio-dock');
const group=(page:Page)=>dock(page).getByText('Tùy chọn xuất',{exact:true});
const controls=(page:Page)=>{const d=dock(page);return {normalize:d.getByRole('checkbox',{name:'Chuẩn hóa'}),srt:d.getByRole('button',{name:'SRT',exact:true}),dub:d.getByRole('checkbox',{name:'Theo mốc phụ đề'}),keep:d.getByRole('checkbox',{name:'Giữ nhạc nền'}),chapters:d.getByRole('checkbox',{name:'Mỗi chương một file'})};};

test('dock shows format, Xuất audio, Tùy chọn xuất; options keep values',async({page})=>{
 await open(page);const d=dock(page),c=controls(page);
 await expect(d.getByRole('combobox',{name:'Định dạng audio'})).toBeVisible();await expect(d.getByRole('button',{name:'Xuất audio'})).toBeVisible();await expect(group(page)).toBeVisible();
 for(const el of [c.normalize,c.srt,c.dub,c.chapters])await expect(el).toBeHidden();
 await group(page).click();
 for(const el of [c.normalize,c.srt,c.dub,c.chapters])await expect(el).toBeVisible();
 await expect(c.normalize).toBeChecked();await expect(c.keep).toHaveCount(0);
 await c.normalize.uncheck();await c.dub.check();await expect(c.keep).toBeVisible();
 await group(page).click();await expect(c.normalize).toBeHidden();await group(page).click();
 await expect(c.normalize).not.toBeChecked();await expect(c.dub).toBeChecked();await expect(c.keep).toBeVisible();
 await c.dub.uncheck();await d.getByRole('combobox',{name:'Định dạng audio'}).selectOption({label:'MP3'});await d.getByRole('button',{name:'Xuất audio'}).click();
 await expect.poll(async()=>(await sent(page)).length).toBe(1);
 const [job]=await sent(page);expect(Object.keys(job.payload).sort()).toEqual(['format','normalize','segments']);expect(job.payload).toMatchObject({format:'mp3',normalize:false});
});

test('Tùy chọn xuất is closed at first and keeps its state for the session',async({page})=>{
 await open(page);const box=dock(page).locator('details');
 await expect(box).not.toHaveAttribute('open','');await group(page).click();await expect(box).toHaveAttribute('open','');
 await page.getByRole('navigation',{name:'Điều hướng chính'}).getByRole('button',{name:/^Chép lời/}).click();await expect(page.locator('main h1')).toContainText('Chép lời');
 await page.getByRole('navigation',{name:'Điều hướng chính'}).getByRole('button',{name:/^Tạo giọng đọc/}).click();
 await expect(box).toHaveAttribute('open','');await expect(controls(page).normalize).toBeVisible();
});

test('the queued-chapters notice shows while Tùy chọn xuất is closed',async({page})=>{
 await open(page);await group(page).click();await controls(page).chapters.check();await group(page).click();
 await expect(dock(page).locator('details')).not.toHaveAttribute('open','');
 await dock(page).getByRole('button',{name:'Xuất audio'}).click();
 await expect(page.getByRole('status').filter({hasText:'Đã thêm 2 chương vào hàng đợi xuất.'})).toBeVisible();await expect(page.getByRole('button',{name:'Mở hàng đợi'})).toBeVisible();
});

test('the per-chapter tooltip points at the Chương field in Chỉnh âm',async({page})=>{
 await open(page);await group(page).click();
 await expect(page.locator('label',{has:controls(page).chapters})).toHaveAttribute('title',/ô Chương trong Chỉnh âm/);
});
