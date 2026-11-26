import {test,expect,type Page} from '@playwright/test';
import {readFileSync} from 'node:fs';
// A blocked action says why. Ctrl+Enter on a blocked segment speaks the reason and shows it under the text on every press; a focused aria-disabled
// control shows its reason in one fixed bubble outside every panel, which no panel clips, the control's dimming does not fade, and which follows the
// control when Tab scrolls it into view. Desktop cases mock Tauri as segment-toolbar.spec.ts does; preview cases seed the browser store.
const FIXTURE=JSON.parse(readFileSync('e2e/fixtures/script-12.json','utf8'));
const KEY='thanh-am-preview-projects-v1';
type Seg={text:string;normalized_text:string;chapter?:string|null;[k:string]:unknown};
const mock=(o:{project:string;installed:boolean}):void=>{
 const w=window as any;w.isTauri=true;w.__calls=[];w.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};
 const project:any=JSON.parse(o.project);
 const ipc=(v:unknown)=>JSON.parse(JSON.stringify(v));
 w.__TAURI_INTERNALS__={convertFileSrc:(p:string)=>p,transformCallback:()=>1,unregisterCallback:()=>{},metadata:{currentWindow:{label:'main'},currentWebview:{label:'main',windowLabel:'main'}},
  invoke:async(cmd:string,args:any)=>{w.__calls.push(cmd);switch(cmd){
   case 'list_projects':return [{id:project.id,name:project.name,updated_at:project.updated_at,revision:project.revision}];case 'load_project':return ipc(project);
   case 'list_voices':return [];case 'list_models':return [{id:'vieneu-v3',name:'VieNeu v3 Turbo',engine:'tts',installed:o.installed,revision:'r',license:'Apache-2.0',description:''}];
   case 'list_jobs':return [];case 'get_settings':return {dictionary:{}};
   case 'runtime_status':return {python_ready:true,ffmpeg_ready:true,worker_ready:true,python_path:null,ffmpeg_path:null,message:''};
   case 'save_project':return {...ipc(args.project),revision:args.project.revision+1};
   default:return null;}}};
 // What the live region receives: a node added to it is what a screen reader reads. Every action the app runs shows the busy indicator for a moment.
 w.__said=[];w.__busy=0;new MutationObserver(l=>{for(const m of l)for(const n of m.addedNodes)if(n instanceof HTMLElement){if(n.parentElement?.matches('.sr-only[aria-live=polite]'))w.__said.push(n.textContent);if(n.classList.contains('busy-indicator'))w.__busy++;}}).observe(document,{childList:true,subtree:true});
};
const openProject=async(page:Page,n:number)=>{
 await page.getByRole('button',{name:'Dự án',exact:true}).click();await page.getByRole('button',{name:'Mở dự án',exact:true}).click();
 if(n)await expect(page.getByRole('textbox',{name:`Nội dung đoạn ${n}`,exact:true})).toBeVisible();
};
const desktop=async(page:Page,segments:Seg[],o:{installed?:boolean;height?:number}={})=>{
 await page.setViewportSize({width:1440,height:o.height??900});await page.addInitScript(mock,{project:JSON.stringify({...FIXTURE,segments}),installed:o.installed??true});await page.goto('/');
 await openProject(page,segments.length);
};
// The browser preview, where generating and exporting are blocked ("Cần bản desktop…").
const preview=async(page:Page,theme:'light'|'dark',transcript:unknown[]=[])=>{
 await page.goto('/');await page.evaluate(([k,p,t])=>{localStorage.setItem(k,JSON.stringify([p]));localStorage.setItem('thanh-am-theme',t);},[KEY,{...FIXTURE,transcript},theme] as const);await page.reload();
 await expect(page.locator('html')).toHaveAttribute('data-theme',theme);await openProject(page,12);
};
const seg=(page:Page,n:number)=>page.locator('article.segment').nth(n-1);
const area=(page:Page,n:number)=>page.getByRole('textbox',{name:`Nội dung đoạn ${n}`,exact:true});
const region=(page:Page)=>page.locator('.sr-only[aria-live=polite]');
const bubble=(page:Page)=>page.locator('.reason-bubble');
const calls=(page:Page,name:string)=>page.evaluate(n=>((window as any).__calls as string[]).filter(c=>c===n).length,name);
const settle=(page:Page)=>page.evaluate(()=>new Promise<void>(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r()))));
// WCAG contrast of two computed colours, as in a11y.spec.ts.
const ratio=(a:string,b:string)=>{const lum=(c:string)=>{const [r,g,b]=c.match(/[\d.]+/g)!.slice(0,3).map(v=>{const x=Number(v)/255;return x<=0.03928?x/12.92:((x+0.055)/1.055)**2.4;});return 0.2126*r+0.7152*g+0.0722*b;};const [x,y]=[lum(a),lum(b)].sort((p,q)=>q-p);return (x+0.05)/(y+0.05);};
// The bubble against the viewport and the focused control, and its colours with the opacity of the bubble and every ancestor.
const measure=(page:Page)=>page.evaluate(()=>{
 const b=document.querySelector<HTMLElement>('.reason-bubble');if(!b)return null;
 const r=b.getBoundingClientRect(),f=document.activeElement!.getBoundingClientRect(),vw=document.documentElement.clientWidth,vh=document.documentElement.clientHeight,s=getComputedStyle(b),pointerEvents=s.pointerEvents;
 let opacity=1;for(let e:Element|null=b;e;e=e.parentElement)opacity*=Number(getComputedStyle(e).opacity);
 // The bubble lets clicks through, which elementFromPoint also skips, so it is hit-testable just for this check: nothing is drawn over it.
 b.style.pointerEvents='auto';const topmost=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)===b;b.style.pointerEvents='';
 return {text:b.textContent,ariaHidden:b.getAttribute('aria-hidden'),pointerEvents,visible:s.visibility!=='hidden'&&r.width>0&&r.height>0,inside:r.left>=0&&r.top>=0&&r.right<=vw&&r.bottom<=vh,topmost,
  overlaps:r.left<f.right&&f.left<r.right&&r.top<f.bottom&&f.top<r.bottom,inPanelOrButton:!!b.closest('button,.panel'),fg:s.color,bg:s.backgroundColor,page:getComputedStyle(document.documentElement).backgroundColor,opacity};
});
// Text and background as drawn: the background over the page by its alpha, the text over the background by its alpha, then both faded over the page by the opacity.
const drawn=(m:{fg:string;bg:string;page:string;opacity:number})=>{
 const rgba=(c:string)=>{const [r,g,b,a=1]=c.match(/[\d.]+/g)!.map(Number);return {c:[r,g,b],a};},over=(top:number[],under:number[],a:number)=>top.map((v,i)=>v*a+under[i]*(1-a));
 const page=rgba(m.page).c,bg=over(rgba(m.bg).c,page,rgba(m.bg).a),fg=over(rgba(m.fg).c,bg,rgba(m.fg).a);
 return [over(fg,page,m.opacity),over(bg,page,m.opacity)].map(c=>`rgb(${c.join(',')})`) as [string,string];
};
const readable=async(page:Page,text:string,label:string)=>{
 await settle(page);const m=await measure(page);
 expect(m,`${label}: a bubble`).not.toBeNull();
 expect(m!,label).toMatchObject({text,ariaHidden:'true',pointerEvents:'none',visible:true,inside:true,topmost:true,overlaps:false,inPanelOrButton:false});
 expect(ratio(...drawn(m!)),`${label}: contrast of ${m!.fg} on ${m!.bg} at opacity ${m!.opacity}`).toBeGreaterThanOrEqual(4.5);
};

test('Ctrl+Enter in an empty segment says why, aloud and under the text, again on every press, and enqueues nothing',async({page})=>{
 await desktop(page,FIXTURE.segments.map((s:Seg,i:number)=>i===2?{...s,text:'',normalized_text:''}:s));
 await area(page,3).click();await expect(seg(page,3)).toHaveClass(/selected/); // segment 1 is the one selected when a project opens
 const text='Chưa tạo giọng được: Đoạn này chưa có nội dung',hint=seg(page,3).locator('.row-hint');
 await page.keyboard.press('Control+Enter');
 await expect(hint).toHaveText(text);await expect(hint).toHaveAttribute('aria-hidden','true');await expect(region(page)).toHaveText(text);
 // The hint lasts 4 s from the last press: pressed again after 2.5 s, it is still there 2.5 s later, then goes.
 await page.waitForTimeout(2500);await page.keyboard.press('Control+Enter');
 await expect.poll(()=>page.evaluate(t=>((window as any).__said as string[]).filter(s=>s===t).length,text)).toBe(2);
 await expect(area(page,3)).toHaveValue(''); // a precaution: Chromium types nothing for Ctrl+Enter anyway, and the blocked shortcut keeps preventDefault
 await page.waitForTimeout(2500);await expect(hint).toHaveText(text);await expect(hint).toHaveCount(0,{timeout:3000});
 expect(await calls(page,'enqueue_job')).toBe(0);
});

test('with VieNeu missing, Ctrl+Enter gives the model reason, and editing the text clears the hint',async({page})=>{
 await desktop(page,FIXTURE.segments,{installed:false});
 await area(page,3).click();await page.keyboard.press('Control+Enter');
 const text='Chưa tạo giọng được: Tải VieNeu v3 Turbo trong Model & cài đặt để bật',hint=seg(page,3).locator('.row-hint');
 await expect(hint).toHaveText(text);await expect(region(page)).toHaveText(text);
 await page.keyboard.type('x');await expect(hint).toHaveCount(0,{timeout:1000}); // at once, well inside its 4 s: still blocked, but the hint was about the text before the edit
 expect(await calls(page,'enqueue_job')).toBe(0);
});

for(const theme of ['light','dark'] as const)test(`a focused blocked control shows its reason in a readable bubble that no panel clips: "Đưa đoạn lên" and the dock's "Xuất audio", ${theme}`,async({page})=>{
 await preview(page,theme);
 await seg(page,1).getByRole('button',{name:'Đưa đoạn lên'}).focus();
 await readable(page,'Đây là đoạn đầu tiên','"Đưa đoạn lên" of segment 1');
 const exportAudio=page.getByRole('button',{name:'Xuất audio',exact:true});
 await expect(exportAudio).toHaveAttribute('aria-disabled','true');await expect(exportAudio).toHaveAccessibleDescription('Cần bản desktop để xuất audio');
 await exportAudio.focus();
 await readable(page,'Cần bản desktop để xuất audio','"Xuất audio" in the dock');
 await exportAudio.blur();await expect(bubble(page)).toHaveCount(0);
});

test('Tab to a blocked item of an off-screen row: the bubble follows the scroll that brings it into view, and hides when it leaves',async({page})=>{
 // 30 segments; the last is empty and opens no chapter, so Tab from its speaker field goes straight to its toolbar.
 const segments=Array.from({length:30},(_,i)=>{const {chapter:_c,...s}=FIXTURE.segments[i%12] as Seg;return {...s,id:'s'+(i+1),takes:[],selected_take_id:null,...i===29?{text:'',normalized_text:''}:{}};});
 await desktop(page,segments,{height:960});
 const gen=seg(page,30).getByRole('button',{name:'Tạo giọng',exact:true});
 await expect(gen).toHaveAttribute('aria-disabled','true');await expect(gen).toHaveAccessibleDescription('Đoạn này chưa có nội dung');
 await gen.focus();await gen.blur();await expect(gen).toHaveAttribute('tabindex','0'); // the toolbar's tab stop is now this item
 await page.evaluate(()=>scrollTo(0,0));await settle(page);
 expect(await gen.evaluate(el=>el.getBoundingClientRect().top>=innerHeight),'the item starts below the viewport').toBe(true);
 await page.getByRole('textbox',{name:'Nhân vật đoạn 30',exact:true}).evaluate(el=>(el as HTMLElement).focus({preventScroll:true}));
 await page.keyboard.press('Tab');await expect(gen).toBeFocused();
 await readable(page,'Đoạn này chưa có nội dung','the item Tab scrolled into view');
 // A small scroll that keeps the item in view moves the bubble with it.
 const gap=()=>page.evaluate(()=>{const b=document.querySelector('.reason-bubble')!.getBoundingClientRect(),f=document.activeElement!.getBoundingClientRect();return Math.round(b.top-f.bottom);});
 const g0=await gap(),y0=await page.evaluate(()=>scrollY);await page.evaluate(()=>scrollBy(0,-40));await settle(page);
 expect(await page.evaluate(()=>scrollY),'the page scrolled').toBe(y0-40);expect(await gap(),'the bubble kept its place under the item').toBe(g0);
 await readable(page,'Đoạn này chưa có nội dung','the item after a small scroll');
 await page.evaluate(()=>scrollTo(0,0));await settle(page);
 await expect(bubble(page)).toBeHidden();await expect(gen).toBeFocused();
});

test('the bubble follows the focused control: Ctrl+Z unblocks "Tạo giọng" and the bubble goes, Ctrl+Shift+Z blocks it again and the bubble is back',async({page})=>{
 await desktop(page,FIXTURE.segments);
 await area(page,3).fill('');const gen=seg(page,3).getByRole('button',{name:'Tạo giọng',exact:true});
 await gen.focus();await readable(page,'Đoạn này chưa có nội dung','"Tạo giọng" of the emptied segment');
 await page.keyboard.press('Control+z');await expect(area(page,3)).toHaveValue(FIXTURE.segments[2].text);
 await expect(gen).not.toHaveAttribute('aria-disabled','true');await expect(gen).toBeFocused();await expect(bubble(page)).toHaveCount(0);
 await page.keyboard.press('Control+Shift+z');await expect(area(page,3)).toHaveValue('');
 await expect(gen).toHaveAttribute('aria-disabled','true');await expect(gen).toBeFocused();await readable(page,'Đoạn này chưa có nội dung','"Tạo giọng" blocked again');
});

test('an enabled control with a description shows no bubble: "Nghỉ sau (ms)" holding an invalid value',async({page})=>{
 await desktop(page,FIXTURE.segments);await page.getByText('Chỉnh âm',{exact:true}).click();
 const field=page.getByLabel('Nghỉ sau (ms)');await field.fill('-5');await expect(field).toHaveAccessibleDescription(/trở lên/);
 await page.keyboard.press('Tab');await field.focus();await settle(page); // a fresh focusin on the field, which keeps its draft and description
 await expect(field).toBeFocused();await expect(field).toHaveAccessibleDescription(/trở lên/);await expect(bubble(page)).toHaveCount(0);
});

test('"Thay N chỗ" with no exact match is focusable and shows its reason',async({page})=>{
 await preview(page,'light',[{id:'r0',start_ms:0,end_ms:1000,text:'mua cá thu',speaker:null,overlap_speaker:null},{id:'r1',start_ms:2000,end_ms:3000,text:'cá thu tươi',speaker:null,overlap_speaker:null}]);
 await page.getByRole('button',{name:'Chép lời',exact:true}).click();
 await page.getByLabel('Tìm trong bản chép lời').fill('ca thu');await page.getByLabel('Thay bằng').fill('cá basa');
 const replace=page.getByRole('button',{name:'Thay 0 chỗ',exact:true}),why='Thay thế chỉ khớp đúng dấu: không có chỗ nào khớp đúng “ca thu”';
 await expect(replace).toHaveAccessibleDescription(why);
 await page.getByLabel('Thay bằng').focus();await page.keyboard.press('Tab');await expect(replace).toBeFocused();
 await readable(page,why,'"Thay 0 chỗ" in the transcript toolbar');
 await page.keyboard.press('Enter');await expect(page.locator('.transcript-row textarea').first()).toHaveValue('mua cá thu');
});

test('with no segment the dock\'s SRT and "Xuất audio" keep their names, are focusable, say why and do nothing',async({page})=>{
 await desktop(page,[]);
 const busy=()=>page.evaluate(()=>(window as any).__busy as number);await settle(page);await page.waitForTimeout(500);const before=await busy();
 for(const name of ['SRT','Xuất audio']){
  const b=page.getByRole('button',{name,exact:true});await expect(b).toHaveAccessibleDescription('Thêm ít nhất một đoạn');await expect(b).toHaveAttribute('title','Thêm ít nhất một đoạn');
  await b.focus();await readable(page,'Thêm ít nhất một đoạn',name);
  await b.click({force:true});await page.keyboard.press('Enter');await page.keyboard.press('Space');
 }
 await settle(page);expect(await busy()).toBe(before);expect(await calls(page,'enqueue_job')).toBe(0);
});

test('with no segment "Tạo giọng tất cả" is reached by Tab, says why and does nothing',async({page})=>{
 await desktop(page,[]);
 const all=page.getByRole('button',{name:'Tạo giọng tất cả',exact:true}),why='Thêm ít nhất một đoạn',busy=()=>page.evaluate(()=>(window as any).__busy as number);
 await settle(page);await page.waitForTimeout(500);const before=await busy();
 await page.getByRole('checkbox',{name:'Đọc từ tiếng Anh'}).focus();await page.keyboard.press('Tab');await expect(all).toBeFocused();
 await expect(all).toHaveAccessibleDescription(why);await expect(all).toHaveAttribute('title',why);await readable(page,why,'Tạo giọng tất cả');
 await all.click({force:true});await page.keyboard.press('Enter');await page.keyboard.press('Space');
 await settle(page);expect(await busy()).toBe(before);expect(await calls(page,'enqueue_job')).toBe(0);
});
