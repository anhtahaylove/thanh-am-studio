import {test,expect,type Page} from '@playwright/test';
// The "Đang thực hiện…" indicator is fixed at the bottom right and must stay clear of the audio dock (sticky at the bottom of the window) at every window size, scroll position and dock content.
// Every cell of a width × height × scroll grid must leave the indicator fully on screen (8 px from every window edge) and, wherever the window has room for it above or below the dock (10 px apart), clear of the dock rect grown by 8 px; where there is no such room it must still be on screen. Each cell is logged as one BUSYGAP line (parseable key=value pairs; gap = dock.top − indicator.bottom, for diagnostics only).
// Tauri is mocked as in busy-focus: "Xuất audio" finishes only when a test makes it fail (`__failExport`), so the indicator stays up while the window is resized and scrolled. The "rich" dock has the subtitle options, a chapter and a take strip.
const mock=(rich:boolean)=>{
 const w=window as any,now=new Date().toISOString();w.isTauri=true;w.__hold=false;
 const take=(id:string)=>({id,asset_id:'a'+id,path:id+'.wav',duration_ms:3000,sample_rate:48000,created_at:now});
 const seg=(n:number)=>{const id=String(n);return {id,text:'Câu '+id+'. Một câu đủ dài để kịch bản cao hơn cửa sổ.',normalized_text:'Câu '+id+'.',voice_id:null,speaker:'Người dẫn',gap_ms:300,takes:rich&&n===1?[take('t1'),take('t1b')]:[take('t'+id)],selected_take_id:'t'+id,trim_start_ms:0,trim_end_ms:null,fade_in_ms:0,fade_out_ms:0,gain_db:0,...(rich?{cue_start_ms:n*2000,cue_end_ms:n*2000+2000,chapter:n===1||n===8?'Chương '+n:null}:{})};};
 const project={id:'p1',name:'Lồng tiếng',updated_at:now,revision:1,segments:Array.from({length:14},(_,i)=>seg(i+1)),transcript:[],dictionary:{},source_asset_id:null};
 w.__TAURI_INTERNALS__={convertFileSrc:(p:string)=>p,transformCallback:()=>1,unregisterCallback:()=>{},metadata:{currentWindow:{label:'main'},currentWebview:{label:'main',windowLabel:'main'}},invoke:async(cmd:string)=>{switch(cmd){
  case 'list_projects':return [{id:'p1',name:project.name,updated_at:now,revision:1}];case 'load_project':return JSON.parse(JSON.stringify(project));
  case 'list_jobs':if(w.__hold)return new Promise(()=>{});return [];
  case 'list_voices':case 'list_models':return [];case 'get_settings':return {dictionary:{}};
  case 'runtime_status':return {python_ready:true,ffmpeg_ready:true,worker_ready:true,native_worker_ready:true,python_path:null,ffmpeg_path:null,native_worker_path:null,fallback_count:0,total_memory_mb:7910,message:''};
  case 'enqueue_job':return new Promise((_,reject)=>{w.__failExport=()=>reject('WORKER_ERROR: disk full');});
  case 'plugin:dialog|save':return 'C:/x/ban-xuat.wav';default:return null;}}};
};
const nav=(page:Page,name:string)=>page.getByRole('navigation',{name:'Điều hướng chính'}).getByRole('button',{name,exact:true});
const openProject=async(page:Page)=>{await nav(page,'Dự án').click();await page.getByRole('button',{name:'Mở dự án',exact:true}).click();await expect(page.locator('#audio-dock')).toBeVisible();};
const frames=(page:Page)=>page.evaluate(()=>new Promise<void>(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>requestAnimationFrame(()=>r())))));
type Rect={l:number;t:number;r:number;b:number};
type Snap={ind:Rect;dock:Rect;h:number};
const snap=(page:Page):Promise<Snap>=>page.evaluate(()=>{const f=(q:string)=>{const b=document.querySelector(q)!.getBoundingClientRect();return {l:b.left,t:b.top,r:b.right,b:b.bottom};};return {ind:f('.busy-indicator'),dock:f('#audio-dock'),h:innerHeight};});
// `spot`: the dock is off screen, or the indicator fits on screen above it or below it with 10 px between them.
const verdict=({ind,dock,h}:Snap)=>{
 const ih=ind.b-ind.t,onScreen=ind.t>=8&&ind.b<=h-8,clear=ind.r<=dock.l-8||ind.l>=dock.r+8||ind.b<=dock.t-8||ind.t>=dock.b+8;
 const spot=!(dock.t<h&&dock.b>0)||dock.t-10-ih>=8||dock.b+10+ih<=h-8;
 return {spot,onScreen,clear,ok:onScreen&&(clear||!spot)};
};
// Every cell of widths × heights × {top, end}; `label` names the dock and is part of every logged line. Returns the cells that fail.
const sweep=async(page:Page,label:string,widths:number[],heights:number[]):Promise<string[]>=>{
 const bad:string[]=[];
 for(const h of heights)for(const w of widths){
  await page.setViewportSize({width:w,height:h});
  for(const scroll of ['top','end']){
   await page.evaluate(s=>window.scrollTo(0,s==='top'?0:document.documentElement.scrollHeight),scroll);await frames(page);await page.waitForTimeout(60);
   const m=await snap(page),v=verdict(m),n=(x:number)=>x.toFixed(1);
   console.log(`BUSYGAP test=${label} w=${w} h=${h} scroll=${scroll} gap=${n(m.dock.t-m.ind.b)} dockTop=${n(m.dock.t)} dockBottom=${n(m.dock.b)} dockLeft=${n(m.dock.l)} dockRight=${n(m.dock.r)} indTop=${n(m.ind.t)} indBottom=${n(m.ind.b)} indLeft=${n(m.ind.l)} indRight=${n(m.ind.r)} spot=${v.spot?1:0} onScreen=${v.onScreen?1:0} clear=${v.clear?1:0}`);
   if(!v.ok)bad.push(`${w}x${h} ${scroll}: ${v.onScreen?'overlaps the dock':'off screen'} (indicator ${n(m.ind.t)}..${n(m.ind.b)}, dock ${n(m.dock.t)}..${n(m.dock.b)})`);
  }
 }
 return bad;
};
const WIDTHS=[641,700,800,860,900,1024,1440],HEIGHTS=[720,900];
const exportAndHold=async(page:Page)=>{await page.getByRole('button',{name:'Xuất audio',exact:true}).click();await expect(page.locator('.busy-indicator')).toBeVisible();};

test('busy indicator stays on screen and clear of a plain audio dock at every width, height and scroll position',async({page})=>{
 await page.addInitScript(mock,false);await page.goto('/');await openProject(page);await exportAndHold(page);
 expect(await sweep(page,'plain',WIDTHS,HEIGHTS)).toEqual([]);
});
test('busy indicator stays on screen and clear of a dock with subtitle options, chapter options and a take strip',async({page})=>{
 await page.addInitScript(mock,true);await page.goto('/');await openProject(page);await exportAndHold(page);
 await page.getByText('Tùy chọn xuất',{exact:true}).click();await page.getByRole('checkbox',{name:'Theo mốc phụ đề'}).check();
 await expect(page.getByRole('checkbox',{name:'Giữ nhạc nền'})).toBeVisible();await expect(page.getByRole('checkbox',{name:'Mỗi chương một file'})).toBeVisible();await expect(page.getByRole('toolbar',{name:'So sánh take'})).toBeVisible();
 expect(await sweep(page,'rich',WIDTHS,HEIGHTS)).toEqual([]);
});
test('busy indicator stays on screen and clear of the dock in a 456 x 320 window',async({page})=>{
 await page.addInitScript(mock,true);await page.goto('/');await openProject(page);await exportAndHold(page);
 await page.getByText('Tùy chọn xuất',{exact:true}).click();await page.getByRole('checkbox',{name:'Theo mốc phụ đề'}).check();
 expect(await sweep(page,'tiny',[456],[320])).toEqual([]);
});
test('busy indicator started on the queue page stays clear of the dock once the page switches to the script',async({page})=>{
 await page.addInitScript(mock,true);await page.goto('/');await openProject(page);
 await nav(page,'Hàng đợi').click();await page.evaluate(()=>{(window as any).__hold=true;});
 await page.getByRole('button',{name:'Làm mới',exact:true}).click();await expect(page.locator('.busy-indicator')).toBeVisible();
 await nav(page,'Tạo giọng đọc').click();await expect(page.locator('#audio-dock')).toBeVisible();await expect(page.locator('.busy-indicator')).toBeVisible();
 expect(await sweep(page,'queue',[641,800,1024,1440],[720])).toEqual([]);
});
test('busy indicator follows a dock that grows while busy, with no resize or scroll',async({page})=>{
 await page.addInitScript(mock,true);await page.goto('/');await page.setViewportSize({width:800,height:720});await openProject(page);await exportAndHold(page);await page.getByText('Tùy chọn xuất',{exact:true}).click();await frames(page);
 const before=await snap(page);expect(verdict(before).ok,'clear before the dock grows').toBe(true);
 // A script click: a real click focuses the checkbox, which scrolls the page (scroll padding) and would wake the scroll listener, hiding a dead observer.
 const y=await page.evaluate(()=>scrollY);await page.getByRole('checkbox',{name:'Theo mốc phụ đề'}).evaluate((e:HTMLInputElement)=>e.click());await expect(page.getByRole('checkbox',{name:'Giữ nhạc nền'})).toBeVisible();await frames(page);
 expect(await page.evaluate(()=>scrollY),'the page did not scroll').toBe(y);
 const after=await snap(page);expect(after.dock.b-after.dock.t,'the dock grew').toBeGreaterThan(before.dock.b-before.dock.t+3);
 expect(verdict(after),'indicator after the dock grew').toMatchObject({spot:true,ok:true});
});
// Window scroll and resize listeners and ResizeObservers alive right now, counted from the page start.
const track=()=>{
 const w=window as any,on:{t:string;l:any;c:boolean}[]=[],cap=(o:any)=>typeof o==='object'?!!o?.capture:!!o,add=w.addEventListener.bind(w),del=w.removeEventListener.bind(w),live=new Set<any>(),RO=w.ResizeObserver;
 w.addEventListener=(t:string,l:any,o?:any)=>{if((t==='scroll'||t==='resize')&&!on.some(e=>e.t===t&&e.l===l&&e.c===cap(o)))on.push({t,l,c:cap(o)});return add(t,l,o);};
 w.removeEventListener=(t:string,l:any,o?:any)=>{const i=on.findIndex(e=>e.t===t&&e.l===l&&e.c===cap(o));if(i>=0)on.splice(i,1);return del(t,l,o);};
 w.ResizeObserver=class extends RO{constructor(cb:any){super(cb);live.add(this);}disconnect(){live.delete(this);super.disconnect();}};
 w.__alive=()=>[on.length,live.size];
};
test('the indicator removes its window listeners and its observer when busy ends',async({page})=>{
 await page.addInitScript(mock,false);await page.addInitScript(track);await page.goto('/');await openProject(page);
 await expect(page.locator('.busy-indicator')).toHaveCount(0);
 const alive=()=>page.evaluate(()=>(window as any).__alive() as number[]);
 const before=await alive();
 await exportAndHold(page);
 const during=await alive();expect(during[0],'scroll and resize listeners while busy').toBeGreaterThan(before[0]);expect(during[1],'observers while busy').toBeGreaterThan(before[1]);
 await page.evaluate(()=>(window as any).__failExport());await expect(page.locator('.busy-indicator')).toHaveCount(0);
 expect(await alive()).toEqual(before);
});
