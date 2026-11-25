import {test,expect,type Page} from '@playwright/test';
const KEY='thanh-am-preview-projects-v1';
const seed=async(page:Page,project:object)=>{await page.goto('/');await page.evaluate(([k,p])=>localStorage.setItem(k,JSON.stringify([p])),[KEY,project] as const);await page.reload();await page.getByRole('button',{name:'Dự án',exact:true}).click();await page.getByRole('button',{name:'Mở dự án',exact:true}).click();};
test('Ctrl+Z in a dialog or a side field undoes that text only, and still undoes the script from the script',async({page})=>{
 await page.goto('/');await page.getByRole('button',{name:'Viết đoạn đầu tiên'}).click();
 const first=page.getByRole('textbox',{name:'Nội dung đoạn 1'});await first.click();await page.keyboard.type('Một hai');await expect(first).toHaveValue('Một hai');await expect(page.getByRole('button',{name:'Đã lưu'})).toBeVisible();
 await page.getByRole('button',{name:'Thêm nội dung',exact:true}).click();const box=page.getByRole('textbox',{name:'Nội dung cần thêm'});await box.click();await page.keyboard.type('ab');
 // Chromium keeps one native undo stack per page: extra presses must not walk back into the script behind the dialog.
 for(let i=0;i<5;i++)await page.keyboard.press('Control+z');await expect(box).toHaveValue('');await expect(box).toBeFocused();await expect(first).toHaveValue('Một hai');await expect(page.locator('article.segment')).toHaveCount(1);await page.keyboard.press('Escape');
 await page.getByRole('button',{name:'Từ điển phát âm'}).click();const word=page.getByRole('textbox',{name:'Từ gốc'});await word.click();await page.keyboard.type('UBND');
 for(let i=0;i<3;i++)await page.keyboard.press('Control+z');await expect(word).toBeFocused();await expect(first).toHaveValue('Một hai');
 await first.focus();await page.keyboard.press('Control+z');await expect(first).not.toHaveValue('Một hai');
});
test('a time field keeps what is typed as a draft: 0:10,000 over 0:09,100 is 10000 ms, not 91000000',async({page})=>{
 await seed(page,{id:'p1',name:'Mốc giờ',updated_at:new Date().toISOString(),revision:1,segments:[],transcript:[{id:'r1',start_ms:4300,end_ms:9100,text:'Một câu'}],dictionary:{},source_asset_id:null});
 await page.getByRole('button',{name:'Chép lời',exact:true}).click();
 await page.locator('.tr-time').click();const end=page.getByLabel('Kết thúc');await end.press('Control+a');await page.keyboard.type('0:1');
 await expect(end).toHaveAttribute('aria-invalid','true');await expect(end).toHaveAccessibleDescription('Bắt đầu phải nhỏ hơn kết thúc.');await expect(end).toHaveAccessibleName('Kết thúc');await expect(page.getByRole('alert')).toHaveCount(0);
 await page.keyboard.type('0,000');await expect(end).not.toHaveAttribute('aria-invalid');await end.press('Enter');await expect(page.locator('.tr-time')).toHaveText('0:04,300 – 0:10,000');
 await expect.poll(()=>page.evaluate(k=>JSON.parse(localStorage.getItem(k)!)[0].transcript[0].end_ms,KEY)).toBe(10000);
 await page.locator('.tr-time').click();await end.press('Control+a');await page.keyboard.type('0:11,000');await expect(end).toHaveValue('0:11,000');await end.press('Escape');await expect(page.locator('.tr-time')).toHaveText('0:04,300 – 0:10,000');
 await page.locator('.tr-time').click();await end.press('Control+a');await page.keyboard.type('-');await end.blur();await expect(end).toHaveAttribute('aria-invalid','true');await expect(page.getByText('Nhập dạng phút:giây, ví dụ 0:09,200')).toBeVisible();
});
test('Ctrl+S in a number field saves what is typed there',async({page})=>{
 await page.goto('/');await page.getByRole('button',{name:'Viết đoạn đầu tiên'}).click();await expect(page.getByRole('button',{name:'Đã lưu'})).toBeVisible();
 const gap=page.getByLabel('Nghỉ sau (ms)');await gap.click();await gap.press('Control+a');await page.keyboard.type('777');await page.keyboard.press('Control+s');
 await expect.poll(()=>page.evaluate(k=>JSON.parse(localStorage.getItem(k)!)[0].segments[0].gap_ms,KEY),{timeout:2000}).toBe(777);await expect(gap).toHaveValue('777');
});
test('moving focus into a segment selects it, so the inspector follows the keyboard',async({page})=>{
 await page.goto('/');await page.getByRole('button',{name:'Thêm nội dung',exact:true}).click();await page.getByRole('textbox',{name:'Nội dung cần thêm'}).fill('Một.\nHai.\nBa.');await page.getByRole('button',{name:/^Thêm \d+ đoạn vào kịch bản$/}).click();
 const segments=page.locator('article.segment');await page.getByRole('textbox',{name:'Nội dung đoạn 2'}).click();await expect(segments.nth(1)).toHaveClass(/selected/);
 await page.getByRole('textbox',{name:'Nội dung đoạn 3'}).focus();await expect(segments.nth(2)).toHaveClass(/selected/);await expect(segments.nth(1)).not.toHaveClass(/selected/);
 // A mouse click on a button of another segment must still act: selecting on mouse focus would move the emotion bar under the pointer.
 await page.getByRole('textbox',{name:'Nội dung đoạn 1'}).click();await segments.nth(2).getByRole('button',{name:'Đưa đoạn lên'}).click();
 await expect(page.getByRole('textbox',{name:'Nội dung đoạn 2'})).toHaveValue('Ba.');await expect(page.getByRole('textbox',{name:'Nội dung đoạn 3'})).toHaveValue('Hai.');
 const third=page.getByRole('textbox',{name:'Nội dung đoạn 3'});await page.getByRole('textbox',{name:'Nội dung đoạn 1'}).click();await third.click();await expect(segments.nth(2)).toHaveClass(/selected/);
 expect(await third.evaluate((el:HTMLTextAreaElement)=>el.selectionStart===el.selectionEnd)).toBe(true);
});
test('disabled generate and export buttons say why',async({page})=>{
 await page.goto('/');
 await expect(page.getByRole('button',{name:'SRT',exact:true})).toHaveAttribute('title','Thêm ít nhất một đoạn');
 await page.getByRole('button',{name:'Viết đoạn đầu tiên'}).click();
 await expect(page.getByRole('button',{name:'Tạo giọng tất cả'})).toHaveAttribute('title','Cần bản desktop để tạo giọng');
 await expect(page.getByRole('button',{name:'Xuất audio'})).toHaveAttribute('title','Cần bản desktop để xuất audio');
});
test('desktop generation waits for the VieNeu model and says where to get it',async({page})=>{
 await page.addInitScript(()=>{
  const w=window as any;w.isTauri=true;w.__voice=false;w.__jobs=[];
  const seg=(id:string)=>({id,text:'Câu '+id+'.',normalized_text:'Câu '+id+'.',voice_id:null,speaker:'Người dẫn',gap_ms:300,takes:[],selected_take_id:null,trim_start_ms:0,trim_end_ms:null,fade_in_ms:0,fade_out_ms:0,gain_db:0});
  const project={id:'p1',name:'Chưa có model',updated_at:new Date().toISOString(),revision:1,segments:[seg('1'),seg('2')],transcript:[],dictionary:{},source_asset_id:null};
  w.__TAURI_INTERNALS__={convertFileSrc:(p:string)=>p,transformCallback:()=>1,unregisterCallback:()=>{},metadata:{currentWindow:{label:'main'},currentWebview:{label:'main',windowLabel:'main'}},
   invoke:async(cmd:string,args:any)=>{switch(cmd){case 'list_projects':return [project];case 'load_project':return project;case 'save_project':return {...args.project,revision:args.project.revision+1};case 'list_jobs':case 'list_voices':return [];case 'get_settings':return {dictionary:{}};
    case 'enqueue_job':w.__jobs.push(args.payload.segment_id);return {id:'j'+w.__jobs.length};case 'list_models':return [{id:'vieneu-v3',name:'VieNeu v3 Turbo',engine:'tts',installed:w.__voice,revision:'r',license:'Apache-2.0',description:''},{id:'whisper-small',name:'Whisper Small',engine:'stt',installed:true,revision:'r',license:'MIT',description:''}];
    case 'runtime_status':return {python_ready:true,ffmpeg_ready:true,worker_ready:true,python_path:null,ffmpeg_path:null,message:''};default:return null;}}};
 });
 await page.goto('/');await page.getByRole('button',{name:'Dự án',exact:true}).click();await page.getByRole('button',{name:'Mở dự án',exact:true}).click();
 const all=page.getByRole('button',{name:'Tạo giọng tất cả'}),one=page.getByRole('button',{name:'Tạo giọng',exact:true}).first(),reason='Tải VieNeu v3 Turbo trong Model & cài đặt để bật';
 await expect(all).toBeDisabled();await expect(all).toHaveAttribute('title',reason);await expect(all).toHaveAccessibleDescription(/tải VieNeu v3 Turbo trong Model & cài đặt/i);
 await expect(one).toBeDisabled();await expect(one).toHaveAttribute('title',reason);await expect(page.getByText('Chưa có model giọng đọc',{exact:false})).toBeVisible();
 await page.evaluate(()=>{(window as any).__voice=true;});
 await expect(all).toBeEnabled({timeout:6000});await expect(all).not.toHaveAttribute('title');await expect(one).toBeEnabled();await expect(page.getByText('Chưa có model giọng đọc',{exact:false})).toHaveCount(0);
 await page.getByRole('textbox',{name:'Nội dung đoạn 2'}).click();await one.click();
 await expect.poll(()=>page.evaluate(()=>(window as any).__jobs)).toEqual(['1']);
});
