import {useEffect,useId,useState} from 'react';
import {X} from 'lucide-react';
import type {LucideIcon} from 'lucide-react';
import {Modal,useEscape} from './Updates';
import {searchParts} from './domain';

/** `disabled` is the reason the app itself shows for the same action, or null when it can run. */
export interface Command{id:string;label:string;icon:LucideIcon;disabled:string|null;run:()=>void}

// Every word typed must hit the label, ignoring case and tone marks, in any order.
const matches=(label:string,query:string)=>query.split(/\s+/).filter(Boolean).every(w=>searchParts(label,w).some(p=>p.hit));

/** The command palette, or with other texts and `rank` another pick-one dialog (quick-open). With `rank`, items ranked 0 come before
 * items ranked 1, each keeping the given order, and null hides an item. */
export function CommandPalette({commands,onClose,title='Bảng lệnh',closeLabel='Đóng bảng lệnh',inputLabel='Gõ để tìm lệnh',placeholder='Gõ để tìm lệnh… (không cần gõ dấu)',listLabel='Lệnh',help='↑ ↓ để chọn, Enter để chạy, Esc để đóng.',empty='Không có lệnh nào khớp.',rank,toggleKey='k'}:{commands:Command[];onClose:()=>void;title?:string;closeLabel?:string;inputLabel?:string;placeholder?:string;listLabel?:string;help?:string;empty?:string;rank?:(label:string,query:string)=>0|1|null;toggleKey?:string}){
 useEscape(onClose);
 const [query,setQuery]=useState(''),[sel,setSel]=useState<string|null>(null),list=useId(),heading=useId();
 const shown=rank?[0,1].flatMap(r=>commands.filter(c=>rank(c.label,query)===r)):commands.filter(c=>matches(c.label,query)),cur=shown.findIndex(c=>c.id===sel);
 const pick=(c?:Command)=>{if(!c||c.disabled)return;onClose();c.run();};
 useEffect(()=>{document.getElementById(`${list}-${cur}`)?.scrollIntoView({block:'nearest'});},[list,cur]);
 const key=(e:React.KeyboardEvent)=>{
  if(e.nativeEvent.isComposing)return;
  const n=shown.length;
  if(e.key==='ArrowDown'&&n){e.preventDefault();setSel(shown[(cur+1)%n].id);}
  else if(e.key==='ArrowUp'&&n){e.preventDefault();setSel(shown[(cur-1+n)%n].id);}
  else if(e.key==='Home'&&n){e.preventDefault();setSel(shown[0].id);}
  else if(e.key==='End'&&n){e.preventDefault();setSel(shown[n-1].id);}
  else if(e.key==='Enter'){e.preventDefault();pick(shown[cur]);}
 };
 // Its own key (Ctrl+K, or Ctrl+P for quick-open) closes the dialog wherever focus is inside it (the filter or the close button); like opening, not with Alt (AltGr+K).
 // Ctrl+K inside quick-open is only prevented, so neither the browser's nor a second dialog's shortcut fires.
 const toggle=(e:React.KeyboardEvent)=>{const k=e.key.toLowerCase();if(e.nativeEvent.isComposing||!(e.ctrlKey||e.metaKey)||e.altKey||(k!==toggleKey&&k!=='k'))return;e.preventDefault();if(k===toggleKey){e.stopPropagation();onClose();}};
 return <Modal><section className="modal panel palette" role="dialog" aria-modal="true" aria-labelledby={heading} onKeyDown={toggle}>
  <div className="panel-toolbar"><h3 id={heading}>{title}</h3><button type="button" className="icon-button" aria-label={closeLabel} title={closeLabel} onClick={onClose}><X size={17}/></button></div>
  <input autoFocus role="combobox" aria-expanded="true" aria-controls={list} aria-activedescendant={shown.length?`${list}-${cur}`:undefined} aria-label={inputLabel} placeholder={placeholder} value={query} onChange={e=>{setQuery(e.target.value);setSel(null);}} onKeyDown={key}/>
  <ul id={list} role="listbox" aria-label={listLabel}>{shown.map((c,i)=><li key={c.id} id={`${list}-${i}`} role="option" aria-selected={i===cur} aria-disabled={c.disabled?true:undefined} onMouseMove={()=>{if(i!==cur)setSel(c.id);}} onClick={()=>pick(c)}><c.icon size={16}/><span>{c.label}</span>{c.disabled&&<small>{c.disabled}</small>}</li>)}</ul>
  {!shown.length&&<p className="hint" role="status">{empty}</p>}
  <p className="hint">{help}</p>
 </section></Modal>;
}

// Only shortcuts that exist in App.tsx (and NumberField) belong here; e2e/palette.spec.ts exercises them.
const SHORTCUTS:{group:string;items:{combos:string[];what:string}[]}[]=[
 {group:'Mọi trang',items:[
  {combos:['Ctrl+K'],what:'Mở bảng lệnh'},
  {combos:['Ctrl+P'],what:'Mở nhanh một dự án theo tên (không cần gõ dấu)'},
  {combos:['?'],what:'Mở bảng phím tắt này (khi không gõ trong ô nhập)'},
  {combos:['Ctrl+S'],what:'Lưu dự án'},
  {combos:['Ctrl+Z'],what:'Hoàn tác trong dự án (trong ô tìm kiếm, từ điển, ô số và ô thời gian thì hoàn tác chữ đang gõ)'},
  {combos:['Ctrl+Shift+Z','Ctrl+Y'],what:'Làm lại'},
  {combos:['Esc'],what:'Đóng hộp thoại đang mở'}]},
 {group:'Tạo giọng đọc',items:[
  {combos:['Ctrl+V'],what:'Dán kịch bản nhiều vai (“Tên: lời”): xem trước rồi mới thêm đoạn'},
  {combos:['Space'],what:'Phát hoặc dừng take của đoạn đang chọn (khi không gõ và không đứng trên nút)'},
  {combos:['1–9'],what:'Nghe take số N của đoạn đang chọn (đang phát thì nghe tiếp từ cùng chỗ)'},
  {combos:['Alt+↑','Alt+↓'],what:'Đưa đoạn lên hoặc xuống (trong ô nội dung đoạn hoặc thanh thao tác của đoạn)'},
  {combos:['Ctrl+Enter'],what:'Tạo giọng cho đoạn này (trong ô nội dung đoạn hoặc thanh thao tác; ở trang Chép lời, Ctrl+Enter nghe từ con trỏ)'},
  {combos:['Ctrl+Shift+Enter'],what:'Chia đoạn tại con trỏ (trong ô nội dung đoạn hoặc thanh thao tác)'},
  {combos:['←','→'],what:'Trên điểm cắt của dạng sóng: dời 10 ms (Shift: 100 ms; Page Up/Page Down: 0,5 giây)'},
  {combos:['Esc'],what:'Trong chi tiết đoạn: quay về ô nội dung của đoạn (ô số đang có giá trị nhập dở thì Esc bỏ giá trị đó trước)'}]},
 {group:'Chép lời',items:[
  {combos:['Ctrl+F'],what:'Tìm trong bản chép lời'},
  {combos:['Enter','Shift+Enter'],what:'Trong ô tìm kiếm: sang kết quả sau hoặc trước'},
  {combos:['Space'],what:'Phát hoặc tạm dừng audio nguồn (khi không gõ và không đứng trên nút)'},
  {combos:['Ctrl+bấm'],what:'Bấm vào một từ trong ô lời nói để nghe từ khoảng chỗ đó (ước lượng)'},
  {combos:['Ctrl+Enter'],what:'Trong ô lời nói: nghe từ con trỏ'}]},
 {group:'Ô nhập số và thời gian (Bắt đầu, Kết thúc, Nghỉ sau…)',items:[
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
