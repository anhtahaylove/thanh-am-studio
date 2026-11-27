import {test,expect,type Page} from '@playwright/test';
// Round 1.0.26 C5 (PLAN §6): the transcript toolbar shows one menu button "Xuất…" holding TXT, SRT and VTT (menu items, names unchanged); "Thành kịch bản" stays a button.
// Each format saves as before (a save dialog named after the project, then export_text with the path and the text); focus never ends on <body>. Tauri is mocked.
const ROWS=[{id:'r1',start_ms:0,end_ms:900,text:'Chào chị.'},{id:'r2',start_ms:1000,end_ms:1900,text:'Khỏe không?'}];
const mock=(o:{rows:string}):void=>{
 const w=window as any;w.isTauri=true;w.__calls=[];w.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};
 const transcript=JSON.parse(o.rows),project={id:'p1',name:'Phỏng vấn',updated_at:'2026-01-01T00:00:00Z',revision:1,segments:[],transcript,dictionary:{},source_asset_id:null};
 w.__TAURI_INTERNALS__={convertFileSrc:(p:string)=>p,transformCallback:()=>1,unregisterCallback:()=>{},metadata:{currentWindow:{label:'main'},currentWebview:{label:'main',windowLabel:'main'}},
  invoke:async(cmd:string,args:any)=>{w.__calls.push({cmd,args:JSON.parse(JSON.stringify(args??{}))});switch(cmd){
   case 'list_projects':return [{id:project.id,name:project.name,updated_at:project.updated_at,revision:project.revision}];case 'load_project':return JSON.parse(JSON.stringify(project));
   case 'list_voices':case 'list_jobs':return [];case 'list_models':return [];case 'get_settings':return {dictionary:{}};
   case 'runtime_status':return {python_ready:true,ffmpeg_ready:true,worker_ready:true,native_worker_ready:true,python_path:null,ffmpeg_path:null,native_worker_path:null,fallback_count:0,message:''};
   case 'save_project':return {...JSON.parse(JSON.stringify(args.project)),revision:args.project.revision+1};
   case 'plugin:dialog|save':return 'C:/x/'+args.options.defaultPath;
   default:return null;}}};
};
const open=async(page:Page,rows=ROWS)=>{
 await page.addInitScript(mock,{rows:JSON.stringify(rows)});await page.goto('/');
 await page.getByRole('button',{name:'Dự án',exact:true}).click();await page.getByRole('button',{name:'Mở dự án',exact:true}).click();await page.getByRole('button',{name:'Chép lời',exact:true}).click();
 await expect(page.locator('.transcript-panel')).toBeVisible();
};
const panel=(page:Page)=>page.locator('.transcript-panel');
const menu=(page:Page)=>panel(page).getByRole('button',{name:'Xuất…',exact:true});
const item=(page:Page,name:string)=>panel(page).getByRole('menuitem',{name,exact:true});
const calls=(page:Page,cmd:string)=>page.evaluate(c=>((window as any).__calls as {cmd:string;args:any}[]).filter(x=>x.cmd===c),cmd);
const onBody=(page:Page)=>page.evaluate(()=>document.activeElement===document.body);
const EXPECTED={
 txt:'Chào chị.\n\nKhỏe không?',
 srt:'1\n00:00:00,000 --> 00:00:00,900\nChào chị.\n\n2\n00:00:01,000 --> 00:00:01,900\nKhỏe không?\n',
 vtt:'WEBVTT\n\n00:00:00.000 --> 00:00:00.900\nChào chị.\n\n00:00:01.000 --> 00:00:01.900\nKhỏe không?\n',
};

test('toolbar shows Xuất… with TXT, SRT and VTT as menu items inside it; Thành kịch bản stays a button',async({page})=>{
 await open(page);
 await expect(menu(page)).toHaveAttribute('aria-haspopup','menu');await expect(menu(page)).toHaveAttribute('aria-expanded','false');
 for(const n of ['TXT','SRT','VTT']){await expect(panel(page).getByRole('button',{name:n,exact:true}),`${n} is no toolbar button`).toHaveCount(0);await expect(item(page,n),`${n} waits inside the closed menu`).toHaveCount(0);}
 await expect(panel(page).getByRole('button',{name:'Thành kịch bản',exact:true})).toBeVisible();
 await menu(page).click();await expect(menu(page)).toHaveAttribute('aria-expanded','true');
 expect(await panel(page).getByRole('menuitem').evaluateAll(l=>l.map(i=>i.textContent))).toEqual(['TXT','SRT','VTT']);
 for(const n of ['TXT','SRT','VTT'])await expect(item(page,n)).not.toHaveAttribute('aria-disabled','true');
});

for(const ext of ['txt','srt','vtt'] as const)test(`${ext.toUpperCase()} saves the transcript as before and focus returns to Xuất…`,async({page})=>{
 await open(page);
 await menu(page).click();await item(page,ext.toUpperCase()).click();
 await expect.poll(async()=>(await calls(page,'export_text')).length).toBe(1);
 expect((await calls(page,'plugin:dialog|save'))[0].args.options.defaultPath).toBe(`Phỏng vấn.${ext}`);
 expect((await calls(page,'export_text'))[0].args).toEqual({path:`C:/x/Phỏng vấn.${ext}`,content:EXPECTED[ext]});
 await expect(menu(page)).toHaveAttribute('aria-expanded','false');await expect(page.getByRole('menuitem')).toHaveCount(0);
 await expect(menu(page)).toBeFocused();expect(await onBody(page)).toBe(false);
});

test('keyboard: Enter opens on TXT, the arrows and End reach VTT, Enter saves it and focus is back on Xuất…',async({page})=>{
 await open(page);
 await menu(page).focus();await page.keyboard.press('Enter');await expect(item(page,'TXT')).toBeFocused();
 await page.keyboard.press('End');await expect(item(page,'VTT')).toBeFocused();
 await page.keyboard.press('Enter');
 await expect.poll(async()=>(await calls(page,'export_text')).length).toBe(1);
 expect((await calls(page,'export_text'))[0].args.content).toBe(EXPECTED.vtt);
 await expect(menu(page)).toBeFocused();await expect(menu(page)).toHaveAttribute('aria-expanded','false');
 await menu(page).focus();await page.keyboard.press('Enter');await page.keyboard.press('Escape');await expect(menu(page)).toBeFocused();
});

test('with no transcript the items are aria-disabled with a reason, do nothing and keep the menu open',async({page})=>{
 await open(page,[]);
 await menu(page).click();
 for(const n of ['TXT','SRT','VTT']){
  await expect(item(page,n)).toHaveAttribute('aria-disabled','true');await expect(item(page,n)).toHaveAccessibleDescription('Chưa có nội dung để xuất');await expect(item(page,n)).toHaveAttribute('title','Chưa có nội dung để xuất');
 }
 await item(page,'SRT').focus();await item(page,'SRT').click({force:true});await page.keyboard.press('Enter');
 await expect(menu(page)).toHaveAttribute('aria-expanded','true');await expect(item(page,'SRT')).toBeFocused();
 expect(await calls(page,'plugin:dialog|save')).toHaveLength(0);expect(await calls(page,'export_text')).toHaveLength(0);
});
