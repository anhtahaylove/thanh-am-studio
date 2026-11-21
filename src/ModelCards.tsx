import {AudioLines,Check,FileText,Music,TriangleAlert,Users} from 'lucide-react';
import type {LucideIcon} from 'lucide-react';
import type {ReactNode} from 'react';
import {MODEL_RAM_MB,formatBytes,modelAdvice,modelSize} from './models';
import type {ModelInfo} from './types';
const ICONS:Record<string,LucideIcon>={'vieneu-v3':AudioLines,'whisper-small':FileText,'whisper-turbo':FileText,diarization:Users,htdemucs:Music,'separation-runtime':Music};
/** One model: what it costs to download and to run, a recommendation for this machine, and its action (children). */
export function ModelCard({m,totalMb,children}:{m:ModelInfo;totalMb:number|null;children:ReactNode}){
 const Icon=ICONS[m.id]??AudioLines,size=modelSize(m.id),ram=MODEL_RAM_MB[m.id]??null,advice=modelAdvice(m.id,totalMb);
 return <article className="panel model-card">
  <div className="model-icon"><Icon size={27}/></div>
  <div className="eyebrow">{m.engine}</div><h3>{m.name}</h3>
  {advice.badge&&<span className={`mc-badge ${advice.badge}`}>{advice.badge==='heavy'?<TriangleAlert size={14}/>:<Check size={14}/>}{advice.badge==='heavy'?'Có thể nặng với máy này':'Đề xuất cho máy bạn'}</span>}
  <p>{m.description}</p>
  {advice.note&&<p className="mc-reason">{advice.note}</p>}
  <dl className="mc-facts"><dt>Dung lượng tải</dt><dd>{size==null?'Chưa rõ':formatBytes(size)}</dd><dt>RAM khi chạy</dt><dd>{ram==null?'Chưa đo':`khoảng ${formatBytes(ram*1e6)}`}{m.id==='vieneu-v3'&&<small>Chưa tính Whisper Small khi bật Tự kiểm bằng Whisper</small>}</dd><dt>Giấy phép</dt><dd>{m.license}</dd><dt>Phiên bản</dt><dd title={m.revision}>{m.revision.slice(0,12)}</dd></dl>
  {children}
 </article>;
}
