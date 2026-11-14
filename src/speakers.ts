import type {TranscriptSegment} from './types';
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
