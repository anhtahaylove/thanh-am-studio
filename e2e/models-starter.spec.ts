import {test,expect} from '@playwright/test';
import type {Page} from '@playwright/test';
// "Model & cài đặt" shows two starter cards (VieNeu and the recommended Whisper); "Thêm model" holds the other four and opens by itself while one of them
// downloads; "Nâng cao" holds the runtime panel, the processor selects and the diagnostics button. Tauri is mocked like model-cards.spec.ts, plus list_jobs.
const NAMES:Record<string,string>={'vieneu-v3':'VieNeu v3 Turbo','whisper-small':'Whisper Small','whisper-turbo':'Whisper Large v3 Turbo','diarization':'Phân biệt người nói (pyannote + CAM++)','htdemucs':'Tách giọng và nhạc nền (HTDemucs)','separation-runtime':'Gói chạy tách nhạc nền (Python + PyTorch)'};
const mock=({total,names,jobs}:{total:number|null;names:Record<string,string>;jobs:{model:string;status:string}[]})=>{
 const w=window as any,now=new Date().toISOString();
 const models=Object.keys(names).map(id=>({id,name:names[id],engine:id.startsWith('whisper')||id==='diarization'?'stt':id==='vieneu-v3'?'tts':id==='htdemucs'?'separation':'runtime',kind:id==='separation-runtime'?'runtime':'model',installed:false,revision:'9f8e7d6c5b4a3921',license:'MIT',description:'Mô tả ngắn của model.'}));
 const list=jobs.map((j,i)=>({id:'dl'+i,kind:'model_download',project_id:null,payload:{model_id:j.model},status:j.status,progress:0.4,error:null,result:null,created_at:now,updated_at:now}));
 w.isTauri=true;
 w.__TAURI_INTERNALS__={convertFileSrc:(p:string)=>p,transformCallback:()=>1,unregisterCallback:()=>{},metadata:{currentWindow:{label:'main'},currentWebview:{label:'main',windowLabel:'main'}},
  invoke:async(cmd:string)=>{switch(cmd){
   case 'list_projects':case 'list_voices':return [];case 'list_jobs':return list;case 'list_models':return models;case 'get_settings':return {dictionary:{},worker_engines:{}};
   case 'runtime_status':return {python_ready:true,ffmpeg_ready:true,worker_ready:true,native_worker_ready:true,python_path:null,ffmpeg_path:null,native_worker_path:null,fallback_count:0,total_memory_mb:total,message:'Runtime đã tìm thấy.'};
   default:return null;}}};
};
const open=async(page:Page,total:number|null=7910,jobs:{model:string;status:string}[]=[])=>{
 await page.addInitScript(mock,{total,names:NAMES,jobs});await page.goto('/');
 await page.getByRole('navigation',{name:'Điều hướng chính'}).getByRole('button',{name:'Model & cài đặt',exact:true}).click();await expect(page.locator('.model-card')).toHaveCount(6);
};
const more=(page:Page)=>page.locator('details.mc-more'),adv=(page:Page)=>page.locator('details.mc-advanced');
const titles=(l:ReturnType<Page['locator']>)=>l.locator('h3').allTextContents(); // getByRole skips what a closed fold hides
const diag=(page:Page)=>page.locator('button',{hasText:'Xuất nhật ký chẩn đoán'});

test('2 cards; Thêm model holds 4',async({page})=>{
 await open(page);
 // The two starters sit outside every disclosure and are visible; the other four are inside "Thêm model", closed.
 const starters=page.locator('.model-card').filter({hasNot:page.locator('xpath=ancestor::details')});
 expect(await titles(starters)).toEqual([NAMES['vieneu-v3'],NAMES['whisper-small']]);
 await expect(starters).toHaveCount(2);for(const c of await starters.all())await expect(c).toBeVisible();
 await expect(more(page).locator('summary')).toHaveText('Thêm model');await expect(more(page)).not.toHaveAttribute('open','');
 expect(await titles(more(page))).toEqual([NAMES['whisper-turbo'],NAMES.diarization,NAMES.htdemucs,NAMES['separation-runtime']]);
 for(const c of await more(page).locator('.model-card').all())await expect(c).toBeHidden();
 // One click opens them, and they can be used from there.
 await more(page).locator('summary').click();
 for(const c of await more(page).locator('.model-card').all())await expect(c).toBeVisible();
 await expect(more(page).getByRole('button',{name:'Tải gói'})).toBeVisible();
});
test('the starter Whisper follows the machine memory',async({page})=>{
 await open(page,15760);
 expect(await titles(page.locator('main>.model-grid'))).toEqual([NAMES['vieneu-v3'],NAMES['whisper-turbo']]);
 expect(await titles(more(page))).toEqual([NAMES['whisper-small'],NAMES.diarization,NAMES.htdemucs,NAMES['separation-runtime']]);
});
test('Thêm model opens while one of its models downloads, and stays closed otherwise',async({page})=>{
 await open(page,7910,[{model:'diarization',status:'running'}]);
 await expect(more(page)).toHaveAttribute('open','');await expect(more(page).locator('.model-card').first()).toBeVisible();
});
test('Thêm model stays closed for a starter download, a finished download and a failed one',async({page})=>{
 await open(page,7910,[{model:'vieneu-v3',status:'running'},{model:'whisper-small',status:'queued'},{model:'diarization',status:'succeeded'},{model:'htdemucs',status:'failed'}]);
 await expect(more(page)).toHaveCount(1);await expect(more(page)).not.toHaveAttribute('open','');
});
test('Thêm model opens while the pack is queued',async({page})=>{
 await open(page,7910,[{model:'separation-runtime',status:'queued'}]);
 await expect(more(page)).toHaveAttribute('open','');
});
test('the runtime panel, the processor selects and the diagnostics button sit in Nâng cao; dictionary, updates and the privacy note stay visible',async({page})=>{
 await open(page);
 await expect(adv(page).locator('summary')).toHaveText('Nâng cao');await expect(adv(page)).not.toHaveAttribute('open','');
 for(const hidden of [page.locator('.runtime-panel'),page.locator('.engine-rows'),diag(page)]){await expect(hidden).toBeHidden();expect(await hidden.evaluate(e=>!!e.closest('details.mc-advanced'))).toBe(true);}
 await expect(page.getByRole('heading',{name:'Từ điển phát âm chung'})).toBeVisible();
 await expect(page.getByRole('checkbox',{name:'Tự kiểm tra và tải bản mới'})).toBeVisible();
 await expect(page.getByText('Không tự tải model hay gửi nội dung ra ngoài',{exact:false})).toBeVisible();
 await adv(page).locator('summary').click();
 await expect(page.locator('.runtime-panel')).toBeVisible();await expect(page.locator('.engine-rows')).toBeVisible();await expect(page.getByRole('button',{name:'Xuất nhật ký chẩn đoán'})).toBeVisible();
});
test('both disclosures work from the keyboard',async({page})=>{
 await open(page);
 for(const [d,hidden] of [[more(page),more(page).locator('.model-card').first()],[adv(page),page.locator('.engine-rows')]] as const){
  await d.locator('summary').focus();await page.keyboard.press('Enter');await expect(hidden).toBeVisible();
  await page.keyboard.press('Enter');await expect(hidden).toBeHidden();
 }
});
for(const width of [800,640])test(`the models page does not scroll sideways at ${width} px with both disclosures open`,async({page})=>{
 await page.setViewportSize({width,height:800});await open(page,3900);
 await more(page).locator('summary').click();await adv(page).locator('summary').click();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
});
