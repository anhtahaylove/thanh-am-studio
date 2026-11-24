import {memo,useState} from 'react';
import {rovingKeyDown} from './ui';
/** The chapter mini-map above the script: one button per chapter that jumps to its first segment. `spec` is App's JSON of the chapters' [label, first segment id, size] and the selected segment's chapter, so a keystroke in a segment leaves it (and so this component) unchanged. */
export const ChapterMap=memo(function ChapterMap({spec,select}:{spec:string;select:(id:string)=>void}){
 const {g,cur}=JSON.parse(spec) as {g:[string,string,number][];cur:number};
 // The toolbar keeps one tab stop, on the selected chapter (the first when none is selected) until another button takes focus; a new selected chapter takes it back.
 const [rove,setRove]=useState(cur),[seen,setSeen]=useState(cur);
 if(seen!==cur){setSeen(cur);setRove(cur);}
 const stop=g[rove]?rove:0;
 const jump=(id:string,start:number)=>{
  select(id);
  requestAnimationFrame(()=>{
   const row=document.querySelectorAll<HTMLElement>('.segment-list>article.segment')[start];if(!row)return;
   row.scrollIntoView({block:'start',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});
   row.querySelector('textarea')?.focus({preventScroll:true});
  });
 };
 let start=0;
 return <nav className="chapter-map" aria-label="Mục lục chương"><div role="toolbar" aria-label="Chương" onKeyDown={e=>rovingKeyDown(e,e.currentTarget)}>{g.map(([label,id,n],i)=>{
  const at=start;start+=n;
  return <button key={id} type="button" style={{flexGrow:n}} tabIndex={i===stop?0:-1} aria-current={i===cur?'true':undefined} onFocus={()=>setRove(i)} onClick={()=>jump(id,at)}>{`${label==='P0'?'Mở đầu':label} · ${n} đoạn`}</button>;
 })}</div></nav>;
});
