import {test,expect,type Page} from '@playwright/test';
// A/B take compare: the dock lists the takes of the selected segment; each can be auditioned (button or keys 1-9) and "Dùng take này"
// makes it the selected one. Tauri is mocked; the takes are real WAVs with different lengths and levels, so the waveform differs per take.
const tone=(seconds:number,level:number)=>{const rate=8000,n=rate*seconds,b=Buffer.alloc(44+n*2);b.write('RIFF',0);b.writeUInt32LE(36+n*2,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(rate,24);b.writeUInt32LE(rate*2,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(n*2,40);for(let i=0;i<n;i++)b.writeInt16LE(Math.round(Math.sin(i/rate*2*Math.PI*440)*32000*level),44+i*2);return b;};
// Take 1: 4 s, speech 0.5-3.5 s, level .3 (bars about 27 %).  Take 2: 6 s, speech 1-5 s, level .9 (81 %).  Take 3: 2 s, level .6 (54 %).
const FILES:Record<string,Buffer>={'/t1.wav':tone(4,.3),'/t2.wav':tone(6,.9),'/t3.wav':tone(2,.6)};
const mock=(o:{count:number;selected:string|null;fadeIn:number})=>{
 const w=window as any;w.isTauri=true;w.__starts=[];w.__keys=[];w.__ramps=0;
 const ramp=AudioParam.prototype.linearRampToValueAtTime;AudioParam.prototype.linearRampToValueAtTime=function(this:AudioParam,v:number,t:number){w.__ramps++;return ramp.call(this,v,t);};
 // Every start() of a buffer source, with its offset, the buffer length and when it happened; and when a digit key went down.
 const start=AudioBufferSourceNode.prototype.start;AudioBufferSourceNode.prototype.start=function(this:AudioBufferSourceNode,when?:number,offset?:number,duration?:number){w.__starts.push({offset,duration,len:Math.round(this.buffer!.duration),at:performance.now()});return start.call(this,when,offset,duration);};
 window.addEventListener('keydown',e=>{if(/^[1-9]$/.test(e.key))w.__keys.push({key:e.key,at:performance.now()});},true);
 const all=[{id:'t1',asset_id:'a1',path:'/t1.wav',duration_ms:4000,sample_rate:8000,created_at:'2026-11-22T00:00:00Z',speech_start_ms:500,speech_end_ms:3500,check:{ok:true,issues:[]}},
  {id:'t2',asset_id:'a2',path:'/t2.wav',duration_ms:6000,sample_rate:8000,created_at:'2026-11-22T00:01:00Z',speech_start_ms:1000,speech_end_ms:5000},
  {id:'t3',asset_id:'a3',path:'/t3.wav',duration_ms:2000,sample_rate:8000,created_at:'2026-11-22T00:02:00Z'}].slice(0,o.count);
 const seg={id:'1',text:'Xin chào.',normalized_text:'Xin chào.',voice_id:null,speaker:'Người dẫn',gap_ms:300,takes:all,selected_take_id:o.selected,trim_start_ms:500,trim_end_ms:3500,fade_in_ms:o.fadeIn,fade_out_ms:0,gain_db:0};
 let project:any={id:'p1',name:'So sánh',updated_at:'2026-11-22T00:00:00Z',revision:1,segments:[seg],transcript:[],dictionary:{},source_asset_id:null};
 w.__TAURI_INTERNALS__={convertFileSrc:(p:string)=>p,transformCallback:()=>1,unregisterCallback:()=>{},metadata:{currentWindow:{label:'main'},currentWebview:{label:'main',windowLabel:'main'}},
  invoke:async(cmd:string,args:any)=>{switch(cmd){
   case 'list_projects':return [project];case 'load_project':return JSON.parse(JSON.stringify(project));case 'list_jobs':case 'list_voices':case 'list_models':return [];case 'get_settings':return {dictionary:{}};
   case 'runtime_status':return {python_ready:true,ffmpeg_ready:true,worker_ready:true,python_path:null,ffmpeg_path:null,message:''};
   case 'save_project':project={...args.project,revision:args.project.revision+1};return project;default:return null;}}};
};
const open=async(page:Page,count=3,width=1440,delay:Record<string,number|'abort'>={},extra:{selected?:string|null;fadeIn?:number}={})=>{
 await page.setViewportSize({width,height:900});
 await page.route(/\/t[123]\.wav$/,async r=>{const p=new URL(r.request().url()).pathname;if(delay[p])await new Promise(z=>setTimeout(z,delay[p]==='abort'?500:delay[p] as number));if(delay[p]==='abort')return r.abort();await r.fulfill({body:FILES[p],contentType:'audio/wav'});});
 await page.addInitScript(mock,{count,selected:extra.selected===undefined?'t1':extra.selected,fadeIn:extra.fadeIn??0});await page.goto('/');
 await page.getByRole('button',{name:'Dự án',exact:true}).click();await page.getByRole('button',{name:'Mở dự án',exact:true}).click();
 await page.getByRole('heading',{level:1}).click();
};
const strip=(page:Page)=>page.getByRole('toolbar',{name:'So sánh take'});
const use=(page:Page)=>page.getByRole('button',{name:'Dùng take này'});
const play=(page:Page)=>page.locator('.play-button');
const bars=(page:Page)=>page.locator('.waveform i').evaluateAll(l=>l.map(i=>parseFloat((i as HTMLElement).style.height)));
const loudest=async(page:Page)=>Math.max(...await bars(page));
const starts=(page:Page)=>page.evaluate(()=>(window as any).__starts as {offset:number;duration:number;len:number;at:number}[]);
const trimmed=(page:Page)=>page.locator('.waveform i.trimmed').count();

test('a segment with several takes gets a take strip, and one with a single take does not',async({page})=>{
 await open(page);const t=strip(page);await expect(t.getByRole('button')).toHaveCount(3);
 await expect(t.getByRole('button').nth(0)).toContainText(/^Take 1 · 4,0 giây/);await expect(t.getByRole('button').nth(1)).toContainText(/^Take 2 · 6,0 giây/);
 for(const [i,pressed] of ['true','false','false'].entries())await expect(t.getByRole('button').nth(i)).toHaveAttribute('aria-pressed',pressed);
 await expect(t.getByText('Đang dùng')).toHaveCount(1);await expect(t.getByRole('button').nth(0).getByText('Đang dùng')).toBeVisible();
 await expect(use(page)).toHaveCount(0);
});
test('a segment with one take shows no strip',async({page})=>{await open(page,1);await expect(page.locator('.audio-dock')).toBeVisible();await expect(strip(page)).toHaveCount(0);});

test('the strip is a toolbar: arrows move focus only, Enter auditions, and Tab leaves it',async({page})=>{
 await open(page);const b=strip(page).getByRole('button');
 await b.nth(0).focus();await page.keyboard.press('ArrowRight');await expect(b.nth(1)).toBeFocused();await expect(play(page)).toHaveAccessibleName('Nghe thử đoạn');await expect(b.nth(1)).toHaveAttribute('aria-pressed','false');
 await page.keyboard.press('End');await expect(b.nth(2)).toBeFocused();await page.keyboard.press('ArrowRight');await expect(b.nth(0)).toBeFocused();await page.keyboard.press('ArrowLeft');await expect(b.nth(2)).toBeFocused();await page.keyboard.press('Home');await expect(b.nth(0)).toBeFocused();
 await page.keyboard.press('ArrowRight');await page.keyboard.press('Enter');await expect(b.nth(1)).toHaveAttribute('aria-pressed','true');await expect(play(page)).toHaveAccessibleName('Dừng nghe thử');
 await expect(b.nth(0)).toHaveAttribute('tabindex','-1');await expect(b.nth(1)).toHaveAttribute('tabindex','0');
 await page.keyboard.press('Tab');expect(await page.evaluate(()=>!!document.activeElement?.closest('[role=toolbar]'))).toBe(false); // one tab stop: Tab leaves the strip
});

test('pressing 2 while take 1 plays keeps playing, shows take 2 and resumes at the same distance into the speech',async({page})=>{
 await open(page);await page.keyboard.press('Space');await expect(play(page)).toHaveAccessibleName('Dừng nghe thử');await expect.poll(()=>starts(page).then(s=>s.length)).toBe(1);
 expect(await loudest(page)).toBeLessThan(30);const first=(await starts(page))[0];expect(first.offset).toBeCloseTo(.5,2);
 await page.waitForTimeout(800);await page.keyboard.press('2');
 await expect.poll(()=>starts(page).then(s=>s.length)).toBe(2);await expect(play(page)).toHaveAccessibleName('Dừng nghe thử');
 await expect.poll(()=>loudest(page)).toBeGreaterThan(75);
 const [a,b]=await starts(page),key=(await page.evaluate(()=>(window as any).__keys as {at:number}[]))[0];
 // Take 2's speech starts at 1.0 s; the same distance into it as the key press was into take 1's speech.
 expect(Math.abs(b.offset-(1+(key.at-a.at)/1000))).toBeLessThan(.05);expect(b.len).toBe(6);expect(b.duration).toBeCloseTo(4-(b.offset-1),1);
 await expect(strip(page).getByRole('button').nth(1)).toHaveAttribute('aria-pressed','true');await expect(page.locator('.audio-control strong')).toHaveText('Take 2');
 await page.keyboard.press('Space');await expect(play(page)).toHaveAccessibleName('Nghe thử đoạn');await page.waitForTimeout(400);expect((await starts(page)).length).toBe(2);
});

test('the trimmed bars follow the auditioned take own trim window',async({page})=>{
 await open(page);await page.keyboard.press('Space');await expect.poll(()=>loudest(page)).toBeLessThan(30);
 const n1=await trimmed(page);expect(Math.abs(n1-25)).toBeLessThanOrEqual(3); // 0.5 s off each end of 4 s
 await page.keyboard.press('2');await expect.poll(()=>loudest(page)).toBeGreaterThan(75);
 const n2=await trimmed(page);expect(Math.abs(n2-33)).toBeLessThanOrEqual(3); // 1 s off each end of 6 s
 await page.keyboard.press('3');await expect.poll(()=>loudest(page)).toBeGreaterThan(50);expect(await trimmed(page)).toBe(0); // take 3 has no speech window
});

test('a late load never starts after a newer press: 2 then 3 starts only take 3',async({page})=>{
 await open(page,3,1440,{'/t2.wav':500});await page.keyboard.press('2');await page.keyboard.press('3');
 await expect.poll(()=>starts(page).then(s=>s.length)).toBe(1);await page.waitForTimeout(900);
 const s=await starts(page);expect(s.length).toBe(1);expect(s[0].len).toBe(2);
 await expect.poll(()=>loudest(page)).toBeGreaterThan(50);expect(await loudest(page)).toBeLessThan(60); // take 3 level, not overwritten by take 2's late peaks
 await expect(page.locator('.audio-control strong')).toHaveText('Take 3');
});

test('Space then Space again before the take loads starts nothing and leaves the dock idle',async({page})=>{
 await open(page,3,1440,{'/t1.wav':500});await page.keyboard.press('Space');await expect(play(page)).toHaveAccessibleName('Dừng nghe thử');
 await page.keyboard.press('Space');await expect(play(page)).toHaveAccessibleName('Nghe thử đoạn');
 await page.waitForTimeout(1000);expect((await starts(page)).length).toBe(0);await expect(play(page)).toHaveAccessibleName('Nghe thử đoạn');
});

test('a replaced take does not flip the dock back to idle when its source ends',async({page})=>{
 await open(page);await page.keyboard.press('3');await expect(play(page)).toHaveAccessibleName('Dừng nghe thử');
 await page.keyboard.press('2');await page.waitForTimeout(2600); // take 3 would have ended after 2 s
 await expect(play(page)).toHaveAccessibleName('Dừng nghe thử');
});

test('digit keys are ignored while typing and under a dialog, and "2" in the editor types 2',async({page})=>{
 await open(page);const box=page.getByRole('textbox',{name:'Nội dung đoạn 1'});await box.click();await page.keyboard.press('End');await page.keyboard.press('2');
 await expect(box).toHaveValue('Xin chào.2');expect((await starts(page)).length).toBe(0);await expect(play(page)).toHaveAccessibleName('Nghe thử đoạn');
 await page.keyboard.press('Control+k');await expect(page.locator('[aria-modal="true"]')).toBeVisible();await page.keyboard.press('Escape');
 await page.getByRole('heading',{level:1}).click();await page.evaluate(()=>{const d=document.createElement('div');d.setAttribute('aria-modal','true');document.body.append(d);});
 await page.keyboard.press('2');await page.waitForTimeout(300);expect((await starts(page)).length).toBe(0);
 await page.evaluate(()=>document.querySelector('body>div[aria-modal]')!.remove());
 await page.keyboard.press('9');await page.waitForTimeout(200);expect((await starts(page)).length).toBe(0); // there is no ninth take
 await page.keyboard.down('2');await expect.poll(()=>starts(page).then(s=>s.length)).toBe(1);await page.keyboard.down('2');await page.waitForTimeout(300);expect((await starts(page)).length).toBe(1);await page.keyboard.up('2'); // a held key auditions once
});

test('"Dùng take này" selects the auditioned take with its own trim, and Ctrl+Z restores the previous one',async({page})=>{
 await open(page);const pick=page.getByRole('combobox',{name:'Take đang sử dụng'}),start=page.getByRole('spinbutton',{name:'Cắt đầu (ms)'}),end=page.getByRole('spinbutton',{name:'Cắt cuối (ms)'});
 await expect(pick).toHaveValue('t1');await expect(start).toHaveValue('500');
 await strip(page).getByRole('button').nth(1).click();await expect(use(page)).toBeVisible();
 await expect(pick).toHaveValue('t1'); // auditioning alone changes nothing in the project
 await use(page).click();
 await expect(pick).toHaveValue('t2');await expect(start).toHaveValue('1000');await expect(end).toHaveValue('5000');
 await expect(strip(page).getByRole('button').nth(1).getByText('Đang dùng')).toBeVisible();await expect(use(page)).toHaveCount(0);
 await page.getByRole('heading',{level:1}).click();await page.keyboard.press('Control+z');
 await expect(pick).toHaveValue('t1');await expect(start).toHaveValue('500');await expect(end).toHaveValue('3500');
});

test('the inspector select still picks a take through the same path',async({page})=>{
 await open(page);const pick=page.getByRole('combobox',{name:'Take đang sử dụng'});await pick.selectOption('t3');
 await expect(strip(page).getByRole('button').nth(2).getByText('Đang dùng')).toBeVisible();await expect(page.getByRole('spinbutton',{name:'Cắt đầu (ms)'})).toHaveValue('0');
});

for(const width of [1440,800,640])test(`the dock fits at ${width} px: no sideways scroll and every control stays inside it`,async({page})=>{
 await open(page,3,width);await expect(strip(page)).toBeVisible();await strip(page).getByRole('button').nth(1).click();await expect(use(page)).toBeVisible();
 const m=await page.evaluate(()=>{const dock=document.querySelector('.audio-dock')!.getBoundingClientRect(),el=document.documentElement;
  const right=Math.max(...[...document.querySelectorAll('.audio-dock button,.audio-dock select')].map(b=>b.getBoundingClientRect().right));
  return {over:el.scrollWidth-el.clientWidth,right,dockRight:dock.right,height:dock.height};});
 expect(m.over).toBeLessThanOrEqual(0);expect(m.right).toBeLessThanOrEqual(m.dockRight+0.5);
 if(width===1440)expect(m.height).toBeLessThanOrEqual(96);
});

test('a superseded load that fails neither stops the dock nor raises an alert',async({page})=>{
 await open(page,3,1440,{'/t2.wav':'abort'});await page.keyboard.press('2');await page.keyboard.press('3');
 await expect.poll(()=>starts(page).then(s=>s.length)).toBe(1);await page.waitForTimeout(900);
 await expect(play(page)).toHaveAccessibleName('Dừng nghe thử');await expect(page.locator('.alert.error')).toHaveCount(0);expect((await starts(page)).length).toBe(1);
});

test('choosing a take in the inspector drops the audition: the strip, the dock and Space follow the chosen take',async({page})=>{
 await open(page);await strip(page).getByRole('button').nth(1).click();await expect(play(page)).toHaveAccessibleName('Dừng nghe thử');await page.getByRole('heading',{level:1}).click();await page.keyboard.press('Space');await expect(play(page)).toHaveAccessibleName('Nghe thử đoạn'); // focus off the strip button, where Space would press it
 await page.getByRole('combobox',{name:'Take đang sử dụng'}).selectOption('t3');
 await expect(strip(page).getByRole('button').nth(2)).toHaveAttribute('aria-pressed','true');await expect(strip(page).getByRole('button').nth(1)).toHaveAttribute('aria-pressed','false');
 await expect(use(page)).toHaveCount(0);await expect(page.locator('.audio-control strong')).toHaveText('Take 3');
 await page.getByRole('heading',{level:1}).click();await page.keyboard.press('Space');await expect.poll(()=>starts(page).then(s=>s.length)).toBeGreaterThan(1);expect((await starts(page)).at(-1)!.len).toBe(2);
 await page.keyboard.press('Space');await page.getByRole('heading',{level:1}).click();await page.keyboard.press('Control+z');await expect(page.locator('.audio-control strong')).toHaveText('Take 1');await expect(strip(page).getByRole('button').nth(0)).toHaveAttribute('aria-pressed','true');
});

test('focus lands on the newly chosen take button after "Dùng take này"',async({page})=>{
 await open(page);await strip(page).getByRole('button').nth(1).click();await use(page).focus();await page.keyboard.press('Enter');
 await expect(strip(page).getByRole('button').nth(1)).toBeFocused();await expect(use(page)).toHaveCount(0);
});

test('the strip has a tab stop even when the segment has no selected take',async({page})=>{
 await open(page,3,1440,{},{selected:null});const b=strip(page).getByRole('button');await expect(b).toHaveCount(3);
 await expect(b.nth(0)).toHaveAttribute('tabindex','0');await expect(b.nth(1)).toHaveAttribute('tabindex','-1');
 await b.nth(0).focus();await page.keyboard.press('Tab');expect(await page.evaluate(()=>!!document.activeElement?.closest('[role=toolbar]'))).toBe(false);
});

test('a second switch keeps the place in the speech, also while the first is still loading',async({page})=>{
 await open(page,3,1440,{'/t2.wav':400});await page.keyboard.press('Space');await expect.poll(()=>starts(page).then(s=>s.length)).toBe(1);
 await page.waitForTimeout(300);await page.keyboard.press('2');await page.waitForTimeout(100);await page.keyboard.press('3');
 await expect.poll(()=>starts(page).then(s=>s.length)).toBe(2);
 const [a,b]=await starts(page),k=await page.evaluate(()=>(window as any).__keys as {at:number}[]);
 // Take 1's speech starts at 0.5 s and take 3 has no speech window, so the offset into take 3 is the time listened to take 1's speech.
 expect(b.len).toBe(2);expect(Math.abs(b.offset-(k[1].at-a.at)/1000)).toBeLessThan(.05);
});
test('switching 1, 2, 3 after each load keeps the same distance into the speech',async({page})=>{
 await open(page);await page.keyboard.press('Space');await expect.poll(()=>starts(page).then(s=>s.length)).toBe(1);
 await page.waitForTimeout(500);await page.keyboard.press('2');await expect.poll(()=>starts(page).then(s=>s.length)).toBe(2);
 await page.waitForTimeout(500);await page.keyboard.press('3');await expect.poll(()=>starts(page).then(s=>s.length)).toBe(3);
 const [,b,c]=await starts(page),k=await page.evaluate(()=>(window as any).__keys as {at:number}[]);
 expect(Math.abs(c.offset-((b.offset-1)+(k[1].at-b.at)/1000))).toBeLessThan(.05);
});

test('resuming in the middle of a take adds no fade-in',async({page})=>{
 await open(page,3,1440,{},{fadeIn:200});await page.keyboard.press('Space');await expect.poll(()=>starts(page).then(s=>s.length)).toBe(1);
 const ramps=()=>page.evaluate(()=>(window as any).__ramps as number);expect(await ramps()).toBe(1);
 await page.waitForTimeout(600);await page.keyboard.press('2');await expect.poll(()=>starts(page).then(s=>s.length)).toBe(2);expect(await ramps()).toBe(1);
});

test('digit keys do nothing on the transcript page',async({page})=>{
 await open(page);await page.getByRole('button',{name:'Chép lời',exact:true}).click();await page.keyboard.press('2');await page.waitForTimeout(400);expect((await starts(page)).length).toBe(0);
});
