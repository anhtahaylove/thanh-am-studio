import {test,expect} from '@playwright/test';
// Actions the client history can undo no longer ask first: they happen at once and an Undo toast follows.
const seedWithTake=()=>{
 const seg=(id:string,text:string,takes:unknown[])=>({id,text,normalized_text:text,voice_id:null,speaker:'',gap_ms:0,takes,selected_take_id:null,trim_start_ms:0,trim_end_ms:null,fade_in_ms:0,fade_out_ms:0,gain_db:0});
 const take={id:'t1',asset_id:'a1',path:'C:/x/t1.wav',duration_ms:1500,sample_rate:24000,created_at:'2026-01-01T00:00:00Z'};
 localStorage.setItem('thanh-am-preview-projects-v1',JSON.stringify([{id:'p1',name:'Có audio',updated_at:'2026-01-01T00:00:00Z',revision:0,segments:[seg('s1','Câu một.',[]),seg('s2','Câu hai.',[take])],transcript:[],dictionary:{},source_asset_id:null}]));
};
const addTwo=async(page:import('@playwright/test').Page)=>{
 await page.goto('/');await page.getByRole('button',{name:'Thêm nội dung',exact:true}).click();await page.getByRole('textbox',{name:'Nội dung cần thêm'}).fill('Câu một.\nCâu hai.');await page.getByRole('button',{name:/^Thêm \d+ đoạn vào kịch bản$/}).click();
 await expect(page.getByRole('textbox',{name:'Nội dung đoạn 2'})).toHaveValue('Câu hai.');
};
test('deleting a segment happens at once with no dialog, and the toast Undo brings it back',async({page})=>{
 let dialogs=0;page.on('dialog',d=>{dialogs++;void d.dismiss();});
 await addTwo(page);const toast=page.locator('.toast'),first=page.getByRole('textbox',{name:'Nội dung đoạn 1'});
 await page.getByRole('button',{name:'Xóa đoạn',exact:true}).first().click();
 await expect(first).toHaveValue('Câu hai.');await expect(page.getByRole('textbox',{name:'Nội dung đoạn 2'})).toHaveCount(0);
 await expect(toast).toHaveAttribute('role','status');await expect(toast).toContainText('Đã xóa đoạn 1');
 await toast.getByRole('button',{name:'Hoàn tác',exact:true}).click();
 await expect(first).toHaveValue('Câu một.');await expect(page.getByRole('textbox',{name:'Nội dung đoạn 2'})).toHaveValue('Câu hai.');await expect(toast).toHaveCount(0);
 expect(dialogs).toBe(0);
});
test('Ctrl+Z still undoes the delete and retires the toast; a later edit retires it too',async({page})=>{
 await addTwo(page);const toast=page.locator('.toast'),first=page.getByRole('textbox',{name:'Nội dung đoạn 1'});
 await page.getByRole('button',{name:'Xóa đoạn',exact:true}).first().click();await expect(toast).toBeVisible();
 await page.keyboard.press('Control+z');await expect(first).toHaveValue('Câu một.');await expect(toast).toHaveCount(0);
 await page.getByRole('button',{name:'Xóa đoạn',exact:true}).first().click();await expect(toast).toBeVisible();
 await first.fill('Đã sửa tiếp.');await expect(toast).toHaveCount(0);
});
test('the toast hides itself after about 8 seconds but waits while it is focused',async({page})=>{
 await page.clock.install();await addTwo(page);const toast=page.locator('.toast'),undo=toast.getByRole('button',{name:'Hoàn tác',exact:true});
 await page.getByRole('button',{name:'Xóa đoạn',exact:true}).first().click();await expect(toast).toBeVisible();
 await page.clock.fastForward(7000);await expect(toast).toBeVisible();
 await page.clock.fastForward(1500);await expect(toast).toHaveCount(0);
 await page.getByRole('button',{name:'Hoàn tác (Ctrl+Z)'}).click();await page.getByRole('button',{name:'Xóa đoạn',exact:true}).first().click();
 await undo.focus();await page.clock.fastForward(20000);await expect(toast).toBeVisible();
 await page.keyboard.press('Enter');await expect(page.getByRole('textbox',{name:'Nội dung đoạn 2'})).toHaveValue('Câu hai.');await expect(toast).toHaveCount(0);
});
test('the toast respects reduced motion and has a keyboard reachable close button',async({page})=>{
 await page.emulateMedia({reducedMotion:'reduce'});await addTwo(page);const toast=page.locator('.toast');
 await page.getByRole('button',{name:'Xóa đoạn',exact:true}).first().click();await expect(toast).toBeVisible();
 expect(await toast.evaluate(e=>getComputedStyle(e).animationName)).toBe('none');
 await toast.getByRole('button',{name:'Đóng thông báo hoàn tác'}).focus();await page.keyboard.press('Enter');await expect(toast).toHaveCount(0);
 await page.keyboard.press('Control+z');await expect(page.getByRole('textbox',{name:'Nội dung đoạn 2'})).toHaveValue('Câu hai.');
});
test('merging into a segment that already has audio no longer asks, says what happens to the take, and undoes',async({page})=>{
 let dialogs=0;page.on('dialog',d=>{dialogs++;void d.dismiss();});
 await page.addInitScript(seedWithTake);await page.goto('/');await page.getByRole('button',{name:'Dự án',exact:true}).click();await page.getByRole('button',{name:'Mở dự án',exact:true}).click();
 await expect(page.getByRole('textbox',{name:'Nội dung đoạn 2'})).toHaveValue('Câu hai.');await expect(page.getByText('1 take',{exact:true})).toHaveCount(1);
 await page.getByRole('button',{name:'Gộp với đoạn sau'}).first().click();
 await expect(page.getByRole('textbox',{name:'Nội dung đoạn 2'})).toHaveCount(0);await expect(page.getByText('1 take',{exact:true})).toHaveCount(0);
 const toast=page.locator('.toast');await expect(toast).toContainText('Đã gộp đoạn 1 và 2');await expect(toast).toContainText('file audio vẫn còn trên đĩa');
 await toast.getByRole('button',{name:'Hoàn tác',exact:true}).click();
 await expect(page.getByRole('textbox',{name:'Nội dung đoạn 2'})).toHaveValue('Câu hai.');await expect(page.getByText('1 take',{exact:true})).toHaveCount(1);expect(dialogs).toBe(0);
});
test('applying a finished transcript over an open one replaces it at once and can be undone',async({page})=>{
 let dialogs=0;page.on('dialog',d=>{dialogs++;void d.dismiss();});
 await page.addInitScript(()=>{
  const w=window as any;w.isTauri=true;let project:any=null;
  const job={id:'j1',kind:'stt',project_id:null,payload:{asset_id:'B'},status:'succeeded',progress:1,error:null,result:{segments:[{start:0,end:2,text:'Bản mới một'},{start:2,end:4,text:'Bản mới hai'}]},created_at:'2026-01-01T00:00:00Z',updated_at:'2026-01-01T00:00:00Z'};
  w.__TAURI_INTERNALS__={convertFileSrc:(p:string)=>p,transformCallback:()=>1,unregisterCallback:()=>{},metadata:{currentWindow:{label:'main'},currentWebview:{label:'main',windowLabel:'main'}},
   invoke:async(cmd:string,args:any)=>{switch(cmd){
    case 'list_jobs':return [job];case 'list_projects':return project?[{id:project.id,name:project.name,updated_at:project.updated_at,revision:project.revision}]:[];
    case 'create_project':project={id:'p1',name:args.name,updated_at:'2026-01-01T00:00:00Z',revision:0,segments:[],transcript:[],dictionary:{},source_asset_id:'A'};return project;
    case 'get_asset':return {id:args.id,path:args.id+'.wav',name:args.id+'.wav',duration_ms:1000,sample_rate:16000};
    case 'save_project':project={...args.project,revision:args.project.revision+1};return project;
    case 'load_project':return project;case 'list_voices':case 'list_models':return [];case 'get_settings':return {dictionary:{}};
    case 'runtime_status':return {python_ready:true,ffmpeg_ready:true,worker_ready:true,python_path:null,ffmpeg_path:null,message:''};
    default:return null;}}};
 });
 await page.goto('/');await page.getByRole('button',{name:'Chép lời',exact:true}).click();await page.getByRole('button',{name:'Thêm dòng'}).click();
 const texts=page.getByLabel(/^Lời nói tại/);await texts.first().fill('Bản cũ');
 await page.getByRole('button',{name:'Hàng đợi',exact:true}).click();await page.getByRole('button',{name:'Áp dụng transcript'}).click();
 await expect(texts).toHaveCount(2);await expect(texts.first()).toHaveValue('Bản mới một');
 const toast=page.locator('.toast'),player=page.locator('.source-player');await expect(toast).toContainText('Đã thay transcript');await expect(player).toContainText('B.wav');
 // The source player goes back with the transcript, through the toast, Ctrl+Y and Ctrl+Z alike.
 await toast.getByRole('button',{name:'Hoàn tác',exact:true}).click();await expect(texts).toHaveCount(1);await expect(texts.first()).toHaveValue('Bản cũ');await expect(player).toContainText('A.wav');expect(dialogs).toBe(0);
 await page.keyboard.press('Control+y');await expect(texts).toHaveCount(2);await expect(player).toContainText('B.wav');
 await page.keyboard.press('Control+z');await expect(texts).toHaveCount(1);await expect(player).toContainText('A.wav');await expect(player).not.toContainText('B.wav');
});
test('a toast that disappears while it has focus does not stop the next one from timing out',async({page})=>{
 await page.clock.install();await addTwo(page);const toast=page.locator('.toast');
 await page.getByRole('button',{name:'Xóa đoạn',exact:true}).first().click();await toast.getByRole('button',{name:'Hoàn tác',exact:true}).focus();
 await page.keyboard.press('Control+z');await expect(toast).toHaveCount(0);
 await page.getByRole('button',{name:'Xóa đoạn',exact:true}).first().click();await expect(toast).toBeVisible();
 await page.clock.fastForward(8500);await expect(toast).toHaveCount(0);
});
test('opening a project whose source asset is missing does not keep the source player of the previous project',async({page})=>{
 await page.addInitScript(()=>{
  const w=window as any;w.isTauri=true;
  const proj=(id:string,name:string,source:string)=>({id,name,updated_at:'2026-01-01T00:00:00Z',revision:1,segments:[],transcript:[],dictionary:{},source_asset_id:source});
  const projects=[proj('p1','Có nguồn','A'),proj('p2','Mất nguồn','Z')];
  w.__TAURI_INTERNALS__={convertFileSrc:(p:string)=>p,transformCallback:()=>1,unregisterCallback:()=>{},metadata:{currentWindow:{label:'main'},currentWebview:{label:'main',windowLabel:'main'}},
   invoke:async(cmd:string,args:any)=>{switch(cmd){
    case 'list_projects':return projects.map(p=>({id:p.id,name:p.name,updated_at:p.updated_at,revision:p.revision}));case 'load_project':return projects.find(p=>p.id===args.id);
    case 'get_asset':if(args.id==='Z')throw Error('ASSET_MISSING');return {id:args.id,path:args.id+'.wav',name:'cu-'+args.id+'.wav',duration_ms:1000,sample_rate:16000};
    case 'list_jobs':case 'list_voices':case 'list_models':return [];case 'get_settings':return {dictionary:{}};
    case 'runtime_status':return {python_ready:true,ffmpeg_ready:true,worker_ready:true,python_path:null,ffmpeg_path:null,message:''};default:return null;}}};
 });
 await page.goto('/');await page.getByRole('button',{name:'Dự án',exact:true}).click();
 await page.getByRole('button',{name:'Mở dự án',exact:true}).nth(0).click();await page.getByRole('button',{name:'Chép lời',exact:true}).click();await expect(page.locator('.source-player')).toContainText('cu-A.wav');
 await page.getByRole('button',{name:'Dự án',exact:true}).click();await page.getByRole('button',{name:'Mở dự án',exact:true}).nth(1).click();await page.getByRole('button',{name:'Chép lời',exact:true}).click();
 await expect(page.locator('.source-player')).toHaveCount(0);
});
test('the toast names Ctrl+Z, and the palette offers Undo while the toast sits inert behind it',async({page})=>{
 await addTwo(page);const toast=page.locator('.toast'),undo=toast.getByRole('button',{name:'Hoàn tác',exact:true}),palette=page.getByRole('dialog',{name:'Bảng lệnh'}),box=page.getByRole('combobox',{name:'Gõ để tìm lệnh'});
 await page.getByRole('button',{name:'Xóa đoạn',exact:true}).first().click();await expect(toast).toBeVisible();
 await expect(undo).toHaveAttribute('title','Hoàn tác (Ctrl+Z)');await expect(undo).toHaveAttribute('aria-keyshortcuts','Control+Z');
 await page.keyboard.press('Control+k');await expect(palette).toBeVisible();expect(await toast.evaluate(e=>!!e.closest('[inert]'))).toBe(true);
 await box.fill('hoan tac');const command=palette.getByRole('option',{name:/Hoàn tác thay đổi gần nhất/});await expect(command).not.toHaveAttribute('aria-disabled','true');
 await page.keyboard.press('Enter');await expect(palette).toHaveCount(0);await expect(page.getByRole('textbox',{name:'Nội dung đoạn 2'})).toHaveValue('Câu hai.');await expect(toast).toHaveCount(0);
 await page.getByRole('button',{name:'Hoàn tác (Ctrl+Z)'}).click();await expect(page.getByRole('button',{name:'Hoàn tác (Ctrl+Z)'})).toBeDisabled();
 await page.keyboard.press('Control+k');await box.fill('hoan tac');await expect(command).toHaveAttribute('aria-disabled','true');await expect(command).toContainText('Chưa có thay đổi nào để hoàn tác');
});
test('Ctrl+Z on the toast Undo button undoes like a click and leaves focus on the page, not on nothing',async({page})=>{
 await addTwo(page);const toast=page.locator('.toast');
 await page.getByRole('button',{name:'Xóa đoạn',exact:true}).first().click();await toast.getByRole('button',{name:'Hoàn tác',exact:true}).focus();
 await page.keyboard.press('Control+z');await expect(page.getByRole('textbox',{name:'Nội dung đoạn 2'})).toHaveValue('Câu hai.');await expect(toast).toHaveCount(0);
 await expect(page.locator('main')).toBeFocused();
 // Only one step was undone: the two added segments are still there.
 await expect(page.getByRole('textbox',{name:'Nội dung đoạn 1'})).toHaveValue('Câu một.');
});
test('running Undo from the palette leaves focus on the page',async({page})=>{
 await addTwo(page);const toast=page.locator('.toast');
 await page.getByRole('button',{name:'Xóa đoạn',exact:true}).first().click();await expect(toast).toBeVisible();
 await page.keyboard.press('Control+k');await page.getByRole('combobox',{name:'Gõ để tìm lệnh'}).fill('hoan tac');await page.keyboard.press('Enter');
 await expect(page.getByRole('textbox',{name:'Nội dung đoạn 2'})).toHaveValue('Câu hai.');await expect(page.locator('main')).toBeFocused();
 await page.getByRole('textbox',{name:'Nội dung đoạn 1'}).focus();await page.keyboard.press('Control+k');await page.getByRole('combobox',{name:'Gõ để tìm lệnh'}).fill('hoan tac');await page.keyboard.press('Enter');
 await expect(page.getByRole('textbox',{name:'Nội dung đoạn 1'})).toHaveCount(0);await expect(page.locator('main')).toBeFocused();
});
