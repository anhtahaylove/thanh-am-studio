import {useCallback,useEffect,useId,useLayoutEffect,useMemo,useRef,useState,useSyncExternalStore} from 'react';
import {ChevronDown,LoaderCircle,type LucideIcon} from 'lucide-react';
import {desktop} from './bridge';
import type {Segment} from './types';

/** `blocked` is the reason the action cannot run: the button then says so (aria-disabled, a hidden description and the title) yet stays focusable, and its click does nothing, so Enter and Space are no-ops too. */
export function IconButton({label,icon:Icon,onClick,disabled=false,pressed,blocked,tabIndex,onFocus,title}:{label:string;icon:LucideIcon;onClick:(e:React.MouseEvent)=>void;disabled?:boolean;pressed?:boolean;blocked?:string|null;tabIndex?:number;onFocus?:()=>void;title?:string}){const why=useId();return <button type="button" className="icon-button" aria-label={label} title={blocked?`${label}: ${blocked}`:title??label} aria-pressed={pressed} aria-disabled={blocked?true:undefined} aria-describedby={blocked?why:undefined} tabIndex={tabIndex} onFocus={onFocus} onClick={e=>{if(!blocked)onClick(e);}} disabled={disabled}><Icon size={17}/>{blocked&&<span id={why} className="sr-only">{blocked}</span>}</button>;}
/** A text button with IconButton's `blocked` behaviour. Its reason is a `hidden` child, so it is the accessible description without joining the name; the title shows it on hover. */
export function ReasonButton({blocked,title,onClick,children,...rest}:React.ButtonHTMLAttributes<HTMLButtonElement>&{blocked?:string|null}){const why=useId();return <button type="button" {...rest} title={blocked??title} aria-disabled={blocked?true:undefined} aria-describedby={blocked?why:rest['aria-describedby']} onClick={e=>{if(!blocked)onClick?.(e);}}>{children}{blocked&&<span id={why} hidden>{blocked}</span>}</button>;}
/** The reason of the focused `aria-disabled` control, in one fixed bubble rendered outside every panel, so no `overflow:hidden` clips it and the control's dimming does not fade it. The control's description stays the accessible text, so the bubble is aria-hidden.
 *  It follows the control on any scroll (capture phase) or resize, because Tab to an off-screen control scrolls it into view after focusin, and is hidden while the control is wholly off screen. */
export function ReasonBubble(){
 const [tip,setTip]=useState<{text:string}|null>(null),target=useRef<HTMLElement|null>(null),box=useRef<HTMLDivElement>(null);
 const place=useCallback(()=>{
  const el=target.current,b=box.current;if(!el||!b)return;
  b.style.left='0px'; // measured at the left edge: an old left would narrow (and wrap) a fixed box sized to its text
  const r=el.getBoundingClientRect(),vw=document.documentElement.clientWidth,vh=document.documentElement.clientHeight,gap=6,w=b.offsetWidth,h=b.offsetHeight;
  b.style.visibility=r.bottom<=0||r.top>=vh||r.right<=0||r.left>=vw?'hidden':'';
  b.style.top=`${r.bottom+gap+h>vh?r.top-gap-h:r.bottom+gap}px`; // below the control, above it near the bottom (the dock)
  b.style.left=`${Math.max(gap,Math.min(r.left+(r.width-w)/2,vw-w-gap))}px`;
 },[]);
 useLayoutEffect(place,[tip,place]);
 useEffect(()=>{
  let frame=0,focused:Element|null=null;
  // The focused control can become blocked or unblocked, or change its reason, while it keeps focus (Ctrl+Z, a busy action), so it is watched:
  // its two attributes always, and its reason text only while it is blocked (not a field's text on every keystroke).
  const watch=new MutationObserver(()=>show(focused));
  // A new object for every focus, so the bubble is placed again even when the next control has the same reason.
  const show=(el:Element|null)=>{
   const text=el instanceof HTMLElement&&el.matches('[aria-disabled="true"][aria-describedby]')?el.getAttribute('aria-describedby')!.split(/\s+/).map(id=>document.getElementById(id)?.textContent??'').join(' ').trim():'';
   watch.disconnect();focused=el;target.current=text?el as HTMLElement:null;setTip(text?{text}:null);
   if(el)watch.observe(el,{attributes:true,attributeFilter:['aria-disabled','aria-describedby'],...text?{childList:true,characterData:true,subtree:true}:{}});
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
/** The house overflow control: a button that opens a small panel under it. Kind `menu` (`aria-haspopup="menu"`, a `role="menu"` panel, `role="menuitem"` buttons with roving focus: ArrowUp/Down and Home/End move, Tab leaves)
 *  is for actions and closes after one; an `aria-disabled` item does nothing, and an item that moves focus on purpose keeps it. Kind `disclosure` (`aria-controls`, no menu roles) is for native controls
 *  (checkboxes, a pressed toggle) that Tab walks through and that keep the panel open. Escape closes and returns focus to the button; so does a click outside when focus was inside the panel and would otherwise be lost;
 *  Tab out of the panel closes it, but focus moving into a modal does not (the modal gives focus back to the option that opened it). The panel element is always there (hidden when closed) so `aria-controls`
 *  always resolves; its children exist only while it is open. */
export function MenuButton({kind,label,className='quiet',children}:{kind:'menu'|'disclosure';label:string;className?:string;children:React.ReactNode}){
 const [open,setOpen]=useState(false),root=useRef<HTMLDivElement>(null),button=useRef<HTMLButtonElement>(null),from=useRef<'first'|'last'>('first'),id=useId();
 const items=()=>[...root.current!.querySelectorAll<HTMLElement>('[role=menuitem]:not(:disabled)')];
 useEffect(()=>{
  if(!open)return;
  const down=(e:MouseEvent)=>{
   if(root.current!.contains(e.target as Node))return;
   const had=root.current!.contains(document.activeElement);setOpen(false);
   if(had)requestAnimationFrame(()=>{if(document.activeElement===document.body)button.current?.focus();}); // the click moved focus to nothing
  };
  document.addEventListener('mousedown',down);return()=>document.removeEventListener('mousedown',down);
 },[open]);
 useEffect(()=>{if(open&&kind==='menu')items().forEach(i=>{i.tabIndex=-1;});}); // roving focus: the arrows move between items, Tab leaves the menu
 useEffect(()=>{if(open&&kind==='menu'){const list=items();list[from.current==='last'?list.length-1:0]?.focus();}from.current='first';},[open,kind]);
 const key=(e:React.KeyboardEvent)=>{
  if(e.key==='Escape'&&open&&!e.nativeEvent.isComposing){e.preventDefault();e.stopPropagation();setOpen(false);button.current?.focus();return;}
  if(kind!=='menu'||!['ArrowDown','ArrowUp','Home','End'].includes(e.key)||e.altKey||e.ctrlKey||e.metaKey)return;
  e.preventDefault();if(!open){from.current=e.key==='ArrowUp'?'last':'first';setOpen(true);return;}
  const list=items(),at=list.indexOf(document.activeElement as HTMLElement),last=list.length-1;
  list[e.key==='Home'?0:e.key==='End'?last:e.key==='ArrowDown'?(at<last?at+1:0):(at>0?at-1:last)]?.focus();
 };
 return <div className="menu-wrap" ref={root} onKeyDown={key} onBlur={e=>{const to=e.relatedTarget as Element|null;if(open&&to&&!root.current!.contains(to)&&!to.closest('[aria-modal="true"]'))setOpen(false);}}>
  <button ref={button} type="button" className={className} aria-expanded={open} aria-controls={id} aria-haspopup={kind==='menu'?'menu':undefined} onClick={()=>setOpen(o=>!o)}>{label}<ChevronDown size={14} className="menu-caret"/></button>
  <div id={id} className="menu-panel" hidden={!open} role={kind==='menu'?'menu':undefined} aria-label={kind==='menu'?label:undefined} onClick={e=>{
   if(kind!=='menu'||!(e.target as HTMLElement).closest('[role=menuitem]:not([aria-disabled=true])'))return;
   const had=root.current!.contains(document.activeElement);setOpen(false);if(had)button.current?.focus(); // an item that moved focus elsewhere keeps it
  }}>{open&&children}</div>
 </div>;
}
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
// The width at and below which the selected segment's panel sits inside its row; it must equal the query App passes to useMediaQuery for that panel.
export const NARROW='(max-width:920px)';
/** The "Đang thực hiện…" indicator, fixed at the bottom right. It takes the first spot that is on screen (8 px from the window edges) and 10 px clear of the audio dock: 20 px from the bottom, else just above the dock, else just below it; if none fits it stays at 20 px. `bottom` is written straight to the element, not through React state: one frame-batched pass runs on scroll, window resize and any size change of the page or of the dock, which is found again on every pass because it comes and goes with the page. */
export function BusyIndicator(){
 const ref=useRef<HTMLDivElement>(null);
 useLayoutEffect(()=>{
  const el=ref.current!;let frame=0,dock:Element|null=null;
  const place=()=>{
   frame=0;const d=document.getElementById('audio-dock');
   if(d!==dock){if(dock)ro.unobserve(dock);if(d)ro.observe(d);dock=d;}
   const r=d?.getBoundingClientRect(),h=el.getBoundingClientRect().height;
   const fits=(bottom:number)=>{const top=innerHeight-bottom-h;return top>=8&&bottom>=8&&(!r||top+h<=r.top-10||top>=r.bottom+10);};
   const shown=r&&r.top<innerHeight&&r.bottom>0;
   el.style.bottom=`${shown?[20,innerHeight-r.top+10,innerHeight-r.bottom-10-h].find(fits)??20:20}px`;
  };
  const queue=()=>{if(!frame)frame=requestAnimationFrame(place);};
  const ro=new ResizeObserver(queue);
  ro.observe(document.documentElement);place();
  addEventListener('scroll',queue,{passive:true,capture:true});addEventListener('resize',queue);
  return()=>{cancelAnimationFrame(frame);ro.disconnect();removeEventListener('scroll',queue,{capture:true});removeEventListener('resize',queue);};
 },[]);
 return <div ref={ref} className="busy-indicator" role="status"><LoaderCircle className="spin" size={16}/>Đang thực hiện…</div>;
}
