import {useEffect,useRef} from 'react';
import {UserAttentionType,getCurrentWindow} from '@tauri-apps/api/window';
import {desktop} from './bridge';
import type {Job} from './types';

const KINDS=['stt','render','separate'],LONG_MS=30000;
/** The jobs of the notified kinds that ended in this poll after running (or waiting) for at least 30 s. `seen` maps a job id to when the app took it to have started,
 * and is updated in place: a job counts once it has been seen queued or running in an earlier poll (the app may never see "running" between two polls), starting at
 * its `updated_at` when first seen running and at the poll time when first seen queued. A job that is cancelled, interrupted or already over at the first poll counts for nothing. */
export function jobNotices(seen:Map<string,number>,jobs:Job[],now:number):Job[]{
 const done:Job[]=[];
 for(const j of jobs){
  if(!KINDS.includes(j.kind))continue;
  if(j.status==='queued'||j.status==='running'){if(!seen.has(j.id)){const t=Date.parse(j.updated_at);seen.set(j.id,j.status==='running'&&Number.isFinite(t)?t:now);}continue;}
  const start=seen.get(j.id);seen.delete(j.id);
  if((j.status==='succeeded'||j.status==='failed')&&start!==undefined&&now-start>=LONG_MS)done.push(j);
 }
 return done;
}
/** Flashes the taskbar button, once per poll, when such a job ends while the window is in the background. A cosmetic feature: a failure is ignored. */
export function useJobNotices(jobs:Job[]){
 const seen=useRef(new Map<string,number>());
 useEffect(()=>{if(!desktop)return;const done=jobNotices(seen.current,jobs,Date.now());if(done.length)void getCurrentWindow().requestUserAttention(UserAttentionType.Informational).catch(()=>{});},[jobs]);
}
