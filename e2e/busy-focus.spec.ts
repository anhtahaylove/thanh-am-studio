import {test,expect,type Page} from '@playwright/test';
// A busy action disables the control that started it, which drops keyboard focus to <body>; focus comes back when the action ends,
// unless the user focused or clicked somewhere else meanwhile.
// A rejected play() shows a Vietnamese message, and one a pause interrupted (AbortError) shows nothing. Tauri is mocked as in model-cards,
// export-bar and transcript-seek; the transcript source is a WAV served by page.route, or a 415 answer that is not audio.
const mock=(exportMs:number)=>{
 const w=window as any,now=new Date().toISOString();w.isTauri=true;w.__rejected=[];let settings:any={dictionary:{}};
 // Every rejected play() is recorded by name, so a test can tell that the case it stages really happened.
 const play=HTMLMediaElement.prototype.play;HTMLMediaElement.prototype.play=function(this:HTMLMediaElement){const p=play.call(this);p.catch(e=>w.__rejected.push(e.name));return p;};
 const take=(id:string)=>({id,asset_id:'a'+id,path:id+'.wav',duration_ms:3000,sample_rate:48000,created_at:now});
 const seg=(id:string)=>({id,text:'Câu '+id+'.',normalized_text:'Câu '+id+'.',voice_id:null,speaker:'Người dẫn',gap_ms:300,takes:[take('t'+id)],selected_take_id:'t'+id,trim_start_ms:0,trim_end_ms:null,fade_in_ms:0,fade_out_ms:0,gain_db:0});
 const project={id:'p1',name:'Lồng tiếng',updated_at:now,revision:1,segments:[seg('1'),seg('2')],transcript:[{id:'r1',start_ms:0,end_ms:4000,text:'một câu mở đầu',speaker:0},{id:'r2',start_ms:10000,end_ms:14000,text:'aaa bbb ccc ddd',speaker:0}],dictionary:{},source_asset_id:'src'};
 const later=(ms:number)=>new Promise(r=>setTimeout(r,ms));
 w.__TAURI_INTERNALS__={convertFileSrc:(p:string)=>p,transformCallback:()=>1,unregisterCallback:()=>{},metadata:{currentWindow:{label:'main'},currentWebview:{label:'main',windowLabel:'main'}},invoke:async(cmd:string,args:any)=>{switch(cmd){
  case 'list_projects':return [{id:'p1',name:project.name,updated_at:now,revision:1}];case 'load_project':return JSON.parse(JSON.stringify(project));
  case 'list_jobs':case 'list_voices':case 'list_models':return [];case 'get_settings':return settings;
  case 'runtime_status':return {python_ready:true,ffmpeg_ready:true,worker_ready:true,native_worker_ready:true,python_path:null,ffmpeg_path:null,native_worker_path:null,fallback_count:0,total_memory_mb:7910,message:''};
  case 'get_asset':return {id:'src',path:'/tone.wav',name:'phong-van.wav',duration_ms:20000,sample_rate:8000};
  case 'save_settings':await later(300);settings=args.settings;return settings;
  case 'enqueue_job':await later(exportMs);throw 'WORKER_ERROR: disk full';
  case 'plugin:dialog|save':return 'C:/x/ban-xuat.wav';default:return null;}}};
};
const tone=()=>{const rate=8000,n=rate*20,b=Buffer.alloc(44+n*2);b.write('RIFF',0);b.writeUInt32LE(36+n*2,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(rate,24);b.writeUInt32LE(rate*2,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(n*2,40);return b;};
const start=async(page:Page,exportMs=300)=>{await page.addInitScript(mock,exportMs);await page.goto('/');};
const openProject=async(page:Page)=>{await page.getByRole('button',{name:'Dự án',exact:true}).click();await page.getByRole('button',{name:'Mở dự án',exact:true}).click();};
const openTranscript=async(page:Page,audio:boolean)=>{
 await page.route('**/tone.wav',r=>audio?r.fulfill({body:tone(),headers:{'content-type':'audio/wav'}}):r.fulfill({status:415,body:'not audio',headers:{'content-type':'text/plain'}}));
 await start(page);await openProject(page);await page.getByRole('button',{name:'Chép lời',exact:true}).click();await expect(page.locator('.transcript-row')).toHaveCount(2);
};
const idle=(page:Page)=>expect(page.locator('.busy-indicator')).toHaveCount(0);
// "Xuất audio" pressed with Enter, with an export that fails after 1.5 s: room to act while it is busy.
const exporting=async(page:Page)=>{await start(page,1500);await openProject(page);const b=page.getByRole('button',{name:'Xuất audio',exact:true});await b.focus();await page.keyboard.press('Enter');await expect(b).toBeDisabled();return b;};
const failed=async(page:Page)=>{await expect(page.getByRole('alert')).toContainText('WORKER_ERROR: disk full');await idle(page);await page.waitForTimeout(200);};
const NOT_AUDIO='Không phát được audio này: tệp không còn hoặc định dạng không được hỗ trợ.';

// Mutation: `el.focus()` without `{preventScroll:true}` scrolls a button the user has scrolled away from back into view.
test('focus given back to "Xuất audio" does not scroll the page to it',async({page})=>{
 const button=await exporting(page);
 await page.evaluate(()=>{document.body.style.minHeight='4000px';window.scrollTo(0,2000);});
 const y=await page.evaluate(()=>window.scrollY);expect(y,'the page was scrolled away').toBeGreaterThan(500);
 expect(await button.evaluate(e=>{const r=e.getBoundingClientRect();return r.bottom<0||r.top>innerHeight;}),'the button is out of view').toBe(true);
 await failed(page);await expect(button).toBeFocused();
 expect(await page.evaluate(()=>window.scrollY)).toBe(y);
});
test('a processor select changed with the keyboard gets focus back once its save ends',async({page})=>{
 await start(page);await page.getByRole('navigation',{name:'Điều hướng chính'}).getByRole('button',{name:'Model & cài đặt',exact:true}).click();
 await page.getByText('Nâng cao: bộ xử lý').click();
 const select=page.locator('.engine-rows label').filter({hasText:'Đọc văn bản'}).locator('select');
 await select.focus();await page.keyboard.press('ArrowDown');
 await expect(select).toBeDisabled();await idle(page);await expect(select).toHaveValue('python');await expect(select).toBeEnabled();
 await expect(select).toBeFocused();
});
test('"Xuất audio" pressed with Enter gets focus back when the export fails',async({page})=>{
 await start(page);await openProject(page);
 const button=page.getByRole('button',{name:'Xuất audio',exact:true});
 await button.focus();await page.keyboard.press('Enter');
 await expect(button).toBeDisabled();await idle(page);await expect(page.getByRole('alert')).toContainText('WORKER_ERROR: disk full');
 await expect(button).toBeFocused();
});
test('a source that is not audio shows the Vietnamese message, not the DOMException name',async({page})=>{
 await openTranscript(page,false);
 await page.locator('[data-row="r2"] textarea').press('Control+Enter');
 await expect(page.getByRole('alert')).toContainText(NOT_AUDIO);
 await expect(page.getByRole('alert')).not.toContainText('NotSupportedError');
 expect(await page.evaluate(()=>(window as any).__rejected)).toContain('NotSupportedError');
});
test('a pause right after play shows no alert',async({page})=>{
 await openTranscript(page,true);
 await page.locator('[data-row="r2"] textarea').evaluate(t=>{t.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,bubbles:true,cancelable:true}));document.querySelector<HTMLAudioElement>('.source-player audio')!.pause();});
 await expect.poll(()=>page.evaluate(()=>(window as any).__rejected)).toEqual(['AbortError']);
 await page.waitForTimeout(300);await expect(page.getByRole('alert')).toHaveCount(0);
});
test('a save started with Ctrl+S while the export is busy does not take the way back from "Xuất audio"',async({page})=>{
 const button=await exporting(page);await expect.poll(()=>page.evaluate(()=>document.activeElement===document.body)).toBe(true);
 await page.keyboard.press('Control+s');await failed(page);
 await expect(button).toBeFocused();
});
test('a field the user focuses while the export is busy keeps focus when it ends',async({page})=>{
 await exporting(page);const text=page.locator('textarea[aria-label="Nội dung đoạn 1"]');await text.focus();
 await failed(page);await expect(text).toBeFocused();
});
test('a click while the export is busy leaves focus where the user put it',async({page})=>{
 const button=await exporting(page);await page.locator('.page-heading h1').click();
 expect(await page.evaluate(()=>document.activeElement===document.body)).toBe(true);
 await failed(page);await expect(button).not.toBeFocused();expect(await page.evaluate(()=>document.activeElement===document.body)).toBe(true);
});
test('Space on the transcript page with a source that is not audio shows the Vietnamese message',async({page})=>{
 await openTranscript(page,false);await page.evaluate(()=>(document.activeElement as HTMLElement|null)?.blur());
 await page.keyboard.press('Space');
 await expect(page.getByRole('alert')).toContainText(NOT_AUDIO);await expect(page.getByRole('alert')).not.toContainText('NotSupportedError');
});
test('a speaker sample whose source is not audio shows the message and its button goes back to "Nghe mẫu"',async({page})=>{
 await openTranscript(page,false);await page.getByRole('button',{name:'Nghe mẫu Người 1',exact:true}).click();
 await expect(page.getByRole('alert')).toContainText(NOT_AUDIO);
 await expect(page.getByRole('button',{name:'Nghe mẫu Người 1',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Dừng mẫu Người 1',exact:true})).toHaveCount(0);
});
