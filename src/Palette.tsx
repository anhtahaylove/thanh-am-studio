import {useEffect,useId,useState} from 'react';
import {X} from 'lucide-react';
import type {LucideIcon} from 'lucide-react';
import {Modal,useEscape} from './Updates';
import {searchParts} from './domain';

/** `disabled` is the reason the app itself shows for the same action, or null when it can run. */
export interface Command{id:string;label:string;icon:LucideIcon;disabled:string|null;run:()=>void}

// Every word typed must hit the label, ignoring case and tone marks, in any order.
const matches=(label:string,query:string)=>query.split(/\s+/).filter(Boolean).every(w=>searchParts(label,w).some(p=>p.hit));

export function CommandPalette({commands,onClose}:{commands:Command[];onClose:()=>void}){
 useEscape(onClose);
 const [query,setQuery]=useState(''),[at,setAt]=useState(0),list=useId();
 const shown=commands.filter(c=>matches(c.label,query)),cur=Math.min(at,shown.length-1);
 const pick=(c?:Command)=>{if(!c||c.disabled)return;onClose();c.run();};
 useEffect(()=>{document.getElementById(`${list}-${cur}`)?.scrollIntoView({block:'nearest'});},[list,cur]);
 const key=(e:React.KeyboardEvent)=>{
  if(e.nativeEvent.isComposing)return;
  const n=shown.length;
  if(e.key==='ArrowDown'&&n){e.preventDefault();setAt((cur+1)%n);}
  else if(e.key==='ArrowUp'&&n){e.preventDefault();setAt((cur-1+n)%n);}
  else if(e.key==='Home'&&n){e.preventDefault();setAt(0);}
  else if(e.key==='End'&&n){e.preventDefault();setAt(n-1);}
  else if(e.key==='Enter'){e.preventDefault();pick(shown[cur]);}
  else if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){e.preventDefault();e.stopPropagation();onClose();}
 };
 return <Modal><section className="modal panel palette" role="dialog" aria-modal="true" aria-labelledby="palette-title">
  <div className="panel-toolbar"><h3 id="palette-title">Bảng lệnh</h3><button type="button" className="icon-button" aria-label="Đóng bảng lệnh" title="Đóng bảng lệnh" onClick={onClose}><X size={17}/></button></div>
  <input autoFocus role="combobox" aria-expanded="true" aria-controls={list} aria-activedescendant={shown.length?`${list}-${cur}`:undefined} aria-label="Gõ để tìm lệnh" placeholder="Gõ để tìm lệnh… (không cần gõ dấu)" value={query} onChange={e=>{setQuery(e.target.value);setAt(0);}} onKeyDown={key}/>
  <ul id={list} role="listbox" aria-label="Lệnh">{shown.map((c,i)=><li key={c.id} id={`${list}-${i}`} role="option" aria-selected={i===cur} aria-disabled={c.disabled?true:undefined} onMouseMove={()=>{if(i!==cur)setAt(i);}} onClick={()=>pick(c)}><c.icon size={16}/><span>{c.label}</span>{c.disabled&&<small>{c.disabled}</small>}</li>)}</ul>
  {!shown.length&&<p className="hint" role="status">Không có lệnh nào khớp.</p>}
  <p className="hint">↑ ↓ để chọn, Enter để chạy, Esc để đóng. Nhấn ? ngoài ô nhập để xem phím tắt.</p>
 </section></Modal>;
}

// Only shortcuts that exist in App.tsx (and NumberField) belong here; e2e/palette.spec.ts exercises them.
const SHORTCUTS:{group:string;items:{combos:string[];what:string}[]}[]=[
 {group:'Mọi trang',items:[
  {combos:['Ctrl+K'],what:'Mở bảng lệnh'},
  {combos:['?'],what:'Mở bảng phím tắt này (khi không gõ trong ô nhập)'},
  {combos:['Ctrl+S'],what:'Lưu dự án'},
  {combos:['Ctrl+Z'],what:'Hoàn tác trong dự án (trong ô tìm kiếm, từ điển và ô số thì hoàn tác chữ đang gõ)'},
  {combos:['Ctrl+Shift+Z','Ctrl+Y'],what:'Làm lại'},
  {combos:['Esc'],what:'Đóng hộp thoại đang mở'}]},
 {group:'Tạo giọng đọc',items:[{combos:['Space'],what:'Phát hoặc dừng take của đoạn đang chọn (khi không gõ và không đứng trên nút)'}]},
 {group:'Chép lời',items:[
  {combos:['Ctrl+F'],what:'Tìm trong bản chép lời'},
  {combos:['Space'],what:'Phát hoặc tạm dừng audio nguồn (khi không gõ và không đứng trên nút)'}]},
 {group:'Ô nhập số (Từ, Đến, Nghỉ sau…)',items:[
  {combos:['Enter','Ctrl+S'],what:'Áp dụng giá trị đang nhập'},
  {combos:['Esc'],what:'Bỏ giá trị đang nhập'}]}
];

export function ShortcutSheet({onClose}:{onClose:()=>void}){
 useEscape(onClose);
 return <Modal><section className="modal panel shortcuts" role="dialog" aria-modal="true" aria-labelledby="shortcuts-title">
  <div className="panel-toolbar"><h3 id="shortcuts-title">Phím tắt</h3><button type="button" className="icon-button" aria-label="Đóng phím tắt" title="Đóng phím tắt" autoFocus onClick={onClose}><X size={17}/></button></div>
  {SHORTCUTS.map(g=><div key={g.group}><h4>{g.group}</h4><dl>{g.items.map(i=><div key={i.what}><dt>{i.combos.map((c,n)=><span key={c}>{n>0&&' hoặc '}{c.split('+').map((k,j)=><span key={k}>{j>0&&'+'}<kbd>{k}</kbd></span>)}</span>)}</dt><dd>{i.what}</dd></div>)}</dl></div>)}
 </section></Modal>;
}
