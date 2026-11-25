import {useEffect,useState} from 'react';
import {X} from 'lucide-react';
import {call} from './bridge';
import {Modal,useEscape} from './Updates';
import {ReasonButton} from './ui';
import type {ProjectVersion} from './types';

const two=(n:number)=>String(n).padStart(2,'0'),clock=(d:Date)=>`${two(d.getHours())}:${two(d.getMinutes())}`,date=(d:Date)=>`${two(d.getDate())}/${two(d.getMonth()+1)}`;
const BUSY='Dự án đang có công việc chạy hoặc chờ. Chờ xong hoặc hủy rồi khôi phục.';
// The calendar day of `d` as seen from `now`: "Hôm nay", "Hôm qua", else dd/MM.
const day=(d:Date,now:Date)=>{const n=Math.round((new Date(now.getFullYear(),now.getMonth(),now.getDate()).getTime()-new Date(d.getFullYear(),d.getMonth(),d.getDate()).getTime())/864e5);return n===0?'Hôm nay':n===1?'Hôm qua':date(d);};
export const restoredNotice=(v:ProjectVersion)=>`Đã khôi phục trạng thái lúc ${clock(new Date(v.state_at))}. Trạng thái trước đó được lưu thành phiên bản “Trước khi khôi phục”.`;

/** The saved versions of the open project, newest first. `jobsActive` blocks every restore (the store refuses while a job is queued or running); `working` disables them while one restore runs. */
export function VersionHistory({projectId,jobsActive,working,onRestore,onClose,onError}:{projectId:string;jobsActive:boolean;working:boolean;onRestore:(v:ProjectVersion)=>void;onClose:()=>void;onError:(e:unknown)=>void}){
 useEscape(onClose);
 const [list,setList]=useState<ProjectVersion[]|null>(null);
 useEffect(()=>{let live=true;call<ProjectVersion[]>('list_project_versions',{projectId}).then(l=>{if(live)setList(l);},e=>{if(live)onError(e);});return()=>{live=false;};},[projectId]);
 const now=new Date();
 return <Modal><section className="modal panel versions" role="dialog" aria-modal="true" aria-labelledby="versions-title"><div className="panel-toolbar"><h3 id="versions-title">Lịch sử phiên bản</h3><button type="button" className="icon-button" aria-label="Đóng lịch sử phiên bản" title="Đóng lịch sử phiên bản" autoFocus onClick={onClose}><X size={17}/></button></div>
  <p>Ứng dụng tự lưu một phiên bản khi bạn sửa dự án, tối đa 10 phút một lần, và giữ tối đa 30 phiên bản gần nhất.</p>
  {list&&(list.length?<ol>{list.map((v,i)=>{const d=new Date(v.state_at);return <li key={v.id}><span className="version-when"><span className="version-label">{day(d,now)} lúc {clock(d)} · {v.segments} đoạn · {v.transcript} dòng chép lời</span>{v.reason==='before_restore'&&<span className="badge">Trước khi khôi phục</span>}</span><ReasonButton className="outlined" blocked={jobsActive?BUSY:null} disabled={working} autoFocus={i===0} aria-label={`Khôi phục trạng thái lúc ${clock(d)} ngày ${date(d)}`} onClick={()=>onRestore(v)}>Khôi phục</ReasonButton></li>;})}</ol>:<p className="hint">Chưa có phiên bản nào. Phiên bản đầu tiên được lưu khi bạn sửa dự án lần tới.</p>)}
 </section></Modal>;
}
