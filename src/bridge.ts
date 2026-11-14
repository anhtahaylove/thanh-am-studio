import {invoke,convertFileSrc,isTauri} from '@tauri-apps/api/core';
import {open,save} from '@tauri-apps/plugin-dialog';
import {uid} from './domain';
import {UTF8_HINT} from './csv';
import type {AppSettings,Project,ProjectSummary,Voice} from './types';
export const desktop=isTauri();
const KEY='thanh-am-preview-projects-v1',SETTINGS_KEY='thanh-am-preview-settings-v1';
function projects():Project[]{try{return JSON.parse(localStorage.getItem(KEY)||'[]');}catch{return [];}}
const persist=(list:Project[])=>localStorage.setItem(KEY,JSON.stringify(list));
const ERRORS:Record<string,string>={INVALID_DOCX:'Không đọc được tệp Word này. Hãy mở bằng Word rồi lưu lại dạng .docx.',DOCX_TOO_LARGE:'Tệp quá lớn: phần chữ vượt 10 MB.',TEXT_FILE_TOO_LARGE:'Tệp quá lớn: phần chữ vượt 10 MB.',UNSUPPORTED_TEXT:'Định dạng tệp không được hỗ trợ.'};
const friendly=(e:unknown)=>{const code=Object.keys(ERRORS).find(k=>String(e).startsWith(k));return code?Error(ERRORS[code]):e;};
export async function call<T>(command:string,args:Record<string,unknown>={}):Promise<T>{
 if(desktop)return invoke<T>(command,args).catch(e=>{throw friendly(e);});
 const list=projects();let result:unknown;
 switch(command){
 case 'list_projects':result=list.map(({id,name,updated_at,revision}):ProjectSummary=>({id,name,updated_at,revision}));break;
 case 'create_project':{const p:Project={id:uid(),name:String(args.name),updated_at:new Date().toISOString(),revision:0,segments:[],transcript:[],dictionary:{},source_asset_id:null};persist([p,...list]);result=p;break;}
 case 'load_project':result=list.find(x=>x.id===args.id);if(!result)throw Error('Dự án không còn tồn tại');break;
 case 'save_project':{const p=args.project as Project;const old=list.find(x=>x.id===p.id);if(old&&old.revision!==p.revision)throw Error('Dự án đã thay đổi. Tải lại trước khi lưu.');const next={...p,revision:p.revision+1,updated_at:new Date().toISOString()};persist([next,...list.filter(x=>x.id!==p.id)]);result=next;break;}
 case 'get_settings':try{result={dictionary:{},...JSON.parse(localStorage.getItem(SETTINGS_KEY)||'{}')};}catch{result={dictionary:{}};}break;
 case 'save_settings':{const dictionary=(args.settings as AppSettings)?.dictionary;if(!dictionary||typeof dictionary!=='object'||Array.isArray(dictionary)||Object.keys(dictionary).length>5000||Object.entries(dictionary).some(([k,v])=>!k||typeof v!=='string'))throw Error('INVALID_SETTINGS: dictionary');result={dictionary};localStorage.setItem(SETTINGS_KEY,JSON.stringify(result));break;}
 case 'delete_project':persist(list.filter(x=>x.id!==args.id));break;
 case 'list_jobs':case 'list_models':result=[];break;
 case 'list_voices':result=[] satisfies Voice[];break;
 case 'runtime_status':result={python_ready:false,ffmpeg_ready:false,worker_ready:false,python_path:null,ffmpeg_path:null,message:'Bản xem trước giao diện trong trình duyệt. Chạy bản desktop để dùng engine và file cục bộ.'};break;
 default:throw Error('Thao tác này cần bản desktop. Bản xem trước không chạy model hoặc giả lập audio.');
 }return result as T;
}
export const mediaUrl=(path:string)=>desktop?convertFileSrc(path):path;
export async function pickFiles(kind:'text'|'audio'|'csv',multiple=false):Promise<string[]>{
 if(!desktop)throw Error('Mở bản desktop để chọn tệp từ máy tính.');
 const result=await open({multiple,filters:kind==='text'?[{name:'Văn bản, Word & phụ đề',extensions:['txt','srt','vtt','docx']}]:kind==='csv'?[{name:'Bảng CSV',extensions:['csv']}]:[{name:'Audio & video',extensions:['wav','mp3','m4a','flac','ogg','opus','mp4','mkv','webm','mov']}]});return result?Array.isArray(result)?result:[result]:[];
}
/** Content of one CSV the user picks, or null when cancelled. The browser preview has no file paths, so it reads through a file input. */
export async function openCsv():Promise<string|null>{
 if(desktop){const [path]=await pickFiles('csv');return path?call<string>('read_text_file',{path}).catch(e=>{throw String(e).includes('UTF8_REQUIRED')?Error(UTF8_HINT):e;}):null;}
 return new Promise((resolve,reject)=>{const input=Object.assign(document.createElement('input'),{type:'file',accept:'.csv,text/csv'});input.addEventListener('change',()=>{const file=input.files?.[0];if(file)file.text().then(resolve,reject);else resolve(null);});input.addEventListener('cancel',()=>resolve(null));input.click();});
}
export async function saveText(name:string,content:string):Promise<void>{
 if(!desktop){const url=URL.createObjectURL(new Blob([content],{type:'text/plain;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);return;}
 const path=await save({defaultPath:name,filters:[{name:'Văn bản',extensions:[name.split('.').pop()!]}]});if(path)await call('export_text',{path,content});
}
export async function saveAudio(assetId:string,format:string,name='thanh-am'):Promise<void>{const path=await save({defaultPath:`${name}.${format}`,filters:[{name:'Audio',extensions:[format]}]});if(path)await call('export_asset',{assetId,path});}
/** Asks for a folder and copies each audio asset there as `file`, leaving a file that already exists alone; a file that fails is reported and the rest still go on. Null when cancelled. */
export async function saveAudioFiles(items:{assetId:string;file:string}[]):Promise<{saved:number;skipped:string[];failed:{file:string;error:string}[]}|null>{
 if(!desktop)throw Error('Mở bản desktop để lưu tệp.');
 const dir=await open({directory:true});if(typeof dir!=='string')return null;
 const base=dir.replace(/[\\/]$/,'')+(dir.includes('\\')?'\\':'/'),skipped:string[]=[],failed:{file:string;error:string}[]=[];let saved=0;
 for(const {assetId,file} of items){try{if(await call<boolean>('export_asset_new',{assetId,path:base+file}))saved++;else skipped.push(file);}catch(e){failed.push({file,error:String(e instanceof Error?e.message:e)});}}
 return {saved,skipped,failed};
}
