import {test,expect,type Page} from '@playwright/test';
// The "Đang thực hiện…" indicator is fixed at the bottom right and must stay clear of the audio dock (sticky at the bottom of the window) at every window size, scroll position and dock content.
// gap = dock.top − indicator.bottom in px, measured in each cell of a width × height × scroll grid; every cell must be at least 8 px. Each cell is logged as one BUSYGAP line (parseable: key=value pairs).
// Tauri is mocked as in busy-focus: "Xuất audio" never finishes, so the indicator stays up while the window is resized and scrolled. The "rich" dock has the subtitle options, a chapter and a take strip.
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
  case 'enqueue_job':return new Promise(()=>{});
  default:return null;}}};
};
const nav=(page:Page,name:string)=>page.getByRole('navigation',{name:'Điều hướng chính'}).getByRole('button',{name,exact:true});
const openProject=async(page:Page)=>{await nav(page,'Dự án').click();await page.getByRole('button',{name:'Mở dự án',exact:true}).click();await expect(page.locator('#audio-dock')).toBeVisible();};
const frames=(page:Page)=>page.evaluate(()=>new Promise<void>(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>requestAnimationFrame(()=>r())))));
type Cell={label:string;w:number;h:number;scroll:string;gap:number};
// Every cell of widths × heights × {top, end}; `label` names the dock and is part of every logged line.
const sweep=async(page:Page,label:string,widths:number[],heights:number[]):Promise<Cell[]>=>{
 const cells:Cell[]=[];
 for(const h of heights)for(const w of widths){
  await page.setViewportSize({width:w,height:h});
  for(const scroll of ['top','end']){
   await page.evaluate(s=>window.scrollTo(0,s==='top'?0:document.documentElement.scrollHeight),scroll);await frames(page);await page.waitForTimeout(60);
   const m=await page.evaluate(()=>{const i=document.querySelector('.busy-indicator')!.getBoundingClientRect(),d=document.querySelector('#audio-dock')!.getBoundingClientRect();return {gap:d.top-i.bottom,dockTop:d.top,indBottom:i.bottom,dockH:d.height,shown:d.top<innerHeight&&d.bottom>0};});
   console.log(`BUSYGAP test=${label} w=${w} h=${h} scroll=${scroll} gap=${m.gap.toFixed(1)} dockTop=${m.dockTop.toFixed(1)} indBottom=${m.indBottom.toFixed(1)} dockH=${m.dockH.toFixed(1)} dockShown=${m.shown?1:0}`);
   cells.push({label,w,h,scroll,gap:m.gap});
  }
 }
 return cells;
};
const tight=(cells:Cell[])=>cells.filter(c=>c.gap<8).map(c=>`${c.w}x${c.h} ${c.scroll}: ${c.gap.toFixed(1)} px`);
const WIDTHS=[641,700,800,860,900,1024,1440],HEIGHTS=[720,900];
const exportAndHold=async(page:Page)=>{await page.getByRole('button',{name:'Xuất audio',exact:true}).click();await expect(page.locator('.busy-indicator')).toBeVisible();};

test('busy indicator stays at least 8 px above a plain audio dock at every width, height and scroll position',async({page})=>{
 await page.addInitScript(mock,false);await page.goto('/');await openProject(page);await exportAndHold(page);
 expect(tight(await sweep(page,'plain',WIDTHS,HEIGHTS))).toEqual([]);
});
test('busy indicator stays at least 8 px above a dock with subtitle options, chapter options and a take strip',async({page})=>{
 await page.addInitScript(mock,true);await page.goto('/');await openProject(page);await exportAndHold(page);
 await page.getByRole('checkbox',{name:'Theo mốc phụ đề'}).check();
 await expect(page.getByRole('checkbox',{name:'Giữ nhạc nền'})).toBeVisible();await expect(page.getByRole('checkbox',{name:'Mỗi chương một file'})).toBeVisible();await expect(page.getByRole('toolbar',{name:'So sánh take'})).toBeVisible();
 expect(tight(await sweep(page,'rich',WIDTHS,HEIGHTS))).toEqual([]);
});
test('busy indicator stays at least 8 px above the dock in a 456 x 320 window',async({page})=>{
 await page.addInitScript(mock,true);await page.goto('/');await openProject(page);await exportAndHold(page);
 await page.getByRole('checkbox',{name:'Theo mốc phụ đề'}).check();
 expect(tight(await sweep(page,'tiny',[456],[320]))).toEqual([]);
});
test('busy indicator started on the queue page stays above the dock once the page switches to the script',async({page})=>{
 await page.addInitScript(mock,true);await page.goto('/');await openProject(page);
 await nav(page,'Hàng đợi').click();await page.evaluate(()=>{(window as any).__hold=true;});
 await page.getByRole('button',{name:'Làm mới',exact:true}).click();await expect(page.locator('.busy-indicator')).toBeVisible();
 await nav(page,'Tạo giọng đọc').click();await expect(page.locator('#audio-dock')).toBeVisible();await expect(page.locator('.busy-indicator')).toBeVisible();
 expect(tight(await sweep(page,'queue',[641,800,1024,1440],[720]))).toEqual([]);
});
