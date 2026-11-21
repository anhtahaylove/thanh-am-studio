import {useId,useState} from 'react';
import type {LucideIcon} from 'lucide-react';
import {desktop} from './bridge';
import type {Segment} from './types';

export function IconButton({label,icon:Icon,onClick,disabled=false,pressed}:{label:string;icon:LucideIcon;onClick:()=>void;disabled?:boolean;pressed?:boolean}){return <button type="button" className="icon-button" aria-label={label} title={label} aria-pressed={pressed} onClick={onClick} disabled={disabled}><Icon size={17}/></button>;}
// Why an action cannot run, or null: its button shows this as the title and its palette command as the reason. Only the palette adds `busy`, since a busy button is just disabled next to the busy indicator.
export const whyBlocked={generateAll:(ttsBlock:string|null,count:number)=>ttsBlock??(count?null:'Thêm ít nhất một đoạn'),generate:(ttsBlock:string|null,segment?:Segment)=>ttsBlock??(!segment?'Thêm ít nhất một đoạn':segment.text.trim()?null:'Đoạn này chưa có nội dung'),exportAudio:(count:number)=>!desktop?'Cần bản desktop để xuất audio':count?null:'Thêm ít nhất một đoạn',busy:(busy:boolean)=>busy?'Đang xử lý một việc khác':null};
export function Empty({icon:Icon,title,children}:{icon:LucideIcon;title:string;children:React.ReactNode}){return <div className="empty"><div className="empty-icon"><Icon size={30}/></div><h3>{title}</h3><p>{children}</p></div>;}
// What is typed stays a draft until blur, Enter or Ctrl+S (which runs before the window's save handler), so a keystroke is never applied to (or appended after) a rejected value; Escape restores the stored value.
export function NumberField({label,value,onChange,min=0,step=1,check}:{label:string;value:number;onChange:(n:number)=>void;min?:number;step?:number;check?:(n:number)=>string|null}){const [draft,setDraft]=useState<string|null>(null),hint=useId();const n=Number(draft),problem=draft===null?null:draft.trim()===''||!Number.isFinite(n)?'Nhập một số.':n<min?`Từ ${min.toLocaleString('vi-VN')} trở lên.`:check?.(n)??null;const commit=()=>{if(draft===null||problem)return;if(n!==value)onChange(n);setDraft(null);};return <label className="field">{label}<input type="number" min={min} step={step} value={draft??value} aria-invalid={problem?true:undefined} aria-describedby={problem?hint:undefined} onChange={e=>setDraft(e.target.value)} onBlur={commit} onKeyDown={e=>{if(e.key==='Enter'||(e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='s')commit();else if(e.key==='Escape')setDraft(null);}}/>{problem&&<small id={hint} className="field-error" aria-hidden="true">{problem}</small>}</label>;}
/** Roving focus for an ARIA toolbar: ←/→ (wrapping), Home and End move focus between its buttons and skip natively disabled ones; an item marked `aria-disabled` stays reachable.
 *  The caller keeps `tabIndex` 0 on the item that last had focus and -1 on the rest, so Tab leaves the toolbar. */
export function rovingKeyDown(e:React.KeyboardEvent,container:HTMLElement){
 if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key)||e.altKey||e.ctrlKey||e.metaKey)return;
 const items=[...container.querySelectorAll<HTMLButtonElement>('button')].filter(b=>!b.disabled),at=items.indexOf(e.target as HTMLButtonElement);if(at<0)return;
 e.preventDefault();items[e.key==='Home'?0:e.key==='End'?items.length-1:(at+(e.key==='ArrowRight'?1:-1)+items.length)%items.length].focus();
}
