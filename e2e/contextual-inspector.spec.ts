import {test,expect,type Page} from '@playwright/test';
import {readFileSync} from 'node:fs';
// The inspector shows the selected segment: its heading, its voice and speed, and (once it has takes) the take and trim fields. Beside the script it is the aside; at 920 px and
// below, where the aside would fall under the whole script, the same panel is inside the selected row. Tauri is mocked; the script is the 12-segment fixture
// (segments 2, 6 and 9 have a take; 2 and 9 have a checked one; segment 1 is selected when the project opens).
const FIXTURE:string=readFileSync('e2e/fixtures/script-12.json','utf8');
const mock=(o:{project:string;live:boolean}):void=>{
 const w=window as any;w.isTauri=true;w.__calls=[];w.__kd=[];w.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};
 const project:any=JSON.parse(o.project);
 const ipc=(v:unknown)=>JSON.parse(JSON.stringify(v));
 const voices=[{id:'v1',name:'Giọng một',kind:'preset',reference_asset_id:null,consent:true,engine_voice_id:'v1'},{id:'v2',name:'Giọng hai',kind:'preset',reference_asset_id:null,consent:true,engine_voice_id:'v2'}];
 let progress=0.1,settings:any={dictionary:{}};w.__addVoice=()=>voices.push({id:'v3',name:'Giọng ba',kind:'preset',reference_asset_id:null,consent:true,engine_voice_id:'v3'});
 w.__TAURI_INTERNALS__={convertFileSrc:(p:string)=>p,transformCallback:()=>1,unregisterCallback:()=>{},metadata:{currentWindow:{label:'main'},currentWebview:{label:'main',windowLabel:'main'}},
  invoke:async(cmd:string,args:any)=>{w.__calls.push(cmd);switch(cmd){
   case 'list_projects':return [{id:project.id,name:project.name,updated_at:project.updated_at,revision:project.revision}];case 'load_project':return ipc(project);
   case 'list_voices':return ipc(voices);case 'list_models':return [{id:'vieneu-v3',name:'VieNeu v3 Turbo',engine:'tts',installed:true,revision:'r',license:'Apache-2.0',description:''}];
   case 'list_jobs':if(o.live)progress=Math.min(.95,progress+.1);return o.live?[{id:'j1',kind:'tts',project_id:project.id,payload:{segment_id:'s1',text:''},status:'running',progress,error:null,result:null,created_at:'2026-11-20T00:00:00Z',updated_at:'2026-11-20T00:00:00Z'}]:[];case 'get_settings':return ipc(settings);case 'save_settings':settings=ipc(args.settings);return ipc(settings);
   case 'runtime_status':return {python_ready:true,ffmpeg_ready:true,worker_ready:true,python_path:null,ffmpeg_path:null,message:''};
   case 'save_project':return {...ipc(args.project),revision:args.project.revision+1};
   default:return null;}}};
 // The keydown as it reaches the window, in the bubble phase: after the page's own handlers have run.
 window.addEventListener('keydown',e=>{if(e.altKey&&e.key==='ArrowDown')w.__kd.push(e.defaultPrevented);});
};
// Which rows React re-rendered: the commit hook walks each commit like React DevTools does, and counts a row's function running (PerformedWork) by segment id.
const countRenders=():void=>{
 const w=window as any;w.__renders={};
 const walk=(next:any,prev:any):void=>{
  if((next.tag===15||next.tag===0)&&/^SegmentRow\d*$/.test(next.type?.name)&&(next.flags&1)){const id=next.memoizedProps.segment.id;w.__renders[id]=(w.__renders[id]??0)+1;}
  if(next.child!==prev.child)for(let c=next.child;c;c=c.sibling)if(c.alternate)walk(c,c.alternate);
 };
 w.__REACT_DEVTOOLS_GLOBAL_HOOK__={supportsFiber:true,renderers:new Map(),inject(r:any){const id=this.renderers.size+1;this.renderers.set(id,r);return id;},onCommitFiberRoot(_:number,root:any){if(root.current.alternate)walk(root.current,root.current.alternate);},onCommitFiberUnmount(){},onPostCommitFiberRoot(){},checkDCE(){}};
};
const open=async(page:Page,width=1440,live=false)=>{
 await page.setViewportSize({width,height:900});if(live)await page.addInitScript(countRenders);await page.addInitScript(mock,{project:FIXTURE,live});await page.goto('/');
 await page.getByRole('button',{name:'Dự án',exact:true}).click();await page.getByRole('button',{name:'Mở dự án',exact:true}).click();
 await expect(page.getByRole('textbox',{name:'Nội dung đoạn 12'})).toBeVisible();
};
const seg=(page:Page,n:number)=>page.locator('.segment').nth(n-1);
const area=(page:Page,n:number)=>page.getByRole('textbox',{name:`Nội dung đoạn ${n}`,exact:true});
const pick=(page:Page,n:number)=>area(page,n).click();
const panel=(page:Page)=>page.locator('.segment-detail');
const texts=(page:Page)=>page.locator('.segment textarea').evaluateAll(l=>l.map(t=>(t as HTMLTextAreaElement).value));
const settle=(page:Page)=>page.evaluate(()=>new Promise<void>(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r()))));
const ORIGINAL:string[]=JSON.parse(FIXTURE).segments.map((s:{text:string})=>s.text);

test('the inspector is headed "Đoạn NN · speaker", with "(Chưa đặt tên)" for an empty speaker',async({page})=>{
 await open(page);const h=page.locator('.inspector .segment-detail h3');
 await expect(h).toHaveText('Đoạn 01 · Người dẫn');await pick(page,6);await expect(h).toHaveText('Đoạn 06 · Bà Tư');
 await page.getByRole('textbox',{name:'Nhân vật đoạn 6'}).fill('');await expect(h).toHaveText('Đoạn 06 · (Chưa đặt tên)');
 await page.getByRole('textbox',{name:'Nhân vật đoạn 6'}).fill('   ');await expect(h).toHaveText('Đoạn 06 · (Chưa đặt tên)'); // blanks only
 await page.getByRole('textbox',{name:'Nhân vật đoạn 6'}).fill('Cô Ba');await expect(h).toHaveText('Đoạn 06 · Cô Ba');
});

test('the voice and speed selects are a group "Giọng & tốc độ" in the inspector, named by segment, and are not in the row',async({page})=>{
 await open(page);await pick(page,5);
 const group=page.getByRole('group',{name:'Giọng & tốc độ'});await expect(group).toBeVisible();
 await expect(group.getByRole('combobox',{name:'Giọng đoạn 5',exact:true})).toBeVisible();await expect(group.getByRole('combobox',{name:'Tốc độ đọc đoạn 5',exact:true})).toBeVisible();
 await expect(page.locator('.inspector').getByRole('combobox',{name:/^(Giọng|Tốc độ đọc) đoạn/})).toHaveCount(2);
 await expect(page.locator('.segment').getByRole('combobox')).toHaveCount(0);
});

test('a voice and a speed chosen in the inspector belong to the selected segment only',async({page})=>{
 await open(page);await pick(page,5);
 await page.getByRole('combobox',{name:'Giọng đoạn 5'}).selectOption('v2');await page.getByRole('combobox',{name:'Tốc độ đọc đoạn 5'}).selectOption('1.15');
 await pick(page,7);await expect(page.getByRole('combobox',{name:'Giọng đoạn 7'})).toHaveValue('');await expect(page.getByRole('combobox',{name:'Tốc độ đọc đoạn 7'})).toHaveValue('1');
 await pick(page,5);await expect(page.getByRole('combobox',{name:'Giọng đoạn 5'})).toHaveValue('v2');await expect(page.getByRole('combobox',{name:'Tốc độ đọc đoạn 5'})).toHaveValue('1.15');
});

test('a voice added while the page is open appears in the inspector, also inside the row',async({page})=>{
 await open(page,800);await pick(page,5);const select=seg(page,5).getByRole('combobox',{name:'Giọng đoạn 5'});
 await expect(select.locator('option')).toHaveCount(3);await page.evaluate(()=>(window as any).__addVoice());
 await expect(select.locator('option')).toHaveCount(4,{timeout:8000});await expect(select).toContainText('Giọng ba');
});

test('with no take the inspector says so and shows no take or trim field; with one it shows them',async({page})=>{
 await open(page);const hidden=['Âm lượng (dB)','Cắt đầu (ms)','Cắt cuối (ms)','To dần (ms)','Nhỏ dần (ms)'];
 const note=page.getByText('Chưa có take: bấm Tạo giọng (Ctrl+Enter)',{exact:true});
 const take=page.locator('.inspector').getByRole('combobox',{name:'Take đang sử dụng'});
 await pick(page,3);await expect(note).toBeVisible();await expect(take).toHaveCount(0);
 for(const label of hidden)await expect(page.locator('.inspector').getByLabel(label,{exact:true}),label).toHaveCount(0);
 await expect(page.getByText('Tạo lại không thay thế take đang chọn.')).toHaveCount(0);
 for(const label of ['Chương','Nghỉ sau (ms)'])await expect(page.locator('.inspector').getByLabel(label,{exact:true}),label).toBeVisible(); // these apply before a take exists
 await pick(page,6);await expect(note).toHaveCount(0);await expect(take).toBeVisible();
 for(const label of hidden)await expect(page.locator('.inspector').getByLabel(label,{exact:true}),label).toBeVisible();
 await expect(page.getByText('Tạo lại không thay thế take đang chọn.')).toBeVisible();
});

test('the panel is in the aside beside the script and inside the selected row at 920 px and below, never twice',async({page})=>{
 await open(page);await pick(page,6);
 await expect(panel(page)).toHaveCount(1);await expect(page.locator('.inspector .segment-detail')).toHaveCount(1);
 await page.setViewportSize({width:920,height:900});await expect(seg(page,6).locator('.segment-detail')).toHaveCount(1);
 await expect(panel(page)).toHaveCount(1);await expect(page.locator('.inspector .segment-detail')).toHaveCount(0);
 await page.setViewportSize({width:921,height:900});await expect(page.locator('.inspector .segment-detail')).toHaveCount(1);await expect(panel(page)).toHaveCount(1);
 await page.setViewportSize({width:800,height:900});await pick(page,9);
 await expect(seg(page,9).locator('.segment-detail')).toHaveCount(1);await expect(seg(page,6).locator('.segment-detail')).toHaveCount(0);await expect(panel(page)).toHaveCount(1);
 await expect(seg(page,9).locator('.segment-detail h3')).toHaveText('Đoạn 09 · Người dẫn');
});

test('on selection only the old and the new row change, the panel included, at 800 px and beside the script',async({page})=>{
 for(const width of [800,1440]){
  await open(page,width);
  const changed=async(n:number)=>{await page.evaluate(()=>{const w=window as any;w.__rows=new Set<number>();w.__mo?.disconnect();
   w.__mo=new MutationObserver(l=>{const rows=[...document.querySelectorAll('.segment')];for(const m of l){const i=rows.findIndex(r=>r.contains(m.target));if(i>=0)w.__rows.add(i+1);}});
   w.__mo.observe(document.querySelector('.segment-list')!,{childList:true,subtree:true,attributes:true,characterData:true});});
   await pick(page,n);await settle(page);await page.waitForTimeout(150);
   return page.evaluate(()=>[...(window as any).__rows as Set<number>].sort((a,b)=>a-b));};
  expect(await changed(6),`${width}: 1 to 6`).toEqual([1,6]);expect(await changed(9),`${width}: 6 to 9`).toEqual([6,9]);
 }
});

test('the panel is the next region after the selected segment text, within one screen at 800 px',async({page})=>{
 await open(page,800);await pick(page,6);
 const m=await page.evaluate(()=>{const s=document.querySelectorAll('.segment')[5],p=s.querySelector('.segment-detail')!.getBoundingClientRect(),t=s.querySelector('textarea')!.getBoundingClientRect();
  return {top:p.top,after:p.top-t.bottom,last:s.lastElementChild!.classList.contains('segment-detail'),h:innerHeight};});
 expect(m.last).toBe(true);expect(m.after).toBeGreaterThanOrEqual(0);expect(m.after).toBeLessThan(m.h);
 await expect(seg(page,6).locator('.segment-detail').getByRole('combobox',{name:'Giọng đoạn 6'})).toBeInViewport();
});

for(const width of [800,640])test(`the panel fits inside its row at ${width} px with no sideways scroll`,async({page})=>{
 await open(page,width);
 for(const n of [3,6]){
  await pick(page,n);await expect(seg(page,n).locator('.segment-detail'),`segment ${n} holds its panel`).toHaveCount(1);
  const m=await page.evaluate(i=>{const s=document.querySelectorAll('.segment')[i-1],r=s.getBoundingClientRect(),d=document.documentElement;
   const out=[...s.querySelectorAll('.segment-detail *')].filter(e=>{const b=e.getBoundingClientRect();return b.width>0&&(b.right>r.right+.5||b.left<r.left-.5);}).map(e=>e.tagName+'.'+e.className);
   return {over:d.scrollWidth-d.clientWidth,out};},n);
  expect(m.over,`segment ${n}`).toBeLessThanOrEqual(0);expect(m.out,`segment ${n} overflowing`).toEqual([]);
 }
});

for(const theme of ['light','dark'])test(`the panel's legend, labels and hints have AA contrast in ${theme} mode, beside the script and inside the row`,async({page})=>{
 await page.emulateMedia({colorScheme:theme as 'light'|'dark'});
 const lum=(c:string)=>{const [r,g,b]=(c.match(/[\d.]+/g)??[]).slice(0,3).map(Number).map(v=>{v/=255;return v<=.03928?v/12.92:((v+.055)/1.055)**2.4;});return .2126*r+.7152*g+.0722*b;};
 for(const width of [1440,800]){
  await open(page,width);await pick(page,3); // no take: its hint is the note
  const pairs=await page.evaluate(()=>{const bgOf=(el:Element)=>{let bg='',e:Element|null=el;while(e&&(!bg||bg==='rgba(0, 0, 0, 0)')){bg=getComputedStyle(e).backgroundColor;e=e.parentElement;}return bg;};
   const p=document.querySelector('.segment-detail')!;
   return [p.querySelector('legend')!,p.querySelector('label.field')!,p.querySelector('.hint')!,p.querySelector('h3')!,p.querySelector('summary')!].map(e=>({n:e.tagName,fg:getComputedStyle(e).color,bg:bgOf(e)}));});
  for(const q of pairs){const a=lum(q.fg),b=lum(q.bg);expect((Math.max(a,b)+.05)/(Math.min(a,b)+.05),`${q.n} ${q.fg} on ${q.bg}, ${width}, ${theme}`).toBeGreaterThanOrEqual(4.5);}
 }
});

test('a typed draft is committed when the window is resized across 920 px and the panel changes parent',async({page})=>{
 await open(page,1000);await pick(page,3);
 const gap=()=>page.getByLabel('Nghỉ sau (ms)',{exact:true});
 await gap().click();await gap().fill('1234'); // a draft: it commits on blur, Enter or Ctrl+S
 await page.setViewportSize({width:800,height:900});await expect(seg(page,3).locator('.segment-detail')).toHaveCount(1);
 await expect(gap()).toHaveValue('1234');
 await pick(page,4);await pick(page,3);await expect(gap()).toHaveValue('1234'); // it reached the segment
 await gap().click();await gap().fill('555');await page.setViewportSize({width:1000,height:900});await expect(page.locator('.inspector .segment-detail')).toHaveCount(1);
 await expect(gap()).toHaveValue('555');await pick(page,4);await pick(page,3);await expect(gap()).toHaveValue('555');
});

test('focus outside the panel stays where it is when the window is resized across 920 px',async({page})=>{
 await open(page,1000);await area(page,5).focus();await page.keyboard.type('x');
 await page.setViewportSize({width:800,height:900});await expect(seg(page,5).locator('.segment-detail')).toHaveCount(1);
 await expect(area(page,5)).toBeFocused();
 await page.getByRole('textbox',{name:'Nhân vật đoạn 5'}).focus();await page.setViewportSize({width:1000,height:900});await expect(page.locator('.inspector .segment-detail')).toHaveCount(1);
 await expect(page.getByRole('textbox',{name:'Nhân vật đoạn 5'})).toBeFocused();
});

test('a draft typed for one segment is not carried to the segment selected next',async({page})=>{
 await open(page);await pick(page,3);
 const gap=()=>page.getByLabel('Nghỉ sau (ms)',{exact:true});
 await gap().click();await gap().fill('777');
 await seg(page,9).dispatchEvent('click'); // selects the row without moving focus out of the field
 await expect(page.locator('.inspector .segment-detail h3')).toHaveText('Đoạn 09 · Người dẫn');await expect(gap()).toHaveValue('300');
 await page.mouse.click(2,2);await expect(gap()).toHaveValue('300');
 await pick(page,3);await expect(gap()).toHaveValue('300');
});

test('Alt+Down on the inspector\'s selects and take select, inside the row at 800 px, neither moves the segment nor is prevented',async({page})=>{
 await open(page,800);
 for(const [n,names] of [[3,['Giọng đoạn 3','Tốc độ đọc đoạn 3']],[2,['Giọng đoạn 2','Tốc độ đọc đoạn 2','Take đang sử dụng']]] as const){
  await pick(page,n);
  for(const name of names){
   await page.evaluate(()=>{(window as any).__kd=[];});
   const c=seg(page,n).getByRole('combobox',{name,exact:true});await expect(c).toBeVisible();
   await c.focus();await page.keyboard.press('Alt+ArrowDown');await settle(page);
   expect(await texts(page),name).toEqual(ORIGINAL);expect(await page.evaluate(()=>(window as any).__kd),name).toEqual([false]);
  }
 }
});

test('Alt+Down in the text moves the segment at 800 px and the panel goes with it',async({page})=>{
 await open(page,800);await pick(page,6);await area(page,6).focus();await page.keyboard.press('Alt+ArrowDown');await settle(page);
 expect((await texts(page))[6]).toBe(ORIGINAL[5]);
 await expect(panel(page)).toHaveCount(1);await expect(seg(page,7).locator('.segment-detail h3')).toHaveText('Đoạn 07 · Bà Tư');
});

// The keyboard path to the panel: the toolbar's "Chi tiết đoạn N" (Tab reaches the toolbar in two stops, while the aside is a screen of Tabs away) and Escape back.
const detailButton=(page:Page,n:number)=>seg(page,n).getByRole('button',{name:`Chi tiết đoạn ${n}`,exact:true});
for(const width of [1440,800])for(const how of ['Enter','click'])test(`"Chi tiết đoạn 5" in the toolbar, by ${how}, moves focus to "Giọng đoạn 5" at ${width} px`,async({page})=>{
 await open(page,width);
 if(how==='click')await detailButton(page,5).click(); // segment 1 is the selected one: the click selects segment 5 first
 else{await page.getByRole('textbox',{name:'Nhân vật đoạn 5'}).focus();await page.keyboard.press('Tab');await page.keyboard.press('End');await expect(detailButton(page,5)).toBeFocused();await page.keyboard.press('Enter');}
 await expect(page.getByRole('combobox',{name:'Giọng đoạn 5',exact:true})).toBeFocused();
 await expect(seg(page,5)).toHaveClass(/selected/);await expect(page.locator('.segment-detail h3')).toHaveText('Đoạn 05 · Người dẫn');
 await expect(seg(page,5).locator('.segment-detail')).toHaveCount(width===800?1:0);
});

for(const width of [1440,800])test(`Escape in the panel returns focus to the segment's text, which stays selected, at ${width} px`,async({page})=>{
 await open(page,width);await detailButton(page,5).click();await expect(page.getByRole('combobox',{name:'Giọng đoạn 5'})).toBeFocused();
 await page.keyboard.press('Escape');await expect(area(page,5)).toBeFocused();await expect(seg(page,5)).toHaveClass(/selected/);await expect(page.locator('.segment-detail h3')).toHaveText('Đoạn 05 · Người dẫn');
 await expect(seg(page,1)).not.toHaveClass(/selected/);
 await page.getByRole('textbox',{name:'Chương',exact:true}).focus();await page.keyboard.press('Escape');await expect(area(page,5)).toBeFocused(); // any control of the panel
});

test('Escape in a number field first drops the draft and keeps focus, the next one leaves the panel',async({page})=>{
 await open(page);await pick(page,3);const gap=page.getByLabel('Nghỉ sau (ms)',{exact:true});
 await gap.click();await gap.fill('999');await page.keyboard.press('Escape');
 await expect(gap).toHaveValue('300');await expect(gap).toBeFocused();
 await page.keyboard.press('Escape');await expect(area(page,3)).toBeFocused();await expect(gap).toHaveValue('300'); // nothing was committed on the way
});

test('Escape does nothing while an input method is composing',async({page})=>{
 await open(page);await detailButton(page,5).click();const voice=page.getByRole('combobox',{name:'Giọng đoạn 5'});await expect(voice).toBeFocused();
 await page.evaluate(()=>{const t=document.activeElement!;t.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',isComposing:true,bubbles:true,cancelable:true}));t.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',keyCode:229,bubbles:true,cancelable:true}));});
 await settle(page);await expect(voice).toBeFocused();
});

test('crossing 920 px with focus in the panel keeps focus on the same control, after committing its draft',async({page})=>{
 await open(page,1000);await detailButton(page,5).click();const voice=()=>page.getByRole('combobox',{name:'Giọng đoạn 5'});await expect(voice()).toBeFocused();
 await page.setViewportSize({width:800,height:900});await expect(seg(page,5).locator('.segment-detail')).toHaveCount(1);await expect(voice()).toBeFocused();
 await page.setViewportSize({width:1000,height:900});await expect(page.locator('.inspector .segment-detail')).toHaveCount(1);await expect(voice()).toBeFocused();
 const gap=page.getByLabel('Nghỉ sau (ms)',{exact:true});await gap.click();await gap.fill('1234');
 await page.setViewportSize({width:800,height:900});await expect(seg(page,5).locator('.segment-detail')).toHaveCount(1);
 await expect(gap).toBeFocused();await expect(gap).toHaveValue('1234'); // committed by the blur, then focused again where the panel is now
});

for(const width of [800,1440])test(`a poll that changes nothing for a row re-renders no row but the job's, the selected one included, at ${width} px`,async({page})=>{
 await open(page,width,true);await pick(page,5);await settle(page);
 await page.evaluate(()=>{(window as any).__renders={};});await page.waitForTimeout(6500); // two or three polls, each moving the job of segment 1
 const r:Record<string,number>=await page.evaluate(()=>(window as any).__renders);
 expect(r.s1,'the job row re-renders as its progress moves (this is how the count is known to work)').toBeGreaterThan(0);
 expect(Object.keys(r).filter(k=>k!=='s1'),`rows re-rendered: ${JSON.stringify(r)}`).toEqual([]);
});

test('the aside is named for what it holds: the segment panel beside the script, the dictionary and cast under 920 px',async({page})=>{
 await open(page);await expect(page.getByRole('complementary',{name:'Chi tiết đoạn',exact:true})).toHaveCount(1);
 await page.setViewportSize({width:800,height:900});
 await expect(page.getByRole('complementary',{name:'Từ điển và phân vai'})).toHaveCount(1);await expect(page.getByRole('complementary',{name:'Chi tiết đoạn',exact:true})).toHaveCount(0);
});

test('the normalized text in the panel follows the app dictionary while it is open',async({page})=>{
 await open(page);await pick(page,3);const word=ORIGINAL[2].split(' ')[0].replace(/[^\p{L}]/gu,'');
 await page.getByText('Văn bản sau chuẩn hóa',{exact:true}).click();await expect(page.locator('.normalization p')).not.toContainText('xyzzy');
 await page.getByRole('button',{name:'Model & cài đặt',exact:true}).click();const d=page.locator('.app-dictionary');
 await d.getByRole('textbox',{name:'Từ gốc'}).fill(word);await d.getByRole('textbox',{name:'Cách đọc'}).fill('xyzzy');await d.getByRole('button',{name:'Thêm cách đọc'}).click();await expect(d.getByText(`${word} → xyzzy`)).toBeVisible();
 await page.getByRole('button',{name:'Tạo giọng đọc',exact:true}).click();
 await expect(page.locator('.normalization p')).toContainText('xyzzy');
});
