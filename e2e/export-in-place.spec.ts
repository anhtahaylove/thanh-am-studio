import {test,expect} from '@playwright/test';
import type {Page} from '@playwright/test';
// Round 1.0.26 F2: "Xuất audio" asks for the file first, queues the render, stays on the page, and saves the file when the render finishes.
// Tauri is mocked: every command is answered and recorded in window.__calls (in call order). A render job stays queued until a test calls
// window.__finish(), which also gives each job a result like the store does.
type O={save?:string|null;chapters?:boolean;noTake?:boolean;badTrim?:boolean;seeded?:boolean;exportError?:string};
const mock=(o:O)=>{
 const w=window as any,now='2026-11-27T00:00:00Z',calls:any[]=[];w.isTauri=true;w.__calls=calls;
 const take=(id:string)=>({id,asset_id:'a'+id,path:id+'.wav',duration_ms:3000,sample_rate:48000,created_at:now});
 const seg=(i:number)=>({id:String(i),text:'Câu '+i+'.',normalized_text:'Câu '+i+'.',voice_id:null,speaker:'Người dẫn',gap_ms:300,takes:o.noTake&&i===2?[]:[take('t'+i)],selected_take_id:o.noTake&&i===2?null:'t'+i,trim_start_ms:0,trim_end_ms:o.badTrim&&i===2?9000:null,fade_in_ms:0,fade_out_ms:0,gain_db:0,chapter:o.chapters?'P'+i:null});
 const project={id:'p1',name:'Xuất tại chỗ',updated_at:now,revision:1,segments:[seg(1),seg(2)],transcript:[],dictionary:{},source_asset_id:null};
 const job=(id:string,status:string,payload:object)=>({id,kind:'render',project_id:'p1',payload,status,progress:status==='succeeded'?1:0,error:null,result:status==='succeeded'?{asset_id:'r'+id}:null,created_at:now,updated_at:now});
 const jobs:any[]=o.seeded?[job('old','succeeded',{format:'wav',name:'Bản cũ'})]:[];
 w.__finish=()=>{for(const j of jobs){j.status='succeeded';j.progress=1;j.result={asset_id:'r'+j.id};}};
 w.__TAURI_INTERNALS__={convertFileSrc:(p:string)=>p,transformCallback:()=>1,unregisterCallback:()=>{},metadata:{currentWindow:{label:'main'},currentWebview:{label:'main',windowLabel:'main'}},
  invoke:async(cmd:string,args:any)=>{calls.push({cmd,args:JSON.parse(JSON.stringify(args??{}))});switch(cmd){
   case 'list_projects':return [{id:'p1',name:project.name,updated_at:now,revision:1}];case 'load_project':return project;
   case 'save_project':return {...args.project,revision:args.project.revision+1};
   case 'list_voices':case 'list_models':return [];case 'get_settings':return {dictionary:{}};
   case 'list_jobs':return JSON.parse(JSON.stringify([...jobs].reverse())); // a copy, as IPC gives: the app skips a poll that equals the last one
   case 'runtime_status':return {python_ready:true,ffmpeg_ready:true,worker_ready:true,python_path:null,ffmpeg_path:null,message:''};
   case 'enqueue_job':{const j=job('j'+(jobs.length+1),'queued',args.payload);jobs.push(j);return j;}
   case 'plugin:dialog|save':return o.save===undefined?'C:\\Xuất\\bản-xuất.wav':o.save;
   case 'export_asset':if(o.exportError)throw o.exportError;return null;
   default:return null;}}};
};
const open=async(page:Page,o:O={})=>{
 await page.addInitScript(mock,o);await page.goto('/');await page.getByRole('button',{name:'Dự án',exact:true}).click();await page.getByRole('button',{name:'Mở dự án',exact:true}).click();
 await expect(page.getByRole('textbox',{name:'Nội dung đoạn 2'})).toBeVisible();
};
const calls=(page:Page)=>page.evaluate(()=>(window as any).__calls as {cmd:string;args:any}[]);
const of=async(page:Page,cmd:string)=>(await calls(page)).filter(c=>c.cmd===cmd).map(c=>c.args);
const onTts=(page:Page)=>expect(page.locator('main h1')).toContainText('Tạo giọng đọc');
const exportAudio=(page:Page)=>page.getByRole('button',{name:'Xuất audio'});
const finish=(page:Page)=>page.evaluate(()=>(window as any).__finish());

test('the save dialog opens before the render is queued, the payload is the same and the page stays',async({page})=>{
 await open(page);await exportAudio(page).click();
 await expect.poll(async()=>(await of(page,'enqueue_job')).length).toBe(1);
 const order=(await calls(page)).map(c=>c.cmd),dialog=order.indexOf('plugin:dialog|save'),enqueue=order.indexOf('enqueue_job');
 expect(dialog,'the save dialog was opened').toBeGreaterThanOrEqual(0);expect(dialog,'the dialog comes before the render is queued').toBeLessThan(enqueue);
 const [options]=await of(page,'plugin:dialog|save');expect(options.options.defaultPath).toBe('thanh-am.wav');expect(options.options.filters[0].extensions).toEqual(['wav']);
 const [sent]=await of(page,'enqueue_job');expect(sent.kind).toBe('render');expect(Object.keys(sent.payload).sort()).toEqual(['format','normalize','segments']);
 expect(sent.payload).toMatchObject({normalize:true,format:'wav'});expect(sent.payload.segments.map((s:any)=>s.selected_take_id)).toEqual(['t1','t2']);
 await page.waitForTimeout(500);await onTts(page);
});

test('cancelling the save dialog queues nothing and shows no error',async({page})=>{
 await open(page,{save:null});await exportAudio(page).click();
 await expect.poll(async()=>(await of(page,'plugin:dialog|save')).length).toBe(1);
 await page.waitForTimeout(500);
 expect(await of(page,'enqueue_job')).toEqual([]);await expect(page.getByRole('alert')).toHaveCount(0);await onTts(page);await expect(exportAudio(page)).toBeEnabled();
});

// The take and recipe checks of render() run before the dialog: a project that cannot be exported never asks for a file.
for(const [label,o,message] of [['a segment without a take',{noTake:true},'Chọn một take cho mỗi đoạn trước khi xuất'],['a trim past the end of the take',{badTrim:true},'Trim và khoảng nghỉ phải nằm trong thời lượng audio']] as [string,O,string][])
 test(`${label} blocks the export before the dialog`,async({page})=>{
  await open(page,o);await exportAudio(page).click();
  await expect(page.getByRole('alert')).toContainText(message);
  expect(await of(page,'plugin:dialog|save')).toEqual([]);expect(await of(page,'enqueue_job')).toEqual([]);
 });

test('the file is saved when the render finishes, with the banner and its folder button',async({page})=>{
 await open(page);await exportAudio(page).click();
 await expect.poll(async()=>(await of(page,'enqueue_job')).length).toBe(1);
 await page.waitForTimeout(500);expect(await of(page,'export_asset'),'nothing is saved while the render is queued').toEqual([]);
 await finish(page);
 await expect.poll(async()=>await of(page,'export_asset'),{timeout:15000}).toEqual([{assetId:'rj1',path:'C:\\Xuất\\bản-xuất.wav'}]);
 const banner=page.getByRole('status').filter({hasText:'Đã lưu bản-xuất.wav'});await expect(banner).toBeVisible();
 await banner.getByRole('button',{name:'Mở thư mục'}).click();
 await expect.poll(async()=>await of(page,'reveal_path')).toEqual([{path:'C:\\Xuất\\bản-xuất.wav'}]);
 await onTts(page);expect((await of(page,'export_asset')).length,'saved once').toBe(1);
});

test('a save that fails is reported',async({page})=>{
 await open(page,{exportError:'FORMAT_MISMATCH: Chọn đúng định dạng đã render.'});await exportAudio(page).click();
 await expect.poll(async()=>(await of(page,'enqueue_job')).length).toBe(1);await finish(page);
 await expect(page.getByRole('alert')).toContainText('Chọn đúng định dạng đã render.',{timeout:15000});
 await expect(page.getByRole('status').filter({hasText:'Đã lưu'})).toHaveCount(0);
});

test('a render from an earlier session is not saved by itself, and the queue still saves it',async({page})=>{
 await open(page,{seeded:true});await page.waitForTimeout(3000);
 expect(await of(page,'export_asset')).toEqual([]);expect(await of(page,'plugin:dialog|save')).toEqual([]);
 await page.getByRole('navigation',{name:'Điều hướng chính'}).getByRole('button',{name:/^Hàng đợi/}).click();
 await page.getByRole('button',{name:'Lưu audio'}).click();
 await expect.poll(async()=>await of(page,'export_asset')).toEqual([{assetId:'rold',path:'C:\\Xuất\\bản-xuất.wav'}]);
 expect((await of(page,'plugin:dialog|save')).length).toBe(1);
});

test('one render per chapter is queued without a dialog or a page change, and "Mở hàng đợi" opens the queue',async({page})=>{
 await open(page,{chapters:true});await page.getByRole('checkbox',{name:'Mỗi chương một file'}).check();await exportAudio(page).click();
 await expect(page.getByRole('status').filter({hasText:'Đã thêm 2 chương vào hàng đợi xuất.'})).toBeVisible();
 expect((await of(page,'enqueue_job')).map(a=>a.payload.name)).toEqual(['001-P1','002-P2']);
 expect(await of(page,'plugin:dialog|save')).toEqual([]);await onTts(page);
 await page.getByRole('button',{name:'Mở hàng đợi'}).click();
 await expect(page.locator('main h1')).toContainText('Hàng đợi');
});
