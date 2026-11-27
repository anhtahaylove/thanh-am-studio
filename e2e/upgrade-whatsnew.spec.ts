import {test,expect} from '@playwright/test';
import {readFileSync} from 'node:fs';
// Round 1.0.26 criterion 4 (PLAN §2, §6 S1): someone updating from the previous release, with a project, gets one "Có gì mới" and no start panel; the palette's
// "Hiện hướng dẫn bắt đầu" (Ctrl+K) still opens the start panel. The previous release is the changelog entry before the running version (1.0.25 once 1.0.26 is out).
const {version}=JSON.parse(readFileSync('package.json','utf8')),log:{version:string}[]=JSON.parse(readFileSync('src/changelog.vi.json','utf8'));
const previous=log[log.findIndex(e=>e.version===version)+1].version;
const mock=(seen:string)=>{
 const w=window as any,now='2026-11-27T00:00:00Z';w.isTauri=true;w.__polls=0;
 if(!sessionStorage.getItem('seeded')){localStorage.setItem('thanh-am-seen-version',seen);localStorage.setItem('thanh-am-theme','system');sessionStorage.setItem('seeded','1');}
 const project={id:'p1',name:'Làng chài',updated_at:now,revision:1,segments:[],transcript:[],dictionary:{},source_asset_id:null};
 w.__TAURI_INTERNALS__={convertFileSrc:(p:string)=>p,transformCallback:()=>1,unregisterCallback:()=>{},metadata:{currentWindow:{label:'main'},currentWebview:{label:'main',windowLabel:'main'}},
  invoke:async(cmd:string)=>{switch(cmd){
   case 'list_projects':return [{id:project.id,name:project.name,updated_at:now,revision:1}];case 'load_project':return project;case 'list_jobs':w.__polls++;return [];case 'list_voices':return [];case 'get_settings':return {dictionary:{}};
   // No model is installed: only the project makes this profile not fresh.
   case 'list_models':return [{id:'vieneu-v3',name:'VieNeu v3 Turbo',engine:'tts',kind:'model',installed:false,revision:'r',license:'',description:''},{id:'whisper-small',name:'Whisper Small',engine:'stt',kind:'model',installed:false,revision:'r',license:'',description:''}];
   case 'runtime_status':return {python_ready:true,ffmpeg_ready:true,worker_ready:true,native_worker_ready:true,python_path:null,ffmpeg_path:null,native_worker_path:null,fallback_count:0,total_memory_mb:null,message:''};
   default:return null;}}};
};
const polls=async(page:any,n:number)=>{const at=await page.evaluate(()=>(window as any).__polls);await page.waitForFunction((k:number)=>(window as any).__polls>=k,at+n);};

test(`an upgrader from ${previous} with a project gets one "What's new" dialog and no start panel; Ctrl+K opens the start panel`,async({page})=>{
 await page.addInitScript(mock,previous);await page.goto('/');
 const dialog=page.getByRole('dialog',{name:'Có gì mới'}),panel=page.locator('.start-panel');
 await expect(dialog).toHaveCount(1);
 await expect(dialog.getByRole('heading',{name:/^Bản /})).toHaveCount(1);await expect(dialog.getByRole('heading',{name:new RegExp(`^Bản ${version.replace(/\./g,'\\.')}`)})).toBeVisible();
 await polls(page,2);await expect(panel).toHaveCount(0);
 await dialog.getByRole('button',{name:'Đã hiểu'}).click();await expect(dialog).toHaveCount(0);
 await page.reload();await polls(page,2);
 await expect(dialog,'"Có gì mới" shows once').toHaveCount(0);await expect(panel).toHaveCount(0);
 await page.keyboard.press('Control+k');await page.getByRole('dialog',{name:'Bảng lệnh'}).getByRole('option',{name:'Hiện hướng dẫn bắt đầu'}).click();
 const heading=panel.getByRole('heading',{name:'Bước 1/3 Bạn muốn làm gì trước?'});
 await expect(heading).toBeVisible();await expect(heading).toBeFocused();
 await expect(panel.getByRole('button',{name:'Đọc văn bản thành giọng nói',exact:true})).toBeVisible();await expect(panel.getByRole('button',{name:'Chép lời từ file âm thanh',exact:true})).toBeVisible();
});
