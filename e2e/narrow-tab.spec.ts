import {test,expect,type Page} from '@playwright/test';
import {readFileSync} from 'node:fs';
// At 920 px and below the selected segment's panel sits inside its row, so there keyboard focus alone does not select a row: Tab walks past
// unselected rows, and a key pressed in a row selects it. Windows text size reaches these widths, because WebView2 applies it as page zoom:
// D2 step 0 measured the 1024x720 minimum window at 820x576, 683x481 and 456x320 CSS px at 125, 150 and 225 %. Headless Chromium hides
// scrollbars, so those cases run at the width left beside WebView2's 15 px scrollbar (806, 668 and 441 px; no media query lies in between).
// Tauri is mocked; the script is the 12-segment fixture (segments 2, 6 and 9 have a take; segment 1 is selected when the project opens).
const FIXTURE=JSON.parse(readFileSync('e2e/fixtures/script-12.json','utf8'));
// Segment 2 with a second take: selected, it shows the take strip ("So sánh take") in the dock, which makes the dock taller.
const COMPARE=JSON.stringify({...FIXTURE,segments:FIXTURE.segments.map((s:any)=>s.id==='s2'?{...s,takes:[...s.takes,{...s.takes[0],id:'s2-t2',asset_id:'a-s2-2',path:'s2-2.wav'}]}:s)});
const mock=(project:string):void=>{
 const w=window as any;w.isTauri=true;
 const p:any=JSON.parse(project);
 const ipc=(v:unknown)=>JSON.parse(JSON.stringify(v));
 w.__TAURI_INTERNALS__={convertFileSrc:(x:string)=>x,transformCallback:()=>1,unregisterCallback:()=>{},metadata:{currentWindow:{label:'main'},currentWebview:{label:'main',windowLabel:'main'}},
  invoke:async(cmd:string,args:any)=>{switch(cmd){
   case 'list_projects':return [{id:p.id,name:p.name,updated_at:p.updated_at,revision:p.revision}];case 'load_project':return ipc(p);
   case 'list_voices':return [];case 'list_models':return [{id:'vieneu-v3',name:'VieNeu v3 Turbo',engine:'tts',installed:true,revision:'r',license:'Apache-2.0',description:''}];
   case 'list_jobs':return [];case 'get_settings':return {dictionary:{}};
   case 'runtime_status':return {python_ready:true,ffmpeg_ready:true,worker_ready:true,python_path:null,ffmpeg_path:null,message:''};
   case 'save_project':if(w.__holdSave)return new Promise(()=>{});return {...ipc(args.project),revision:args.project.revision+1}; // held: the app stays busy
   default:return null;}}};
};
const seg=(page:Page,n:number)=>page.locator('.segment').nth(n-1);
const settle=(page:Page)=>page.evaluate(()=>new Promise<void>(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r()))));
// Opens the project and selects segment 2 by a click on its text (segment 1 is selected by default), so its panel is in its row at these widths.
const open=async(page:Page,width:number,height:number,project=JSON.stringify(FIXTURE))=>{
 await page.setViewportSize({width,height});await page.addInitScript(mock,project);await page.goto('/');
 await page.getByRole('button',{name:'Dự án',exact:true}).click();await page.getByRole('button',{name:'Mở dự án',exact:true}).click();
 await page.getByRole('textbox',{name:'Nội dung đoạn 2',exact:true}).click();await expect(seg(page,2)).toHaveClass(/selected/);
};
// The focused control: its name, its segment (1-based, 0 outside the script) and whether it is in a segment panel.
const focused=(page:Page)=>page.evaluate(()=>{const a=document.activeElement as HTMLElement,row=a.closest('.segment');return {name:a.getAttribute('aria-label')??a.textContent?.trim()??'',row:row?[...document.querySelectorAll('.segment')].indexOf(row)+1:0,panel:!!a.closest('.segment-detail')};});

test('at 800 px, Tab from the text of segment 2 to the text of segment 4 makes 6 stops past segment 2, in no panel, and selects neither row',async({page})=>{
 await open(page,800,720);
 const stops:{name:string;row:number;panel:boolean}[]=[];
 for(let i=0;i<60&&stops.at(-1)?.name!=='Nội dung đoạn 4';i++){await page.keyboard.press('Tab');stops.push(await focused(page));}
 const past=stops.filter(s=>s.row>2);
 expect(past.map(s=>s.name),JSON.stringify(stops)).toEqual(['Nhân vật đoạn 3','Chia đoạn tại con trỏ','Nội dung đoạn 3','Nhân vật đoạn 4','Chia đoạn tại con trỏ','Nội dung đoạn 4']);
 expect(past.every(s=>!s.panel)).toBe(true);
 await expect(seg(page,2)).toHaveClass(/selected/);await expect(page.locator('.segment-detail')).toHaveCount(1);await expect(seg(page,2).locator('.segment-detail')).toHaveCount(1);
});

test('at 800 px, focus alone leaves segment 4 unselected; typing "a" in it selects it, and Tab then reaches "Giọng đoạn 4" after the emotion bar',async({page})=>{
 await open(page,800,720);
 const area=page.getByRole('textbox',{name:'Nội dung đoạn 4',exact:true}),before=await area.inputValue();
 await area.focus();await settle(page);
 await expect(seg(page,4)).not.toHaveClass(/selected/);await expect(seg(page,2)).toHaveClass(/selected/);
 await page.keyboard.type('a');
 await expect(seg(page,4)).toHaveClass(/selected/);await expect(area).toBeFocused();expect((await area.inputValue()).length).toBe(before.length+1);
 await page.keyboard.press('Tab');await expect(seg(page,4).getByRole('button',{name:'Thở dài'})).toBeFocused();
 await page.keyboard.press('Tab');await expect(page.getByRole('combobox',{name:'Giọng đoạn 4',exact:true})).toBeFocused();
 await expect(seg(page,4).locator('.segment-detail')).toHaveCount(1);
});

test('above 920 px, Tab into a segment still selects it',async({page})=>{
 await open(page,921,720);
 for(let i=0;i<10&&(await focused(page)).name!=='Nhân vật đoạn 3';i++)await page.keyboard.press('Tab');
 expect((await focused(page)).name).toBe('Nhân vật đoạn 3');await expect(seg(page,3)).toHaveClass(/selected/);
});

// The take strip gives the dock a row of its own at 800 px and below.
for(const width of [641,700,800])test(`at ${width}x800 the busy indicator stays clear of the dock that shows the take strip`,async({page})=>{
 await open(page,width,800,COMPARE);await expect(page.locator('.audio-dock.compare')).toBeVisible();
 await page.evaluate(()=>{(window as any).__holdSave=true;});
 await page.keyboard.type('x');await page.keyboard.press('Control+s'); // an edit in segment 2's text, then a save that never answers
 const busy=page.locator('.busy-indicator');await expect(busy).toBeVisible();
 const b=await busy.evaluate(e=>e.getBoundingClientRect().toJSON()),d=await page.locator('.audio-dock').evaluate(e=>e.getBoundingClientRect().toJSON());
 console.log(`b3b-measure: ${width} busy ${Math.round(b.top)}-${Math.round(b.bottom)} dock ${Math.round(d.top)}-${Math.round(d.bottom)} (${Math.round(d.height)} px)`);
 expect(b.bottom<=d.top||b.top>=d.bottom,`busy indicator ${Math.round(b.top)}-${Math.round(b.bottom)}, dock ${Math.round(d.top)}-${Math.round(d.bottom)}`).toBe(true);
});

const PAGES=['Tạo giọng đọc','Chép lời','Thư viện giọng','Hàng đợi','Dự án','Model & cài đặt'];
for(const [width,height,scale] of [[441,320,' (225 %)'],[668,481,' (150 %)'],[806,576,' (125 %)'],[800,720,''],[640,720,'']] as const)test(`at ${width}x${height}${scale} every rail control can be reached, no page scrolls sideways, and the dock covers no focused segment text`,async({page})=>{
 await open(page,width,height,COMPARE);
 // Tab through the script: each segment's text, once focused (the browser scrolls it into view after focusin), is clear of the dock.
 await page.getByRole('textbox',{name:'Nhân vật đoạn 1',exact:true}).focus();
 const seen=new Set<string>();
 for(let i=0;i<120&&seen.size<12;i++){
  await page.keyboard.press('Tab');await settle(page);
  const r=await page.evaluate(()=>{const a=document.activeElement as HTMLElement;if(!a.matches('.segment textarea'))return null;const t=a.getBoundingClientRect(),d=document.querySelector('.audio-dock')!.getBoundingClientRect();return {name:a.getAttribute('aria-label')!,t:[Math.round(t.top),Math.round(t.bottom)],d:[Math.round(d.top),Math.round(d.bottom)],h:innerHeight};});
  if(!r)continue;seen.add(r.name);
  expect(r.t[1]<=r.d[0]+1||r.t[0]>=r.d[1]-1,`${r.name} at ${r.t.join('-')}, the dock at ${r.d.join('-')}`).toBe(true);
  expect(r.t[0]>=-1&&r.t[1]<=r.h+1,`${r.name} at ${r.t.join('-')} in a ${r.h} px window`).toBe(true);
 }
 expect(seen.size).toBe(12);
 const nav=page.getByRole('navigation',{name:'Điều hướng chính'});
 for(const name of PAGES){
  await nav.getByRole('button',{name:new RegExp(`^${name}`)}).click({timeout:5000});await settle(page);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth),`${name} scrolls sideways by`).toBeLessThanOrEqual(0);
 }
 for(const b of await page.locator('.sidebar button').all())await b.click({trial:true,timeout:3000}); // scrolled into view and hit at its centre
});
