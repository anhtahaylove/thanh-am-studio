import {test,expect,type Page} from '@playwright/test';
// The chapter map: a sticky bar above the script (two or more chapters) whose buttons jump to a chapter's first segment.
// The first test runs the demo project in the browser preview (chapters at segments 1 and 5). The rest mock Tauri with a 30-segment
// project (chapters at segments 3, 13 and 26, so segments 1-2 are "Mở đầu") that is long enough to scroll, and `chapters` positions.
const mock=({chapters,n}:{chapters:number[];n:number}):void=>{
 const w=window as any;w.isTauri=true;w.__scroll=[];
 const orig=Element.prototype.scrollIntoView;Element.prototype.scrollIntoView=function(o?:any){w.__scroll.push(o?.behavior);return orig.call(this,o);};
 const text='Đây là một câu thử nghiệm đủ dài để mỗi đoạn cao hơn một dòng trong danh sách kịch bản, có dấu tiếng Việt.';
 let project:any={id:'p1',name:'Sách nói',updated_at:'2026-11-20T00:00:00Z',revision:1,transcript:[],dictionary:{},source_asset_id:null,segments:Array.from({length:n},(_,i)=>({id:'s'+i,text:text+' '+(i+1),normalized_text:text,voice_id:null,speaker:'Người dẫn',gap_ms:300,takes:[],selected_take_id:null,trim_start_ms:0,trim_end_ms:null,fade_in_ms:0,fade_out_ms:0,gain_db:0,chapter:chapters.includes(i+1)?'Chương '+(chapters.indexOf(i+1)+1):null}))};
 const ipc=(v:unknown)=>JSON.parse(JSON.stringify(v));
 w.__TAURI_INTERNALS__={convertFileSrc:(p:string)=>p,transformCallback:()=>1,unregisterCallback:()=>{},metadata:{currentWindow:{label:'main'},currentWebview:{label:'main',windowLabel:'main'}},
  invoke:async(cmd:string,args:any)=>{switch(cmd){
   case 'list_projects':return [{id:project.id,name:project.name,updated_at:project.updated_at,revision:project.revision}];case 'load_project':return ipc(project);
   case 'list_voices':case 'list_models':case 'list_jobs':return [];case 'get_settings':return {dictionary:{}};
   case 'runtime_status':return {python_ready:true,ffmpeg_ready:true,worker_ready:true,native_worker_ready:true,python_path:null,ffmpeg_path:null,native_worker_path:null,fallback_count:0,message:''};
   case 'save_project':project={...ipc(args.project),revision:args.project.revision+1};return ipc(project);
   default:return null;}}};
};
// The commit hook of karaoke.spec.ts: counts the commits in which the chapter map re-rendered.
const countRenders=():void=>{
 const w=window as any;w.__map=0;
 const walk=(next:any,prev:any):void=>{
  if((next.tag===15||next.tag===0)&&/^ChapterMap\d*$/.test(next.type?.name)&&(next.flags&1))w.__map++;
  if(next.child!==prev.child)for(let c=next.child;c;c=c.sibling)if(c.alternate)walk(c,c.alternate);
 };
 w.__REACT_DEVTOOLS_GLOBAL_HOOK__={supportsFiber:true,renderers:new Map(),inject(r:any){const id=this.renderers.size+1;this.renderers.set(id,r);return id;},onCommitFiberRoot(_:number,root:any){if(root.current.alternate)walk(root.current,root.current.alternate);},onCommitFiberUnmount(){},onPostCommitFiberRoot(){},checkDCE(){}};
};
const open=async(page:Page,d:{chapters?:number[];n?:number;width?:number;height?:number;reduce?:boolean}={})=>{
 await page.setViewportSize({width:d.width??1440,height:d.height??700});
 if(d.reduce)await page.emulateMedia({reducedMotion:'reduce'});
 await page.addInitScript(countRenders);await page.addInitScript(mock,{chapters:d.chapters??[3,13,26],n:d.n??30});await page.goto('/');
 await page.getByRole('button',{name:'Dự án',exact:true}).click();await page.getByRole('button',{name:'Mở dự án',exact:true}).click();
 await expect(page.locator('article.segment')).toHaveCount(d.n??30);
};
const map=(page:Page)=>page.getByRole('navigation',{name:'Mục lục chương'});
const buttons=(page:Page)=>map(page).getByRole('toolbar',{name:'Chương'}).getByRole('button');
const box=async(l:ReturnType<Page['locator']>)=>(await l.boundingBox())!;
// The textarea of segment `k` is focused, that segment is the selected one, and its row starts just below the map (not under it).
const landed=async(page:Page,k:number,near=true)=>{
 const textarea=page.getByRole('textbox',{name:`Nội dung đoạn ${k}`,exact:true}),row=page.locator('article.segment').nth(k-1);
 await expect(textarea).toBeFocused();await expect(row).toHaveClass(/selected/);
 await expect.poll(async()=>(await box(row)).y-(await box(map(page))).y-(await box(map(page))).height,{message:'the row starts at or below the map and within a row of it'}).toBeGreaterThanOrEqual(0);
 if(near)expect((await box(row)).y-(await box(map(page))).y-(await box(map(page))).height).toBeLessThan(40);
};

test('the demo project shows a map of its two chapters: one tab stop that the arrows move, and Enter on a chapter selects its first segment and focuses its text',async({page})=>{
 await page.goto('/');await page.getByRole('button',{name:'Mở dự án mẫu'}).click();
 await expect(page.locator('article.segment')).toHaveCount(8);
 await expect(buttons(page)).toHaveText(['Chương 1: Buổi sáng ở bến · 4 đoạn','Chương 2: Chợ sớm · 4 đoạn']);
 await expect(buttons(page).and(page.locator('[tabindex="0"]'))).toHaveCount(1);
 await expect(buttons(page).first()).toHaveAttribute('tabindex','0');
 await expect(buttons(page).first()).toHaveAttribute('aria-current','true'); // the first segment is the selected one
 await buttons(page).first().focus();await page.keyboard.press('ArrowRight');
 await expect(buttons(page).nth(1)).toBeFocused();
 await expect(buttons(page).and(page.locator('[tabindex="0"]'))).toHaveCount(1);await expect(buttons(page).nth(1)).toHaveAttribute('tabindex','0');
 await page.keyboard.press('Enter');
 await landed(page,5,false); // 8 short segments: the page cannot scroll far enough to put row 5 at the top
 await expect(buttons(page).nth(1)).toHaveAttribute('aria-current','true');await expect(buttons(page).first()).not.toHaveAttribute('aria-current','true');
 await expect(buttons(page).nth(1)).toHaveAttribute('tabindex','0'); // the tab stop follows the selected chapter
});

test('the map names the opening segments "Mở đầu", jumps far down a long script with its row below the map, and stays visible at the last segment',async({page})=>{
 await open(page);
 await expect(buttons(page)).toHaveText(['Mở đầu · 2 đoạn','Chương 1 · 10 đoạn','Chương 2 · 13 đoạn','Chương 3 · 5 đoạn']);
 await buttons(page).nth(2).click();await landed(page,13);
 await buttons(page).nth(3).click();await landed(page,26);
 await page.mouse.wheel(0,100000);
 await expect(page.getByRole('textbox',{name:'Nội dung đoạn 30',exact:true})).toBeInViewport();
 await expect(map(page)).toBeInViewport({ratio:1});expect((await box(map(page))).y).toBeLessThan(2);
});

test('typing in a segment does not re-render the map; moving the selection to another chapter does',async({page})=>{
 await open(page);
 const area=page.getByRole('textbox',{name:'Nội dung đoạn 5',exact:true});await area.click();
 await page.evaluate(()=>{(window as any).__map=0;});
 await page.keyboard.type('abcdef',{delay:30});await expect(area).toHaveValue(/abcdef$/);await page.waitForTimeout(300);
 expect(await page.evaluate(()=>(window as any).__map),'map renders while typing').toBe(0);
 await page.getByRole('textbox',{name:'Nội dung đoạn 15',exact:true}).click();
 await expect(buttons(page).nth(2)).toHaveAttribute('aria-current','true');
 // The tab stop follows the selection without the map being focused first.
 await expect(buttons(page).nth(2)).toHaveAttribute('tabindex','0');
 for(const i of [0,1,3])await expect(buttons(page).nth(i)).toHaveAttribute('tabindex','-1');
 expect(await page.evaluate(()=>(window as any).__map),'the counter works: a new selected chapter re-renders the map').toBeGreaterThan(0);
});

for(const chapters of [[],[1]])test(`no map with ${chapters.length?'a single chapter':'no chapters'}`,async({page})=>{
 await open(page,{chapters});await expect(map(page)).toHaveCount(0);
});

test('a jump scrolls smoothly',async({page})=>{
 await open(page);
 await buttons(page).nth(2).click();await landed(page,13);
 expect(await page.evaluate(()=>(window as any).__scroll)).toEqual(['smooth']);
});
test('under reduced motion a jump passes behavior auto',async({page})=>{
 await open(page,{reduce:true});
 await buttons(page).nth(2).click();await landed(page,13);
 expect(await page.evaluate(()=>(window as any).__scroll)).toEqual(['auto']);
});

test('at 800 px, where the selected segment carries its panel inside its row, a jump still selects the segment and focuses its text',async({page})=>{
 await open(page,{width:800,height:700});
 await buttons(page).nth(1).click();await landed(page,3);
 await expect(page.locator('article.segment').nth(2).locator('.segment-detail')).toHaveCount(1);
 await buttons(page).nth(3).click();await landed(page,26);
 await expect(page.locator('article.segment').nth(25).locator('.segment-detail')).toHaveCount(1);
 await expect(page.locator('.segment-detail')).toHaveCount(1);
});

// At 920 px and below the studio grid is one column; the panel must not grow to the toolbar's width (min-width:0), so the toolbar scrolls inside itself and every button can be reached.
for(const [width,height] of [[1440,960],[1024,720],[800,720],[441,320]])test(`twelve chapters scroll inside the map, never the page, at ${width}x${height}`,async({page})=>{
 await open(page,{width,height,chapters:[1,3,5,7,9,11,13,15,17,19,21,23]});
 await expect(buttons(page)).toHaveCount(12);
 const over=()=>page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth);
 expect(await over(),'page scrolls sideways').toBeLessThanOrEqual(0);
 const bar=page.getByRole('toolbar',{name:'Chương'});
 if(width<=1024)expect(await bar.evaluate(e=>e.scrollWidth>e.clientWidth),'the toolbar scrolls inside itself').toBe(true);
 await buttons(page).first().focus();await page.keyboard.press('End');
 await expect(buttons(page).last()).toBeFocused();
 const [b,t]=[await box(buttons(page).last()),await box(bar)];
 expect(b.x+b.width,'the last button is inside the toolbar').toBeLessThanOrEqual(t.x+t.width+1);expect(b.x).toBeGreaterThanOrEqual(t.x-1);
 expect(await over(),'page scrolls sideways after reaching the last button').toBeLessThanOrEqual(0);
});
