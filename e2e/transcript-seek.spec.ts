import {test,expect,type Page} from '@playwright/test';
// Listening from the transcript: Ctrl+click on a word and Ctrl+Enter play the source from about that word (an estimate), and the
// follow-along toggle decides whether the playing row is scrolled to. Tauri is mocked; the source is a real 20 s WAV served by page.route.
const tone=()=>{const rate=8000,n=rate*20,b=Buffer.alloc(44+n*2);b.write('RIFF',0);b.writeUInt32LE(36+n*2,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(rate,24);b.writeUInt32LE(rate*2,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(n*2,40);for(let i=0;i<n;i++)b.writeInt16LE(Math.round(Math.sin(i/rate*2*Math.PI*440)*300),44+i*2);return b;};
const ROWS=[{id:'r1',start_ms:0,end_ms:4000,text:'một câu mở đầu'},{id:'r2',start_ms:10000,end_ms:14000,text:'aaa bbb ccc ddd'},{id:'r3',start_ms:15000,end_ms:18000,text:'câu cuối cùng'}];
const mock=(source:boolean)=>{
 const w=window as any;w.isTauri=true;w.__seekTo=[];w.__scrolls=[];
 // Record every time the app sets on the player, and every scroll into view.
 const d=Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,'currentTime')!;Object.defineProperty(HTMLMediaElement.prototype,'currentTime',{...d,set(v:number){w.__seekTo.push(v);d.set!.call(this,v);}});
 const sv=Element.prototype.scrollIntoView;Element.prototype.scrollIntoView=function(this:Element,arg?:boolean|ScrollIntoViewOptions){w.__scrolls.push(typeof arg==='object'?arg.behavior:arg);return sv.call(this,arg);};
 const project:any={id:'p1',name:'Nghe thử',updated_at:'2026-11-22T00:00:00Z',revision:1,transcript:[{id:'r1',start_ms:0,end_ms:4000,text:'một câu mở đầu'},{id:'r2',start_ms:10000,end_ms:14000,text:'aaa bbb ccc ddd'},{id:'r3',start_ms:15000,end_ms:18000,text:'câu cuối cùng'}],dictionary:{},source_asset_id:source?'src':null,segments:[]};
 const ipc=(v:unknown)=>JSON.parse(JSON.stringify(v));
 w.__TAURI_INTERNALS__={convertFileSrc:(p:string)=>p,transformCallback:()=>1,unregisterCallback:()=>{},metadata:{currentWindow:{label:'main'},currentWebview:{label:'main',windowLabel:'main'}},
  invoke:async(cmd:string,args:any)=>{switch(cmd){
   case 'list_projects':return [{id:'p1',name:project.name,updated_at:project.updated_at,revision:1}];case 'load_project':return ipc(project);
   case 'get_asset':return {id:'src',path:'/tone.wav',name:'phong-van.wav',duration_ms:20000,sample_rate:8000};
   case 'list_voices':case 'list_models':case 'list_jobs':return [];case 'get_settings':return {dictionary:{}};
   case 'runtime_status':return {python_ready:true,ffmpeg_ready:true,worker_ready:true,native_worker_ready:true,python_path:null,ffmpeg_path:null,native_worker_path:null,fallback_count:0,message:''};
   case 'save_project':return {...ipc(args.project),revision:args.project.revision+1};
   default:return null;}}};
};
const open=async(page:Page,source=true,width=1440)=>{
 await page.setViewportSize({width,height:900});const wav=tone();
 // Range requests are answered, so the player can seek far into the file instead of only inside what it has already buffered.
 await page.route('**/tone.wav',r=>{const m=/bytes=(\d+)-(\d*)/.exec(r.request().headers().range??'');if(!m)return r.fulfill({body:wav,headers:{'content-type':'audio/wav','accept-ranges':'bytes'}});const a=Number(m[1]),z=m[2]?Number(m[2]):wav.length-1;return r.fulfill({status:206,body:wav.subarray(a,z+1),headers:{'content-type':'audio/wav','accept-ranges':'bytes','content-range':`bytes ${a}-${z}/${wav.length}`}});});await page.addInitScript(mock,source);await page.goto('/');
 await page.getByRole('button',{name:'Dự án',exact:true}).click();await page.getByRole('button',{name:'Mở dự án',exact:true}).click();await page.getByRole('button',{name:'Chép lời',exact:true}).click();
 await expect(page.locator('.transcript-row')).toHaveCount(ROWS.length);
};
const box=(page:Page,id:string)=>page.locator(`[data-row="${id}"] textarea`);
const seeks=(page:Page)=>page.evaluate(()=>(window as any).__seekTo as number[]);
// The x of the middle of the third word of "aaa bbb ccc ddd", measured with the textarea's own font.
const thirdWordX=(page:Page)=>box(page,'r2').evaluate(el=>{const t=el as HTMLTextAreaElement,cs=getComputedStyle(t),c=document.createElement('canvas').getContext('2d')!;c.font=cs.font;return parseFloat(cs.paddingLeft)+parseFloat(cs.borderLeftWidth)+c.measureText('aaa bbb ').width+c.measureText('cc').width/2;});
const EXPECT_S=(10000+4000*8/15)/1000; // 12.1333 s: the third word starts at character 8 of 15

test('Ctrl+click on a word seeks to its estimated start and plays, and a plain click only places the caret',async({page})=>{
 await open(page);const audio=page.locator('.source-player audio');await expect(audio).toBeAttached();
 const x=await thirdWordX(page);
 await box(page,'r2').click({position:{x,y:18}});expect(await seeks(page)).toEqual([]);expect(await audio.evaluate((a:HTMLAudioElement)=>a.paused)).toBe(true);
 await box(page,'r2').click({position:{x,y:18},modifiers:['Control']});
 await expect.poll(async()=>(await seeks(page)).length).toBe(1);const [to]=await seeks(page);expect(Math.abs(to-EXPECT_S)).toBeLessThan(0.001);
 await box(page,'r2').click({position:{x,y:18},modifiers:['Meta']});await expect.poll(async()=>(await seeks(page)).length).toBe(2);expect(Math.abs((await seeks(page))[1]-EXPECT_S)).toBeLessThan(0.001);
 await expect.poll(()=>audio.evaluate((a:HTMLAudioElement)=>a.paused)).toBe(false);
 await expect.poll(()=>audio.evaluate((a:HTMLAudioElement)=>a.currentTime)).toBeGreaterThanOrEqual(EXPECT_S-0.001);
});
test('Ctrl+Enter plays from the caret, wherever in the word it is, and is not a newline',async({page})=>{
 await open(page);const t=box(page,'r2');await t.focus();await expect(t).toHaveAttribute('aria-keyshortcuts','Control+Enter');
 await page.evaluate(()=>{const w=window as any;w.__prevented=[];window.addEventListener('keydown',e=>{if(e.key==='Enter'&&e.ctrlKey)w.__prevented.push(e.defaultPrevented);});});
 for(const caret of [8,10,11]){await t.evaluate((el,c)=>(el as HTMLTextAreaElement).setSelectionRange(c,c),caret);await t.press('Control+Enter');}
 await expect.poll(async()=>(await seeks(page)).length).toBe(3);for(const to of await seeks(page))expect(Math.abs(to-EXPECT_S)).toBeLessThan(0.001);
 expect(await page.evaluate(()=>(window as any).__prevented)).toEqual([true,true,true]);
 // Enter that confirms an IME composition is not a request to play.
 await t.evaluate(el=>el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,isComposing:true,bubbles:true,cancelable:true})));await page.waitForTimeout(200);expect((await seeks(page)).length).toBe(3);
 await expect(t).toHaveValue('aaa bbb ccc ddd');
});
test('without a source audio, Ctrl+click and Ctrl+Enter do nothing but say so',async({page})=>{
 await open(page,false);expect(await page.locator('.source-player').count()).toBe(0);
 const x=await thirdWordX(page);
 await box(page,'r2').click({position:{x,y:18},modifiers:['Control']});await expect(page.getByRole('status')).toContainText('Dự án chưa có audio gốc để nghe');
 await page.getByRole('button',{name:'Đóng thông báo'}).click();await expect(page.getByRole('status')).toHaveCount(0);
 await box(page,'r2').press('Control+Enter');await expect(page.getByRole('status')).toContainText('Dự án chưa có audio gốc để nghe');
 expect(await seeks(page)).toEqual([]);
});
test('the footer tells how to listen from a word',async({page})=>{
 await open(page);await expect(page.locator('.script-footer .hint')).toContainText('Ctrl + bấm vào một từ để nghe từ khoảng chỗ đó');
});
test('the follow-along toggle decides whether the playing row is scrolled to, and the choice is remembered',async({page})=>{
 await open(page);const audio=page.locator('.source-player audio'),follow=page.getByRole('button',{name:'Theo lời khi phát'});
 const playAt=(s:number)=>audio.evaluate((a:HTMLAudioElement,s)=>{Object.defineProperty(a,'paused',{get:()=>false,configurable:true});Object.defineProperty(a,'currentTime',{get:()=>s,configurable:true});a.dispatchEvent(new Event('timeupdate'));},s);
 const scrolls=()=>page.evaluate(()=>(window as any).__scrolls.length as number);
 await expect(follow).toHaveAttribute('aria-pressed','true');
 await playAt(11);await expect(page.locator('.transcript-row[data-row="r2"]')).toHaveAttribute('aria-current','true');await expect.poll(scrolls).toBeGreaterThan(0);
 await follow.click();await expect(follow).toHaveAttribute('aria-pressed','false');expect(await page.evaluate(()=>localStorage.getItem('thanh-am-follow'))).toBe('0');
 const before=await scrolls();await playAt(16);await expect(page.locator('.transcript-row[data-row="r3"]')).toHaveAttribute('aria-current','true');await page.waitForTimeout(300);expect(await scrolls()).toBe(before);
 await page.reload();await page.getByRole('button',{name:'Dự án',exact:true}).click();await page.getByRole('button',{name:'Mở dự án',exact:true}).click();await page.getByRole('button',{name:'Chép lời',exact:true}).click();
 await expect(page.getByRole('button',{name:'Theo lời khi phát'})).toHaveAttribute('aria-pressed','false');
 await page.getByRole('button',{name:'Theo lời khi phát'}).click();await expect(page.getByRole('button',{name:'Theo lời khi phát'})).toHaveAttribute('aria-pressed','true');
 const again=await scrolls();await audio.evaluate((a:HTMLAudioElement)=>{Object.defineProperty(a,'paused',{get:()=>false,configurable:true});Object.defineProperty(a,'currentTime',{get:()=>11,configurable:true});a.dispatchEvent(new Event('timeupdate'));});await expect.poll(scrolls).toBeGreaterThan(again);
});
test('the follow toggle shows its state with more than a text colour',async({page})=>{
 await open(page);const follow=page.getByRole('button',{name:'Theo lời khi phát'});
 const paint=()=>follow.evaluate(b=>({button:getComputedStyle(b).backgroundColor,bar:getComputedStyle(b.closest('.source-player')!).backgroundColor,shadow:getComputedStyle(b).boxShadow}));
 // The pointer is moved away before every read: :hover paints the button too, and is not the state signal. The inset ring is.
 const settled=async(pressed:boolean)=>{await page.mouse.move(0,0);await expect(follow).toHaveAttribute('aria-pressed',String(pressed));await expect.poll(async()=>(await paint()).shadow!=='none').toBe(pressed);return paint();};
 const on=await settled(true);expect(on.button).not.toBe(on.bar);
 await follow.click();const off=await settled(false);expect(off.shadow).toBe('none');expect(off.button).not.toBe(on.button);
});
test('follow-along stays out of the way for 2.5 s after an edit, keeps working while only listening, and catches up when turned back on',async({page})=>{
 await open(page);const audio=page.locator('.source-player audio'),follow=page.getByRole('button',{name:'Theo lời khi phát'});
 const playAt=(s:number)=>audio.evaluate((a:HTMLAudioElement,s)=>{Object.defineProperty(a,'paused',{get:()=>false,configurable:true});Object.defineProperty(a,'currentTime',{get:()=>s,configurable:true});a.dispatchEvent(new Event('timeupdate'));},s);
 const scrolls=()=>page.evaluate(()=>(window as any).__scrolls.length as number),current=(id:string)=>expect(page.locator(`.transcript-row[data-row="${id}"]`)).toHaveAttribute('aria-current','true');
 // Listening only (Ctrl+click leaves the caret in the textarea): the list follows.
 await box(page,'r1').click();await playAt(11);await current('r2');await expect.poll(scrolls).toBeGreaterThan(0);
 // Typing in a row, then playback moves on: no scroll for 2.5 s.
 await box(page,'r1').press('End');await box(page,'r1').pressSequentially('!');const quiet=await scrolls();
 await playAt(16);await current('r3');await page.waitForTimeout(300);expect(await scrolls()).toBe(quiet);
 // After the quiet period the next row change scrolls again.
 await page.waitForTimeout(2400);await playAt(1);await current('r1');await expect.poll(scrolls).toBeGreaterThan(quiet);
 // Follow off, playback moves, then follow on while playing: the current row is scrolled to without a new time update.
 await follow.click();await expect(follow).toHaveAttribute('aria-pressed','false');await playAt(16);await current('r3');await page.waitForTimeout(300);const off=await scrolls();
 await follow.click();await expect(follow).toHaveAttribute('aria-pressed','true');await expect.poll(scrolls).toBeGreaterThan(off);
});
for(const width of [1440,1024,800,640])test(`the source player and its follow toggle stay inside the panel at ${width} px`,async({page})=>{
 await open(page,true,width);
 const edges=()=>page.evaluate(()=>{const p=document.querySelector('.transcript-panel')!,pr=p.getBoundingClientRect().right;return {over:[...p.querySelectorAll('.source-player > *')].filter(e=>e.getBoundingClientRect().right>pr+0.5).map(e=>e.textContent||e.tagName),page:document.documentElement.scrollWidth-innerWidth,scroll:p.scrollLeft};});
 expect(await edges()).toEqual({over:[],page:0,scroll:0});
 await page.getByRole('button',{name:'Theo lời khi phát'}).focus();expect(await edges()).toEqual({over:[],page:0,scroll:0});
});
