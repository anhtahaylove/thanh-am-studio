import {test,expect,type Page} from '@playwright/test';
// A 12-segment project, a speaker-labelled transcript, a voice, a model and jobs in three states, served by a mocked Tauri bridge.
const mock=()=>{
 const w=window as any,now=new Date().toISOString();w.isTauri=true;
 const line='buổi sáng ở làng chài Mũi Né bắt đầu từ lúc bốn giờ, khi những chiếc thuyền thúng rẽ sóng trở về bến.';
 const take=(id:string)=>({id,asset_id:'a'+id,path:id+'.wav',duration_ms:3000,sample_rate:48000,created_at:now,check:{model:'whisper-small',wer:0,heard:line,mismatches:[]}});
 const segments=Array.from({length:12},(_,i)=>({id:'s'+i,text:i?`Đoạn ${i+1}: ${line}`:`Đoạn 1: ${line} ${line} ${line} ${line}`,normalized_text:line,voice_id:null,speaker:'Người dẫn',gap_ms:300,takes:[take('t'+i)],selected_take_id:'t'+i,trim_start_ms:0,trim_end_ms:null,fade_in_ms:0,fade_out_ms:0,gain_db:0,cue_start_ms:i*6500,cue_end_ms:i*6500+6000,chapter:i%4?null:`Chương ${i/4+1} · Làng chài`}));
 const transcript=Array.from({length:6},(_,i)=>({id:'r'+i,start_ms:i*4000,end_ms:i*4000+3500,text:'Xin chào quý vị, hôm nay chúng ta trò chuyện với ngư dân.',speaker:i%2,...(i===2?{overlap_speaker:0}:{})}));
 let project={id:'p1',name:'Làng chài Mũi Né',updated_at:now,revision:1,segments,transcript,dictionary:{},source_asset_id:null};
 const job=(id:string,kind:string,status:string)=>({id,kind,project_id:'p1',payload:{name:'Làng chài Mũi Né'},status,progress:status==='running'?.4:1,error:status==='failed'?'FFmpeg dừng với mã 1.':null,result:status==='succeeded'?{transcript:[]}:null,created_at:now,updated_at:now});
 const jobs=[job('j1','tts','running'),job('j2','render','failed'),job('j3','stt','succeeded')];
 const voices=[{id:'v1',name:'Giọng kể của Lan',kind:'reference',reference_asset_id:'ra1',consent:true,engine_voice_id:null}];
 const models=[{id:'whisper-small',name:'Whisper Small',engine:'stt',kind:'model',installed:true,revision:'9f8e7d6c5b4a3921',license:'MIT',description:'Chép lời nhanh, nhẹ, chạy tốt trên CPU.'}];
 w.__TAURI_INTERNALS__={convertFileSrc:(p:string)=>p,transformCallback:()=>1,unregisterCallback:()=>{},metadata:{currentWindow:{label:'main'},currentWebview:{label:'main',windowLabel:'main'}},
  invoke:async(cmd:string,args:any)=>{switch(cmd){
   case 'list_projects':return [project];case 'load_project':return project;case 'list_jobs':return jobs;case 'list_voices':return voices;case 'list_models':return models;case 'get_settings':return {dictionary:{}};
   case 'runtime_status':return {python_ready:true,ffmpeg_ready:true,worker_ready:true,python_path:null,ffmpeg_path:null,message:''};
   case 'save_project':project={...args.project,revision:args.project.revision+1};return project;
   default:return null;}}};
};
const pages:[string,string][]=[['Tạo giọng đọc','.segment'],['Chép lời','.transcript-row'],['Thư viện giọng','.voice-card'],['Hàng đợi','.job-row'],['Dự án','.project-card'],['Model & cài đặt','.model-card']];
const open=async(page:Page,width:number,height:number)=>{
 await page.setViewportSize({width,height});await page.addInitScript(mock);await page.goto('/');
 await page.getByRole('button',{name:'Dự án',exact:true}).click();await page.getByRole('button',{name:'Mở dự án',exact:true}).click();
 await expect(page.getByRole('textbox',{name:/^Nội dung đoạn/})).toHaveCount(12);await page.getByText('Chỉnh âm',{exact:true}).click(); // the tuning group stays open, so its fields keep the size, border and ellipsis checks they had
};
// "Dự án" is the top-bar button; "Thư viện giọng" is a section of the models page (opened once).
const nav=async(page:Page,name:string)=>{
 if(name==='Dự án')return page.locator('.topbar').getByRole('button',{name,exact:true}).click();
 if(name!=='Thư viện giọng')return page.getByRole('navigation',{name:'Điều hướng chính'}).getByRole('button',{name:new RegExp('^'+name)}).click();
 await nav(page,'Model & cài đặt');const section=page.locator('details.mc-voices');if(!await section.evaluate(d=>(d as HTMLDetailsElement).open))await section.locator('summary').click();
};
test('the export action stays on screen and the page is the only scroller',async({page})=>{
 await open(page,1280,800);
 const exportAudio=page.getByRole('button',{name:'Xuất audio'}),onScreen=()=>exportAudio.evaluate(b=>{const r=b.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight;});
 expect(await onScreen(),'at the top of the page').toBe(true);
 expect(await page.locator('.segment-list').evaluate(l=>l.scrollHeight<=l.clientHeight+1),'the script list does not scroll on its own').toBe(true);
 // The long first segment grows to show all its text instead of scrolling inside the box.
 expect(await page.getByRole('textbox',{name:'Nội dung đoạn 1',exact:true}).evaluate(t=>t.scrollHeight<=t.clientHeight+1)).toBe(true);
 await page.evaluate(()=>scrollTo(0,document.documentElement.scrollHeight/2));
 expect(await onScreen(),'halfway down the script').toBe(true);
});
test('the segment inspector stays in view next to a segment far down the script',async({page})=>{
 await open(page,1280,800);
 await page.getByRole('textbox',{name:'Nội dung đoạn 12',exact:true}).click();await expect(page.locator('.segment.selected .segment-index')).toHaveText('12');
 const m=await page.evaluate(()=>{const panel=document.querySelector('.inspector>.panel')!.getBoundingClientRect(),inspector=document.querySelector('.inspector')!.getBoundingClientRect();
  return {top:panel.top,bottom:inspector.bottom,dock:document.querySelector('.audio-dock')!.getBoundingClientRect().top,height:innerHeight};});
 expect(m.top,'inspector top').toBeGreaterThanOrEqual(0);expect(m.top,'inspector top').toBeLessThan(m.height);expect(m.bottom,'inspector bottom clears the dock').toBeLessThanOrEqual(m.dock);
});
test('script and transcript text boxes draw the input border, and speaker labels and chips are 24 px targets',async({page})=>{
 await open(page,1440,1000);
 // a11y.spec.ts checks that this input border keeps 3:1 contrast in both themes.
 const input=await page.getByLabel('Nghỉ sau (ms)').evaluate(e=>getComputedStyle(e).borderTopColor),border=(name:string)=>page.getByRole('textbox',{name,exact:true}).evaluate(e=>[getComputedStyle(e).borderTopStyle,getComputedStyle(e).borderTopColor]);
 expect(await border('Nội dung đoạn 2')).toEqual(['solid',input]);
 // The script's speaker labels set their height, so it does not hang on the font's line height.
 for(const [h,min] of await page.locator('.speaker-input').evaluateAll(l=>l.map(e=>[e.getBoundingClientRect().height,parseFloat(getComputedStyle(e).minHeight)])))expect([h,min].every(v=>v>=24),`height ${h}, min-height ${min}`).toBe(true);
 await nav(page,'Chép lời');expect(await border('Lời nói tại 00:00:04,000')).toEqual(['solid',input]);
 for(const h of await page.locator('.speaker-chip').evaluateAll(chips=>chips.map(c=>c.getBoundingClientRect().height)))expect(h).toBeGreaterThanOrEqual(24);
});
test('no visible text or field value is smaller than 11 px on any page',async({page})=>{
 await open(page,1440,1000);
 for(const [name,ready] of pages){
  await nav(page,name);await expect(page.locator(ready).first()).toBeVisible();
  const small=await page.evaluate(()=>[...document.querySelectorAll('body *')].filter(e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);
   const text=[...e.childNodes].some(n=>n.nodeType===3&&n.textContent!.trim())||e.matches('select,textarea,input:not([type=checkbox],[type=radio],[type=range],[type=file],[type=hidden])');
   return r.width>0&&r.height>0&&s.visibility!=='hidden'&&text&&parseFloat(s.fontSize)<11;})
   .map(e=>`${e.tagName.toLowerCase()}.${e.className} "${e.textContent!.trim().slice(0,30)}" ${getComputedStyle(e).fontSize}`));
  expect(small,name).toEqual([]);
 }
});
// e2e/desktop/packaged.mjs checks the layout at 1093x574 and at 1280 px wide; no label on these pages may end in an ellipsis there.
for(const [width,height] of [[1093,574],[1280,800]])test(`no label is cut off with an ellipsis at ${width}x${height}`,async({page})=>{
 await open(page,width,height);
 const cut:Record<string,string[]>={};
 for(const [name,ready] of pages){
  await nav(page,name);await expect(page.locator(ready).first()).toBeVisible();
  const found=await page.evaluate(()=>[...document.querySelectorAll('body *')].filter(e=>getComputedStyle(e).textOverflow==='ellipsis'&&e.getBoundingClientRect().width>0&&e.scrollWidth>e.clientWidth).map(e=>`${e.className} "${e.textContent!.trim()}"`));
  if(found.length)cut[name]=found;
 }
 expect(cut).toEqual({});
});
test('no page scrolls sideways at 800 px',async({page})=>{
 await open(page,800,700);
 for(const [name] of pages){
  await nav(page,name);await expect(page.locator('h1')).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth),name).toBeLessThanOrEqual(0);
 }
});
// The queue drawer (S3a): at 1200 px and below it lies over the right side of the page, so the focus stays inside it; Tab past its last control closes it and lands on a control
// that is in view and not under anything. Above 1200 px it is a column beside the page, which narrows the page instead of covering it.
const queue=async(page:Page)=>{const drawer=page.getByRole('complementary',{name:'Hàng đợi'});await page.getByRole('navigation',{name:'Điều hướng chính'}).getByRole('button',{name:/^Hàng đợi/}).click();await expect(drawer).toBeVisible();return drawer;};
const sideways=(page:Page)=>page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth);
for(const [width,height] of [[1024,720],[1093,574]])test(`at ${width}x${height} the open queue drawer lies over the page with no sideways scroll and holds the focus, and Tab past its last control closes it onto a visible control`,async({page})=>{
 await open(page,width,height);const drawer=await queue(page);
 expect(await drawer.evaluate(d=>d.contains(document.activeElement)),'focus is inside the drawer').toBe(true);
 expect(await sideways(page)).toBeLessThanOrEqual(0);
 const m=(await page.locator('main').boundingBox())!,d=(await drawer.boundingBox())!;expect(d.x,'the drawer lies over the page').toBeLessThan(m.x+m.width);
 await drawer.getByRole('button').last().focus();await page.keyboard.press('Tab');
 await expect(drawer).toBeHidden();
 const next=await page.evaluate(()=>{const a=document.activeElement as HTMLElement,r=a.getBoundingClientRect(),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
  return {name:a===document.body?'BODY':(a.getAttribute('aria-label')??a.textContent??'').trim().slice(0,40),inView:r.width>0&&r.top>=0&&r.left>=0&&r.bottom<=innerHeight&&r.right<=innerWidth,uncovered:!!hit&&(hit===a||a.contains(hit))};});
 expect(next.name,'focus went on to a control').not.toBe('BODY');expect(next,`the control after the drawer, "${next.name}"`).toMatchObject({inView:true,uncovered:true});
});
test('at 1280x800 the open queue drawer is a column beside the page: no sideways scroll, and the script column keeps at least 360 px',async({page})=>{
 await open(page,1280,800);const drawer=await queue(page);
 expect(await sideways(page)).toBeLessThanOrEqual(0);
 const m=(await page.locator('main').boundingBox())!,d=(await drawer.boundingBox())!;expect(d.x,'the drawer starts where the page ends').toBeGreaterThanOrEqual(m.x+m.width-1);
 expect((await page.locator('.script-panel').boundingBox())!.width,'script column width').toBeGreaterThanOrEqual(360);
});
test('dialogs fade in, and not when the system asks for reduced motion',async({page})=>{
 await open(page,1280,800);
 await page.getByRole('button',{name:'Thêm nội dung',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'Thêm nội dung'}),animation=()=>dialog.evaluate(d=>[getComputedStyle(d).animationName,getComputedStyle(d.parentElement!).animationName]);
 await expect(dialog).toBeVisible();expect(await animation()).toEqual(['pop-in','fade-in']);
 await page.emulateMedia({reducedMotion:'reduce'});expect(await animation()).toEqual(['none','none']);
});
