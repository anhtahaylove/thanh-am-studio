import {test,expect,type Page} from '@playwright/test';
import {readFileSync} from 'node:fs';
// Compact transcript rows: a one-line row, the "Bắt đầu"/"Kết thúc" time editor and its keyboard rules.
// Tauri is mocked like perf-budget.spec.ts; every save_project argument is recorded in window.__saved. The rows come from the
// synthetic e2e/fixtures/transcript-1200.json (about 3.7 s each, 8 to 16 words, so a row is one line at 1440 px).
const ROWS:{id:string;start_ms:number;end_ms:number;text:string;speaker?:number}[]=JSON.parse(readFileSync('e2e/fixtures/transcript-1200.json','utf8')).slice(0,6);
const mock=({rows,source}:{rows:unknown[];source:boolean})=>{
 const w=window as any;w.isTauri=true;w.__saved=[];
 let project:any={id:'p1',name:'Phỏng vấn',updated_at:'2026-11-22T00:00:00Z',revision:1,transcript:rows,dictionary:{},source_asset_id:source?'src':null,segments:[]};
 const ipc=(v:unknown)=>JSON.parse(JSON.stringify(v));
 w.__TAURI_INTERNALS__={convertFileSrc:(p:string)=>p,transformCallback:()=>1,unregisterCallback:()=>{},metadata:{currentWindow:{label:'main'},currentWebview:{label:'main',windowLabel:'main'}},
  invoke:async(cmd:string,args:any)=>{switch(cmd){
   case 'list_projects':return [{id:project.id,name:project.name,updated_at:project.updated_at,revision:project.revision}];case 'load_project':return ipc(project);
   case 'get_asset':return {id:'src',path:'goc.wav',name:'goc.wav',duration_ms:60000,sample_rate:48000};
   case 'list_voices':case 'list_models':case 'list_jobs':return [];case 'get_settings':return {dictionary:{}};
   case 'runtime_status':return {python_ready:true,ffmpeg_ready:true,worker_ready:true,native_worker_ready:true,python_path:null,ffmpeg_path:null,native_worker_path:null,fallback_count:0,message:''};
   case 'save_project':w.__saved.push(ipc(args.project));project={...ipc(args.project),revision:args.project.revision+1};return ipc(project);
   default:return null;}}};
};
const open=async(page:Page,opts:{rows?:unknown[];source?:boolean;width?:number}={})=>{
 await page.setViewportSize({width:opts.width??1440,height:1000});await page.addInitScript(mock,{rows:opts.rows??ROWS,source:opts.source??true});await page.goto('/');
 await page.getByRole('button',{name:'Dự án',exact:true}).click();await page.getByRole('button',{name:'Mở dự án'}).click();await page.getByRole('button',{name:'Chép lời',exact:true}).click();
 await expect(page.locator('.transcript-row')).toHaveCount((opts.rows??ROWS).length);
};
const time=(page:Page,i:number)=>page.locator('.transcript-row').nth(i).locator('.tr-time');
const saved=(page:Page)=>page.evaluate(()=>(window as any).__saved as {transcript:{start_ms:number;end_ms:number;text:string}[]}[]);

test('a transcript row is one short line, with the time as one button and the speaker as a coloured chip and rule',async({page})=>{
 await open(page);
 const heights=await page.locator('.transcript-row').evaluateAll(rows=>rows.map(r=>Math.round(r.getBoundingClientRect().height)));
 console.log(`transcript row heights at 1440x1000 (px): ${heights.join(', ')}`);
 for(const h of heights)expect(h).toBeLessThanOrEqual(64);
 await expect(time(page,0)).toHaveText('0:00,000 – 0:03,200');await expect(time(page,0)).toHaveAttribute('title','0 – 3200 ms');
 const row=page.locator('.transcript-row').nth(1);
 expect(await row.evaluate(r=>getComputedStyle(r).borderLeftWidth)).toBe('4px');
 await expect(row.locator('select.speaker-chip')).toHaveAccessibleName(/^Người nói tại 00:00:03,300$/);await expect(row.getByRole('textbox')).toHaveAccessibleName('Lời nói tại 00:00:03,300');
 await expect(row.getByRole('button',{name:'Phát từ 00:00:03,300'})).toBeEnabled();
});
test('both times move later in one edit and one Ctrl+Z restores both',async({page})=>{
 await open(page);const undo=page.getByRole('button',{name:'Hoàn tác (Ctrl+Z)'});await expect(undo).toBeDisabled();
 await time(page,1).click();await expect(page.getByLabel('Bắt đầu')).toBeFocused();
 await page.getByLabel('Bắt đầu').fill('0:04,000');await page.getByLabel('Kết thúc').fill('0:07,500');await page.getByLabel('Kết thúc').press('Enter');
 await expect(time(page,1)).toHaveText('0:04,000 – 0:07,500');await expect(time(page,1)).toBeFocused();await expect(undo).toBeEnabled();
 await page.keyboard.press('Control+z');await expect(time(page,1)).toHaveText('0:03,300 – 0:06,537');await expect(undo).toBeDisabled();
});
test('leaving the pair commits it, and an invalid pair keeps the editor open with the old values',async({page})=>{
 await open(page);
 await time(page,0).click();await page.getByLabel('Kết thúc').fill('0:05,000');await page.getByLabel('Kết thúc').press('Tab');await expect(time(page,0)).toHaveText('0:00,000 – 0:05,000');
 await time(page,0).click();const start=page.getByLabel('Bắt đầu'),end=page.getByLabel('Kết thúc');
 await start.fill('0:06,000');await start.press('Enter');
 await expect(start).toHaveAttribute('aria-invalid','true');await expect(end).toHaveAttribute('aria-invalid','true');await expect(start).toHaveAccessibleDescription('Bắt đầu phải nhỏ hơn kết thúc.');await expect(start).toBeFocused();
 await start.fill('x');await start.press('Enter');await expect(start).toHaveAttribute('aria-invalid','true');await expect(end).not.toHaveAttribute('aria-invalid');await expect(page.getByText('Nhập dạng phút:giây, ví dụ 0:09,200')).toBeVisible();
 await page.getByLabel('Lời nói tại 00:00:03,300').click();await expect(start).toBeVisible();
 await start.press('Escape');await expect(time(page,0)).toHaveText('0:00,000 – 0:05,000');await expect(time(page,0)).toBeFocused();
});
test('Escape discards the draft and gives focus back to the button',async({page})=>{
 await open(page);const undo=page.getByRole('button',{name:'Hoàn tác (Ctrl+Z)'});
 await time(page,2).click();await page.getByLabel('Kết thúc').fill('0:20,000');await page.getByLabel('Kết thúc').press('Escape');
 await expect(page.getByLabel('Kết thúc')).toHaveCount(0);await expect(time(page,2)).toHaveText('0:06,637 – 0:09,911');await expect(time(page,2)).toBeFocused();await expect(undo).toBeDisabled();
});
test('Ctrl+Z in an open draft undoes only the typed text: the project and the undo count stay',async({page})=>{
 await open(page);const undo=page.getByRole('button',{name:'Hoàn tác (Ctrl+Z)'});
 await time(page,0).click();const end=page.getByLabel('Kết thúc');await end.press('Control+a');await page.keyboard.type('0:09,999');
 for(let i=0;i<3;i++)await page.keyboard.press('Control+z');
 await expect(end).toBeFocused();await expect(end).not.toHaveValue('0:09,999');await expect(undo).toBeDisabled();
 await end.press('Escape');await expect(time(page,0)).toHaveText('0:00,000 – 0:03,200');await expect(undo).toBeDisabled();
});
test('Ctrl+S commits a valid draft first and saves it; an invalid one is left out of the save and keeps its error',async({page})=>{
 await open(page);
 await time(page,0).click();await page.getByLabel('Kết thúc').fill('0:03,900');await page.keyboard.press('Control+s');
 await expect(page.getByLabel('Kết thúc')).toHaveCount(0);await expect(time(page,0)).toBeFocused();await expect.poll(async()=>(await saved(page)).at(-1)?.transcript[0].end_ms).toBe(3900);
 // Something else is unsaved, so the save really runs while the invalid draft is open.
 const text=page.getByLabel('Lời nói tại 00:00:03,300');await text.fill('Đã sửa lời.');
 await time(page,2).click();const end=page.getByLabel('Kết thúc');await end.fill('0:01,000');await end.press('Control+s');
 await expect.poll(async()=>(await saved(page)).at(-1)?.transcript[1].text).toBe('Đã sửa lời.');
 const last=(await saved(page)).at(-1)!;expect(last.transcript[2].end_ms).toBe(9911);
 await expect(end).toHaveAttribute('aria-invalid','true');await expect(end).toBeVisible();
});
test('hours show only when the last row ends at one hour or later',async({page})=>{
 await open(page);await expect(time(page,5)).toHaveText(/^0:\d\d,\d{3} – 0:\d\d,\d{3}$/);
 const long=ROWS.map((r,i)=>i===ROWS.length-1?{...r,end_ms:3600000}:r);
 const p2=await page.context().newPage();await p2.setViewportSize({width:1440,height:1000});await p2.addInitScript(mock,{rows:long,source:true});await p2.goto('/');
 await p2.getByRole('button',{name:'Dự án',exact:true}).click();await p2.getByRole('button',{name:'Mở dự án'}).click();await p2.getByRole('button',{name:'Chép lời',exact:true}).click();
 await expect(p2.locator('.tr-time').nth(0)).toHaveText('0:00:00,000 – 0:00:03,200');await expect(p2.locator('.tr-time').nth(5)).toHaveText(/ – 1:00:00,000$/);
 await p2.locator('.tr-time').nth(5).click();await expect(p2.getByLabel('Kết thúc')).toHaveValue('1:00:00,000');
});
test('play is disabled without a source audio and says why',async({page})=>{
 await open(page,{source:false});const play=page.getByRole('button',{name:/^Phát từ /});
 await expect(play.first()).toBeDisabled();await expect(play.first()).toHaveAttribute('title','Dự án chưa có audio gốc');
});
for(const width of [800,640])test(`the transcript does not scroll sideways at ${width} px, even with the time editor open`,async({page})=>{
 await open(page,{width});const wide=()=>page.evaluate(()=>[document.documentElement.scrollWidth-innerWidth,...[...document.querySelectorAll('.transcript-list,.transcript-row')].map(e=>e.scrollWidth-e.clientWidth)].filter(d=>d>0));
 expect(await wide()).toEqual([]);await time(page,1).click();await expect(page.getByLabel('Bắt đầu')).toBeVisible();expect(await wide()).toEqual([]);
});
test('a row that is past one hour is written, reopened and committed with hours even when the last row is shorter',async({page})=>{
 const rows=ROWS.map((r,i)=>i===2?{...r,start_ms:3700000,end_ms:3705000}:r);
 await open(page,{rows});await expect(time(page,2)).toHaveText('1:01:40,000 – 1:01:45,000');await expect(time(page,5)).toHaveText(/^0:\d\d,\d{3} – 0:\d\d,\d{3}$/);
 await time(page,2).click();await expect(page.getByLabel('Bắt đầu')).toHaveValue('1:01:40,000');await page.getByLabel('Bắt đầu').press('Enter');
 await expect(page.getByLabel('Bắt đầu')).toHaveCount(0);await expect(page.locator('.tr-time[aria-invalid]')).toHaveCount(0);await expect(time(page,2)).toBeFocused();
});
test('a click on another row time button still lands when the open editor closes and its row shrinks (1024 px)',async({page})=>{
 await open(page,{width:1024});
 await time(page,0).click();await page.getByLabel('Kết thúc').fill('0:03,900');
 await time(page,1).click();
 await expect(page.getByLabel('Bắt đầu')).toHaveCount(1);await expect(page.getByLabel('Bắt đầu')).toHaveValue('0:03,300');await expect(time(page,0)).toHaveText('0:00,000 – 0:03,900');
});
