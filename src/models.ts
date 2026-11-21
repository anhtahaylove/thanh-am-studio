import {models as catalog} from '../worker/models.json';
interface Entry {id:string;artifacts:{size:number}[];pack?:{size:number}}
const entries:Entry[]=catalog;
/** Download size in bytes: the sum of a model's artifacts, or the pack for the separation runtime. */
export const modelSize=(id:string)=>{const m=entries.find(x=>x.id===id);return m?m.pack?.size??m.artifacts.reduce((n,a)=>n+a.size,0):null;};
/** Decimal units, vi-VN separators: 637 MB, 1,6 GB. */
export const formatBytes=(bytes:number)=>{const mb=Math.round(bytes/1e6);return mb>=1000?`${(bytes/1e9).toLocaleString('vi-VN',{maximumFractionDigits:1})} GB`:`${mb.toLocaleString('vi-VN')} MB`;};
/** Peak memory a model needs while it runs, in MB; null until measured (shown as "Chưa đo"). */
export const MODEL_RAM_MB:Record<string,number|null>={
 'vieneu-v3':2200, // STATUS.md: TTS worker peak 2,179 MB, clean 8 GB Sandbox 2,221 MB; README: about 2.2 GB
 'whisper-small':1300, // STATUS.md: windowed STT peak 1,231 MB; the Rust worker runs at 0.932-0.993x of that
 'whisper-turbo':null, // not measured yet (follow-up F1), so it is never recommended
 'diarization':null, // not measured yet
 'htdemucs':null, // not measured yet
 'separation-runtime':null, // not measured yet
};
/** Memory the OS, the app and WebView2 keep. A chosen policy margin, not derived from a measurement. */
const HEADROOM_MB=3072;
/** A 16 GB machine reports only about 15,700-15,900 MB of physical memory, so 16,384 would never pass. */
const TURBO_MIN_MB=14336;
export interface Advice {badge:'recommended'|'heavy'|null;note?:string}
/** A model's need, in decimal GB like its download size. */
const ramText=(mb:number)=>formatBytes(mb*1e6);
/** The machine total is in MiB (what Windows reports), so 1,024 MiB per GB: 8 GB shows as 7,7 GB. */
const machineText=(mb:number)=>`${(mb/1024).toLocaleString('vi-VN',{maximumFractionDigits:1})} GB`;
/** One recommendation per task for a machine with `totalMb` of physical memory (null: unknown). `ram` is a parameter so a test can pass a measured Turbo. */
export function modelAdvice(id:string,totalMb:number|null|undefined,ram:Record<string,number|null>=MODEL_RAM_MB):Advice{
 const total=totalMb??null,need=ram[id]??null;
 if(id==='vieneu-v3'){
  if(need==null||total==null||need+HEADROOM_MB<=total)return {badge:'recommended',note:total==null?'Chưa đọc được RAM của máy; đây là lựa chọn mặc định.':`Máy có ${machineText(total)} RAM, đủ cho model này.`};
  return {badge:'heavy',note:`Cần khoảng ${ramText(need)} RAM, máy chỉ có ${machineText(total)}. Đóng bớt ứng dụng khác trước khi đọc.`};
 }
 if(id==='whisper-small'||id==='whisper-turbo'){
  const turbo=ram['whisper-turbo']??null,turboPick=total!=null&&total>=TURBO_MIN_MB&&turbo!=null&&turbo+HEADROOM_MB<=total;
  if(id==='whisper-turbo')return turboPick?{badge:'recommended',note:`Máy có ${machineText(total)} RAM, đủ cho model lớn này.`}:{badge:null};
  if(turboPick)return {badge:null,note:'Cần cho Tự kiểm bằng Whisper'};
  return {badge:'recommended',note:total==null||need==null?'Chưa đọc được RAM của máy; đây là lựa chọn mặc định.':`Cần khoảng ${ramText(need)} RAM, máy có ${machineText(total)}.`};
 }
 return {badge:null};
}
