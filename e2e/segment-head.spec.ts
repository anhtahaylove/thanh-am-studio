import {test,expect,type Page} from '@playwright/test';
import {readFileSync} from 'node:fs';
// A segment's head keeps its height while a job runs (the job ring sits inline after the chips instead of taking a line of its own), and the take-check chip is
// reached by Tab where it is seen. Tauri is mocked; the script is the 12-segment fixture, whose segment 2 has a checked take. The app polls jobs every 2.5 s.
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
const head=(page:Page)=>page.locator('.segment').nth(1).locator('.segment-head');

for(const [width,height] of [[1440,960],[1024,720]])test(`at ${width}x${height} a running job leaves the head of segment 2 as tall as it was, and nothing scrolls sideways`,async({page})=>{
 await open(page,width,height);
 const idle=(await head(page).boundingBox())!.height;
 await page.evaluate(()=>(window as any).__jobs.push({id:'j1',kind:'tts',project_id:'p1',payload:{segment_id:'s2',text:'x'},status:'running',progress:0.42,error:null,result:null,created_at:'2026-11-22T00:00:00Z',updated_at:'2026-11-22T00:00:00Z'}));
 await expect(head(page).locator('.job-ring')).toHaveText('Đang tạo 42 %');
 expect(Math.abs((await head(page).boundingBox())!.height-idle),`idle ${idle} px`).toBeLessThanOrEqual(1);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
});

// 1024x720 is the largest of the desktop sizes (1024x720, 1440x960) at which segment 2 is at most 600 px wide, where the `@container (max-width:600px)` rules apply.
test('at 1024x720, Tab walks the head of segment 2 in reading order: down a line or right along it',async({page})=>{
 await open(page,1024,720);
 expect(await page.locator('.segment').nth(1).evaluate(e=>e.getBoundingClientRect().width)).toBeLessThanOrEqual(600);
 await page.getByRole('textbox',{name:'Nhân vật đoạn 2',exact:true}).focus();
 const stops:{name:string;top:number;bottom:number;left:number}[]=[];
 for(;;){
  await page.keyboard.press('Tab');
  const s=await page.evaluate(()=>{const a=document.activeElement as HTMLElement;if(!a.closest('.segment-head'))return null;const r=a.getBoundingClientRect();return {name:a.getAttribute('aria-label')??a.textContent??'',top:r.top,bottom:r.bottom,left:r.left};});
  if(!s)break;stops.push(s);
 }
 expect(stops.map(s=>s.name)).toEqual(['Khớp kịch bản','Chia đoạn tại con trỏ']);
 for(let i=1;i<stops.length;i++){
  const a=stops[i-1],b=stops[i],sameLine=b.top<a.bottom&&a.top<b.bottom;
  if(sameLine)expect(b.left,`${b.name} is right of ${a.name}`).toBeGreaterThan(a.left);else expect(b.top,`${b.name} is on a line below ${a.name}`).toBeGreaterThanOrEqual(a.bottom-1);
 }
});
