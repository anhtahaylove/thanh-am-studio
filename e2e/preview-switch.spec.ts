import {test,expect,type Page} from '@playwright/test';
// A take preview stops when the selected segment or the open project changes (the audition and the waveform reset with it).
// Tauri is mocked; the take is a real 8 s WAV. A spy on AudioBufferSourceNode records every start() and stop(). The dock draws the shown take's bars
// without Play (A3); segment 2's take and the second project's are a quiet WAV that arrives 1 s late, or when the test releases a hold, so bars seen sooner after a switch would be stale.
const tone=(amp=6000)=>{const rate=8000,n=rate*8,b=Buffer.alloc(44+n*2);b.write('RIFF',0);b.writeUInt32LE(36+n*2,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(rate,24);b.writeUInt32LE(rate*2,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(n*2,40);for(let i=0;i<n;i++)b.writeInt16LE(Math.round(Math.sin(2*Math.PI*440*i/rate)*amp),44+i*2);return b;};
const mock=()=>{
 const w=window as any;w.isTauri=true;w.__ev=[];w.__loads=0;w.__jobs=[];
 const start=AudioBufferSourceNode.prototype.start,stop=AudioBufferSourceNode.prototype.stop;
 AudioBufferSourceNode.prototype.start=function(this:AudioBufferSourceNode,...a:any[]){w.__ev.push('start');return (start as any).apply(this,a);};
 AudioBufferSourceNode.prototype.stop=function(this:AudioBufferSourceNode,...a:any[]){w.__ev.push('stop');return (stop as any).apply(this,a);};
 const take=(id:string,path='/tone.wav')=>({id,asset_id:'a'+id,path,duration_ms:8000,sample_rate:8000,created_at:new Date().toISOString()});
 const seg=(id:string,takes:any[])=>({id,text:'Xin chào '+id+'.',normalized_text:'Xin chào '+id+'.',voice_id:null,speaker:'Người dẫn',gap_ms:300,takes,selected_take_id:takes[0].id,trim_start_ms:0,trim_end_ms:null,fade_in_ms:0,fade_out_ms:0,gain_db:0});
 const make=(id:string,name:string)=>({id,name,updated_at:new Date().toISOString(),revision:1,segments:[seg('1',[take('t1',id==='p2'?'/quiet.wav':'/tone.wav'),take('t1b')]),seg('2',[take('t2','/quiet.wav')])],transcript:[],dictionary:{},source_asset_id:null});
 // The project list is ordered like a real one: p1 first, p2 second. Both projects use segment ids 1 and 2.
 const projects:any[]=[make('p1','Dự án một'),make('p2','Dự án hai')];
 w.__TAURI_INTERNALS__={convertFileSrc:(p:string)=>p,transformCallback:()=>1,unregisterCallback:()=>{},metadata:{currentWindow:{label:'main'},currentWebview:{label:'main',windowLabel:'main'}},
  invoke:async(cmd:string,args:any)=>{switch(cmd){
   case 'list_projects':return projects;case 'load_project':w.__loads++;return JSON.parse(JSON.stringify(projects.find(p=>p.id===args.id)));case 'list_jobs':return JSON.parse(JSON.stringify(w.__jobs));case 'list_voices':case 'list_models':return [];case 'get_settings':return {dictionary:{}};
   case 'runtime_status':return {python_ready:true,ffmpeg_ready:true,worker_ready:true,python_path:null,ffmpeg_path:null,message:''};
   // A finished tts job: p1's segment 1 gets a second take. The app reloads the project when a new succeeded tts job shows up.
   case 'add_take':projects[0].segments[0].takes.push(take('t9'));w.__jobs.push({id:'j1',kind:'tts',project_id:'p1',payload:{segment_id:'1'},status:'succeeded',progress:1,error:null,result:{asset_id:'r1'},created_at:new Date().toISOString(),updated_at:new Date().toISOString()});return null;
   case 'save_project':{const p={...args.project,revision:args.project.revision+1};projects[projects.findIndex(x=>x.id===p.id)]=p;return p;}default:return null;}}};
};
// `hold`: the quiet WAV waits for release() instead of 1 s, so a test can look at the page while it is still missing.
const holdQuiet=()=>{let release=()=>{};const gate=new Promise<void>(r=>{release=r;});return {gate,release};};
const open=async(page:Page,delay:{ms:number}={ms:0},hold?:{gate:Promise<void>}) =>{
 await page.route('**/tone.wav',async r=>{if(delay.ms)await new Promise(z=>setTimeout(z,delay.ms));await r.fulfill({body:tone(),contentType:'audio/wav'});});
 await page.route('**/quiet.wav',async r=>{await (hold?hold.gate:new Promise(z=>setTimeout(z,1000)));await r.fulfill({body:tone(600),contentType:'audio/wav'});});
 await page.addInitScript(mock);await page.goto('/');
 await page.getByRole('button',{name:'Dự án',exact:true}).click();await page.getByRole('button',{name:'Mở dự án',exact:true}).first().click();
 await page.getByRole('heading',{level:1}).click();
};
const play=(page:Page)=>page.locator('.play-button');
const events=(page:Page)=>page.evaluate(()=>(window as any).__ev as string[]);
const bars=(page:Page)=>page.locator('.waveform i').count();

test('selecting another segment stops the playing preview and clears the waveform',async({page})=>{
 const hold=holdQuiet();
 await open(page,{ms:0},hold);
 await page.keyboard.press('Space');await expect(play(page)).toHaveAccessibleName('Dừng nghe thử');
 await expect.poll(()=>bars(page)).toBeGreaterThan(0);
 await expect.poll(()=>events(page)).toEqual(['start']);
 await page.locator('article.segment').nth(1).click();
 await expect(play(page)).toHaveAccessibleName('Nghe thử đoạn');
 expect(await events(page)).toEqual(['start','stop']);
 expect(await bars(page)).toBe(0);
 await page.waitForTimeout(600);
 expect(await events(page)).toEqual(['start','stop']); // nothing started again
 expect(await bars(page),'still none while segment 2\'s take is missing').toBe(0);
 hold.release();await expect.poll(()=>bars(page)).toBe(100);
});

test('a preview still loading when another segment is selected never starts',async({page})=>{
 const delay={ms:1500};
 await open(page,delay);
 await page.keyboard.press('Space');
 await page.locator('article.segment').nth(1).click();
 await page.waitForTimeout(2000);
 expect(await events(page)).not.toContain('start');
 await expect(play(page)).toHaveAccessibleName('Nghe thử đoạn');
});

test('opening another project stops the playing preview',async({page})=>{
 const hold=holdQuiet();
 await open(page,{ms:0},hold);
 await page.keyboard.press('Space');await expect(play(page)).toHaveAccessibleName('Dừng nghe thử');
 await expect.poll(()=>events(page)).toEqual(['start']);
 await page.getByRole('button',{name:'Dự án',exact:true}).click();await page.getByRole('button',{name:'Mở dự án',exact:true}).nth(1).click();
 await expect.poll(()=>page.evaluate(()=>(window as any).__loads)).toBe(2); // the second project was loaded, so the stop is not just the first open
 await expect(play(page)).toHaveAccessibleName('Nghe thử đoạn');
 expect(await events(page)).toEqual(['start','stop']);
 expect(await bars(page)).toBe(0);
 hold.release();await expect.poll(()=>bars(page)).toBe(100); // the second project's own take, once it arrives
});

test('a segment shows only its own take bars: the old ones go at once on a switch and the new take brings its own',async({page})=>{
 const hold=holdQuiet();
 await open(page,{ms:0},hold);
 await expect.poll(()=>bars(page)).toBe(100); // segment 1's take, drawn without Play
 await page.keyboard.press('Space');await expect(play(page)).toHaveAccessibleName('Dừng nghe thử');
 await page.getByRole('button',{name:'Dừng nghe thử'}).click();
 await page.locator('article.segment').nth(1).click();
 await expect(page.locator('.waveform span')).toBeVisible();
 expect(await bars(page)).toBe(0);
 hold.release();await expect.poll(()=>bars(page)).toBe(100);
 expect(await page.locator('.waveform i').evaluateAll(l=>Math.max(...l.map(i=>parseFloat((i as HTMLElement).style.height))))).toBe(3); // the quiet take's bars, not the loud one's
});

test('a new take arriving in the playing segment does not stop the preview',async({page})=>{
 await open(page);
 await page.keyboard.press('Space');await expect(play(page)).toHaveAccessibleName('Dừng nghe thử');
 await page.evaluate(()=>(window as any).__TAURI_INTERNALS__.invoke('add_take'));
 // The poll (2.5 s) sees the job and reloads the project; the tone lasts 8 s.
 await expect.poll(()=>page.evaluate(()=>(window as any).__loads),{timeout:6000}).toBeGreaterThan(1);
 await expect(page.getByRole('toolbar',{name:'So sánh take'})).toBeVisible();
 await expect(play(page)).toHaveAccessibleName('Dừng nghe thử');
 expect(await events(page)).toEqual(['start']);
});

test('switching segments drops the audition: back on segment 1 the dock shows its selected take',async({page})=>{
 await open(page);
 const dockTake=page.locator('.audio-control strong');
 await page.keyboard.press('2');await expect(dockTake).toHaveText('Take 2');
 await page.locator('article.segment').nth(1).click();
 await page.locator('article.segment').nth(0).click();
 await expect(dockTake).toHaveText('Take 1');
 await expect(page.getByRole('button',{name:'Dùng take này'})).toHaveCount(0);
});
