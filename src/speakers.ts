import type {CSSProperties} from 'react';
import type {Project,TranscriptSegment} from './types';
import {jsonEqual} from './domain';
export interface SpeakerStat {speaker:number;rows:number;ms:number;sample:{start_ms:number;end_ms:number}}
/** Row count, speaking time and a short sample (the start of the longest row, at most `sampleMs`) per diarized speaker, in speaker order. */
export function speakerStats(rows:TranscriptSegment[],sampleMs=6000):SpeakerStat[]{
 const by=new Map<number,{rows:number;ms:number;longest:TranscriptSegment}>();
 for(const r of rows){if(r.speaker===undefined)continue;const ms=r.end_ms-r.start_ms,s=by.get(r.speaker);if(!s)by.set(r.speaker,{rows:1,ms,longest:r});else{s.rows++;s.ms+=ms;if(ms>s.longest.end_ms-s.longest.start_ms)s.longest=r;}}
 return [...by].sort((a,b)=>a[0]-b[0]).map(([speaker,{rows,ms,longest:l}])=>({speaker,rows,ms,sample:{start_ms:l.start_ms,end_ms:Math.min(l.end_ms,l.start_ms+sampleMs)}}));
}
/** Relabels every row of `from` as `to`; other rows keep their identity. */
export const mergeSpeaker=(rows:TranscriptSegment[],from:number,to:number)=>rows.map(r=>r.speaker===from?{...r,speaker:to}:r);
export function speakingTime(ms:number):string{const s=Math.round(ms/1000);return s<60?`${s} giây`:s<3600?`${Math.floor(s/60)} phút ${s%60} giây`:`${Math.floor(s/3600)} giờ ${Math.floor(s/60)%60} phút`;}
/** STT job fields for the "Số người nói" choice: "0" automatic, "3" a fixed count, "3-4" a range (never both); nothing when separation is off. */
export function speakerPayload(on:boolean,choice:string):{num_speakers?:number|null;min_speakers?:number;max_speakers?:number}{
 const [min,max]=choice.split('-').map(Number);
 return !on||!min?{num_speakers:null}:max?{min_speakers:min,max_speakers:max}:{num_speakers:min};
}
/** Colour slot 0-7 of a diarized speaker; the palette is `--spk-N` and `--spk-N-soft`. */
export const speakerColor=(n:number)=>n%8;
/** The `--spk`/`--spk-soft` pair of colour slot `slot`, as inline style for a speaker's rule and label. */
export const speakerVars=(slot:number)=>({'--spk':`var(--spk-${slot})`,'--spk-soft':`var(--spk-${slot}-soft)`}) as CSSProperties;
/** Slot per speaker name, in order of first appearance: a name in `prev` (the slots before an edit) keeps its slot, a new name takes the
 * slot of a name that vanished (a rename inherits), "Người N" takes N-1 when free, the rest the lowest free slot, a ninth the least-used one. */
export function speakerColors(names:string[],prev?:Record<string,number>):Map<string,number>{
 const seen=new Set(names),order=[...seen],out=new Map<string,number>(),uses=Array<number>(8).fill(0),take=(n:string,c:number)=>{out.set(n,c);uses[c]++;};
 // Beyond eight names slots are shared by design, so a kept slot need not be free there.
 if(prev)for(const n of order)if(Object.hasOwn(prev,n)&&(!uses[prev[n]]||order.length>8))take(n,prev[n]);
 if(prev){const gone=[...new Set(Object.keys(prev).filter(n=>!seen.has(n)).map(n=>prev[n]))].sort((a,b)=>a-b);for(const n of order)if(!out.has(n)&&!Object.hasOwn(prev,n)){const c=gone.find(c=>!uses[c]);if(c!==undefined)take(n,c);}}
 for(const n of order){const m=/^Người ([1-9]\d*)$/.exec(n),c=m&&speakerColor(Number(m[1])-1);if(c!==null&&!out.has(n)&&!uses[c])take(n,c);}
 for(const n of order)if(!out.has(n))take(n,uses.indexOf(Math.min(...uses)));
 return out;
}
/** The integer slots 0-7 of a stored `speaker_slots`; the store does not validate the field. Undefined when none is left. */
export function validSlots(x:unknown):Record<string,number>|undefined{
 const kept=x&&typeof x==='object'&&!Array.isArray(x)?Object.entries(x).filter(([,v])=>Number.isInteger(v)&&v>=0&&v<8):[];
 return kept.length?Object.fromEntries(kept):undefined;
}
const names=(p:Project)=>p.segments.map(s=>s.speaker);
/** The slots the user sees for `p`, one per current name: its stored map completed for any name it lacks, or for a project saved before 1.0.23 the order-of-appearance mapping. */
export const slotsOf=(p:Project|null|undefined)=>p?Object.fromEntries(speakerColors(names(p),validSlots(p.speaker_slots))):undefined;
/** `p` with `speaker_slots` for its current names, computed from `prev` (the slots before the edit); `p` itself when nothing changed. */
export function withSpeakerSlots(p:Project,prev?:Record<string,number>):Project{
 const m=Object.fromEntries(speakerColors(names(p),prev));
 return jsonEqual(m,p.speaker_slots??{})?p:{...p,speaker_slots:m};
}
