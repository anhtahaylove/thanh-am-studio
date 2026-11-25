import {test,expect,type Page} from '@playwright/test';
// The take-check chip opens a diff dialog: the sent script aligned against what Whisper heard, the hard mismatches, and a form that writes one
// entry into the project dictionary (never a job, never a take). Tauri is mocked; jobs and enqueued calls are recorded.
type Setup={text?:string;sent?:string|null;heard?:string;mismatches?:{expected:string;heard:string;soft:boolean}[];dictionary?:Record<string,string>;appDictionary?:Record<string,string>;model?:boolean;twoSegments?:boolean;noCheck?:boolean};
const wav=()=>{const rate=8000,n=rate,b=Buffer.alloc(44+n*2);b.write('RIFF',0);b.writeUInt32LE(36+n*2,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(rate,24);b.writeUInt32LE(rate*2,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(n*2,40);for(let i=0;i<n;i++)b.writeInt16LE(Math.round(Math.sin(i/rate*2*Math.PI*440)*3000),44+i*2);return b;};
const mock=(o:Required<Setup>)=>{
 const w=window as any,calls:any[]=[];w.isTauri=true;w.__calls=calls;w.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};
 const words=o.heard.split(/\s+/).filter(Boolean).map((text,i)=>({text,start_ms:i*300}));
 const take={id:'t1',asset_id:'a1',path:'/t1.wav',duration_ms:1000,sample_rate:8000,created_at:'2026-11-22T00:00:00Z',...(o.noCheck?{}:{check:{model:'whisper-small',wer:.2,heard:o.heard,mismatches:o.mismatches,words}})};
 const seg=(id:string,text:string,takes:any[])=>({id,text,normalized_text:text,voice_id:null,speaker:'Người dẫn',gap_ms:300,takes,selected_take_id:takes[0]?.id??null,trim_start_ms:0,trim_end_ms:null,fade_in_ms:0,fade_out_ms:0,gain_db:0});
 let project:any={id:'p1',name:'Đối chiếu',updated_at:'2026-11-22T00:00:00Z',revision:1,segments:[seg('1',o.text,[take]),...(o.twoSegments?[seg('2','Đoạn hai không có kiểm tra.',[{id:'t2',asset_id:'a2',path:'/t1.wav',duration_ms:1000,sample_rate:8000,created_at:'2026-11-22T00:00:00Z'}])]:[])],transcript:[],dictionary:o.dictionary,source_asset_id:null};
 const jobs=o.sent===null?[]:[{id:'j1',kind:'tts',project_id:'p1',payload:{segment_id:'1',text:o.sent,voice_id:null,speed:1},status:'succeeded',progress:1,error:null,result:{asset_id:'a1',duration_ms:1000,check:take.check},created_at:'2026-11-22T00:00:00Z',updated_at:'2026-11-22T00:00:01Z'}];
 w.__TAURI_INTERNALS__={convertFileSrc:(p:string)=>p,transformCallback:()=>1,unregisterCallback:()=>{},metadata:{currentWindow:{label:'main'},currentWebview:{label:'main',windowLabel:'main'}},
  invoke:async(cmd:string,args:any)=>{calls.push({cmd,args});switch(cmd){
   case 'list_projects':return [project];case 'load_project':return JSON.parse(JSON.stringify(project));case 'list_voices':return [];case 'get_settings':return {dictionary:o.appDictionary};
   case 'list_models':return o.model?[{id:'vieneu-v3',name:'VieNeu v3 Turbo',engine:'tts',installed:true,revision:'r',license:'Apache-2.0',description:''}]:[];
   case 'list_jobs':return JSON.parse(JSON.stringify(jobs));
   case 'runtime_status':return {python_ready:true,ffmpeg_ready:true,worker_ready:true,python_path:null,ffmpeg_path:null,message:''};
   case 'save_project':project={...args.project,revision:args.project.revision+1};return project;
   case 'enqueue_job':return {id:'j2',kind:args.kind,project_id:args.projectId,payload:args.payload,status:'queued',progress:0,error:null,result:null,created_at:'2026-11-22T00:00:02Z',updated_at:'2026-11-22T00:00:02Z'};
   default:return null;}}};
};
const SETUP:Required<Setup>={text:'Ký tên vào đây.',sent:'Ký tên vào đây.',heard:'kí tên vào đây',mismatches:[{expected:'ký',heard:'kí',soft:false}],dictionary:{},appDictionary:{},model:true,twoSegments:false,noCheck:false};
const open=async(page:Page,o:Setup={},width=1440)=>{
 await page.setViewportSize({width,height:900});await page.route('**/t1.wav',r=>r.fulfill({body:wav(),contentType:'audio/wav'}));
 await page.addInitScript(mock,{...SETUP,...o});await page.goto('/');
 await page.getByRole('button',{name:'Dự án',exact:true}).click();await page.getByRole('button',{name:'Mở dự án',exact:true}).click();
 await expect(page.getByRole('textbox',{name:'Nội dung đoạn 1'})).toBeVisible();
};
const chip=(page:Page)=>page.locator('.segment .take-check').first();
const dialog=(page:Page)=>page.getByRole('dialog');
const calls=(page:Page,cmd:string)=>page.evaluate((c:string)=>(window as any).__calls.filter((x:any)=>x.cmd===c).map((x:any)=>x.args),cmd);
const form=(page:Page,i=0)=>dialog(page).locator(`[data-form="${i}"]`);
const keyBox=(page:Page,i=0)=>form(page,i).getByLabel('Từ trong kịch bản');
const valueBox=(page:Page,i=0)=>form(page,i).getByLabel('Cách đọc mới');
const addBtn=(page:Page,i=0)=>form(page,i).getByRole('button',{name:'Thêm vào từ điển'});
const projectDictionary=async(page:Page)=>{await page.getByRole('button',{name:'Từ điển phát âm'}).click();const t=await page.locator('.dictionary-row').allInnerTexts();await page.getByRole('button',{name:'Từ điển phát âm'}).click();return t.map(x=>x.replace(/\s+/g,' ').trim());};

test('the chip is a button that opens the dialog with Enter, and the page behind goes inert',async({page})=>{
 await open(page);await expect(chip(page)).toHaveAttribute('aria-haspopup','dialog');expect(await chip(page).evaluate(e=>e.tagName)).toBe('BUTTON');
 await expect(chip(page)).toHaveText(/^Có thể đọc sai: “ký” → “kí”/);
 await chip(page).focus();await page.keyboard.press('Enter');
 await expect(dialog(page)).toBeVisible();await expect(dialog(page).getByRole('heading',{level:3})).toHaveText('Whisper nghe khác kịch bản');
 expect(await page.locator('main').evaluate(e=>!!e.closest('[inert]'))).toBe(true);
});

test('an ok chip opens "Khớp kịch bản" with no form, and focus starts on Đóng',async({page})=>{
 await open(page,{mismatches:[],heard:'ký tên vào đây'});await expect(chip(page)).toHaveText('Khớp kịch bản');await chip(page).click();
 await expect(dialog(page).getByRole('heading',{level:3})).toHaveText('Khớp kịch bản');await expect(dialog(page).locator('form')).toHaveCount(0);await expect(dialog(page).getByRole('button',{name:'Đóng'})).toBeFocused();
});

test('a segment with a checked take adds one tab stop, the chip; one without adds none',async({page})=>{
 await open(page,{twoSegments:true});await expect(page.locator('.segment')).toHaveCount(2);
 await page.getByRole('textbox',{name:'Nhân vật đoạn 1'}).focus();await page.keyboard.press('Tab');await expect(chip(page)).toBeFocused();
 await page.getByRole('textbox',{name:'Nhân vật đoạn 2'}).focus();await page.keyboard.press('Tab');expect(await page.evaluate(()=>document.activeElement?.classList.contains('take-check'))).toBe(false);
});

test('the dialog compares the text the take was made from, or says it is gone',async({page})=>{
 await open(page,{text:'Ký tên vào đây nhé.',sent:'Ký tên vào đây.'});await chip(page).click();
 await expect(dialog(page).locator('.diff-script')).toHaveText('Ký (nghe khác) tên vào đây '); // the word Whisper heard as "kí" is marked, the script has no "nhé"
 await expect(dialog(page)).not.toContainText('không còn văn bản đã gửi');await expect(dialog(page).getByRole('heading',{name:'Kịch bản đã gửi'})).toBeVisible();
 await page.keyboard.press('Escape');await expect(dialog(page)).toHaveCount(0);
});
test('without the job that made the take, it falls back to the current script and says so',async({page})=>{
 await open(page,{text:'Ký tên vào đây nhé.',sent:null});await chip(page).click();
 await expect(dialog(page)).toContainText('So với kịch bản hiện tại: không còn văn bản đã gửi lúc tạo take này');await expect(dialog(page).locator('.diff-script')).toHaveText('Ký (nghe khác) tên vào đây nhé ');await expect(dialog(page).getByRole('heading',{name:'Kịch bản hiện tại'})).toBeVisible();
});

test('missed words are marked by weight and an underline, and by text for a screen reader',async({page})=>{
 await open(page,{heard:'kí tên đây',mismatches:[{expected:'vào',heard:'',soft:false}]});await chip(page).click();
 const miss=dialog(page).locator('.diff-word.miss');await expect(miss).toHaveCount(1);await expect(miss.first()).toContainText('vào');await expect(miss.first().locator('.sr-only')).toHaveText('(không nghe thấy)');
 const css=await miss.first().evaluate(e=>{const c=getComputedStyle(e);return {w:c.fontWeight,d:c.textDecorationLine};});expect(Number(css.w)).toBeGreaterThanOrEqual(700);expect(css.d).toContain('underline');
});

test('the key is prefilled with the script spelling; a reading changes the preview and enables the button',async({page})=>{
 await open(page);await chip(page).click();
 await expect(keyBox(page)).toHaveValue('Ký');await expect(keyBox(page)).toBeFocused();
 await expect(addBtn(page)).toBeDisabled();await expect(form(page)).toContainText('Nhập cách đọc');
 await expect(valueBox(page)).toHaveAttribute('placeholder','ví dụ: kí');
 await valueBox(page).fill('Kí');
 await expect(form(page).locator('.diff-preview')).toHaveText(/Xem trước: Kí \(đã đổi\) tên vào đây\./);await expect(form(page).locator('.diff-preview mark')).toHaveText('Kí (đã đổi)');
 await expect(addBtn(page)).toBeEnabled();
});

test('adding writes one project dictionary entry, shows an in-dialog Undo that removes it, keeps focus in the dialog and enqueues nothing',async({page})=>{
 await open(page);await chip(page).click();await valueBox(page).fill('Kí');await addBtn(page).click();
 await expect(dialog(page).getByRole('status')).toHaveText('Đã thêm “Ký” → “Kí” vào từ điển dự án.');
 await expect(keyBox(page)).toBeFocused();await expect(addBtn(page)).toBeDisabled();await expect(form(page)).toContainText('Từ điển đã có mục này');
 await expect(dialog(page)).toContainText('Từ điển chỉ áp dụng cho lần tạo sau. Bấm Tạo take mới rồi nghe lại để kiểm tra cách đọc.');
 await dialog(page).getByRole('button',{name:'Hoàn tác'}).click();
 await expect(dialog(page).getByRole('status')).toHaveText('Đã hoàn tác mục “Ký” → “Kí”.');await expect(keyBox(page)).toBeFocused();await expect(dialog(page).getByRole('button',{name:'Hoàn tác'})).toHaveCount(0);
 await expect(dialog(page)).toBeVisible();expect((await calls(page,'enqueue_job')).length).toBe(0);
 await page.keyboard.press('Escape');expect(await projectDictionary(page)).toEqual([]);
});

test('the entry is one undo step on the page, and a job is never enqueued by adding it',async({page})=>{
 await open(page);await chip(page).click();await valueBox(page).fill('Kí');await addBtn(page).click();await expect(dialog(page).getByRole('status')).toContainText('Đã thêm');
 await dialog(page).getByRole('button',{name:'Đóng'}).click();await expect(dialog(page)).toHaveCount(0);
 expect(await projectDictionary(page)).toEqual(['Ký → Kí']);
 await page.getByRole('heading',{level:1}).click();await page.keyboard.press('Control+z');
 expect(await projectDictionary(page)).toEqual([]);expect((await calls(page,'enqueue_job')).length).toBe(0);
});

test('Enter in the reading field submits the form, and a key that matches nothing keeps the button disabled with the reason',async({page})=>{
 await open(page);await chip(page).click();await valueBox(page).fill('Kí');await valueBox(page).press('Enter');
 await expect(dialog(page).getByRole('status')).toContainText('Đã thêm “Ký” → “Kí”');
 await keyBox(page).fill('zzz');await expect(addBtn(page)).toBeDisabled();await expect(form(page)).toContainText('Mục này không khớp chữ nào trong đoạn');
 await expect(addBtn(page)).toHaveAttribute('aria-describedby',/diff-why-0/);
});

test('Escape and Đóng return focus to the chip; Escape during IME composition does not close',async({page})=>{
 await open(page);await chip(page).focus();await page.keyboard.press('Enter');await expect(dialog(page)).toBeVisible();
 await keyBox(page).evaluate(e=>e.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',isComposing:true,bubbles:true,cancelable:true})));await page.waitForTimeout(200);await expect(dialog(page)).toBeVisible();
 await page.keyboard.press('Escape');await expect(dialog(page)).toHaveCount(0);await expect(chip(page)).toBeFocused();
 await chip(page).click();await dialog(page).getByRole('button',{name:'Đóng'}).click();await expect(chip(page)).toBeFocused();
});

test('an extra heard word has no form, only a line saying what Whisper added',async({page})=>{
 await open(page,{heard:'ký tên vào đây đây',mismatches:[{expected:'',heard:'đây',soft:false}]});await chip(page).click();
 await expect(dialog(page).locator('form')).toHaveCount(0);await expect(dialog(page)).toContainText('Whisper nghe thêm: “đây”');await expect(dialog(page).getByRole('button',{name:'Đóng'})).toBeFocused();
});

test('a word a rule or a dictionary entry rewrote has no prefill and the hint names the cause',async({page})=>{
 await open(page,{text:'Nặng 12 kg.',sent:'Nặng 12 ki lô gam.',heard:'nặng 12 ký',mismatches:[{expected:'ki lô gam',heard:'ký',soft:false}]});await chip(page).click();
 await expect(keyBox(page)).toHaveValue('');await expect(form(page)).toContainText('“ki lô gam” do quy tắc chuẩn hóa văn bản tạo ra từ “kg”');
 await page.keyboard.press('Escape');
});
test('a dictionary reading is traced back to its entry',async({page})=>{
 await open(page,{text:'Họp HTX sáng nay.',sent:'Họp hợp tác xã sáng nay.',dictionary:{HTX:'hợp tác xã'},heard:'họp htx sáng nay',mismatches:[{expected:'hợp tác xã',heard:'htx',soft:false}]});await chip(page).click();
 await expect(keyBox(page)).toHaveValue('');await expect(form(page)).toContainText('“hợp tác xã” đến từ mục từ điển “HTX”: sửa mục đó trong Từ điển phát âm');
});

test('Tạo take mới enqueues exactly one job and closes the dialog; it is disabled with the reason when generating is blocked',async({page})=>{
 await open(page);await chip(page).click();expect((await calls(page,'enqueue_job')).length).toBe(0);
 await dialog(page).getByRole('button',{name:'Tạo take mới'}).click();await expect(dialog(page)).toHaveCount(0);
 const jobs=await calls(page,'enqueue_job');expect(jobs.length).toBe(1);expect(jobs[0].payload.text).toBe('Ký tên vào đây.');await expect(chip(page)).toBeFocused();
});
test('without a voice model Tạo take mới is disabled and says why',async({page})=>{
 await open(page,{model:false});await chip(page).click();const b=dialog(page).getByRole('button',{name:'Tạo take mới'});await expect(b).toBeDisabled();await expect(b).toHaveAttribute('title',/model giọng đọc/);
});

test('Nghe take này plays the take',async({page})=>{
 await open(page);await chip(page).click();await dialog(page).getByRole('button',{name:'Nghe take này'}).click();
 await expect(page.locator('.play-button')).toHaveAccessibleName('Dừng nghe thử');
});

test('digits typed in the dialog fields are text, not take keys',async({page})=>{
 await open(page);await chip(page).click();await keyBox(page).fill('');await keyBox(page).press('2');await expect(keyBox(page)).toHaveValue('2');await expect(page.locator('.play-button')).toHaveAccessibleName('Nghe thử đoạn');
});

for(const width of [1440,800,640])test(`the dialog fits at ${width} px: no sideways scroll, every control inside it`,async({page})=>{
 await open(page,{heard:'kí tên đây',mismatches:[{expected:'ký',heard:'kí',soft:false},{expected:'vào',heard:'',soft:false},{expected:'',heard:'đây',soft:false}]},width);await chip(page).click();await expect(dialog(page)).toBeVisible();await valueBox(page,0).fill('Kí');
 const m=await page.evaluate(()=>{const d=document.querySelector('[role=dialog]')!.getBoundingClientRect(),el=document.documentElement;
  const inner=[...document.querySelectorAll('[role=dialog] button,[role=dialog] input,[role=dialog] small,[role=dialog] .diff-preview')].map(b=>b.getBoundingClientRect());
  return {over:el.scrollWidth-el.clientWidth,right:Math.max(...inner.map(r=>r.right)),left:Math.min(...inner.map(r=>r.left)),dRight:d.right,dLeft:d.left,top:d.top,bottom:d.bottom,vh:innerHeight,vw:innerWidth};});
 expect(m.over).toBeLessThanOrEqual(0);expect(m.right).toBeLessThanOrEqual(m.dRight+0.5);expect(m.left).toBeGreaterThanOrEqual(m.dLeft-0.5);expect(m.dRight).toBeLessThanOrEqual(m.vw);expect(m.dLeft).toBeGreaterThanOrEqual(0);expect(m.top).toBeGreaterThanOrEqual(0);expect(m.bottom).toBeLessThanOrEqual(m.vh);
});

test('a soft mismatch is neither marked nor listed: the dialog agrees with its "Khớp kịch bản" title',async({page})=>{
 await open(page,{text:'Trời hôm nay đẹp.',sent:'Trời hôm nay đẹp.',heard:'chời hôm nay đẹp',mismatches:[{expected:'trời',heard:'chời',soft:true}]});
 await expect(chip(page)).toHaveText('Khớp kịch bản');await chip(page).click();await expect(dialog(page).getByRole('heading',{level:3})).toHaveText('Khớp kịch bản');await expect(dialog(page).locator('.diff-word.miss')).toHaveCount(0);
});

test('a word heard as something else reads "nghe khác", visibly and for a screen reader',async({page})=>{
 await open(page);await chip(page).click();const miss=dialog(page).locator('.diff-word.miss');await expect(miss).toHaveCount(1);await expect(miss.locator('.sr-only')).toHaveText('(nghe khác)');
});

test('a long chip label is cut at its end with an ellipsis, not at its start',async({page})=>{
 await open(page,{text:'Trân trọng kính chào, hàng hóa đã về, nhận đi.',sent:'Trân trọng kính chào, hàng hóa đã về, nhận đi.',heard:'chân chọng kính chào hàn hoa đã về',mismatches:[{expected:'trân trọng',heard:'chân chọng',soft:false},{expected:'hàng hóa',heard:'hàn hoa',soft:false},{expected:'nhận đi',heard:'',soft:false}]});
 const m=await chip(page).evaluate(b=>{const r=document.createRange();r.selectNodeContents(b);const c=b.getBoundingClientRect(),t=r.getBoundingClientRect();return {over:b.scrollWidth>b.clientWidth,ellipsis:getComputedStyle(b).textOverflow,textLeft:t.left,chipLeft:c.left,display:getComputedStyle(b).display};});
 expect(m.over).toBe(true);expect(m.ellipsis).toBe('ellipsis');expect(m.display).toBe('block');expect(m.textLeft).toBeGreaterThanOrEqual(m.chipLeft);
});

test('an existing project entry with the same key is replaced openly: the hint before, "Đã thay" after, and Undo brings the old reading back',async({page})=>{
 await open(page,{dictionary:{'Ký':'Kê'}});await chip(page).click();await valueBox(page).fill('Kí');
 await expect(form(page)).toContainText('Thay mục hiện có “Ký” → “Kê”');await expect(addBtn(page)).toHaveText('Thêm vào từ điển');
 expect(await addBtn(page).getAttribute('aria-describedby')).toContain('diff-replace-0');
 await addBtn(page).click();await expect(dialog(page).getByRole('status')).toHaveText('Đã thay “Ký” → “Kí” trong từ điển dự án.');
 await dialog(page).getByRole('button',{name:'Hoàn tác'}).click();await expect(dialog(page).getByRole('status')).toHaveText('Đã hoàn tác mục “Ký” → “Kí”.');
 await page.keyboard.press('Escape');expect(await projectDictionary(page)).toEqual(['Ký → Kê']);
});
test('a key with no entry yet gets no replace hint and the status says "Đã thêm"',async({page})=>{
 await open(page);await chip(page).click();await valueBox(page).fill('Kí');await expect(form(page)).not.toContainText('Thay mục hiện có');await addBtn(page).click();await expect(dialog(page).getByRole('status')).toContainText('Đã thêm');
});
test('an inherited object key such as "constructor" is not an existing entry: no replace hint, "Đã thêm"',async({page})=>{
 await open(page,{text:'Ký constructor vào đây.',sent:'Ký constructor vào đây.',heard:'kí constructor vào đây'});await chip(page).click();await keyBox(page).fill('constructor');await valueBox(page).fill('kơn');
 await expect(form(page)).not.toContainText('Thay mục hiện có');expect(await addBtn(page).getAttribute('aria-describedby')??'').not.toContain('diff-replace-0');
 await addBtn(page).click();await expect(dialog(page).getByRole('status')).toContainText('Đã thêm');
});
test('an entry only in the app dictionary is not a project entry: no replace hint, "Đã thêm", and the project dictionary gets the new reading',async({page})=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(String(e)));
 await open(page,{appDictionary:{'Ký':'Kê'}});await chip(page).click();await valueBox(page).fill('Kí');
 await expect(form(page)).not.toContainText('Thay mục hiện có');expect(await addBtn(page).getAttribute('aria-describedby')??'').not.toContain('diff-replace-0');
 await addBtn(page).click();await expect(dialog(page).getByRole('status')).toContainText('Đã thêm');
 await page.keyboard.press('Escape');expect(await projectDictionary(page)).toEqual(['Ký → Kí']);expect(errors).toEqual([]);
});
test('the key "__proto__" is a plain key: no replace hint, "Đã thêm", and the entry is kept in the project dictionary',async({page})=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(String(e)));
 await open(page,{text:'Ký __proto__ vào đây.',sent:'Ký __proto__ vào đây.',heard:'kí __proto__ vào đây'});await chip(page).click();await keyBox(page).fill('__proto__');await valueBox(page).fill('prô-tô');
 await expect(form(page)).not.toContainText('Thay mục hiện có');expect(await addBtn(page).getAttribute('aria-describedby')??'').not.toContain('diff-replace-0');
 await addBtn(page).click();await expect(dialog(page).getByRole('status')).toContainText('Đã thêm');
 await page.keyboard.press('Escape');expect(await projectDictionary(page)).toEqual(['__proto__ → prô-tô']);expect(errors).toEqual([]);
});

test('focus returns to the chip after an add, with Escape and with Đóng',async({page})=>{
 await open(page);await chip(page).click();await valueBox(page).fill('Kí');await addBtn(page).click();await expect(dialog(page).getByRole('status')).toContainText('Đã thêm');
 await page.keyboard.press('Escape');await expect(dialog(page)).toHaveCount(0);await expect(chip(page)).toBeFocused();
 await chip(page).click();await dialog(page).getByRole('button',{name:'Đóng'}).click();await expect(dialog(page)).toHaveCount(0);await expect(chip(page)).toBeFocused();
});
