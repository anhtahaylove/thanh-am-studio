import {test,expect} from '@playwright/test';
import type {Page} from '@playwright/test';
// Round 1.0.28: backend codes that reached the error alert raw now have a Vietnamese sentence. UTF8_REQUIRED from a script import says how to save the file as UTF-8, while the CSV
// import keeps its own Excel hint (the bridge turns the code into that hint after the shared mapping, so the mapping must not hide the code from it). A bare NOT_FOUND from
// "Mở thư mục" (the saved file was moved or deleted) says so. Tauri is mocked: `read_text_file` and `reveal_path` reject with the bare code, as the host does.
const mock=(d:{read?:string;reveal?:string})=>{
 const w=window as any;w.isTauri=true;
 w.__TAURI_INTERNALS__={convertFileSrc:(p:string)=>p,transformCallback:()=>1,unregisterCallback:()=>{},metadata:{currentWindow:{label:'main'},currentWebview:{label:'main',windowLabel:'main'}},
  invoke:async(cmd:string)=>{switch(cmd){
   case 'list_projects':case 'list_jobs':case 'list_voices':case 'list_models':return [];case 'get_settings':return {dictionary:{UBND:'ủy ban nhân dân'}};
   case 'runtime_status':return {python_ready:true,ffmpeg_ready:true,worker_ready:true,python_path:null,ffmpeg_path:null,message:''};
   case 'create_project':return {id:'p1',name:'x',updated_at:new Date().toISOString(),revision:1,segments:[],transcript:[],dictionary:{},source_asset_id:null};
   case 'plugin:dialog|open':return ['C:/kịch bản.txt'];case 'plugin:dialog|save':return 'C:\\Users\\a\\Từ điển chung.csv';
   case 'read_text_file':throw d.read;case 'reveal_path':throw d.reveal;
   default:return null;}}};
};
const open=async(page:Page,d:{read?:string;reveal?:string})=>{await page.addInitScript(mock,d);await page.goto('/');};
const alertText=(page:Page)=>page.getByRole('alert').locator('p');
const UTF8='UTF8_REQUIRED: stream did not contain valid UTF-8';

test('a script file that is not UTF-8 shows how to save it as UTF-8, not the raw code',async({page})=>{
 await open(page,{read:UTF8});
 await page.getByRole('button',{name:/Nhập TXT \/ SRT \/ Word/}).click();
 await expect(alertText(page)).toHaveText('Tệp cần mã hóa UTF-8. Trong Notepad, chọn Lưu thành và đặt Mã hóa là UTF-8 rồi mở lại.');
 await expect(page.getByText('UTF8_REQUIRED')).toHaveCount(0);
});

test('a dictionary CSV that is not UTF-8 still shows the Excel hint',async({page})=>{
 await open(page,{read:UTF8});
 await page.getByRole('button',{name:'Model & cài đặt'}).click();
 await page.locator('.app-dictionary').getByRole('button',{name:'Nhập CSV'}).click();
 await expect(alertText(page)).toHaveText('Tệp CSV cần mã hóa UTF-8. Trong Excel, chọn Lưu dưới dạng › CSV UTF-8.');
});

test('"Mở thư mục" on a saved file that was moved shows that the file is gone, not the raw code',async({page})=>{
 await open(page,{reveal:'NOT_FOUND'});
 await page.getByRole('button',{name:'Model & cài đặt'}).click();
 await page.locator('.app-dictionary').getByRole('button',{name:'Xuất CSV'}).click();
 await page.getByRole('status').filter({hasText:'Đã lưu Từ điển chung.csv'}).getByRole('button',{name:'Mở thư mục'}).click();
 await expect(alertText(page)).toHaveText('Không tìm thấy tệp đã lưu: tệp đã bị chuyển hoặc xóa.');
 await expect(page.getByText('NOT_FOUND',{exact:true})).toHaveCount(0);
});
