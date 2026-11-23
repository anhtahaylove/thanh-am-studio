import {test,expect,type Locator,type Page} from '@playwright/test';
import {readFileSync} from 'node:fs';
// The script reads like a document: one paragraph per segment with its speaker as a coloured label in the left margin, in the colours the
// transcript and "Phân vai" use for the same name. Tauri is mocked; the script is the 12-segment, 4-speaker fixture (segment 1 is selected when it opens).
const FIXTURE:string=readFileSync('e2e/fixtures/script-12.json','utf8');
// Two diarized speakers, so "Thành kịch bản" adds "Người 1" and "Người 2".
const TRANSCRIPT=[0,1,0,1].map((speaker,i)=>({id:`t${i}`,start_ms:i*4000,end_ms:i*4000+3500,text:`Câu thứ ${i+1} của người nói.`,speaker}));
const mock=(o:{project:string;transcript:unknown[];slots?:Record<string,number>})=>{
 const w=window as any;w.isTauri=true;w.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};
 const project:any={...JSON.parse(o.project),transcript:o.transcript,...o.transcript.length?{source_asset_id:'src'}:{},...o.slots&&{speaker_slots:o.slots}};
 const ipc=(v:unknown)=>JSON.parse(JSON.stringify(v));
 w.__TAURI_INTERNALS__={convertFileSrc:(p:string)=>p,transformCallback:()=>1,unregisterCallback:()=>{},metadata:{currentWindow:{label:'main'},currentWebview:{label:'main',windowLabel:'main'}},
  invoke:async(cmd:string,args:any)=>{switch(cmd){
   case 'list_projects':return [{id:project.id,name:project.name,updated_at:project.updated_at,revision:project.revision}];case 'load_project':return ipc(project);
   case 'list_voices':case 'list_jobs':return [];case 'list_models':return [{id:'vieneu-v3',name:'VieNeu v3 Turbo',engine:'tts',installed:true,revision:'r',license:'Apache-2.0',description:''}];
   case 'get_settings':return {dictionary:{}};case 'runtime_status':return {python_ready:true,ffmpeg_ready:true,worker_ready:true,python_path:null,ffmpeg_path:null,message:''};
   case 'save_project':return {...ipc(args.project),revision:args.project.revision+1};case 'get_asset':return {id:'src',path:'goc.wav',name:'goc.wav',duration_ms:20000,sample_rate:48000};
   default:return null;}}};
};
const open=async(page:Page,o:{width?:number;height?:number;transcript?:unknown[];slots?:Record<string,number>}={})=>{
 await page.setViewportSize({width:o.width??1440,height:o.height??1000});await page.addInitScript(mock,{project:FIXTURE,transcript:o.transcript??[],slots:o.slots});await page.goto('/');
 await page.getByRole('button',{name:'Dự án',exact:true}).click();await page.getByRole('button',{name:'Mở dự án',exact:true}).click();
 await expect(page.getByRole('textbox',{name:'Nội dung đoạn 12',exact:true})).toBeVisible();
};
const ratio=(a:string,b:string)=>{const lum=(c:string)=>{const [r,g,b]=c.match(/[\d.]+/g)!.slice(0,3).map(v=>{const x=Number(v)/255;return x<=0.03928?x/12.92:((x+0.055)/1.055)**2.4;});return 0.2126*r+0.7152*g+0.0722*b;};const [x,y]=[lum(a),lum(b)].sort((p,q)=>q-p);return (x+0.05)/(y+0.05);};
// The colours a speaker is drawn with: its rule (the row's left border), its label text and the label's tint.
const paint=(rule:Locator,label:Locator)=>Promise.all([rule.evaluate(e=>getComputedStyle(e).borderLeftColor),label.evaluate(e=>getComputedStyle(e).color),label.evaluate(e=>getComputedStyle(e).backgroundColor)]);
const segment=(page:Page,speaker:string)=>page.locator('article.segment').filter({has:page.locator(`input[value="${speaker}"]`)}).first();

test('at 1440x1000 at least eight of the twelve segments are fully on screen with the first one at the top',async({page})=>{
 await open(page);
 // PLAN §8: the first segment scrolled to the viewport top, counting segments that lie fully between the viewport top and the dock's top.
 const m=await page.evaluate(()=>{const rows=[...document.querySelectorAll('article.segment')];rows[0].scrollIntoView({block:'start'});const dock=document.querySelector('.audio-dock')!.getBoundingClientRect().top;
  return {shown:rows.filter(r=>{const b=r.getBoundingClientRect();return b.top>=-0.5&&b.bottom<=dock+0.5;}).length,heights:rows.map(r=>Math.round(r.getBoundingClientRect().height))};});
 console.log(`density: ${m.shown} of 12 fully visible, heights ${m.heights.join(',')}`);
 expect(m.shown).toBeGreaterThanOrEqual(8);
});
test('each segment has a 4 px rule and a tinted speaker label in its speaker colour; the same name shares a colour, other names differ',async({page})=>{
 await open(page);
 const narrator=await paint(page.locator('article.segment').nth(0),page.locator('article.segment').nth(0).getByRole('textbox',{name:'Nhân vật đoạn 1',exact:true}));
 expect(await page.locator('article.segment').nth(0).evaluate(e=>getComputedStyle(e).borderLeftWidth)).toBe('4px');
 expect(await paint(page.locator('article.segment').nth(4),page.getByRole('textbox',{name:'Nhân vật đoạn 5',exact:true})),'segment 5 is the narrator too').toEqual(narrator);
 const second=await paint(page.locator('article.segment').nth(1),page.getByRole('textbox',{name:'Nhân vật đoạn 2',exact:true}));
 expect(second[0]).not.toBe(narrator[0]);expect(second[1]).not.toBe(narrator[1]);
 // The label keeps its text: colour is never the only signal.
 await expect(page.getByRole('textbox',{name:'Nhân vật đoạn 2',exact:true})).toHaveValue('Bà Tư');
});
for(const theme of ['light','dark'])test(`speaker labels keep AA contrast on their tint, and the index stays small and muted, in ${theme} mode`,async({page})=>{
 await page.emulateMedia({colorScheme:theme as 'light'|'dark'});await open(page);
 await expect(page.locator('html')).toHaveAttribute('data-theme',theme);
 for(const n of [1,2,3,4]){const [,text,tint]=await paint(page.locator('article.segment').nth(n-1),page.getByRole('textbox',{name:`Nhân vật đoạn ${n}`,exact:true}));expect(tint,`label ${n} is tinted`).not.toMatch(/^rgba\(.*,\s*0\)$|^transparent$/);expect(ratio(text,tint),`label ${n}`).toBeGreaterThanOrEqual(4.5);}
 const index=await page.locator('article.segment').nth(1).locator('.segment-index').evaluate(e=>({size:parseFloat(getComputedStyle(e).fontSize),color:getComputedStyle(e).color}));
 expect(index.size).toBeGreaterThanOrEqual(11);expect(index.size).toBeLessThanOrEqual(12);
 expect(await page.evaluate(c=>{const i=document.createElement('i');i.style.color='var(--muted)';document.body.append(i);const v=getComputedStyle(i).color;i.remove();return v===c;},index.color)).toBe(true);
});
test('"Người 2" has the same colour in the transcript, in the script after "Thành kịch bản" and in "Phân vai"',async({page})=>{
 // "Người N" takes the transcript's slot N-1 only while it is free, so here the script's four named speakers are stored on slots 4-7.
 await open(page,{transcript:TRANSCRIPT,slots:{'Người dẫn':4,'Bà Tư':5,'Cậu Hai':6,'Cô giáo':7}});
 await page.getByRole('button',{name:'Chép lời',exact:true}).click();
 const row=page.locator('.transcript-row').nth(1);await expect(row.locator('select.speaker-chip')).toHaveValue('1');
 const heard=await paint(row,row.locator('select.speaker-chip'));
 await page.getByRole('button',{name:'Thành kịch bản'}).click();
 await expect(page.getByRole('textbox',{name:'Nội dung đoạn 16',exact:true})).toBeVisible();
 const script=segment(page,'Người 2');await expect(script.locator('.speaker-input')).toHaveValue('Người 2');
 expect(await paint(script,script.locator('.speaker-input')),'script').toEqual(heard);
 const cast=page.locator('.speaker-tag',{hasText:/^Người 2$/});
 expect(await cast.evaluate(e=>[getComputedStyle(e).borderLeftColor,getComputedStyle(e).color,getComputedStyle(e).backgroundColor]),'Phân vai').toEqual(heard);
 expect(await cast.evaluate(e=>getComputedStyle(e).borderLeftWidth),'Phân vai rule').toBe('4px');
 expect((await paint(segment(page,'Người 1'),segment(page,'Người 1').locator('.speaker-input')))[0]).not.toBe(heard[0]);
});
// The label is an input: a line under it at rest that thickens on hover and focus (shape, not colour alone), the focus ring kept.
const shadow=(s:string)=>{const m=/^(rgba?\([^)]*\)) (-?[\d.]+)px (-?[\d.]+)px ([\d.]+)px ([\d.]+)px inset$/.exec(s);return m?{color:m[1],x:Number(m[2]),y:Number(m[3]),blur:Number(m[4]),spread:Number(m[5])}:null;};
for(const theme of ['light','dark'])test(`the speaker label reads as an input: a line under it at rest that thickens on hover and focus, in ${theme} mode`,async({page})=>{
 await page.emulateMedia({colorScheme:theme as 'light'|'dark'});await open(page);
 const label=page.getByRole('textbox',{name:'Nhân vật đoạn 2',exact:true});await page.mouse.move(0,0);
 const look=()=>label.evaluate(e=>{const s=getComputedStyle(e);return {shadow:s.boxShadow,text:s.color,tint:s.backgroundColor,outline:`${s.outlineStyle} ${s.outlineWidth}`};});
 const rest=await look(),line=shadow(rest.shadow);
 expect(line,`a line under the label at rest: ${rest.shadow}`).toMatchObject({x:0,blur:0,spread:0});expect(line!.y).toBeLessThan(0);
 expect(line!.color,'in the speaker colour').toBe(rest.text);expect(ratio(line!.color,rest.tint),'3:1 on its tint').toBeGreaterThanOrEqual(3);
 await label.hover();const hover=shadow((await look()).shadow);expect(Math.abs(hover!.y),'thicker on hover').toBeGreaterThan(Math.abs(line!.y));
 await page.mouse.move(0,0);await page.keyboard.press('Tab');await label.focus();const focus=await look();
 expect(Math.abs(shadow(focus.shadow)!.y),'thicker on focus').toBeGreaterThan(Math.abs(line!.y));expect(focus.outline,'the focus ring stays').toBe('solid 2px');
});
test('a long speaker name ends in an ellipsis inside the margin and is told in full by the title',async({page})=>{
 await open(page);const name='Người dẫn chuyện chính của cả làng chài ven sông';
 const label=page.getByRole('textbox',{name:'Nhân vật đoạn 3',exact:true});await label.fill(name);await page.getByRole('textbox',{name:'Nội dung đoạn 3',exact:true}).click();
 const m=await label.evaluate(e=>{const s=getComputedStyle(e),r=e.getBoundingClientRect(),col=e.closest('.segment-label')!.getBoundingClientRect();return {overflow:s.textOverflow,cut:e.scrollWidth>e.clientWidth,inside:r.left>=col.left&&r.right<=col.right+0.5};});
 expect(m).toEqual({overflow:'ellipsis',cut:true,inside:true});await expect(label).toHaveAttribute('title',name);
});
for(const theme of ['light','dark'])test(`an empty speaker name shows "(Chưa đặt tên)" with AA contrast on the tint, and no title, in ${theme} mode`,async({page})=>{
 await page.emulateMedia({colorScheme:theme as 'light'|'dark'});await open(page);
 const label=page.getByRole('textbox',{name:'Nhân vật đoạn 3',exact:true});await label.fill('');
 await expect(label).toHaveAttribute('placeholder','(Chưa đặt tên)');await expect(label).not.toHaveAttribute('title',/.*/);
 const c=await label.evaluate(e=>({hint:getComputedStyle(e,'::placeholder').color,tint:getComputedStyle(e).backgroundColor}));
 expect(c.tint).not.toMatch(/^rgba\(.*,\s*0\)$|^transparent$/);expect(ratio(c.hint,c.tint)).toBeGreaterThanOrEqual(4.5);
});
// Beside the text down to 641 px; at 640 px and below the label goes above it so the text keeps its width.
for(const width of [800,640])test(`the script does not scroll sideways at ${width} px and each label stays inside its segment, ${width>640?'beside':'above'} the text`,async({page})=>{
 await open(page,{width,height:800});
 expect(await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
 const rows=await page.locator('article.segment').evaluateAll(rows=>rows.map(r=>{const b=r.getBoundingClientRect(),l=r.querySelector('.speaker-input')!.getBoundingClientRect(),t=r.querySelector('textarea')!.getBoundingClientRect();
  return {inside:l.left>=b.left&&l.right<=b.right&&t.right<=b.right+0.5,beside:l.right<=t.left&&l.top<t.bottom,above:l.bottom<=t.top,wide:t.width>=b.width*0.85};}));
 expect(rows.filter(r=>!r.inside)).toEqual([]);
 expect(rows.every(r=>width>640?r.beside:r.above&&!r.beside&&r.wide)).toBe(true);
});
// L8: the playing row is a ring in the text colour, so it neither merges with the speaker rule beside it nor looks like a speaker colour.
for(const theme of ['light','dark'])test(`the playing transcript row is marked by a ring, not a second bar beside the speaker rule, in ${theme} mode`,async({page})=>{
 await page.emulateMedia({colorScheme:theme as 'light'|'dark',reducedMotion:'reduce'});await open(page,{transcript:TRANSCRIPT});
 await page.getByRole('button',{name:'Chép lời',exact:true}).click();
 const audio=page.locator('.source-player audio');await expect(audio).toBeAttached();
 // No real playback: the player reports playing at 1 s (row t0, "Người 1", the green slot closest to the old green bar).
 await audio.evaluate((a:HTMLAudioElement)=>{Object.defineProperty(a,'paused',{get:()=>false,configurable:true});Object.defineProperty(a,'currentTime',{get:()=>1,configurable:true});a.dispatchEvent(new Event('timeupdate'));});
 const row=page.locator('.transcript-row[data-row="t0"]');await expect(row).toHaveAttribute('aria-current','true');
 const m=await row.evaluate(e=>{const s=getComputedStyle(e),probe=document.createElement('i');probe.style.color='var(--ink)';document.body.append(probe);const ink=getComputedStyle(probe).color;probe.remove();
  let p=e.parentElement;while(p&&/^rgba\(.*,\s*0\)$|^transparent$/.test(getComputedStyle(p).backgroundColor))p=p.parentElement;
  return {shadow:s.boxShadow,rule:s.borderLeftColor,ink,behind:/^rgba\(.*,\s*0\)$|^transparent$/.test(s.backgroundColor)?getComputedStyle(p??document.documentElement).backgroundColor:s.backgroundColor};});
 const [,color,x,y,blur,spread]=/^(rgba?\([^)]*\)) (-?[\d.]+)px (-?[\d.]+)px ([\d.]+)px ([\d.]+)px inset$/.exec(m.shadow)??[];
 expect([x,y,blur],`a ring all round, not an offset bar: ${m.shadow}`).toEqual(['0','0','0']);expect(Number(spread)).toBeGreaterThanOrEqual(2);
 expect(color,'the text colour, not a speaker colour').toBe(m.ink);expect(color).not.toBe(m.rule);
 expect(ratio(color,m.behind),'visible on the row').toBeGreaterThanOrEqual(3);
 await expect(page.locator('.transcript-row.playing')).toHaveCount(1);
});
// CIEDE2000 colour difference of two computed rgb() colours (sRGB, D65), so the speaker slots can be checked for being told apart.
const lab=(c:string)=>{const [r,g,b]=c.match(/[\d.]+/g)!.slice(0,3).map(v=>{const x=Number(v)/255;return x<=0.04045?x/12.92:((x+0.055)/1.055)**2.4;});
 const f=(t:number)=>t>0.008856?Math.cbrt(t):7.787*t+16/116,[x,y,z]=[(0.4124*r+0.3576*g+0.1805*b)/0.95047,0.2126*r+0.7152*g+0.0722*b,(0.0193*r+0.1192*g+0.9505*b)/1.08883].map(f);
 return [116*y-16,500*(x-y),200*(y-z)];};
const de2000=([L1,a1,b1]:number[],[L2,a2,b2]:number[])=>{const rad=Math.PI/180,C7=(c:number)=>Math.sqrt(c**7/(c**7+25**7)),G=0.5*(1-C7((Math.hypot(a1,b1)+Math.hypot(a2,b2))/2));
 const [p1,p2]=[a1*(1+G),a2*(1+G)],[C1,C2]=[Math.hypot(p1,b1),Math.hypot(p2,b2)],hue=(a:number,b:number)=>(Math.atan2(b,a)/rad+360)%360,[h1,h2]=[hue(p1,b1),hue(p2,b2)];
 const dh=C1*C2===0?0:Math.abs(h2-h1)<=180?h2-h1:h2-h1>180?h2-h1-360:h2-h1+360,dH=2*Math.sqrt(C1*C2)*Math.sin(dh*rad/2),L=(L1+L2)/2,C=(C1+C2)/2;
 const H=C1*C2===0?h1+h2:Math.abs(h1-h2)<=180?(h1+h2)/2:h1+h2<360?(h1+h2+360)/2:(h1+h2-360)/2;
 const T=1-0.17*Math.cos((H-30)*rad)+0.24*Math.cos(2*H*rad)+0.32*Math.cos((3*H+6)*rad)-0.2*Math.cos((4*H-63)*rad),Rt=-Math.sin(60*Math.exp(-(((H-275)/25)**2))*rad)*2*C7(C);
 const [sL,sC,sH]=[1+0.015*(L-50)**2/Math.sqrt(20+(L-50)**2),1+0.045*C,1+0.015*C*T],[l,c,h]=[(L2-L1)/sL,(C2-C1)/sC,dH/sH];return Math.sqrt(l*l+c*c+h*h+Rt*c*h);};
test('every two of the eight speaker colours are at least 15 apart (CIEDE2000) in both themes',async({page})=>{
 expect(de2000([50,2.6772,-79.7751],[50,0,-82.7485])).toBeCloseTo(2.0425,3);expect(de2000([50,2.5,0],[73,25,-18])).toBeCloseTo(27.1492,3); // Sharma et al. 2005 test pairs
 for(const theme of ['light','dark']){
  await page.emulateMedia({colorScheme:theme as 'light'|'dark'});await page.goto('/');await expect(page.locator('html')).toHaveAttribute('data-theme',theme);
  const c:string[]=await page.evaluate(()=>[0,1,2,3,4,5,6,7].map(n=>{const i=document.createElement('i');i.style.color=`var(--spk-${n})`;document.body.append(i);const v=getComputedStyle(i).color;i.remove();return v;}));
  const close=[];for(let i=0;i<8;i++)for(let j=i+1;j<8;j++){const d=de2000(lab(c[i]),lab(c[j]));if(d<15)close.push(`${i}-${j} ${d.toFixed(1)}`);}
  expect(close,theme).toEqual([]);
 }
});

