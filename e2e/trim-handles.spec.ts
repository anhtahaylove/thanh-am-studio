import {test,expect,type Page} from '@playwright/test';
// Trim handles on the dock waveform: the selected take's bars show without Play, and two sliders write trim_start_ms / trim_end_ms.
// Tauri is mocked and records every call; the takes are real 4 s WAVs, one file per take. Segment 1 has take 1 (selected, trimmed to 500-3500 ms)
// and take 2; segments 2-6 have one take each. Spies count AudioContext constructions and decodeAudioData calls.
const tone=(level:number)=>{const rate=8000,n=rate*4,b=Buffer.alloc(44+n*2);b.write('RIFF',0);b.writeUInt32LE(36+n*2,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(rate,24);b.writeUInt32LE(rate*2,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(n*2,40);for(let i=0;i<n;i++)b.writeInt16LE(Math.round(Math.sin(i/rate*2*Math.PI*440)*32000*level),44+i*2);return b;};
const ratio=(a:string,b:string)=>{const lum=(c:string)=>{const [r,g,b]=c.match(/[\d.]+/g)!.slice(0,3).map(v=>{const x=Number(v)/255;return x<=0.03928?x/12.92:((x+0.055)/1.055)**2.4;});return 0.2126*r+0.7152*g+0.0722*b;};const [x,y]=[lum(a),lum(b)].sort((p,q)=>q-p);return (x+0.05)/(y+0.05);};
const KEYS='Mũi tên: 10 ms, Shift + mũi tên: 100 ms, Page Up/Page Down: 0,5 giây, Home/End: đầu hoặc cuối.';
const mock=()=>{
 const w=window as any;w.isTauri=true;w.__calls=[];w.__ctx=0;w.__decodes=0;
 const Ctx=window.AudioContext;(window as any).AudioContext=class extends Ctx{constructor(o?:AudioContextOptions){super(o);w.__ctx++;}};
 const decode=BaseAudioContext.prototype.decodeAudioData;BaseAudioContext.prototype.decodeAudioData=function(this:BaseAudioContext,...a:any[]){w.__decodes++;return (decode as any).apply(this,a);};
 const take=(id:string)=>({id,asset_id:'a'+id,path:`/${id}.wav`,duration_ms:4000,sample_rate:8000,created_at:'2026-11-23T00:00:00Z'});
 const seg=(n:number,takes:any[],trim:[number,number|null])=>({id:'s'+n,text:`Câu số ${n}.`,normalized_text:`Câu số ${n}.`,voice_id:null,speaker:'Người dẫn',gap_ms:300,takes,selected_take_id:takes[0].id,trim_start_ms:trim[0],trim_end_ms:trim[1],fade_in_ms:0,fade_out_ms:0,gain_db:0});
 let project:any={id:'p1',name:'Cắt take',updated_at:'2026-11-23T00:00:00Z',revision:1,transcript:[],dictionary:{},source_asset_id:null,segments:[seg(1,[take('s1'),take('s1b')],[500,3500]),...[2,3,4,5,6].map(n=>seg(n,[take('s'+n)],[0,null]))]};
 const ipc=(v:unknown)=>JSON.parse(JSON.stringify(v));
 w.__TAURI_INTERNALS__={convertFileSrc:(p:string)=>p,transformCallback:()=>1,unregisterCallback:()=>{},metadata:{currentWindow:{label:'main'},currentWebview:{label:'main',windowLabel:'main'}},
  invoke:async(cmd:string,args:any)=>{if(['save_project','enqueue_job'].includes(cmd))w.__calls.push({cmd,args:ipc(args)});switch(cmd){
   case 'list_projects':return [{id:project.id,name:project.name,updated_at:project.updated_at,revision:project.revision}];case 'load_project':return ipc(project);
   case 'list_jobs':case 'list_voices':case 'list_models':return [];case 'get_settings':return {dictionary:{}};
   case 'runtime_status':return {python_ready:true,ffmpeg_ready:true,worker_ready:true,python_path:null,ffmpeg_path:null,message:''};
   case 'save_project':project={...ipc(args.project),revision:args.project.revision+1};return ipc(project);
   case 'enqueue_job':return {id:'j'+w.__calls.length,kind:args.kind,project_id:args.projectId,payload:args.payload,status:'queued',progress:0,error:null,result:null,created_at:'2026-11-23T00:00:00Z',updated_at:'2026-11-23T00:00:00Z'};
   default:return null;}}};
};
const open=async(page:Page,width=1440,height=960)=>{
 await page.setViewportSize({width,height});
 await page.route(/\/s\d+b?\.wav$/,r=>{const id=new URL(r.request().url()).pathname.slice(1,-4);return r.fulfill({body:tone(id==='s1b'?.9:.2+.1*Number(id.slice(1))),contentType:'audio/wav'});});
 await page.addInitScript(mock);await page.goto('/');
 await page.getByRole('button',{name:'Dự án',exact:true}).click();await page.getByRole('button',{name:'Mở dự án',exact:true}).click();
 await page.getByRole('heading',{level:1}).click(); // the take keys (1-9) act when focus is not in a field
};
const slider=(page:Page,name:'Cắt đầu'|'Cắt cuối')=>page.getByRole('slider',{name,exact:true});
const field=(page:Page,name:string)=>page.getByRole('spinbutton',{name});
const undo=(page:Page)=>page.getByRole('button',{name:'Hoàn tác (Ctrl+Z)'});
const spy=(page:Page)=>page.evaluate(()=>{const w=window as any;return {ctx:w.__ctx as number,decodes:w.__decodes as number,calls:w.__calls as {cmd:string;args:any}[]};});
const rendered=async(page:Page)=>{await page.getByRole('button',{name:'Xuất audio',exact:true}).click();await expect.poll(async()=>(await spy(page)).calls.some(c=>c.cmd==='enqueue_job')).toBe(true);return (await spy(page)).calls.find(c=>c.cmd==='enqueue_job')!.args;};

test('the selected take shows its bars about 150 ms after selection without Play, and a quick run through 5 rows decodes only where it stops',async({page})=>{
 await open(page);
 await expect(page.locator('.waveform i')).toHaveCount(100); // segment 1, never played
 const t=await page.evaluate(async()=>{
  const rows=document.querySelectorAll<HTMLElement>('article.segment'),t0=performance.now(),frame=()=>new Promise(r=>requestAnimationFrame(r));
  rows[1].click();while(document.querySelector('.waveform i'))await frame();const gone=performance.now()-t0;
  while(!document.querySelector('.waveform i'))await frame();return {gone,back:performance.now()-t0};
 });
 expect(t.gone,'segment 1 bars cleared at once').toBeLessThan(100);expect(t.back,'decoded after the 150 ms pause').toBeGreaterThanOrEqual(140);expect(t.back).toBeLessThan(2000);
 await page.evaluate(()=>{(window as any).__decodes=0;});
 await page.evaluate(async()=>{const rows=document.querySelectorAll<HTMLElement>('article.segment');for(const i of [2,3,4,5]){rows[i].click();await new Promise(r=>setTimeout(r,40));}}); // rows 3-6, 40 ms apart
 await expect(page.locator('.waveform i')).toHaveCount(100);await page.waitForTimeout(600);
 expect((await spy(page)).decodes).toBeLessThanOrEqual(2);expect((await spy(page)).decodes).toBeGreaterThan(0);
 await expect(slider(page,'Cắt cuối')).toHaveAttribute('aria-valuenow','4000'); // segment 6's take, untrimmed
});

test('the bars are decoded offline: no AudioContext exists before the first Play, and Play makes one',async({page})=>{
 await open(page);
 await expect(page.locator('.waveform i')).toHaveCount(100);
 const before=await spy(page);expect(before.decodes).toBeGreaterThan(0);expect(before.ctx).toBe(0);
 await page.locator('.play-button').click();await expect(page.locator('.play-button')).toHaveAccessibleName('Dừng nghe thử');
 await expect.poll(async()=>(await spy(page)).ctx).toBe(1);
});

test('arrow keys move the start by 10 ms and Shift+arrow by 100 ms; the steps are one undo step',async({page})=>{
 await open(page);const start=slider(page,'Cắt đầu');
 await expect(start).toHaveAttribute('aria-valuenow','500');await expect(undo(page)).toBeDisabled();
 await start.focus();
 for(let i=0;i<5;i++)await page.keyboard.press('ArrowRight');
 for(let i=0;i<2;i++)await page.keyboard.press('Shift+ArrowRight');
 await expect(start).toHaveAttribute('aria-valuenow','750');await expect(start).toHaveAttribute('aria-valuetext','0,75 giây');
 await expect(field(page,'Cắt đầu (ms)')).toHaveValue('750');
 await expect(page.locator('.trim-readout')).toHaveText('Giữ từ 0,75 đến 3,50 giây');await expect(page.locator('.trim-readout')).toHaveAttribute('aria-hidden','true');
 await page.keyboard.press('Control+z');
 await expect(start).toHaveAttribute('aria-valuenow','500');await expect(field(page,'Cắt đầu (ms)')).toHaveValue('500');await expect(undo(page)).toBeDisabled();
 // Page Up/Down 500 ms, Home/End the bounds; the end handle's bounds follow the start.
 await page.keyboard.press('PageUp');await expect(start).toHaveAttribute('aria-valuenow','1000');
 await page.keyboard.press('PageDown');await page.keyboard.press('PageDown');await expect(start).toHaveAttribute('aria-valuenow','0');
 await page.keyboard.press('End');await expect(start).toHaveAttribute('aria-valuenow','3450');await expect(start).toHaveAttribute('aria-valuemax','3450');
 await expect(slider(page,'Cắt cuối')).toHaveAttribute('aria-valuemin','3500');
 await page.keyboard.press('Home');await expect(start).toHaveAttribute('aria-valuenow','0');await expect(start).toHaveAttribute('aria-valuemin','0');
 await page.keyboard.press('Tab');await expect(slider(page,'Cắt cuối')).toBeFocused();
 await page.keyboard.press('ArrowLeft');await expect(slider(page,'Cắt cuối')).toHaveAttribute('aria-valuenow','3490');
});

test('a drag shows a draft and commits once on release: one undo step',async({page})=>{
 await open(page);const end=slider(page,'Cắt cuối');
 await expect(end).toHaveAttribute('aria-valuenow','3500');
 const box=(await end.boundingBox())!,wave=(await page.locator('.waveform').boundingBox())!,x=(f:number)=>wave.x+12+(wave.width-24)*f,y=box.y+box.height/2;
 await page.mouse.move(box.x+box.width/2,y);await page.mouse.down();
 // Moves spread over more than a second: a commit per move would make several undo steps (edits only merge within 1 s).
 for(const f of [.8,.75,.7]){await page.mouse.move(x(f),y,{steps:3});await page.waitForTimeout(450);}
 const draft=Number(await end.getAttribute('aria-valuenow'));expect(Math.abs(draft-2800)).toBeLessThanOrEqual(30);
 await expect(field(page,'Cắt cuối (ms)')).toHaveValue('3500');expect((await spy(page)).calls.filter(c=>c.cmd==='save_project')).toHaveLength(0); // the draft is only drawn
 await expect(page.locator('.trim-readout')).toBeVisible();
 await page.mouse.up();
 await expect(field(page,'Cắt cuối (ms)')).toHaveValue(String(draft));await expect(end).toHaveAttribute('aria-valuenow',String(draft));
 await expect(undo(page)).toBeEnabled();await page.keyboard.press('Control+z');
 await expect(end).toHaveAttribute('aria-valuenow','3500');await expect(field(page,'Cắt cuối (ms)')).toHaveValue('3500');await expect(undo(page)).toBeDisabled();
});

test('Esc during a drag drops the draft and commits nothing',async({page})=>{
 await open(page);const start=slider(page,'Cắt đầu'),trimmed=()=>page.locator('.waveform i.trimmed').count();
 const before=await trimmed(),box=(await start.boundingBox())!,wave=(await page.locator('.waveform').boundingBox())!,y=box.y+box.height/2;
 await page.mouse.move(box.x+box.width/2,y);await page.mouse.down();await page.mouse.move(wave.x+12+(wave.width-24)*.5,y,{steps:4});
 await expect(start).toHaveAttribute('aria-valuenow',/^(19[7-9]\d|20[0-2]\d)$/);expect(await trimmed()).toBeGreaterThan(before+20); // the bars follow the draft
 await page.keyboard.press('Escape');
 await expect(start).toHaveAttribute('aria-valuenow','500');expect(await trimmed()).toBe(before);
 await page.mouse.move(wave.x+12+(wave.width-24)*.3,y);await page.mouse.up();await page.waitForTimeout(300);
 await expect(start).toHaveAttribute('aria-valuenow','500');await expect(field(page,'Cắt đầu (ms)')).toHaveValue('500');await expect(undo(page)).toBeDisabled();
});

test('the render payload carries the trims set with the handles; the other segments are unchanged',async({page})=>{
 await open(page);
 await slider(page,'Cắt đầu').focus();for(let i=0;i<3;i++)await page.keyboard.press('ArrowRight');
 await slider(page,'Cắt cuối').focus();await page.keyboard.press('PageDown');
 await expect(slider(page,'Cắt cuối')).toHaveAttribute('aria-valuenow','3000');
 const payload=await rendered(page);
 expect(payload.kind).toBe('render');
 expect(payload.payload.segments.map((s:any)=>[s.id,s.trim_start_ms,s.trim_end_ms])).toEqual([['s1',530,3000],...[2,3,4,5,6].map(n=>['s'+n,0,null])]);
});

test('the end handle at the take end stores null (the whole take)',async({page})=>{
 await open(page);const end=slider(page,'Cắt cuối');
 await end.focus();await page.keyboard.press('End');
 await expect(end).toHaveAttribute('aria-valuenow','4000');await expect(end).toHaveAttribute('aria-valuetext','4,00 giây');await expect(field(page,'Cắt cuối (ms)')).toHaveValue('4000');
 const payload=await rendered(page);
 expect(payload.payload.segments[0]).toMatchObject({trim_start_ms:500,trim_end_ms:null});
});

test('an auditioned take that is not the selected one shows no handles',async({page})=>{
 await open(page);
 await expect(page.getByRole('slider')).toHaveCount(2);
 await page.keyboard.press('2');await expect(page.locator('.audio-control strong')).toHaveText('Take 2');
 await expect(page.getByRole('img',{name:'Dạng sóng âm thanh'})).toBeVisible();await expect(page.getByRole('slider')).toHaveCount(0);
 await page.keyboard.press('1');await expect(page.locator('.audio-control strong')).toHaveText('Take 1');
 await expect(page.getByRole('slider')).toHaveCount(2);
});

for(const [width,height] of [[1024,720],[1440,960]])test(`at ${width}x${height} the handles are labelled, reachable, at least 24x38 px, ringed on keyboard focus, AA in both themes, still under reduced motion, and nothing scrolls sideways`,async({page})=>{
 await page.emulateMedia({reducedMotion:'reduce'});
 await open(page,width,height);
 const group=page.getByRole('group',{name:'Cắt take trên dạng sóng'}),start=slider(page,'Cắt đầu'),end=slider(page,'Cắt cuối');
 await expect(group).toBeVisible();
 for(const [s,min,max,now,text] of [[start,'0','3450','500','0,50 giây'],[end,'550','4000','3500','3,50 giây']] as const){
  await expect(s).toHaveAttribute('aria-valuemin',min);await expect(s).toHaveAttribute('aria-valuemax',max);await expect(s).toHaveAttribute('aria-valuenow',now);await expect(s).toHaveAttribute('aria-valuetext',text);
  await expect(s).toHaveAccessibleDescription(KEYS);
 }
 const wave=(await page.locator('.waveform').boundingBox())!;
 for(const s of [start,end]){const b=(await s.boundingBox())!;expect(b.width).toBeGreaterThanOrEqual(24);expect(b.height).toBeGreaterThanOrEqual(38);expect(b.x).toBeGreaterThanOrEqual(wave.x-0.5);expect(b.x+b.width).toBeLessThanOrEqual(wave.x+wave.width+0.5);}
 // Keyboard focus: Shift+Tab from the end handle lands on the start handle with a visible ring.
 await end.focus();await page.keyboard.press('Shift+Tab');await expect(start).toBeFocused();
 const look=await start.evaluate(el=>{const s=getComputedStyle(el),line=getComputedStyle(el,'::before'),dock=getComputedStyle(el.closest('.audio-dock')!),r=document.querySelector('.trim-readout')!,rs=getComputedStyle(r),rb=r.getBoundingClientRect();
  return {visible:el.matches(':focus-visible'),outline:s.outlineStyle,width:s.outlineWidth,ring:s.outlineColor,line:line.backgroundColor,dock:dock.backgroundColor,text:rs.color,textBg:rs.backgroundColor,motion:[s.transitionDuration,line.transitionDuration],readout:[rb.left,rb.right],sideways:document.documentElement.scrollWidth-innerWidth};});
 expect(look.visible).toBe(true);expect(look.outline).toBe('solid');expect(look.width).toBe('2px');
 expect(look.motion).toEqual(['0s','0s']);expect(look.sideways).toBeLessThanOrEqual(0);expect(look.readout[0]).toBeGreaterThanOrEqual(0);expect(look.readout[1]).toBeLessThanOrEqual(width);
 for(const theme of ['light','dark']){
  if(theme==='dark'){await page.getByRole('button',{name:'Chuyển giao diện tối'}).click();await expect(page.locator('html')).toHaveAttribute('data-theme','dark');await start.focus();await page.keyboard.press('Shift+Tab');await page.keyboard.press('Tab');await expect(start).toBeFocused();}
  const c=await start.evaluate(el=>{const s=getComputedStyle(el),dock=getComputedStyle(el.closest('.audio-dock')!).backgroundColor,r=getComputedStyle(document.querySelector('.trim-readout')!);return {line:getComputedStyle(el,'::before').backgroundColor,ring:s.outlineColor,dock,text:r.color,textBg:r.backgroundColor};});
  expect(ratio(c.line,c.dock),`${theme}: handle line`).toBeGreaterThanOrEqual(3);expect(ratio(c.ring,c.dock),`${theme}: focus ring`).toBeGreaterThanOrEqual(3);expect(ratio(c.text,c.textBg),`${theme}: readout`).toBeGreaterThanOrEqual(4.5);
 }
});
