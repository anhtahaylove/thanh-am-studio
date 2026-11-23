import {test,expect,type Page} from '@playwright/test';
// Karaoke: while a take with self-check word times plays, the words of the playing segment light up under its text; a take without them gets a one-line hint.
// Tauri is mocked; the take is a real 8 s WAV (the tone of preview-switch.spec.ts). Segment 1 has take 1 (words at 0/400/800 ms), take 2 (only its last word,
// at 0 ms) and take 3 (the times of take 1); segment 2 has a take that was never checked; segment 3 is trimmed to 2000 ms with words at 0/2000/2400 ms;
// segment 4's check failed (`error`); segment 5's heard words match none of its script words.
const tone=()=>{const rate=8000,n=rate*8,b=Buffer.alloc(44+n*2);b.write('RIFF',0);b.writeUInt32LE(36+n*2,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(rate,24);b.writeUInt32LE(rate*2,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(n*2,40);for(let i=0;i<n;i++)b.writeInt16LE(Math.round(Math.sin(2*Math.PI*440*i/rate)*6000),44+i*2);return b;};
const ratio=(a:string,b:string)=>{const lum=(c:string)=>{const [r,g,b]=c.match(/[\d.]+/g)!.slice(0,3).map(v=>{const x=Number(v)/255;return x<=0.03928?x/12.92:((x+0.055)/1.055)**2.4;});return 0.2126*r+0.7152*g+0.0722*b;};const [x,y]=[lum(a),lum(b)].sort((p,q)=>q-p);return (x+0.05)/(y+0.05);};
const HINT='Chữ chạy theo giọng chỉ có ở take tạo khi bật “Tự kiểm bằng Whisper”.';
const mock=()=>{
 const w=window as any;w.isTauri=true;
 const check=(words:[string,number][])=>({model:'whisper-small',wer:0,heard:'',mismatches:[],words:words.map(([text,start_ms])=>({text,start_ms}))});
 const take=(id:string,c?:object)=>({id,asset_id:'a'+id,path:'/tone.wav',duration_ms:8000,sample_rate:8000,created_at:new Date().toISOString(),...(c?{check:c}:{})});
 const seg=(id:string,text:string,takes:any[],trim=0)=>({id,text,normalized_text:text,voice_id:null,speaker:'Người dẫn',gap_ms:300,takes,selected_take_id:takes[0].id,trim_start_ms:trim,trim_end_ms:null,fade_in_ms:0,fade_out_ms:0,gain_db:0});
 const ws:[string,number][]=[['xin',0],['chào',400],['bạn',800]];
 const project={id:'p1',name:'Chữ chạy',updated_at:new Date().toISOString(),revision:1,transcript:[],dictionary:{},source_asset_id:null,segments:[
  seg('1','Xin chào, bạn.',[take('t1',check(ws)),take('t1b',check([['bạn',0]])),take('t1c',check(ws))]),seg('2','Một câu khác.',[take('t2')]),
  seg('3','Một câu khác.',[take('t3',check([['một',0],['câu',2000],['khác',2400]]))],2000),
  seg('4','Một câu khác.',[take('t4',{model:'whisper-small',error:'CHECK_FAILED: no audio'})]),seg('5','Một câu khác.',[take('t5',check([['hoàn',0],['toàn',300],['lạ',600]]))])]};
 w.__TAURI_INTERNALS__={convertFileSrc:(p:string)=>p,transformCallback:()=>1,unregisterCallback:()=>{},metadata:{currentWindow:{label:'main'},currentWebview:{label:'main',windowLabel:'main'}},
  invoke:async(cmd:string,args:any)=>{switch(cmd){
   case 'list_projects':return [{id:project.id,name:project.name,updated_at:project.updated_at,revision:project.revision}];case 'load_project':return JSON.parse(JSON.stringify(project));
   case 'list_jobs':case 'list_voices':case 'list_models':return [];case 'get_settings':return {dictionary:{}};
   case 'runtime_status':return {python_ready:true,ffmpeg_ready:true,worker_ready:true,python_path:null,ffmpeg_path:null,message:''};
   case 'save_project':return {...args.project,revision:args.project.revision+1};default:return null;}}};
};
const open=async(page:Page,width=1440,height=1000)=>{
 await page.setViewportSize({width,height});
 await page.route('**/tone.wav',r=>r.fulfill({body:tone(),contentType:'audio/wav'}));
 await page.addInitScript(mock);await page.goto('/');
 await page.getByRole('button',{name:'Dự án',exact:true}).click();await page.getByRole('button',{name:'Mở dự án',exact:true}).click();
 await page.getByRole('heading',{level:1}).click(); // the take keys (1-9) act when focus is not in a field
};
const play=(page:Page)=>page.locator('.play-button');
const row=(page:Page,n:number)=>page.locator('article.segment').nth(n-1);
const lit=(page:Page)=>page.locator('.karaoke mark');
type Look={color:string;bg:string;weight:string}|null;
// Waits, frame by frame, until `word` is the lit one, and returns the line as it was in that frame: the words already spoken, each word's box, and the colours
// (against the first ancestor with a background) and weight of the lit word, a spoken one and one still to come.
const whenLit=(page:Page,word:string)=>page.waitForFunction(w=>{
 const p=document.querySelector('.karaoke');if(p?.querySelector('mark')?.textContent!==w)return false;
 const look=(e:Element|null)=>{if(!e)return null;let q:Element|null=e;while(q&&/^rgba\(.*,\s*0\)$|^transparent$/.test(getComputedStyle(q).backgroundColor))q=q.parentElement;const s=getComputedStyle(e);return {color:s.color,bg:getComputedStyle(q!).backgroundColor,weight:s.fontWeight};};
 return {said:[...p.querySelectorAll('.said')].map(e=>e.textContent),t:performance.now(),boxes:[...p.children].map(e=>{const r=e.getBoundingClientRect();return [r.x,r.y,r.width,r.height].map(v=>Math.round(v*10)/10);}),
  mark:look(p.querySelector('mark')),spoken:look(p.querySelector('span.said')),unsaid:look(p.querySelector('span:not(.said)'))};
},word,{polling:'raf'}).then(h=>h.jsonValue() as Promise<{said:string[];t:number;boxes:number[][];mark:Look;spoken:Look;unsaid:Look}>);

test('the playing take lights its words in order under the segment text: the second about 400 ms in, the first then spoken',async({page})=>{
 await open(page);await play(page).click();
 const line=row(page,1).locator('.karaoke');await expect(line).toHaveText('Xin chào, bạn.');await expect(line).toHaveAttribute('aria-hidden','true');
 const first=await whenLit(page,'Xin'),second=await whenLit(page,'chào');
 expect(first.said).toEqual([]);expect(second.said).toEqual(['Xin']);
 expect(second.t-first.t,'the second word starts at 400 ms, so it is not lit much sooner').toBeGreaterThan(300);
 const third=await whenLit(page,'bạn');expect(third.said).toEqual(['Xin','chào']);
 await expect(row(page,2).locator('.karaoke, .karaoke-none')).toHaveCount(0); // only the playing segment
});

test('the line disappears when playback stops',async({page})=>{
 await open(page);await play(page).click();await expect(lit(page)).toHaveCount(1);
 await page.getByRole('button',{name:'Dừng nghe thử'}).click();
 await expect(page.locator('.karaoke, .karaoke-none')).toHaveCount(0);
});

test('a take that was never checked shows a one-line hint while it plays, and nothing before or after',async({page})=>{
 await open(page);await row(page,2).click();await expect(page.locator('.karaoke-none')).toHaveCount(0);
 await play(page).click();await expect(play(page)).toHaveAccessibleName('Dừng nghe thử');
 const hint=row(page,2).locator('.karaoke-none');await expect(hint).toHaveText(HINT);await expect(hint).toHaveAttribute('aria-hidden','true');await expect(page.locator('.karaoke')).toHaveCount(0);
 await page.getByRole('button',{name:'Dừng nghe thử'}).click();await expect(hint).toHaveCount(0);
});

// The hint would be wrong for a take that was checked: self-check was on. A failed check, or words that place nowhere in the script, show nothing.
for(const [n,what] of [[4,'whose check failed'],[5,'whose heard words match none of the script']] as const)test(`a take ${what} shows neither the line nor the hint while it plays`,async({page})=>{
 await open(page);await row(page,n).click();await play(page).click();
 await expect(play(page)).toHaveAccessibleName('Dừng nghe thử');await expect.poll(()=>page.locator('.waveform i.played').count()).toBeGreaterThan(0); // playing, past the decode (the dock draws a take's bars before Play, so only played bars say the take started)
 await page.waitForTimeout(300);await expect(page.locator('.karaoke, .karaoke-none')).toHaveCount(0);
});

test('a trimmed take lights the word at its trim start first',async({page})=>{
 await open(page);await row(page,3).click();await page.getByRole('heading',{level:1}).click();
 await play(page).click();
 expect(await page.waitForFunction(()=>document.querySelector('.karaoke mark')?.textContent??false,undefined,{polling:'raf'}).then(h=>h.jsonValue())).toBe('câu');
});

test('switching to another take mid-play keeps the place in the speech: the lit word holds',async({page})=>{
 await open(page);await play(page).click();await whenLit(page,'bạn');
 await page.keyboard.press('3'); // take 3 has the same word times
 // Every frame for 600 ms after the switch: a take restarted from its start would light "Xin" again.
 const seen=await page.evaluate(()=>new Promise<string[]>(done=>{const words=new Set<string>(),t0=performance.now();const tick=()=>{words.add(document.querySelector('.karaoke mark')?.textContent??'(none)');if(performance.now()-t0<600)requestAnimationFrame(tick);else done([...words]);};tick();}));
 await expect(page.locator('.take-pick').nth(2)).toHaveAttribute('aria-pressed','true');
 expect(seen,'the words lit after the switch').toEqual(['bạn']);
});

test('stopping clears every 100 ms timer the line and the dock started, also after a mid-play take switch',async({page})=>{
 await page.addInitScript(()=>{const w=window as any;w.__live=new Set();const si=window.setInterval.bind(window),ci=window.clearInterval.bind(window);w.setInterval=(f:any,ms?:number,...a:any[])=>{const id=si(f,ms,...a);if(ms===100)w.__live.add(id);return id;};w.clearInterval=(id:any)=>{w.__live.delete(id);ci(id);};});
 await open(page);const base=await page.evaluate(()=>(window as any).__live.size);
 await play(page).click();await whenLit(page,'chào');
 await page.keyboard.press('2');await expect(page.locator('.take-pick').nth(1)).toHaveAttribute('aria-pressed','true');await page.waitForTimeout(300);
 await page.getByRole('button',{name:'Dừng nghe thử'}).click();await expect(page.locator('.karaoke')).toHaveCount(0);await page.waitForTimeout(250);
 expect(await page.evaluate(()=>(window as any).__live.size)).toBe(base);
});

test('typing in the playing segment updates its karaoke line',async({page})=>{
 await open(page);await play(page).click();await expect(lit(page)).toHaveCount(1);
 await page.getByRole('textbox',{name:'Nội dung đoạn 1',exact:true}).click();await page.keyboard.press('End');await page.keyboard.type(' nhé');
 await expect(page.locator('.karaoke')).toHaveText('Xin chào, bạn. nhé');
});

test('an auditioned take lights its own words',async({page})=>{
 await open(page);await page.keyboard.press('2'); // audition take 2: only "bạn" was timed, at 0 ms
 await expect(row(page,1).locator('.karaoke mark')).toHaveText('bạn');
 await expect(row(page,1).locator('.karaoke .said')).toHaveText(['Xin','chào']);
});

test('selecting another segment removes the line, since the preview stops',async({page})=>{
 await open(page);await play(page).click();await expect(lit(page)).toHaveCount(1);
 await row(page,2).click();
 await expect(play(page)).toHaveAccessibleName('Nghe thử đoạn');await expect(page.locator('.karaoke, .karaoke-none')).toHaveCount(0);
});

test('at 800 px the playing row shows the karaoke line above its details panel, and the panel stays after the stop',async({page})=>{
 await open(page,800,900);await play(page).click();
 const line=row(page,1).locator('.karaoke'),panel=row(page,1).locator('.segment-detail');
 await expect(line).toBeVisible();await expect(panel).toBeVisible();await expect(lit(page)).toHaveCount(1);
 expect((await line.boundingBox())!.y).toBeLessThan((await panel.boundingBox())!.y);
 await page.getByRole('button',{name:'Dừng nghe thử'}).click();await expect(line).toHaveCount(0);await expect(panel).toBeVisible();
});

for(const theme of ['light','dark'] as const)test(`in the ${theme} theme the lit word keeps its place and width, every word reads at AA, and nothing scrolls sideways at 1024 or 1440 px`,async({page})=>{
 await page.emulateMedia({colorScheme:theme});await open(page);await expect(page.locator('html')).toHaveAttribute('data-theme',theme);
 const line=row(page,1).locator('.karaoke');
 await play(page).click();const first=await whenLit(page,'Xin'),last=await whenLit(page,'bạn');
 expect(last.boxes,'the words do not move or change width as the light passes').toEqual(first.boxes);
 expect(first.mark!.weight,'the lit word is not bolder').toBe(first.unsaid!.weight);
 for(const [what,c] of Object.entries({lit:first.mark,'still to come':first.unsaid,spoken:last.spoken,'lit last':last.mark}))expect(ratio(c!.color,c!.bg),`${what}: ${c!.color} on ${c!.bg}`).toBeGreaterThanOrEqual(4.5);
 for(const [width,height] of [[1024,720],[1440,960]]){
  await page.setViewportSize({width,height});await expect(line).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth),`sideways scroll at ${width} px`).toBeLessThanOrEqual(0);
 }
});

// An 800-segment script (perf-budget.spec.ts's) whose segment 1 plays a take of 30 timed words matching its text. The commit hook of contextual-inspector.spec.ts
// counts the rows React re-renders. Every poll re-renders the app (a job of another project is running, and a voice is added), but no row may re-render: not
// the playing one, whose karaoke line ticks inside itself, and not any other. The perf line is printed before the karaoke checks, so main prints it too (A/B).
const IDLE_MS=100;
const countRenders=():void=>{
 const w=window as any;w.__renders={};w.__app=0;
 const walk=(next:any,prev:any):void=>{
  if((next.tag===15||next.tag===0)&&/^SegmentRow\d*$/.test(next.type?.name)&&(next.flags&1)){const id=next.memoizedProps.segment.id;w.__renders[id]=(w.__renders[id]??0)+1;}
  if(next.tag===0&&next.type?.name==='App'&&(next.flags&1))w.__app++;
  if(next.child!==prev.child)for(let c=next.child;c;c=c.sibling)if(c.alternate)walk(c,c.alternate);
 };
 w.__REACT_DEVTOOLS_GLOBAL_HOOK__={supportsFiber:true,renderers:new Map(),inject(r:any){const id=this.renderers.size+1;this.renderers.set(id,r);return id;},onCommitFiberRoot(_:number,root:any){if(root.current.alternate)walk(root.current,root.current.alternate);},onCommitFiberUnmount(){},onPostCommitFiberRoot(){},checkDCE(){}};
};
const mock800=()=>{
 const w=window as any,n=800;w.isTauri=true;w.__loads=0;w.__lt=[];w.__grow=false;w.__holdSave=false;
 const words=Array.from({length:30},(_,k)=>({text:'từ'+k,start_ms:k*200}));
 const take=(id:string,path=id+'.wav')=>({id,asset_id:'a'+id,path,duration_ms:8000,sample_rate:8000,created_at:'2026-11-20T00:00:00Z',check:{model:'whisper-small',wer:0.02,heard:'x',mismatches:[],words}});
 const text='Đây là một câu thử nghiệm khá dài để mô phỏng kịch bản tiếng Việt thật, có dấu và có nhiều từ trong một đoạn văn bình thường.';
 let project:any={id:'p1',name:'Sách nói',updated_at:'2026-11-20T00:00:00Z',revision:1,transcript:[],dictionary:{},source_asset_id:null,segments:Array.from({length:n},(_,i)=>({id:'s'+i,text:i?text+' '+i:words.map(x=>x.text).join(' ')+'.',normalized_text:text,voice_id:'v'+(i%25),speaker:'Người dẫn',gap_ms:300,takes:[take('t'+i+'a',i?undefined:'/tone.wav'),take('t'+i+'b')],selected_take_id:'t'+i+'a',trim_start_ms:0,trim_end_ms:null,fade_in_ms:0,fade_out_ms:0,gain_db:0,chapter:i%100===0?'Chương '+(i/100+1):null}))};
 const voices=Array.from({length:25},(_,i)=>({id:'v'+i,name:'Giọng '+i,kind:'preset',reference_asset_id:null,consent:true,engine_voice_id:'v'+i}));
 const jobs:any[]=Array.from({length:n},(_,i)=>({id:'j'+i,kind:'tts',project_id:'p1',payload:{segment_id:'s'+i,text},status:'succeeded',progress:1,error:null,result:{asset_id:'r'+i,take_id:'t'+i+'a'},created_at:'2026-11-20T00:00:00Z',updated_at:'2026-11-20T00:00:00Z'}));
 jobs.push({id:'jx',kind:'render',project_id:'p0',payload:{segments:[]},status:'running',progress:0.1,error:null,result:null,created_at:'2026-11-20T00:00:00Z',updated_at:'2026-11-20T00:00:00Z'}); // another project's export: every poll re-renders the app
 const models=['vieneu-v3','whisper-small'].map(id=>({id,name:id,engine:'tts',kind:'model',installed:true,revision:'x',license:'MIT',description:''}));
 const ipc=(v:unknown)=>JSON.parse(JSON.stringify(v));
 w.__TAURI_INTERNALS__={convertFileSrc:(p:string)=>p,transformCallback:()=>1,unregisterCallback:()=>{},metadata:{currentWindow:{label:'main'},currentWebview:{label:'main',windowLabel:'main'}},
  invoke:async(cmd:string,args:any)=>{switch(cmd){
   case 'list_projects':return [{id:project.id,name:project.name,updated_at:project.updated_at,revision:project.revision}];case 'load_project':w.__loads++;return ipc(project);
   case 'list_voices':if(w.__grow)voices.push({id:'v'+voices.length,name:'Giọng '+voices.length,kind:'preset',reference_asset_id:null,consent:true,engine_voice_id:'v'+voices.length});return ipc(voices); // a new voice rebuilds the details panel, which at this width is not in the row
   case 'list_models':return ipc(models);case 'list_jobs':jobs[n].progress=Math.min(.99,jobs[n].progress+.01);return ipc(jobs);case 'get_settings':return {dictionary:{}};
   case 'runtime_status':return {python_ready:true,ffmpeg_ready:true,worker_ready:true,native_worker_ready:true,python_path:null,ffmpeg_path:null,native_worker_path:null,fallback_count:0,message:''};
   case 'save_project':if(w.__holdSave)return new Promise(()=>{});project={...ipc(args.project),revision:args.project.revision+1};return ipc(project); // held: the saved copy has new segment objects, which would re-render every row by itself
   default:return null;}}};
 new PerformanceObserver(l=>{for(const e of l.getEntries())w.__lt.push(Math.round(e.duration));}).observe({type:'longtask'});
};
test('while a take plays in an 800-segment script, polls re-render no row (the playing one included) and an edit to another row re-renders only that row',async({page})=>{
 test.setTimeout(180000);
 await page.route('**/tone.wav',r=>r.fulfill({body:tone(),contentType:'audio/wav'}));
 await page.addInitScript(countRenders);await page.addInitScript(mock800);await page.goto('/');
 await page.getByRole('button',{name:'Dự án',exact:true}).click();await page.getByRole('button',{name:'Mở dự án',exact:true}).click();
 // CSS selectors from here on: computing accessible names over ~70k nodes takes seconds.
 await expect(page.locator('textarea[aria-label="Nội dung đoạn 800"]')).toBeAttached({timeout:90000});
 await expect.poll(()=>page.evaluate(()=>(window as any).__loads),{timeout:30000}).toBe(2);await page.waitForTimeout(2000);
 await page.locator('.play-button').click();
 await expect(page.locator('.play-button[aria-label="Dừng nghe thử"]')).toBeAttached();await expect.poll(()=>page.locator('.waveform i.played').count()).toBeGreaterThan(0); // the take started: the bars alone are drawn before Play
 await page.waitForTimeout(500); // the start of playback has landed
 await page.evaluate(()=>{const w=window as any;w.__renders={};w.__app=0;w.__lt=[];w.__grow=true;});
 await page.waitForTimeout(3000); // one or two polls (every 2.5 s)
 const {renders,app,idle}=await page.evaluate(()=>{const w=window as any;return {renders:w.__renders as Record<string,number>,app:w.__app as number,idle:w.__lt as number[]};});
 console.log(`perf: 800 segments while a take plays: idle long tasks (ms) ${idle.join(', ')||'none'}; app renders ${app}; row renders ${JSON.stringify(renders)}`);
 await expect(page.locator('.play-button[aria-label="Dừng nghe thử"]')).toBeAttached(); // still playing
 await expect(page.locator('article.segment').first().locator('.karaoke mark')).toHaveCount(1);
 expect(app,'a poll re-rendered the app (this is how the window is known to hold one)').toBeGreaterThan(0);
 expect(renders,'rows re-rendered while the take played').toEqual({});
 expect.soft(Math.max(0,...idle),`long tasks (ms) while the take played: ${idle.join(', ')||'none'}`).toBeLessThan(IDLE_MS);
 // An edit to row 400 that does not focus it (focus would select it and stop the preview): only that row re-renders, and the take keeps playing.
 await page.evaluate(()=>{const w=window as any;w.__holdSave=true;w.__renders={};const t=document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Nội dung đoạn 400"]')!;Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(t,t.value+' x');t.dispatchEvent(new Event('input',{bubbles:true}));});
 await expect(page.locator('textarea[aria-label="Nội dung đoạn 400"]')).toHaveValue(/ x$/);await page.waitForTimeout(300);
 expect(await page.evaluate(()=>(window as any).__renders)).toEqual({s399:expect.any(Number)});
 await expect(page.locator('.play-button[aria-label="Dừng nghe thử"]')).toBeAttached();await expect(page.locator('article.segment').first().locator('.karaoke mark')).toHaveCount(1);
});
