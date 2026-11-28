import {test,expect} from '@playwright/test';
import type {Page} from '@playwright/test';
// A model download runs in place: one click on the card, no page change, progress on the card, "Đã tải xong {tên}." in the live region when it ends,
// and a desktop notice for a long one while the window is in the background. Tauri is mocked as in job-done-notice.spec.ts: window.__calls records every
// command, window.__finish(id) ends the running download job (and installs the model), window.__notified records every desktop notification asked for,
// window.__said every text the live regions (the polite sr-only line and the role=status banner) ever showed (a MutationObserver, so a line that clears itself after 6 s is still caught).
const NAMES:Record<string,string>={'whisper-small':'Whisper Small','separation-runtime':'Gói chạy tách nhạc nền (Python + PyTorch)'};
const VIENEU:Record<string,string>={'vieneu-v3':'VieNeu v3 Turbo'};
const mock=({names,done,installed}:{names:Record<string,string>;done:boolean;installed:string[]})=>{
 const w=window as any;w.isTauri=true;w.__calls=[];w.__jobs=[];w.__notified=[];w.__installed=new Set<string>(installed);w.__focus=false;document.hasFocus=()=>w.__focus;w.__said=[];
 new MutationObserver(()=>{document.querySelectorAll('[aria-live="polite"],[role="status"]').forEach(e=>{const t=(e.textContent??'').trim();if(t&&!w.__said.includes(t))w.__said.push(t);});}).observe(document,{subtree:true,childList:true,characterData:true});
 if(done){w.__installed.add('whisper-small');w.__jobs=[{id:'old',kind:'model_download',project_id:null,payload:{model_id:'whisper-small'},status:'succeeded',progress:1,error:null,result:null,created_at:new Date().toISOString(),updated_at:new Date().toISOString()}];}
 w.__finish=(id:string)=>{const j=w.__jobs.find((x:any)=>x.payload.model_id===id);j.status='succeeded';j.progress=1;w.__installed.add(id);};
 w.__fail=(id:string)=>{const j=w.__jobs.find((x:any)=>x.payload.model_id===id);j.status='failed';j.error='Không đủ dung lượng ổ đĩa';};
 w.__TAURI_INTERNALS__={convertFileSrc:(p:string)=>p,transformCallback:()=>1,unregisterCallback:()=>{},metadata:{currentWindow:{label:'main'},currentWebview:{label:'main',windowLabel:'main'}},
  invoke:async(cmd:string,args:any)=>{w.__calls.push({cmd,args});switch(cmd){
   case 'plugin:window|is_focused':return w.__focus;
   case 'plugin:window|request_user_attention':return null;
   case 'plugin:notification|notify':w.__notified.push(args.options);return null;
   case 'download_model':{const t=new Date(Date.now()-60000).toISOString(),j={id:'dl-'+args.id,kind:'model_download',project_id:null,payload:{model_id:args.id},status:'running',progress:0.4,error:null,result:null,created_at:t,updated_at:t};w.__jobs=[j];return j;}
   case 'list_jobs':return JSON.parse(JSON.stringify(w.__jobs));
   case 'list_models':return Object.keys(names).map(id=>({id,name:names[id],engine:id==='whisper-small'?'stt':id==='vieneu-v3'?'tts':'runtime',kind:id==='separation-runtime'?'runtime':'model',installed:w.__installed.has(id),revision:'9f8e7d6c5b4a3921',license:'MIT',description:'Mô tả ngắn của model.'}));
   case 'list_projects':case 'list_voices':return [];case 'get_settings':return {dictionary:{}};
   case 'runtime_status':return {python_ready:true,ffmpeg_ready:true,worker_ready:true,python_path:null,ffmpeg_path:null,message:''};
   default:return null;}}};
};
const open=async(page:Page,done=false,names=NAMES,installed:string[]=[])=>{
 await page.addInitScript(mock,{names,done,installed});await page.goto('/');
 await page.getByRole('navigation',{name:'Điều hướng chính'}).getByRole('button',{name:'Model & cài đặt',exact:true}).click();
 await expect(page.locator('.model-card')).toHaveCount(Object.keys(names).length);
 await page.getByText('Thêm model',{exact:true}).click(); // the pack and every non-starter card sit in this fold
};
const ALL={...NAMES,...VIENEU};
const card=(page:Page,id:string)=>page.locator('.model-card').filter({has:page.getByRole('heading',{level:3,name:ALL[id],exact:true})});
const downloads=(page:Page)=>page.evaluate(()=>(window as any).__calls.filter((x:any)=>x.cmd==='download_model').map((x:any)=>x.args));
const finish=(page:Page,id:string)=>page.evaluate(i=>(window as any).__finish(i),id);
const fail=(page:Page,id:string)=>page.evaluate(i=>(window as any).__fail(i),id);
const said=(page:Page)=>page.evaluate(()=>((window as any).__said as string[]));
const live=(page:Page,text:string)=>page.locator('.sr-only[aria-live="polite"]').filter({hasText:text});
const stays=async(page:Page)=>{await expect(page.locator('main h1')).toContainText('Model & cài đặt');await expect(page.getByText('Công việc gần đây')).toHaveCount(0);};

test('one click on a model card starts the download, keeps the page, and shows the progress on the card',async({page})=>{
 await open(page);
 await card(page,'whisper-small').getByRole('button',{name:'Tải model',exact:true}).click();
 await expect.poll(()=>downloads(page)).toEqual([{id:'whisper-small'}]);
 await expect(card(page,'whisper-small').locator('progress')).toHaveJSProperty('value',0.4);
 await expect(card(page,'whisper-small').getByRole('button',{name:'Đang tải…',exact:true})).toBeDisabled();
 await expect(card(page,'separation-runtime').locator('progress')).toHaveCount(0);
 await stays(page);
});

test('when the download ends the live region says so, the card reads "Đã tải" and the page is still the same',async({page})=>{
 await open(page);
 await card(page,'whisper-small').getByRole('button',{name:'Tải model',exact:true}).click();
 await expect(card(page,'whisper-small').locator('progress')).toHaveCount(1);
 await expect(live(page,'Đã tải xong')).toHaveCount(0);
 await finish(page,'whisper-small');
 await expect(live(page,'Đã tải xong Whisper Small.')).toHaveCount(1,{timeout:10000});
 await expect(card(page,'whisper-small').getByRole('button',{name:'Đã tải',exact:true})).toBeDisabled();
 await expect(card(page,'whisper-small').locator('progress')).toHaveCount(0);
 await stays(page);
});

test('a download already finished when the app opens is not announced',async({page})=>{
 await open(page,true);
 await expect(card(page,'whisper-small').getByRole('button',{name:'Đã tải',exact:true})).toBeVisible();
 await page.waitForTimeout(3000);
 await expect(live(page,'Đã tải xong')).toHaveCount(0);
 expect((await said(page)).filter(t=>t.includes('Đã tải xong'))).toEqual([]); // the line clears itself after 6 s and toHaveCount(0) passes before the first poll, so the recorded texts are the proof
});

test('a long download that ends while the window is in the background raises the desktop notice with the model name',async({page})=>{
 test.setTimeout(60000);
 await open(page);
 await card(page,'whisper-small').getByRole('button',{name:'Tải model',exact:true}).click();
 await expect(card(page,'whisper-small').locator('progress')).toHaveCount(1);
 await finish(page,'whisper-small');
 await expect.poll(()=>page.evaluate(()=>(window as any).__notified),{timeout:10000}).toEqual([{title:'Đã tải model xong',body:'Whisper Small · 1 phút'}]);
});

test('the separation pack downloads in place after the licence is accepted',async({page})=>{
 await open(page);
 await card(page,'separation-runtime').getByRole('button',{name:'Tải gói',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'Tải gói chạy tách nhạc nền'});
 await dialog.getByRole('button',{name:'Đồng ý và tải'}).click();
 await expect(dialog).toHaveCount(0);
 await expect.poll(()=>downloads(page)).toEqual([{id:'separation-runtime',licenseAccepted:true}]);
 await expect(card(page,'separation-runtime').locator('progress')).toHaveJSProperty('value',0.4);
 await expect(card(page,'separation-runtime').getByRole('button',{name:'Đang tải…',exact:true})).toBeDisabled();
 await stays(page);
 await finish(page,'separation-runtime');
 await expect(live(page,'Đã tải xong Gói chạy tách nhạc nền (Python + PyTorch).')).toHaveCount(1,{timeout:10000});
 await stays(page);
});

test('after Enter on "Tải model" the focus stays on the card button while it downloads',async({page})=>{
 await open(page);
 const button=card(page,'whisper-small').locator('button.full');
 await button.focus();await page.keyboard.press('Enter');
 await expect.poll(()=>downloads(page)).toEqual([{id:'whisper-small'}]);
 await expect(card(page,'whisper-small').locator('progress')).toHaveCount(1);
 await expect(button).toBeFocused();
});

test('the focus stays on the card button when the download finishes and the card reads "Đã tải"',async({page})=>{
 await open(page);
 const button=card(page,'whisper-small').locator('button.full');
 await button.focus();await page.keyboard.press('Enter');
 await expect(card(page,'whisper-small').locator('progress')).toHaveCount(1);
 await finish(page,'whisper-small');
 await expect(button).toHaveAccessibleName('Đã tải',{timeout:10000});await expect(button).toBeDisabled();
 await expect(button).toBeFocused();
});

test('after "Đồng ý và tải" the focus goes back to the pack card button',async({page})=>{
 await open(page);
 await card(page,'separation-runtime').getByRole('button',{name:'Tải gói',exact:true}).click();
 await page.getByRole('dialog',{name:'Tải gói chạy tách nhạc nền'}).getByRole('button',{name:'Đồng ý và tải'}).click();
 await expect.poll(()=>downloads(page)).toEqual([{id:'separation-runtime',licenseAccepted:true}]);
 await expect(card(page,'separation-runtime').locator('progress')).toHaveCount(1);
 await expect(card(page,'separation-runtime').locator('button.full')).toBeFocused();
});

test('a download that fails shows the error on the page and the card offers the download again',async({page})=>{
 await open(page);
 await card(page,'whisper-small').getByRole('button',{name:'Tải model',exact:true}).click();
 await expect(card(page,'whisper-small').locator('progress')).toHaveCount(1);
 await fail(page,'whisper-small');
 await expect(page.getByRole('alert').filter({hasText:'Tải Whisper Small không thành công: Không đủ dung lượng ổ đĩa'})).toHaveCount(1,{timeout:10000});
 await expect(card(page,'whisper-small').getByRole('button',{name:'Tải model',exact:true})).toBeEnabled();
 expect((await said(page)).filter(t=>t.includes('Đã tải xong'))).toEqual([]);
 await stays(page);
});

test('a first-run VieNeu download is announced once, by the checklist step and not again as a download',async({page})=>{
 await open(page,false,VIENEU);
 await card(page,'vieneu-v3').getByRole('button',{name:'Tải model',exact:true}).click();
 await expect(card(page,'vieneu-v3').locator('progress')).toHaveCount(1);
 await finish(page,'vieneu-v3');
 await expect(card(page,'vieneu-v3').getByRole('button',{name:'Đã tải',exact:true})).toBeVisible({timeout:10000});
 await expect.poll(async()=>(await said(page)).some(t=>t.startsWith('Đã xong bước 1')),{timeout:10000}).toBe(true);
 expect((await said(page)).filter(t=>t.includes('Đã tải xong'))).toEqual([]);
});

test('"Kiểm tra lại gói" on an installed pack is a check, not a download, and is not announced as one',async({page})=>{
 await open(page,false,NAMES,['separation-runtime']);
 await card(page,'separation-runtime').getByRole('button',{name:'Kiểm tra lại gói',exact:true}).click();
 await expect.poll(()=>downloads(page)).toEqual([{id:'separation-runtime'}]);
 await expect(card(page,'separation-runtime').locator('progress')).toHaveCount(1);
 await finish(page,'separation-runtime');
 await expect(card(page,'separation-runtime').locator('progress')).toHaveCount(0,{timeout:10000});
 expect((await said(page)).filter(t=>t.includes('Đã tải xong'))).toEqual([]);
});

const PACK='Gói chạy tách nhạc nền (Python + PyTorch)';
test('a re-check of an installed pack reads "Đang kiểm tra…" on the button and the progress line, never "Đang tải…" or a percentage',async({page})=>{
 await open(page,false,NAMES,['separation-runtime']);
 await card(page,'separation-runtime').getByRole('button',{name:'Kiểm tra lại gói',exact:true}).click();
 await expect(card(page,'separation-runtime').getByRole('button',{name:'Đang kiểm tra…',exact:true})).toBeDisabled();
 await expect(card(page,'separation-runtime').locator('.job-progress')).toHaveText('Đang kiểm tra…');
 await expect(card(page,'separation-runtime').getByRole('button',{name:'Đang tải…'})).toHaveCount(0);
});

test('a re-check that ends is announced as "Đã kiểm tra xong {name}." and not as a download',async({page})=>{
 await open(page,false,NAMES,['separation-runtime']);
 await card(page,'separation-runtime').getByRole('button',{name:'Kiểm tra lại gói',exact:true}).click();
 await expect(card(page,'separation-runtime').locator('progress')).toHaveCount(1);
 await finish(page,'separation-runtime');
 await expect(live(page,`Đã kiểm tra xong ${PACK}.`)).toHaveCount(1,{timeout:10000});
 expect((await said(page)).filter(t=>t.includes('Đã tải xong'))).toEqual([]);
});

test('a re-check that fails reads "Kiểm tra {name} không thành công: {error}", not the download wording',async({page})=>{
 await open(page,false,NAMES,['separation-runtime']);
 await card(page,'separation-runtime').getByRole('button',{name:'Kiểm tra lại gói',exact:true}).click();
 await expect(card(page,'separation-runtime').locator('progress')).toHaveCount(1);
 await fail(page,'separation-runtime');
 await expect(page.getByRole('alert').filter({hasText:`Kiểm tra ${PACK} không thành công: Không đủ dung lượng ổ đĩa`})).toHaveCount(1,{timeout:10000});
 await expect(page.getByRole('alert').filter({hasText:'Tải '})).toHaveCount(0);
});

test('a real download still reads "Đang tải…" with a percentage and ends with "Đã tải xong {name}."',async({page})=>{
 await open(page);
 await card(page,'whisper-small').getByRole('button',{name:'Tải model',exact:true}).click();
 await expect(card(page,'whisper-small').getByRole('button',{name:'Đang tải…',exact:true})).toBeDisabled();
 await expect(card(page,'whisper-small').locator('.job-progress')).toContainText('40 %');
 await finish(page,'whisper-small');
 await expect(live(page,'Đã tải xong Whisper Small.')).toHaveCount(1,{timeout:10000});
});

test('two announcements from one poll both reach the live region, and a later one replaces them',async({page})=>{
 test.setTimeout(60000);
 await open(page,false,NAMES,['separation-runtime']);
 await card(page,'whisper-small').getByRole('button',{name:'Tải model',exact:true}).click();
 await expect(card(page,'whisper-small').locator('progress')).toHaveCount(1);
 // a re-check of the pack runs beside the download; both end between two polls
 await page.evaluate(()=>{const w=window as any,t=new Date(Date.now()-60000).toISOString();w.__jobs.push({id:'dl-separation-runtime',kind:'model_download',project_id:null,payload:{model_id:'separation-runtime'},status:'running',progress:0.4,error:null,result:null,created_at:t,updated_at:t});});
 await expect(card(page,'separation-runtime').locator('.job-progress')).toHaveText('Đang kiểm tra…',{timeout:10000});
 await page.evaluate(()=>{const w=window as any;for(const j of w.__jobs){j.status='succeeded';j.progress=1;w.__installed.add(j.payload.model_id);}});
 const region=page.locator('.sr-only[aria-live="polite"]');
 await expect(region).toHaveText(`Đã tải xong Whisper Small. Đã kiểm tra xong ${PACK}.`,{timeout:10000});
 await page.waitForTimeout(1200);
 await card(page,'separation-runtime').getByRole('button',{name:'Kiểm tra lại gói',exact:true}).click();
 await expect(card(page,'separation-runtime').locator('progress')).toHaveCount(1);
 await finish(page,'separation-runtime');
 await expect(region).toHaveText(`Đã kiểm tra xong ${PACK}.`,{timeout:10000});
});
