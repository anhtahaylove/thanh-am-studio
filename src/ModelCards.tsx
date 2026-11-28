import {AudioLines,Check,FileText,Music,TriangleAlert,Users} from 'lucide-react';
import type {LucideIcon} from 'lucide-react';
import type {ReactNode} from 'react';
import {jobProgressLabel} from './domain';
import {MODEL_RAM_MB,formatBytes,modelAdvice,modelSize,ramText} from './models';
import type {Job,ModelInfo} from './types';
const ICONS:Record<string,LucideIcon>={'vieneu-v3':AudioLines,'whisper-small':FileText,'whisper-turbo':FileText,diarization:Users,htdemucs:Music,'separation-runtime':Music};
/** The download or re-check of this model that is queued or running, if any. */
export const activeDownload=(jobs:Job[],id:string)=>jobs.find(j=>j.kind==='model_download'&&j.payload.model_id===id&&(j.status==='queued'||j.status==='running'));
/** A running download shows its bar and label; a queued one has no progress yet, so only "Đang chờ…" (a 0 % bar would read as running). A job on an installed model (`check`) is a re-check, not a download, so a running one reads "Đang kiểm tra…". */
export const JobProgress=({job,check}:{job:Job;check?:boolean})=>job.status==='queued'?<small className="job-progress">Đang chờ…</small>:<><progress max={1} value={job.progress}/><small className="job-progress">{check?'Đang kiểm tra…':jobProgressLabel(job.kind,job.progress,job.updated_at)}</small></>;
/** One model: what it costs to download and to run, a recommendation for this machine, its running download (job) and its action (children). */
export function ModelCard({m,totalMb,job,children}:{m:ModelInfo;totalMb:number|null;job?:Job;children:ReactNode}){
 const Icon=ICONS[m.id]??AudioLines,size=modelSize(m.id),ram=MODEL_RAM_MB[m.id]??null,advice=modelAdvice(m.id,totalMb);
 return <article className="panel model-card">
  <div className="model-icon"><Icon size={27}/></div>
  <div className="eyebrow">{m.engine}</div><h3>{m.name}</h3>
  {advice.badge&&<span className={`mc-badge ${advice.badge}`}>{advice.badge==='heavy'?<TriangleAlert size={14}/>:<Check size={14}/>}{advice.badge==='heavy'?'Có thể nặng với máy này':'Đề xuất cho máy bạn'}</span>}
  <p>{m.description}</p>
  {advice.note&&<p className="mc-reason">{advice.note}</p>}
  <dl className="mc-facts"><dt>Dung lượng tải</dt><dd>{size==null?'Chưa rõ':formatBytes(size)}</dd><dt>RAM khi chạy</dt><dd>{ram!=null?`khoảng ${ramText(ram)}`:m.id==='separation-runtime'?'Đã tính trong thẻ Tách giọng và nhạc nền':'Chưa đo'}{m.id==='vieneu-v3'&&<small>Chưa tính Whisper Small khi bật Tự kiểm bằng Whisper</small>}{m.id==='diarization'&&<small>Cộng thêm vào RAM của model chép lời khi bật tách người nói</small>}</dd><dt>Giấy phép</dt><dd>{m.license}</dd><dt>Phiên bản</dt><dd title={m.revision}>{m.revision.slice(0,12)}</dd></dl>
  {job&&<JobProgress job={job} check={m.installed}/>}
  {children}
 </article>;
}
