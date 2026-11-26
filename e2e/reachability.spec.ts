import {test,expect} from '@playwright/test';
import type {Locator,Page} from '@playwright/test';
// Round 1.0.26 guard for the "Mạnh" simplification (PLAN §2, §6 T0); green on main, and every PR that moves a control edits the rows it moves.
// 1. Reachability: every control of the UX audit (§4-6) with the clicks that reach it from its page. A click is a trusted mouse click inside the page (typing,
//    shortcuts and native dialogs do not count); each path is at most 2 clicks (the §2 criterion-5 baseline), and each page at most 2 clicks from anywhere.
// 2. Page log: one scenario per `setPage(` line of App.tsx (the §2 table). A MutationObserver on `main h1` records each page change and whether a trusted input preceded it.
//    The four rows PLAN §2 marks "remove" are pinned as forced jumps at main: the AFTER_* constants below are the page the user lands on, one per row, and F1, F2 and F5 flip theirs.
// 3. Shortcuts and the keys PLAN §6 T0 lists, each with its effect.
// Tauri is mocked as in the other desktop specs; every command is recorded in window.__calls.
test.describe.configure({mode:'parallel'});
type At='tts'|'stt'|'voices'|'jobs'|'projects'|'models';
type W={models:boolean;projects:boolean;jobs:'none'|'done'|'all'};
const WORLDS={fresh:{models:false,projects:false,jobs:'none'},studio:{models:true,projects:true,jobs:'done'},busy:{models:true,projects:true,jobs:'all'}} satisfies Record<string,W>;
type WK=keyof typeof WORLDS;
const LABEL:Record<At,string>={tts:'Tạo giọng đọc',stt:'Chép lời',voices:'Thư viện giọng',jobs:'Hàng đợi',projects:'Dự án',models:'Model & cài đặt'};
// Forced jumps pinned at main (PLAN §2 rows :290, :359, :372, :382): the page the user is on after the action. Each owner sets its constant to the page the action started from.
const AFTER_RENDER='Hàng đợi'; // :290 "Xuất audio" (both setPage calls); F2 -> 'Tạo giọng đọc'
const AFTER_CHECKLIST_MODEL='Model & cài đặt'; // :359 the checklist's model button; F5 -> 'Tạo giọng đọc'
const AFTER_DOWNLOAD='Hàng đợi'; // :372 "Tải model" and "Kiểm tra lại gói"; F1 -> 'Model & cài đặt'
const AFTER_PACK_CONSENT='Hàng đợi'; // :382 "Đồng ý và tải"; F1 -> 'Model & cài đặt'

const tone=(()=>{const rate=8000,n=rate*4,b=Buffer.alloc(44+n*2);b.write('RIFF',0);b.writeUInt32LE(36+n*2,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(rate,24);b.writeUInt32LE(rate*2,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(n*2,40);for(let i=0;i<n;i++)b.writeInt16LE(Math.round(Math.sin(i/rate*2*Math.PI*440)*9000),44+i*2);return b;})();
const mock=(o:W)=>{
 const w=window as any,now='2026-11-22T00:00:00Z',ipc=(v:unknown)=>JSON.parse(JSON.stringify(v));w.isTauri=true;w.__calls=[];w.__clicks=0;w.__log=[];w.__polls=0;w.__cb=0;
 // The last trusted input (a mouse click has detail > 0, a click made by Enter has 0) and every change of the page heading.
 let input:{kind:string;name:string;t:number}|null=null,last='';
 const nameOf=(t:EventTarget|null)=>{const e=(t as Element|null)?.closest?.('button,[role=option],a,summary,input,select,textarea');return (e?.getAttribute('aria-label')||e?.textContent||'').trim().slice(0,60);};
 for(const type of ['click','keydown','change'])addEventListener(type,e=>{if(!e.isTrusted)return;if(type==='click'&&(e as MouseEvent).detail>0)w.__clicks++;input={kind:type,name:type==='keydown'?(e as KeyboardEvent).key:nameOf(e.target),t:performance.now()};},true);
 new MutationObserver(()=>{const t=document.querySelector('main h1')?.firstChild?.textContent??'';if(t&&t!==last){w.__log.push({from:last,to:t,input:input&&performance.now()-input.t<3000?input:null});last=t;input=null;}}).observe(document,{childList:true,subtree:true,characterData:true});
 w.__reset=()=>{input=null;w.__clicks=0;w.__log.length=0;w.__calls.length=0;}; // the scenario starts here, not at the setup clicks
 w.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};
 w.__drop=(paths:string[])=>w['_'+w.__dropId]({event:'tauri://drag-drop',id:1,payload:{paths,position:{x:1,y:1}}}); // the host delivers a drop, never a DOM event
 const take=(id:string)=>({id,asset_id:'a'+id,path:`/${id}.wav`,duration_ms:4000,sample_rate:8000,created_at:now});
 const seg=(id:string,text:string,takes:any[],extra:object={})=>({id,text,normalized_text:text,voice_id:null,speaker:'Người dẫn',gap_ms:300,takes,selected_take_id:takes[0]?.id??null,trim_start_ms:0,trim_end_ms:null,fade_in_ms:0,fade_out_ms:0,gain_db:0,...extra});
 const mk=(id:string,name:string,segments:any[],transcript:any[]=[],source:string|null=null)=>({id,name,updated_at:now,revision:1,segments,transcript,dictionary:{},source_asset_id:source});
 // p1: two segments with takes, chapters and subtitle cues; a diarized transcript whose last row repeats the one before it (a suspect row) and a source audio.
 const store:any[]=o.projects?[mk('p1','Dự án thử',[seg('s1','Xin chào làng chài.',[take('t1'),take('t1b')],{chapter:'Chương 1',cue_start_ms:0,cue_end_ms:3000}),seg('s2','Hẹn gặp lại.',[take('t2')],{chapter:'Chương 2',cue_start_ms:3000,cue_end_ms:5000})],[{id:'r1',start_ms:0,end_ms:3000,text:'Chào bạn.',speaker:0},{id:'r2',start_ms:3000,end_ms:5000,text:'Xin chào, tôi là Lan.',speaker:1},{id:'r3',start_ms:5000,end_ms:7000,text:'Xin chào, tôi là Lan.',speaker:1}],'src1'),mk('p2','Dự án khác',[seg('s9','Một câu.',[take('t9')])])]:[];
 if(o.projects)store[0].dictionary={TPHCM:'thành phố Hồ Chí Minh'}; // one entry in the project dictionary, one in the app dictionary (get_settings): their delete buttons
 const job=(id:string,kind:string,status:string,extra:object={})=>({id,kind,project_id:'p1',payload:{},status,progress:status==='succeeded'?1:status==='running'?0.4:0,error:status==='failed'?'Lỗi thử nghiệm':null,result:null,created_at:now,updated_at:now,...extra});
 const jobs:any[]=o.jobs==='none'?[]:[job('j1','tts','succeeded',{payload:{segment_id:'s1',text:'Xin chào.'},result:{asset_id:'at1'}}),job('j2','stt','succeeded',{payload:{asset_id:'src1',name:'phong-van.wav'},result:{segments:[{start_ms:0,end_ms:2000,text:'Mới.'}]}}),job('j3','render','succeeded',{payload:{name:'Chương 1',format:'wav',batch:'b1',batch_size:1},result:{asset_id:'ar1'}}),...o.jobs==='all'?[job('j4','tts','running',{payload:{segment_id:'s2',text:'y'}}),job('j5','render','queued',{payload:{name:'Bản xuất'}}),job('j6','stt','failed',{payload:{name:'hong.wav'}})]:[]];
 w.__finish=()=>{for(const j of jobs){j.status='succeeded';j.progress=1;j.result=j.result??{asset_id:'x',segments:[{start_ms:0,end_ms:1000,text:'Xong.'}]};}};
 const MODELS=[['vieneu-v3','VieNeu v3 Turbo','tts','model'],['whisper-small','Whisper Small','stt','model'],['whisper-turbo','Whisper Large v3 Turbo','stt','model'],['diarization','Phân biệt người nói','stt','model'],['htdemucs','Tách giọng và nhạc nền','separate','model'],['separation-runtime','Gói chạy tách nhạc nền','runtime','runtime']];
 w.__TAURI_INTERNALS__={convertFileSrc:(p:string)=>p,transformCallback:(f:unknown)=>{const id=++w.__cb;w['_'+id]=f;return id;},unregisterCallback:()=>{},metadata:{currentWindow:{label:'main'},currentWebview:{label:'main',windowLabel:'main'}},
  invoke:async(cmd:string,args:any)=>{w.__calls.push({cmd,args:ipc(args??{}),t:performance.now()});switch(cmd){
   case 'plugin:event|listen':if(args.event==='tauri://drag-drop')w.__dropId=args.handler;return 1;
   case 'list_projects':return store.map(p=>({id:p.id,name:p.name,updated_at:p.updated_at,revision:p.revision}));
   case 'load_project':return ipc(store.find(p=>p.id===args.id));
   case 'create_project':{const p=mk('n'+store.length,args.name,[]);store.unshift(p);return ipc(p);}
   case 'save_project':{const next={...ipc(args.project),revision:args.project.revision+1},i=store.findIndex(p=>p.id===next.id);if(i<0)store.unshift(next);else store[i]=next;return ipc(next);}
   case 'delete_project':store.splice(store.findIndex(p=>p.id===args.id),1);return null;
   case 'list_jobs':w.__polls++;return ipc(jobs);
   case 'list_voices':return o.models?[{id:'v1',name:'Giọng thử',kind:'preset',reference_asset_id:null,consent:true,engine_voice_id:'v1'}]:[];
   case 'list_models':return MODELS.map(([id,name,engine,kind])=>({id,name,engine,kind,installed:o.models,revision:'r1abcdef0123456',license:'Apache-2.0',description:''}));
   case 'runtime_status':return {python_ready:true,ffmpeg_ready:true,worker_ready:true,native_worker_ready:true,python_path:null,ffmpeg_path:null,native_worker_path:null,fallback_count:0,total_memory_mb:null,message:''};
   case 'get_settings':return {dictionary:o.projects?{UBND:'ủy ban nhân dân'}:{}};
   case 'plugin:dialog|save':return 'C:/x/ban-xuat.wav';
   case 'get_asset':return {id:args.id,path:'/src.wav',name:'phong-van.wav',duration_ms:60000,sample_rate:16000};
   case 'import_asset':return {id:'ai1',path:args.path,name:'moi.wav',duration_ms:5000,sample_rate:16000};
   case 'read_text_file':return 'Xin chào làng chài. Hẹn gặp lại.';
   case 'list_project_versions':return [{id:'v1',project_id:'p1',revision:1,state_at:now,created_at:now,reason:'auto',segments:2,transcript:3,chars:30,bytes:1000}];
   case 'restore_project_version':{const p=store.find(x=>x.id===args.projectId);p.revision++;return ipc(p);}
   case 'enqueue_job':{const j=job('n'+jobs.length,args.kind,'queued',{project_id:args.projectId,payload:args.payload});jobs.push(j);return ipc(j);}
   default:return null;}}};
};

type Role=Parameters<Page['getByRole']>[0];
// [role, name, scope, first]: `label` finds a field by its label text, `css` by selector, `text` by its text; scope is a CSS selector for the container (the first item of a list scope in MANY).
// A locator must match one element (strict); F(...) marks the few controls that really repeat.
type L=[role:Role|'label'|'css'|'text',name:string|RegExp,scope?:string,first?:'first'];
type Step=L|[L,string]; // a click, or a fill (typing is no click)
const MANY=new Set(['.segment','.transcript-row','.project-card']);
const F=(l:L):L=>[l[0],l[1],l[2],'first'];
const at=(page:Page,[role,name,scope,first]:L):Locator=>{const root=scope?MANY.has(scope)?page.locator(scope).first():page.locator(scope):page;const loc=role==='label'?root.getByLabel(name,{exact:true}):role==='css'?root.locator(name as string):role==='text'?root.getByText(name,{exact:true}):root.getByRole(role,{name,exact:typeof name==='string'||undefined});return first?loc.first():loc;};
const act=(page:Page,s:Step)=>Array.isArray(s[0])?at(page,s[0] as L).fill(s[1] as string):at(page,s as L).click();
const clicks=(path:Step[])=>path.filter(s=>!Array.isArray(s[0])).length;
const NAVBAR='nav[aria-label="Điều hướng chính"]';
const NAV=(to:At):Step=>['button',new RegExp('^'+LABEL[to]),NAVBAR]; // the queue button also carries a count badge
const read=<T>(page:Page,fn:()=>T)=>page.evaluate(fn);
const h1=(page:Page)=>read(page,()=>document.querySelector('main h1')?.firstChild?.textContent??'');
const calls=(page:Page,cmd:string)=>page.evaluate(c=>(window as any).__calls.filter((x:any)=>x.cmd===c) as {args:any;t:number}[],cmd);
// Opens the world on the TTS page (a world with projects opens its first project, which is where the script and the dock have content), then goes to `to`.
// Setup clicks are not counted: the counters and the page log start after it.
const open=async(page:Page,world:WK,to:At='tts')=>{
 await page.route(/\/[\w-]+\.wav$/,r=>r.fulfill({body:tone,contentType:'audio/wav'}));
 await page.addInitScript(mock,WORLDS[world]);await page.goto('/');
 if(WORLDS[world].projects){await act(page,NAV('projects'));await act(page,F(['button','Mở dự án']));await expect(at(page,['textbox','Nội dung đoạn 2'])).toBeVisible();}
 if(to!=='tts')await act(page,NAV(to));
 await expect(page.locator('main h1')).toContainText(LABEL[to]);
 await page.evaluate(()=>(window as any).__reset());
};

const SEG='.segment',INSP='.inspector',DOCK='#audio-dock',FIRST='.first-run',TB='.topbar-actions',STT='.transcript-panel',TIME=F(['css','.transcript-row .tr-time']);
// [id, world, page, clicks before the control is there, the control]
const ROWS:[string,WK,At,Step[],L][]=[
 // Global chrome (any page) and the first-run page: no project, no model.
 ...(['Chuyển giao diện theo hệ thống','Chuyển giao diện sáng','Chuyển giao diện tối','Chuyển giao diện tương phản cao'] as const).map(n=>[`chrome: ${n}`,'fresh','tts',[],['button',n]] as [string,WK,At,Step[],L]),
 ['hero: Tùy chọn','fresh','tts',[],['button','Tùy chọn']],
 ['hero: Chế độ tập trung','fresh','tts',[['button','Tùy chọn']],['button','Chế độ tập trung']],
 ['hero: Đọc từ tiếng Anh','fresh','tts',[['button','Tùy chọn']],['checkbox','Đọc từ tiếng Anh']],
 ['hero: Tự kiểm bằng Whisper','fresh','tts',[['button','Tùy chọn']],['checkbox','Tự kiểm bằng Whisper']],
 ['hero: Tạo giọng tất cả','fresh','tts',[],['button','Tạo giọng tất cả']],
 ['script: Nhập TXT / SRT / Word','fresh','tts',[],['button','Nhập TXT / SRT / Word']],
 ['script: Thêm nội dung','fresh','tts',[],['button','Thêm nội dung']],
 ['script: Thêm nội dung, its text box','fresh','tts',[['button','Thêm nội dung']],['textbox','Nội dung cần thêm']],
 ['empty: Viết đoạn đầu tiên','fresh','tts',[],['button','Viết đoạn đầu tiên','.script-empty']],
 ['empty: Mở dự án mẫu','fresh','tts',[],['button','Mở dự án mẫu','.script-empty']],
 ['footer: Thêm đoạn','fresh','tts',[],['button','Thêm đoạn','.script-footer']],
 ['checklist: Xem model giọng đọc','fresh','tts',[],['button','Xem model giọng đọc',FIRST]],
 ['checklist: Mở dự án mẫu','fresh','tts',[],['button','Mở dự án mẫu',FIRST]],
 ['checklist: Tạo giọng ngay','fresh','tts',[],['button','Tạo giọng ngay',FIRST]],
 ['checklist: Ẩn hướng dẫn','fresh','tts',[],['button','Ẩn hướng dẫn',FIRST]],
 ['inspector: Từ điển phát âm','fresh','tts',[],['button','Từ điển phát âm',INSP]],
 ...(['textbox:Từ gốc','textbox:Cách đọc','button:Thêm cách đọc','button:Nhập CSV','button:Xuất CSV'] as const).map(s=>{const [role,name]=s.split(':');return [`inspector dictionary: ${name}`,'fresh','tts',[['button','Từ điển phát âm',INSP]],[role as Role,name,INSP]] as [string,WK,At,Step[],L];}),
 ['inspector dictionary: Xóa TPHCM','studio','tts',[['button','Từ điển phát âm',INSP]],['button','Xóa TPHCM',INSP]],
 ['dock: Nghe thử đoạn','fresh','tts',[],['button','Nghe thử đoạn',DOCK]],
 ['dock: Định dạng audio','fresh','tts',[],['combobox','Định dạng audio',DOCK]],
 ['dock: Chuẩn hóa','fresh','tts',[],['checkbox','Chuẩn hóa',DOCK]],
 ['dock: Xuất audio','fresh','tts',[],['button','Xuất audio',DOCK]],
 ['dock: SRT','fresh','tts',[],['button','SRT',DOCK]],
 // TTS page with a project: top bar, one segment, the inspector, the dock.
 ['top bar: Hoàn tác','studio','tts',[],['button','Hoàn tác (Ctrl+Z)',TB]],
 ['top bar: Làm lại','studio','tts',[],['button','Làm lại (Ctrl+Shift+Z)',TB]],
 ['top bar: Lịch sử phiên bản','studio','tts',[],['button','Lịch sử phiên bản',TB]],
 ['top bar: save state','studio','tts',[],['button','Đã lưu',TB]],
 ['segment: Nội dung','studio','tts',[],['textbox','Nội dung đoạn 1',SEG]],
 ['segment: Nhân vật','studio','tts',[],['textbox','Nhân vật đoạn 1',SEG]],
 ...(['Chia đoạn tại con trỏ','Chèn khoảng nghỉ 0,5 giây tại con trỏ','Gộp với đoạn sau','Đưa đoạn lên','Đưa đoạn xuống','Xóa đoạn','Tạo take mới','Chi tiết đoạn 1'] as const).map(n=>[`segment: ${n}`,'studio','tts',[],['button',n,SEG]] as [string,WK,At,Step[],L]),
 ['segment: Thở dài','studio','tts',[],['button','Thở dài',SEG]],
 ['inspector: Giọng đoạn','studio','tts',[],['combobox','Giọng đoạn 1',INSP]],
 ['inspector: Tốc độ','studio','tts',[],['combobox','Tốc độ đọc đoạn 1',INSP]],
 ['inspector: Take đang sử dụng','studio','tts',[],['combobox',/^Take đang sử dụng/,INSP]],
 ['inspector: Chương','studio','tts',[['text','Chỉnh âm',INSP]],['textbox','Chương',INSP]],
 ...(['Nghỉ sau (ms)','Âm lượng (dB)','Cắt đầu (ms)','Cắt cuối (ms)','To dần (ms)','Nhỏ dần (ms)'] as const).map(n=>[`inspector: ${n}`,'studio','tts',[['text','Chỉnh âm',INSP]],['label',n,INSP]] as [string,WK,At,Step[],L]),
 ['inspector: Văn bản sau chuẩn hóa','studio','tts',[],['text','Văn bản sau chuẩn hóa',INSP]],
 ['inspector: Phân vai, giọng','studio','tts',[],['combobox','Giọng của Người dẫn',INSP]],
 ['inspector: Phân vai, nghe mẫu','studio','tts',[],['button','Nghe mẫu giọng của Người dẫn',INSP]],
 ['inspector: Tải lại để nhận take mới','studio','tts',[],['button','Tải lại để nhận take mới',INSP]],
 ['dock: Theo mốc phụ đề','studio','tts',[],['checkbox','Theo mốc phụ đề',DOCK]],
 ['dock: Giữ nhạc nền','studio','tts',[['checkbox','Theo mốc phụ đề',DOCK]],['checkbox','Giữ nhạc nền',DOCK]],
 ['dock: Mỗi chương một file','studio','tts',[],['checkbox','Mỗi chương một file',DOCK]],
 ['dock: take strip','studio','tts',[],['toolbar','So sánh take',DOCK]],
 ['dock: Dùng take này','studio','tts',[['button',/^Take 2/,DOCK]],['button','Dùng take này',DOCK]],
 ['dock: waveform Cắt đầu','studio','tts',[],['slider','Cắt đầu',DOCK]],
 ['dock: waveform Cắt cuối','studio','tts',[],['slider','Cắt cuối',DOCK]],
 // STT page: a transcript with a source audio, two speakers and a suspect row.
 ['stt: Model STT','studio','stt',[],['combobox','Model STT']],
 ['stt: Ngôn ngữ STT','studio','stt',[],['combobox','Ngôn ngữ STT']],
 ['stt: Phân biệt người nói','studio','stt',[],['checkbox','Phân biệt người nói']],
 ['stt: Số người nói','studio','stt',[],['combobox','Số người nói']],
 ['stt: Chọn tệp & chép lời','studio','stt',[],['button','Chọn tệp & chép lời']],
 ['stt: Thêm dòng','studio','stt',[],['button','Thêm dòng',STT]],
 ['stt: Thành kịch bản','studio','stt',[],['button','Thành kịch bản',STT]],
 ['stt: search','studio','stt',[],['textbox','Tìm trong bản chép lời']],
 ['stt: dòng đáng ngờ','studio','stt',[],['button',/^\d+ dòng đáng ngờ$/,STT]],
 ['stt: Thay bằng','studio','stt',[[['textbox','Tìm trong bản chép lời'],'Xin chào']],['textbox','Thay bằng']],
 ['stt: Thay N chỗ','studio','stt',[[['textbox','Tìm trong bản chép lời'],'Xin chào']],['button',/^Thay \d+ chỗ/]],
 ...(['TXT','SRT','VTT'] as const).map(n=>[`stt: ${n}`,'studio','stt',[],['button',n,STT]] as [string,WK,At,Step[],L]),
 ['stt: source audio player','studio','stt',[],['css','.source-player audio']],
 ['stt: Tốc độ nghe','studio','stt',[],['combobox','Tốc độ nghe']],
 ['stt: Theo lời khi phát','studio','stt',[],['button','Theo lời khi phát']],
 ['stt speakers: Nghe mẫu','studio','stt',[],['button','Nghe mẫu Người 1','.speaker-panel']],
 ['stt speakers: Gộp vào','studio','stt',[],['combobox','Gộp Người 1 vào','.speaker-panel']],
 ['stt speakers: Gộp','studio','stt',[],['button','Gộp Người 1','.speaker-panel']],
 ['stt row: speaker','studio','stt',[],['combobox',/^Người nói tại/,'.transcript-row']],
 ['stt row: Phát từ','studio','stt',[],['button',/^Phát từ/,'.transcript-row']],
 ['stt row: time','studio','stt',[],TIME],
 ['stt row: time editor, Bắt đầu','studio','stt',[TIME],['label','Bắt đầu']],
 ['stt row: time editor, Kết thúc','studio','stt',[TIME],['label','Kết thúc']],
 ['stt row: Lời nói','studio','stt',[],['textbox',/^Lời nói tại/,'.transcript-row']],
 ['stt row: Chia đoạn','studio','stt',[],['button','Chia đoạn tại giữa số từ','.transcript-row']],
 ['stt row: Xóa dòng','studio','stt',[],['button','Xóa dòng','.transcript-row']],
 ['stt row: Gộp sau','studio','stt',[],['button','Gộp sau','.transcript-row']],
 ['stt: Tạo dự án TTS từ transcript','studio','stt',[],['button','Tạo dự án TTS từ transcript']],
 // Voices, queue, projects, models.
 ['voices: Tên hiển thị','studio','voices',[],['label','Tên hiển thị']],
 ['voices: Chọn mẫu audio','studio','voices',[],['button','Chọn mẫu audio']],
 ['voices: Nghe mẫu đã làm sạch','studio','voices',[],['button','Nghe mẫu đã làm sạch']],
 ['voices: consent','studio','voices',[],['checkbox','Tôi có quyền sử dụng và tạo giọng từ mẫu audio này.']],
 ['voices: Lưu mẫu giọng','studio','voices',[],['button','Lưu mẫu giọng']],
 ['jobs: Làm mới','busy','jobs',[],['button','Làm mới']],
 ['jobs: Lưu tất cả chương','busy','jobs',[],['button','Lưu tất cả chương']],
 ['jobs: Hủy','busy','jobs',[],F(['button','Hủy'])],
 ['jobs: Thử lại','busy','jobs',[],['button','Thử lại']],
 ['jobs: Áp dụng transcript','busy','jobs',[],['button','Áp dụng transcript']],
 ['jobs: Mở take','busy','jobs',[],['button','Mở take']],
 ['jobs: Lưu audio','busy','jobs',[],['button','Lưu audio']],
 ['projects: Tên dự án mới','studio','projects',[],['label','Tên dự án mới']],
 ['projects: Tạo dự án','studio','projects',[],['button','Tạo dự án']],
 ['projects: Mở dự án','studio','projects',[],['button','Mở dự án','.project-card']],
 ['projects: Xóa dự án','studio','projects',[],['button','Xóa dự án Dự án thử','.project-card']],
 ['projects: Mở dự án mẫu','fresh','projects',[],['button','Mở dự án mẫu','.empty']],
 ['models: Tải model','fresh','models',[],F(['button','Tải model'])],
 ['models: Tải gói','fresh','models',[],['button','Tải gói']],
 ['models: Đã tải','studio','models',[],F(['button','Đã tải'])],
 ['models: Kiểm tra lại gói','studio','models',[],['button','Kiểm tra lại gói']],
 ['models: Nâng cao','studio','models',[['text','Nâng cao: bộ xử lý']],['combobox',/^Đọc văn bản/]],
 ['models: Xuất nhật ký chẩn đoán','studio','models',[],['button','Xuất nhật ký chẩn đoán']],
 ...(['textbox:Từ gốc','textbox:Cách đọc','button:Thêm cách đọc','button:Nhập CSV','button:Xuất CSV'] as const).map(s=>{const [role,name]=s.split(':');return [`models dictionary: ${name}`,'studio','models',[],[role as Role,name,'.app-dictionary']] as [string,WK,At,Step[],L];}),
 ['models dictionary: Xóa UBND','studio','models',[],['button','Xóa UBND','.app-dictionary']],
 ['models: Tự kiểm tra và tải bản mới','studio','models',[],['checkbox','Tự kiểm tra và tải bản mới']],
 ['models: Kiểm tra ngay','studio','models',[],['button','Kiểm tra ngay']],
 ['models: Có gì mới','studio','models',[],['button','Có gì mới']],
];
for(const [id,world,page,path,target] of ROWS)test(`reach ${page} | ${id}`,async({page:p})=>{
 await open(p,world,page);
 for(const s of path)await act(p,s);
 await expect(at(p,target),id).toBeVisible();
 const n=await read(p,()=>(window as any).__clicks as number);
 expect(n,'trusted clicks on the path').toBe(clicks(path));
 expect(clicks(path)+1,'the opening clicks plus the click that uses the control: at most 2 (PLAN §2, criterion 5)').toBeLessThanOrEqual(2);
});
// Each page at most 2 clicks from anywhere (criterion 5): Projects, Voices and Queue change owner in S2 and S3a; edit these paths there.
const PAGE_PATH:Record<At,Step[]>={tts:[NAV('tts')],stt:[NAV('stt')],voices:[NAV('voices')],jobs:[NAV('jobs')],projects:[NAV('projects')],models:[NAV('models')]};
for(const from of ['tts','models'] as const)for(const to of Object.keys(LABEL) as At[])if(to!==from)test(`page ${LABEL[to]} from ${LABEL[from]}`,async({page})=>{
 await open(page,'studio',from);
 for(const s of PAGE_PATH[to])await act(page,s);
 await expect(page.locator('main h1')).toContainText(LABEL[to]);
 const n=await read(page,()=>(window as any).__clicks as number);
 expect(n).toBe(clicks(PAGE_PATH[to]));expect(n).toBeLessThanOrEqual(2);
});

// Page log: the scenario starts on `from`, runs the action, and the page must be `lands` for good (the heading is read again after 500 ms, so a late jump is caught).
// A page change must follow a trusted input, except a native drop, which the host delivers.
const paletteOption=(name:string)=>async(p:Page)=>{await p.keyboard.press('Control+k');await p.getByRole('dialog',{name:'Bảng lệnh'}).getByRole('option',{name,exact:true}).click();};
const drop=(path:string)=>async(p:Page)=>{await expect.poll(()=>read(p,()=>!!(window as any).__dropId)).toBe(true);await p.evaluate(x=>(window as any).__drop([x]),path);};
// What the action did on the backend, so a flipped row fails when its button does nothing.
const queued=(kind:string)=>async(p:Page)=>{await expect.poll(async()=>(await calls(p,'enqueue_job')).map(c=>c.args.kind)).toContain(kind);};
const downloads=(want:object[])=>async(p:Page)=>{await expect.poll(async()=>(await calls(p,'download_model')).map(c=>c.args)).toEqual(want);};
const CHECKLIST_MODEL_DOWNLOADS:object[]=[]; // :359 at main only navigates; F5 -> [{id:'vieneu-v3'}] ("Tải ngay" downloads in place)
const SCENARIOS:[id:string,world:WK,from:At,run:(p:Page)=>Promise<unknown>,lands:string,native?:true,effect?:(p:Page)=>Promise<unknown>][]=[
 [':114 openDemo ("Mở dự án mẫu" on an empty Projects page)','fresh','projects',p=>act(p,['button','Mở dự án mẫu','.empty']),LABEL.tts],
 [':226 drop a script file','studio','jobs',drop('C:/x/kich-ban.txt'),LABEL.tts,true],
 [':226 drop an audio file','studio','tts',drop('C:/x/phong-van.wav'),LABEL.stt,true],
 [':244 newProject ("Tạo dự án")','studio','projects',p=>act(p,['button','Tạo dự án']),LABEL.tts],
 [':269 restoreVersion ("Khôi phục")','studio','stt',async p=>{await act(p,['button','Lịch sử phiên bản',TB]);await act(p,['button',/^Khôi phục trạng thái lúc/,'[role=dialog]']);},LABEL.tts],
 [':281 applyTranscript ("Áp dụng transcript")','studio','jobs',p=>act(p,['button','Áp dụng transcript']),LABEL.stt],
 [':290 render ("Xuất audio")','studio','tts',p=>act(p,['button','Xuất audio',DOCK]),AFTER_RENDER,undefined,queued('render')],
 [':290 render per chapter ("Mỗi chương một file", "Xuất audio")','studio','tts',async p=>{await act(p,['checkbox','Mỗi chương một file',DOCK]);await act(p,['button','Xuất audio',DOCK]);},AFTER_RENDER,undefined,queued('render')],
 ...(Object.keys(LABEL) as At[]).filter(to=>to!=='models').map(to=>[`:353 sidebar to ${LABEL[to]}`,'studio','models',p=>act(p,NAV(to)),LABEL[to]] as [string,WK,At,(p:Page)=>Promise<unknown>,string]),
 [':359 checklist model button ("Xem model giọng đọc")','fresh','tts',p=>act(p,['button','Xem model giọng đọc',FIRST]),AFTER_CHECKLIST_MODEL,undefined,downloads(CHECKLIST_MODEL_DOWNLOADS)],
 [':366 "Thành kịch bản"','studio','stt',p=>act(p,['button','Thành kịch bản',STT]),LABEL.tts],
 [':368 "Tạo dự án TTS từ transcript"','studio','stt',p=>act(p,['button','Tạo dự án TTS từ transcript']),LABEL.tts],
 [':370 "Mở take"','studio','jobs',p=>act(p,['button','Mở take']),LABEL.tts],
 [':371 "Mở dự án"','studio','projects',p=>act(p,['button','Mở dự án','.project-card']),LABEL.tts],
 [':372 download ("Tải model")','fresh','models',p=>act(p,F(['button','Tải model'])),AFTER_DOWNLOAD,undefined,downloads([{id:'vieneu-v3'}])],
 [':372 download ("Kiểm tra lại gói")','studio','models',p=>act(p,['button','Kiểm tra lại gói']),AFTER_DOWNLOAD,undefined,downloads([{id:'separation-runtime'}])],
 [':382 pack consent ("Đồng ý và tải")','fresh','models',async p=>{await act(p,['button','Tải gói']);await act(p,['button','Đồng ý và tải','[role=dialog]']);},AFTER_PACK_CONSENT,undefined,downloads([{id:'separation-runtime',licenseAccepted:true}])],
 ...(['Đi tới Tạo giọng đọc','Thêm đoạn mới','Bật chế độ tập trung','Tạo giọng tất cả','Tạo giọng đoạn đang chọn','Hiện hướng dẫn bắt đầu'] as const).map(n=>[`:383 palette "${n}"`,'studio','stt',paletteOption(n),LABEL.tts] as [string,WK,At,(p:Page)=>Promise<unknown>,string]),
 [':384 quick open (Ctrl+P, a project)','studio','stt',async p=>{await p.keyboard.press('Control+p');await p.getByRole('dialog',{name:'Mở nhanh dự án'}).getByRole('option',{name:'Dự án khác',exact:true}).click();},LABEL.tts],
];
for(const [id,world,from,run,lands,native,effect] of SCENARIOS)test(`page log ${id}`,async({page})=>{
 await open(page,world,from);
 await run(page);await effect?.(page);
 const stay=lands===LABEL[from]; // a flipped row: the action no longer moves the user
 if(!stay)await expect.poll(()=>h1(page)).toBe(lands);
 await page.waitForTimeout(500);expect(await h1(page)).toBe(lands);
 const log=(await read(page,()=>(window as any).__log as {from:string;to:string;input:{kind:string;name:string}|null}[])).filter(e=>e.from);
 if(stay){expect(log,'no page change').toEqual([]);return;}
 expect(log.at(-1)?.to).toBe(lands);
 expect(log.at(-1)?.input===null,`a ${native?'native drop has no DOM input':'trusted input precedes the page change'}: ${JSON.stringify(log.at(-1))}`).toBe(!!native);
});
test('page log: finishing background work never moves the page',async({page})=>{
 await open(page,'busy','tts');
 const start=await read(page,()=>(window as any).__polls as number);
 await page.evaluate(()=>(window as any).__finish());
 await page.waitForFunction(n=>(window as any).__polls>=n,start+2);
 await expect(page.locator(NAVBAR).getByRole('button',{name:'Hàng đợi',exact:true})).toBeVisible(); // the queue badge is gone: the app has taken the new job states in
 await page.waitForTimeout(500);expect(await h1(page)).toBe(LABEL.tts);
 expect((await read(page,()=>(window as any).__log as unknown[])).length).toBe(0);
});

// Shortcuts, and what each does.
test('Ctrl+K opens the command palette and Escape closes it',async({page})=>{
 await open(page,'studio');await page.keyboard.press('Control+k');const d=page.getByRole('dialog',{name:'Bảng lệnh'});
 await expect(d).toBeVisible();await page.keyboard.press('Escape');await expect(d).toHaveCount(0);
});
test('Ctrl+P opens quick open and Escape closes it',async({page})=>{
 await open(page,'studio');await page.keyboard.press('Control+p');const d=page.getByRole('dialog',{name:'Mở nhanh dự án'});
 await expect(d).toBeVisible();await page.keyboard.press('Escape');await expect(d).toHaveCount(0);
});
test('? opens the shortcut sheet and Escape closes it',async({page})=>{
 await open(page,'studio');await page.keyboard.press('?');const d=page.getByRole('dialog',{name:'Phím tắt'});
 await expect(d).toBeVisible();await page.keyboard.press('Escape');await expect(d).toHaveCount(0);
});
test('Ctrl+S saves the project at once, before the 0.9 s autosave',async({page})=>{
 await open(page,'studio');await at(page,['textbox','Nội dung đoạn 1']).fill('Xin chào lại.');
 const edited=await read(page,()=>performance.now());await page.keyboard.press('Control+s');
 await expect.poll(async()=>(await calls(page,'save_project')).length).toBeGreaterThan(0);
 expect((await calls(page,'save_project'))[0].t-edited,'ms from the edit to the first save').toBeLessThan(600);
});
test('Ctrl+Enter in a segment queues its voice',async({page})=>{
 await open(page,'studio');await at(page,['textbox','Nội dung đoạn 2']).click();await page.keyboard.press('Control+Enter');
 await expect.poll(async()=>(await calls(page,'enqueue_job')).map(c=>c.args.kind)).toEqual(['tts']);
});
test('Ctrl+Shift+F toggles focus mode',async({page})=>{
 await open(page,'studio');const grid=page.locator('.studio-grid.focus-mode'),button=at(page,['button','Chế độ tập trung']);await at(page,['button','Tùy chọn']).click();
 await page.keyboard.press('Control+Shift+f');await expect(grid).toHaveCount(1);await expect(button).toHaveAttribute('aria-pressed','true');
 await page.keyboard.press('Control+Shift+f');await expect(grid).toHaveCount(0);
});
test('Ctrl+F on the transcript page focuses the search box',async({page})=>{
 await open(page,'studio','stt');await page.keyboard.press('Control+f');await expect(at(page,['textbox','Tìm trong bản chép lời'])).toBeFocused();
});
test('Ctrl+Z and Ctrl+Y undo and redo an added segment',async({page})=>{
 await open(page,'studio');await at(page,['button','Thêm đoạn','.script-footer']).click(); // a segment with no take (undo and redo keep a segment that has takes, so its audio is never lost)
 const third=at(page,['textbox','Nội dung đoạn 3']);await expect(third).toBeVisible();
 await page.keyboard.press('Control+z');await expect(third).toHaveCount(0);
 await page.keyboard.press('Control+y');await expect(third).toBeVisible();
});
test('Escape in the segment details goes back to the segment text',async({page})=>{
 await open(page,'studio');await at(page,['text','Chỉnh âm',INSP]).click();await at(page,['textbox','Chương',INSP]).focus();await page.keyboard.press('Escape');
 await expect(at(page,['textbox','Nội dung đoạn 1'])).toBeFocused();
});
test('Alt+ArrowUp and Alt+ArrowDown move a segment',async({page})=>{
 await open(page,'studio');
 await at(page,['textbox','Nội dung đoạn 2']).click();await page.keyboard.press('Alt+ArrowUp');
 await expect(at(page,['textbox','Nội dung đoạn 1'])).toHaveValue('Hẹn gặp lại.');
 await at(page,['textbox','Nội dung đoạn 1']).click();await page.keyboard.press('Alt+ArrowDown');
 await expect(at(page,['textbox','Nội dung đoạn 1'])).toHaveValue('Xin chào làng chài.');
});
test('the segment toolbar and the take strip move focus with the arrow keys, Home and End',async({page})=>{
 await open(page,'studio');
 const first=at(page,['button','Chia đoạn tại con trỏ',SEG]);await first.focus();
 await page.keyboard.press('ArrowRight');await expect(at(page,['button','Chèn khoảng nghỉ 0,5 giây tại con trỏ',SEG])).toBeFocused();
 await page.keyboard.press('End');await expect(at(page,['button','Chi tiết đoạn 1',SEG])).toBeFocused();
 await page.keyboard.press('Home');await expect(first).toBeFocused();
 await at(page,['button',/^Take 1/,DOCK]).focus();await page.keyboard.press('ArrowRight');await expect(at(page,['button',/^Take 2/,DOCK])).toBeFocused();
});
test('the waveform trim handle moves by 10 ms with ArrowRight',async({page})=>{
 await open(page,'studio');const handle=at(page,['slider','Cắt đầu',DOCK]);await expect(handle).toBeVisible();
 await handle.focus();await page.keyboard.press('ArrowRight');await expect(handle).toHaveAttribute('aria-valuenow','10');
});
test('the transcript row time editor: Enter applies and Escape cancels, both give focus back to the time button',async({page})=>{
 await open(page,'studio','stt');const time=at(page,TIME),start=at(page,['label','Bắt đầu']);
 await time.click();await expect(start).toBeFocused();await start.fill('0:01,000');await start.press('Enter');
 await expect(time).toHaveText('0:01,000 – 0:03,000');await expect(time).toBeFocused();
 await time.click();await start.fill('0:02,000');await start.press('Escape');
 await expect(time).toHaveText('0:01,000 – 0:03,000');await expect(time).toBeFocused();
});
