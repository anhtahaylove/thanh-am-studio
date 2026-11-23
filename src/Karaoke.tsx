import {useEffect,useState} from 'react';
import {karaokeAt} from './domain';
// The playing take's script words, lit as they are spoken (`from` is the preview position, as the waveform gets it). Its own 100 ms tick keeps the re-renders
// inside this line, never the row around it. If the script changed after the take was made, words the alignment cannot place have no start and the last
// placed word stays lit.
export function Karaoke({parts,from}:{parts:{text:string;start_ms?:number|null}[];from:{t0:number;ms:number}|null}){
 const [lit,setLit]=useState(-1);
 useEffect(()=>{if(!from){setLit(-1);return;}const tick=()=>setLit(karaokeAt(parts,from.ms+performance.now()-from.t0));tick();const timer=setInterval(tick,100);return()=>clearInterval(timer);},[parts,from]);
 return <p className="karaoke" aria-hidden="true">{parts.map((p,i)=>p.start_ms===undefined?p.text:i===lit?<mark key={i}>{p.text}</mark>:<span key={i} className={i<lit?'said':undefined}>{p.text}</span>)}</p>;
}
