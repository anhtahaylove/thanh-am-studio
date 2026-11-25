import {test,expect,type Page} from '@playwright/test';
import {readFileSync} from 'node:fs';
// High contrast (B2): the 4th theme button sets data-theme=dark plus data-contrast=more, from the first frame when it is the stored choice. The sweep reads the computed colours of
// every page: text 7:1, borders, focus ring, bars and stripes 3:1, the eight speaker colours 7:1 on black and on their tint and 10 apart (CIEDE2000). Forced colors are
// emulated with Playwright's forcedColors option. Tauri is mocked with the 12-segment fixture plus a transcript, voices, jobs and models, so every page has content.
const VERSION=JSON.parse(readFileSync('package.json','utf8')).version as string;
const PROJECT=JSON.parse(readFileSync('e2e/fixtures/script-12.json','utf8'));
PROJECT.segments[3].chapter='Chương 1';
PROJECT.transcript=[0,1,2,3].map(n=>({id:`r${n}`,start_ms:n*3000,end_ms:n*3000+2800,text:`Câu chép lời số ${n+1}, có chữ để đọc.`,speaker:n%3,overlap_speaker:n===3?0:null}));
const wav=(()=>{const rate=8000,n=rate*4,b=Buffer.alloc(44+n*2);b.write('RIFF',0);b.writeUInt32LE(36+n*2,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(rate,24);b.writeUInt32LE(rate*2,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(n*2,40);for(let i=0;i<n;i++)b.writeInt16LE(Math.round(Math.sin(i/rate*2*Math.PI*440)*20000),44+i*2);return b;})();
const mock=(o:{project:string}):void=>{
 const w=window as any;w.isTauri=true;w.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};
 const project:any=JSON.parse(o.project),ipc=(v:unknown)=>JSON.parse(JSON.stringify(v));
 for(const s of project.segments)for(const t of s.takes)t.path=`/${t.id}.wav`;
 const job=(id:string,status:string,progress:number,error:string|null)=>({id,kind:'tts',project_id:project.id,payload:{},status,progress,error,result:null,created_at:'2026-11-25T00:00:00Z',updated_at:'2026-11-25T00:00:00Z'});
 w.__TAURI_INTERNALS__={convertFileSrc:(p:string)=>p,transformCallback:()=>1,unregisterCallback:()=>{},metadata:{currentWindow:{label:'main'},currentWebview:{label:'main',windowLabel:'main'}},
  invoke:async(cmd:string,args:any)=>{switch(cmd){
   case 'list_projects':return [{id:project.id,name:project.name,updated_at:project.updated_at,revision:project.revision}];case 'load_project':return ipc(project);
   case 'list_voices':return [{id:'v1',name:'Giọng có sẵn',kind:'preset',reference_asset_id:null,consent:true,engine_voice_id:'x'},{id:'v2',name:'Giọng của tôi',kind:'reference',reference_asset_id:'a1',consent:true,engine_voice_id:null}];
   case 'list_jobs':return [job('j1','running',0.4,null),job('j2','failed',0,'Không đủ bộ nhớ'),job('j3','succeeded',1,null)];
   case 'list_models':return [{id:'vieneu-v3',name:'VieNeu v3 Turbo',engine:'tts',installed:true,revision:'r',license:'Apache-2.0',description:'Giọng đọc tiếng Việt.'},{id:'whisper-small',name:'Whisper Small',engine:'stt',installed:false,revision:'r',license:'MIT',description:'Chép lời.'}];
   case 'list_project_versions':return [{id:'v1',project_id:project.id,revision:2,state_at:'2026-11-25T08:05:00Z',created_at:'2026-11-25T08:05:00Z',reason:'auto',segments:12,transcript:0,chars:1200,bytes:4096},{id:'v2',project_id:project.id,revision:1,state_at:'2026-11-24T21:40:00Z',created_at:'2026-11-24T21:40:00Z',reason:'before_restore',segments:11,transcript:4,chars:1100,bytes:3900}];
   case 'get_settings':return {dictionary:{'TP.HCM':'thành phố Hồ Chí Minh'}};
   case 'runtime_status':return {python_ready:true,ffmpeg_ready:true,worker_ready:true,native_worker_ready:true,python_path:null,ffmpeg_path:null,native_worker_path:null,fallback_count:0,message:''};
   case 'save_project':return {...ipc(args.project),revision:args.project.revision+1};
   default:return null;}}};
};
const start=async(page:Page,d:{stored?:string;width?:number;height?:number;project?:boolean}={}):Promise<void>=>{
 await page.setViewportSize({width:d.width??1440,height:d.height??960});await page.emulateMedia({reducedMotion:'reduce'});
 await page.route(/\/s\d+-t\d+\.wav$/,r=>r.fulfill({status:200,contentType:'audio/wav',body:wav}));
 // A stored theme marks an earlier install, so the "Có gì mới" dialog would open (and make the page inert) unless the current version is already seen.
 await page.addInitScript(v=>localStorage.setItem('thanh-am-seen-version',v),VERSION);
 if(d.stored)await page.addInitScript(v=>localStorage.setItem('thanh-am-theme',v),d.stored);
 await page.addInitScript(mock,{project:JSON.stringify(PROJECT)});await page.goto('/');
 if(d.project===false)return;
 await page.getByRole('button',{name:'Dự án',exact:true}).click();await page.getByRole('button',{name:'Mở dự án',exact:true}).click();
 await expect(page.getByRole('textbox',{name:'Nội dung đoạn 12'})).toBeAttached();
};
const contrastButton=(page:Page)=>page.getByRole('button',{name:'Chuyển giao diện tương phản cao',exact:true});
const root=(page:Page)=>page.locator('html');
// Colour maths (WCAG relative luminance, CIEDE2000 on sRGB D65), on [r,g,b] 0-255.
type RGB=[number,number,number];
const lin=(c:RGB)=>c.map(v=>{const x=v/255;return x<=0.04045?x/12.92:((x+0.055)/1.055)**2.4;});
const ratio=(a:RGB,b:RGB)=>{const Y=(c:RGB)=>{const [r,g,bl]=lin(c);return 0.2126*r+0.7152*g+0.0722*bl;},[x,y]=[Y(a),Y(b)].sort((p,q)=>q-p);return (x+0.05)/(y+0.05);};
const lab=(c:RGB)=>{const [r,g,b]=lin(c),f=(t:number)=>t>0.008856?Math.cbrt(t):7.787*t+16/116,[x,y,z]=[(0.4124*r+0.3576*g+0.1805*b)/0.95047,0.2126*r+0.7152*g+0.0722*b,(0.0193*r+0.1192*g+0.9505*b)/1.08883].map(f);return [116*y-16,500*(x-y),200*(y-z)];};
const de2000=([L1,a1,b1]:number[],[L2,a2,b2]:number[])=>{const rad=Math.PI/180,C7=(c:number)=>Math.sqrt(c**7/(c**7+25**7)),G=0.5*(1-C7((Math.hypot(a1,b1)+Math.hypot(a2,b2))/2));
 const [p1,p2]=[a1*(1+G),a2*(1+G)],[C1,C2]=[Math.hypot(p1,b1),Math.hypot(p2,b2)],hue=(a:number,b:number)=>(Math.atan2(b,a)/rad+360)%360,[h1,h2]=[hue(p1,b1),hue(p2,b2)];
 const dh=C1*C2===0?0:Math.abs(h2-h1)<=180?h2-h1:h2-h1>180?h2-h1-360:h2-h1+360,dH=2*Math.sqrt(C1*C2)*Math.sin(dh*rad/2),L=(L1+L2)/2,C=(C1+C2)/2;
 const H=C1*C2===0?h1+h2:Math.abs(h1-h2)<=180?(h1+h2)/2:h1+h2<360?(h1+h2+360)/2:(h1+h2-360)/2;
 const T=1-0.17*Math.cos((H-30)*rad)+0.24*Math.cos(2*H*rad)+0.32*Math.cos((3*H+6)*rad)-0.2*Math.cos((4*H-63)*rad),Rt=-Math.sin(60*Math.exp(-(((H-275)/25)**2))*rad)*2*C7(C);
 const [sL,sC,sH]=[1+0.015*(L-50)**2/Math.sqrt(20+(L-50)**2),1+0.045*C,1+0.015*C*T],[l,c,h]=[(L2-L1)/sL,(C2-C1)/sC,dH/sH];return Math.sqrt(l*l+c*c+h*h+Rt*c*h);};
// What a page measures, in the page: a CSS colour becomes RGBA through a canvas (so color-mix() and system colours resolve), a background is the stack of the element's own and its
// ancestors' layers composited up to the first opaque one, and a gradient or image behind text is reported instead of guessed.
const SWEEP=`(()=>{
 const cv=document.createElement('canvas');cv.width=cv.height=1;const cx=cv.getContext('2d',{willReadFrequently:true});
 const rgba=c=>{cx.clearRect(0,0,1,1);cx.fillStyle='#000';cx.fillStyle=c;cx.fillRect(0,0,1,1);const d=cx.getImageData(0,0,1,1).data;return [d[0],d[1],d[2],d[3]/255];};
 const over=(f,b)=>{const a=f[3]+b[3]*(1-f[3]);return a?[0,1,2].map(i=>(f[i]*f[3]+b[i]*b[3]*(1-f[3]))/a).concat(a):[0,0,0,0];};
 const behind=(el,self)=>{const layers=[];let image=false;for(let e=self?el:el.parentElement;e;e=e.parentElement){const s=getComputedStyle(e);if(s.backgroundImage!=='none')image=true;layers.push(rgba(s.backgroundColor));if(layers.at(-1)[3]===1)break;}
  let acc=[255,255,255,1];if(layers.at(-1)?.[3]!==1)acc=rgba(getComputedStyle(document.documentElement).backgroundColor);for(const l of layers.reverse())acc=over(l,acc);return {rgb:acc.slice(0,3).map(Math.round),image};};
 const alphaOf=el=>{let a=1;for(let e=el;e;e=e.parentElement)a*=Number(getComputedStyle(e).opacity);return a;};
 const name=el=>el.tagName.toLowerCase()+(el.className&&typeof el.className==='string'?'.'+el.className.trim().split(/\\s+/).join('.'):'');
 const shown=el=>el.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})&&el.getBoundingClientRect().width>0&&!el.closest('.sr-only,[hidden],option');
 const off=el=>el.matches(':disabled,[aria-disabled=true]')||!!el.closest('button:disabled,[aria-disabled=true]');
 const text=[];const walk=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
 for(let n;n=walk.nextNode();){const el=n.parentElement;if(!el||!n.textContent.trim()||!shown(el)||off(el)||el.closest('script,style'))continue;
  const s=getComputedStyle(el),b=behind(el,true),f=rgba(s.color),fa=f[3]*alphaOf(el),fg=over([f[0],f[1],f[2],fa],[...b.rgb,1]);
  text.push({el:name(el)+' "'+n.textContent.trim().slice(0,24)+'"',fg:fg.slice(0,3),bg:b.rgb,image:b.image});}
 for(const el of document.querySelectorAll('input:not([type=hidden]),textarea,select')){if(!shown(el)||off(el))continue;const s=getComputedStyle(el),b=behind(el,true);text.push({el:name(el)+' '+(el.getAttribute('aria-label')||el.name||''),fg:rgba(s.color).slice(0,3),bg:b.rgb,image:b.image});}
 const edges=[];const edge=(el,what,color)=>{if(!shown(el))return;const b=behind(el,false);edges.push({el:name(el)+' '+what,fg:color.slice(0,3),bg:b.rgb});};
 for(const el of document.querySelectorAll('.panel,input:not([type=hidden]):not([type=checkbox]),textarea,select,.audio-dock')){const s=getComputedStyle(el);if(parseFloat(s.borderTopWidth)>0)edge(el,'border',rgba(s.borderTopColor));}
 for(const el of document.querySelectorAll('article.segment,.transcript-row.tr'))edge(el,'stripe',rgba(getComputedStyle(el).borderLeftColor));
 for(const el of document.querySelectorAll('.waveform i:not(.trimmed)'))edge(el,'bar',rgba(getComputedStyle(el).backgroundColor));
 for(const el of document.querySelectorAll('.trim-handle')){const s=getComputedStyle(el,'::before');edges.push({el:'trim-handle',fg:rgba(s.backgroundColor).slice(0,3),bg:behind(el,false).rgb});}
 return {text,edges};})()`;
type Measure={el:string;fg:RGB;bg:RGB;image?:boolean};
const sweep=(page:Page)=>page.evaluate(SWEEP) as Promise<{text:Measure[];edges:Measure[]}>;
const below=(rows:Measure[],min:number)=>rows.filter(r=>ratio(r.fg,r.bg)<min).map(r=>`${r.el} ${ratio(r.fg,r.bg).toFixed(2)} (${r.fg} on ${r.bg})`);
// A computed colour as RGB: one-pixel canvas, so system colours and color-mix() resolve the same way as in the sweep.
const colourOf=(page:Page,css:string)=>page.evaluate(c=>{const x=document.createElement('canvas').getContext('2d')!;x.fillStyle=c;x.fillRect(0,0,1,1);return [...x.getImageData(0,0,1,1).data.slice(0,3)] as [number,number,number];},css);
const PAGES=['Tạo giọng đọc','Chép lời','Thư viện giọng','Hàng đợi','Dự án','Model & cài đặt'];
const goto=async(page:Page,name:string)=>{await page.getByRole('navigation',{name:'Điều hướng chính'}).getByRole('button',{name:new RegExp(`^${name}( [(][0-9]+[)])?$`)}).click();await expect(page.getByRole('heading',{level:1})).toBeVisible();};

test('a stored contrast choice is dark plus data-contrast on the root before the first frame',async({page})=>{
 await page.emulateMedia({colorScheme:'light'});
 await page.addInitScript(()=>{localStorage.setItem('thanh-am-theme','contrast');const w=window as unknown as Record<string,unknown>,seen=()=>{const d=document.documentElement.dataset;return `${d.theme??'none'}/${d.contrast??'none'}`;};document.addEventListener('DOMContentLoaded',()=>{w.atLoaded=seen();});const frame=()=>{if(document.body?.querySelector('#root > *'))w.atFirstPaint=seen();else requestAnimationFrame(frame);};requestAnimationFrame(frame);});
 await page.goto('/');await expect(root(page)).toHaveAttribute('data-contrast','more');
 expect(await page.evaluate(()=>{const w=window as unknown as Record<string,unknown>;return [w.atLoaded,w.atFirstPaint];})).toEqual(['dark/more','dark/more']);
 await expect(contrastButton(page)).toHaveAttribute('aria-pressed','true');
});
test('the contrast button sits with the other three, switches the theme, persists, and every other choice clears it',async({page})=>{
 await page.emulateMedia({colorScheme:'light'});await page.goto('/');
 const names=['Chuyển giao diện theo hệ thống','Chuyển giao diện sáng','Chuyển giao diện tối','Chuyển giao diện tương phản cao'];
 await expect(page.getByRole('group',{name:'Giao diện'}).getByRole('button')).toHaveCount(4);
 await expect(root(page)).not.toHaveAttribute('data-contrast',/.*/);
 await contrastButton(page).click();
 await expect(root(page)).toHaveAttribute('data-theme','dark');await expect(root(page)).toHaveAttribute('data-contrast','more');
 for(const n of names)await expect(page.getByRole('button',{name:n,exact:true})).toHaveAttribute('aria-pressed',String(n===names[3]));
 expect(await page.evaluate(()=>[localStorage.getItem('thanh-am-theme'),getComputedStyle(document.documentElement).getPropertyValue('--ink').trim(),getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()])).toEqual(['contrast','#fff','#000']);
 await page.reload();await expect(root(page)).toHaveAttribute('data-contrast','more');await expect(contrastButton(page)).toHaveAttribute('aria-pressed','true');
 for(const [name,theme] of [['Chuyển giao diện tối','dark'],['Chuyển giao diện sáng','light']] as const){
  await contrastButton(page).click();await expect(root(page)).toHaveAttribute('data-contrast','more');
  await page.getByRole('button',{name,exact:true}).click();await expect(root(page)).toHaveAttribute('data-theme',theme);await expect(root(page)).not.toHaveAttribute('data-contrast',/.*/);
 }
 await contrastButton(page).click();await page.getByRole('button',{name:'Chuyển giao diện theo hệ thống',exact:true}).click();
 await expect(root(page)).toHaveAttribute('data-theme','light');await expect(root(page)).not.toHaveAttribute('data-contrast',/.*/);
 await page.reload();await expect(root(page)).not.toHaveAttribute('data-contrast',/.*/);
});
for(const [width,height] of [[456,320],[1000,720],[640,800]])test(`the contrast button is inside the rail and works at ${width}x${height}`,async({page})=>{
 await page.setViewportSize({width,height});await page.goto('/');
 const button=contrastButton(page);await button.scrollIntoViewIfNeeded();
 const rail=await page.locator('.sidebar').boundingBox(),b=await button.boundingBox();expect(b).not.toBeNull();
 expect(b!.x).toBeGreaterThanOrEqual(rail!.x);expect(b!.x+b!.width).toBeLessThanOrEqual(rail!.x+rail!.width);
 expect(await page.locator('.sidebar').evaluate(el=>el.scrollWidth<=el.clientWidth),'no sideways scroll in the rail').toBe(true);
 await button.click();await expect(root(page)).toHaveAttribute('data-contrast','more');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no sideways scroll on the page').toBe(true);
});
test('the eight speaker colours keep 7:1 on black and on their tint and stay 10 apart in CIEDE2000',async({page})=>{
 await start(page,{stored:'contrast',project:false});
 const slots=[0,1,2,3,4,5,6,7],rgb=async(n:string)=>colourOf(page,await page.evaluate(n=>getComputedStyle(document.documentElement).getPropertyValue(n).trim(),n));
 const text=await Promise.all(slots.map(n=>rgb(`--spk-${n}`))),soft=await Promise.all(slots.map(n=>rgb(`--spk-${n}-soft`))),black=await rgb('--paper'),ink=await rgb('--ink');
 expect(black).toEqual([0,0,0]);expect(ink).toEqual([255,255,255]);
 for(const n of slots){expect(ratio(text[n],black),`--spk-${n} on black`).toBeGreaterThanOrEqual(7);expect(ratio(text[n],soft[n]),`--spk-${n} on its tint`).toBeGreaterThanOrEqual(7);expect(de2000(lab(text[n]),lab(ink)),`--spk-${n} vs --ink`).toBeGreaterThanOrEqual(10);}
 const near=slots.flatMap(i=>slots.filter(j=>j>i).map(j=>({pair:`${i}-${j}`,d:de2000(lab(text[i]),lab(text[j]))}))).filter(p=>p.d<10);
 expect(near,'pairs closer than 10').toEqual([]);
});
for(const name of PAGES)test(`high contrast, ${name}: text 7:1, borders, focus ring, bars and stripes 3:1`,async({page})=>{
 await start(page,{stored:'contrast'});await goto(page,name);
 if(name==='Chép lời')await expect(page.locator('.transcript-row')).toHaveCount(4);
 if(name==='Tạo giọng đọc'){await page.locator('article.segment').nth(1).click();await expect(page.locator('.waveform i').first()).toBeAttached();}
 // Pieces that need a failure or a dialog to appear are put in place by hand: the rules under test are class rules, not tied to a parent.
 await page.evaluate(()=>{const host=document.createElement('div');host.id='probe';host.innerHTML='<div class="alert error"><div><strong>Lỗi</strong><p>Không đủ bộ nhớ.</p></div></div><div class="preview-strip">Bản xem trước, chưa có engine.</div><div class="tip-card"><h4>Mẹo</h4><p>Chia đoạn ngắn.</p></div><div class="alert notice"><span>Đã xong.</span></div><span class="take-check warn">Lệch 3 chữ</span> <span class="job-icon failed">!</span> <button class="primary">Tạo</button> <button class="outlined">Hủy</button><div class="busy-indicator" role="status"><span>Đang tạo giọng…</span></div><section class="script-empty"><h2>Mở đầu</h2><p>Dán kịch bản vào đây.</p></section>';document.querySelector('main')!.append(host);});
 const m=await sweep(page);expect(m.text.length,'text nodes measured').toBeGreaterThan(20);
 expect(m.text.filter(r=>r.image).map(r=>r.el),'text on a gradient or image').toEqual([]);
 expect(below(m.text,7),'text under 7:1').toEqual([]);
 expect(below(m.edges,3),'borders, bars and stripes under 3:1').toEqual([]);
 if(name==='Tạo giọng đọc'){
  // E2's dialog: a modal panel with a close button, a badge and a restore button per version.
  await page.getByRole('button',{name:'Lịch sử phiên bản',exact:true}).click();await expect(page.getByRole('dialog',{name:'Lịch sử phiên bản'}).getByRole('listitem')).toHaveCount(2);
  const d=await sweep(page);expect(below(d.text,7),'version history: text under 7:1').toEqual([]);expect(below(d.edges,3),'version history: edges under 3:1').toEqual([]);
  await page.keyboard.press('Escape');await expect(page.getByRole('dialog')).toHaveCount(0);
 }
 await page.keyboard.press('Tab');
 for(const target of [page.getByRole('button',{name:'Chuyển giao diện sáng',exact:true}),page.locator('main button:not(:disabled)').first()]){
  await target.focus();
  const ring=await target.evaluate(el=>{const s=getComputedStyle(el);let p=el.parentElement;while(p&&/^rgba\(.*,\s*0\)$|^transparent$/.test(getComputedStyle(p).backgroundColor))p=p.parentElement;return {style:`${s.outlineStyle} ${s.outlineWidth}`,color:s.outlineColor,behind:getComputedStyle(p??document.documentElement).backgroundColor};});
  expect(ring.style,'focus ring').toBe('solid 2px');
  const [c,b]=await Promise.all([colourOf(page,ring.color),colourOf(page,ring.behind)]);expect(ratio(c,b),`focus ring ${ring.color} on ${ring.behind}`).toBeGreaterThanOrEqual(3);
 }
});
test('the pressed focus-mode button and the pressed theme button are drawn with an outline in the contrast theme',async({page})=>{
 await start(page,{stored:'contrast'});
 const focus=page.getByRole('button',{name:'Chế độ tập trung',exact:true}),theme=contrastButton(page);
 await focus.click();await page.mouse.move(0,0);await expect(focus).toHaveAttribute('aria-pressed','true');
 for(const [name,button] of [['focus mode',focus],['contrast theme',theme]] as const){
  const o=await button.evaluate(el=>{const s=getComputedStyle(el);return {style:s.outlineStyle,width:s.outlineWidth,color:s.outlineColor};});
  expect(o,`${name} pressed outline`).toEqual({style:'solid',width:'2px',color:'rgb(255, 255, 255)'});
 }
 await focus.click();await page.mouse.move(0,0);await expect(focus).toHaveAttribute('aria-pressed','false');
 expect(await focus.evaluate(el=>getComputedStyle(el).outlineStyle),'not pressed: no outline').toBe('none');
});
test('the heard words of the lit line are underlined in the contrast theme, where heard and unheard text differ by 1.25:1',async({page})=>{
 await start(page,{stored:'contrast',project:false});
 const said=await page.evaluate(()=>{const host=document.createElement('div');host.innerHTML='<div class="karaoke"><span class="said">đã đọc</span> chưa đọc</div>';document.querySelector('main')!.append(host);return getComputedStyle(host.querySelector('.said')!).textDecorationLine;});
 expect(said).toBe('underline');
});
test.describe('forced colors',()=>{
 test.use({forcedColors:'active'});
 test('the emulation applies the forced palette (U5)',async({page})=>{
  await page.goto('/');
  expect(await page.evaluate(()=>matchMedia('(forced-colors: active)').matches)).toBe(true);
  // The stylesheet paints html with --bg (#f6f5f0 or dark); under forced colors it is Canvas instead.
  expect(await page.evaluate(()=>getComputedStyle(document.documentElement).backgroundColor)).toBe(`rgb(${(await colourOf(page,'Canvas')).join(', ')})`);
 });
});
// Under a Windows contrast theme the app can be on any of its themes; the dark and contrast rules carry more specificity than the forced block, so each is exercised.
for(const [name,scheme,stored] of [['light, system theme','light',undefined],['dark scheme, stored dark','dark','dark'],['dark scheme, stored contrast','dark','contrast']] as const)test.describe(`forced colors, ${name}`,()=>{
 test.use({forcedColors:'active',colorScheme:scheme});
  test(`bars, marks, the lit word, stripes, icons, progress and every pressed or selected state use system colours and outlines, ${name}`,async({page})=>{
  await start(page,{project:false,stored});
  // A blocked control is GrayText at full opacity, not a faded copy of the text colour.
  const blocked=page.getByRole('button',{name:'Tạo giọng tất cả',exact:true});await expect(blocked).toHaveAttribute('aria-disabled','true');
  expect(await blocked.evaluate(el=>[getComputedStyle(el).color,getComputedStyle(el).opacity])).toEqual([`rgb(${(await colourOf(page,'GrayText')).join(', ')})`,'1']);
  await page.getByRole('button',{name:'Dự án',exact:true}).click();await page.getByRole('button',{name:'Mở dự án',exact:true}).click();
  await expect(page.getByRole('textbox',{name:'Nội dung đoạn 12'})).toBeAttached();
  const [canvasText,highlight,highlightText]=await Promise.all(['CanvasText','Highlight','HighlightText'].map(c=>colourOf(page,c))),rgb=(c:number[])=>`rgb(${c.join(', ')})`;
  await page.locator('article.segment').nth(1).click();
  const bars=page.locator('.waveform i:not(.trimmed)');await expect(bars.first()).toBeAttached();
  expect(await bars.first().evaluate(el=>getComputedStyle(el).backgroundColor),'a bar').toBe(rgb(canvasText));
  expect(await bars.first().evaluate(el=>{el.classList.add('played');return getComputedStyle(el).backgroundColor;}),'a played bar').toBe(rgb(highlight));
  // The lit word, the diff preview and a search hit have rules of their own with colours; each still becomes Highlight, and the heard words stay underlined.
  const marks=await page.evaluate(()=>{const host=document.createElement('div');host.innerHTML='<mark>a</mark><div class="karaoke"><span class="said">b</span> <mark>c</mark></div><p class="diff-preview"><mark>d</mark></p><p class="match-preview"><mark class="exact">e</mark></p>';document.querySelector('main')!.append(host);
   return {marks:[...host.querySelectorAll('mark')].map(m=>[getComputedStyle(m).backgroundColor,getComputedStyle(m).color]),said:getComputedStyle(host.querySelector('.said')!).textDecorationLine};});
  const busy=await page.evaluate(()=>{const el=document.createElement('div');el.className='busy-indicator';el.textContent='Đang tạo giọng…';document.body.append(el);const c=getComputedStyle(el);return `${c.borderTopStyle} ${c.borderTopWidth}`;});expect(busy,'busy indicator edge').toBe('solid 1px');
  expect(marks.marks,'marks').toEqual(Array(4).fill([rgb(highlight),rgb(highlightText)]));expect(marks.said,'heard word').toBe('underline');
  // Icons and the progress bar: an icon is drawn in the text colour, never an author colour under 3:1 on Canvas; a progress bar shows its fill and its track.
  const prog=await page.evaluate(()=>{const p=document.createElement('progress');p.value=0.4;p.max=1;document.querySelector('main')!.append(p);return [getComputedStyle(p,'::-webkit-progress-value').backgroundColor,getComputedStyle(p,'::-webkit-progress-bar').backgroundColor];});
  expect(prog,'progress fill and track').toEqual([rgb(highlight),rgb(await colourOf(page,'Canvas'))]);
  await page.getByRole('button',{name:'Lịch sử phiên bản',exact:true}).click();await expect(page.getByRole('dialog',{name:'Lịch sử phiên bản'})).toBeVisible();
  const icons=await page.evaluate(()=>[...document.querySelectorAll('svg')].filter(el=>el.checkVisibility()&&el.getBoundingClientRect().width>0).map(el=>({el:(el.closest('[class]')?.className||'svg')+'',color:getComputedStyle(el).color})));
  const canvas=await colourOf(page,'Canvas'),parse=(c:string)=>c.match(/[\d.]+/g)!.slice(0,3).map(Number) as RGB;
  expect(icons.length,'icons measured').toBeGreaterThan(5);
  expect(icons.filter(i=>ratio(parse(i.color),canvas)<3).map(i=>`${i.el} ${i.color}`),'icons under 3:1 on Canvas').toEqual([]);
  await page.keyboard.press('Escape');await expect(page.getByRole('dialog')).toHaveCount(0);
  const stripe=await page.locator('article.segment').nth(1).evaluate(el=>getComputedStyle(el).borderLeftColor);expect(stripe,'speaker stripe').toBe(rgb(canvasText));
  const outline=(l:ReturnType<Page['locator']>)=>l.evaluate(el=>{const s=getComputedStyle(el);return `${s.outlineStyle} ${s.outlineWidth}`;});
  const focus=page.getByRole('button',{name:'Chế độ tập trung',exact:true});
  expect(await outline(focus),'focus mode off').toMatch(/^none /);
  await focus.click();await page.mouse.move(0,0);await expect(focus).toHaveAttribute('aria-pressed','true');expect(await outline(focus),'focus mode on').toBe('solid 2px');
  await expect.poll(()=>outline(page.getByRole('button',{name:'Tạo giọng đọc',exact:true})),'current page in the rail').toBe('solid 2px');
  await expect.poll(()=>outline(page.locator('article.segment.selected')),'selected row').toBe('solid 2px');
  await page.getByRole('button',{name:'Chuyển giao diện tương phản cao',exact:true}).click();await page.mouse.move(0,0);
  expect(await outline(page.getByRole('button',{name:'Chuyển giao diện tương phản cao',exact:true})),'pressed theme button').toBe('solid 2px');
 });
});
