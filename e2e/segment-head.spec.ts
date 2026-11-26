import {test,expect,type Page} from '@playwright/test';
import {readFileSync} from 'node:fs';
// A segment's head keeps its height while a job waits or runs, as long as the chips' line has 27 px to spare (the job ring takes the room beside the chips and ends
// its label in an ellipsis, instead of taking a line of its own or pushing the toolbar down), and the take-check chip is reached by Tab where it is seen. Tauri is mocked; the script is the 12-segment fixture,
// whose segment 2 has a checked take and segment 3 has no take. The app polls jobs every 2.5 s.
const FIXTURE:string=readFileSync('e2e/fixtures/script-12.json','utf8');
const mock=(project:string):void=>{
 const w=window as any;w.isTauri=true;w.__jobs=[];
 const p:any=JSON.parse(project);
 const ipc=(v:unknown)=>JSON.parse(JSON.stringify(v));
 w.__TAURI_INTERNALS__={convertFileSrc:(x:string)=>x,transformCallback:()=>1,unregisterCallback:()=>{},metadata:{currentWindow:{label:'main'},currentWebview:{label:'main',windowLabel:'main'}},
  invoke:async(cmd:string,args:any)=>{switch(cmd){
   case 'list_projects':return [{id:p.id,name:p.name,updated_at:p.updated_at,revision:p.revision}];case 'load_project':return ipc(p);
   case 'list_voices':return [];case 'list_models':return [{id:'vieneu-v3',name:'VieNeu v3 Turbo',engine:'tts',installed:true,revision:'r',license:'Apache-2.0',description:''}];
   case 'list_jobs':return ipc(w.__jobs);case 'get_settings':return {dictionary:{}};
   case 'runtime_status':return {python_ready:true,ffmpeg_ready:true,worker_ready:true,python_path:null,ffmpeg_path:null,message:''};
   case 'save_project':return {...ipc(args.project),revision:args.project.revision+1};
   default:return null;}}};
};
// Opens the fixture and selects segment 2 (segment 1 is selected by default).
const open=async(page:Page,width:number,height:number)=>{
 await page.setViewportSize({width,height});await page.addInitScript(mock,FIXTURE);await page.goto('/');
 await page.getByRole('button',{name:'Dự án',exact:true}).click();await page.getByRole('button',{name:'Mở dự án',exact:true}).click();
 await page.getByRole('textbox',{name:'Nội dung đoạn 2',exact:true}).click();await expect(page.locator('.segment').nth(1)).toHaveClass(/selected/);
};
const ring=(page:Page,n:number)=>page.locator('.segment').nth(n-1).locator('.job-ring');
const headHeight=(page:Page,n:number)=>page.locator('.segment').nth(n-1).locator('.segment-head').evaluate(e=>e.getBoundingClientRect().height);
// The jobs the next poll returns, one per segment, all in the same state.
const jobs=(page:Page,segments:string[],status:string,progress=0)=>page.evaluate(([s,st,pr])=>{(window as any).__jobs=(s as string[]).map(id=>({id:'j'+id,kind:'tts',project_id:'p1',payload:{segment_id:id,text:'x'},status:st,progress:pr,error:null,result:null,created_at:'2026-11-22T00:00:00Z',updated_at:'2026-11-22T00:00:00Z'}));},[segments,status,progress] as const);

// Segment 2 has a checked take (its "Khớp kịch bản" chip), segment 3 has no take. The ring needs 27 px beside the chips (icon 16 + gap 5 + head gap 6). The residual band:
// a head whose first line has under 27 px spare still grows while a job runs, its ring alone on a second line. At 800x720 segment 2 has 10 px spare, so that cell is left
// out; a long "Có thể đọc sai" warning chip does the same at 1024x720 (12 px spare, the head grows from 89 to 111 px). See PLAN §16.
for(const [width,height,segments] of [[800,720,[3]],[921,720,[2,3]],[1024,720,[2,3]],[1152,720,[2,3]],[1280,720,[2,3]],[1366,768,[2,3]],[1440,960,[2,3]]] as const)test(`at ${width}x${height} a waiting or running job leaves the head of segment ${segments.join(' and ')} as tall as it was, and nothing scrolls sideways`,async({page})=>{
 await open(page,width,height);
 const idle=new Map<number,number>();for(const n of segments)idle.set(n,await headHeight(page,n));
 for(const [status,progress,label] of [['queued',0,'Đang chờ'],['running',0.42,'Đang tạo 42 %']] as const){
  await jobs(page,segments.map(n=>'s'+n),status,progress);
  for(const n of segments){await expect(ring(page,n)).toHaveText(label);expect(Math.abs(await headHeight(page,n)-idle.get(n)!),`segment ${n} with "${label}", idle ${idle.get(n)} px`).toBeLessThanOrEqual(1);}
 }
 expect(await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
});

test('a label longer than the room beside the chips ends in an ellipsis on one line, the head keeps its height, and the whole label stays readable',async({page})=>{
 const LONG='Gián đoạn · Thử lại trong Hàng đợi';
 await open(page,1440,960);
 const idle=await headHeight(page,2);
 await jobs(page,['s2'],'interrupted');
 await expect(ring(page,2)).toHaveText(LONG);await expect(ring(page,2)).toHaveAttribute('title',LONG);
 expect(Math.abs(await headHeight(page,2)-idle),`idle ${idle} px`).toBeLessThanOrEqual(1);
 const label=await ring(page,2).locator('.job-ring-label').evaluate(e=>({scroll:e.scrollWidth,client:e.clientWidth,ellipsis:getComputedStyle(e).textOverflow,overflow:getComputedStyle(e).overflowX}));
 expect(label.scroll,'the label is cut, not wrapped').toBeGreaterThan(label.client);expect(label.ellipsis).toBe('ellipsis');expect(label.overflow,'the ellipsis shows only when the overflow is hidden').toBe('hidden');
});

// 1024x720 is the largest of the desktop sizes (1024x720, 1440x960) at which segment 2 is at most 600 px wide, where the `@container (max-width:600px)` rules apply.
test('at 1024x720, Tab walks the head of segment 2 in reading order: down a line or right along it',async({page})=>{
 await open(page,1024,720);
 expect(await page.locator('.segment').nth(1).evaluate(e=>e.getBoundingClientRect().width)).toBeLessThanOrEqual(600);
 await page.getByRole('textbox',{name:'Nhân vật đoạn 2',exact:true}).focus();
 const stops:{name:string;top:number;bottom:number;left:number}[]=[];
 for(let i=0;i<12;i++){
  await page.keyboard.press('Tab');
  const s=await page.evaluate(()=>{const a=document.activeElement as HTMLElement;if(!a.closest('.segment-head'))return null;const r=a.getBoundingClientRect();return {name:a.getAttribute('aria-label')??a.textContent??'',top:r.top,bottom:r.bottom,left:r.left};});
  if(!s)break;stops.push(s);
 }
 expect(stops.map(s=>s.name)).toEqual(['Khớp kịch bản','Tạo take mới']);
 for(let i=1;i<stops.length;i++){
  const a=stops[i-1],b=stops[i],sameLine=b.top<a.bottom&&a.top<b.bottom;
  if(sameLine)expect(b.left,`${b.name} is right of ${a.name}`).toBeGreaterThan(a.left);else expect(b.top,`${b.name} is on a line below ${a.name}`).toBeGreaterThanOrEqual(a.bottom-1);
 }
});
