import {useEffect,useRef} from 'react';
import {UserAttentionType,getCurrentWindow} from '@tauri-apps/api/window';
import {addPluginListener} from '@tauri-apps/api/core';
import {call,desktop} from './bridge';
import type {Asset,Job,ProjectSummary} from './types';

const KINDS=['stt','render','separate'],LONG_MS=30000;
/** The jobs of the notified kinds that ended in this poll after running (or waiting) for at least 30 s, each with `ms`, how long that was. `seen` maps a job id to when the app took it to have started,
 * and is updated in place: a job counts once it has been seen queued or running in an earlier poll (the app may never see "running" between two polls), starting at
 * its `updated_at` when first seen running and at the poll time when first seen queued. A job that is cancelled, interrupted or already over at the first poll counts for nothing. */
export function jobNotices(seen:Map<string,number>,jobs:Job[],now:number):(Job&{ms:number})[]{
 const done:(Job&{ms:number})[]=[];
 for(const j of jobs){
  if(!KINDS.includes(j.kind))continue;
  if(j.status==='queued'||j.status==='running'){if(!seen.has(j.id)){const t=Date.parse(j.updated_at);seen.set(j.id,j.status==='running'&&Number.isFinite(t)?t:now);}continue;}
  const start=seen.get(j.id);seen.delete(j.id);
  if((j.status==='succeeded'||j.status==='failed')&&start!==undefined&&now-start>=LONG_MS)done.push({...j,ms:now-start});
 }
 return done;
}
const DONE:Record<string,string>={stt:'Đã chép lời xong',render:'Đã xuất audio xong',separate:'Đã tách nhạc nền xong'};
const FAILED:Record<string,string>={stt:'Chép lời không thành công',render:'Xuất audio không thành công',separate:'Tách nhạc nền không thành công'};
const KIND_NAME:Record<string,string>={stt:'Chép lời',render:'Xuất audio',separate:'Tách nhạc nền'};
const duration=(ms:number)=>{const s=Math.round(ms/1000);if(s<60)return `${s} giây`;const m=Math.round(s/60),h=Math.floor(m/60);return h?`${h} giờ${m%60?` ${m%60} phút`:''}`:`${m} phút`;};
export interface Ended{kind:string;status:string;name:string;ms:number}
/** The title and body of the desktop notification for the jobs that ended in one poll: one job gets its own title, name and duration; several get a count and up to three "kind: name". */
export function noticeText(ended:Ended[]):{title:string;body:string}{
 if(ended.length>1){const more=ended.length-3;return {title:`Đã xong ${ended.length} công việc`,body:ended.slice(0,3).map(e=>e.name?`${KIND_NAME[e.kind]}: ${e.name}`:KIND_NAME[e.kind]).join('; ')+(more>0?` và ${more} việc khác`:'')};}
 const [e]=ended,failed=e.status==='failed';
 return {title:(failed?FAILED:DONE)[e.kind],body:[e.name,duration(e.ms),...failed?['Mở Thanh Âm Studio để xem lỗi.']:[]].filter(Boolean).join(' · ')};
}
/** What the job is about: its own name, else the file it works on, else its project. A lookup that fails leaves the name out. */
async function jobName(j:Job):Promise<string>{
 if(typeof j.payload?.name==='string'&&j.payload.name)return j.payload.name;
 try{
  if(typeof j.payload.asset_id==='string')return (await call<Asset|null>('get_asset',{id:j.payload.asset_id}))?.name??'';
  if(j.project_id)return (await call<ProjectSummary[]|null>('list_projects'))?.find(p=>p.id===j.project_id)?.name??'';
 }catch{/* the notification still says what finished */}
 return '';
}
/** Flashes the taskbar button and raises a desktop notification, once per poll, when such a job ends while the window is in the background; clicking the notification brings the window forward. Cosmetic: a failure is ignored. */
export function useJobNotices(jobs:Job[]){
 const seen=useRef(new Map<string,number>());
 useEffect(()=>{if(!desktop)return;const done=jobNotices(seen.current,jobs,Date.now());if(!done.length||document.hasFocus())return;void getCurrentWindow().requestUserAttention(UserAttentionType.Informational).catch(()=>{});
  void Promise.all(done.map(async j=>({kind:j.kind,status:j.status,ms:j.ms,name:await jobName(j)}))).then(ended=>call('plugin:notification|notify',{options:noticeText(ended)})).catch(()=>{});},[jobs]);
 useEffect(()=>{
  if(!desktop)return;let off:{unregister:()=>Promise<void>}|undefined,live=true;
  void addPluginListener('notification','actionPerformed',()=>{const w=getCurrentWindow();void w.unminimize().then(()=>w.show()).then(()=>w.setFocus()).catch(()=>{});}).then(l=>{if(live)off=l;else void l.unregister().catch(()=>{});}).catch(()=>{});
  return()=>{live=false;void off?.unregister().catch(()=>{});};
 },[]);
}
