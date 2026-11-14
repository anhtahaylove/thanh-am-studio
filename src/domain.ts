import type {Project,Segment,TakeCheck,TranscriptSegment} from './types';
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
const escapeRegExp=(s:string)=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
/** Replaces every case-insensitive literal match of `find` in transcript text; untouched rows keep their identity. */
export function replaceInTranscript(rows:TranscriptSegment[],find:string,replacement:string):{rows:TranscriptSegment[];count:number}{
 if(!find)return {rows,count:0};
 const pattern=new RegExp(escapeRegExp(find.normalize('NFC')),'giu');let count=0;
 const next=rows.map(r=>{const text=r.text.normalize('NFC').replace(pattern,()=>{count++;return replacement;});return text===r.text.normalize('NFC')?r:{...r,text};});
 return {rows:next,count};
}
/** Badge for a take that Whisper listened back to; soft mismatches (merged initials/finals) do not warn. */
export function checkSummary(check:TakeCheck|undefined):{tone:'ok'|'warn';label:string;detail:string}|null{
 if(!check||check.error||!check.mismatches)return null;
 const hard=check.mismatches.filter(m=>!m.soft),tried=(check.attempts??1)>1;const detail=`${tried?`Đã thử ${check.attempts} lần, giữ bản tốt nhất. `:''}Whisper nghe: “${check.heard??''}”`,tail=tried?` · ${check.attempts} lần`:'';
 if(!hard.length)return {tone:'ok',label:`Khớp kịch bản${tail}`,detail};
 return {tone:'warn',label:`Có thể đọc sai: ${hard.slice(0,2).map(m=>`“${m.expected||'…'}” → “${m.heard||'…'}”`).join(', ')}${hard.length>2?` +${hard.length-2}`:''}${tail}`,detail};
}
/** Speaker choices for a row: every speaker in the transcript plus one new one. */
export function speakerSlots(rows:TranscriptSegment[]):number{return Math.max(-1,...rows.map(r=>r.speaker??-1))+2;}
/** Script lines from a transcript: consecutive rows of one speaker are joined (up to `max` characters). */
export function transcriptToScript(rows:TranscriptSegment[],max=500):{speaker:string;text:string}[]{
 const out:{speaker:string;text:string}[]=[];
 for(const r of rows){const text=r.text.trim();if(!text)continue;const speaker=r.speaker===undefined?'Người dẫn':`Người ${r.speaker+1}`;const last=out.at(-1);
  if(last&&last.speaker===speaker&&last.text.length+1+text.length<=max)last.text+=' '+text;else out.push({speaker,text});}
 return out;
}
/** The transcript row being heard at `ms` of the source audio, if any. */
/** Class of waveform bar `i` of `n`: outside the trim window, already played, or neither. */
export function barState(i:number,n:number,durationMs:number,trim:{trim_start_ms:number;trim_end_ms:number|null},playMs:number|null):''|'trimmed'|'played'{
 const t=(i+0.5)/n*durationMs;
 if(t<trim.trim_start_ms||t>(trim.trim_end_ms??durationMs))return 'trimmed';
 return playMs!==null&&t<=playMs?'played':'';
}
export const rowAt=(rows:TranscriptSegment[],ms:number)=>rows.find(r=>r.start_ms<=ms&&ms<r.end_ms)?.id??null;
/** Pause mark the worker turns into silence, e.g. "[nghỉ 0.5s]" or "[nghỉ 300ms]". */
export const PAUSE_MARK=/\[\s*nghỉ\s+\d+(?:[.,]\d+)?\s*(?:ms|s|giây)?\s*\]/giu;
export const spokenText=(text:string)=>text.replace(PAUSE_MARK,' ').replace(/\s+/g,' ').trim();
/** Dictionary and number rules apply to spoken text only; pause marks pass through untouched. `codeSwitch` wraps English-only words in <en>…</en>. */
export function normalizeText(text:string,dictionary:Record<string,string>,options:{codeSwitch?:boolean}={}):string {
 return text.normalize('NFC').split(new RegExp(`(${PAUSE_MARK.source})`,'iu')).map((part,i)=>i%2?part:normalizeSpoken(part,dictionary,options.codeSwitch)).join('');
}
const CURRENCY:Record<string,string>={'₿':'bitcoin','₹':'rupi','₽':'rúp','¢':'xu'};
// Code-switching idea ported from nguyenan97/VieNeu-TTS commit c836e480 (src/vieneu_utils/codeswitch.py, Apache-2.0): pinned sea-g2p reads <en>…</en> with its English engine.
// Its ALL-CAPS rule is left out: it needs sea-g2p's English word list, and without it UBND/THPT would be read as English.
const EN_TOKEN=/(<en>[\s\S]*?<\/en>|\[[^\]]*\]|<\|[^|]*\|>|\S*(?::\/\/|@|www\.|[\\/])\S*|\S*[A-Za-z0-9]\.[A-Za-z]\S*)|(?<![\p{L}\p{N}])[A-Za-z]{2,}(?:['’][A-Za-z]+)*(?![\p{L}\p{N}])/gu;
// Unaccented Vietnamese syllables end in a vowel, m, n, ng or nh (p/t/c/ch codas need a tone mark) and never contain f/j/w/z; all-caps and vowel-less words are acronyms or units.
const onlyEnglish=(w:string)=>w!==w.toUpperCase()&&/[aeiouy]/i.test(w)&&(/[fjwz]/i.test(w)||!/(?:[aeiouymn]|ng|nh)$/i.test(w));
// Only sentences typed with diacritics, so Vietnamese written without them ("hoc", "dep") is left alone.
const tagEnglish=(text:string)=>text.split(/(?<=[.!?…])(\s+)/u).map((s,i)=>i%2||!/\p{M}|đ/iu.test(s.normalize('NFD'))?s:s.replace(EN_TOKEN,(m,kept)=>kept||!onlyEnglish(m)?m:`<en>${m}</en>`)).join('').replace(/<\/en>(\s+)<en>/g,'$1');
function normalizeSpoken(text:string,dictionary:Record<string,string>,codeSwitch=false):string {
 const keys=Object.keys(dictionary).filter(Boolean).sort((a,b)=>b.length-a.length);let out=text.normalize('NFC');
 if(keys.length){const escaped=keys.map(escapeRegExp);out=out.replace(new RegExp(escaped.join('|'),'gu'),m=>dictionary[m]);}
 out=out.replace(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g,(_,d,m,y)=>`${Number(d)} tháng ${Number(m)} năm ${y}`).replace(/(\d[\d.,]*)\s*(₫|đ)(?=\s|[.,;!?]|$)/g,(_,n)=>`${n.replace(/\./g,'')} đồng`).replace(/\b(\d+(?:[.,]\d+)?)\s*kg\b/gi,'$1 ki lô gam').replace(/\b(\d+(?:[.,]\d+)?)\s*km\b/gi,'$1 ki lô mét')
  // Readings pinned sea-g2p 0.10.0 gets wrong (its issues #20, #21, #22, #25): đ/cp → "địa chỉp", -2,5 loses the sign, 50k → "năm mươi ca", 1.2B → "bê", rate 1.1200 → a date, ₿₹₽¢ dropped.
  .replace(/(?<!\p{L})(\d?)\s*đ\/(c\p{L}+)/gu,(_,d,u)=>`${d&&d+' '}đồng trên ${u==='cp'?'cổ phiếu':u}`).replace(/(?<![\p{L}\d])[-\u2212](?=\d+,\d)/gu,'âm ').replace(/(?<![\p{L}\d.,])(\d[\d.,]*)k(?![\p{L}\d])/gu,'$1 nghìn').replace(/(?<![\p{L}\d.,])(\d+)[.,](\d+)B(?![\p{L}\d])/gu,'$1,$2 tỷ')
  .replace(/(?<![\d.,])(\d{1,2})\.(\d{4})(?!\d|[.,]\d)/g,(m,a,b)=>+a>=1&&+a<=12&&(+b<1900||+b>2100)?`${a} chấm ${[...b].join(' ')}`:m).replace(/([₿₹₽¢])\s*(\d(?:[\d.,]*\d)?)|(\d(?:[\d.,]*\d)?)\s*([₿₹₽¢])/gu,(_,s,a,b,t)=>`${a??b} ${CURRENCY[s??t]}`);
 return codeSwitch?tagEnglish(out):out;
}
const SENTENCE_END=/(?<=[.!?…]["'”’)\]]*)\s+/gu;
function splitWords(text:string,max:number):string[]{const out:string[]=[];let current='';for(const word of text.split(/\s+/)){if(!word)continue;if(current.length+word.length+1>max&&current){out.push(current);current='';}if(word.length>max){if(current)out.push(current);for(let i=0;i<word.length;i+=max)out.push(word.slice(i,i+max));current='';}else current+=(current?' ':'')+word;}if(current)out.push(current);return out;}
// Each line is its own paragraph; sentences are packed up to max chars and only a single over-long sentence is cut (at word boundaries).
export function splitText(input:string,max=500):string[]{const out:string[]=[];for(const para of input.trim().split(/\n+/)){let current='';for(const sentence of para.trim().replace(/\s+/g,' ').split(SENTENCE_END)){if(!sentence)continue;if(current&&current.length+1+sentence.length<=max){current+=' '+sentence;continue;}if(current)out.push(current);if(sentence.length<=max)current=sentence;else{const parts=splitWords(sentence,max);current=parts.pop()!;out.push(...parts);}}if(current)out.push(current);}return out;}
export function makeSegment(text=''):Segment{return {id:uid(),text,normalized_text:text,voice_id:null,speaker:'Người dẫn',gap_ms:300,takes:[],selected_take_id:null,trim_start_ms:0,trim_end_ms:null,fade_in_ms:0,fade_out_ms:0,gain_db:0};}
// A line "Tên: lời" or "[Tên]: lời" names its speaker. The name is at most 30 characters with no digits or URL (so "8:30" and "http://…" are not labels).
const LABEL=/^\s*(?:\[([^\][:\n]+)\]|([^:[\]\n]+?))\s*[:：](?!\/\/)\s*(.*)$/u;
const labelOf=(line:string)=>{const m=line.match(LABEL),name=(m?.[1]??m?.[2])?.trim();return m&&name&&name.length<=30&&!/\d|www\.|@/i.test(name)?{name,rest:m[3]}:null;};
/** Script chunks of pasted text. With at least two labelled lines each label starts a block (continuing until the next label) spoken by that name; otherwise one speaker reads everything, so a lone "Lưu ý:" stays text. */
export function scriptChunks(text:string):{speaker:string;text:string}[]{
 const lines=text.split(/\r?\n/).map(line=>({line,label:labelOf(line)})),labelled=lines.filter(l=>l.label).length>=2,blocks=[{speaker:'Người dẫn',lines:[] as string[]}];
 for(const {line,label} of lines){if(labelled&&label)blocks.push({speaker:label.name,lines:[label.rest]});else blocks.at(-1)!.lines.push(line);}
 return blocks.flatMap(b=>splitText(b.lines.join('\n')).map(text=>({speaker:b.speaker,text})));
}
export function splitTranscript(row:TranscriptSegment):[TranscriptSegment,TranscriptSegment]{const words=row.text.split(/\s+/);if(words.length<2||row.end_ms-row.start_ms<2)throw Error('Cần ít nhất hai từ để chia đoạn');const n=Math.ceil(words.length/2);const mid=Math.round(row.start_ms+(row.end_ms-row.start_ms)*n/words.length);return [{...row,text:words.slice(0,n).join(' '),end_ms:mid},{id:uid(),start_ms:mid,end_ms:row.end_ms,text:words.slice(n).join(' ')}];}
export function mergeTranscript(a:TranscriptSegment,b:TranscriptSegment):TranscriptSegment{return {...a,start_ms:Math.min(a.start_ms,b.start_ms),end_ms:Math.max(a.end_ms,b.end_ms),text:a.text+' '+b.text};}
export interface Recipe {duration_ms:number;trim_start_ms:number;trim_end_ms:number|null;gap_ms:number;fade_in_ms:number;fade_out_ms:number;gain_db:number}
export function validateRecipe(c:Recipe):void {const end=c.trim_end_ms??c.duration_ms;if(![c.duration_ms,c.trim_start_ms,end,c.gap_ms,c.fade_in_ms,c.fade_out_ms,c.gain_db].every(Number.isFinite)||c.trim_start_ms<0||end>c.duration_ms||end<=c.trim_start_ms||c.gap_ms<0)throw Error('Trim và khoảng nghỉ phải nằm trong thời lượng audio');if(c.fade_in_ms<0||c.fade_out_ms<0||c.fade_in_ms+c.fade_out_ms>end-c.trim_start_ms)throw Error('Fade vượt thời lượng đoạn');}
export function clipDuration(c:Recipe):number {validateRecipe(c);return (c.trim_end_ms??c.duration_ms)-c.trim_start_ms+c.gap_ms;}
const splitMarks=(t:string,re:RegExp)=>[...t.matchAll(re)].map(m=>m.index!).filter(i=>t.slice(0,i).trim()&&t.slice(i).trim());
// Split at the cursor when it is inside the text, else at the sentence (then word) boundary closest to the middle. The first half keeps id, takes and recipe.
export function splitSegment(s:Segment,cursor?:number,dictionary:Record<string,string>={}):[Segment,Segment]{
 const t=s.text,mid=t.length/2,closest=(m:number[])=>m.sort((a,b)=>Math.abs(a-mid)-Math.abs(b-mid))[0];
 const at=cursor!==undefined&&cursor>0&&cursor<t.length&&t.slice(0,cursor).trim()&&t.slice(cursor).trim()?cursor:closest(splitMarks(t,SENTENCE_END))??closest(splitMarks(t,/\s+/g));
 if(at===undefined)throw Error('Đoạn cần ít nhất hai từ để chia');
 const a=t.slice(0,at).trim(),b=t.slice(at).trim();
 return [{...s,text:a,normalized_text:normalizeText(a,dictionary)},{...s,id:uid(),text:b,normalized_text:normalizeText(b,dictionary),takes:[],selected_take_id:null,trim_start_ms:0,trim_end_ms:null,fade_in_ms:0,fade_out_ms:0}];
}
export function mergeSegments(a:Segment,b:Segment,dictionary:Record<string,string>={}):Segment{const text=[a.text.trim(),b.text.trim()].filter(Boolean).join(' ');return {...a,text,normalized_text:normalizeText(text,dictionary),gap_ms:b.gap_ms};}
// Takes are append-only and server-owned: restoring an older snapshot must keep every take of the current project, plus new segments that already own takes.
export function restoreSnapshot(snap:Project,cur:Project):Project{
 const byId=new Map(cur.segments.map(s=>[s.id,s]));
 const segments=snap.segments.map(s=>{const c=byId.get(s.id);if(!c)return s;const known=new Set(s.takes.map(t=>t.id));return {...s,takes:[...s.takes,...c.takes.filter(t=>!known.has(t.id))],selected_take_id:s.selected_take_id??c.selected_take_id};});
 const ids=new Set(segments.map(s=>s.id));cur.segments.forEach((s,i)=>{if(!ids.has(s.id)&&s.takes.length)segments.splice(Math.min(i,segments.length),0,s);});
 return {...snap,segments,id:cur.id,name:cur.name,revision:cur.revision,updated_at:cur.updated_at};
}
export const validRange=(start:number,end:number)=>Number.isFinite(start)&&Number.isFinite(end)&&start>=0&&end>start;
export function addTranscriptRow(rows:TranscriptSegment[],afterId:string|null):TranscriptSegment[]{const found=rows.findIndex(r=>r.id===afterId),i=found<0?rows.length-1:found,start_ms=rows[i]?.end_ms??0;return [...rows.slice(0,i+1),{id:uid(),start_ms,end_ms:start_ms+1000,text:''},...rows.slice(i+1)];}
// A running job's updated_at is when it started: progress writes do not touch it.
export function progressLabel(progress:number,startedAt:string,now=Date.now()):string{const pct=`${Math.floor(progress*100)} %`;const elapsed=now-Date.parse(startedAt);if(!(progress>=0.15&&progress<1&&elapsed>0))return pct;return `${pct} · còn ~${Math.max(1,Math.round(elapsed*(1-progress)/progress/60000))} phút`;}
// A TTS batch marks all its jobs running but reports progress only for the one being synthesized.
export const jobProgressLabel=(kind:string,progress:number,startedAt:string,now=Date.now())=>kind==='tts'&&progress<=0?'Chờ trong lô':progressLabel(progress,startedAt,now);
export function ttsTranscript(clips:(Recipe&{text:string})[]):TranscriptSegment[]{let time=0;return clips.map(c=>{const start_ms=time;time+=clipDuration(c);return {id:uid(),start_ms,end_ms:time-c.gap_ms,text:spokenText(c.text)};});}
