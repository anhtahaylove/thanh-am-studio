import {useMemo,useRef,useState} from 'react';
import {Headphones,WandSparkles} from 'lucide-react';
import {checkSummary,normalizeText,normalizedParts,readingOrigin,sourceSpelling,takeDiff} from './domain';
import {Modal,useEscape} from './Updates';
import type {Segment,Take} from './types';

// What the dialog needs from the app. `onAdd` writes one entry into the project dictionary and resolves with the project version right after it
// (the same history rule as the toast: Undo is offered only while that is still the latest change); `onUndo` takes that version and says whether it undid.
export type TakeDiffProps={segment:Segment;take:Take;source:string|null;dictionary:Record<string,string>;projectDictionary:Record<string,string>;codeSwitch:boolean;blocked:string|null;busy:boolean;
 run:(task:()=>Promise<unknown>)=>Promise<void>;onAdd:(key:string,value:string)=>Promise<number>;onUndo:(version:number)=>boolean;onPlay:()=>Promise<void>;onGenerate:()=>Promise<void>;onClose:()=>void};

// One missed word: the script spelling to teach the engine a reading for, with a live preview of the segment's normalized text.
// It is a real <form>, so Enter submits natively (never while an IME composes) and a disabled button blocks it.
function MismatchForm({index,expected,segment,dictionary,projectDictionary,codeSwitch,autoFocus,onAdd}:{index:number;expected:string;segment:Segment;dictionary:Record<string,string>;projectDictionary:Record<string,string>;codeSwitch:boolean;autoFocus:boolean;onAdd:(key:string,value:string,index:number,replaced:string|null)=>void}){
 const spelled=useMemo(()=>sourceSpelling(segment.text,expected),[segment.text,expected]);
 const [key,setKey]=useState(spelled??''),[value,setValue]=useState('');
 const k=key.trim(),v=value.trim(),current=normalizeText(segment.text,dictionary,{codeSwitch});
 const preview=normalizedParts(segment.text,k&&v?{...dictionary,[k]:v}:dictionary,{codeSwitch});
 const same=preview.parts.map(p=>p.text).join('')===current;
 const why=!k?'Nhập chữ trong kịch bản cần đọc khác đi':!v?'Nhập cách đọc':dictionary[k]===v?'Từ điển đã có mục này':same?'Mục này không khớp chữ nào trong đoạn':null;
 const origin=useMemo(()=>spelled?null:readingOrigin(segment.text,dictionary,expected,{codeSwitch}),[spelled,segment.text,dictionary,expected,codeSwitch]);
 const hint=spelled?null:!origin?`Không thấy “${expected}” trong kịch bản: gõ chữ trong kịch bản mà bạn muốn đọc khác đi.`
  :origin.kind==='dictionary'?`“${expected}” đến từ mục từ điển “${origin.key}”: sửa mục đó trong Từ điển phát âm.`
  :`“${expected}” do quy tắc chuẩn hóa văn bản tạo ra${origin.from?` từ “${origin.from.replace(/[.,;:!?]+$/,'')}”`:''}: gõ chữ trong kịch bản mà bạn muốn đọc khác đi.`;
 // Adding over a project entry with the same key and another reading replaces it; the form says so before, and the status after.
 const replaced=k&&v&&projectDictionary[k]!==undefined&&projectDictionary[k]!==v?projectDictionary[k]:null,notes=[hint&&`diff-hint-${index}`,why&&`diff-why-${index}`,replaced!==null&&`diff-replace-${index}`].filter(Boolean).join(' ')||undefined;
 return <form className="diff-form" data-form={index} onSubmit={e=>{e.preventDefault();if(!why)onAdd(k,v,index,replaced);}}>
  <label>Từ trong kịch bản<input aria-label="Từ trong kịch bản" aria-describedby={notes} value={key} autoFocus={autoFocus} onChange={e=>setKey(e.target.value)}/></label>
  <label>Cách đọc mới<input aria-label="Cách đọc mới" placeholder="ví dụ: kí" value={value} onChange={e=>setValue(e.target.value)}/></label>
  {hint&&<small id={`diff-hint-${index}`}>{hint}</small>}
  <p className="diff-preview">Xem trước: {preview.parts.length?preview.parts.map((p,i)=>p.changed?<mark key={i}>{p.text}<span className="sr-only"> (đã đổi)</span></mark>:p.text):'…'}</p>
  <button type="submit" className="quiet accent" disabled={!!why} aria-describedby={notes}>Thêm vào từ điển</button>
  {why&&<small id={`diff-why-${index}`}>{why}</small>}
  {replaced!==null&&<small id={`diff-replace-${index}`}>Thay mục hiện có “{k}” → “{replaced}”</small>}
 </form>;
}

export function TakeDiff({segment,take,source,dictionary,projectDictionary,codeSwitch,blocked,busy,run,onAdd,onUndo,onPlay,onGenerate,onClose}:TakeDiffProps){
 useEscape(onClose);
 const box=useRef<HTMLElement>(null),check=take.check!,sum=checkSummary(check)!,ok=sum.tone==='ok';
 const [added,setAdded]=useState<{key:string;value:string;version:number;form:number;replaced:boolean;undone:boolean|null}|null>(null),[problem,setProblem]=useState('');
 const sent=source??normalizeText(segment.text,dictionary,{codeSwitch}),diff=useMemo(()=>takeDiff(sent,check),[sent,check]);
 const focusForm=(i:number)=>requestAnimationFrame(()=>box.current?.querySelector<HTMLElement>(`[data-form="${i}"] input`)?.focus());
 const forms=diff.mismatches.filter(m=>m.expected);
 const guarded=(task:()=>Promise<unknown>)=>void run(async()=>{setProblem('');try{await task();}catch(e){setProblem(String(e instanceof Error?e.message:e));throw e;}});
 const add=(key:string,value:string,form:number,replaced:string|null)=>guarded(async()=>{const version=await onAdd(key,value);setAdded({key,value,version,form,replaced:replaced!==null,undone:null});focusForm(form);});
 const undo=()=>{if(!added)return;setAdded({...added,undone:onUndo(added.version)});focusForm(added.form);};
 let formAt=-1;
 return <Modal><section ref={box} className="modal panel diff-dialog" role="dialog" aria-modal="true" aria-labelledby="diff-title">
  <div className="panel-toolbar"><h3 id="diff-title">{ok?'Khớp kịch bản':'Whisper nghe khác kịch bản'}</h3></div>
  {!source&&<p className="hint">So với kịch bản hiện tại: không còn văn bản đã gửi lúc tạo take này.</p>}
  <h4 className="diff-label">{source?'Kịch bản đã gửi':'Kịch bản hiện tại'}</h4>
  <p className="diff-script">{diff.script.map((s,i)=>s.mark?<span key={i} className="diff-word miss">{s.word}<span className="sr-only"> ({s.mark==='missing'?'không nghe thấy':'nghe khác'})</span> </span>:<span key={i}>{s.word} </span>)}</p>
  <p className="diff-heard">{sum.detail}</p>
  {!ok&&diff.mismatches.length>0&&<ul className="diff-list">{diff.mismatches.map((m,i)=>{
   if(!m.expected)return <li key={i}>Whisper nghe thêm: “{m.heard}”</li>;
   const f=++formAt;
   return <li key={i}><span>“{m.expected}” → “{m.heard||'…'}”</span><MismatchForm index={f} expected={m.expected} segment={segment} dictionary={dictionary} projectDictionary={projectDictionary} codeSwitch={codeSwitch} autoFocus={f===0} onAdd={add}/></li>;})}</ul>}
  <div className="diff-added"><p role="status">{added?(added.undone===null?`Đã ${added.replaced?'thay':'thêm'} “${added.key}” → “${added.value}” ${added.replaced?'trong':'vào'} từ điển dự án.`:added.undone?`Đã hoàn tác mục “${added.key}” → “${added.value}”.`:'Không hoàn tác được vì dự án đã đổi sau khi thêm.'):''}</p>{added&&added.undone===null&&<button type="button" className="quiet" onClick={undo}>Hoàn tác</button>}</div>
  {forms.length>0&&<p className="hint">Từ điển chỉ áp dụng cho lần tạo sau. Bấm Tạo take mới rồi nghe lại để kiểm tra cách đọc.</p>}
  {problem&&<p role="alert" className="alert error">{problem}</p>}
  <div className="modal-actions">
   <button type="button" className="quiet" onClick={()=>guarded(onPlay)}><Headphones size={14}/>Nghe take này</button>
   <button type="button" className="quiet accent" disabled={busy||!!blocked} title={blocked??undefined} onClick={()=>guarded(async()=>{await onGenerate();onClose();})}><WandSparkles size={14}/>Tạo take mới</button>
   <button type="button" className="primary" autoFocus={forms.length===0} onClick={onClose}>Đóng</button>
  </div>
 </section></Modal>;
}
