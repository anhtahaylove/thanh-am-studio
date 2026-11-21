import {test,expect} from '@playwright/test';
// Tauri is mocked as in poll-errors.spec.ts, with two failed transcriptions in the queue.
const mock=()=>{
 const w=window as any,now=new Date().toISOString();w.isTauri=true;
 const job=(id:string,error:string)=>({id,kind:'stt',project_id:null,payload:{},status:'failed',progress:0,error,result:null,created_at:now,updated_at:now});
 const jobs=[job('j1','INVALID_MEDIA: The file has no decodable audio.'),job('j2','WORKER_ERROR: RuntimeError: boom')];
 w.__TAURI_INTERNALS__={convertFileSrc:(p:string)=>p,transformCallback:()=>1,unregisterCallback:()=>{},metadata:{currentWindow:{label:'main'},currentWebview:{label:'main',windowLabel:'main'}},
  invoke:async(cmd:string)=>{switch(cmd){
   case 'list_jobs':return jobs;case 'list_projects':case 'list_voices':case 'list_models':return [];case 'get_settings':return {dictionary:{}};
   case 'runtime_status':return {python_ready:true,ffmpeg_ready:true,worker_ready:true,python_path:null,ffmpeg_path:null,message:''};
   default:return null;}}};
};
test('a job that failed on its input shows the Vietnamese message for the code, other failures show their text',async({page})=>{
 await page.addInitScript(mock);await page.goto('/');
 await page.getByRole('navigation',{name:'Điều hướng chính'}).getByRole('button',{name:/^Hàng đợi/}).click();
 const errors=page.locator('.job-error');
 await expect(errors).toHaveText(['Không đọc được âm thanh trong tệp này: tệp bị hỏng, không có âm thanh hoặc ghép từ các phần khác tần số lấy mẫu hay số kênh. Nếu tệp vẫn nghe được trong trình phát, hãy chuyển sang WAV rồi thử lại.','WORKER_ERROR: RuntimeError: boom']);
});
