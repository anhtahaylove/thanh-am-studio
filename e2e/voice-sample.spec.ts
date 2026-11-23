import {test,expect,type Page} from '@playwright/test';
import {readFileSync} from 'node:fs';
// "Phân vai" voice samples play up to 3 s of audio that already exists: a take made with that voice here, a take of another project for a preset
// (its asset looked up with get_asset, the next one when that fails), or the voice's own recording. Nothing is enqueued. Tauri is mocked; every
// .wav is a real 8 s tone served with range support. Spies record what the sample's detached <audio> plays, seeks to and pauses at, and the dock's
// AudioBufferSourceNode start() and stop().
const tone=()=>{const rate=8000,n=rate*8,b=Buffer.alloc(44+n*2);b.write('RIFF',0);b.writeUInt32LE(36+n*2,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(rate,24);b.writeUInt32LE(rate*2,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(n*2,40);for(let i=0;i<n;i++)b.writeInt16LE(Math.round(Math.sin(2*Math.PI*440*i/rate)*3000),44+i*2);return b;};
const mock=(o:{broken:string[]})=>{
 const w=window as any;w.isTauri=true;w.__calls=[];w.__dock=[];w.__voice={played:[],seeks:[],paused:[]};
 const P=HTMLMediaElement.prototype,play=P.play,pause=P.pause,time=Object.getOwnPropertyDescriptor(P,'currentTime')!;
 P.play=function(this:HTMLMediaElement){if(!this.isConnected)w.__voice.played.push(this.src);return play.call(this);};
 P.pause=function(this:HTMLMediaElement){if(!this.isConnected&&!this.paused)w.__voice.paused.push(this.currentTime);return pause.call(this);};
 Object.defineProperty(P,'currentTime',{...time,set(this:HTMLMediaElement,v:number){if(!this.isConnected)w.__voice.seeks.push(v);time.set!.call(this,v);}});
 const start=AudioBufferSourceNode.prototype.start,stop=AudioBufferSourceNode.prototype.stop;
 AudioBufferSourceNode.prototype.start=function(this:AudioBufferSourceNode,...a:any[]){w.__dock.push('start');return (start as any).apply(this,a);};
 AudioBufferSourceNode.prototype.stop=function(this:AudioBufferSourceNode,...a:any[]){w.__dock.push('stop');return (stop as any).apply(this,a);};
 const seg=(id:string,speaker:string,voice:string|null,takes:any[]=[])=>({id,text:`Câu của ${speaker}.`,normalized_text:`Câu của ${speaker}.`,voice_id:voice,speaker,gap_ms:300,takes,selected_take_id:takes[0]?.id??null,trim_start_ms:0,trim_end_ms:null,fade_in_ms:0,fade_out_ms:0,gain_db:0});
 // Người dẫn: the default voice, with a take here that starts speaking at 1.2 s. Bà Tư: a preset used only in "Làng chài". Cậu Hai: a preset never
 // used. Cô giáo: two voices.
 const project={id:'p1',name:'Dự án một',updated_at:'2026-11-22T00:00:00Z',revision:1,transcript:[],dictionary:{},source_asset_id:null,segments:[
  seg('s1','Người dẫn',null,[{id:'t1',asset_id:'a1',path:'/takes/a1.wav',duration_ms:8000,sample_rate:8000,created_at:'2026-11-22T00:00:00Z',speech_start_ms:1200}]),
  seg('s2','Bà Tư','v-north'),seg('s3','Cậu Hai','v-south'),seg('s4','Cô giáo','v-north'),seg('s5','Cô giáo',null)]};
 const projects=[{id:'p1',name:'Dự án một',updated_at:project.updated_at,revision:1},{id:'p2',name:'Làng chài',updated_at:'2026-11-21T00:00:00Z',revision:3}];
 const voices=[{id:'v-north',name:'Bắc nữ',kind:'preset',reference_asset_id:null,consent:false,engine_voice_id:'north'},{id:'v-south',name:'Nam trầm',kind:'preset',reference_asset_id:null,consent:false,engine_voice_id:'south'}];
 const tts=(id:string,p:string,voice:string|null,asset:string,speech:number,at:string)=>({id,kind:'tts',project_id:p,payload:{segment_id:'x',text:'x',voice_id:voice,reference_asset_id:null},status:'succeeded',progress:1,error:null,result:{asset_id:asset,path:`/takes/${asset}.wav`,speech_start_ms:speech},created_at:at,updated_at:at});
 const jobs=[tts('j3','p2','v-north','b-new',300,'2026-11-21T12:00:00Z'),tts('j2','p2','v-north','b-old',500,'2026-11-20T12:00:00Z'),tts('j1','p1',null,'a1',1200,'2026-11-19T12:00:00Z')]; // newest first, as list_jobs answers
 w.__TAURI_INTERNALS__={convertFileSrc:(p:string)=>p,transformCallback:()=>1,unregisterCallback:()=>{},metadata:{currentWindow:{label:'main'},currentWebview:{label:'main',windowLabel:'main'}},
  invoke:async(cmd:string,args:any)=>{w.__calls.push({cmd,args});const ipc=(v:unknown)=>JSON.parse(JSON.stringify(v));switch(cmd){
   case 'list_projects':return ipc(projects);case 'load_project':return ipc(project);case 'list_voices':return ipc(voices);case 'list_jobs':return ipc(jobs);
   case 'list_models':return [];case 'get_settings':return {dictionary:{}};
   case 'runtime_status':return {python_ready:true,ffmpeg_ready:true,worker_ready:true,python_path:null,ffmpeg_path:null,message:''};
   case 'get_asset':if(o.broken.includes(args.id))throw 'ASSET_NOT_FOUND: asset missing';return {id:args.id,path:`/assets/${args.id}.wav`,name:args.id,duration_ms:8000,sample_rate:8000};
   case 'save_project':return {...ipc(args.project),revision:args.project.revision+1};
   default:return null;}}};
};
const open=async(page:Page,o:{broken?:string[]}={})=>{
 const wav=tone();
 await page.route('**/*.wav',r=>{const m=/bytes=(\d+)-(\d*)/.exec(r.request().headers().range??'');if(!m)return r.fulfill({body:wav,headers:{'content-type':'audio/wav','accept-ranges':'bytes'}});const a=Number(m[1]),z=m[2]?Number(m[2]):wav.length-1;return r.fulfill({status:206,body:wav.subarray(a,z+1),headers:{'content-type':'audio/wav','accept-ranges':'bytes','content-range':`bytes ${a}-${z}/${wav.length}`}});});
 await page.addInitScript(mock,{broken:o.broken??[]});await page.goto('/');
 await page.getByRole('button',{name:'Dự án',exact:true}).click();await page.getByRole('button',{name:'Mở dự án',exact:true}).first().click();
 await expect(page.getByRole('textbox',{name:'Nội dung đoạn 1',exact:true})).toBeVisible();
};
const voice=(page:Page)=>page.evaluate(()=>(window as any).__voice as {played:string[];seeks:number[];paused:number[]});
const calls=(page:Page,cmd:string)=>page.evaluate(c=>((window as any).__calls as {cmd:string;args:any}[]).filter(x=>x.cmd===c).map(x=>x.args),cmd);
const sampleButton=(page:Page,name:string)=>page.getByRole('button',{name:new RegExp(`^(Nghe|Dừng) mẫu giọng của ${name}$`)});

test('the default voice plays its take here from the speech start, pauses after 3 s and enqueues nothing',async({page})=>{
 await open(page);
 const button=sampleButton(page,'Người dẫn');
 await expect(button).toHaveAccessibleName('Nghe mẫu giọng của Người dẫn');await expect(button).toHaveAttribute('aria-pressed','false');
 await expect(button).toHaveAttribute('title','Phát 3 giây từ take 1 của đoạn 1');
 await button.click();
 await expect(button).toHaveAccessibleName('Dừng mẫu giọng của Người dẫn');await expect(button).toHaveAttribute('aria-pressed','true');
 const v=await voice(page);expect(v.played).toHaveLength(1);expect(v.played[0]).toMatch(/\/takes\/a1\.wav$/);expect(v.seeks).toEqual([1.2]);
 await expect.poll(async()=>(await voice(page)).paused.length,{timeout:6000}).toBe(1);
 const at=(await voice(page)).paused[0]-1.2;
 expect(at,'seconds played before the pause').toBeGreaterThanOrEqual(2.9);expect(at,'seconds played before the pause').toBeLessThanOrEqual(3.3);
 await expect(button).toHaveAccessibleName('Nghe mẫu giọng của Người dẫn');await expect(button).toHaveAttribute('aria-pressed','false');
 expect(await calls(page,'enqueue_job')).toEqual([]);expect(await calls(page,'get_asset')).toEqual([]);
});

test('pressing the playing sample again stops it at once',async({page})=>{
 await open(page);
 const button=sampleButton(page,'Người dẫn');
 await button.click();await expect.poll(async()=>(await voice(page)).played.length).toBe(1);
 await page.waitForTimeout(500);await button.click();
 await expect(button).toHaveAccessibleName('Nghe mẫu giọng của Người dẫn');
 const v=await voice(page);expect(v.paused).toHaveLength(1);expect(v.paused[0]-1.2).toBeLessThan(1.5);expect(v.played).toHaveLength(1);
});

test('a preset used only in another project plays that take after get_asset, and its title names the project and the date',async({page})=>{
 await open(page);
 const button=sampleButton(page,'Bà Tư');
 await expect(button).toHaveAttribute('title','Phát 3 giây từ một take của dự án Làng chài (21/11/2026)');
 await button.click();
 await expect.poll(async()=>(await voice(page)).played).toEqual([expect.stringMatching(/\/assets\/b-new\.wav$/)]);
 expect(await calls(page,'get_asset')).toEqual([{id:'b-new'}]);expect((await voice(page)).seeks).toEqual([0.3]);
 expect(await calls(page,'enqueue_job')).toEqual([]);
});

test('when get_asset fails for the newest take of another project, the next one plays',async({page})=>{
 await open(page,{broken:['b-new']});
 await sampleButton(page,'Bà Tư').click();
 await expect.poll(async()=>(await voice(page)).played).toEqual([expect.stringMatching(/\/assets\/b-old\.wav$/)]);
 expect(await calls(page,'get_asset')).toEqual([{id:'b-new'},{id:'b-old'}]);expect((await voice(page)).seeks).toEqual([0.5]);
 await expect(page.getByRole('alert')).toHaveCount(0);
});

test('a blocked sample says why in its accessible description and plays nothing',async({page})=>{
 await open(page);
 for(const [name,why] of [['Cậu Hai','Chưa có take nào tạo bằng giọng này: tạo giọng một đoạn trước.'],['Cô giáo','Các đoạn của nhân vật này đang dùng nhiều giọng khác nhau.']]){
  const button=sampleButton(page,name);
  await expect(button).toHaveAttribute('aria-disabled','true');await expect(button).toHaveAccessibleDescription(why);
  await button.click({force:true});await button.focus();await page.keyboard.press('Enter'); // force: Playwright waits for aria-disabled controls to enable
  await expect(button).toHaveAccessibleName(`Nghe mẫu giọng của ${name}`);
 }
 expect((await voice(page)).played).toEqual([]);expect(await calls(page,'get_asset')).toEqual([]);
});

test('Space on the dock pauses the sample, and the sample stops the dock',async({page})=>{
 await open(page);
 const button=sampleButton(page,'Người dẫn'),dock=page.locator('.play-button');
 await button.click();await expect(button).toHaveAccessibleName('Dừng mẫu giọng của Người dẫn');
 await page.getByRole('heading',{level:1}).click(); // Space on a button presses it, so the dock's Space needs focus elsewhere
 await page.keyboard.press('Space');
 await expect(dock).toHaveAccessibleName('Dừng nghe thử');await expect.poll(()=>page.evaluate(()=>(window as any).__dock)).toEqual(['start']);
 await expect(button).toHaveAccessibleName('Nghe mẫu giọng của Người dẫn');expect((await voice(page)).paused).toHaveLength(1);
 await button.click();
 await expect(dock).toHaveAccessibleName('Nghe thử đoạn');await expect.poll(()=>page.evaluate(()=>(window as any).__dock)).toEqual(['start','stop']);
 await expect(button).toHaveAccessibleName('Dừng mẫu giọng của Người dẫn');await expect.poll(async()=>(await voice(page)).played.length).toBe(2);
});

test('selecting another segment keeps the sample, switching page stops it',async({page})=>{
 await open(page);
 const button=sampleButton(page,'Người dẫn');
 await button.click();await expect(button).toHaveAccessibleName('Dừng mẫu giọng của Người dẫn');
 await page.locator('article.segment').nth(1).click();await expect(page.locator('article.segment').nth(1)).toHaveClass(/selected/);
 await expect(button).toHaveAccessibleName('Dừng mẫu giọng của Người dẫn');expect((await voice(page)).paused).toEqual([]);
 await page.getByRole('navigation',{name:'Điều hướng chính'}).getByRole('button',{name:'Thư viện giọng'}).click();
 await expect.poll(async()=>(await voice(page)).paused.length).toBe(1);expect((await voice(page)).paused[0]-1.2,'stopped by the page switch, not after 3 s').toBeLessThan(2.5);
 await page.getByRole('navigation',{name:'Điều hướng chính'}).getByRole('button',{name:'Tạo giọng đọc'}).click();
 await expect(button).toHaveAccessibleName('Nghe mẫu giọng của Người dẫn');await expect(button).toHaveAttribute('aria-pressed','false');
});

test('when no asset of the sample can be found, the error says so in Vietnamese, not with the backend code',async({page})=>{
 await open(page,{broken:['b-new','b-old']});
 const button=sampleButton(page,'Bà Tư');
 await button.click();
 await expect(page.getByRole('alert')).toContainText('Không phát được audio này: tệp không còn hoặc định dạng không được hỗ trợ.');
 await expect(page.getByRole('alert')).not.toContainText('ASSET_NOT_FOUND');
 await expect(button).toHaveAccessibleName('Nghe mẫu giọng của Bà Tư');
 expect(await calls(page,'get_asset')).toEqual([{id:'b-new'},{id:'b-old'}]);expect((await voice(page)).played).toEqual([]);
});

// B1's bubble on a blocked "Phân vai" button, in the browser preview (where samples need the desktop app). Helpers copied from blocked-feedback.spec.ts.
const FIXTURE=JSON.parse(readFileSync('e2e/fixtures/script-12.json','utf8'));
const settle=(page:Page)=>page.evaluate(()=>new Promise<void>(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r()))));
const ratio=(a:string,b:string)=>{const lum=(c:string)=>{const [r,g,b]=c.match(/[\d.]+/g)!.slice(0,3).map(v=>{const x=Number(v)/255;return x<=0.03928?x/12.92:((x+0.055)/1.055)**2.4;});return 0.2126*r+0.7152*g+0.0722*b;};const [x,y]=[lum(a),lum(b)].sort((p,q)=>q-p);return (x+0.05)/(y+0.05);};
const measure=(page:Page)=>page.evaluate(()=>{
 const b=document.querySelector<HTMLElement>('.reason-bubble');if(!b)return null;
 const r=b.getBoundingClientRect(),f=document.activeElement!.getBoundingClientRect(),vw=document.documentElement.clientWidth,vh=document.documentElement.clientHeight,s=getComputedStyle(b);
 let opacity=1;for(let e:Element|null=b;e;e=e.parentElement)opacity*=Number(getComputedStyle(e).opacity);
 b.style.pointerEvents='auto';const topmost=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)===b;b.style.pointerEvents=''; // the bubble lets clicks through, so it is hit-testable just for this check
 return {text:b.textContent,visible:s.visibility!=='hidden'&&r.width>0&&r.height>0,inside:r.left>=0&&r.top>=0&&r.right<=vw&&r.bottom<=vh,topmost,overlaps:r.left<f.right&&f.left<r.right&&r.top<f.bottom&&f.top<r.bottom,fg:s.color,bg:s.backgroundColor,page:getComputedStyle(document.documentElement).backgroundColor,opacity};
});
const drawn=(m:{fg:string;bg:string;page:string;opacity:number})=>{
 const rgba=(c:string)=>{const [r,g,b,a=1]=c.match(/[\d.]+/g)!.map(Number);return {c:[r,g,b],a};},over=(top:number[],under:number[],a:number)=>top.map((v,i)=>v*a+under[i]*(1-a));
 const page=rgba(m.page).c,bg=over(rgba(m.bg).c,page,rgba(m.bg).a),fg=over(rgba(m.fg).c,bg,rgba(m.fg).a);
 return [over(fg,page,m.opacity),over(bg,page,m.opacity)].map(c=>`rgb(${c.join(',')})`) as [string,string];
};
for(const theme of ['light','dark'] as const)test(`a focused blocked "Phân vai" sample shows its reason in a readable bubble, ${theme}`,async({page})=>{
 await page.goto('/');await page.evaluate(([p,t])=>{localStorage.setItem('thanh-am-preview-projects-v1',JSON.stringify([p]));localStorage.setItem('thanh-am-theme',t);},[FIXTURE,theme] as const);await page.reload();
 await page.getByRole('button',{name:'Dự án',exact:true}).click();await page.getByRole('button',{name:'Mở dự án',exact:true}).click();
 const button=sampleButton(page,'Cô giáo'),why='Cần bản desktop để nghe mẫu giọng';
 await expect(button).toHaveAttribute('aria-disabled','true');await expect(button).toHaveAccessibleDescription(why);
 await button.focus();await settle(page);
 const m=await measure(page);
 expect(m,'a bubble').not.toBeNull();
 expect(m!).toMatchObject({text:why,visible:true,inside:true,topmost:true,overlaps:false});
 expect(ratio(...drawn(m!)),`contrast of ${m!.fg} on ${m!.bg} at opacity ${m!.opacity}`).toBeGreaterThanOrEqual(4.5);
});

test('the "Phân vai" rows do not scroll sideways at 1024 and 1440 px',async({page})=>{
 await open(page);
 for(const width of [1024,1440]){
  await page.setViewportSize({width,height:720});await settle(page);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth),`${width} px`).toBe(true);
  const box=await sampleButton(page,'Người dẫn').boundingBox(),select=await page.getByRole('combobox',{name:'Giọng của Người dẫn'}).boundingBox();
  expect(box!.width,`${width} px: target width`).toBeGreaterThanOrEqual(24);expect(box!.height,`${width} px: target height`).toBeGreaterThanOrEqual(24);
  expect(Math.abs(box!.y+box!.height/2-(select!.y+select!.height/2)),`${width} px: centred on its select`).toBeLessThanOrEqual(3);
 }
});
