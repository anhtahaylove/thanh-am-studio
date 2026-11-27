import {useEffect,useRef} from 'react';
import {Check,Circle,ListChecks} from 'lucide-react';
import {jobProgressLabel} from './domain';
import {activeDownload} from './ModelCards';
import {formatBytes,modelSize,sttDefault} from './models';
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
