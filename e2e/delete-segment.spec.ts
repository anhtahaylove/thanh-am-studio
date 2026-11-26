import {test,expect,type Page} from '@playwright/test';
// "Xóa đoạn" does not select the row it removes: a selected row hands the selection (and focus) to its neighbour, an unselected row leaves the selection and a playing preview alone.
const addThree=async(page:Page)=>{
 await page.goto('/');await page.getByRole('button',{name:'Thêm nội dung',exact:true}).click();await page.getByRole('textbox',{name:'Nội dung cần thêm'}).fill('Câu một.\nCâu hai.\nCâu ba.');await page.getByRole('button',{name:/^Thêm \d+ đoạn vào kịch bản$/}).click();
 await expect(page.getByRole('textbox',{name:'Nội dung đoạn 3'})).toHaveValue('Câu ba.');
};
const del=(page:Page,n:number)=>page.getByRole('button',{name:'Xóa đoạn',exact:true}).nth(n-1).click();
const selectedText=(page:Page)=>page.locator('article.segment.selected textarea');

test('deleting the selected middle segment selects and focuses the next one',async({page})=>{
 await addThree(page);
 await page.locator('article.segment').nth(1).click();await expect(selectedText(page)).toHaveValue('Câu hai.');
 await del(page,2);
 await expect(page.locator('article.segment')).toHaveCount(2);
 await expect(selectedText(page)).toHaveValue('Câu ba.');
 await expect(page.getByRole('textbox',{name:'Nội dung đoạn 2'})).toBeFocused();
});

test('deleting the selected last segment selects and focuses the previous one',async({page})=>{
 await addThree(page);
 await page.locator('article.segment').nth(2).click();await expect(selectedText(page)).toHaveValue('Câu ba.');
 await del(page,3);
 await expect(page.locator('article.segment')).toHaveCount(2);
 await expect(selectedText(page)).toHaveValue('Câu hai.');
 await expect(page.getByRole('textbox',{name:'Nội dung đoạn 2'})).toBeFocused();
});

test('deleting the only segment focuses "Viết đoạn đầu tiên"',async({page})=>{
 await page.goto('/');await page.getByRole('button',{name:'Thêm nội dung',exact:true}).click();await page.getByRole('textbox',{name:'Nội dung cần thêm'}).fill('Câu một.');await page.getByRole('button',{name:/^Thêm \d+ đoạn vào kịch bản$/}).click();
 await expect(page.getByRole('textbox',{name:'Nội dung đoạn 1'})).toHaveValue('Câu một.');
 await del(page,1);
 await expect(page.locator('article.segment')).toHaveCount(0);
 await expect(page.getByRole('button',{name:'Viết đoạn đầu tiên'})).toBeFocused();
});

// The keyboard moves focus to the delete button (the Tab press tells Chromium the focus is keyboard focus) and activates it either with Enter or, as a screen reader does, with a click that carries no key event.
const kbDel=async(page:Page,n:number,how:'Enter'|'click')=>{
 await page.keyboard.press('Tab');const b=page.getByRole('button',{name:'Xóa đoạn',exact:true}).nth(n-1);await b.focus();
 if(how==='Enter')await page.keyboard.press('Enter');else await b.evaluate(e=>(e as HTMLElement).click());
};
// At 900 px a row's focus does not select it (the selected row holds the segment panel), at 1440 px it does; the outcome of deleting by keyboard is the same.
for(const width of [900,1440])for(const how of ['Enter','click'] as const)test(`keyboard delete (${how}) of an unselected segment hands focus to its neighbour at ${width}px`,async({page})=>{
 await page.setViewportSize({width,height:1000});
 await addThree(page);
 await page.locator('article.segment').nth(2).click();await expect(selectedText(page)).toHaveValue('Câu ba.');
 await kbDel(page,1,how);
 await expect(page.locator('article.segment')).toHaveCount(2);
 await expect(page.getByRole('textbox',{name:'Nội dung đoạn 1'})).toHaveValue('Câu hai.');
 await expect(page.getByRole('textbox',{name:'Nội dung đoạn 1'})).toBeFocused();
 await expect(selectedText(page)).toHaveValue('Câu hai.');
});

// Tauri is mocked and a spy on AudioBufferSourceNode records every start() and stop(), as in preview-switch.spec.ts.
const tone=()=>{const rate=8000,n=rate*8,b=Buffer.alloc(44+n*2);b.write('RIFF',0);b.writeUInt32LE(36+n*2,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(rate,24);b.writeUInt32LE(rate*2,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(n*2,40);for(let i=0;i<n;i++)b.writeInt16LE(Math.round(Math.sin(2*Math.PI*440*i/rate)*6000),44+i*2);return b;};
const mock=()=>{
 const w=window as any;w.isTauri=true;w.__ev=[];
 const start=AudioBufferSourceNode.prototype.start,stop=AudioBufferSourceNode.prototype.stop;
 AudioBufferSourceNode.prototype.start=function(this:AudioBufferSourceNode,...a:any[]){w.__ev.push('start');return (start as any).apply(this,a);};
 AudioBufferSourceNode.prototype.stop=function(this:AudioBufferSourceNode,...a:any[]){w.__ev.push('stop');return (stop as any).apply(this,a);};
 const seg=(id:string)=>({id,text:'Xin chào '+id+'.',normalized_text:'Xin chào '+id+'.',voice_id:null,speaker:'Người dẫn',gap_ms:300,takes:[{id:'t'+id,asset_id:'a'+id,path:'/tone.wav',duration_ms:8000,sample_rate:8000,created_at:new Date().toISOString()}],selected_take_id:'t'+id,trim_start_ms:0,trim_end_ms:null,fade_in_ms:0,fade_out_ms:0,gain_db:0});
 const projects:any[]=[{id:'p1',name:'Dự án một',updated_at:new Date().toISOString(),revision:1,segments:[seg('1'),seg('2'),seg('3')],transcript:[],dictionary:{},source_asset_id:null}];
 w.__TAURI_INTERNALS__={convertFileSrc:(p:string)=>p,transformCallback:()=>1,unregisterCallback:()=>{},metadata:{currentWindow:{label:'main'},currentWebview:{label:'main',windowLabel:'main'}},
  invoke:async(cmd:string,args:any)=>{switch(cmd){
   case 'list_projects':return projects;case 'load_project':return JSON.parse(JSON.stringify(projects[0]));case 'list_jobs':case 'list_voices':case 'list_models':return [];case 'get_settings':return {dictionary:{}};
   case 'runtime_status':return {python_ready:true,ffmpeg_ready:true,worker_ready:true,python_path:null,ffmpeg_path:null,message:''};
   case 'save_project':{const p={...args.project,revision:args.project.revision+1};projects[0]=p;return p;}default:return null;}}};
};

// Opens the mocked project, selects segment `sel` and starts its preview.
const playing=async(page:Page,sel:number)=>{
 await page.route('**/tone.wav',r=>r.fulfill({body:tone(),contentType:'audio/wav'}));
 await page.addInitScript(mock);await page.goto('/');
 await page.getByRole('button',{name:'Dự án',exact:true}).click();await page.getByRole('button',{name:'Mở dự án',exact:true}).first().click();
 await page.locator('article.segment').nth(sel-1).click();await page.getByRole('heading',{level:1}).click();
 await expect(selectedText(page)).toHaveValue(`Xin chào ${sel}.`);
 await page.keyboard.press('Space');
 const play=page.locator('.play-button');await expect(play).toHaveAccessibleName('Dừng nghe thử');
 return play;
};
const kept=async(page:Page,play:import('@playwright/test').Locator,sel:number)=>{
 await expect(page.locator('article.segment')).toHaveCount(2);
 await expect(selectedText(page)).toHaveValue(`Xin chào ${sel}.`);
 await expect(play).toHaveAccessibleName('Dừng nghe thử');
 expect(await page.evaluate(()=>(window as any).__ev as string[])).toEqual(['start']);
};

// Segment 2 plays (segment 1 would hide the bug: the missing-selection fallback is segment 1).
test('deleting an unselected segment keeps the selection and a playing preview',async({page})=>{
 const play=await playing(page,2);
 await del(page,3);
 await kept(page,play,2);
});

// The deleted row's neighbour (segment 3) is not the selected one, so only the "was selected" guard keeps the selection and focus away from it.
test('deleting an unselected segment does not move the selection or focus to its neighbour',async({page})=>{
 const play=await playing(page,1);
 await del(page,2);
 await kept(page,play,1);
 expect(await page.evaluate(()=>document.activeElement?.matches('textarea')??false)).toBe(false);
});
