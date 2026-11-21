import {test,expect} from '@playwright/test';
import type {Page} from '@playwright/test';
// The "Làng chài · dự án mẫu" demo project: opened from the script-empty page, the projects page, the palette and the first-run checklist.
// Most tests run in the browser preview (a localStorage store); the desktop tests mock Tauri to watch the commands and to fail a save.
const NAME='Làng chài · dự án mẫu';
const nav=(page:Page,label:string)=>page.getByRole('navigation',{name:'Điều hướng chính'}).getByRole('button',{name:label,exact:true}).click();
const segments=(page:Page)=>page.locator('article.segment');
const palette=async(page:Page,option:string)=>{await expect(page.getByRole('heading',{level:1})).toBeVisible();await page.keyboard.press('Control+k');await page.getByRole('dialog',{name:'Bảng lệnh'}).getByRole('option',{name:option}).click();};
const DEMO_COMMAND='Mở dự án mẫu Làng chài';
// failSave: true fails the first save, 'always' every save. preseed: an empty demo project, or 'user' one whose segments were deleted but which keeps the user's transcript and dictionary. delay: ms per command.
type Setup={failSave?:boolean|'always';preseed?:boolean|'user';delay?:number};
const mock=(d:Setup&{name:string})=>{
 const w=window as any,now='2026-11-22T00:00:00Z';w.isTauri=true;w.__cmds=[];let fail=!!d.failSave,n=0;const lag=()=>new Promise(r=>setTimeout(r,d.delay??0));
 const blank=(id:string,name:string,revision:number)=>({id,name,updated_at:now,revision,segments:[],transcript:[],dictionary:{},source_asset_id:null});
 let projects:any[]=d.preseed?[blank('old',d.name,3)]:[];if(d.preseed==='user')Object.assign(projects[0],{transcript:[{id:'u1',start_ms:0,end_ms:2000,text:'Dòng của người dùng.',speaker:0}],dictionary:{ABC:'a bê xê'}});w.__names=()=>projects.map(p=>p.name);w.__stored=(name:string)=>JSON.parse(JSON.stringify(projects.find(p=>p.name===name)??null));
 w.__TAURI_INTERNALS__={convertFileSrc:(p:string)=>p,transformCallback:()=>1,unregisterCallback:()=>{},metadata:{currentWindow:{label:'main'},currentWebview:{label:'main',windowLabel:'main'}},
  invoke:async(cmd:string,args:any)=>{w.__cmds.push(cmd);await lag();switch(cmd){
   case 'list_projects':return projects.map(({id,name,updated_at,revision})=>({id,name,updated_at,revision}));
   case 'create_project':{const p=blank('p'+(++n),args.name,0);projects=[p,...projects];return JSON.parse(JSON.stringify(p));}
   case 'load_project':return JSON.parse(JSON.stringify(projects.find(p=>p.id===args.id)));
   case 'save_project':{if(fail){if(d.failSave!=='always')fail=false;throw 'SAVE_FAILED: disk is full';}const p={...JSON.parse(JSON.stringify(args.project)),revision:args.project.revision+1};projects=[p,...projects.filter(x=>x.id!==p.id)];return JSON.parse(JSON.stringify(p));}
   case 'delete_project':projects=projects.filter(p=>p.id!==args.id);return null;
   case 'list_jobs':case 'list_voices':case 'list_models':return [];case 'get_settings':return {dictionary:{}};
   case 'runtime_status':return {python_ready:true,ffmpeg_ready:true,worker_ready:true,native_worker_ready:true,python_path:null,ffmpeg_path:null,native_worker_path:null,fallback_count:0,total_memory_mb:null,message:''};
   default:return null;}}};
};
const desktop=async(page:Page,d:Setup={})=>{await page.addInitScript(mock,{...d,name:NAME});await page.goto('/');await expect(page.getByRole('heading',{level:1})).toBeVisible();};

test('the demo opens from the empty script page in the preview: 8 segments, 2 chapters, the dictionary entry; the transcript page shows 8 rows, a flagged line and the speakers',async({page})=>{
 await page.goto('/');
 await page.getByRole('button',{name:'Mở dự án mẫu'}).click();
 await expect(segments(page)).toHaveCount(8);await expect(page.locator('.chapter-chip')).toHaveCount(2);
 await page.getByRole('button',{name:'Từ điển phát âm'}).click();await expect(page.locator('.inspector').getByText('HTX → hợp tác xã')).toBeVisible();
 await nav(page,'Chép lời');
 await expect(page.locator('.transcript-row')).toHaveCount(8);
 await expect(page.getByRole('button',{name:/1 dòng đáng ngờ/})).toBeVisible();
 await expect(page.getByRole('group',{name:'Người nói'}).locator('.speaker-card')).toHaveCount(2);
});
test('the demo opens from the projects page and from the palette',async({page})=>{
 await page.goto('/');await nav(page,'Dự án');
 await page.locator('.empty').getByRole('button',{name:'Mở dự án mẫu'}).click();
 await expect(segments(page)).toHaveCount(8);
 await page.evaluate(()=>localStorage.clear());await page.reload();
 await palette(page,DEMO_COMMAND);await expect(segments(page)).toHaveCount(8);
});
test('opening the demo twice leaves one demo project (the preview)',async({page})=>{
 await page.goto('/');await palette(page,DEMO_COMMAND);await expect(segments(page)).toHaveCount(8);
 await nav(page,'Dự án');await expect(page.locator('.project-card').filter({hasText:NAME})).toHaveCount(1);
 await palette(page,DEMO_COMMAND);await expect(segments(page)).toHaveCount(8);
 await nav(page,'Dự án');await expect(page.locator('.project-card')).toHaveCount(1);
});
test('the demo survives a reload',async({page})=>{
 await page.goto('/');await palette(page,DEMO_COMMAND);await expect(segments(page)).toHaveCount(8);
 await page.reload();await nav(page,'Dự án');
 await page.locator('.project-card').filter({hasText:NAME}).getByRole('button',{name:/Mở dự án/}).click();
 await expect(segments(page)).toHaveCount(8);await expect(page.locator('.chapter-chip')).toHaveCount(2);
});
test('an edit to the open project is saved before the demo opens, and is still there when it is reopened',async({page})=>{
 await page.goto('/');await nav(page,'Dự án');
 await page.getByRole('textbox',{name:'Tên dự án mới'}).fill('Dự án A');await page.getByRole('button',{name:'Tạo dự án'}).click();
 await page.getByRole('button',{name:'Viết đoạn đầu tiên'}).click();
 const text=page.getByRole('textbox',{name:'Nội dung đoạn 1'});await text.fill('Một đoạn viết dở trước khi mở dự án mẫu.');
 await palette(page,DEMO_COMMAND); // before the 900 ms autosave
 await expect(segments(page)).toHaveCount(8);
 await nav(page,'Dự án');await page.locator('.project-card').filter({hasText:'Dự án A'}).getByRole('button',{name:/Mở dự án/}).click();
 await expect(page.getByRole('textbox',{name:'Nội dung đoạn 1'})).toHaveValue('Một đoạn viết dở trước khi mở dự án mẫu.');
});
test('opening the demo on the desktop sends no job',async({page})=>{
 await desktop(page);await palette(page,DEMO_COMMAND);await expect(segments(page)).toHaveCount(8);
 expect(await page.evaluate(()=>(window as any).__cmds)).not.toContain('enqueue_job');
 expect(await page.evaluate(()=>(window as any).__names())).toEqual([NAME]);
});
test('the first-run checklist offers the demo for its second step',async({page})=>{
 await desktop(page);
 await page.locator('.first-run').getByRole('button',{name:'Mở dự án mẫu'}).click();
 await expect(segments(page)).toHaveCount(8);
 await expect(page.locator('.first-run').getByText('Đã xong',{exact:true})).toHaveCount(1);
});
test('a failed first save leaves no demo project behind, shows the error, and a retry opens the full demo',async({page})=>{
 await desktop(page,{failSave:true});
 await palette(page,DEMO_COMMAND);
 await expect(page.getByRole('alert')).toContainText('SAVE_FAILED');
 expect(await page.evaluate(()=>(window as any).__names())).toEqual([]);
 await expect(segments(page)).toHaveCount(0);
 await palette(page,DEMO_COMMAND);await expect(segments(page)).toHaveCount(8);
 expect(await page.evaluate(()=>(window as any).__names())).toEqual([NAME]);
});
test('an empty demo project left by an older failed save is filled, not reopened empty',async({page})=>{
 await desktop(page,{preseed:true});
 await palette(page,DEMO_COMMAND);await expect(segments(page)).toHaveCount(8);
 expect(await page.evaluate(()=>(window as any).__names())).toEqual([NAME]);
});
test('a double click on the checklist step creates one demo project, not two',async({page})=>{
 await desktop(page,{delay:40});
 await page.locator('.first-run').getByRole('button',{name:'Mở dự án mẫu'}).dblclick();
 await expect(segments(page)).toHaveCount(8);
 expect(await page.evaluate(()=>(window as any).__names())).toEqual([NAME]);
});
test('refilling an empty demo keeps the transcript and the dictionary entries the user made',async({page})=>{
 await desktop(page,{preseed:'user'});
 await palette(page,DEMO_COMMAND);await expect(segments(page)).toHaveCount(8);
 const stored=await page.evaluate(n=>(window as any).__stored(n),NAME);
 expect(stored.segments).toHaveLength(8);
 expect(stored.transcript.map((r:any)=>r.text)).toEqual(['Dòng của người dùng.']);
 expect(stored.dictionary).toEqual({HTX:'hợp tác xã',ABC:'a bê xê'});
});
test('the first segment has the focus once the demo is open, from each entry point',async({page})=>{
 const first=()=>page.getByRole('textbox',{name:'Nội dung đoạn 1'});
 await page.goto('/');await page.getByRole('button',{name:'Mở dự án mẫu'}).click();await expect(segments(page)).toHaveCount(8);await expect(first()).toBeFocused();
 await page.evaluate(()=>localStorage.clear());await page.reload();await nav(page,'Dự án');
 await page.locator('.empty').getByRole('button',{name:'Mở dự án mẫu'}).click();await expect(segments(page)).toHaveCount(8);await expect(first()).toBeFocused();
});
test('the first segment has the focus after the checklist opens the demo',async({page})=>{
 await desktop(page);
 await page.locator('.first-run').getByRole('button',{name:'Mở dự án mẫu'}).click();
 await expect(segments(page)).toHaveCount(8);await expect(page.getByRole('textbox',{name:'Nội dung đoạn 1'})).toBeFocused();
});
test('a failed save of the open project stops the demo before it creates anything',async({page})=>{
 await desktop(page,{failSave:'always'});
 await nav(page,'Dự án');await page.getByRole('textbox',{name:'Tên dự án mới'}).fill('Dự án A');await page.getByRole('button',{name:'Tạo dự án'}).click();
 await page.getByRole('button',{name:'Viết đoạn đầu tiên'}).click();
 await page.getByRole('textbox',{name:'Nội dung đoạn 1'}).fill('Đoạn chưa lưu được.');
 await palette(page,DEMO_COMMAND);
 await expect(page.getByRole('alert')).toContainText('SAVE_FAILED');
 expect((await page.evaluate(()=>(window as any).__cmds)).filter((c:string)=>c==='create_project')).toHaveLength(1);
 expect(await page.evaluate(()=>(window as any).__names())).toEqual(['Dự án A']);
});
for(const width of [800,640])test(`the empty script page and the empty projects page do not scroll sideways at ${width} px`,async({page})=>{
 await page.setViewportSize({width,height:800});await page.goto('/');
 await expect(page.getByRole('button',{name:'Mở dự án mẫu'})).toBeVisible();
 const over=()=>page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth);
 expect(await over()).toBeLessThanOrEqual(0);
 await nav(page,'Dự án');await expect(page.locator('.empty').getByRole('button',{name:'Mở dự án mẫu'})).toBeVisible();expect(await over()).toBeLessThanOrEqual(0);
});
