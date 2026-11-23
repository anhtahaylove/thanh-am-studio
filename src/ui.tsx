import {useCallback,useEffect,useId,useLayoutEffect,useMemo,useRef,useState,useSyncExternalStore} from 'react';
import type {LucideIcon} from 'lucide-react';
import {desktop} from './bridge';
import type {Segment} from './types';

/** `blocked` is the reason the action cannot run: the button then says so (aria-disabled, a hidden description and the title) yet stays focusable, and its click does nothing, so Enter and Space are no-ops too. */
export function IconButton({label,icon:Icon,onClick,disabled=false,pressed,blocked,tabIndex,onFocus}:{label:string;icon:LucideIcon;onClick:()=>void;disabled?:boolean;pressed?:boolean;blocked?:string|null;tabIndex?:number;onFocus?:()=>void}){const why=useId();return <button type="button" className="icon-button" aria-label={label} title={blocked?`${label}: ${blocked}`:label} aria-pressed={pressed} aria-disabled={blocked?true:undefined} aria-describedby={blocked?why:undefined} tabIndex={tabIndex} onFocus={onFocus} onClick={()=>{if(!blocked)onClick();}} disabled={disabled}><Icon size={17}/>{blocked&&<span id={why} className="sr-only">{blocked}</span>}</button>;}
/** A text button with IconButton's `blocked` behaviour. Its reason is a `hidden` child, so it is the accessible description without joining the name; the title shows it on hover. */
export function ReasonButton({blocked,title,onClick,children,...rest}:React.ButtonHTMLAttributes<HTMLButtonElement>&{blocked?:string|null}){const why=useId();return <button type="button" {...rest} title={blocked??title} aria-disabled={blocked?true:undefined} aria-describedby={blocked?why:undefined} onClick={e=>{if(!blocked)onClick?.(e);}}>{children}{blocked&&<span id={why} hidden>{blocked}</span>}</button>;}
/** The reason of the focused `aria-disabled` control, in one fixed bubble rendered outside every panel, so no `overflow:hidden` clips it and the control's dimming does not fade it. The control's description stays the accessible text, so the bubble is aria-hidden.
 *  It follows the control on any scroll (capture phase) or resize, because Tab to an off-screen control scrolls it into view after focusin, and is hidden while the control is wholly off screen. */
export function ReasonBubble(){
 const [tip,setTip]=useState<{text:string}|null>(null),target=useRef<HTMLElement|null>(null),box=useRef<HTMLDivElement>(null);
 const place=useCallback(()=>{
  const el=target.current,b=box.current;if(!el||!b)return;
  const r=el.getBoundingClientRect(),vw=document.documentElement.clientWidth,vh=document.documentElement.clientHeight,gap=6,w=b.offsetWidth,h=b.offsetHeight;
  b.style.visibility=r.bottom<=0||r.top>=vh||r.right<=0||r.left>=vw?'hidden':'';
  b.style.top=`${r.bottom+gap+h>vh?r.top-gap-h:r.bottom+gap}px`; // below the control, above it near the bottom (the dock)
  b.style.left=`${Math.max(gap,Math.min(r.left+(r.width-w)/2,vw-w-gap))}px`;
 },[]);
 useLayoutEffect(place,[tip,place]);
 useEffect(()=>{
  let frame=0;
  // The reason can change or go while the control keeps focus (a busy action ends), so the focused control is watched.
  const watch=new MutationObserver(()=>show(target.current));
  // A new object for every focus, so the bubble is placed again even when the next control has the same reason.
  const show=(el:Element|null)=>{
   const text=el instanceof HTMLElement&&el.matches('[aria-disabled="true"][aria-describedby]')?el.getAttribute('aria-describedby')!.split(/\s+/).map(id=>document.getElementById(id)?.textContent??'').join(' ').trim():'';
   watch.disconnect();target.current=text?el as HTMLElement:null;setTip(text?{text}:null);
   if(text)watch.observe(el!,{attributes:true,attributeFilter:['aria-disabled','aria-describedby'],childList:true,characterData:true,subtree:true});
  };
  const focusIn=(e:FocusEvent)=>show(e.target as Element),focusOut=()=>show(null),follow=()=>{if(target.current&&!frame)frame=requestAnimationFrame(()=>{frame=0;place();});};
  document.addEventListener('focusin',focusIn);document.addEventListener('focusout',focusOut);addEventListener('scroll',follow,true);addEventListener('resize',follow);
  return()=>{document.removeEventListener('focusin',focusIn);document.removeEventListener('focusout',focusOut);removeEventListener('scroll',follow,true);removeEventListener('resize',follow);cancelAnimationFrame(frame);watch.disconnect();};
 },[place]);
 return tip&&<div ref={box} className="reason-bubble" aria-hidden="true">{tip.text}</div>;
}
// Why an action cannot run, or null: its button shows this as the title and its palette command as the reason. `busy` is added by the palette and by a segment's generate button and Ctrl+Enter, where it is the reason shown; any other busy button is just disabled next to the busy indicator.
export const whyBlocked={generateAll:(ttsBlock:string|null,count:number)=>ttsBlock??(count?null:'Thêm ít nhất một đoạn'),generate:(ttsBlock:string|null,segment?:Segment)=>ttsBlock??(!segment?'Thêm ít nhất một đoạn':segment.text.trim()?null:'Đoạn này chưa có nội dung'),exportAudio:(count:number)=>!desktop?'Cần bản desktop để xuất audio':count?null:'Thêm ít nhất một đoạn',busy:(busy:boolean)=>busy?'Đang xử lý một việc khác':null};
export function Empty({icon:Icon,title,children}:{icon:LucideIcon;title:string;children:React.ReactNode}){return <div className="empty"><div className="empty-icon"><Icon size={30}/></div><h3>{title}</h3><p>{children}</p></div>;}
// What is typed stays a draft until blur, Enter or Ctrl+S (which runs before the window's save handler), so a keystroke is never applied to (or appended after) a rejected value; Escape restores the stored value (and is then spent: the panel's own Escape, which leaves the field, takes the next one).
export function NumberField({label,value,onChange,min=0,step=1,check}:{label:string;value:number;onChange:(n:number)=>void;min?:number;step?:number;check?:(n:number)=>string|null}){const [draft,setDraft]=useState<string|null>(null),hint=useId();const n=Number(draft),problem=draft===null?null:draft.trim()===''||!Number.isFinite(n)?'Nhập một số.':n<min?`Từ ${min.toLocaleString('vi-VN')} trở lên.`:check?.(n)??null;const commit=()=>{if(draft===null||problem)return;if(n!==value)onChange(n);setDraft(null);};return <label className="field">{label}<input type="number" min={min} step={step} value={draft??value} aria-invalid={problem?true:undefined} aria-describedby={problem?hint:undefined} onChange={e=>setDraft(e.target.value)} onBlur={commit} onKeyDown={e=>{if(e.key==='Enter'||(e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='s')commit();else if(e.key==='Escape'&&draft!==null){e.preventDefault();setDraft(null);}}}/>{problem&&<small id={hint} className="field-error" aria-hidden="true">{problem}</small>}</label>;}
/** Roving focus for an ARIA toolbar: ←/→ (wrapping), Home and End move focus between its buttons and skip natively disabled ones; an item marked `aria-disabled` stays reachable.
 *  The caller keeps `tabIndex` 0 on the item that last had focus and -1 on the rest, so Tab leaves the toolbar. */
export function rovingKeyDown(e:React.KeyboardEvent,container:HTMLElement){
 if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key)||e.altKey||e.ctrlKey||e.metaKey)return;
 const items=[...container.querySelectorAll<HTMLButtonElement>('button')].filter(b=>!b.disabled),at=items.indexOf(e.target as HTMLButtonElement);if(at<0)return;
 e.preventDefault();items[e.key==='Home'?0:e.key==='End'?items.length-1:(at+(e.key==='ArrowRight'?1:-1)+items.length)%items.length].focus();
}
/** Whether a CSS media query matches, kept current. `beforeChange` runs first when it flips, so a caller can settle what the flip is about to move (a focused field's draft). */
export function useMediaQuery(query:string,beforeChange?:()=>void){
 const before=useRef(beforeChange);before.current=beforeChange;
 const m=useMemo(()=>matchMedia(query),[query]);
 const subscribe=useCallback((notify:()=>void)=>{const f=()=>{before.current?.();notify();};m.addEventListener('change',f);return()=>m.removeEventListener('change',f);},[m]);
 return useSyncExternalStore(subscribe,()=>m.matches);
}
