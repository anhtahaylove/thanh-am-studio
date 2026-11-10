import type {Segment,TranscriptSegment} from './types';
export const uid=()=>crypto.randomUUID();
export function timestamp(ms:number,separator=','):string {ms=Math.round(ms);return `${String(Math.floor(ms/3600000)).padStart(2,'0')}:${String(Math.floor(ms/60000)%60).padStart(2,'0')}:${String(Math.floor(ms/1000)%60).padStart(2,'0')}${separator}${String(ms%1000).padStart(3,'0')}`;}
export function parseTime(value:string):number {const parts=value.trim().replace(',','.').split(':').map(Number);if(parts.length<2||parts.length>3||parts.some(x=>!Number.isFinite(x)||x<0)||parts.at(-1)!>=60||parts.at(-2)!>=60)throw Error('Mốc thời gian không hợp lệ');return Math.round(parts.reduce((a,n)=>a*60+n,0)*1000);}
export function parseSubtitles(input:string):TranscriptSegment[]{
 const blocks=input.replace(/^\uFEFF/,'').replace(/\r/g,'').trim().split(/\n\s*\n/);const rows:TranscriptSegment[]=[];
 for(const block of blocks){const lines=block.split('\n');if(/^(WEBVTT|NOTE|STYLE|REGION)(\s|$)/.test(lines[0]))continue;const idx=lines.findIndex(l=>l.includes('-->'));if(idx<0)continue;const match=lines[idx].match(/^(\S+)\s+-->\s+(\S+)/);if(!match)throw Error('Mốc thời gian không hợp lệ');const start_ms=parseTime(match[1]),end_ms=parseTime(match[2]);if(end_ms<=start_ms)throw Error('Khoảng thời gian phải tăng');rows.push({id:uid(),start_ms,end_ms,text:lines.slice(idx+1).join('\n')});}
 if(!rows.length)throw Error('Không tìm thấy đoạn phụ đề hợp lệ');return rows;
}
export function exportSubtitles(rows:TranscriptSegment[],format:'srt'|'vtt'|'txt'):string {
 if(format==='txt')return rows.map(r=>r.text).join('\n\n');
 for(const r of rows)if(!Number.isFinite(r.start_ms)||!Number.isFinite(r.end_ms)||r.start_ms<0||r.end_ms<=r.start_ms)throw Error('Khoảng thời gian phải tăng');
 return (format==='vtt'?'WEBVTT\n\n':'')+rows.map((r,i)=>`${format==='srt'?`${i+1}\n`:''}${timestamp(r.start_ms,format==='vtt'?'.':',')} --> ${timestamp(r.end_ms,format==='vtt'?'.':',')}\n${r.text}`).join('\n\n')+'\n';
}
export function normalizeText(text:string,dictionary:Record<string,string>):string {
 const keys=Object.keys(dictionary).filter(Boolean).sort((a,b)=>b.length-a.length);let out=text.normalize('NFC');
 if(keys.length){const escaped=keys.map(k=>k.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'));out=out.replace(new RegExp(escaped.join('|'),'gu'),m=>dictionary[m]);}
 return out.replace(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g,(_,d,m,y)=>`${Number(d)} tháng ${Number(m)} năm ${y}`).replace(/(\d[\d.,]*)\s*(₫|đ)(?=\s|[.,;!?]|$)/g,(_,n)=>`${n.replace(/\./g,'')} đồng`).replace(/\b(\d+(?:[.,]\d+)?)\s*kg\b/gi,'$1 ki lô gam').replace(/\b(\d+(?:[.,]\d+)?)\s*km\b/gi,'$1 ki lô mét');
}
export function splitText(input:string,max=500):string[]{const out:string[]=[];for(const para of input.trim().split(/\n+/)){let current='';for(const word of para.trim().split(/\s+/)){if(!word)continue;if(current.length+word.length+1>max&&current){out.push(current);current='';}if(word.length>max){if(current)out.push(current);for(let i=0;i<word.length;i+=max)out.push(word.slice(i,i+max));current='';}else current+=(current?' ':'')+word;}if(current)out.push(current);}return out;}
export function makeSegment(text=''):Segment{return {id:uid(),text,normalized_text:text,voice_id:null,speaker:'Người dẫn',gap_ms:300,takes:[],selected_take_id:null,trim_start_ms:0,trim_end_ms:null,fade_in_ms:0,fade_out_ms:0,gain_db:0};}
export function splitTranscript(row:TranscriptSegment):[TranscriptSegment,TranscriptSegment]{const words=row.text.split(/\s+/);if(words.length<2||row.end_ms-row.start_ms<2)throw Error('Cần ít nhất hai từ để chia đoạn');const n=Math.ceil(words.length/2);const mid=Math.round(row.start_ms+(row.end_ms-row.start_ms)*n/words.length);return [{...row,text:words.slice(0,n).join(' '),end_ms:mid},{id:uid(),start_ms:mid,end_ms:row.end_ms,text:words.slice(n).join(' ')}];}
export function mergeTranscript(a:TranscriptSegment,b:TranscriptSegment):TranscriptSegment{return {...a,start_ms:Math.min(a.start_ms,b.start_ms),end_ms:Math.max(a.end_ms,b.end_ms),text:a.text+' '+b.text};}
export interface Recipe {duration_ms:number;trim_start_ms:number;trim_end_ms:number|null;gap_ms:number;fade_in_ms:number;fade_out_ms:number;gain_db:number}
export function validateRecipe(c:Recipe):void {const end=c.trim_end_ms??c.duration_ms;if(![c.duration_ms,c.trim_start_ms,end,c.gap_ms,c.fade_in_ms,c.fade_out_ms,c.gain_db].every(Number.isFinite)||c.trim_start_ms<0||end>c.duration_ms||end<=c.trim_start_ms||c.gap_ms<0)throw Error('Trim và khoảng nghỉ phải nằm trong thời lượng audio');if(c.fade_in_ms<0||c.fade_out_ms<0||c.fade_in_ms+c.fade_out_ms>end-c.trim_start_ms)throw Error('Fade vượt thời lượng đoạn');}
export function clipDuration(c:Recipe):number {validateRecipe(c);return (c.trim_end_ms??c.duration_ms)-c.trim_start_ms+c.gap_ms;}
export function ttsTranscript(clips:(Recipe&{text:string})[]):TranscriptSegment[]{let time=0;return clips.map(c=>{const start_ms=time;time+=clipDuration(c);return {id:uid(),start_ms,end_ms:time-c.gap_ms,text:c.text};});}
