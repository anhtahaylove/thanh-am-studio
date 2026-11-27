import {useEffect,useRef} from 'react';
import {AudioLines,Check,Circle,Download,FileText,ListChecks} from 'lucide-react';
import {jobProgressLabel} from './domain';
import {ModelCard,activeDownload} from './ModelCards';
import {formatBytes,modelSize,sttDefault} from './models';
import {ReasonButton} from './ui';
import type {Job,ModelInfo} from './types';
/** '' = show it as the steps allow, 'hidden' = the user hid it, 'done' = every step was done, 'shown' = brought back this session by the palette. */
export type Guide=''|'hidden'|'done'|'shown';
/** One checklist per job: the TTS page and the STT page each keep their own choice. */
export type Flow='tts'|'stt';
const KEYS:Record<Flow,string>={tts:'thanh-am-onboarding',stt:'thanh-am-onboarding-stt'};
export const readGuide=(flow:Flow):Guide=>{try{const v=localStorage.getItem(KEYS[flow]);return v==='hidden'||v==='done'?v:'';}catch{return '';}};
export const writeGuide=(flow:Flow,v:Guide)=>{try{if(v==='hidden'||v==='done')localStorage.setItem(KEYS[flow],v);else localStorage.removeItem(KEYS[flow]);}catch{/* storage is blocked: the choice lasts for this session only */}};
export interface OnboardingStep {id:'model'|'voice'|'export'|'pick'|'save';title:string;done:boolean;ready:boolean;/** The model a download step fetches, and its running download. */model?:string;job?:Job}
const sized=(title:string,id:string)=>{const size=modelSize(id);return size==null?title:`${title} (${formatBytes(size)})`;};
/** The three first-run steps of a job. `ready` is whether the step can be started: the first sentence needs a segment with text, the transcript export needs rows. */
export function onboardingSteps(flow:Flow,{models,jobs,hasText,hasTranscript,transcriptSaved,totalMb}:{models:ModelInfo[];jobs:Job[];hasText:boolean;hasTranscript:boolean;transcriptSaved:boolean;totalMb:number|null|undefined}):OnboardingStep[]{
 const ok=(kind:string)=>jobs.some(j=>j.kind===kind&&j.status==='succeeded');
 if(flow==='tts')return [
  {id:'model',title:sized('Tải VieNeu v3 Turbo','vieneu-v3'),done:models.some(m=>m.id==='vieneu-v3'&&m.installed),ready:true,model:'vieneu-v3',job:activeDownload(jobs,'vieneu-v3')},
  {id:'voice',title:'Tạo giọng cho đoạn đầu tiên',done:ok('tts'),ready:hasText},
  {id:'export',title:'Lưu file audio',done:ok('render'),ready:true},
 ];
 const installed=models.filter(m=>m.installed).map(m=>m.id),id=sttDefault(installed,totalMb); // the model the STT page selects: an installed one, else the recommended one
 return [
  {id:'model',title:sized(`Tải ${models.find(m=>m.id===id)?.name??id}`,id),done:installed.includes(id),ready:true,model:id,job:activeDownload(jobs,id)},
  {id:'pick',title:'Chọn tệp âm thanh để chép lời',done:ok('stt'),ready:true},
  {id:'save',title:'Lưu bản chép lời',done:transcriptSaved,ready:hasTranscript},
 ];
}
// The checklist is removed while it may hold the focus: hand it to the first control of its page, as the speaker merge does.
const TOOLBAR:Record<Flow,string>={tts:'.script-panel .panel-toolbar button',stt:'.transcript-panel .panel-toolbar button'};
const focusToolbar=(flow:Flow)=>{requestAnimationFrame(()=>document.querySelector<HTMLElement>(TOOLBAR[flow])?.focus());};
// Not the names of the controls they start ("Xuất audio", "Chọn tệp & chép lời", "Xuất…"): two buttons with one name on a page confuse a screen reader and every locator that looks for the real one.
const ACTIONS:Record<OnboardingStep['id'],string>={model:'Tải ngay',voice:'Tạo giọng ngay',export:'Xuất ngay',pick:'Chọn tệp ngay',save:'Chọn cách xuất'};
/** Mount it only after the first poll: the steps it sees on its first render are the baseline, and only a step that flips after that is announced.
 *  `offPage`: also announce while the page of this checklist is not open. The STT checklist stays quiet then, so a Whisper download finished from the Models page is told as a download (see App). `blocks` holds why a step cannot start now (a text under the step); `busy` only disables the buttons, with no text, so the checklist never changes height while the app works. */
export function FirstRunChecklist({flow,steps,guide,visible,offPage,busy,blocks,onGuide,onNotice,onAction}:{flow:Flow;steps:OnboardingStep[];guide:Guide;visible:boolean;offPage:boolean;busy:boolean;blocks:Partial<Record<OnboardingStep['id'],string|null>>;onGuide:(g:Guide)=>void;onNotice:(text:string,step:OnboardingStep)=>void;onAction:(step:OnboardingStep)=>void}){
 const baseline=useRef(steps.map(s=>s.done)),told=useRef<boolean[]>([]),all=steps.every(s=>s.done),speak=visible||offPage;
// A hidden or finished checklist announces nothing. This effect runs before the one below that writes `done`, so the step that finishes the list is still announced. A step finished while the checklist keeps quiet is marked told, so it is not announced later.
 useEffect(()=>{if(guide==='hidden'||guide==='done')return;steps.forEach((s,i)=>{if(s.done&&!baseline.current[i]&&!told.current[i]){told.current[i]=true;if(speak)onNotice(`Đã xong bước ${i+1}: ${s.title}`,s);}});});
 // A step that finishes removes its own button: if the focus was on it (or inside the checklist and now on <body>), hand it to the next button that can be used, else to the heading.
 const root=useRef<HTMLElement>(null),heading=useRef<HTMLHeadingElement>(null),inside=useRef(false),was=useRef(steps.map(s=>s.done));
 useEffect(()=>{
  const before=was.current;was.current=steps.map(s=>s.done);
  if(!visible||all||guide==='hidden'||guide==='done'||!inside.current||document.activeElement!==document.body||!steps.some((s,i)=>s.done&&!before[i]))return;
  (root.current?.querySelector<HTMLElement>('li:not(.is-done) button:not(:disabled):not([aria-disabled=true])')??heading.current)?.focus();
 });
 useEffect(()=>{if(all&&!guide){writeGuide(flow,'done');onGuide('done');if(visible&&document.activeElement===document.body)focusToolbar(flow);}},[all,guide,onGuide]); // the section was just removed under the focus
 if(!visible||guide==='hidden'||guide==='done'||(all&&!guide))return null;
 return <section ref={root} className="first-run panel" aria-labelledby="first-run-title" onFocus={()=>{inside.current=true;}} onBlur={e=>{const to=e.relatedTarget as Node|null,from=e.target as HTMLElement;if(to){if(!root.current!.contains(to))inside.current=false;}else setTimeout(()=>{if(from.isConnected)inside.current=false;});}}>
  <div className="first-run-head"><h2 id="first-run-title" ref={heading} tabIndex={-1}><ListChecks size={18}/>{flow==='stt'?'Chép lời đầu tiên với Thanh Âm':'Bắt đầu với Thanh Âm'}</h2><button className="quiet" onClick={()=>{writeGuide(flow,'hidden');onGuide('hidden');focusToolbar(flow);}}>Ẩn hướng dẫn</button></div>
  <ol>{steps.map(s=>{const reason=s.done?null:blocks[s.id]??null,busyDownload=!!s.job; // a running download keeps the button focusable (aria-disabled), so the focus stays on it
   return <li key={s.id} className={s.done?'is-done':''}>
    <span className="first-run-state">{s.done?<Check size={14}/>:<Circle size={14}/>}{s.done?'Đã xong':'Chưa làm'}</span>
    <span className="first-run-title">{s.title}{s.job&&!s.done&&<><progress max={1} value={s.job.progress}/><small className="job-progress">{jobProgressLabel(s.job.kind,s.job.progress,s.job.updated_at)}</small></>}</span>
    {!s.done&&<button className="outlined" disabled={!busyDownload&&(busy||!!reason||!s.ready)} aria-disabled={busyDownload||undefined} aria-describedby={reason?`first-run-why-${s.id}`:undefined} onClick={()=>{if(!busyDownload)onAction(s);}}>{busyDownload?'Đang tải…':ACTIONS[s.id]}</button>}
    {reason&&<small id={`first-run-why-${s.id}`}>{reason}</small>}
   </li>;})}</ol>
 </section>;
}
/** The start panel's stored choice (`thanh-am-start`): 'hidden' = "Để sau", 'done' = step 3 was reached. The pick at step 2 writes nothing, so a relaunch during that download resumes at step 2. */
export type StartChoice=''|'hidden'|'done';
const START_KEY='thanh-am-start';
export const readStart=():StartChoice=>{try{const v=localStorage.getItem(START_KEY);return v==='hidden'||v==='done'?v:'';}catch{return '';}};
export const writeStart=(v:'hidden'|'done')=>{try{localStorage.setItem(START_KEY,v);}catch{/* storage is blocked: the choice lasts for this session only */}};
/** Where the start panel stands: 1 the job choice, 2 the model cards (with `model` picked: a one-line strip with its download), 3 the hand-over to the job's checklist. */
export interface StartState {step:1|2|3;job?:Flow;model?:string}
/** What the panel shows at launch, decided once after the first poll: nothing once a choice is stored or a model is installed; the step-2 strip while a starter model picked earlier still downloads (even if its first segment made a project); else step 1 on a profile with no project. */
export function startAtLaunch({stored,projects,models,jobs,starters}:{stored:StartChoice;projects:number;models:ModelInfo[];jobs:Job[];starters:string[]}):StartState|null{
 if(stored||models.some(m=>m.kind!=='runtime'&&m.installed))return null;
 const dl=jobs.find(j=>j.kind==='model_download'&&(j.status==='queued'||j.status==='running')&&starters.includes(String(j.payload.model_id)));
 if(dl){const model=String(dl.payload.model_id);return {step:2,job:models.find(m=>m.id===model)?.engine==='stt'?'stt':'tts',model};}
 return projects?null:{step:1};
}
/** The model the job's page runs with once it is installed (the job's checklist step 1 is done), however it was downloaded; undefined while there is none. Reaching it is step 3. */
export const readyModel=(models:ModelInfo[],job:Flow,totalMb:number|null|undefined)=>{const s=onboardingSteps(job,{models,jobs:[],hasText:false,hasTranscript:false,transcriptSaved:false,totalMb})[0];return s.done?s.model:undefined;};
const JOBS=[{job:'tts',title:'Đọc văn bản thành giọng nói',text:'Gõ hoặc dán chữ, nghe và lưu thành file audio.',icon:AudioLines},{job:'stt',title:'Chép lời từ file âm thanh',text:'Chọn file ghi âm hoặc video, nhận bản chép lời.',icon:FileText}] as const;
/** The first-run start panel, where the checklist stands: not a dialog, "Để sau" at every step. The App moves the focus to the step heading (`#start-title`) after a pick, "Quay lại" or the palette;
 *  step 3, which a finished download reaches by itself, takes the focus only from inside the panel or from <body>, never from the text being typed or the STT button. */
export function StartPanel({start,page,models,jobs,starters,totalMb,busy,onPick,onDownload,onAll,onBack,onLater}:{start:StartState;page:Flow;models:ModelInfo[];jobs:Job[];starters:string[];totalMb:number|null;busy:boolean;onPick:(job:Flow)=>void;onDownload:(id:string)=>void;onAll:()=>void;onBack:()=>void;onLater:()=>void}){
 const root=useRef<HTMLElement>(null),heading=useRef<HTMLHeadingElement>(null),was=useRef(start.step);
 useEffect(()=>{const before=was.current,a=document.activeElement;was.current=start.step;if(start.step===3&&before!==3&&(a===document.body||root.current?.contains(a)))heading.current?.focus();},[start.step]);
 // The panel is removed under the focus: hand it to the checklist that now stands there, else to the page toolbar.
 const later=()=>{onLater();requestAnimationFrame(()=>(document.getElementById('first-run-title')??document.querySelector<HTMLElement>(TOOLBAR[page]))?.focus());};
 const title=(n:number,text:string)=><h2 id="start-title" ref={heading} tabIndex={-1}><span className="start-step">{`Bước ${n}/3`}</span> {text}</h2>;
 const head=(n:number,text:string)=><div className="start-head">{title(n,text)}<button type="button" className="quiet" onClick={later}>Để sau</button></div>;
 const model=start.model?models.find(m=>m.id===start.model):undefined,job=start.model?activeDownload(jobs,start.model):undefined;
 // A picked model shows as a strip while it downloads; one whose download failed or was cancelled goes back to the cards, so it can be started again.
 if(start.step===3||(start.step===2&&model&&(job||model.installed)))return <section ref={root} className="start-panel start-strip panel" aria-labelledby="start-title">
  {title(start.step,start.step===3?`Đã tải xong ${model?.name??start.model}.`:`Đang tải ${model?.name??start.model}…`)}
  {start.step===2&&job&&<div className="start-progress"><progress max={1} value={job.progress}/><small className="job-progress">{jobProgressLabel(job.kind,job.progress,job.updated_at)}</small></div>}
  <button type="button" className="quiet" onClick={later}>Để sau</button>
 </section>;
 if(start.step===2)return <section ref={root} className="start-panel panel" aria-labelledby="start-title">
  {head(2,'Chọn model')}<p>Model tải trong lúc bạn tiếp tục.</p>
  <div className="model-grid">{models.filter(m=>starters.includes(m.id)&&m.engine===start.job).map(m=>{const dl=activeDownload(jobs,m.id);return <ModelCard key={m.id} m={m} totalMb={totalMb} job={dl}><ReasonButton className={m.installed?'outlined full':'primary full'} disabled={busy} blocked={m.installed?'Đã tải':dl?'Đang tải…':null} onClick={()=>onDownload(m.id)}>{m.installed?<><Check size={16}/>Đã tải</>:<><Download size={16}/>{dl?'Đang tải…':'Tải model'}</>}</ReasonButton></ModelCard>;})}</div>
  <div className="start-actions"><button type="button" className="outlined" onClick={onBack}>Quay lại</button><button type="button" className="quiet" onClick={onAll}>Xem tất cả model</button></div>
 </section>;
 return <section ref={root} className="start-panel panel" aria-labelledby="start-title">
  {head(1,'Bạn muốn làm gì trước?')}
  <div className="start-cards">{JOBS.map(c=><button key={c.job} type="button" className="start-job" aria-labelledby={`start-${c.job}-title`} aria-describedby={`start-${c.job}-text`} onClick={()=>onPick(c.job)}><c.icon size={22}/><strong id={`start-${c.job}-title`}>{c.title}</strong><span id={`start-${c.job}-text`}>{c.text}</span></button>)}</div>
 </section>;
}
