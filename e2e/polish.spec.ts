import {test,expect} from '@playwright/test';
// 5 s of a quiet 440 Hz tone, served for the take and the transcript source.
const tone=()=>{const rate=48000,n=rate*5,b=Buffer.alloc(44+n*2);b.write('RIFF',0);b.writeUInt32LE(36+n*2,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(rate,24);b.writeUInt32LE(rate*2,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(n*2,40);for(let i=0;i<n;i++)b.writeInt16LE(Math.round(Math.sin(2*Math.PI*440*i/rate)*2000),44+i*2);return b;};
const mock=()=>{
 const w=window as any,calls:any[]=[];w.isTauri=true;w.__calls=calls;
 const take={id:'t1',asset_id:'a1',path:'/tone.wav',duration_ms:5000,sample_rate:48000,created_at:new Date().toISOString()};
 const seg={id:'1',text:'Xin chào.',normalized_text:'Xin chào.',voice_id:null,speaker:'Người dẫn',gap_ms:300,takes:[take],selected_take_id:'t1',trim_start_ms:0,trim_end_ms:null,fade_in_ms:0,fade_out_ms:0,gain_db:0};
 let project:any={id:'p1',name:'Nghe thử',updated_at:new Date().toISOString(),revision:1,segments:[seg],transcript:[{id:'r1',start_ms:0,end_ms:2000,text:'Một'}],dictionary:{},source_asset_id:'src'};
 w.__TAURI_INTERNALS__={convertFileSrc:(p:string)=>p,transformCallback:()=>1,unregisterCallback:()=>{},metadata:{currentWindow:{label:'main'},currentWebview:{label:'main',windowLabel:'main'}},
  invoke:async(cmd:string,args:any)=>{calls.push({cmd,args});switch(cmd){
   case 'list_projects':return [project];case 'load_project':return project;case 'list_jobs':case 'list_voices':case 'list_models':return [];case 'get_settings':return {dictionary:{UBND:'ủy ban nhân dân'}};
   case 'runtime_status':return {python_ready:true,ffmpeg_ready:true,worker_ready:true,python_path:null,ffmpeg_path:null,message:''};
   case 'get_asset':return {id:'src',path:'/tone.wav',name:'phong-van.wav',duration_ms:5000,sample_rate:48000};
   case 'plugin:dialog|save':return 'C:\\Users\\a\\Bản xuất\\Từ điển chung.csv';
   case 'save_project':project={...args.project,revision:args.project.revision+1};return project;default:return null;}}};
};
const open=async(page:any)=>{await page.route('**/tone.wav',(r:any)=>r.fulfill({body:tone(),contentType:'audio/wav'}));await page.addInitScript(mock);await page.goto('/');await page.getByRole('button',{name:'Dự án',exact:true}).click();await page.getByRole('button',{name:'Mở dự án'}).click();};

test('Space plays and stops the selected take on the studio page, but types a space in the editor',async({page})=>{
 await open(page);await page.getByRole('heading',{level:1}).click();
 const play=page.locator('.play-button');await expect(play).toHaveAccessibleName('Nghe thử đoạn');await expect(play).toHaveAttribute('title','Nghe thử đoạn (Space)');
 await page.keyboard.press('Space');await expect(play).toHaveAccessibleName('Dừng nghe thử');
 await page.keyboard.press('Space');await expect(play).toHaveAccessibleName('Nghe thử đoạn');
 const box=page.getByRole('textbox',{name:'Nội dung đoạn 1'});await box.click();await page.keyboard.press('End');await page.keyboard.press('Space');
 await expect(box).toHaveValue('Xin chào. ');await expect(play).toHaveAccessibleName('Nghe thử đoạn');
});

test('the transcript source can be heard faster or slower without changing the file',async({page})=>{
 await open(page);await page.getByRole('button',{name:'Chép lời'}).click();
 const audio=page.locator('.source-player audio'),speed=page.getByRole('combobox',{name:'Tốc độ nghe'});
 await expect(speed).toHaveValue('1');await speed.selectOption('1.5');
 await expect.poll(()=>audio.evaluate((a:HTMLAudioElement)=>[a.playbackRate,a.preservesPitch])).toEqual([1.5,true]);
});

test('a saved file can be shown in Explorer',async({page})=>{
 await open(page);await page.getByRole('button',{name:'Model & cài đặt'}).click();
 await page.locator('.app-dictionary').getByRole('button',{name:'Xuất CSV'}).click();
 const notice=page.getByRole('status').filter({hasText:'Đã lưu Từ điển chung.csv'});await expect(notice).toBeVisible();
 await notice.getByRole('button',{name:'Mở thư mục'}).click();
 await expect.poll(()=>page.evaluate(()=>(window as any).__calls.filter((c:any)=>c.cmd==='reveal_path').map((c:any)=>c.args))).toEqual([{path:'C:\\Users\\a\\Bản xuất\\Từ điển chung.csv'}]);
 await notice.getByRole('button',{name:'Đóng thông báo đã lưu'}).click();await expect(notice).toHaveCount(0);
});
