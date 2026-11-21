import {useEffect,useRef} from 'react';
import {Check,Circle,ListChecks} from 'lucide-react';
import {formatBytes,modelSize} from './models';
import type {Job,ModelInfo,ProjectSummary} from './types';
/** '' = show it as the steps allow, 'hidden' = the user hid it, 'done' = every step was done, 'shown' = brought back this session by the palette. */
export type Guide=''|'hidden'|'done'|'shown';
const KEY='thanh-am-onboarding';
export const readGuide=():Guide=>{try{const v=localStorage.getItem(KEY);return v==='hidden'||v==='done'?v:'';}catch{return '';}};
export const writeGuide=(v:Guide)=>{try{if(v==='hidden'||v==='done')localStorage.setItem(KEY,v);else localStorage.removeItem(KEY);}catch{/* storage is blocked: the choice lasts for this session only */}};
export interface OnboardingStep {id:'model'|'project'|'voice';title:string;done:boolean;ready:boolean}
/** The three first-run steps. `ready` is whether the step can be started: the first sentence needs a segment with text. */
export function onboardingSteps({models,projects,jobs,hasText}:{models:ModelInfo[];projects:ProjectSummary[];jobs:Job[];hasText:boolean}):OnboardingStep[]{
 const size=modelSize('vieneu-v3');
 return [
  {id:'model',title:`Tải VieNeu v3 Turbo${size==null?'':` (${formatBytes(size)})`}`,done:models.some(m=>m.id==='vieneu-v3'&&m.installed),ready:true},
  {id:'project',title:'Tạo hoặc mở một dự án',done:projects.length>0,ready:true},
  {id:'voice',title:'Tạo giọng cho đoạn đầu tiên',done:jobs.some(j=>j.kind==='tts'&&j.status==='succeeded'),ready:hasText},
 ];
}
// The checklist is removed while it may hold the focus: hand it to the first control of the script panel, as the speaker merge does.
const focusToolbar=()=>{requestAnimationFrame(()=>document.querySelector<HTMLElement>('.script-panel .panel-toolbar button')?.focus());};
const ACTIONS={model:'Xem model giọng đọc',project:'Mở dự án mẫu',voice:'Tạo giọng ngay'};
/** Mount it only after the first poll: the steps it sees on its first render are the baseline, and only a step that flips after that is announced. */
export function FirstRunChecklist({steps,guide,visible,voiceBlock,onGuide,onNotice,onAction}:{steps:OnboardingStep[];guide:Guide;visible:boolean;voiceBlock:string|null;onGuide:(g:Guide)=>void;onNotice:(text:string)=>void;onAction:(id:OnboardingStep['id'])=>void}){
 const baseline=useRef(steps.map(s=>s.done)),told=useRef<boolean[]>([]),all=steps.every(s=>s.done);
// A hidden or finished checklist announces nothing. This effect runs before the one below that writes `done`, so the step that finishes the list is still announced.
 useEffect(()=>{if(guide==='hidden'||guide==='done')return;steps.forEach((s,i)=>{if(s.done&&!baseline.current[i]&&!told.current[i]){told.current[i]=true;onNotice(`Đã xong bước ${i+1}: ${s.title}`);}});});
 useEffect(()=>{if(all&&!guide){writeGuide('done');onGuide('done');if(visible&&document.activeElement===document.body)focusToolbar();}},[all,guide,onGuide]); // the section was just removed under the focus
 if(!visible||guide==='hidden'||guide==='done'||(all&&!guide))return null;
 return <section className="first-run panel" aria-labelledby="first-run-title">
  <div className="first-run-head"><h2 id="first-run-title"><ListChecks size={18}/>Bắt đầu với Thanh Âm</h2><button className="quiet" onClick={()=>{writeGuide('hidden');onGuide('hidden');focusToolbar();}}>Ẩn hướng dẫn</button></div>
  <ol>{steps.map(s=>{const reason=s.id==='voice'&&!s.done?voiceBlock:null;
   return <li key={s.id} className={s.done?'is-done':''}>
    <span className="first-run-state">{s.done?<Check size={14}/>:<Circle size={14}/>}{s.done?'Đã xong':'Chưa làm'}</span>
    <span className="first-run-title">{s.title}</span>
    {!s.done&&<button className="outlined" disabled={!!reason||!s.ready} aria-describedby={reason?`first-run-why-${s.id}`:undefined} onClick={()=>onAction(s.id)}>{ACTIONS[s.id]}</button>}
    {reason&&<small id={`first-run-why-${s.id}`}>{reason}</small>}
   </li>;})}</ol>
 </section>;
}
