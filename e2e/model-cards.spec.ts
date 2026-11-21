import {test,expect} from '@playwright/test';
import type {Page} from '@playwright/test';
// The model cards on "Model & cài đặt": sizes from models.json, RAM per model, one recommendation per task for the machine's memory
// (runtime_status.total_memory_mb), and the processor panel behind "Nâng cao". Tauri is mocked like layout.spec.ts.
const IDS=['vieneu-v3','whisper-small','whisper-turbo','diarization','htdemucs','separation-runtime'];
const NAMES:Record<string,string>={'vieneu-v3':'VieNeu v3 Turbo','whisper-small':'Whisper Small','whisper-turbo':'Whisper Large v3 Turbo','diarization':'Phân biệt người nói (pyannote + CAM++)','htdemucs':'Tách giọng và nhạc nền (HTDemucs)','separation-runtime':'Gói chạy tách nhạc nền (Python + PyTorch)'};
const BADGE={recommended:'Đề xuất cho máy bạn',heavy:'Có thể nặng với máy này'};
const mock=({total,names,engines,none}:{total:number|null;names:Record<string,string>;engines:Record<string,string>;none:boolean})=>{
 let settings:any={dictionary:{},worker_engines:engines};
 const w=window as any,models=none?[]:Object.keys(names).map(id=>({id,name:names[id],engine:id.startsWith('whisper')||id==='diarization'?'stt':id==='vieneu-v3'?'tts':id==='htdemucs'?'separation':'runtime',kind:id==='separation-runtime'?'runtime':'model',installed:false,revision:'9f8e7d6c5b4a3921',license:'MIT',description:'Mô tả ngắn của model.'}));
 w.isTauri=true;
 w.__TAURI_INTERNALS__={convertFileSrc:(p:string)=>p,transformCallback:()=>1,unregisterCallback:()=>{},metadata:{currentWindow:{label:'main'},currentWebview:{label:'main',windowLabel:'main'}},
  invoke:async(cmd:string,args:any)=>{switch(cmd){
   case 'list_projects':case 'list_jobs':case 'list_voices':return [];case 'list_models':return models;case 'get_settings':return settings;case 'save_settings':settings=args.settings;return settings;
   case 'runtime_status':return {python_ready:true,ffmpeg_ready:true,worker_ready:true,native_worker_ready:true,python_path:null,ffmpeg_path:null,native_worker_path:null,fallback_count:0,total_memory_mb:total,message:'Runtime đã tìm thấy.'};
   default:return null;}}};
};
const open=async(page:Page,total:number|null,width=1440,height=1000,engines:Record<string,string>={},none=false)=>{
 await page.setViewportSize({width,height});await page.addInitScript(mock,{total,names:NAMES,engines,none});await page.goto('/');
 await page.getByRole('navigation',{name:'Điều hướng chính'}).getByRole('button',{name:'Model & cài đặt',exact:true}).click();await expect(page.locator('.model-card')).toHaveCount(none?0:IDS.length);
};
const card=(page:Page,id:string)=>page.locator('.model-card').filter({has:page.getByRole('heading',{level:3,name:NAMES[id],exact:true})});
const fact=(page:Page,id:string,label:string)=>card(page,id).locator('dt',{hasText:label}).locator('xpath=following-sibling::dd[1]');
const sideways=(page:Page)=>page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth);

test('each card shows its download size and RAM, and "Chưa đo" where no peak was measured',async({page})=>{
 await open(page,7910);
 // 636,939,541 B; 486,212,372 B; 1,621,665,983 B; 34,275,138 B; 84,025,440 B; the pack, 173,988,339 B.
 for(const [id,size] of Object.entries({'vieneu-v3':'637 MB','whisper-small':'486 MB','whisper-turbo':'1,6 GB',diarization:'34 MB',htdemucs:'84 MB','separation-runtime':'174 MB'}))await expect(fact(page,id,'Dung lượng tải'),id).toHaveText(size);
 await expect(fact(page,'vieneu-v3','RAM khi chạy')).toContainText('khoảng 2,2 GB');
 await expect(fact(page,'vieneu-v3','RAM khi chạy')).toContainText('Chưa tính Whisper Small khi bật Tự kiểm bằng Whisper');
 await expect(fact(page,'whisper-small','RAM khi chạy')).toHaveText('khoảng 1,3 GB');
 for(const id of ['whisper-turbo','diarization','htdemucs','separation-runtime'])await expect(fact(page,id,'RAM khi chạy'),id).toHaveText('Chưa đo');
});
// What modelAdvice says per machine (src/models.test.ts has the rules; the Playwright loader cannot import models.json through src/models.ts).
const DEFAULT='Chưa đọc được RAM của máy; đây là lựa chọn mặc định.';
const ADVICE:[number|null,string,string,string,string][]=[ // total, VieNeu badge, VieNeu reason, Small badge, Small reason
 [7910,'recommended','Máy có 7,7 GB RAM, đủ cho model này.','recommended','Cần khoảng 1,3 GB RAM, máy có 7,7 GB.'],
 [15760,'recommended','Máy có 15,4 GB RAM, đủ cho model này.','recommended','Cần khoảng 1,3 GB RAM, máy có 15,4 GB.'],
 [null,'recommended',DEFAULT,'recommended',DEFAULT],
 [3900,'heavy','Cần khoảng 2,2 GB RAM, máy chỉ có 3,8 GB. Đóng bớt ứng dụng khác trước khi đọc.','recommended','Cần khoảng 1,3 GB RAM, máy có 3,8 GB.'],
];
for(const [total,tts,ttsReason,stt,sttReason] of ADVICE)test(`the badges and their reasons follow the machine memory (${total??'unknown'} MB)`,async({page})=>{
 await open(page,total);
 for(const [id,badge,reason] of [['vieneu-v3',tts,ttsReason],['whisper-small',stt,sttReason]] as const){
  await expect(card(page,id).locator('.mc-badge'),id).toHaveText(BADGE[badge as keyof typeof BADGE]);await expect(card(page,id).locator('.mc-reason'),id).toHaveText(reason);
 }
 // Turbo is not measured, so Small is the only STT pick and Turbo has no badge; there are never two STT badges.
 for(const id of ['whisper-turbo','diarization','htdemucs','separation-runtime']){await expect(card(page,id).locator('.mc-badge'),id).toHaveCount(0);await expect(card(page,id).locator('.mc-reason'),id).toHaveCount(0);}
 await expect(page.locator('.model-card').filter({has:page.locator('.eyebrow',{hasText:'stt'})}).locator('.mc-badge')).toHaveCount(1);
});
test('the cards come before the runtime panel, and the processor selects are reachable only after "Nâng cao"',async({page})=>{
 await open(page,7910);
 const y=async(sel:string)=>(await page.locator(sel).boundingBox())!.y;
 expect(await y('.model-grid')).toBeLessThan(await y('.runtime-panel'));expect(await y('.runtime-panel')).toBeLessThan(await y('details.mc-advanced'));
 const select=page.locator('.engine-rows label').filter({hasText:'Đọc văn bản'}).locator('select'),summary=page.getByText('Nâng cao: bộ xử lý');
 await expect(summary).toBeVisible();await expect(select).toBeHidden();
 await summary.focus();await page.keyboard.press('Enter');await expect(select).toBeVisible();
 await page.keyboard.press('Enter');await expect(select).toBeHidden();
});
for(const width of [800,640])test(`the models page does not scroll sideways at ${width} px`,async({page})=>{
 await open(page,3900,width,800);
 expect(await sideways(page)).toBeLessThanOrEqual(0);
 await page.getByText('Nâng cao: bộ xử lý').click();await expect(page.locator('.engine-rows')).toBeVisible();expect(await sideways(page)).toBeLessThanOrEqual(0);
 const edge=await page.evaluate(()=>[...document.querySelectorAll('.model-card')].filter(c=>c.scrollWidth>c.clientWidth).length);expect(edge).toBe(0);
});
// WCAG AA: 4.5:1 for text under 24 px, in the light and the dark theme, against the card (or the badge) behind it.
for(const scheme of ['light','dark'] as const)test(`card text and badges reach 4.5:1 in the ${scheme} theme`,async({page})=>{
 await page.emulateMedia({colorScheme:scheme});await open(page,3900);await expect(page.locator('html')).toHaveAttribute('data-theme',scheme);
 const ratios=await page.evaluate(()=>{
  const rgb=(c:string)=>c.match(/[\d.]+/g)!.slice(0,3).map(Number),lum=([r,g,b]:number[])=>{const f=(v:number)=>{v/=255;return v<=.03928?v/12.92:((v+.055)/1.055)**2.4;};return .2126*f(r)+.7152*f(g)+.0722*f(b);};
  const ratio=(a:string,b:string)=>{const [x,y]=[lum(rgb(a)),lum(rgb(b))];return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);};
  const out:Record<string,number>={},cardBg=getComputedStyle(document.querySelector('.model-card')!).backgroundColor;
  for(const [name,sel,own] of [['recommended','.mc-badge.recommended',true],['heavy','.mc-badge.heavy',true],['reason','.mc-reason',false],['label','.mc-facts dt',false],['value','.mc-facts dd',false],['sub','.mc-facts dd small',false],['description','.model-card p:not(.mc-reason)',false]] as const){
   const e=document.querySelector(sel)!,s=getComputedStyle(e);out[name]=ratio(s.color,own?s.backgroundColor:cardBg);
  }
  return out;
 });
 for(const [name,r] of Object.entries(ratios))expect(r,name).toBeGreaterThanOrEqual(4.5);
});
test('the cards add no motion when the system asks for reduced motion',async({page})=>{
 await page.emulateMedia({reducedMotion:'reduce'});await open(page,7910);
 const moving=await page.evaluate(()=>[...document.querySelectorAll('.model-card, .model-card *, details.mc-advanced, details.mc-advanced *')].filter(e=>{const s=getComputedStyle(e);return s.animationName!=='none'||s.transitionDuration.split(',').some(d=>parseFloat(d)>0);}).length);
 expect(moving).toBe(0);
});
test('the diagnostics button stays outside the fold',async({page})=>{
 await open(page,7910);
 await expect(page.locator('details.mc-advanced')).not.toHaveAttribute('open','');
 const diag=page.getByRole('button',{name:'Xuất nhật ký chẩn đoán'});await expect(diag).toBeVisible();
 expect(await diag.evaluate(b=>!b.closest('details'))).toBe(true);
});
test('"Nâng cao" starts open when an engine is set to Python',async({page})=>{
 await open(page,7910,1440,1000,{tts:'python'});
 await expect(page.locator('details.mc-advanced')).toHaveAttribute('open','');
 await expect(page.locator('.engine-rows label').filter({hasText:'Đọc văn bản'}).locator('select')).toHaveValue('python');
});
test('the panel the user opened stays open when the last non-default engine goes back to auto',async({page})=>{
 await open(page,7910);
 await page.getByText('Nâng cao: bộ xử lý').click();
 const select=page.locator('.engine-rows label').filter({hasText:'Đọc văn bản'}).locator('select');
 await select.selectOption('python');await expect(select).toHaveValue('python');
 await select.selectOption('auto');await expect(select).toHaveValue('auto');
 await expect(page.locator('details.mc-advanced')).toHaveJSProperty('open',true);await expect(select).toBeVisible(); // focus is not asserted: every select is disabled while a save runs (busy), which drops focus with or without the fold
});
test('the empty state comes right after the card grid',async({page})=>{
 await open(page,null,1440,1000,{},true);
 await expect(page.locator('.model-grid + .panel').filter({hasText:'Model local xuất hiện trong bản desktop'})).toHaveCount(1);
});
test('the badge follows the heading in the DOM and still sits in the top corner of the card',async({page})=>{
 await open(page,3900);
 const c=card(page,'vieneu-v3'),h=c.getByRole('heading',{level:3}),b=c.locator('.mc-badge');
 await expect(c.locator('h3 + .mc-badge')).toHaveCount(1);
 const [cb,hb,bb]=[await c.boundingBox(),await h.boundingBox(),await b.boundingBox()];
 expect(bb!.y).toBeLessThan(hb!.y);expect(bb!.x+bb!.width).toBeGreaterThan(cb!.x+cb!.width-40);expect(bb!.x+bb!.width).toBeLessThanOrEqual(cb!.x+cb!.width);
});
